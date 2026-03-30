/* ═══════════════════════════════════════════════
   SESSIONS.JS — Assignation des pilotes aux sessions
   EC/MQ : auto + retrait manuel
   DF1/DF2 : répartition alternée depuis classement intermédiaire
   Finale : top 4 de chaque DF + remplaçant si forfait
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings       = [];
let allSessions       = [];   // sessions du meeting+catégorie sélectionnés
let engagedDrivers    = [];   // pilotes engagés au meeting+catégorie
let sessionParticipants = {}; // { sessionId: Set(driverId) }
let unsubMeetings     = null;
let unsubSessions     = null;
let unsubEngaged      = null;
let unsubParticipants = {};

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let selectedSessionId = '';   // session en cours d'affichage détaillé

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

const SESSION_ORDER = { EC: 0, MQ: 1, DF: 2, FIN: 3 };
const SESSION_LABELS = { EC: 'Essais', MQ: 'Qualif.', DF: '½ Finale', FIN: 'Finale' };

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
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; renderSessionList(); return; }
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubSessions) unsubSessions();
  const q = query(
    collection(db, 'sessions'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory),
    orderBy('order',   'asc')
  );
  unsubSessions = onSnapshot(q, snap => {
    allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSessionList();
    loadAllParticipants();
  });
}

async function loadEngaged() {
  if (!db || !selectedMeetingId || !selectedCategory) { engagedDrivers = []; return; }
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'engagements'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  );
  const snap = await getDocs(q);
  engagedDrivers = snap.docs
    .map(d => ({ id: d.data().driverId, ...d.data() }))
    .sort((a, b) => a.carNumber - b.carNumber);
}

async function loadAllParticipants() {
  if (!db) return;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Arrêter les anciens listeners
  Object.values(unsubParticipants).forEach(u => u && u());
  unsubParticipants = {};
  sessionParticipants = {};

  for (const session of allSessions) {
    const q = query(
      collection(db, 'sessionParticipants'),
      where('sessionId', '==', session.id)
    );
    unsubParticipants[session.id] = onSnapshot(q, snap => {
      sessionParticipants[session.id] = new Set(snap.docs.map(d => d.data().driverId));
      renderSessionList();
      if (selectedSessionId === session.id) renderSessionDetail();
    });
  }
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — PARTICIPANTS
// ─────────────────────────────────────────────────────────

async function addParticipant(sessionId, driver) {
  if (!db) return;
  const { collection, addDoc, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Vérifier doublon dans cette session
  const driverId = driver.id || driver.driverId;
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  );
  const snap = await getDocs(q);
  if (!snap.empty) return;

  // Vérification DF : un pilote ne peut pas être dans DF1 ET DF2
  const targetSession = allSessions.find(s => s.id === sessionId);
  if (targetSession?.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== sessionId);
    if (otherDf && sessionParticipants[otherDf.id]?.has(driverId)) {
      return; // Silencieux — le pilote n'apparaît pas dans la liste, pas besoin d'erreur
    }
  }

  await addDoc(collection(db, 'sessionParticipants'), {
    sessionId,
    meetingId:  selectedMeetingId,
    category:   selectedCategory,
    year:       selectedYear,
    driverId,
    carNumber:  driver.carNumber,
    firstName:  driver.firstName,
    lastName:   driver.lastName,
    createdAt:  new Date(),
  });
}

async function removeParticipant(sessionId, driverId) {
  if (!db) return;
  const { collection, query, where, getDocs, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  );
  const snap = await getDocs(q);
  snap.docs.forEach(d => deleteDoc(d.ref));
}

async function getParticipantsData(sessionId) {
  if (!db) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.carNumber - b.carNumber);
}

// ─────────────────────────────────────────────────────────
// LOGIQUE AUTOMATIQUE
// ─────────────────────────────────────────────────────────

/** EC + MQ : assigner tous les engagés */
async function autoAssignAll(sessionId) {
  await loadEngaged();
  let count = 0;
  for (const d of engagedDrivers) {
    const already = sessionParticipants[sessionId]?.has(d.id || d.driverId);
    if (!already) {
      await addParticipant(sessionId, d);
      count++;
    }
  }
  toast(count > 0 ? `${count} pilote(s) assigné(s) ✓` : 'Tous déjà assignés', count > 0 ? 'success' : 'info');
}

