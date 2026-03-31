/* ═══════════════════════════════════════════════
   TIMING.JS — Interface chronométrage terrain
   EC : meilleur tour (1 champ temps)
   MQ / DF / FIN : temps total session (min | sec | ms)
   Statuts : DNS, DNF, DSQ, DSQ_RACE
   Navigation Entrée entre les champs
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { msToDisplay, inputToMs, msToFields, escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

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
    // Tenter de récupérer le classement général championnat
    try {
      const champQ = query(
        collection(db, 'championshipStandings'),
        where('year',     '==', selectedYear),
        where('category', '==', selectedCategory),
        orderBy('position', 'asc')
      );
      const champSnap = await getDocs(champQ);

      if (!champSnap.empty) {
        // Classement général existant
        const ranked = champSnap.docs.map(d => d.data());
        const rankedMap = {}; // driverId → position
        ranked.forEach(r => { rankedMap[r.driverId] = r.position; });

        const notRanked = raw.filter(p => !rankedMap[p.driverId])
          .sort((a, b) => b.carNumber - a.carNumber); // numéros décroissants
        const isRanked = raw.filter(p =>  rankedMap[p.driverId])
          .sort((a, b) => rankedMap[b.driverId] - rankedMap[a.driverId]); // classement décroissant (le moins bon en premier)

        return [...notRanked, ...isRanked];
      }
    } catch {}

    // Fallback : numéros décroissants (premier meeting ou pas de classement)
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
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
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

  // Trier les chronométrés par temps (DNS/DNF/DSQ en dernier)
  const sortedTimed = [...timed].sort((a, b) => {
    const ra = results[a.driverId];
    const rb = results[b.driverId];
    const aMs = ra?.ms ?? Infinity;
    const bMs = rb?.ms ?? Infinity;
    const aSpecial = SPECIAL_STATUSES.includes(ra?.status);
    const bSpecial = SPECIAL_STATUSES.includes(rb?.status);
    if (aSpecial && !bSpecial) return 1;
    if (!aSpecial && bSpecial) return -1;
    return aMs - bMs;
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
  const statusLabel = r?.status === 'DSQ_RACE' ? 'DSQ EC' : r?.status === 'DSQ' ? 'DSQ HC' : r?.status;
  const manualPosLabel = r?.status === 'DNF' && r?.manualPosition ? ` (${r.manualPosition}ème)` : '';
  const badgeCls = r?.status === 'DNF' ? 'badge-dnf' : r?.status === 'DNS' ? 'badge-dns' : 'badge-dsq';
  const displayTime = isSpecial
    ? `<span class="badge ${badgeCls}">${statusLabel}${manualPosLabel}</span>`
    : `<span class="tim-time">${msToDisplay(r?.ms)}</span>`;

  return `
    <div class="tim-row tim-row--timed" data-driver-id="${p.driverId}">
      <span class="tim-pos">${isSpecial ? '—' : index + 1}</span>
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
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('timing-styles')) return;
  const style = document.createElement('style');
  style.id = 'timing-styles';
  style.textContent = `
    /* Banner session active */
    .tim-session-banner {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-sm) var(--sp-md);
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-md);
      margin-bottom: var(--sp-md);
      font-size: 0.9rem;
      flex-wrap: wrap;
    }
    .tim-session-banner .badge { font-size: 0.75rem; }

    /* Layout 2 colonnes */
    .tim-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--sp-md);
      align-items: start;
    }
    @media (max-width: 800px) { .tim-layout { grid-template-columns: 1fr; } }

    /* Panels */
    .tim-panel {
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
      overflow: hidden;
    }
    .tim-panel--untimed { border-top: 3px solid var(--clr-warning); }
    .tim-panel--timed   { border-top: 3px solid var(--clr-success); }

    .tim-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px var(--sp-md);
      background: var(--clr-bg-3);
      border-bottom: 1px solid var(--clr-border);
    }
    .tim-panel-title {
      font-family: var(--font-condensed);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
    }
    .tim-panel-count {
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-accent-2);
    }

    /* Rows */
    .tim-row {
      padding: 8px var(--sp-md);
      border-bottom: 1px solid var(--clr-border);
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      flex-wrap: wrap;
    }
    .tim-row:last-child { border-bottom: none; }
    .tim-row--untimed { background: var(--clr-surface); }
    .tim-row--untimed:hover { background: var(--clr-surface-2); }
    .tim-row--timed { background: var(--clr-surface); }

    /* Numéro, nom */
    .tim-num {
      min-width: 38px;
      text-align: center;
      font-family: var(--font-display);
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--clr-accent-2);
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      padding: 2px 5px;
      flex-shrink: 0;
    }
    .tim-name { flex: 1; font-size: 0.88rem; min-width: 80px; }
    .tim-name strong { font-weight: 600; }
    .tim-pos {
      min-width: 24px;
      font-family: var(--font-display);
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--clr-text-3);
      text-align: center;
      flex-shrink: 0;
    }

    /* Champs de saisie temps */
    .tim-input-group {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .tim-input {
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      color: var(--clr-text);
      font-family: var(--font-display);
      font-size: 0.88rem;
      font-weight: 600;
      text-align: center;
      outline: none;
      transition: border-color var(--tr-fast), box-shadow var(--tr-fast);
      -moz-appearance: textfield;
    }
    .tim-input::-webkit-outer-spin-button,
    .tim-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .tim-input:focus {
      border-color: var(--clr-accent);
      box-shadow: 0 0 0 2px var(--clr-accent-dim);
    }
    .tim-min { width: 36px; padding: 5px 4px; }
    .tim-sec { width: 36px; padding: 5px 4px; }
    .tim-ms  { width: 46px; padding: 5px 4px; }
    .tim-sep { color: var(--clr-text-3); font-weight: 700; font-size: 0.9rem; }

    /* Boutons statuts */
    .tim-status-btns {
      display: flex;
      gap: 3px;
      flex-wrap: wrap;
    }
    .tim-dnf-group {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .tim-dnf-pos {
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      color: var(--clr-text-2);
      font-family: var(--font-body);
      font-size: 0.72rem;
      padding: 3px 5px;
      outline: none;
      cursor: pointer;
      width: 78px;
    }
    .tim-dnf-pos:focus { border-color: var(--clr-warning); }
    .tim-status-btn {
      font-size: 0.68rem !important;
      padding: 3px 6px !important;
      border-color: var(--clr-border-2) !important;
      color: var(--clr-text-3) !important;
    }
    .tim-status-btn:hover { border-color: var(--clr-danger) !important; color: var(--clr-danger) !important; }

    /* Résultat dans colonne droite */
    .tim-result { flex: 1; text-align: right; }
    .tim-time {
      font-family: var(--font-display);
      font-size: 0.92rem;
      font-weight: 700;
      color: var(--clr-success);
    }

    /* Vide / placeholder */
    .tim-empty {
      padding: var(--sp-lg);
      text-align: center;
      color: var(--clr-text-3);
      font-size: 0.85rem;
    }
    .tim-placeholder {
      text-align: center;
      padding: var(--sp-2xl) var(--sp-md);
      color: var(--clr-text-3);
    }

    /* Reconnaissance photo */
    .photo-confidence {
      padding: var(--sp-sm) var(--sp-md);
      background: var(--clr-surface);
      border-radius: var(--r-md);
      font-size: 0.88rem;
      font-weight: 500;
    }
    .photo-row-notfound td { opacity: 0.4; }

    /* Toggle mobile */
    .tim-mobile-toggle {
      display: none;
      gap: var(--sp-xs);
      margin-bottom: var(--sp-sm);
    }
    .tim-toggle-btn {
      flex: 1;
      padding: 10px var(--sp-sm);
      background: var(--clr-surface);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md);
      color: var(--clr-text-2);
      font-family: var(--font-condensed);
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--tr-fast);
      text-align: center;
    }
    .tim-toggle-btn.is-active {
      background: var(--clr-accent-dim);
      border-color: var(--clr-accent);
      color: var(--clr-accent-2);
    }
    .tim-toggle-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--clr-bg-3);
      border-radius: 10px;
      padding: 0 6px;
      font-size: 0.75rem;
      min-width: 20px;
      margin-left: 4px;
    }
    @media (max-width: 800px) {
      .tim-mobile-toggle { display: flex; }
    }

    /* Grille de départ */
    .grid-serie {
      margin-bottom: var(--sp-lg);
    }
    .grid-serie-title {
      font-family: var(--font-condensed);
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
      padding-bottom: var(--sp-xs);
      border-bottom: 1px solid var(--clr-border);
    }
    .grid-row {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: 8px var(--sp-sm);
      border-radius: var(--r-sm);
      transition: background var(--tr-fast);
    }
    .grid-row:hover { background: var(--clr-surface); }
    .grid-pos {
      min-width: 24px;
      font-family: var(--font-display);
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--clr-text-3);
      text-align: center;
    }
    .grid-num {
      min-width: 42px;
      text-align: center;
      font-family: var(--font-display);
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--clr-accent-2);
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      padding: 3px 6px;
    }
    .grid-name { flex: 1; font-size: 0.92rem; }
    .grid-name strong { font-weight: 600; }
    .grid-name-sm { font-size: 0.78rem; color: var(--clr-text-2); font-weight: 600; margin-top: 2px; }
    .grid-pole {
      background: var(--clr-accent-dim);
      border: 1px solid var(--clr-accent);
      color: var(--clr-accent);
      font-family: var(--font-condensed);
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 2px 6px;
      border-radius: 20px;
    }

    /* Grille DF/Finale : layout visuel */
    .grid-line-row {
      display: flex;
      justify-content: center;
      gap: var(--sp-md);
      padding: var(--sp-sm) 0;
    }
    .grid-line-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: var(--sp-sm);
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-md);
      min-width: 80px;
      text-align: center;
    }
    .grid-line-slot--pole {
      border-color: var(--clr-accent);
      background: var(--clr-accent-dim);
    }
    .grid-line-slot .grid-num {
      font-size: 1rem;
      min-width: unset;
      width: 44px;
    }
    .grid-note {
      font-size: 0.82rem;
      color: var(--clr-warning);
      background: var(--clr-warning-dim);
      border: 1px solid var(--clr-warning);
      border-radius: var(--r-md);
      padding: var(--sp-sm) var(--sp-md);
      margin-bottom: var(--sp-md);
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

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
        const { msToDisplay: _, inputToMs, parseTimeString } = await import('./utils.js');
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
    // Récupérer l'ordre depuis le classement intermédiaire (DF) ou résultats DF (Finale)
    let orderedPilots = [...participants];

    if (session.type === 'DF') {
      // Trier par classement intermédiaire
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
      // Trier par résultats DF (points décroissants)
      const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
      const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
      const dfPtsMap = {};
      for (const df of [df1, df2].filter(Boolean)) {
        const snap = await getDocs(query(collection(db,'results'), where('sessionId','==',df.id)));
        snap.docs.forEach(d => {
          const r = d.data();
          dfPtsMap[r.driverId] = (dfPtsMap[r.driverId] ?? 0) + (r.points ?? 0);
        });
      }
      orderedPilots.sort((a, b) => (dfPtsMap[b.driverId] ?? 0) - (dfPtsMap[a.driverId] ?? 0));
    }

    // Grille 3 lignes : 3-2-3 (8 pilotes max)
    // Ligne 1 : pos 1, 2, 3 → places 1, 3, 5
    // Ligne 2 : pos 4, 5   → places 2, 4
    // Ligne 3 : pos 6, 7, 8 → places 6, 7, 8
    const lines = [
      { label: '1ère ligne', pilots: [orderedPilots[0], orderedPilots[2], orderedPilots[4]].filter(Boolean) },
      { label: '2ème ligne', pilots: [orderedPilots[1], orderedPilots[3]].filter(Boolean) },
      { label: '3ème ligne', pilots: [orderedPilots[5], orderedPilots[6], orderedPilots[7]].filter(Boolean) },
    ];

    gridHtml = `
      <div class="grid-note">
        ⭐ Le pilote en pole position choisit librement sa place sur la 1ère ligne
      </div>
      ${lines.map(line => `
        <div class="grid-serie">
          <div class="grid-serie-title">${line.label}</div>
          <div class="grid-line-row">
            ${line.pilots.map((p, pi) => `
              <div class="grid-line-slot ${pi === 0 && line.label === '1ère ligne' ? 'grid-line-slot--pole' : ''}">
                <div class="grid-num">${escHtml(p.carNumber)}</div>
                <div class="grid-name-sm">${escHtml(p.lastName)}</div>
                ${pi === 0 && line.label === '1ère ligne' ? '<div class="grid-pole">POLE</div>' : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
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

export function initTiming() {
  injectStyles();
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
