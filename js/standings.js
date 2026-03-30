/* ═══════════════════════════════════════════════
   STANDINGS.JS — Calcul des points et classements
   EC, MQ, DF, FIN + classement intermédiaire
   Conforme règlement FFSA 2026
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast, categoryBadge, sessionBadge, statusBadge } from './app.js';
import { msToDisplay, escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// BARÈMES DE POINTS
// ─────────────────────────────────────────────────────────

/** Points MQ : 1er=50, 2ème=45, 3ème=42, 4ème=40, 5ème=39, 6ème=38... */
function mqPoints(position) {
  if (position === 1) return 50;
  if (position === 2) return 45;
  if (position === 3) return 42;
  if (position >= 4) return Math.max(0, 44 - position); // 40, 39, 38...
  return 0;
}

/** Points classement intermédiaire : 1er=16, 2ème=15... 16ème=1 */
function interimPoints(position) {
  return Math.max(0, 17 - position);
}

/** Points bonus EC : top 5 → 5/4/3/2/1 */
function ecBonusPoints(position) {
  if (position <= 5) return 6 - position;
  return 0;
}

/** Points DF : 10/8/6/5/4/3/2/1 */
const DF_POINTS = [0, 10, 8, 6, 5, 4, 3, 2, 1];
function dfPoints(position) {
  return DF_POINTS[position] ?? 0;
}

/** Points Finale : 15/12/9/7/6/5/4/3 */
const FIN_POINTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];
function finPoints(position) {
  return FIN_POINTS[position] ?? 0;
}

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings   = [];
let allSessions   = [];
let unsubMeetings = null;
let unsubSessions = null;

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let activeTab         = 'interim'; // 'ec' | 'mq' | 'interim' | 'df' | 'fin'

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

// ─────────────────────────────────────────────────────────
// FIRESTORE — HELPERS
// ─────────────────────────────────────────────────────────

async function getResults(sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'results'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getParticipants(sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => d.data());
}

async function saveToFirestore(collectionName, docId, data) {
  const { collection, doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await setDoc(doc(collection(db, collectionName), docId), data, { merge: true });
}

async function clearCollection(collectionName, meetingId, category) {
  const { collection, query, where, getDocs, writeBatch, doc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, collectionName),
    where('meetingId', '==', meetingId),
    where('category',  '==', category)
  ));
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS EC
// ─────────────────────────────────────────────────────────