/** DF1/DF2 : répartition alternée depuis classement intermédiaire */
async function autoAssignDemis() {
  await loadEngaged();

  // Récupérer le classement intermédiaire final (points MQ + EC)
  // On utilise l'ordre du classement stocké dans Firestore (interimStandings)
  // Pour l'instant : on prend les engagés triés par leur position dans le classement
  // En attendant le module standings, on trie par carNumber comme fallback
  const { collection, query, where, getDocs, orderBy } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Essayer de récupérer le classement intermédiaire depuis Firestore
  let ranked = [];
  try {
    const q = query(
      collection(db, 'interimStandings'),
      where('meetingId', '==', selectedMeetingId),
      where('category',  '==', selectedCategory),
      orderBy('position', 'asc')
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      ranked = snap.docs.map(d => d.data());
    }
  } catch {}

  // Fallback : utiliser les engagés dans l'ordre
  if (ranked.length === 0) {
    ranked = engagedDrivers.map((d, i) => ({
      driverId:  d.id || d.driverId,
      carNumber: d.carNumber,
      firstName: d.firstName,
      lastName:  d.lastName,
      position:  i + 1,
    }));
  }

  // Prendre les 16 premiers
  const top16 = ranked.slice(0, 16);

  // Sessions DF1 et DF2
  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  if (!df1 || !df2) { toast('Sessions DF1 et DF2 introuvables', 'error'); return; }

  // Vider les DF existantes
  for (const id of [...(sessionParticipants[df1.id] || []), ...(sessionParticipants[df2.id] || [])]) {
    await removeParticipant(df1.id, id);
    await removeParticipant(df2.id, id);
  }

  // Répartition alternée : 1→DF1, 2→DF2, 3→DF1, 4→DF2...
  for (let i = 0; i < top16.length; i++) {
    const driver = top16[i];
    const targetSession = i % 2 === 0 ? df1 : df2;
    await addParticipant(targetSession.id, driver);
  }

  toast(`${top16.length} pilotes répartis en DF1/DF2 ✓`, 'success');
  renderSessionList();
}

/** Finale : top 4 de DF1 + top 4 de DF2 */
async function autoAssignFinale() {
  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const fin = allSessions.find(s => s.type === 'FIN');
  if (!df1 || !df2 || !fin) { toast('Sessions introuvables', 'error'); return; }

  // Récupérer les résultats des DF (triés par position)
  const { collection, query, where, getDocs, orderBy } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const getTop4 = async (sessionId) => {
    try {
      const q = query(
        collection(db, 'results'),
        where('sessionId', '==', sessionId),
        orderBy('position', 'asc')
      );
      const snap = await getDocs(q);
      return snap.docs.map(d => d.data()).filter(d => d.position <= 4);
    } catch { return []; }
  };

  const top4df1 = await getTop4(df1.id);
  const top4df2 = await getTop4(df2.id);

  if (top4df1.length === 0 && top4df2.length === 0) {
    toast('Aucun résultat de DF disponible. Saisissez d\'abord les temps des DF.', 'warning');
    return;
  }

  const finalistes = [...top4df1, ...top4df2];

  // Vider la finale existante
  for (const id of (sessionParticipants[fin.id] || [])) {
    await removeParticipant(fin.id, id);
  }

  // Ajouter les finalistes
  for (const d of finalistes) {
    await addParticipant(fin.id, d);
  }

  toast(`${finalistes.length} finalistes assignés ✓`, 'success');
}

