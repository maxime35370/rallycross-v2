/* ═══════════════════════════════════════════════
   TIMING.JS — Interface chronométrage terrain
   EC : meilleur tour (1 champ temps)
   MQ / DF / FIN : temps total session (min | sec | ms)
   Statuts : DNS, DNF, DSQ, DSQ_RACE
   Navigation Entrée entre les champs
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { msToDisplay, inputToMs, msToFields, escHtml, parseTimeString } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let _autoSaveInterimTimer = null; // debounce recalcul intermédiaire

let allMeetings    = [];
let allSessions    = [];
let participants   = [];   // pilotes assignés à la session sélectionnée
let results        = {};   // { driverId: { ms, status } }
let unsubMeetings  = null;
let unsubSessions  = null;
let unsubResults   = null;

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let selectedSessionId = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];
const SESSION_LABELS = { EC: 'Essais chronométrés', MQ: 'Manche qualificative', DF: 'Demi-finale', FIN: 'Finale' };
const SPECIAL_STATUSES = ['DNS', 'DNF', 'DSQ', 'DSQ_RACE'];

// ─────────────────────────────────────────────────────────
// FIRESTORE — CHARGEMENT
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
    allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshMeetingSelect();
  });
}

async function loadSessions() {
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; renderSessionSelect(); return; }
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubSessions) unsubSessions();
  const q = query(
    collection(db, 'sessions'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory),
    orderBy('order', 'asc')
  );
  unsubSessions = onSnapshot(q, snap => {
    allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSessionSelect();
  });
}

async function loadParticipants() {
  if (!db || !selectedSessionId) { participants = []; renderTimingTable(); return; }
  const { collection, query, where, getDocs, orderBy } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', selectedSessionId)
  );
  const snap = await getDocs(q);
  const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Tri intelligent selon le type de session
  const session = allSessions.find(s => s.id === selectedSessionId);
  participants = await sortParticipantsForTiming(raw, session);
  renderTimingTable();
}

/**
 * Trie les pilotes dans l'ordre où ils vont passer la ligne d'arrivée
 * (du premier au dernier), pour faciliter la saisie terrain.
 *
 * EC :
 *   - Meeting 1 → numéros décroissants
 *   - Meetings 2+ → non-classés (numéros décroisants) puis classés
 *                   du moins bon au leader (classement décroissant)
 * MQ1 → inverse du classement EC de ce meeting
 * MQ2/3/4 → inverse du classement de la MQ précédente
 * DF / FIN → numéros décroissants (ordre de grille géré manuellement)
 */