async function calcEcStandings() {
  const ecSession = allSessions.find(s => s.type === 'EC');
  if (!ecSession) return [];

  const results      = await getResults(ecSession.id);
  const participants = await getParticipants(ecSession.id);

  // Construire map driverId → résultat
  const resultMap = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  // Tous les participants avec leur temps
  const rows = participants.map(p => {
    const r = resultMap[p.driverId] || {};
    return {
      driverId:  p.driverId,
      carNumber: p.carNumber,
      firstName: p.firstName,
      lastName:  p.lastName,
      ms:        r.ms ?? null,
      status:    r.status ?? null,
    };
  });

  // Trier : temps croissant, DNS/DSQ en fin
  rows.sort((a, b) => {
    const aOut = !a.ms && a.status;
    const bOut = !b.ms && b.status;
    if (aOut && !bOut) return 1;
    if (!aOut && bOut) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  // Attribuer positions et points bonus
  let pos = 1;
  return rows.map(r => {
    const hasTime = r.ms != null;
    const position = hasTime ? pos++ : null;
    const bonus    = hasTime ? ecBonusPoints(position) : 0;
    return { ...r, position, bonusPoints: bonus };
  });
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS MQ
// ─────────────────────────────────────────────────────────

/**
 * Calcule le classement d'une manche qualificative.
 * Applique les règles DNS/DNF/DSQ_RACE/DSQ conformément au règlement.
 */
async function calcMqStandings(session) {
  const results      = await getResults(session.id);
  const participants = await getParticipants(session.id);

  const resultMap = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const rows = participants.map(p => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    ms:        resultMap[p.driverId]?.ms    ?? null,
    status:    resultMap[p.driverId]?.status ?? null,
  }));

  // Nombre de partants autorisés (tous les participants)
  const totalEngaged = rows.length;

  // Séparer les finis / abandons / non-partants / déclassés / disqualifiés
  const finished  = rows.filter(r => r.ms && !r.status).sort((a,b) => a.ms - b.ms);
  const dnf       = rows.filter(r => r.status === 'DNF');
  const dsqRace   = rows.filter(r => r.status === 'DSQ_RACE');
  const dns       = rows.filter(r => r.status === 'DNS');
  const dsq       = rows.filter(r => r.status === 'DSQ');
  const noResult  = rows.filter(r => !r.ms && !r.status); // pas encore saisi

  // Points du dernier classé (position = totalEngaged)
  const lastPoints = mqPoints(totalEngaged);

  let pos = 1;
  const result = [];

  // Finis : positions normales
  finished.forEach(r => {
    const points = mqPoints(pos);
    result.push({ ...r, position: pos++, points });
  });

  // DNF : dernier classé - 1
  dnf.forEach(r => {
    const points = Math.max(0, lastPoints - 1);
    result.push({ ...r, position: totalEngaged + 1, points });
  });

  // DSQ_RACE : dernier classé - 3
  dsqRace.forEach(r => {
    const points = Math.max(0, lastPoints - 3);
    result.push({ ...r, position: totalEngaged + 3, points });
  });

  // DNS : 0 point
  dns.forEach(r => result.push({ ...r, position: null, points: 0 }));

  // DSQ : 0 point
  dsq.forEach(r => result.push({ ...r, position: null, points: 0 }));

  // Sans résultat encore
  noResult.forEach(r => result.push({ ...r, position: null, points: null }));

  return result;
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT INTERMÉDIAIRE
// ─────────────────────────────────────────────────────────

async function calcInterimStandings() {
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a,b) => a.num - b.num);
  if (mqSessions.length === 0) return [];

  // Récupérer tous les résultats MQ
  const mqResults = {}; // mqNum → {driverId → {points, position}}
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(mq);
    mqResults[mq.num] = {};
    standings.forEach(r => {
      mqResults[mq.num][r.driverId] = { points: r.points ?? 0, position: r.position };
    });
  }

  // Points bonus EC
  const ecStandings = await calcEcStandings();
  const ecBonus = {};
  ecStandings.forEach(r => { ecBonus[r.driverId] = r.bonusPoints ?? 0; });

  // Collecter tous les pilotes ayant participé à au moins 2 MQ
  const driverMap = {};
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(mq);
    standings.forEach(r => {
      if (!driverMap[r.driverId]) {
        driverMap[r.driverId] = {
          driverId:  r.driverId,
          carNumber: r.carNumber,
          firstName: r.firstName,
          lastName:  r.lastName,
          mqPoints:  {}, // mqNum → points
          mqPos:     {}, // mqNum → position
          mqCount:   0,  // nb de MQ classées
        };
      }
      // Compter seulement les MQ où le pilote a été classé (pas DNS/DSQ)
      if (r.points !== null && r.points !== undefined) {
        driverMap[r.driverId].mqPoints[mq.num] = r.points ?? 0;
        driverMap[r.driverId].mqPos[mq.num]    = r.position;
        if (r.status !== 'DNS' && r.status !== 'DSQ') {
          driverMap[r.driverId].mqCount++;
        }
      }
    });
  }

  // Règle : au moins 2 MQ classées pour figurer au classement intermédiaire
  const eligible = Object.values(driverMap).filter(d => d.mqCount >= 2);

  // Calcul total : somme des points MQ + bonus EC
  eligible.forEach(d => {
    d.totalMqPoints = Object.values(d.mqPoints).reduce((s, p) => s + p, 0);
    d.ecBonus       = ecBonus[d.driverId] ?? 0;
    d.totalPoints   = d.totalMqPoints + d.ecBonus;
  });

  // Tri avec départage : total desc → MQ4 desc → MQ3 desc → MQ2 desc → MQ1 desc
  eligible.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    // Départage MQ du plus récent au plus ancien
    for (let n = mqSessions.length; n >= 1; n--) {
      const pa = a.mqPoints[n] ?? -1;
      const pb = b.mqPoints[n] ?? -1;
      if (pb !== pa) return pb - pa;
    }
    return 0;
  });

  // Attribuer positions (ex-æquo possible)
  let pos = 1;
  eligible.forEach((d, i) => {
    if (i > 0) {
      const prev = eligible[i-1];
      const sameTotal = d.totalPoints === prev.totalPoints;
      // Vérifier aussi le départage complet
      let sameAll = sameTotal;
      if (sameAll) {
        for (let n = mqSessions.length; n >= 1; n--) {
          if ((d.mqPoints[n] ?? -1) !== (prev.mqPoints[n] ?? -1)) { sameAll = false; break; }
        }
      }
      if (!sameAll) pos = i + 1;
    }
    d.position        = pos;
    d.interimPoints   = interimPoints(pos);
  });

  return eligible;
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS DF / FINALE
// ─────────────────────────────────────────────────────────