// ─────────────────────────────────────────────────────────
// RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-sessions').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🏁 <span>Sessions</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap">
      <select class="toolbar-select" id="ses-year">
        ${years.map(y => `<option value="${y}" ${y === selectedYear ? 'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="ses-meeting" style="flex:1;min-width:200px">
        <option value="">— Sélectionner un meeting —</option>
      </select>
      <select class="toolbar-select" id="ses-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <!-- Layout 2 colonnes : liste sessions | détail session -->
    <div class="ses-layout" id="ses-layout">
      <div class="ses-list-panel" id="ses-list-panel">
        <div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">
          Sélectionnez un meeting et une catégorie
        </div>
      </div>
      <div class="ses-detail-panel" id="ses-detail-panel">
        <div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">
          Sélectionnez une session
        </div>
      </div>
    </div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('ses-meeting');
  if (!sel) return;
  const prev = selectedMeetingId;
  sel.innerHTML = `<option value="">— Sélectionner un meeting —</option>`;
  allMeetings.forEach(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '?';
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${d} — ${m.location || '?'}`;
    if (m.id === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderSessionList() {
  const panel = document.getElementById('ses-list-panel');
  if (!panel) return;

  if (!selectedMeetingId || !selectedCategory) {
    panel.innerHTML = `<div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Sélectionnez un meeting et une catégorie</div>`;
    return;
  }

  if (allSessions.length === 0) {
    panel.innerHTML = `<div class="ses-placeholder text-muted" style="padding:var(--sp-xl);text-align:center">Aucune session trouvée pour cette sélection.</div>`;
    return;
  }

  // Bouton assignation globale DF
  const hasDf = allSessions.some(s => s.type === 'DF');
  const hasFin = allSessions.some(s => s.type === 'FIN');

  panel.innerHTML = `
    <div class="ses-list-header">
      <span class="ses-list-title">Sessions</span>
      <div class="ses-list-actions">
        ${hasDf ? `<button class="btn btn-secondary btn-sm" id="ses-auto-df-btn">⚡ Auto DF</button>` : ''}
        ${hasFin ? `<button class="btn btn-secondary btn-sm" id="ses-auto-fin-btn">⚡ Auto Finale</button>` : ''}
      </div>
    </div>
    <div class="ses-cards">
      ${allSessions.map(s => sessionCard(s)).join('')}
    </div>
  `;

  // Binder cartes
  panel.querySelectorAll('.ses-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedSessionId = card.dataset.id;
      panel.querySelectorAll('.ses-card').forEach(c => c.classList.remove('is-active'));
      card.classList.add('is-active');
      renderSessionDetail();
    });
  });

  document.getElementById('ses-auto-df-btn')
    ?.addEventListener('click', e => { e.stopPropagation(); autoAssignDemis(); });
  document.getElementById('ses-auto-fin-btn')
    ?.addEventListener('click', e => { e.stopPropagation(); autoAssignFinale(); });

  // Restaurer la sélection active
  if (selectedSessionId) {
    panel.querySelector(`[data-id="${selectedSessionId}"]`)?.classList.add('is-active');
  }
}

function sessionCard(session) {
  const count = sessionParticipants[session.id]?.size || 0;
  const typeCls = session.type.toLowerCase();
  const label = session.type === 'MQ' ? `MQ${session.num}`
    : session.type === 'DF' ? `DF${session.num}`
    : SESSION_LABELS[session.type] || session.type;

  return `
    <div class="ses-card ses-card--${typeCls} ${selectedSessionId === session.id ? 'is-active' : ''}"
      data-id="${session.id}">
      <div class="ses-card-badge">${label}</div>
      <div class="ses-card-info">
        <div class="ses-card-label">${escHtml(session.label)}</div>
        <div class="ses-card-tours">${session.tours} tour${session.tours > 1 ? 's' : ''}</div>
      </div>
      <div class="ses-card-count">${count}<span>pilotes</span></div>
    </div>
  `;
}

