/* ═══════════════════════════════════════════════
   TIMING.JS — Interface chronométrage terrain
   EC : meilleur tour (1 champ temps)
   MQ / DF / FIN : temps total session (min | sec | ms)
   Statuts : DNS, DNF, DSQ, DSQ_RACE
   Navigation Entrée entre les champs
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { msToDisplay, inputToMs, msToFields, escHtml, parseTimeString } from './utils.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings    = [];
let allSessions    = [];
let participants   = [];
let results        = {};
let unsubMeetings  = null;
let unsubSessions  = null;
let unsubResults   = null;

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let selectedSessionId = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];
const SESSION_LABELS = { EC: 'Essais chronométrés', MQ: 'Manche qualificative', QF: 'Quart de finale', DF: 'Demi-finale', FIN: 'Finale' };

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}
const SPECIAL_STATUSES = ['DNS', 'DNF', 'DSQ', 'DSQ_RACE'];

// ─────────────────────────────────────────────────────────
// SÉRIES MQ — structure & validation
// (même algorithme que computeSeries() utilisé par la grille)
// ─────────────────────────────────────────────────────────

function computeSeriesSizes(n) {
  if (n <= 0) return [];
  if (n <= 5) return [n];
  if (n <= 10) { const first = Math.floor(n / 2); return [first, n - first]; }
  return [...computeSeriesSizes(n - 5), 5];
}

function getSeriesStructure(nbParticipants) {
  const sizes = computeSeriesSizes(nbParticipants);
  return {
    nbSeries: sizes.length,
    sizes,
    maxCouloir: sizes.length ? Math.max(...sizes) : 0,
  };
}

// Vérifie qu'une nouvelle combinaison série/couloir est valide pour un pilote.
function validateMeta(driverId, newSerie, newCouloir) {
  // Valeurs à vide (0/null) : toujours OK
  const { nbSeries, sizes } = getSeriesStructure(participants.length);
  if (newSerie) {
    if (newSerie > nbSeries) return { ok: false, msg: `Ce meeting ne compte que ${nbSeries} série${nbSeries>1?'s':''}` };
    const cap = sizes[newSerie - 1];
    const countInSerie = Object.entries(results).filter(([dId, r]) =>
      dId !== driverId && r.serie === newSerie
    ).length;
    if (countInSerie >= cap) return { ok: false, msg: `Série ${newSerie} déjà complète (${cap} pilotes max)` };
  }
  if (newSerie && newCouloir) {
    const cap = sizes[newSerie - 1];
    if (newCouloir > cap) return { ok: false, msg: `Série ${newSerie} : couloir max = ${cap}` };
    const conflict = Object.entries(results).find(([dId, r]) =>
      dId !== driverId && r.serie === newSerie && r.couloir === newCouloir
    );
    if (conflict) return { ok: false, msg: `Couloir ${newCouloir} déjà pris dans la série ${newSerie}` };
  }
  return { ok: true };
}

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
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const champId = getActiveChampionshipId();
    allMeetings = champId ? all.filter(m => m.championshipId === champId || !m.championshipId) : all;
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
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', selectedSessionId)
  );
  const snap = await getDocs(q);
  const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const session = allSessions.find(s => s.id === selectedSessionId);
  participants = await sortParticipantsForTiming(raw, session);
  renderTimingTable();
}

// ─────────────────────────────────────────────────────────
// TRI INTELLIGENT DES PARTICIPANTS
// ─────────────────────────────────────────────────────────

async function sortParticipantsForTiming(raw, session) {
  if (!session) return raw.sort((a, b) => b.carNumber - a.carNumber);

  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // ── Essais chronométrés ────────────────────────────────
  if (session.type === 'EC') {
    try {
      const { calcInterimStandings } = await import('./calc.js');
      const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
      const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

      const allMeetingsSnap = await getDocs(query(
        collection(db, 'meetings'),
        where('year', '==', selectedYear)
      ));
      const pastMeetings = allMeetingsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m =>
          m.id !== selectedMeetingId &&
          m.date < (allMeetings.find(x => x.id === selectedMeetingId)?.date || '9999')
        );

      if (pastMeetings.length === 0) {
        return raw.sort((a, b) => b.carNumber - a.carNumber);
      }

      const pointsMap = {};

      for (const meeting of pastMeetings) {
        const sessSnap = await getDocs(query(
          collection(db, 'sessions'),
          where('meetingId', '==', meeting.id),
          where('category',  '==', selectedCategory)
        ));
        const meetingSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (!meetingSessions.length) continue;

        const interim = await calcInterimStandings(db, meetingSessions);
        interim.forEach(r => {
          if (!pointsMap[r.driverId]) pointsMap[r.driverId] = 0;
          pointsMap[r.driverId] += r.interimPoints ?? 0;
        });

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

      const notRanked = raw
        .filter(p => !pointsMap[p.driverId])
        .sort((a, b) => b.carNumber - a.carNumber);
      const ranked = raw
        .filter(p => pointsMap[p.driverId])
        .sort((a, b) => pointsMap[a.driverId] - pointsMap[b.driverId]);

      return [...notRanked, ...ranked];

    } catch (e) {
      console.warn('Tri EC :', e);
    }
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── MQ1 → inverse classement EC ────────────────────────
  if (session.type === 'MQ' && session.num === 1) {
    const ecSession = allSessions.find(s => s.type === 'EC');
    if (ecSession) {
      const ecResults = await getSessionResultsSorted(ecSession.id);
      if (ecResults.length > 0) return sortByReferenceInverse(raw, ecResults);
    }
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── MQ2/3/4 → inverse MQ précédente ────────────────────
  if (session.type === 'MQ' && session.num > 1) {
    const prevMQ = allSessions.find(s => s.type === 'MQ' && s.num === session.num - 1);
    if (prevMQ) {
      const prevResults = await getSessionResultsSorted(prevMQ.id);
      if (prevResults.length > 0) return sortByReferenceInverse(raw, prevResults);
    }
    return raw.sort((a, b) => b.carNumber - a.carNumber);
  }

  // ── DF / FIN → numéros décroissants ────────────────────
  return raw.sort((a, b) => b.carNumber - a.carNumber);
}

async function getSessionResultsSorted(sessionId) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  try {
    const snap = await getDocs(query(
      collection(db, 'results'),
      where('sessionId', '==', sessionId)
    ));
    return snap.docs.map(d => d.data()).sort((a, b) => {
      const aZero = ['DNS','DSQ'].includes(a.status);
      const bZero = ['DNS','DSQ'].includes(b.status);
      if (aZero && !bZero) return 1;
      if (!aZero && bZero) return -1;
      const aSpecial = ['DNF','DSQ_RACE'].includes(a.status);
      const bSpecial = ['DNF','DSQ_RACE'].includes(b.status);
      if (aSpecial && !bSpecial) return 1;
      if (!aSpecial && bSpecial) return -1;
      return (a.ms ?? Infinity) - (b.ms ?? Infinity);
    });
  } catch { return []; }
}

function sortByReferenceInverse(raw, reference) {
  const posMap = {};
  reference.forEach((r, i) => { posMap[r.driverId] = i; });
  const notInRef = raw.filter(p => posMap[p.driverId] === undefined)
    .sort((a, b) => b.carNumber - a.carNumber);
  const inRef = raw.filter(p => posMap[p.driverId] !== undefined)
    .sort((a, b) => posMap[b.driverId] - posMap[a.driverId]);
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
      results[data.driverId] = {
        docId: d.id,
        ms: data.ms,
        status: data.status,
        createdAt: data.createdAt,
        manualPosition: data.manualPosition ?? null,
        serie: data.serie ?? null,
        couloir: data.couloir ?? null,
      };
    });
    renderTimingTable();
  });
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — SAUVEGARDE
// ← FIX OPTION 1 : setDoc avec ID déterministe pour éviter les doublons
// ─────────────────────────────────────────────────────────

async function saveResult(driverId, ms, status, manualPosition = null) {
  if (!db || !selectedSessionId) return;
  if (!requireAuth()) return;
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const session = allSessions.find(s => s.id === selectedSessionId);
  const participant = participants.find(p => p.driverId === driverId);
  if (!participant) return;

  const existing = results[driverId] || {};
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
    // Métadonnées MQ (série / couloir de départ) — préservées si déjà définies
    serie:          existing.serie ?? null,
    couloir:        existing.couloir ?? null,
    updatedAt:      new Date(),
    // Conserver la date de création si le document existe déjà
    createdAt:      existing.createdAt ?? new Date(),
  };

  // ID déterministe = sessionId_driverId → impossible d'avoir un doublon
  const docId = `${selectedSessionId}_${driverId}`;

  try {
    await setDoc(doc(db, 'results', docId), data, { merge: true });
    logAudit('update', 'result', docId, { label: `#${participant.carNumber} ${participant.firstName} ${participant.lastName}`, ms, status: status || null });
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
  }
}

// Sauvegarde seule des métadonnées série/couloir (MQ) — ne touche pas au temps
async function saveMeta(driverId, serie, couloir) {
  if (!db || !selectedSessionId) return;
  if (!requireAuth()) return;
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const session = allSessions.find(s => s.id === selectedSessionId);
  const participant = participants.find(p => p.driverId === driverId);
  if (!participant) return;

  const existing = results[driverId] || {};
  const data = {
    sessionId:   selectedSessionId,
    meetingId:   selectedMeetingId,
    category:    selectedCategory,
    year:        selectedYear,
    sessionType: session?.type || '',
    driverId,
    carNumber:   participant.carNumber,
    firstName:   participant.firstName,
    lastName:    participant.lastName,
    serie:       serie ?? null,
    couloir:     couloir ?? null,
    updatedAt:   new Date(),
    createdAt:   existing.createdAt ?? new Date(),
  };

  const docId = `${selectedSessionId}_${driverId}`;
  try {
    await setDoc(doc(db, 'results', docId), data, { merge: true });
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde série/couloir', 'error');
  }
}

async function clearResult(driverId) {
  if (!db) return;
  if (!requireAuth()) return;
  const existing = results[driverId];
  if (!existing?.docId) return;
  const { doc, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  logAudit('delete', 'result', existing.docId, { label: `Temps efface pour pilote ${driverId}` });
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

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm);margin-bottom:var(--sp-md)">
      <select class="toolbar-select" id="tim-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="tim-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="tim-category">
        <option value="">— Catégorie —</option>
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="tim-session" style="min-width:180px">
        <option value="">— Session —</option>
      </select>
    </div>

    <div id="tim-session-info" style="display:none" class="tim-session-banner">
      <span id="tim-session-badge"></span>
      <span id="tim-session-name"></span>
      <span id="tim-session-tours" class="text-muted"></span>
    </div>

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

  if (banner) {
    banner.style.display = 'flex';
    const badgeEl = document.getElementById('tim-session-badge');
    const nameEl  = document.getElementById('tim-session-name');
    const toursEl = document.getElementById('tim-session-tours');
    const typeLabel = session.type === 'MQ' ? `MQ${session.num}` : session.type === 'DF' ? `DF${session.num}` : session.type;
    if (badgeEl) badgeEl.innerHTML = `<span class="badge badge-${session.type.toLowerCase()}">${typeLabel}</span>`;
    if (nameEl)  nameEl.textContent = session.label;
    if (toursEl) toursEl.textContent = `· ${session.tours} tour${session.tours > 1 ? 's' : ''}`;

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
    if (gridBtn) gridBtn.onclick = () => showStartingGrid(session);

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

  const timed   = participants.filter(p => results[p.driverId]?.ms != null || SPECIAL_STATUSES.includes(results[p.driverId]?.status));
  const untimed = participants.filter(p => !results[p.driverId]?.ms && !SPECIAL_STATUSES.includes(results[p.driverId]?.status));

  const sortedTimed = [...timed].sort((a, b) => {
    const ra = results[a.driverId];
    const rb = results[b.driverId];
    const sortVal = (r) => {
      if (r?.ms) return r.ms;
      if (r?.status === 'DNF' && r?.manualPosition) return r.manualPosition * 1000000;
      return Infinity;
    };
    return sortVal(ra) - sortVal(rb);
  });

  content.innerHTML = `
    <div class="tim-mobile-toggle" id="tim-mobile-toggle">
      <button class="tim-toggle-btn is-active" data-panel="untimed">
        ⏱️ À chronométrer <span class="tim-toggle-count">${untimed.length}</span>
      </button>
      <button class="tim-toggle-btn" data-panel="timed">
        🏁 Classement <span class="tim-toggle-count">${timed.length}</span>
      </button>
    </div>

    <div class="tim-layout">
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

function metaControls(p, session) {
  if (session.type !== 'MQ') return '';
  const r = results[p.driverId] || {};
  const serie   = r.serie   ?? null;
  const couloir = r.couloir ?? null;
  return `
    <div class="tim-meta" data-driver-id="${p.driverId}">
      <div class="tim-meta-item" title="Série de départ (facultatif)">
        <span class="tim-meta-label">Série</span>
        <button type="button" class="tim-meta-btn tim-serie-down" data-driver-id="${p.driverId}" aria-label="Série −">−</button>
        <span class="tim-meta-val tim-serie-val" data-driver-id="${p.driverId}">${serie ?? '—'}</span>
        <button type="button" class="tim-meta-btn tim-serie-up" data-driver-id="${p.driverId}" aria-label="Série +">+</button>
      </div>
      <div class="tim-meta-item" title="Couloir de départ (facultatif)">
        <span class="tim-meta-label">Couloir</span>
        <button type="button" class="tim-meta-btn tim-couloir-down" data-driver-id="${p.driverId}" aria-label="Couloir −">−</button>
        <span class="tim-meta-val tim-couloir-val" data-driver-id="${p.driverId}">${couloir ?? '—'}</span>
        <button type="button" class="tim-meta-btn tim-couloir-up" data-driver-id="${p.driverId}" aria-label="Couloir +">+</button>
      </div>
    </div>
  `;
}

function pilotRowUntimed(p, session) {
  const isDfOrFin = session.type === 'DF' || session.type === 'FIN';
  const maxPos = 8;

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
      ${metaControls(p, session)}
      <div class="tim-status-btns">
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DNS">DNS</button>
        <div class="tim-dnf-group">
          <button class="btn btn-ghost btn-sm tim-status-btn tim-dnf-btn" data-driver-id="${p.driverId}" data-status="DNF">DNF</button>
          ${dnfPositionSelect}
        </div>
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DSQ">DSQ HC</button>
        <button class="btn btn-ghost btn-sm tim-status-btn" data-driver-id="${p.driverId}" data-status="DSQ_RACE">DSQ EC</button>
      </div>
    </div>
  `;
}

function pilotRowTimed(p, index, session) {
  const r = results[p.driverId];
  const isSpecial = SPECIAL_STATUSES.includes(r?.status);
  const isDnfWithPos = r?.status === 'DNF' && r?.manualPosition;
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
      ${metaControls(p, session)}
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

  content.querySelectorAll('.tim-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      content.querySelectorAll('.tim-toggle-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const panel = btn.dataset.panel;
      const untimed = content.querySelector('#tim-panel-untimed');
      const timed   = content.querySelector('#tim-panel-timed');
      if (panel === 'untimed') {
        if (untimed) untimed.style.display = '';
        if (timed)   timed.style.display   = window.innerWidth <= 800 ? 'none' : '';
      } else {
        if (untimed) untimed.style.display = window.innerWidth <= 800 ? 'none' : '';
        if (timed)   timed.style.display   = '';
      }
    });
  });

  content.querySelectorAll('.tim-save-btn').forEach(btn => {
    btn.addEventListener('click', () => onSaveTime(btn.dataset.driverId, session));
  });

  content.querySelectorAll('.tim-status-btn').forEach(btn => {
    btn.addEventListener('click', () => onSaveStatus(btn.dataset.driverId, btn.dataset.status));
  });

  content.querySelectorAll('.tim-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => onEditResult(btn.dataset.driverId));
  });

  // ── MQ : sélecteurs ± série / couloir ────────────────────
  if (session.type === 'MQ') {
    const bumpMeta = (driverId, field, delta) => {
      const r = results[driverId] || {};
      const current = field === 'serie' ? (r.serie ?? 0) : (r.couloir ?? 0);
      const { nbSeries, maxCouloir } = getSeriesStructure(participants.length);
      const hardMax = field === 'serie' ? nbSeries : maxCouloir;
      let next = current + delta;
      if (next < 0) next = 0;
      if (next > hardMax) next = hardMax;
      if (next === current) return;

      const newSerie   = field === 'serie'   ? (next || null) : (r.serie   ?? null);
      const newCouloir = field === 'couloir' ? (next || null) : (r.couloir ?? null);

      const check = validateMeta(driverId, newSerie, newCouloir);
      if (!check.ok) { toast(check.msg, 'error'); return; }

      // Mise à jour optimiste du cache local + affichage avant écriture Firestore
      results[driverId] = { ...r, serie: newSerie, couloir: newCouloir };
      const serieEl   = content.querySelector(`.tim-serie-val[data-driver-id="${driverId}"]`);
      const couloirEl = content.querySelector(`.tim-couloir-val[data-driver-id="${driverId}"]`);
      if (serieEl)   serieEl.textContent   = newSerie   ?? '—';
      if (couloirEl) couloirEl.textContent = newCouloir ?? '—';

      saveMeta(driverId, newSerie, newCouloir);
    };

    content.querySelectorAll('.tim-serie-up').forEach(btn => {
      btn.addEventListener('click', () => bumpMeta(btn.dataset.driverId, 'serie', +1));
    });
    content.querySelectorAll('.tim-serie-down').forEach(btn => {
      btn.addEventListener('click', () => bumpMeta(btn.dataset.driverId, 'serie', -1));
    });
    content.querySelectorAll('.tim-couloir-up').forEach(btn => {
      btn.addEventListener('click', () => bumpMeta(btn.dataset.driverId, 'couloir', +1));
    });
    content.querySelectorAll('.tim-couloir-down').forEach(btn => {
      btn.addEventListener('click', () => bumpMeta(btn.dataset.driverId, 'couloir', -1));
    });
  }

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
        const rows = [...content.querySelectorAll('.tim-row--untimed')];
        const idx  = rows.findIndex(r => r.dataset.driverId === driverId);
        if (idx !== -1 && rows[idx + 1]) {
          rows[idx + 1].querySelector('.tim-min')?.focus();
        }
      }
    });

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
  if (!min && !sec && !ms) return;

  const totalMs = inputToMs(min || '0', sec || '0', ms || '0');
  if (totalMs === null || totalMs <= 0) {
    toast('Temps invalide — vérifiez les secondes (0-59) et les millisecondes (0-999)', 'error');
    return;
  }

  await saveResult(driverId, totalMs, null);
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

  let fileInput = document.getElementById('tim-photo-input');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'tim-photo-input';
    fileInput.accept = 'image/*,application/pdf';
    fileInput.capture = 'environment';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
  }

  fileInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileInput.value = '';
    await processPhotoImport(file, session, apiKey);
  };

  fileInput.click();
}

async function processPhotoImport(file, session, apiKey) {
  showPhotoModal(`
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Analyse de la photo en cours…</span>
    </div>
  `, 'Reconnaissance en cours…', false);

  try {
    const isPdf = file.type === 'application/pdf' || file.name?.endsWith('.pdf');
    if (isPdf) {
      showPhotoModal(`<div class="loading-state"><div class="spinner"></div><span>Conversion du PDF en cours…</span></div>`, 'Préparation…', false);
    }
    const base64 = await fileToBase64(file);
    const mediaType = isPdf ? 'image/jpeg'
      : (file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg');

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
  if (file.type === 'application/pdf' || file.name?.endsWith('.pdf')) {
    return await pdfPageToBase64(file);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function pdfPageToBase64(file) {
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

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const scale = 2.5;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

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
    document.getElementById('tim-photo-modal-close')?.addEventListener('click', () => modal.classList.remove('is-open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('is-open'); });
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
// ← FIX OPTION 2 : bloc DF utilise calcInterimStandings au lieu de lire interimStandings Firestore
// ← FIX OPTION 2 : bloc FIN utilise calcInterimStandings au lieu de lire interimStandings Firestore
// ─────────────────────────────────────────────────────────

async function showStartingGrid(session) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const { calcInterimStandings } = await import('./calc.js');

  let gridHtml = '';
  const label = session.type === 'MQ' ? `Manche qualificative ${session.num}`
    : session.type === 'DF' ? `Demi-finale ${session.num}`
    : 'Finale';

  // ── MQ : séries FFSA ───────────────────────────────────
  if (session.type === 'MQ') {
    const total = participants.length;

    function computeSeries(n) {
      if (n <= 5) return [n];
      if (n <= 10) { const first = Math.floor(n / 2); return [first, n - first]; }
      return [...computeSeries(n - 5), 5];
    }

    const seriesSizes = computeSeries(total);
    const series = [];
    let cursor = 0;
    for (const size of seriesSizes) {
      series.push(participants.slice(cursor, cursor + size));
      cursor += size;
    }

    gridHtml = series.map((serie, si) => {
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
      const champ0 = getActiveChampionship();
      const qfEnabled = champ0?.sessionConfig?.QF?.enabled;

      if (qfEnabled) {
        // Mode QF→DF : trier par position QF (qualifies d'abord, remplacants en dernier)
        const qualPerQF = champ0?.sessionConfig?.QF?.qualifiedPerQF || 3;
        const dfSessions0 = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
        const qfSessions0 = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
        const dfIdx0 = dfSessions0.findIndex(d => d.id === session.id);

        // QFs qui alimentent cette DF
        const feedQfResults = [];
        for (let q = dfIdx0; q < qfSessions0.length; q += dfSessions0.length) {
          const qf = qfSessions0[q];
          if (!qf) continue;
          const pSnap = await getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', qf.id)));
          const rSnap = await getDocs(query(collection(db, 'results'), where('sessionId', '==', qf.id)));
          const rMap = {};
          rSnap.docs.forEach(d => { rMap[d.data().driverId] = d.data(); });
          const rows0 = pSnap.docs.map(d => d.data()).map(p => ({
            driverId: p.driverId, ms: rMap[p.driverId]?.ms ?? null,
            status: rMap[p.driverId]?.status ?? null,
          }));
          const order0 = r => r.ms ? r.ms : r.status === 'DNF' ? 9e6 : 9e9;
          rows0.sort((a, b) => order0(a) - order0(b));
          let pos0 = 1;
          rows0.forEach(r => { r.qfPosition = (r.ms || r.status === 'DNF') ? pos0++ : null; });
          feedQfResults.push(rows0);
        }

        // Qualified by QF position level
        const qfOrder = {};
        let ord = 0;
        for (let posLevel = 1; posLevel <= qualPerQF; posLevel++) {
          for (const qfRes of feedQfResults) {
            const d = qfRes.find(r => r.qfPosition === posLevel);
            if (d) qfOrder[d.driverId] = ord++;
          }
        }

        // Qualified first, then replacements (anyone not in qfOrder) at the end
        orderedPilots.sort((a, b) => (qfOrder[a.driverId] ?? 9999) - (qfOrder[b.driverId] ?? 9999));
      } else {
        // Mode direct MQ→DF : trier par classement intermediaire
        const interim = await calcInterimStandings(db, allSessions);
        const intMap = {};
        interim.forEach(r => { intMap[r.driverId] = r.position ?? 99; });
        orderedPilots.sort((a, b) => (intMap[a.driverId] ?? 99) - (intMap[b.driverId] ?? 99));
      }
    }

    if (session.type === 'FIN') {
      const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
      const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);

      const dfPtsMap = {};
      const dfPosMap = {};

      for (const df of [df1, df2].filter(Boolean)) {
        const resSnap  = await getDocs(query(collection(db,'results'),             where('sessionId','==',df.id)));
        const partSnap = await getDocs(query(collection(db,'sessionParticipants'), where('sessionId','==',df.id)));
        const resultMap = {};
        resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });

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

      // ← FIX OPTION 2 : calcul direct, plus de lecture interimStandings Firestore
      const interim = await calcInterimStandings(db, allSessions);
      const intPtsMap = {};
      interim.forEach(r => { intPtsMap[r.driverId] = r.interimPoints ?? 0; });

      const totalPtsMap = {};
      orderedPilots.forEach(p => {
        totalPtsMap[p.driverId] = (intPtsMap[p.driverId] ?? 0) + (dfPtsMap[p.driverId] ?? 0);
      });

      const dfMsMap = {};
      for (const df of [df1, df2].filter(Boolean)) {
        const resSnap = await getDocs(query(collection(db,'results'), where('sessionId','==',df.id)));
        resSnap.docs.forEach(d => {
          const r = d.data();
          if (r.ms) dfMsMap[r.driverId] = r.ms;
        });
      }

      orderedPilots.sort((a, b) => {
        const posA = dfPosMap[a.driverId] ?? 99;
        const posB = dfPosMap[b.driverId] ?? 99;
        if (posA !== posB) return posA - posB;
        const ptsA = totalPtsMap[a.driverId] ?? 0;
        const ptsB = totalPtsMap[b.driverId] ?? 0;
        if (ptsA !== ptsB) return ptsB - ptsA;
        return (dfMsMap[a.driverId] ?? Infinity) - (dfMsMap[b.driverId] ?? Infinity);
      });
    }

    const meeting = allMeetings.find(m => m.id === selectedMeetingId);
    const poleSide = meeting?.poleSide || 'droite';
    const poleLabel = poleSide === 'gauche' ? '◀ Côté gauche' : 'Côté droit ▶';

    // Lire gridLayout depuis le reglement du championnat
    const champ = getActiveChampionship();
    const phaseConfig = session.type === 'DF' ? champ?.sessionConfig?.DF : champ?.sessionConfig?.FIN;
    const gridLayout = phaseConfig?.gridLayout;
    const lanes = gridLayout?.lanes || 5;
    const rows  = gridLayout?.rows  || 3;
    const positions = gridLayout?.positions || {};

    // Construire les assignments depuis gridLayout
    const sortedPositions = Object.entries(positions).sort((a, b) => a[1] - b[1]);
    const assignments = sortedPositions.map(([key, posNum], i) => {
      const [r, c] = key.split('-').map(Number);
      return { ligne: r + 1, couloir: c + 1, pole: i === 0 };
    });

    const grid = {};
    for (let r = 1; r <= rows; r++) grid[r] = [];

    orderedPilots.slice(0, assignments.length).forEach((p, i) => {
      const a = assignments[i];
      if (a) grid[a.ligne].push({ ...a, pilot: p });
    });
    Object.keys(grid).forEach(l => grid[l].sort((a, b) => a.couloir - b.couloir));

    const reverseForDisplay = poleSide === 'droite';
    if (reverseForDisplay) Object.keys(grid).forEach(l => grid[l].reverse());

    const lineLabels = {};
    for (let r = 1; r <= rows; r++) {
      lineLabels[r] = r === 1 ? '1ère ligne' : r + 'ème ligne';
    }

    gridHtml = `
      <div class="grid-note">
        ⭐ Le pilote en pole position choisit librement sa place sur la 1ère ligne
        <span style="margin-left:8px;font-size:0.8rem">${poleLabel}</span>
      </div>
      ${Object.keys(grid).map(Number).sort((a, b) => a - b).map(lineNum => {
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
  document.addEventListener('championshipchange', () => { loadMeetings(); });
}