async function calcPhaseStandings(session) {
  const results      = await getResults(session.id);
  const participants = await getParticipants(session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const rows = participants.map(p => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    ms:        resultMap[p.driverId]?.ms    ?? null,
    status:    resultMap[p.driverId]?.status ?? null,
  }));

  const finished = rows.filter(r => r.ms && !r.status).sort((a,b) => a.ms - b.ms);
  // DNF avec position manuelle : traités comme finissants à leur position déclarée
  const dnfWithPos  = rows.filter(r => r.status === 'DNF' && r.manualPosition);
  const dnfNoPos    = rows.filter(r => r.status === 'DNF' && !r.manualPosition);
  const dsqRace     = rows.filter(r => r.status === 'DSQ_RACE');
  const dns         = rows.filter(r => r.status === 'DNS');
  const dsq         = rows.filter(r => r.status === 'DSQ');
  const noResult    = rows.filter(r => !r.ms && !r.status);
  const ptsFn       = session.type === 'DF' ? dfPoints : finPoints;

  let pos = 1;
  const result = [];
  finished.forEach(r => result.push({ ...r, position: pos,   points: ptsFn(pos++) }));

  // DNF avec position manuelle : points selon la position déclarée
  dnfWithPos.forEach(r => {
    const p = r.manualPosition;
    result.push({ ...r, position: p, points: ptsFn(p) });
  });

  // DNF sans position : classé dernier avec 0 pts (pas assez d'info)
  dnfNoPos.forEach(r => result.push({ ...r, position: null, points: 0 }));

  dsqRace.forEach(r  => result.push({ ...r, position: null, points: 1 })); // 1 pt DSQ EC en DF/FIN
  dns.forEach(r      => result.push({ ...r, position: null, points: 0 }));
  dsq.forEach(r      => result.push({ ...r, position: null, points: 0 }));
  noResult.forEach(r => result.push({ ...r, position: null, points: null }));

  return result;
}

// ─────────────────────────────────────────────────────────
// SAUVEGARDE CLASSEMENT INTERMÉDIAIRE
// ─────────────────────────────────────────────────────────

/**
 * Compare la date de sauvegarde du classement intermédiaire
 * avec la date du dernier résultat modifié dans les MQ.
 * Affiche un badge d'avertissement si périmé.
 */
