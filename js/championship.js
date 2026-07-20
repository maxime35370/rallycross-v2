/* ═══════════════════════════════════════════════
   CHAMPIONSHIP.JS — Classement général saison
   Cumul par meeting : pts intermédiaire + DF + Finale
   Calcul direct depuis les collections brutes
   Plus besoin de sauvegarder meetingStandings
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';
import { calcInterimStandings, qfPoints, dfPoints, finPoints, calcStatusPoints } from './calc.js';
import { getChampionshipConfig } from './settings.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';

let _activeRegulation = null;

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings   = [];
let unsubMeetings = null;

let selectedYear     = new Date().getFullYear();
let selectedCategory = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — HELPERS
// ─────────────────────────────────────────────────────────

async function fsQuery(collectionName, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const constraints = filters.map(([field, op, val]) => where(field, op, val));
  const snap = await getDocs(query(collection(db, collectionName), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fsGetResults(sessionId) {
  return fsQuery('results', [['sessionId', '==', sessionId]]);
}

async function fsGetParticipants(sessionId) {
  return fsQuery('sessionParticipants', [['sessionId', '==', sessionId]]);
}

// ─────────────────────────────────────────────────────────
// PÉNALITÉS « POINTS CHAMPIONNAT » (niveau saison, éditables)
// Un total de points retirés par pilote, appliqué au grand total saison.
// Doc id = `${championshipId}__${driverId}`. Modifiable à tout moment.
// ─────────────────────────────────────────────────────────

async function getChampionshipPenalties(championshipId) {
  if (!championshipId) return {};
  try {
    const rows = await fsQuery('championshipPenalties', [['championshipId', '==', championshipId]]);
    const map = {};
    rows.forEach(r => { map[r.driverId] = Number(r.points) || 0; });
    return map;
  } catch { return {}; }
}

async function saveChampionshipPenalty(championshipId, category, driverId, points) {
  if (!championshipId) { toast('Sélectionne d\'abord un championnat', 'error'); return; }
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await setDoc(
    doc(db, 'championshipPenalties', `${championshipId}__${driverId}`),
    { championshipId, category, driverId, points: Number(points) || 0, updatedAt: Date.now() },
    { merge: true }
  );
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS D'UNE PHASE (DF ou FIN)
// ─────────────────────────────────────────────────────────

async function calcPhasePoints(session) {
  const results      = await fsGetResults(session.id);
  const participants = await fsGetParticipants(session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  // Avant : tables hardcodees DF_POINTS / FIN_POINTS qui ignoraient le
  // reglement actif. Maintenant : qfPoints/dfPoints/finPoints lisent
  // _activeRegulation.pointsScale.[QF|DF|FIN] (formule + overrides du
  // bareme configure). Coherent avec calc.js et standings.js.
  const ptsFn = session.type === 'DF' ? (p => dfPoints(p, _activeRegulation))
              : session.type === 'QF' ? (p => qfPoints(p, _activeRegulation))
              : (p => finPoints(p, _activeRegulation));

  const rows = participants.map(p => ({
    driverId:       p.driverId,
    ms:             resultMap[p.driverId]?.ms             ?? null,
    status:         resultMap[p.driverId]?.status         ?? null,
    manualPosition: resultMap[p.driverId]?.manualPosition ?? null,
  }));

  const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);

  const out = {};
  let pos = 1;
  finished.forEach(r => { out[r.driverId] = ptsFn(pos++); });

  // DNF avec position assignée → points de la position
  rows.filter(r => r.status === 'DNF' && r.manualPosition)
      .forEach(r => { out[r.driverId] = ptsFn(r.manualPosition); });

  // Pilotes avec statut spécial → calcStatusPoints (respecte
  // regulation.statusRules : DSQ_RACE, DNS, DSQ, DNF-no-pos)
  const totalEngaged = participants.length;
  participants.forEach(p => {
    if (out[p.driverId] !== undefined) return;
    const r = resultMap[p.driverId];
    out[p.driverId] = r?.status
      ? calcStatusPoints(r.status, session.type, totalEngaged, _activeRegulation)
      : 0;
  });

  return out; // { driverId → points }
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS PAR MEETING — DIRECT DEPUIS COLLECTIONS BRUTES
// Plus besoin de sauvegarder meetingStandings
// ─────────────────────────────────────────────────────────

async function getMeetingPoints(meetingId) {
  // 1. Sessions du meeting pour cette catégorie
  const sessions = await fsQuery('sessions', [
    ['meetingId', '==', meetingId],
    ['category',  '==', selectedCategory],
  ]);
  if (!sessions.length) return [];

  // 2. Classement intermédiaire (via calc.js — calcul direct)
  const interimRows = await calcInterimStandings(db, sessions, _activeRegulation);

  // Map driverId → données pilote + points intermédiaires
  const driverMap = {};
  interimRows.forEach(r => {
    driverMap[r.driverId] = {
      driverId:  r.driverId,
      carNumber: r.carNumber,
      firstName: r.firstName,
      lastName:  r.lastName,
      interim:   r.interimPoints ?? 0,
      qf:        0,
      df:        0,
      fin:       0,
    };
  });

  const blankRow = (p) => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    interim: 0, qf: 0, df: 0, fin: 0,
  });

  // 3. Points QF (¼ de finale) — championnats de type FIA uniquement.
  //    S'il n'y a pas de session QF, qf reste a 0.
  const qfSessions = sessions.filter(s => s.type === 'QF');
  for (const qf of qfSessions) {
    const ptsMap = await calcPhasePoints(qf);
    const parts  = await fsGetParticipants(qf.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].qf += ptsMap[p.driverId] ?? 0;
    });
  }

  // 4. Points DF
  const dfSessions = sessions.filter(s => s.type === 'DF');
  for (const df of dfSessions) {
    const ptsMap = await calcPhasePoints(df);
    const parts  = await fsGetParticipants(df.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].df += ptsMap[p.driverId] ?? 0;
    });
  }

  // 5. Points Finale
  const finSession = sessions.find(s => s.type === 'FIN');
  if (finSession) {
    const ptsMap = await calcPhasePoints(finSession);
    const parts  = await fsGetParticipants(finSession.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].fin = ptsMap[p.driverId] ?? 0;
    });
  }

  // 6. Calculer le total et retourner
  return Object.values(driverMap).map(d => ({
    ...d,
    total: d.interim + d.qf + d.df + d.fin,
  })).filter(d => d.interim > 0 || d.qf > 0 || d.df > 0 || d.fin > 0); // exclure pilotes sans aucun point
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT CHAMPIONNAT SAISON
// ─────────────────────────────────────────────────────────

async function calcChampionship() {
  if (!selectedCategory || allMeetings.length === 0) return [];

  const champMap = {};

  for (const meeting of allMeetings) {
    const pts = await getMeetingPoints(meeting.id);
    pts.forEach(d => {
      if (!champMap[d.driverId]) {
        champMap[d.driverId] = {
          driverId:   d.driverId,
          carNumber:  d.carNumber,
          firstName:  d.firstName,
          lastName:   d.lastName,
          meetingPts: {},
          grandTotal: 0,
        };
      }
      champMap[d.driverId].meetingPts[meeting.id] = d.total;
      champMap[d.driverId].grandTotal += d.total;
    });
  }

  // Pénalités « points championnat » (retirées du total saison, éditables à tout
  // moment via la colonne Pén.). Appliquées AVANT le tri pour que le rang reflète
  // la sanction.
  const penalties = await getChampionshipPenalties(getActiveChampionshipId());
  Object.values(champMap).forEach(d => {
    d.penalty = penalties[d.driverId] || 0;
    d.grandTotal -= d.penalty;
  });

  // Trier par total décroissant
  const standings = Object.values(champMap).sort((a, b) => b.grandTotal - a.grandTotal);

  // Attribuer les positions
  let pos = 1;
  standings.forEach((d, i) => {
    if (i > 0 && d.grandTotal === standings[i-1].grandTotal) {
      d.position = standings[i-1].position;
    } else {
      d.position = pos;
    }
    pos = i + 2;
  });

  return standings;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — MEETINGS
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubMeetings) unsubMeetings();
  const q = query(
    collection(db, 'meetings'),
    where('year', '==', selectedYear),
    orderBy('date', 'asc')
  );
  unsubMeetings = onSnapshot(q, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const champId = getActiveChampionshipId();
    allMeetings = champId ? all.filter(m => m.championshipId === champId || !m.championshipId) : all;
    if (selectedCategory) renderChampionship();
  });
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-championship').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🥇 <span>Championnat</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="chp-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="chp-category">
        <option value="">— Catégorie —</option>
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <div id="chp-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">🥇</div>
        <div class="placeholder-title">Sélectionnez une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
  if (selectedCategory) renderChampionship();
}

async function renderChampionship() {
  const content = document.getElementById('chp-content');
  if (!content) return;

  if (!selectedCategory) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🥇</div><div class="placeholder-title">Sélectionnez une catégorie</div></div>`;
    return;
  }

  if (allMeetings.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📅</div><div class="placeholder-title">Aucun meeting pour ${selectedYear}</div></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calcul du championnat…</div>`;

  try {
    const standings = await calcChampionship();

    if (standings.length === 0) {
      content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de données pour cette catégorie</div></div>`;
      return;
    }

    // Le bareme par meeting inclut les ¼ de finale si le championnat en a.
    const hasQF = getActiveChampionship()?.sessionConfig?.QF?.enabled === true;

    const meetingHeaders = allMeetings.map(m => {
      const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' }) : '?';
      return `<th class="center chp-meeting-col" title="${escHtml(m.location)}">${d}<br><span class="chp-loc">${escHtml(m.location?.split(' ')[0] || '?')}</span></th>`;
    }).join('');

    content.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="center" style="width:46px">Pos.</th>
              <th>Pilote</th>
              <th class="center" style="width:50px">N°</th>
              ${meetingHeaders}
              <th class="center chp-pen-col" title="Points de pénalité retirés du total saison (éditable)">Pén.</th>
              <th class="center chp-total-col">Total</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map(d => {
              const pos = d.position;
              const posClass = pos === 1 ? 'chp-pos-1' : pos === 2 ? 'chp-pos-2' : pos === 3 ? 'chp-pos-3' : '';
              const meetingCells = allMeetings.map(m => {
                const pts = d.meetingPts[m.id];
                return `<td class="center">${pts != null ? `<span class="chp-pts">${pts}</span>` : '<span class="chp-absent">—</span>'}</td>`;
              }).join('');

              return `
                <tr>
                  <td class="center"><span class="chp-pos ${posClass}">${pos}</span></td>
                  <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
                  ${meetingCells}
                  <td class="center"><input type="number" inputmode="numeric" min="0"
                      class="chp-pen-input${d.penalty ? ' has-pen' : ''}"
                      data-driver="${escHtml(d.driverId)}" value="${d.penalty || ''}"
                      placeholder="0" title="Points de pénalité retirés du total"></td>
                  <td class="center"><strong class="chp-total">${d.grandTotal}</strong></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="chp-legend">
        <span>Points / meeting = intermédiaire${hasQF ? ' + ¼ finale' : ''} + ½ finale + finale</span>
        <span>·</span>
        <span>Pén. = points retirés du total saison (modifiable à tout moment)</span>
        <span>·</span>
        <span>${allMeetings.length} meeting${allMeetings.length > 1 ? 's' : ''} · ${standings.length} pilote${standings.length > 1 ? 's' : ''}</span>
      </div>
    `;

    // Saisie inline des pénalités (régie) : enregistre puis recalcule le classement.
    content.querySelectorAll('.chp-pen-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const driverId = inp.dataset.driver;
        const points   = Math.max(0, parseInt(inp.value, 10) || 0);
        inp.disabled = true;
        try {
          await saveChampionshipPenalty(getActiveChampionshipId(), selectedCategory, driverId, points);
          await renderChampionship();   // recalcule le total + re-trie + repositionne
        } catch (e) {
          console.error(e);
          toast('Échec de l\'enregistrement de la pénalité', 'error');
          inp.disabled = false;
        }
      });
    });

  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('chp-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    loadMeetings();
  });

  document.getElementById('chp-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value;
    renderChampionship();
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initChampionship() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'championship') {
      // Charger le reglement DU CHAMPIONNAT SELECTIONNE dans le header,
      // pas celui qui porte le flag isActive en DB. Sinon les calculs
      // (calcInterimStandings → interimPoints) appliquent une autre
      // reglementation que celle visible cote utilisateur → bug observe :
      // les points intermediaires apparaissaient au format FFSA par defaut
      // (17 - position) meme quand interimPointsEnabled etait desactive
      // dans le championnat selectionne. Pattern aligne sur sessions.js
      // / standings.js.
      try {
        const champId = getActiveChampionshipId();
        _activeRegulation = champId
          ? await getChampionshipConfig(champId)
          : await getChampionshipConfig();
      } catch { _activeRegulation = null; }
      renderView();
      await loadMeetings();
    }
  });
  document.addEventListener('championshipchange', async () => {
    // Idem : recharger le reglement quand l'utilisateur change de
    // championnat depuis le header.
    try {
      const champId = getActiveChampionshipId();
      _activeRegulation = champId
        ? await getChampionshipConfig(champId)
        : await getChampionshipConfig();
    } catch { _activeRegulation = null; }
    loadMeetings();
  });
}