async function sortParticipantsForTiming(raw, session) {
  if (!session) return raw.sort((a, b) => b.carNumber - a.carNumber);

  const { collection, query, where, getDocs, orderBy } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // ── Essais chronométrés ────────────────────────────────
  if (session.type === 'EC') {
    try {
      const { calcInterimStandings } = await import('./calc.js');
      const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
      const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

      // 1. Récupérer tous les meetings passés de la saison/catégorie
      const allMeetingsSnap = await getDocs(query(
        collection(db, 'meetings'),
        where('year', '==', selectedYear)
      ));
      const pastMeetings = allMeetingsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m =>
          m.id !== selectedMeetingId &&           // exclure le meeting en cours
          m.date < (allMeetings.find(x => x.id === selectedMeetingId)?.date || '9999')
        );

      if (pastMeetings.length === 0) {
        // Premier meeting → numéros décroissants
        return raw.sort((a, b) => b.carNumber - a.carNumber);
      }

      // 2. Calculer les points cumulés pour chaque meeting passé
      const pointsMap = {}; // driverId → total points cumulés

      for (const meeting of pastMeetings) {
        // Récupérer les sessions de ce meeting pour cette catégorie
        const sessSnap = await getDocs(query(
          collection(db, 'sessions'),
          where('meetingId', '==', meeting.id),
          where('category',  '==', selectedCategory)
        ));
        const meetingSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (!meetingSessions.length) continue;

        // Points intermédiaires via calcInterimStandings (calc.js)
        const interim = await calcInterimStandings(db, meetingSessions);
        interim.forEach(r => {
          if (!pointsMap[r.driverId]) pointsMap[r.driverId] = 0;
          pointsMap[r.driverId] += r.interimPoints ?? 0;
        });

        // Points DF
        const dfSessions = meetingSessions.filter(s => s.type === 'DF');
        for (const df of dfSessions) {
          const resSnap = await getDocs(query(
            collection(db, 'results'),
            where('sessionId', '==', df.id)
          ));
          const finished = resSnap.docs
            .map(d => d.data())
            .filter(r => r.ms && !r.status)
            .sort((a, b) => a.ms - b.ms);
          finished.forEach((r, i) => {
            if (!pointsMap[r.driverId]) pointsMap[r.driverId] = 0;
            pointsMap[r.driverId] += DF_PTS[i + 1] ?? 0;
          });
        }

        // Points Finale
        const finSession = meetingSessions.find(s => s.type === 'FIN');
        if (finSession) {
          const resSnap = await getDocs(query(
            collection(db, 'results'),
            where('sessionId', '==', finSession.id)
          ));
          const finished = resSnap.docs
            .map(d => d.data())
            .filter(r => r.ms && !r.status)
            .sort((a, b) => a.ms - b.ms);
          finished.forEach((r, i) => {
            if (!pointsMap[r.driverId]) pointsMap[r.driverId] = 0;
            pointsMap[r.driverId] += FIN_PTS[i + 1] ?? 0;
          });
        }
      }

      // 3. Trier : nouveaux pilotes (sans historique) d'abord en numéros décroissants
      //            puis les classés du moins bon au meilleur (leader passe en dernier)
      const notRanked = raw
        .filter(p => !pointsMap[p.driverId])
        .sort((a, b) => b.carNumber - a.carNumber);

      const ranked = raw
        .filter(p => pointsMap[p.driverId])
        .sort((a, b) => pointsMap[a.driverId] - pointsMap[b.driverId]); // croissant

      return [...notRanked, ...ranked];

    } catch (e) {
      console.warn('Tri EC :', e);
    }

    // Fallback ultime
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── Manche qualificative 1 → inverse classement EC ────
  if (session.type === 'MQ' && session.num === 1) {
    const ecSession = allSessions.find(s => s.type === 'EC');
    if (ecSession) {
      const ecResults = await getSessionResultsSorted(ecSession.id);
      if (ecResults.length > 0) {
        return sortByReferenceInverse(raw, ecResults);
      }
    }
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── Manche qualificative 2/3/4 → inverse MQ précédente ─
  if (session.type === 'MQ' && session.num > 1) {
    const prevMQ = allSessions.find(s => s.type === 'MQ' && s.num === session.num - 1);
    if (prevMQ) {
      const prevResults = await getSessionResultsSorted(prevMQ.id);
      if (prevResults.length > 0) {
        return sortByReferenceInverse(raw, prevResults);
      }
    }
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── DF / FIN → numéros décroissants par défaut ─────────
  return raw.sort((a, b) => b.carNumber - a.carNumber);
}

/**
 * Récupère les résultats d'une session triés du meilleur au moins bon.
 * Les DNS/DSQ sont en fin de liste, DNF/DSQ_RACE avant eux.
 * @returns {Array} [{driverId, ms, status}]
 */
async function getSessionResultsSorted(sessionId) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  try {
    const q = query(
      collection(db, 'results'),
      where('sessionId', '==', sessionId)
    );
    const snap = await getDocs(q);
    const res = snap.docs.map(d => d.data());

    return res.sort((a, b) => {
      // DNS/DSQ (0 pts) tout en bas
      const aZero = ['DNS','DSQ'].includes(a.status);
      const bZero = ['DNS','DSQ'].includes(b.status);
      if (aZero && !bZero) return 1;
      if (!aZero && bZero) return -1;
      // DNF/DSQ_RACE avant DNS/DSQ
      const aSpecial = ['DNF','DSQ_RACE'].includes(a.status);
      const bSpecial = ['DNF','DSQ_RACE'].includes(b.status);
      if (aSpecial && !bSpecial) return 1;
      if (!aSpecial && bSpecial) return -1;
      // Tri par temps
      return (a.ms ?? Infinity) - (b.ms ?? Infinity);
    });
  } catch { return []; }
}

/**
 * Trie raw dans l'ordre INVERSE d'un tableau de référence trié.
 * Les pilotes absents du référence sont mis en tête (numéros décroissants).
 */
function sortByReferenceInverse(raw, reference) {
  // reference est trié meilleur → moins bon
  // On veut : moins bon en premier (index élevé en premier)
  const posMap = {}; // driverId → index dans reference (0 = meilleur)
  reference.forEach((r, i) => { posMap[r.driverId] = i; });

  const notInRef = raw.filter(p => posMap[p.driverId] === undefined)
    .sort((a, b) => b.carNumber - a.carNumber);
  const inRef = raw.filter(p => posMap[p.driverId] !== undefined)
    .sort((a, b) => posMap[b.driverId] - posMap[a.driverId]); // inverse : grand index en premier

  return [...notInRef, ...inRef];
}

async function loadResults() {
  if (!db || !selectedSessionId) { results = {}; return; }
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubResults) unsubResults();
  const q = query(
    collection(db, 'results'),
    where('sessionId', '==', selectedSessionId)
  );
  unsubResults = onSnapshot(q, snap => {
    results = {};
    snap.docs.forEach(d => {
      const data = d.data();
      results[data.driverId] = { docId: d.id, ms: data.ms, status: data.status };
    });
    renderTimingTable();
  });
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — SAUVEGARDE
// ─────────────────────────────────────────────────────────

async function saveResult(driverId, ms, status, manualPosition = null) {
  if (!db || !selectedSessionId) return;
  const { collection, doc, addDoc, updateDoc, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const session = allSessions.find(s => s.id === selectedSessionId);
  const participant = participants.find(p => p.driverId === driverId);
  if (!participant) return;

  const data = {
    sessionId:      selectedSessionId,
    meetingId:      selectedMeetingId,
    category:       selectedCategory,
    year:           selectedYear,
    sessionType:    session?.type || '',
    driverId,
    carNumber:      participant.carNumber,
    firstName:      participant.firstName,
    lastName:       participant.lastName,
    ms:             ms ?? null,
    status:         status || null,
    manualPosition: manualPosition ?? null,
    updatedAt:      new Date(),
  };

  const existing = results[driverId];
  try {
    if (existing?.docId) {
      await updateDoc(doc(db, 'results', existing.docId), data);
    } else {
      await addDoc(collection(db, 'results'), { ...data, createdAt: new Date() });
    }
    // Recalcul automatique en arrière-plan (debounce 3s)
    // Uniquement pour les sessions EC et MQ qui impactent le classement intermédiaire
    if (['EC','MQ'].includes(data.sessionType)) {
      scheduleInterimAutoSave();
    }
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
  }
}

/**
 * Lance un recalcul + sauvegarde du classement intermédiaire en arrière-plan.
 * Debounce 3s : si plusieurs temps saisis rapidement, ne recalcule qu'une fois.
 * Fire and forget — ne bloque pas la saisie.
 */
function scheduleInterimAutoSave() {
  if (_autoSaveInterimTimer) clearTimeout(_autoSaveInterimTimer);
  _autoSaveInterimTimer = setTimeout(() => {
    autoSaveInterimStandings(); // fire and forget
  }, 3000);
}

async function autoSaveInterimStandings() {
  if (!db || !selectedMeetingId || !selectedCategory) return;

  const { collection, query, where, getDocs, addDoc, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a,b) => a.num - b.num);
    const ecSession  = allSessions.find(s => s.type === 'EC');
    if (mqSessions.length === 0) return;

    // ── Points MQ par pilote ───────────────────────────
    function mqPts(pos, total) {
      if (pos === 1) return 50;
      if (pos === 2) return 45;
      if (pos === 3) return 42;
      if (pos >= 4)  return Math.max(0, 44 - pos);
      return 0;
    }

    const driverMap = {}; // driverId → { info, mqPoints:{}, mqPos:{}, mqCount, ecBonus }

    for (const mq of mqSessions) {
      const [resSnap, partSnap] = await Promise.all([
        getDocs(query(collection(db,'results'),            where('sessionId','==',mq.id))),
        getDocs(query(collection(db,'sessionParticipants'),where('sessionId','==',mq.id))),
      ]);
      const participants = partSnap.docs.map(d => d.data());
      const resultMap    = {};
      resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });

      const totalEngaged = participants.length;
      const finished = participants
        .map(p => ({ ...p, ...resultMap[p.driverId] }))
        .filter(r => r.ms && !r.status)
        .sort((a,b) => a.ms - b.ms);
      const lastPos = mqPts(totalEngaged, totalEngaged);

      let pos = 1;
      participants.forEach(p => {
        const r = resultMap[p.driverId] || {};
        if (!driverMap[p.driverId]) driverMap[p.driverId] = {
          driverId: p.driverId, carNumber: p.carNumber,
          firstName: p.firstName, lastName: p.lastName,
          mqPoints: {}, mqPos: {}, mqCount: 0, ecBonus: 0,
        };
        const d = driverMap[p.driverId];
        let pts = 0;
        if (r.ms && !r.status) {
          const p2 = finished.findIndex(f => f.driverId === p.driverId) + 1;
          pts = mqPts(p2, totalEngaged);
          d.mqCount++;
        } else if (r.status === 'DNF')      { pts = Math.max(0, lastPos - 1); }
        else if (r.status === 'DSQ_RACE')   { pts = Math.max(0, lastPos - 3); }
        else if (r.status === 'DNS' || r.status === 'DSQ') { pts = 0; }
        else { return; } // pas encore saisi
        d.mqPoints[mq.num] = pts;
      });
    }

    // ── Bonus EC ───────────────────────────────────────
    if (ecSession) {
      const ecRes = await getDocs(query(collection(db,'results'), where('sessionId','==',ecSession.id)));
      const ecSorted = ecRes.docs.map(d => d.data()).filter(r => r.ms).sort((a,b) => a.ms - b.ms);
      ecSorted.slice(0, 5).forEach((r, i) => {
        if (driverMap[r.driverId]) driverMap[r.driverId].ecBonus = 5 - i;
      });
    }

    // ── Calcul total + filtre min 2 MQ ────────────────
    const eligible = Object.values(driverMap)
      .filter(d => d.mqCount >= 2)
      .map(d => ({
        ...d,
        totalMqPoints: Object.values(d.mqPoints).reduce((s,p) => s+p, 0),
        totalPoints:   Object.values(d.mqPoints).reduce((s,p) => s+p, 0) + d.ecBonus,
      }))
      .sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        for (let n = mqSessions.length; n >= 1; n--) {
          const pa = a.mqPoints[n] ?? -1, pb = b.mqPoints[n] ?? -1;
          if (pb !== pa) return pb - pa;
        }
        return 0;
      });

    let pos = 1;
    eligible.forEach((d, i) => {
      if (i > 0 && d.totalPoints === eligible[i-1].totalPoints) {
        d.position = eligible[i-1].position;
      } else { d.position = pos; }
      pos = i + 2;
      d.interimPoints = Math.max(0, 17 - d.position);
    });

    if (eligible.length === 0) return;

    // ── Sauvegarde Firestore ───────────────────────────
    // Vider l'ancien classement
    const oldSnap = await getDocs(query(
      collection(db,'interimStandings'),
      where('meetingId','==',selectedMeetingId),
      where('category', '==',selectedCategory)
    ));
    if (!oldSnap.empty) {
      const batch = writeBatch(db);
      oldSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    // Écrire le nouveau
    for (const d of eligible) {
      await addDoc(collection(db,'interimStandings'), {
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
    console.log(`[Auto] Classement intermédiaire mis à jour — ${eligible.length} pilotes`);
  } catch (e) {
    console.warn('[Auto] Erreur intermédiaire:', e);
  }
}

async function clearResult(driverId) {
  if (!db) return;
  const existing = results[driverId];
  if (!existing?.docId) return;
  const { doc, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await deleteDoc(doc(db, 'results', existing.docId));
}

// ─────────────────────────────────────────────────────────
// RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-timing').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">⏱️ <span>Chronométrage</span></h2>
    </div>

    <!-- Sélecteurs -->
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm);margin-bottom:var(--sp-md)">
      <select class="toolbar-select" id="tim-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="tim-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="tim-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="tim-session" style="min-width:180px">
        <option value="">— Session —</option>
      </select>
    </div>

    <!-- Infos session active -->
    <div id="tim-session-info" style="display:none" class="tim-session-banner">
      <span id="tim-session-badge"></span>
      <span id="tim-session-name"></span>
      <span id="tim-session-tours" class="text-muted"></span>
    </div>

    <!-- Table de chronométrage -->
    <div id="tim-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">⏱️</div>
        <div class="placeholder-title">Sélectionnez un meeting, une catégorie et une session</div>
      </div>
    </div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('tim-meeting');
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

function renderSessionSelect() {
  const sel = document.getElementById('tim-session');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Session —</option>`;
  allSessions.forEach(s => {
    const label = s.type === 'MQ' ? `MQ${s.num}`
      : s.type === 'DF' ? `DF${s.num}`
      : s.type;
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${label} — ${s.label}`;
    if (s.id === selectedSessionId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─────────────────────────────────────────────────────────
// TABLE DE CHRONOMÉTRAGE
// ─────────────────────────────────────────────────────────

function renderTimingTable() {
  const content = document.getElementById('tim-content');
  const banner  = document.getElementById('tim-session-info');
  if (!content) return;

  const session = allSessions.find(s => s.id === selectedSessionId);

  if (!session || participants.length === 0) {
    if (banner) banner.style.display = 'none';
    content.innerHTML = `
      <div class="tim-placeholder">
        <div class="placeholder-icon">${!selectedSessionId ? '⏱️' : '👥'}</div>
        <div class="placeholder-title">${!selectedSessionId
          ? 'Sélectionnez une session'
          : 'Aucun pilote assigné à cette session'}</div>
      </div>`;
    return;
  }

  // Banner session
  if (banner) {
    banner.style.display = 'flex';
    const badgeEl = document.getElementById('tim-session-badge');
    const nameEl  = document.getElementById('tim-session-name');
    const toursEl = document.getElementById('tim-session-tours');
    const typeLabel = session.type === 'MQ' ? `MQ${session.num}` : session.type === 'DF' ? `DF${session.num}` : session.type;
    if (badgeEl) badgeEl.innerHTML = `<span class="badge badge-${session.type.toLowerCase()}">${typeLabel}</span>`;
    if (nameEl)  nameEl.textContent = session.label;
    if (toursEl) toursEl.textContent = `· ${session.tours} tour${session.tours > 1 ? 's' : ''}`;

    // Bouton Grille pour MQ, DF, FIN
    const showGrid = ['MQ','DF','FIN'].includes(session.type);
    let gridBtn = document.getElementById('tim-grid-btn');
    if (!gridBtn && showGrid) {
      gridBtn = document.createElement('button');
      gridBtn.id = 'tim-grid-btn';
      gridBtn.className = 'btn btn-secondary btn-sm';
      gridBtn.textContent = '📋 Grille';
      banner.appendChild(gridBtn);
    } else if (gridBtn && !showGrid) {
      gridBtn.remove();
    }
    if (gridBtn) {
      gridBtn.onclick = () => showStartingGrid(session);
    }

    // Bouton 📸 Photo (toujours visible sauf EC)
    if (session.type !== 'EC') {
      let photoBtn = document.getElementById('tim-photo-btn');
      if (!photoBtn) {
        photoBtn = document.createElement('button');
        photoBtn.id = 'tim-photo-btn';
        photoBtn.className = 'btn btn-primary btn-sm';
        photoBtn.textContent = '📸 Photo';
        banner.appendChild(photoBtn);
      }
      photoBtn.onclick = () => triggerPhotoImport(session);
    }
  }

  // Séparer chronométrés / non chronométrés
  const timed   = participants.filter(p => results[p.driverId]?.ms != null || SPECIAL_STATUSES.includes(results[p.driverId]?.status));
  const untimed = participants.filter(p => !results[p.driverId]?.ms && !SPECIAL_STATUSES.includes(results[p.driverId]?.status));

  // Trier les chronométrés :
  // - Finis par temps croissant
  // - DNF avec position manuelle classés selon cette position
  // - DNS/DSQ/DNF sans position en dernier
  const sortedTimed = [...timed].sort((a, b) => {
    const ra = results[a.driverId];
    const rb = results[b.driverId];

    // Valeur de tri : temps en ms, ou position manuelle × 1000000, ou Infinity
    const sortVal = (r) => {
      if (r?.ms) return r.ms;
      if (r?.status === 'DNF' && r?.manualPosition) return r.manualPosition * 1000000;
      return Infinity; // DNS, DSQ, DNF sans position
    };

    return sortVal(ra) - sortVal(rb);
  });

  const isEC = session.type === 'EC';

  content.innerHTML = `
    <!-- Toggle mobile entre les 2 panneaux -->
    <div class="tim-mobile-toggle" id="tim-mobile-toggle">
      <button class="tim-toggle-btn is-active" data-panel="untimed">
        ⏱️ À chronométrer <span class="tim-toggle-count">${untimed.length}</span>
      </button>
      <button class="tim-toggle-btn" data-panel="timed">
        🏁 Classement <span class="tim-toggle-count">${timed.length}</span>
      </button>
    </div>

    <div class="tim-layout">

      <!-- Colonne gauche : non chronométrés -->
      <div class="tim-panel tim-panel--untimed" id="tim-panel-untimed">
        <div class="tim-panel-header">
          <span class="tim-panel-title">À chronométrer</span>
          <span class="tim-panel-count">${untimed.length}</span>
        </div>
        <div class="tim-list" id="tim-untimed-list">
          ${untimed.length === 0
            ? `<div class="tim-empty">✅ Tous chronométrés</div>`
            : untimed.map(p => pilotRowUntimed(p, session)).join('')
          }
        </div>
      </div>

      <!-- Colonne droite : chronométrés -->
      <div class="tim-panel tim-panel--timed" id="tim-panel-timed">
        <div class="tim-panel-header">
          <span class="tim-panel-title">Classement provisoire</span>
          <span class="tim-panel-count">${timed.length}</span>
        </div>
        <div class="tim-list" id="tim-timed-list">
          ${sortedTimed.length === 0
            ? `<div class="tim-empty">Aucun temps saisi</div>`
            : sortedTimed.map((p, i) => pilotRowTimed(p, i, session)).join('')
          }
        </div>
      </div>

    </div>
  `;

  bindTimingEvents(session);
}

// ─────────────────────────────────────────────────────────
// ROWS PILOTES
// ─────────────────────────────────────────────────────────

function pilotRowUntimed(p, session) {
  const isDfOrFin = session.type === 'DF' || session.type === 'FIN';
  const maxPos = session.type === 'FIN' ? 8 : 8; // max pilotes par session

  // Sélecteur de position pour DNF en DF/FIN
  const dnfPositionSelect = isDfOrFin ? `
    <select class="tim-dnf-pos" data-driver-id="${p.driverId}" title="Position à l'abandon (DNF)">
      <option value="">Pos. DNF</option>
      ${Array.from({length: maxPos}, (_, i) => i + 1)
        .map(n => `<option value="${n}">${n}ème</option>`).join('')}
    </select>` : '';

  return `
    <div class="tim-row tim-row--untimed" data-driver-id="${p.driverId}">
      <span class="tim-num">${escHtml(p.carNumber)}</span>
      <span class="tim-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
      <div class="tim-input-group">
        <input class="tim-input tim-min" type="number" min="0" max="59" placeholder="mm"
          data-driver-id="${p.driverId}" data-field="min" tabindex="0">
        <span class="tim-sep">:</span>
        <input class="tim-input tim-sec" type="number" min="0" max="59" placeholder="ss"
          data-driver-id="${p.driverId}" data-field="sec" tabindex="0">
        <span class="tim-sep">.</span>
        <input class="tim-input tim-ms" type="number" min="0" max="999" placeholder="ms"
          data-driver-id="${p.driverId}" data-field="ms" tabindex="0">
        <button class="btn btn-primary btn-sm tim-save-btn" data-driver-id="${p.driverId}">✓</button>
      </div>
      <div class="tim-status-btns">
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DNS" title="Non partant">DNS</button>
        <div class="tim-dnf-group">
          <button class="btn btn-ghost btn-sm tim-status-btn tim-dnf-btn" data-driver-id="${p.driverId}" data-status="DNF" title="Abandon">DNF</button>
          ${dnfPositionSelect}
        </div>
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DSQ" title="Disqualifié hors course">DSQ HC</button>
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DSQ_RACE" title="Disqualifié en course">DSQ EC</button>
      </div>
    </div>
  `;
}

function pilotRowTimed(p, index, session) {
  const r = results[p.driverId];
  const isSpecial = SPECIAL_STATUSES.includes(r?.status);
  const isDnfWithPos = r?.status === 'DNF' && r?.manualPosition;

  // Position affichée : index réel dans le tri pour les DNF avec position
  const displayPos = isDnfWithPos ? r.manualPosition : (isSpecial ? null : index + 1);

  const statusLabel = r?.status === 'DSQ_RACE' ? 'DSQ EC' : r?.status === 'DSQ' ? 'DSQ HC' : r?.status;
  const manualPosLabel = isDnfWithPos ? ` (${r.manualPosition}ème)` : '';
  const badgeCls = r?.status === 'DNF' ? 'badge-dnf' : r?.status === 'DNS' ? 'badge-dns' : 'badge-dsq';
  const displayTime = isSpecial
    ? `<span class="badge ${badgeCls}">${statusLabel}${manualPosLabel}</span>`
    : `<span class="tim-time">${msToDisplay(r?.ms)}</span>`;

  return `
    <div class="tim-row tim-row--timed" data-driver-id="${p.driverId}">
      <span class="tim-pos">${displayPos ?? '—'}</span>
      <span class="tim-num">${escHtml(p.carNumber)}</span>
      <span class="tim-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
      <span class="tim-result">${displayTime}</span>
      <button class="btn btn-ghost btn-sm tim-edit-btn" data-driver-id="${p.driverId}" title="Modifier">✏️</button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS CHRONOMÉTRAGE
// ─────────────────────────────────────────────────────────

function bindTimingEvents(session) {
  const content = document.getElementById('tim-content');
  if (!content) return;

  // Toggle mobile entre les 2 panneaux
  content.querySelectorAll('.tim-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('.tim-toggle-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const panel = btn.dataset.panel;
      const untimed = content.getElementById?.('tim-panel-untimed') || content.querySelector('#tim-panel-untimed');
      const timed   = content.getElementById?.('tim-panel-timed')   || content.querySelector('#tim-panel-timed');
      if (panel === 'untimed') {
        if (untimed) untimed.style.display = '';
        if (timed)   timed.style.display   = window.innerWidth <= 800 ? 'none' : '';
      } else {
        if (untimed) untimed.style.display = window.innerWidth <= 800 ? 'none' : '';
        if (timed)   timed.style.display   = '';
      }
    });
  });

  // Bouton sauvegarder temps
  content.querySelectorAll('.tim-save-btn').forEach(btn => {
    btn.addEventListener('click', () => onSaveTime(btn.dataset.driverId, session));
  });

  // Boutons statuts spéciaux
  content.querySelectorAll('.tim-status-btn').forEach(btn => {
    btn.addEventListener('click', () => onSaveStatus(btn.dataset.driverId, btn.dataset.status));
  });

  // Bouton modifier (retour dans la liste non chronométrés)
  content.querySelectorAll('.tim-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => onEditResult(btn.dataset.driverId));
  });

  // Navigation Entrée entre les champs min → sec → ms → save
  content.querySelectorAll('.tim-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const driverId = input.dataset.driverId;
      const field    = input.dataset.field;

      if (field === 'min') {
        content.querySelector(`.tim-sec[data-driver-id="${driverId}"]`)?.focus();
      } else if (field === 'sec') {
        content.querySelector(`.tim-ms[data-driver-id="${driverId}"]`)?.focus();
      } else if (field === 'ms') {
        onSaveTime(driverId, session);
        // Focus sur le premier champ min du prochain pilote non-chronométré
        const rows = [...content.querySelectorAll('.tim-row--untimed')];
        const idx  = rows.findIndex(r => r.dataset.driverId === driverId);
        if (idx !== -1 && rows[idx + 1]) {
          rows[idx + 1].querySelector('.tim-min')?.focus();
        }
      }
    });

    // Auto-saut : quand le champ ms a 3 chiffres, sauvegarder auto
    if (input.dataset.field === 'ms') {
      input.addEventListener('input', e => {
        if (e.target.value.length >= 3) {
          const driverId = input.dataset.driverId;
          setTimeout(() => onSaveTime(driverId, session), 200);
        }
      });
    }
  });
}

// ─────────────────────────────────────────────────────────
// ACTIONS TEMPS / STATUTS
// ─────────────────────────────────────────────────────────

async function onSaveTime(driverId, session) {
  const content = document.getElementById('tim-content');
  const minEl = content?.querySelector(`.tim-min[data-driver-id="${driverId}"]`);
  const secEl = content?.querySelector(`.tim-sec[data-driver-id="${driverId}"]`);
  const msEl  = content?.querySelector(`.tim-ms[data-driver-id="${driverId}"]`);

  if (!minEl || !secEl || !msEl) return;

  const min = minEl.value.trim();
  const sec = secEl.value.trim();
  const ms  = msEl.value.trim();

  // Validation
  if (!min && !sec && !ms) return;

  const totalMs = inputToMs(min || '0', sec || '0', ms || '0');
  if (totalMs === null || totalMs <= 0) {
    toast('Temps invalide — vérifiez les secondes (0-59) et les millisecondes (0-999)', 'error');
    return;
  }

  await saveResult(driverId, totalMs, null);
  // Le re-render est déclenché par onSnapshot
}

async function onSaveStatus(driverId, status) {
  let manualPosition = null;
  if (status === 'DNF') {
    const posEl = document.querySelector(`.tim-dnf-pos[data-driver-id="${driverId}"]`);
    const pos = posEl ? parseInt(posEl.value) : null;
    if (pos && !isNaN(pos)) manualPosition = pos;
  }
  await saveResult(driverId, null, status, manualPosition);
}

async function onEditResult(driverId) {
  if (!window.confirm('Remettre ce pilote dans la liste à chronométrer ?')) return;
  await clearResult(driverId);
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS SÉLECTEURS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('tim-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    selectedSessionId = '';
    loadMeetings();
  });

  document.getElementById('tim-meeting')?.addEventListener('change', e => {
    selectedMeetingId = e.target.value;
    selectedSessionId = '';
    loadSessions();
  });

  document.getElementById('tim-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value;
    selectedSessionId = '';
    loadSessions();
  });

  document.getElementById('tim-session')?.addEventListener('change', async e => {
    selectedSessionId = e.target.value;
    if (unsubResults) { unsubResults(); unsubResults = null; }
    results = {};
    await loadParticipants();
    await loadResults();
  });
}

// ─────────────────────────────────────────────────────────
// RECONNAISSANCE PHOTO
// ─────────────────────────────────────────────────────────

function triggerPhotoImport(session) {
  const apiKey = localStorage.getItem('rx_anthropic_key');
  if (!apiKey) {
    toast('Clé API Anthropic non configurée — allez dans ⚙️ Configuration', 'error', 5000);
    return;
  }

  // Créer un input file invisible et déclencher le sélecteur
  let fileInput = document.getElementById('tim-photo-input');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'tim-photo-input';
    fileInput.accept = 'image/*,application/pdf';
    fileInput.capture = 'environment'; // caméra arrière sur mobile
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
  }

  fileInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileInput.value = ''; // reset pour permettre re-sélection
    await processPhotoImport(file, session, apiKey);
  };

  fileInput.click();
}

async function processPhotoImport(file, session, apiKey) {
  // Afficher modale de chargement
  showPhotoModal(`
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Analyse de la photo en cours…</span>
    </div>
  `, 'Reconnaissance en cours…', false);

  try {
    // Convertir en base64 (PDF → image automatiquement)
    const isPdf = file.type === 'application/pdf' || file.name?.endsWith('.pdf');
    if (isPdf) {
      showPhotoModal(`<div class="loading-state"><div class="spinner"></div><span>Conversion du PDF en cours…</span></div>`, 'Préparation…', false);
    }
    const base64 = await fileToBase64(file);
    // Détecter le bon mediaType : PDF converti → jpeg, sinon type réel du fichier
    const mediaType = isPdf ? 'image/jpeg'
      : (file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg');

    // Construire la liste des pilotes engagés pour aider Claude
    const pilotsList = participants.map(p =>
      `N°${p.carNumber} - ${p.firstName} ${p.lastName}`
    ).join(', ');

    const sessionLabel = session.type === 'MQ' ? `Manche qualificative ${session.num}`
      : session.type === 'DF' ? `Demi-finale ${session.num}`
      : 'Finale';

    const prompt = `Tu es un assistant de chronométrage pour une compétition de rallycross.

Analyse cette feuille de chronométrage officielle pour la session : ${sessionLabel}

Pilotes engagés dans cette session :
${pilotsList}

Extrais pour chaque pilote visible sur la feuille :
- Le numéro de voiture (N°)
- Le temps total au format mm:ss.mmm (ex: 1:23.456) ou ss.mmm (ex: 45.123)
- Le statut si applicable : DNS (non partant), DNF (abandon), DSQ (disqualifié)

Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, avec ce format exact :
{
  "results": [
    {"carNumber": 12, "time": "1:23.456", "status": null},
    {"carNumber": 8, "time": null, "status": "DNF"},
    {"carNumber": 15, "time": null, "status": "DNS"}
  ],
  "confidence": "high|medium|low",
  "notes": "remarques éventuelles"
}

Si tu ne peux pas lire un temps clairement, mets null pour ce pilote.
Ne fabrique pas de temps — s'il n'est pas lisible, laisse null.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parser le JSON
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    showValidationModal(parsed.results || [], session, parsed.confidence, parsed.notes);

  } catch (err) {
    console.error('Photo import error:', err);
    showPhotoModal(`
      <div class="config-test-error">
        <span>❌</span>
        <span>Erreur : ${escHtml(err.message)}</span>
      </div>
    `, 'Erreur de reconnaissance', true);
  }
}

async function fileToBase64(file) {
  // PDF : convertir la 1ère page en image via PDF.js
  if (file.type === 'application/pdf' || file.name?.endsWith('.pdf')) {
    return await pdfPageToBase64(file);
  }
  // Image classique
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function pdfPageToBase64(file) {
  // Charger PDF.js depuis CDN
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // Lire le fichier PDF
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Rendre la 1ère page sur un canvas haute résolution
  const page = await pdf.getPage(1);
  const scale = 2.5; // haute résolution pour meilleure OCR
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Convertir canvas en base64 JPEG
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return dataUrl.split(',')[1];
}

function showPhotoModal(bodyHtml, title, showClose) {
  let modal = document.getElementById('tim-photo-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tim-photo-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <span class="modal-title" id="tim-photo-modal-title"></span>
          <button class="modal-close" id="tim-photo-modal-close" style="display:none">✕</button>
        </div>
        <div class="modal-body" id="tim-photo-modal-body"></div>
        <div class="modal-footer" id="tim-photo-modal-footer"></div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('tim-photo-modal-close')?.addEventListener('click', () => {
      modal.classList.remove('is-open');
    });
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.remove('is-open');
    });
  }
  document.getElementById('tim-photo-modal-title').textContent = title;
  document.getElementById('tim-photo-modal-body').innerHTML = bodyHtml;
  document.getElementById('tim-photo-modal-footer').innerHTML = '';
  const closeBtn = document.getElementById('tim-photo-modal-close');
  if (closeBtn) closeBtn.style.display = showClose ? '' : 'none';
  modal.classList.add('is-open');
}

function showValidationModal(results, session, confidence, notes) {
  const confidenceLabel = { high: '🟢 Haute', medium: '🟡 Moyenne', low: '🔴 Faible' }[confidence] || '?';

  // Croiser avec les participants pour afficher les noms
  const rows = results.map(r => {
    const p = participants.find(p => p.carNumber == r.carNumber);
    const name = p ? `${p.firstName} ${p.lastName}` : '⚠️ Non trouvé';
    const timeDisplay = r.time || (r.status ? `<span class="badge badge-${r.status === 'DNF' ? 'dnf' : 'dns'}">${r.status}</span>` : '—');
    return { ...r, name, timeDisplay, found: !!p };
  });

  const bodyHtml = `
    <div class="photo-confidence">
      Confiance : ${confidenceLabel}
      ${notes ? `<span class="text-muted" style="font-size:0.78rem"> — ${escHtml(notes)}</span>` : ''}
    </div>
    <div class="table-wrap" style="margin-top:var(--sp-md)">
      <table>
        <thead><tr>
          <th class="center">N°</th>
          <th>Pilote</th>
          <th class="right">Temps extrait</th>
          <th class="center">Importer</th>
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr class="${!r.found ? 'photo-row-notfound' : ''}">
              <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
              <td>${escHtml(r.name)}</td>
              <td class="right">${r.timeDisplay}</td>
              <td class="center">
                ${r.found && (r.time || r.status)
                  ? `<input type="checkbox" class="photo-check" data-idx="${i}" checked style="width:18px;height:18px;accent-color:var(--clr-accent)">`
                  : '<span class="text-muted">—</span>'}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:0.8rem;color:var(--clr-text-3);margin-top:var(--sp-sm)">
      Décochez les lignes à ne pas importer. Les temps existants seront écrasés.
    </div>
  `;

  showPhotoModal(bodyHtml, `📸 Résultats reconnus — ${rows.length} pilote(s)`, true);

  // Ajouter boutons dans le footer
  const footer = document.getElementById('tim-photo-modal-footer');
  footer.innerHTML = `
    <button class="btn btn-secondary" id="tim-photo-cancel">Annuler</button>
    <button class="btn btn-primary" id="tim-photo-confirm">✅ Importer les résultats cochés</button>
  `;

  document.getElementById('tim-photo-cancel')?.addEventListener('click', () => {
    document.getElementById('tim-photo-modal').classList.remove('is-open');
  });

  document.getElementById('tim-photo-confirm')?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.photo-check:checked')]
      .map(cb => rows[parseInt(cb.dataset.idx)])
      .filter(r => r.found);

    const btn = document.getElementById('tim-photo-confirm');
    btn.disabled = true;
    btn.textContent = '⏳ Import…';

    let count = 0;
    for (const r of checked) {
      const p = participants.find(p => p.carNumber == r.carNumber);
      if (!p) continue;

      if (r.status) {
        await saveResult(p.driverId, null, r.status);
      } else if (r.time) {
        const ms = parseTimeString(r.time);
        if (ms && ms > 0) {
          await saveResult(p.driverId, ms, null);
          count++;
        }
      }
    }

    document.getElementById('tim-photo-modal').classList.remove('is-open');
    toast(`${count} temps importé(s) depuis la photo ✓`, 'success', 4000);
  });
}