async function checkInterimFreshness() {
  const banner = document.getElementById('std-freshness-banner');
  if (!banner) return;

  const { collection, query, where, getDocs, orderBy, limit } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    // Date de la dernière sauvegarde intermédiaire
    const interimSnap = await getDocs(query(
      collection(db, 'interimStandings'),
      where('meetingId', '==', selectedMeetingId),
      where('category',  '==', selectedCategory),
      orderBy('updatedAt', 'desc'),
      limit(1)
    ));

    if (interimSnap.empty) {
      // Pas encore sauvegardé
      banner.style.display = 'none';
      return;
    }

    const lastSaved = interimSnap.docs[0].data().updatedAt?.toDate?.() || new Date(0);

    // Date du dernier résultat MQ modifié
    const mqSessions = allSessions.filter(s => s.type === 'MQ');
    let lastResultDate = new Date(0);
    for (const mq of mqSessions) {
      try {
        const rSnap = await getDocs(query(
          collection(db, 'results'),
          where('sessionId', '==', mq.id),
          orderBy('updatedAt', 'desc'),
          limit(1)
        ));
        if (!rSnap.empty) {
          const d = rSnap.docs[0].data().updatedAt?.toDate?.() || new Date(0);
          if (d > lastResultDate) lastResultDate = d;
        }
      } catch {}
    }

    if (lastResultDate > lastSaved) {
      // Des résultats ont été modifiés après la sauvegarde
      const diff = Math.round((lastResultDate - lastSaved) / 1000);
      const diffStr = diff < 60 ? `${diff}s` : `${Math.round(diff/60)} min`;
      banner.style.display = 'flex';
      banner.innerHTML = `
        <span>⚠️</span>
        <span>Des résultats ont été modifiés <strong>${diffStr}</strong> après la dernière sauvegarde
        — le classement intermédiaire est peut-être périmé.</span>
        <button class="btn btn-secondary btn-sm" id="std-refresh-btn">🔄 Recalculer</button>
      `;
      document.getElementById('std-refresh-btn')?.addEventListener('click', () => renderTab());
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {
    // Index manquant ou autre erreur → on ignore silencieusement
    banner.style.display = 'none';
  }
}

async function saveInterimStandings(standings) {
  await clearCollection('interimStandings', selectedMeetingId, selectedCategory);
  const { collection, addDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const col = collection(db, 'interimStandings');
  for (const d of standings) {
    await addDoc(col, {
      meetingId:     selectedMeetingId,
      category:      selectedCategory,
      year:          selectedYear,
      driverId:      d.driverId,
      carNumber:     d.carNumber,
      firstName:     d.firstName,
      lastName:      d.lastName,
      position:      d.position,
      totalPoints:   d.totalPoints,
      interimPoints: d.interimPoints,
      mqPoints:      d.mqPoints,
      ecBonus:       d.ecBonus,
      updatedAt:     new Date(),
    });
  }
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-standings').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🏆 <span>Classements</span></h2>
    </div>

    <!-- Filtres -->
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="std-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="std-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="std-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <!-- Onglets -->
    <div class="std-tabs" id="std-tabs" style="display:none">
      <button class="std-tab ${activeTab==='ec'?'is-active':''}"      data-tab="ec">Essais</button>
      <button class="std-tab ${activeTab==='mq'?'is-active':''}"      data-tab="mq">Manches</button>
      <button class="std-tab ${activeTab==='interim'?'is-active':''}" data-tab="interim">Intermédiaire</button>
      <button class="std-tab ${activeTab==='df'?'is-active':''}"      data-tab="df">½ Finales</button>
      <button class="std-tab ${activeTab==='fin'?'is-active':''}"     data-tab="fin">Finale</button>
      <button class="std-tab ${activeTab==='meeting'?'is-active':''}" data-tab="meeting">🏆 Meeting</button>
    </div>

    <!-- Contenu -->
    <div id="std-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">🏆</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('std-meeting');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Meeting —</option>`;
  allMeetings.forEach(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '?';
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${d} — ${m.location || '?'}`;
    if (m.id === selectedMeetingId) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function renderTab() {
  const content = document.getElementById('std-content');
  if (!content) return;

  if (!selectedMeetingId || !selectedCategory) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🏆</div><div class="placeholder-title">Sélectionnez un meeting et une catégorie</div></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calcul en cours…</div>`;

  try {
    switch (activeTab) {
      case 'ec':     await renderEcTab(content); break;
      case 'mq':     await renderMqTab(content); break;
      case 'interim': await renderInterimTab(content); break;
      case 'df':     await renderDfTab(content); break;
      case 'fin':    await renderFinTab(content); break;
      case 'meeting': await renderMeetingTab(content); break;
    }
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

async function renderEcTab(content) {
  const standings = await calcEcStandings();
  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Essais chronométrés</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:50px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          <th class="right">Temps</th>
          <th class="center">Bonus</th>
        </tr></thead>
        <tbody>
          ${standings.length === 0
            ? `<tr><td class="table-empty" colspan="5">Aucun résultat saisi</td></tr>`
            : standings.map(r => `
              <tr>
                <td class="center">${r.position ?? '—'}</td>
                <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                <td class="right">
                  ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                </td>
                <td class="center">
                  ${r.bonusPoints > 0 ? `<span class="std-bonus">+${r.bonusPoints}</span>` : '—'}
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>`;
}

async function renderMqTab(content) {
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a,b) => a.num - b.num);
  if (mqSessions.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune manche qualificative</div></div>`;
    return;
  }

  let html = '';
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(mq);
    html += `
      <div class="std-section">
        <div class="std-section-title">Manche qualificative ${mq.num}</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th class="center" style="width:50px">Pos.</th>
              <th>Pilote</th>
              <th class="center">N°</th>
              <th class="right">Temps</th>
              <th class="center">Points</th>
            </tr></thead>
            <tbody>
              ${standings.filter(r => r.points !== null).map(r => `
                <tr>
                  <td class="center">${r.position ?? '—'}</td>
                  <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                  <td class="right">
                    ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                  </td>
                  <td class="center"><strong>${r.points}</strong></td>
                </tr>`).join('')
              }
            </tbody>
          </table>
        </div>
      </div>`;
  }
  content.innerHTML = html;
}

async function renderInterimTab(content) {
  const standings = await calcInterimStandings();
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a,b) => a.num - b.num);

  content.innerHTML = `
    <div class="std-freshness-banner" id="std-freshness-banner" style="display:none"></div>
    <div class="std-header-row">
      <span class="std-table-title">Classement intermédiaire</span>
      <button class="btn btn-primary btn-sm" id="std-save-interim">💾 Sauvegarder</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:46px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          ${mqSessions.map(mq => `<th class="center">MQ${mq.num}</th>`).join('')}
          <th class="center">EC+</th>
          <th class="center">Total MQ</th>
          <th class="center">Pts inter.</th>
        </tr></thead>
        <tbody>
          ${standings.length === 0
            ? `<tr><td class="table-empty" colspan="${5 + mqSessions.length}">Pas encore assez de résultats (min. 2 MQ par pilote)</td></tr>`
            : standings.map(r => `
              <tr class="${r.position <= 16 ? '' : 'std-row-reserve'}">
                <td class="center">
                  <span class="${r.position <= 8 ? 'std-pos-top' : ''}">${r.position}</span>
                </td>
                <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                ${mqSessions.map(mq => `
                  <td class="center">${r.mqPoints[mq.num] !== undefined ? r.mqPoints[mq.num] : '—'}</td>
                `).join('')}
                <td class="center">
                  ${r.ecBonus > 0 ? `<span class="std-bonus">+${r.ecBonus}</span>` : '—'}
                </td>
                <td class="center"><strong>${r.totalMqPoints}</strong></td>
                <td class="center">
                  ${r.position <= 16 ? `<strong class="text-accent">${r.interimPoints}</strong>` : '—'}
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>
    ${standings.length > 0 ? `
      <div class="std-note">
        ℹ️ Top 16 qualifiés pour les demi-finales · Points intermédiaires attribués aux 16 premiers
      </div>` : ''}
  `;

  document.getElementById('std-save-interim')?.addEventListener('click', async () => {
    if (standings.length === 0) { toast('Aucun classement à sauvegarder', 'warning'); return; }
    const btn = document.getElementById('std-save-interim');
    btn.disabled = true; btn.textContent = '⏳ Sauvegarde…';
    await saveInterimStandings(standings);
    btn.disabled = false; btn.textContent = '✅ Sauvegardé';
    setTimeout(() => { if (btn) btn.textContent = '💾 Sauvegarder'; }, 2000);
    toast('Classement intermédiaire sauvegardé ✓', 'success');
    // Rafraîchir l'indicateur de fraîcheur
    await checkInterimFreshness();
  });

  // Vérifier si le classement sauvegardé est à jour
  await checkInterimFreshness();
}

async function renderDfTab(content) {
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a,b) => a.num - b.num);
  if (dfSessions.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune demi-finale</div></div>`;
    return;
  }
  let html = '';
  for (const df of dfSessions) {
    const standings = await calcPhaseStandings(df);
    html += renderPhaseTable(`Demi-finale ${df.num}`, standings);
  }
  content.innerHTML = html;
}

