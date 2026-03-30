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
    <div class="tim-layout">

      <!-- Colonne gauche : non chronométrés -->
      <div class="tim-panel tim-panel--untimed">
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
      <div class="tim-panel tim-panel--timed">
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
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

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