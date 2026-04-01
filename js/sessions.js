/* ═══════════════════════════════════════════════
   SESSIONS.JS — Assignation des pilotes aux sessions
   EC/MQ : auto + retrait manuel
   DF1/DF2 : répartition alternée depuis classement intermédiaire
   Finale : top 4 de chaque DF + remplaçant si forfait
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';
// ← MODIFIÉ : import du calcul intermédiaire partagé depuis calc.js
//   Plus de lecture Firestore interimStandings dans ce fichier
import { calcInterimStandings } from './calc.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings         = [];
let allSessions         = [];
let engagedDrivers      = [];
let sessionParticipants = {};
let unsubMeetings       = null;
let unsubSessions       = null;
let unsubEngaged        = null;
let unsubParticipants   = {};

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let selectedSessionId = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

const SESSION_ORDER  = { EC: 0, MQ: 1, DF: 2, FIN: 3 };
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

  const driverId = driver.id || driver.driverId;
  const q = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  );
  const snap = await getDocs(q);
  if (!snap.empty) return;

  const targetSession = allSessions.find(s => s.id === sessionId);
  if (targetSession?.type === 'DF') {
    const otherDf = allSessions.find(s => s.type === 'DF' && s.id !== sessionId);
    if (otherDf && sessionParticipants[otherDf.id]?.has(driverId)) return;
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

  const qPart = query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  );
  const snapPart = await getDocs(qPart);
  for (const d of snapPart.docs) await deleteDoc(d.ref);

  const qRes = query(
    collection(db, 'results'),
    where('sessionId', '==', sessionId),
    where('driverId',  '==', driverId)
  );
  const snapRes = await getDocs(qRes);
  if (!snapRes.empty) {
    for (const d of snapRes.docs) await deleteDoc(d.ref);
    const session = allSessions.find(s => s.id === sessionId);
    if (session?.type === 'DF' || session?.type === 'FIN') {
      toast('Pilote retiré — son temps a aussi été supprimé', 'warning', 4000);
    }
  }
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

// ← MODIFIÉ : calcul direct depuis les résultats bruts via calc.js
//   Plus de lecture Firestore interimStandings
async function autoAssignDemis() {
  await loadEngaged();

  let ranked = [];
  try {
    ranked = await calcInterimStandings(db, allSessions);
  } catch (e) {
    console.error('Erreur calcul classement intermédiaire:', e);
  }

  if (ranked.length === 0) {
    toast('⚠️ Pas encore assez de résultats MQ — assignation par numéro de voiture.', 'warning', 4000);
    ranked = engagedDrivers.map((d, i) => ({
      driverId:  d.id || d.driverId,
      carNumber: d.carNumber,
      firstName: d.firstName,
      lastName:  d.lastName,
      position:  i + 1,
    }));
  }

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  if (!df1 || !df2) { toast('Sessions DF1 et DF2 introuvables', 'error'); return; }

  const { collection: c0, query: q0, where: w0, getDocs: gd0 } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const df1ResultsSnap = await gd0(q0(c0(db, 'results'), w0('sessionId', '==', df1.id)));
  const df2ResultsSnap = await gd0(q0(c0(db, 'results'), w0('sessionId', '==', df2.id)));
  const hasTimedResults = !df1ResultsSnap.empty || !df2ResultsSnap.empty;
  const df1Count = sessionParticipants[df1.id]?.size || 0;
  const df2Count = sessionParticipants[df2.id]?.size || 0;
  const hasExisting = df1Count > 0 || df2Count > 0;

  const fin = allSessions.find(s => s.type === 'FIN');
  const finPartSnap = fin ? await gd0(q0(c0(db, 'sessionParticipants'), w0('sessionId', '==', fin.id))) : null;
  const finResSnap  = fin ? await gd0(q0(c0(db, 'results'),             w0('sessionId', '==', fin.id))) : null;
  const finHasData  = !finPartSnap?.empty || !finResSnap?.empty;

  if (hasTimedResults) {
    const finaleMsg = finHasData ? `\n\n⚠️ La Finale sera aussi vidée car les qualifiés peuvent changer.` : '';
    const msg = `⚠️ ATTENTION — Des temps ont déjà été saisis en demi-finale !\n\n• DF1 : ${df1ResultsSnap.size} temps saisi(s)\n• DF2 : ${df2ResultsSnap.size} temps saisi(s)\n\nAuto DF va supprimer TOUS ces temps et réassigner les pilotes.${finaleMsg}\n\nCette action est irréversible. Continuer quand même ?`;
    if (!window.confirm(msg)) return;
  } else if (hasExisting) {
    const finaleMsg = finHasData ? `\n\n⚠️ La Finale sera aussi vidée.` : '';
    const msg = `⚡ Auto DF va réassigner toutes les demi-finales.\n\nActuellement :\n• DF1 : ${df1Count} pilote(s)\n• DF2 : ${df2Count} pilote(s)${finaleMsg}\n\nContinuer ?`;
    if (!window.confirm(msg)) return;
  }

  const { collection: fc, query: fq, where: fw, getDocs: fgd, writeBatch: fwb } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const clearDf = async (sessionId) => {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await fgd(fq(fc(db, col), fw('sessionId', '==', sessionId)));
      if (!snap.empty) {
        const batch = fwb(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  };
  await clearDf(df1.id);
  await clearDf(df2.id);

  // Répartition alternée : position impaire → DF1, paire → DF2
  const top16 = ranked.slice(0, 16);
  for (let i = 0; i < top16.length; i++) {
    const driver = top16[i];
    const targetSession = i % 2 === 0 ? df1 : df2;
    await addParticipant(targetSession.id, driver);
  }

  if (fin && finHasData) {
    const { collection: fc2, query: fq2, where: fw2, getDocs: fgd2, writeBatch: fwb2 } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await fgd2(fq2(fc2(db, col), fw2('sessionId', '==', fin.id)));
      if (!snap.empty) {
        const batch = fwb2(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
    toast(`${top16.length} pilotes répartis en DF1/DF2 ✓ — Finale vidée, relancez Auto Finale`, 'success', 5000);
  } else {
    toast(`${top16.length} pilotes répartis en DF1/DF2 ✓`, 'success');
  }

  renderSessionList();
  if (selectedSessionId) {
    const panel = document.getElementById('ses-detail-panel');
    const session = allSessions.find(s => s.id === selectedSessionId);
    if (panel && session?.type === 'DF') {
      await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
    }
  }
}

async function autoAssignFinale() {
  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const fin = allSessions.find(s => s.type === 'FIN');
  if (!df1 || !df2 || !fin) { toast('Sessions introuvables', 'error'); return; }

  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const getTop4 = async (dfSession) => {
    const partSnap = await getDocs(query(
      collection(db, 'sessionParticipants'),
      where('sessionId', '==', dfSession.id)
    ));
    const participants = partSnap.docs.map(d => d.data());
    if (participants.length === 0) return [];

    const resSnap = await getDocs(query(
      collection(db, 'results'),
      where('sessionId', '==', dfSession.id)
    ));
    const resultMap = {};
    resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });

    const rows = participants.map(p => ({
      driverId:  p.driverId,
      carNumber: p.carNumber,
      firstName: p.firstName,
      lastName:  p.lastName,
      ms:        resultMap[p.driverId]?.ms     ?? null,
      status:    resultMap[p.driverId]?.status ?? null,
    }));

    if (rows.every(r => !r.ms && !r.status)) return [];

    const order = r => {
      if (r.ms) return r.ms;
      if (r.status === 'DNF')      return 9000000;
      if (r.status === 'DSQ_RACE') return 9100000;
      return 9999999;
    };
    rows.sort((a, b) => order(a) - order(b));
    return rows.filter(r => r.ms || r.status === 'DNF').slice(0, 4);
  };

  const top4df1 = await getTop4(df1);
  const top4df2 = await getTop4(df2);

  if (top4df1.length === 0 && top4df2.length === 0) {
    toast('Aucun résultat de DF disponible. Saisissez dabord les temps des DF.', 'warning');
    return;
  }

  const finalistes = [...top4df1, ...top4df2];

  const finResultsSnap = await getDocs(query(
    collection(db, 'results'),
    where('sessionId', '==', fin.id)
  ));
  const finPartSnap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', fin.id)
  ));
  const names = finalistes.map(d => `#${d.carNumber} ${d.lastName}`).join(', ');

  if (!finResultsSnap.empty) {
    const msg = `⚠️ ATTENTION — Des temps ont déjà été saisis en Finale !\n\n${finResultsSnap.size} résultat(s) seront supprimés.\n\nAuto Finale va remplacer par :\n${names}\n\nCette action est irréversible. Continuer quand même ?`;
    if (!window.confirm(msg)) return;
  } else if (!finPartSnap.empty) {
    const msg = `⚡ Auto Finale va assigner ${finalistes.length} pilote(s) :\n${names}\n\nLa finale actuelle (${finPartSnap.size} pilote(s)) sera remplacée.\n\nContinuer ?`;
    if (!window.confirm(msg)) return;
  }

  const clearSession = async (sessionId) => {
    for (const col of ['sessionParticipants', 'results']) {
      const snap = await getDocs(query(
        collection(db, col),
        where('sessionId', '==', sessionId)
      ));
      if (!snap.empty) {
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  };
  await clearSession(fin.id);

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

  const hasDf  = allSessions.some(s => s.type === 'DF');
  const hasFin = allSessions.some(s => s.type === 'FIN');

  panel.innerHTML = `
    <div class="ses-list-header">
      <span class="ses-list-title">Sessions</span>
      <div class="ses-list-actions">
        ${hasDf  ? `<button class="btn btn-secondary btn-sm" id="ses-auto-df-btn">⚡ Auto DF</button>` : ''}
        ${hasFin ? `<button class="btn btn-secondary btn-sm" id="ses-auto-fin-btn">⚡ Auto Finale</button>` : ''}
      </div>
    </div>
    <div class="ses-cards">
      ${allSessions.map(s => sessionCard(s)).join('')}
    </div>
  `;

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

  const participants  = await getParticipantsData(selectedSessionId);
  const participantIds = new Set(participants.map(p => p.driverId));

  await loadEngaged();
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

  if (isDf) {
    await renderDfStandings(panel, session, participants);
    return;
  }

  if (session.type === 'FIN') {
    await renderFinaleStandings(panel, session, participants);
    return;
  }

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
// VUE DF — CLASSEMENT INTERMÉDIAIRE AVEC RÉPARTITION
// ─────────────────────────────────────────────────────────

// ← MODIFIÉ : utilise calcInterimStandings(db, allSessions) depuis calc.js
//   Plus de lecture/écriture Firestore interimStandings
async function renderDfStandings(panel, session, assignedParticipants) {
  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);

  // Fetch frais des participants DF depuis Firestore
  const freshFetch = async (sessionId) => {
    if (!sessionId) return new Set();
    const { collection: c2, query: q2, where: w2, getDocs: gd2 } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await gd2(q2(c2(db, 'sessionParticipants'), w2('sessionId', '==', sessionId)));
    return new Set(snap.docs.map(d => d.data().driverId));
  };

  const df1Ids = await freshFetch(df1?.id);
  const df2Ids = await freshFetch(df2?.id);

  // ← MODIFIÉ : calcul direct, plus de try/catch interimStandings Firestore
  let standings = await calcInterimStandings(db, allSessions);
  if (standings.length === 0) {
    standings = engagedDrivers.map((d, i) => ({
      driverId:    d.id || d.driverId,
      carNumber:   d.carNumber,
      firstName:   d.firstName,
      lastName:    d.lastName,
      totalPoints: null,
      position:    i + 1,
    }));
  }
  const hasRealStandings = standings[0]?.totalPoints != null;

  panel._standings = standings;

  const currentDf  = session.num;
  const otherDf    = currentDf === 1 ? 2 : 1;
  const currentIds = currentDf === 1 ? df1Ids : df2Ids;
  const otherIds   = currentDf === 1 ? df2Ids : df1Ids;

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">${escHtml(session.label)}</div>
        <div class="ses-detail-meta">
          ${session.tours} tours ·
          ${currentIds.size} pilote${currentIds.size > 1 ? 's' : ''} assigné${currentIds.size > 1 ? 's' : ''}
        </div>
      </div>
      <div style="display:flex;gap:var(--sp-sm)">
        <button class="btn btn-secondary btn-sm" id="ses-auto-df-inline">⚡ Auto DF</button>
      </div>
    </div>

    ${!hasRealStandings ? `
      <div class="ses-df-notice">
        ⚠️ Pas encore assez de résultats MQ — affichage par numéro de voiture.
      </div>
    ` : ''}

    <div class="ses-df-standings">
      <div class="ses-df-legend">
        <span class="ses-df-pill ses-df-pill--1">DF1</span>
        <span>Places impaires</span>
        <span class="ses-df-pill ses-df-pill--2" style="margin-left:var(--sp-md)">DF2</span>
        <span>Places paires</span>
      </div>

      ${standings.slice(0, 16).map((p, i) => {
        const pos   = i + 1;
        const dfNum = pos % 2 === 1 ? 1 : 2;
        const isInCurrentDf = currentIds.has(p.driverId);
        const isInOtherDf   = otherIds.has(p.driverId);

        let actionBtn = '';
        if (isInCurrentDf) {
          actionBtn = `
            <button class="btn btn-ghost btn-sm ses-df-action"
              data-action="remove" data-driver-id="${p.driverId}"
              data-df="${currentDf}" title="Retirer de DF${currentDf}">✕</button>
            <button class="btn btn-secondary btn-sm ses-df-action"
              data-action="swap" data-driver-id="${p.driverId}"
              data-df="${currentDf}" title="Basculer vers DF${otherDf}">→ DF${otherDf}</button>
          `;
        } else if (isInOtherDf) {
          actionBtn = `
            <button class="btn btn-secondary btn-sm ses-df-action"
              data-action="swap" data-driver-id="${p.driverId}"
              data-df="${otherDf}" title="Basculer vers DF${currentDf}">→ DF${currentDf}</button>
          `;
        } else {
          actionBtn = `
            <button class="btn btn-primary btn-sm ses-df-action"
              data-action="add" data-driver-id="${p.driverId}"
              data-df="${currentDf}" title="Ajouter en DF${currentDf}">＋ DF${currentDf}</button>
          `;
        }

        return `
          <div class="ses-df-row ${isInCurrentDf ? 'ses-df-row--assigned' : ''} ${isInOtherDf ? 'ses-df-row--other' : ''}">
            <span class="ses-df-pos">${pos}</span>
            <span class="ses-df-pill ses-df-pill--${dfNum}">DF${dfNum}</span>
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name">
              ${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong>
            </span>
            <span class="ses-df-pts">
              ${hasRealStandings && p.totalPoints != null
                ? `${p.totalPoints} <span class="ses-df-pts-label">pts</span>`
                : `<span class="ses-df-pts-pos">(${pos}ème)</span>`
              }
            </span>
            <span class="ses-df-actions">${actionBtn}</span>
          </div>
        `;
      }).join('')}

      ${standings.length > 16 ? `
        <div class="ses-df-row ses-df-row--reserve">
          <span style="grid-column:1/-1;color:var(--clr-text-3);font-size:0.8rem;padding:var(--sp-sm) 0">
            Pilotes 17+ : remplaçants potentiels si forfait
          </span>
        </div>
        ${standings.slice(16).map((p, i) => `
          <div class="ses-df-row ses-df-row--reserve">
            <span class="ses-df-pos">${17 + i}</span>
            <span class="ses-df-pill ses-df-pill--reserve">RES</span>
            <span class="ses-pilot-num">${escHtml(p.carNumber)}</span>
            <span class="ses-pilot-name">
              ${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong>
            </span>
            ${hasRealStandings && p.totalPoints != null
              ? `<span class="ses-df-pts">${p.totalPoints} pts</span>`
              : ''}
          </div>
        `).join('')}
      ` : ''}
    </div>
  `;

  document.getElementById('ses-auto-df-inline')
    ?.addEventListener('click', () => autoAssignDemis());

  panel.querySelectorAll('.ses-df-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId  = btn.dataset.driverId;
      const fromDfNum = parseInt(btn.dataset.df);
      const action    = btn.dataset.action;

      const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
      const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
      if (!df1 || !df2) return;

      const fromSession = fromDfNum === 1 ? df1 : df2;
      const toSession   = fromDfNum === 1 ? df2 : df1;
      const driver = (panel._standings || []).find(p => p.driverId === driverId);
      if (!driver) return;

      if (action === 'remove') {
        await removeParticipant(fromSession.id, driverId);
      } else if (action === 'add') {
        await addParticipant(fromSession.id, driver);
      } else if (action === 'swap') {
        await removeParticipant(fromSession.id, driverId);
        await addParticipant(toSession.id, driver);
      }

      await renderDfStandings(panel, session, await getParticipantsData(selectedSessionId));
    });
  });
}

// ─────────────────────────────────────────────────────────
// VUE FINALE
// ─────────────────────────────────────────────────────────

// ← MODIFIÉ : utilise calcInterimStandings(db, allSessions) depuis calc.js
//   Plus de lecture Firestore interimStandings
async function renderFinaleStandings(panel, session, assignedParticipants) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const df1 = allSessions.find(s => s.type === 'DF' && s.num === 1);
  const df2 = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const assignedIds = new Set(assignedParticipants.map(p => p.driverId));

  const getDfResults = async (dfSession) => {
    if (!dfSession) return [];
    const [resSnap, partSnap] = await Promise.all([
      getDocs(query(collection(db, 'results'), where('sessionId', '==', dfSession.id))),
      getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', dfSession.id))),
    ]);
    const resultMap = {};
    resSnap.docs.forEach(d => { resultMap[d.data().driverId] = d.data(); });
    const participants = partSnap.docs.map(d => d.data());

    return participants.map(p => ({
      driverId:  p.driverId,
      carNumber: p.carNumber,
      firstName: p.firstName,
      lastName:  p.lastName,
      ms:        resultMap[p.driverId]?.ms     ?? null,
      status:    resultMap[p.driverId]?.status ?? null,
      points:    resultMap[p.driverId]?.points ?? null,
    })).sort((a, b) => {
      const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9e6 : 9e9;
      return order(a) - order(b);
    });
  };

  // ← MODIFIÉ : calcul direct, plus de lecture Firestore interimStandings
  const interimCalc = await calcInterimStandings(db, allSessions);
  const interimMap  = {};
  interimCalc.forEach(r => { interimMap[r.driverId] = r.position ?? 999; });

  const getInterimPoints = (driverId) => {
    const r = interimCalc.find(d => d.driverId === driverId);
    return r?.interimPoints ?? 0;
  };

  const df1Results = await getDfResults(df1);
  const df2Results = await getDfResults(df2);

  const df1Qualified    = df1Results.filter(r => r.ms || r.status === 'DNF').slice(0, 4);
  const df2Qualified    = df2Results.filter(r => r.ms || r.status === 'DNF').slice(0, 4);
  const df1Replacements = df1Results.filter(r => r.ms || r.status === 'DNF').slice(4);
  const df2Replacements = df2Results.filter(r => r.ms || r.status === 'DNF').slice(4);

  const maxPairs = Math.max(df1Qualified.length, df2Qualified.length);
  const pairs = [];
  for (let i = 0; i < maxPairs; i++) {
    const d1 = df1Qualified[i] || null;
    const d2 = df2Qualified[i] || null;
    let first = d1, second = d2;
    if (d1 && d2) {
      const pos1 = interimMap[d1.driverId] ?? 999;
      const pos2 = interimMap[d2.driverId] ?? 999;
      if (pos2 < pos1) { first = d2; second = d1; }
    }
    pairs.push({ rank: i + 1, first, second });
  }

  const allReplacements = [
    ...df1Replacements.map(r => ({ ...r, dfNum: 1 })),
    ...df2Replacements.map(r => ({ ...r, dfNum: 2 })),
  ].map(r => ({
    ...r,
    totalMeetingPoints: (r.points ?? 0) + getInterimPoints(r.driverId),
  })).sort((a, b) => {
    if (b.totalMeetingPoints !== a.totalMeetingPoints)
      return b.totalMeetingPoints - a.totalMeetingPoints;
    return (interimMap[a.driverId] ?? 999) - (interimMap[b.driverId] ?? 999);
  });

  const hasNoResults = df1Results.length === 0 && df2Results.length === 0;

  const pilotCard = (d, dfNum) => {
    if (!d) return `<div class="ses-fin-empty">—</div>`;
    const isAssigned = assignedIds.has(d.driverId);
    const interimPos = interimMap[d.driverId];
    return `
      <div class="ses-fin-pilot ${isAssigned ? 'ses-fin-pilot--assigned' : ''}">
        <span class="ses-df-pill ses-df-pill--${dfNum}">DF${dfNum}</span>
        <span class="ses-pilot-num">${escHtml(d.carNumber)}</span>
        <span class="ses-pilot-name">${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></span>
        ${interimPos && interimPos < 999 ? `<span class="ses-fin-interim">${interimPos}ème</span>` : ''}
        ${isAssigned ? '<span class="ses-df-check">✓</span>' : ''}
        ${!isAssigned ? `
          <button class="btn btn-primary btn-sm ses-df-action"
            data-action="add" data-driver-id="${d.driverId}" data-df="fin">＋</button>
        ` : `
          <button class="btn btn-danger btn-sm ses-df-action"
            data-action="remove-fin" data-driver-id="${d.driverId}">✕</button>
        `}
      </div>`;
  };

  panel.innerHTML = `
    <div class="ses-detail-header">
      <div>
        <div class="ses-detail-label">Finale</div>
        <div class="ses-detail-meta">
          7 tours · ${assignedParticipants.length} pilote${assignedParticipants.length>1?'s':''} assigné${assignedParticipants.length>1?'s':''}
        </div>
      </div>
      <button class="btn btn-primary btn-sm" id="ses-auto-fin-btn2">⚡ Auto Finale</button>
    </div>

    ${hasNoResults ? `
      <div class="ses-df-notice">
        ⚠️ Aucun résultat de demi-finale saisi. Chronométrez les DF d'abord.
      </div>
    ` : ''}

    <div class="ses-fin-section-title">
      <span>Qualifiés — 4 premiers de chaque ½ finale</span>
      <span class="text-muted" style="font-size:0.75rem">Ordre : classement intermédiaire en cas d'égalité</span>
    </div>

    ${pairs.map(p => `
      <div class="ses-fin-pair">
        <span class="ses-fin-rank">${p.rank}</span>
        <div class="ses-fin-pair-pilots">
          ${pilotCard(p.first,  p.first  === df1Qualified[p.rank-1] || (!df2Qualified[p.rank-1] && p.first) ? 1 : 2)}
          ${p.second ? pilotCard(p.second, p.second === df2Qualified[p.rank-1] || (!df1Qualified[p.rank-1] && p.second) ? 2 : 1) : ''}
        </div>
      </div>
    `).join('')}

    ${allReplacements.length > 0 ? `
      <div class="ses-fin-section-title" style="margin-top:var(--sp-lg)">
        Remplaçants potentiels
        <span class="text-muted" style="font-size:0.75rem">triés par points DF puis classement intermédiaire</span>
      </div>
      ${allReplacements.map((d, i) => `
        <div class="ses-fin-pair ses-fin-pair--reserve">
          <span class="ses-fin-rank ses-fin-rank--reserve">${i+1}</span>
          <div class="ses-fin-pair-pilots">
            ${pilotCard(d, d.dfNum)}
          </div>
          <span class="ses-fin-total-pts">
            ${d.totalMeetingPoints} <span style="font-size:0.68rem;color:var(--clr-text-3)">pts total</span>
          </span>
        </div>
      `).join('')}
    ` : ''}
  `;

  document.getElementById('ses-auto-fin-btn2')?.addEventListener('click', () => autoAssignFinale());

  panel.querySelectorAll('.ses-df-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const driverId = btn.dataset.driverId;
      const action   = btn.dataset.action;
      const fin      = allSessions.find(s => s.type === 'FIN');
      if (!fin) return;

      if (action === 'add') {
        const driver = [...df1Results, ...df2Results].find(d => d.driverId === driverId);
        if (driver) await addParticipant(fin.id, driver);
      } else if (action === 'remove-fin') {
        await removeParticipant(fin.id, driverId);
      }

      const updated = await getParticipantsData(fin.id);
      await renderFinaleStandings(panel, session, updated);
    });
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
    .ses-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: var(--sp-md);
      align-items: start;
    }
    @media (max-width: 680px) {
      .ses-layout { grid-template-columns: 1fr; }
    }

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

    .ses-df-notice {
      padding: 8px var(--sp-md);
      background: var(--clr-warning-dim);
      border: 1px solid var(--clr-warning);
      border-radius: var(--r-md);
      color: var(--clr-warning);
      font-size: 0.82rem;
      margin-bottom: var(--sp-md);
    }
    .ses-df-legend {
      display: flex; align-items: center; gap: var(--sp-xs);
      font-size: 0.78rem; color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
    }
    .ses-df-standings { display: flex; flex-direction: column; gap: 3px; }
    .ses-df-row {
      display: flex; align-items: center; gap: var(--sp-sm);
      padding: 7px var(--sp-sm);
      border-radius: var(--r-sm);
      border: 1px solid transparent;
      transition: background var(--tr-fast);
    }
    .ses-df-row:hover { background: var(--clr-surface-2); }
    .ses-df-row--assigned { background: rgba(30,215,96,0.06); border-color: rgba(30,215,96,0.2); }
    .ses-df-row--other { opacity: 0.45; }
    .ses-df-row--reserve { opacity: 0.5; }

    .ses-df-pos {
      min-width: 22px; font-family: var(--font-display);
      font-size: 0.75rem; color: var(--clr-text-3);
      text-align: center; flex-shrink: 0;
    }
    .ses-df-pill {
      padding: 2px 7px; border-radius: 20px;
      font-family: var(--font-condensed); font-size: 0.7rem; font-weight: 700;
      letter-spacing: 0.06em; flex-shrink: 0;
    }
    .ses-df-pill--1       { background: rgba(255,119,48,0.2); color: #ff7730; border: 1px solid rgba(255,119,48,0.4); }
    .ses-df-pill--2       { background: rgba(59,158,255,0.2); color: var(--clr-info); border: 1px solid rgba(59,158,255,0.4); }
    .ses-df-pill--reserve { background: var(--clr-surface-2); color: var(--clr-text-3); border: 1px solid var(--clr-border); }

    .ses-df-pts {
      margin-left: auto; font-family: var(--font-display);
      font-size: 0.8rem; font-weight: 700; color: var(--clr-accent-2); flex-shrink: 0;
    }
    .ses-df-check { color: var(--clr-success); font-weight: 700; }

    .ses-fin-section-title {
      display: flex; align-items: baseline; gap: var(--sp-sm);
      font-family: var(--font-condensed); font-size: 0.75rem; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase; color: var(--clr-text-3);
      margin: var(--sp-sm) 0; flex-wrap: wrap;
    }
    .ses-fin-pair {
      display: flex; align-items: flex-start; gap: var(--sp-sm);
      padding: var(--sp-xs) 0;
      border-bottom: 1px solid var(--clr-border);
    }
    .ses-fin-pair:last-child { border-bottom: none; }
    .ses-fin-pair--reserve { opacity: 0.6; }
    .ses-fin-pair--reserve:hover { opacity: 1; }

    .ses-fin-rank {
      min-width: 22px; font-family: var(--font-display);
      font-size: 0.82rem; font-weight: 700; color: var(--clr-accent-2);
      text-align: center; flex-shrink: 0; padding-top: 2px;
    }
    .ses-fin-rank--reserve { color: var(--clr-text-3); }

    .ses-fin-pair-pilots { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .ses-fin-pilot {
      display: flex; align-items: center; gap: var(--sp-sm);
      padding: 6px var(--sp-sm); border-radius: var(--r-sm);
      border: 1px solid transparent; transition: background var(--tr-fast); flex-wrap: wrap;
    }
    .ses-fin-pilot:hover { background: var(--clr-surface-2); }
    .ses-fin-pilot--assigned { background: rgba(30,215,96,0.06); border-color: rgba(30,215,96,0.2); }
    .ses-fin-empty { color: var(--clr-text-3); font-size: 0.82rem; padding: 6px; }
    .ses-fin-total-pts {
      font-family: var(--font-display); font-size: 0.85rem; font-weight: 700;
      color: var(--clr-accent-2); flex-shrink: 0; align-self: center;
    }
    .ses-fin-interim {
      font-size: 0.72rem; color: var(--clr-text-3);
      font-style: italic; margin-left: auto;
    }

    .ses-df-actions {
      display: flex; gap: 4px; flex-shrink: 0;
      opacity: 0; transition: opacity var(--tr-fast);
    }
    .ses-df-row:hover .ses-df-actions { opacity: 1; }
    .ses-df-row--other .ses-df-actions,
    .ses-df-row--other:hover .ses-df-actions { opacity: 0.7; }
    .ses-df-action { font-size: 0.72rem !important; padding: 3px 7px !important; white-space: nowrap; }
    .ses-df-pts-label { font-size: 0.7rem; color: var(--clr-text-3); font-weight: 400; font-family: var(--font-body); }
    .ses-df-pts-pos { font-size: 0.78rem; color: var(--clr-text-3); font-style: italic; font-family: var(--font-body); font-weight: 400; }

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