async function renderSessionDetail() {
  const panel = document.getElementById('ses-detail-panel');
  if (!panel || !selectedSessionId) return;

  const session = allSessions.find(s => s.id === selectedSessionId);
  if (!session) return;

  const participants = await getParticipantsData(selectedSessionId);
  const participantIds = new Set(participants.map(p => p.driverId));

  await loadEngaged();
  // Pour une DF : exclure aussi les pilotes déjà dans l'autre DF
  let otherDfIds = new Set();
  if (session.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== selectedSessionId);
    if (otherDf) otherDfIds = sessionParticipants[otherDf.id] || new Set();
  }
  const notAssigned = engagedDrivers.filter(d => {
    const id = d.id || d.driverId;
    return !participantIds.has(id) && !otherDfIds.has(id);
  });

  const isEcOrMq = session.type === 'EC' || session.type === 'MQ';
  const isDf     = session.type === 'DF';
  const isFin    = session.type === 'FIN';

  const label = session.type === 'MQ' ? `MQ${session.num}`
    : session.type === 'DF' ? `DF${session.num}`
    : SESSION_LABELS[session.type] || session.type;

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">${escHtml(session.label)}</div>
        <div class="ses-detail-meta">${session.tours} tour${session.tours > 1?'s':''} · ${participants.length} pilote${participants.length>1?'s':''}</div>
      </div>
      <div style="display:flex;gap:var(--sp-sm);flex-wrap:wrap">
        ${isEcOrMq ? `<button class="btn btn-primary btn-sm" id="ses-auto-all-btn">✅ Assigner tous les engagés</button>` : ''}
      </div>
    </div>

    <!-- Pilotes assignés -->
    <div class="ses-detail-section">
      <div class="ses-section-title">
        <span class="eng-group-dot eng-group-dot--on"></span>
        Assignés (${participants.length})
      </div>
      <div id="ses-assigned-list">
        ${participants.length === 0
          ? `<div class="ses-empty">Aucun pilote assigné</div>`
          : participants.map(p => `
            <div class="ses-pilot-row">
              <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
              <span class="ses-pilot-name">${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></span>
              <button class="btn btn-danger btn-sm ses-remove-btn" data-driver-id="${p.driverId}">✕</button>
            </div>
          `).join('')
        }
      </div>
    </div>

    <!-- Pilotes non assignés (engagés mais pas dans cette session) -->
    ${notAssigned.length > 0 ? `
      <div class="ses-detail-section">
        <div class="ses-section-title">
          <span class="eng-group-dot eng-group-dot--off"></span>
          Non assignés (${notAssigned.length})
        </div>
        <div id="ses-unassigned-list">
          ${notAssigned.map(d => `
            <div class="ses-pilot-row ses-pilot-row--dim">
              <span class="ses-pilot-num">${escHtml(d.carNumber)}</span>
              <span class="ses-pilot-name">${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></span>
              <button class="btn btn-secondary btn-sm ses-add-btn" data-driver-id="${d.id || d.driverId}">＋</button>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
  `;

  // Events
  document.getElementById('ses-auto-all-btn')
    ?.addEventListener('click', () => autoAssignAll(selectedSessionId));

  panel.querySelectorAll('.ses-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeParticipant(selectedSessionId, btn.dataset.driverId);
      renderSessionDetail();
    });
  });

  panel.querySelectorAll('.ses-add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driver = engagedDrivers.find(d => (d.id || d.driverId) === btn.dataset.driverId);
      if (driver) {
        await addParticipant(selectedSessionId, driver);
        renderSessionDetail();
      }
    });
  });
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('ses-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    selectedSessionId = '';
    loadMeetings();
  });

  document.getElementById('ses-meeting')?.addEventListener('change', e => {
    selectedMeetingId = e.target.value;
    selectedSessionId = '';
    loadSessions();
    loadEngaged();
  });

  document.getElementById('ses-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value;
    selectedSessionId = '';
    loadSessions();
    loadEngaged();
  });
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('sessions-styles')) return;
  const style = document.createElement('style');
  style.id = 'sessions-styles';
  style.textContent = `
    /* Layout 2 colonnes */
    .ses-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: var(--sp-md);
      align-items: start;
    }
    @media (max-width: 680px) {
      .ses-layout { grid-template-columns: 1fr; }
    }

    /* Liste sessions (colonne gauche) */
    .ses-list-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: var(--sp-sm);
      gap: var(--sp-sm);
      flex-wrap: wrap;
    }
    .ses-list-title {
      font-family: var(--font-condensed);
      font-size: 0.75rem; font-weight: 700;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--clr-text-3);
    }
    .ses-list-actions { display: flex; gap: 4px; }
    .ses-cards { display: flex; flex-direction: column; gap: var(--sp-xs); }

    .ses-card {
      display: flex; align-items: center; gap: var(--sp-sm);
      padding: 10px var(--sp-md);
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-left: 3px solid transparent;
      border-radius: var(--r-md);
      cursor: pointer;
      transition: all var(--tr-fast);
    }
    .ses-card:hover { background: var(--clr-surface-2); border-color: var(--clr-border-2); }
    .ses-card.is-active { background: var(--clr-surface-2); }

    .ses-card--ec.is-active  { border-left-color: var(--clr-info); }
    .ses-card--mq.is-active  { border-left-color: var(--clr-warning); }
    .ses-card--df.is-active  { border-left-color: #ff7730; }
    .ses-card--fin.is-active { border-left-color: var(--clr-accent); }

    .ses-card-badge {
      min-width: 38px; text-align: center;
      font-family: var(--font-display); font-size: 0.72rem; font-weight: 700;
      padding: 2px 6px; border-radius: var(--r-sm);
    }
    .ses-card--ec  .ses-card-badge { background: var(--clr-info-dim);    color: var(--clr-info); }
    .ses-card--mq  .ses-card-badge { background: var(--clr-warning-dim); color: var(--clr-warning); }
    .ses-card--df  .ses-card-badge { background: rgba(255,119,48,0.18);  color: #ff7730; }
    .ses-card--fin .ses-card-badge { background: var(--clr-accent-dim);  color: var(--clr-accent); }

    .ses-card-info { flex: 1; min-width: 0; }
    .ses-card-label { font-size: 0.82rem; font-weight: 500; color: var(--clr-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ses-card-tours { font-size: 0.72rem; color: var(--clr-text-3); }
    .ses-card-count { text-align: right; font-family: var(--font-display); font-size: 1rem; font-weight: 700; color: var(--clr-accent-2); line-height: 1; }
    .ses-card-count span { display: block; font-family: var(--font-body); font-size: 0.65rem; color: var(--clr-text-3); font-weight: 400; }

    /* Détail session (colonne droite) */
    .ses-detail-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: var(--sp-md); margin-bottom: var(--sp-md); flex-wrap: wrap;
      padding-bottom: var(--sp-md);
      border-bottom: 1px solid var(--clr-border);
    }
    .ses-detail-label { font-family: var(--font-display); font-size: 1rem; font-weight: 700; color: var(--clr-text); }
    .ses-detail-meta { font-size: 0.82rem; color: var(--clr-text-3); margin-top: 2px; }

    .ses-detail-section { margin-bottom: var(--sp-lg); }
    .ses-section-title {
      display: flex; align-items: center; gap: var(--sp-sm);
      font-family: var(--font-condensed); font-size: 0.75rem; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase; color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
    }

    .ses-pilot-row {
      display: flex; align-items: center; gap: var(--sp-sm);
      padding: 8px var(--sp-sm);
      border-radius: var(--r-sm);
      transition: background var(--tr-fast);
    }
    .ses-pilot-row:hover { background: var(--clr-surface); }
    .ses-pilot-row--dim { opacity: 0.6; }
    .ses-pilot-row--dim:hover { opacity: 1; }

    .ses-pilot-num {
      min-width: 40px; text-align: center;
      font-family: var(--font-display); font-size: 0.78rem; font-weight: 700;
      color: var(--clr-accent-2);
      background: var(--clr-bg-3); border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm); padding: 2px 5px;
    }
    .ses-pilot-name { flex: 1; font-size: 0.9rem; }
    .ses-pilot-name strong { font-weight: 600; }

    .ses-empty {
      padding: var(--sp-md); text-align: center;
      color: var(--clr-text-3); font-size: 0.85rem;
    }
    .ses-placeholder { color: var(--clr-text-3); font-size: 0.9rem; }

    /* Dot statut */
    .eng-group-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
    .eng-group-dot--on  { background: var(--clr-success); box-shadow: 0 0 6px var(--clr-success); }
    .eng-group-dot--off { background: var(--clr-text-3); }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initSessions() {
  injectStyles();
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'sessions') {
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) {
        await loadEngaged();
        await loadSessions();
      }
    }
  });
}