async function renderFinTab(content) {
  const finSession = allSessions.find(s => s.type === 'FIN');
  if (!finSession) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune finale</div></div>`;
    return;
  }
  const standings = await calcPhaseStandings(finSession);
  content.innerHTML = renderPhaseTable('Finale', standings);
}

function renderPhaseTable(title, standings) {
  return `
    <div class="std-section">
      <div class="std-section-title">${title}</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th class="center" style="width:50px">Pos.</th>
            <th>Pilote</th>
            <th class="center">N°</th>
            <th class="right">Temps</th>
            <th class="center">Points</th>
          </tr></thead>
          <tbody>
            ${standings.length === 0
              ? `<tr><td class="table-empty" colspan="5">Aucun résultat saisi</td></tr>`
              : standings.map(r => `
                <tr>
                  <td class="center">${r.position ? `<span class="${r.position <= 3 ? 'std-pos-top' : ''}">${r.position}</span>` : '—'}</td>
                  <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                  <td class="right">
                    ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                  </td>
                  <td class="center"><strong>${r.points !== null ? r.points : '—'}</strong></td>
                </tr>`).join('')
            }
          </tbody>
        </table>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — MEETINGS & SESSIONS
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubMeetings) unsubMeetings();
  const q = query(collection(db, 'meetings'), where('year', '==', selectedYear), orderBy('date', 'asc'));
  unsubMeetings = onSnapshot(q, snap => {
    allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshMeetingSelect();
  });
}