// ─────────────────────────────────────────────────────────
// GRILLES DE DÉPART
// ─────────────────────────────────────────────────────────

async function showStartingGrid(session) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  let gridHtml = '';
  const label = session.type === 'MQ' ? `Manche qualificative ${session.num}`
    : session.type === 'DF' ? `Demi-finale ${session.num}`
    : 'Finale';

  // ── MQ : séries de 5, meilleurs en dernière série ──────
  if (session.type === 'MQ') {
    const total = participants.length;

    /**
     * Calcule la taille de chaque série selon le règlement FFSA :
     * - Min 3 pilotes par série, max 5
     * - Les meilleurs toujours en dernière série
     * - Récursif : dernière série = 5, puis on récurse sur n-5
     */
    function computeSeries(n) {
      if (n <= 5) return [n];
      if (n <= 10) {
        const first = Math.floor(n / 2);
        return [first, n - first];
      }
      return [...computeSeries(n - 5), 5];
    }

    const seriesSizes = computeSeries(total);

    // Construire les séries à partir de participants (déjà triés du moins bon au meilleur)
    const series = [];
    let cursor = 0;
    for (const size of seriesSizes) {
      series.push(participants.slice(cursor, cursor + size));
      cursor += size;
    }

    gridHtml = series.map((serie, si) => {
      // Dans chaque série, le mieux classé (dernier dans le tableau trié
      // du moins bon au meilleur) obtient la pole → on inverse l'affichage
      const serieDisplayed = [...serie].reverse();
      return `
        <div class="grid-serie">
          <div class="grid-serie-title">
            Série ${si + 1}${si === series.length - 1 ? ' — <span class="text-accent">Meilleurs qualifiés</span>' : ''}
          </div>
          ${serieDisplayed.map((p, pi) => `
            <div class="grid-row">
              <span class="grid-pos">${pi + 1}</span>
              <span class="grid-num">${escHtml(p.carNumber)}</span>
              <span class="grid-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
              ${pi === 0 ? '<span class="grid-pole">POLE</span>' : ''}
            </div>
          `).join('')}
        </div>
      `;
    }).join('');
  }

  // ── DF et Finale : grille 3 lignes (3-2-3) ────────────
  if (session.type === 'DF' || session.type === 'FIN') {
    let orderedPilots = [...participants];

    if (session.type === 'DF') {
      const intSnap = await getDocs(query(
        collection(db, 'interimStandings'),
        where('meetingId', '==', selectedMeetingId),
        where('category',  '==', selectedCategory)
      ));
      const intMap = {};
      intSnap.docs.forEach(d => { intMap[d.data().driverId] = d.data().position ?? 99; });
      orderedPilots.sort((a, b) => (intMap[a.driverId] ?? 99) - (intMap[b.driverId] ?? 99));
    }

    if (session.type === 'FIN') {
      const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
      const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);

      // Points DF par pilote
      const dfPtsMap  = {}; // driverId → points DF
      const dfPosMap  = {}; // driverId → position en DF (1er, 2ème, etc.)

      for (const df of [df1, df2].filter(Boolean)) {
        const resSnap  = await getDocs(query(collection(db,'results'),             where('sessionId','==',df.id)));
        const partSnap = await getDocs(query(collection(db,'sessionParticipants'), where('sessionId','==',df.id)));
        const resultMap = {};
        resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });

        // Calculer la position dans cette DF
        const finished = partSnap.docs
          .map(d => d.data())
          .map(p => ({ driverId: p.driverId, ms: resultMap[p.driverId]?.ms ?? null }))
          .filter(r => r.ms)
          .sort((a, b) => a.ms - b.ms);

        finished.forEach((r, i) => {
          dfPosMap[r.driverId] = i + 1;
          dfPtsMap[r.driverId] = resultMap[r.driverId]?.points ?? 0;
        });
      }
      // Points intermédiaires par pilote
      const intSnap = await getDocs(query(
        collection(db,'interimStandings'),
        where('meetingId','==',selectedMeetingId),
        where('category', '==',selectedCategory)
      ));
      const intPtsMap = {};
      intSnap.docs.forEach(d => {
        intPtsMap[d.data().driverId] = d.data().interimPoints ?? 0;
      });

      // Total points par pilote = intermédiaire + DF
      const totalPtsMap = {};
      orderedPilots.forEach(p => {
        totalPtsMap[p.driverId] = (intPtsMap[p.driverId] ?? 0) + (dfPtsMap[p.driverId] ?? 0);
      });

      // Tri : par rang DF croissant (1er avant 2ème),
      // puis au sein du même rang par total points décroissant
      const dfMsMap = {}; // driverId → temps en ms dans sa DF
      for (const df of [df1, df2].filter(Boolean)) {
        const resSnap = await getDocs(query(
          collection(db,'results'), where('sessionId','==',df.id)
        ));
        resSnap.docs.forEach(d => {
          const r = d.data();
          if (r.ms) dfMsMap[r.driverId] = r.ms;
        });
      }

      orderedPilots.sort((a, b) => {
        // 1. Rang DF croissant (1er avant 2ème, etc.)
        const posA = dfPosMap[a.driverId] ?? 99;
        const posB = dfPosMap[b.driverId] ?? 99;
        if (posA !== posB) return posA - posB;

        // 2. Total points décroissant (intermédiaire + DF)
        const ptsA = totalPtsMap[a.driverId] ?? 0;
        const ptsB = totalPtsMap[b.driverId] ?? 0;
        if (ptsA !== ptsB) return ptsB - ptsA;

        // 3. Temps DF croissant (le plus rapide devant)
        return (dfMsMap[a.driverId] ?? Infinity) - (dfMsMap[b.driverId] ?? Infinity);
      });
    }

    // Récupérer le côté de pole du meeting
    const meeting = allMeetings.find(m => m.id === selectedMeetingId);
    const poleSide = meeting?.poleSide || 'droite';
    const poleLabel = poleSide === 'gauche' ? '◀ Côté gauche' : 'Côté droit ▶';

    /**
     * Disposition réglementaire 3-2-3 sur 5 couloirs :
     * Ligne 1 : couloirs 1, 3, 5  (le meilleur classé = POLE en couloir 1)
     * Ligne 2 : couloirs 2, 4
     * Ligne 3 : couloirs 1, 3, 5
     * 
     * Attribution par classement :
     * 1er → C1 L1 (POLE)
     * 2nd → C2 L2
     * 3ème → C3 L1
     * 4ème → C4 L2
     * 5ème → C5 L1
     * 6ème → C1 L3
     * 7ème → C3 L3
     * 8ème → C5 L3
     */
    // Séquentiel : les 3 premiers sur la L1, les 2 suivants sur L2, les 3 derniers sur L3
    // Couloirs : L1 et L3 → 1, 3, 5 / L2 → 2, 4
    const assignments = [
      { ligne: 1, couloir: 1, pole: true  }, // 1er
      { ligne: 1, couloir: 3, pole: false }, // 2ème
      { ligne: 1, couloir: 5, pole: false }, // 3ème
      { ligne: 2, couloir: 2, pole: false }, // 4ème
      { ligne: 2, couloir: 4, pole: false }, // 5ème
      { ligne: 3, couloir: 1, pole: false }, // 6ème
      { ligne: 3, couloir: 3, pole: false }, // 7ème
      { ligne: 3, couloir: 5, pole: false }, // 8ème
    ];

    // Construire la grille par ligne
    const grid = { 1: [], 2: [], 3: [] };
    orderedPilots.slice(0, 8).forEach((p, i) => {
      const a = assignments[i];
      if (a) grid[a.ligne].push({ ...a, pilot: p });
    });
    // Trier chaque ligne par couloir
    [1,2,3].forEach(l => grid[l].sort((a,b) => a.couloir - b.couloir));

    // Si pole à gauche, inverser l'ordre des couloirs dans l'affichage
    // Pole à droite → C1 s'affiche à droite → on inverse l'ordre d'affichage
    const reverseForDisplay = poleSide === 'droite';
    if (reverseForDisplay) {
      [1,2,3].forEach(l => grid[l].reverse());
    }

    const lineLabels = { 1: '1ère ligne', 2: '2ème ligne', 3: '3ème ligne' };

    gridHtml = `
      <div class="grid-note">
        ⭐ Le pilote en pole position choisit librement sa place sur la 1ère ligne
        <span style="margin-left:8px;font-size:0.8rem">${poleLabel}</span>
      </div>
      ${[1,2,3].map(lineNum => {
        const slots = grid[lineNum];
        if (slots.length === 0) return '';
        return `
          <div class="grid-serie">
            <div class="grid-serie-title">${lineLabels[lineNum]}</div>
            <div class="grid-line-row">
              ${slots.map(s => `
                <div class="grid-line-slot ${s.pole ? 'grid-line-slot--pole' : ''}">
                  <div class="grid-couloir">C${s.couloir}</div>
                  <div class="grid-num">${escHtml(s.pilot.carNumber)}</div>
                  <div class="grid-name-sm">${escHtml(s.pilot.lastName)}</div>
                  ${s.pole ? '<div class="grid-pole">POLE</div>' : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
    `;
  }

  // Afficher dans une modale
  let modal = document.getElementById('tim-grid-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tim-grid-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:500px">
        <div class="modal-header">
          <span class="modal-title" id="tim-grid-title"></span>
          <button class="modal-close" id="tim-grid-close">✕</button>
        </div>
        <div class="modal-body" id="tim-grid-body"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="tim-grid-print">🖨️ Imprimer</button>
          <button class="btn btn-primary" id="tim-grid-close2">Fermer</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('tim-grid-close')?.addEventListener('click',  () => modal.classList.remove('is-open'));
    document.getElementById('tim-grid-close2')?.addEventListener('click', () => modal.classList.remove('is-open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('is-open'); });
    document.getElementById('tim-grid-print')?.addEventListener('click', () => window.print());
  }

  document.getElementById('tim-grid-title').textContent = `Grille de départ — ${label}`;
  document.getElementById('tim-grid-body').innerHTML = gridHtml || '<p class="text-muted">Aucun pilote assigné à cette session.</p>';
  modal.classList.add('is-open');
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initTiming() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'timing') {
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) await loadSessions();
      if (selectedSessionId) {
        await loadParticipants();
        await loadResults();
      }
    }
  });
}