async function loadSessions() {
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; return; }
  const { collection, query, where, orderBy, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessions'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory),
    orderBy('order', 'asc')
  ));
  allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('std-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    loadMeetings();
  });

  document.getElementById('std-meeting')?.addEventListener('change', async e => {
    selectedMeetingId = e.target.value;
    await loadSessions();
    showTabs();
    renderTab();
  });

  document.getElementById('std-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    await loadSessions();
    showTabs();
    renderTab();
  });
}

function showTabs() {
  const tabs = document.getElementById('std-tabs');
  if (tabs) tabs.style.display = selectedMeetingId && selectedCategory ? 'flex' : 'none';

  document.querySelectorAll('.std-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.std-tab').forEach(b => b.classList.toggle('is-active', b === btn));
      renderTab();
    });
  });
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

/**
 * Classement complet du meeting :
 * Top 8 finale, puis DF par points, puis pilotes non qualifiés par classement intermédiaire
 */
async function renderMeetingTab(content) {
  const finSession = allSessions.find(s => s.type === 'FIN');
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a,b) => a.num - b.num);

  // 1. Résultats Finale (top 8)
  let finStandings = [];
  if (finSession) {
    finStandings = await calcPhaseStandings(finSession);
  }

  // 2. Résultats DF (pour pilotes non en finale)
  const finalistIds = new Set(finStandings.map(r => r.driverId));
  let dfRows = [];
  for (const df of dfSessions) {
    const rows = await calcPhaseStandings(df);
    rows.forEach(r => {
      if (!finalistIds.has(r.driverId)) dfRows.push({ ...r, dfNum: df.num });
    });
  }
  // Trier les DF par points décroissants, puis temps
  dfRows.sort((a,b) => {
    if ((b.points ?? 0) !== (a.points ?? 0)) return (b.points ?? 0) - (a.points ?? 0);
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  // 3. Pilotes non qualifiés pour les DF (classement intermédiaire)
  const dfParticipantIds = new Set();
  for (const df of dfSessions) {
    const parts = await getParticipants(df.id);
    parts.forEach(p => dfParticipantIds.add(p.driverId));
  }

  const interimRows = await getResults('interim_placeholder'); // on lit depuis interimStandings
  // Lire directement interimStandings
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const interimSnap = await getDocs(query(
    collection(db, 'interimStandings'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  ));
  const interimData = interimSnap.docs.map(d => d.data())
    .sort((a,b) => (a.position ?? 99) - (b.position ?? 99))
    .filter(r => !dfParticipantIds.has(r.driverId) && !finalistIds.has(r.driverId));

  // Construire le classement complet
  let globalPos = 1;
  const allRows = [];

  // Finalistes
  finStandings.filter(r => r.ms || r.status).forEach(r => {
    allRows.push({ ...r, globalPos: globalPos++, phase: 'FIN' });
  });

  // Demi-finalistes non qualifiés
  dfRows.forEach(r => {
    allRows.push({ ...r, globalPos: globalPos++, phase: `DF${r.dfNum}` });
  });

  // Non qualifiés DF (classement intermédiaire)
  interimData.forEach(r => {
    allRows.push({
      driverId:  r.driverId,
      carNumber: r.carNumber,
      firstName: r.firstName,
      lastName:  r.lastName,
      ms: null, status: null, points: null,
      globalPos: globalPos++,
      phase: 'Qualifs',
    });
  });

  if (allRows.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de résultats de finale</div></div>`;
    return;
  }

  // Calculer les points totaux meeting pour chaque pilote
  // Récupérer classement intermédiaire
  const { collection: c3, query: q3, where: w3, getDocs: g3 } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const intSnap = await g3(q3(c3(db, 'interimStandings'),
    w3('meetingId', '==', selectedMeetingId), w3('category', '==', selectedCategory)
  ));
  const intMap = {}; // driverId → interimPoints
  intSnap.docs.forEach(d => { intMap[d.data().driverId] = d.data().interimPoints ?? 0; });

  // Accumuler les points DF pour chaque pilote
  // On utilise calcPhaseStandings qui calcule les points correctement
  const dfPtsMap = {}; // driverId → points DF total
  for (const df of dfSessions) {
    const dfStandings = await calcPhaseStandings(df);
    dfStandings.forEach(r => {
      if (r.points != null) dfPtsMap[r.driverId] = (dfPtsMap[r.driverId] ?? 0) + r.points;
    });
  }

  // Total = intermédiaire + DF + Finale
  allRows.forEach(r => {
    const interim = intMap[r.driverId]   ?? 0;
    const df      = dfPtsMap[r.driverId] ?? 0;
    const fin     = r.phase === 'FIN' ? (r.points ?? 0) : 0;
    // Pour pilotes DF : phase pts = leurs points DF
    const dfPhase = r.phase.startsWith('DF') ? (r.points ?? 0) : 0;
    r.totalMeeting = interim + df + fin;
  });

  // Construire le tableau final : un pilote par ligne avec ses points par phase
  // Collecter tous les pilotes engagés (union de tous les engagés)
  const allDriverIds = new Set([
    ...Object.keys(intMap),
    ...Object.keys(dfPtsMap),
    ...allRows.map(r => r.driverId),
  ]);

  // Construire un map global : driverId → { info, interim, df, fin, total }
  const globalMap = {};
  allRows.forEach(r => {
    if (!globalMap[r.driverId]) {
      globalMap[r.driverId] = {
        driverId:  r.driverId,
        carNumber: r.carNumber,
        firstName: r.firstName,
        lastName:  r.lastName,
        interim:   intMap[r.driverId]    ?? 0,
        df:        dfPtsMap[r.driverId]  ?? 0,
        fin:       r.phase === 'FIN' ? (r.points ?? 0) : 0,
      };
    } else if (r.phase === 'FIN') {
      globalMap[r.driverId].fin = r.points ?? 0;
    }
  });

  // Pilotes avec interimPoints mais pas dans allRows
  intSnap.docs.forEach(d => {
    const data = d.data();
    if (!globalMap[data.driverId]) {
      globalMap[data.driverId] = {
        driverId:  data.driverId,
        carNumber: data.carNumber,
        firstName: data.firstName,
        lastName:  data.lastName,
        interim:   data.interimPoints ?? 0,
        df:        dfPtsMap[data.driverId] ?? 0,
        fin:       0,
      };
    }
  });

  // Calculer total et trier
  const meetingRows = Object.values(globalMap).map(d => ({
    ...d,
    total: d.interim + d.df + d.fin,
  })).sort((a, b) => b.total - a.total);

  // Positions (ex-aequo possible)
  let mPos = 1;
  meetingRows.forEach((d, i) => {
    if (i > 0 && d.total === meetingRows[i-1].total) {
      d.position = meetingRows[i-1].position;
    } else {
      d.position = mPos;
    }
    mPos = i + 2;
  });

  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Classement complet du meeting</span>
      <button class="btn btn-primary btn-sm" id="std-save-meeting">💾 Sauvegarder</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:46px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          <th class="center">Intermédiaire</th>
          <th class="center">½ Finales</th>
          <th class="center">Finale</th>
          <th class="center chp-total-col">Total</th>
        </tr></thead>
        <tbody>
          ${meetingRows.map(d => `
            <tr>
              <td class="center">
                <span class="${d.position <= 3 ? 'std-pos-top' : ''}">${d.position}</span>
              </td>
              <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
              <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
              <td class="center">${d.interim > 0 ? d.interim : '<span class="chp-absent">—</span>'}</td>
              <td class="center">${d.df > 0     ? d.df      : '<span class="chp-absent">—</span>'}</td>
              <td class="center">${d.fin > 0    ? d.fin     : '<span class="chp-absent">—</span>'}</td>
              <td class="center chp-total-col">
                <strong class="chp-total">${d.total}</strong>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('std-save-meeting')?.addEventListener('click', async () => {
    if (meetingRows.length === 0) { toast('Aucun résultat à sauvegarder', 'warning'); return; }
    const btn = document.getElementById('std-save-meeting');
    btn.disabled = true; btn.textContent = '⏳ Sauvegarde…';
    await saveMeetingStandings(meetingRows);
    btn.disabled = false; btn.textContent = '✅ Sauvegardé';
    setTimeout(() => { if (btn) btn.textContent = '💾 Sauvegarder'; }, 2000);
    toast('Classement du meeting sauvegardé ✓', 'success');
  });
}

async function saveMeetingStandings(rows) {
  const { collection, addDoc, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'meetingStandings'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  ));
  if (!snap.empty) {
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  const col = collection(db, 'meetingStandings');
  for (const d of rows) {
    await addDoc(col, {
      meetingId:  selectedMeetingId,
      category:   selectedCategory,
      year:       selectedYear,
      driverId:   d.driverId,
      carNumber:  d.carNumber,
      firstName:  d.firstName,
      lastName:   d.lastName,
      position:   d.position,
      interimPts: d.interim,
      dfPts:      d.df,
      finalePts:  d.fin,
      totalPts:   d.total,
      updatedAt:  new Date(),
    });
  }
}

function injectStyles() {
  if (document.getElementById('standings-styles')) return;
  const style = document.createElement('style');
  style.id = 'standings-styles';
  style.textContent = `
    /* Onglets */
    .std-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: var(--sp-md);
      flex-wrap: wrap;
    }
    .std-tab {
      padding: 7px 14px;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md);
      color: var(--clr-text-2);
      font-family: var(--font-condensed);
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all var(--tr-fast);
    }
    .std-tab:hover  { border-color: var(--clr-accent); color: var(--clr-text); }
    .std-tab.is-active {
      background: var(--clr-accent-dim);
      border-color: var(--clr-accent);
      color: var(--clr-accent-2);
    }

    /* Sections */
    .std-section { margin-bottom: var(--sp-lg); }
    .std-section-title {
      font-family: var(--font-condensed);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
    }
    .std-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--sp-md);
    }
    .std-table-title {
      font-family: var(--font-condensed);
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
    }

    /* Cellules spéciales */
    .std-pos-top {
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--clr-accent-2);
    }
    .std-bonus {
      color: var(--clr-success);
      font-weight: 700;
      font-size: 0.85rem;
    }
    .std-row-reserve td { opacity: 0.5; }
    .std-freshness-banner {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-sm) var(--sp-md);
      background: var(--clr-warning-dim);
      border: 1px solid var(--clr-warning);
      border-radius: var(--r-md);
      color: var(--clr-warning);
      font-size: 0.85rem;
      margin-bottom: var(--sp-md);
      flex-wrap: wrap;
    }
    .std-freshness-banner strong { font-weight: 700; }
    .std-row-finale { background: rgba(255,85,0,0.04); }
    .std-row-df     { background: rgba(255,119,48,0.03); }
    .std-note {
      font-size: 0.8rem;
      color: var(--clr-text-3);
      padding: var(--sp-sm) 0;
    }
    .tim-time {
      font-family: var(--font-display);
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--clr-success);
    }
    .tim-num {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 36px; height: 24px;
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      font-family: var(--font-display);
      font-size: 0.75rem; font-weight: 700;
      color: var(--clr-accent-2);
      padding: 0 4px;
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initStandings() {
  injectStyles();
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'standings') {
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) {
        await loadSessions();
        showTabs();
        renderTab();
      }
    }
  });
}