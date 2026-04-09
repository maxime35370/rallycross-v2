/* ═══════════════════════════════════════════════
   ENGAGEMENTS.JS — Assignation des pilotes aux meetings
   Sélection par meeting + catégorie, sauvegarde Firestore
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, CATEGORIES } from './utils.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings    = [];   // meetings de l'année
let allDrivers     = [];   // pilotes de l'année + catégorie sélectionnée
let engagedIds     = new Set(); // IDs des pilotes engagés au meeting sélectionné
let unsubMeetings  = null;
let unsubDrivers   = null;
let unsubEngaged   = null;

let selectedYear     = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';

// ─────────────────────────────────────────────────────────
// FIRESTORE
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

async function loadDrivers() {
  if (!db || !selectedCategory) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubDrivers) unsubDrivers();

  const q = query(
    collection(db, 'drivers'),
    where('year',     '==', selectedYear),
    where('category', '==', selectedCategory),
    orderBy('carNumber', 'asc')
  );
  unsubDrivers = onSnapshot(q, snap => {
    allDrivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDriversList();
  });
}

async function loadEngaged() {
  if (!db || !selectedMeetingId || !selectedCategory) {
    engagedIds = new Set();
    renderDriversList();
    return;
  }
  engagedIds = new Set();
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubEngaged) unsubEngaged();

  const q = query(
    collection(db, 'engagements'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  );
  unsubEngaged = onSnapshot(q, snap => {
    engagedIds = new Set(snap.docs.map(d => d.data().driverId));
    renderDriversList();
  });
}

async function toggleEngagement(driver) {
  if (!db || !selectedMeetingId) return;
  if (!requireAuth()) return;
  const { collection, query, where, getDocs, addDoc, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const meeting = allMeetings.find(m => m.id === selectedMeetingId);

  if (engagedIds.has(driver.id)) {
    // Vérifier si le pilote a des données pour ce meeting
    const [partSnap, resSnap] = await Promise.all([
      getDocs(query(collection(db, 'sessionParticipants'),
        where('meetingId', '==', selectedMeetingId),
        where('driverId',  '==', driver.id))),
      getDocs(query(collection(db, 'results'),
        where('meetingId', '==', selectedMeetingId),
        where('driverId',  '==', driver.id))),
    ]);

    const hasSessions = !partSnap.empty;
    const hasTimes    = !resSnap.empty;

    // Confirmation si des données existent
    if (hasSessions || hasTimes) {
      const detail = [
        hasSessions ? `${partSnap.size} session(s) assignée(s)` : null,
        hasTimes    ? `${resSnap.size} temps saisi(s)`          : null,
      ].filter(Boolean).join(', ');
      const msg = `Retirer ${driver.firstName} ${driver.lastName} de ce meeting ?\n\nSes données seront aussi supprimées : ${detail}\n\nContinuer ?`;
      if (!window.confirm(msg)) return;
    }

    // Supprimer engagement
    const qEng = query(collection(db, 'engagements'),
      where('meetingId', '==', selectedMeetingId),
      where('driverId',  '==', driver.id));
    const engSnap = await getDocs(qEng);
    engSnap.docs.forEach(d => deleteDoc(d.ref));

    // Supprimer sessions et temps en cascade
    const { writeBatch } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    if (!partSnap.empty) {
      const b = writeBatch(db);
      partSnap.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    }
    if (!resSnap.empty) {
      const b = writeBatch(db);
      resSnap.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    }
    // Supprimer aussi les classements intermédiaires et meeting pour ce pilote/meeting
    for (const col of ['meetingStandings']) {
      const snap = await getDocs(query(collection(db, col),
        where('meetingId', '==', selectedMeetingId),
        where('driverId',  '==', driver.id)));
      if (!snap.empty) {
        const b = writeBatch(db);
        snap.docs.forEach(d => b.delete(d.ref));
        await b.commit();
      }
    }

    logAudit('delete', 'engagement', driver.id, { label: `${driver.firstName} ${driver.lastName} retire du meeting` });
    toast(`${driver.firstName} ${driver.lastName} retiré et données supprimées`, 'warning');
  } else {
    // Engager
    await addDoc(collection(db, 'engagements'), {
      meetingId:  selectedMeetingId,
      driverId:   driver.id,
      category:   driver.category,
      year:       selectedYear,
      carNumber:  driver.carNumber,
      firstName:  driver.firstName,
      lastName:   driver.lastName,
      createdAt:  new Date(),
    });
    logAudit('create', 'engagement', driver.id, { label: `${driver.firstName} ${driver.lastName} engage` });
    toast(`${driver.firstName} ${driver.lastName} engagé ✓`, 'success');
  }
}

async function clearAllEngagements() {
  if (!db || !selectedMeetingId || !selectedCategory) return;
  if (!requireAuth()) return;
  if (!window.confirm(`Retirer tous les pilotes ${selectedCategory} de ce meeting ?`)) return;

  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'engagements'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;

  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  toast('Tous les engagements retirés', 'warning');
}

async function engageAll() {
  if (!db || !selectedMeetingId || allDrivers.length === 0) return;
  if (!requireAuth()) return;
  const { collection, query, where, getDocs, addDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const toEngage = allDrivers.filter(d => !engagedIds.has(d.id));
  if (toEngage.length === 0) { toast('Tous les pilotes sont déjà engagés', 'info'); return; }

  for (const driver of toEngage) {
    await addDoc(collection(db, 'engagements'), {
      meetingId: selectedMeetingId,
      driverId:  driver.id,
      category:  driver.category,
      year:      selectedYear,
      carNumber: driver.carNumber,
      firstName: driver.firstName,
      lastName:  driver.lastName,
      createdAt: new Date(),
    });
  }
  toast(`${toEngage.length} pilote(s) engagé(s) ✓`, 'success');
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  const view = document.getElementById('view-engagements');
  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📋 <span>Engagements</span></h2>
    </div>

    <!-- Filtres -->
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="eng-year">
        ${years.map(y => `
          <option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}</option>
        `).join('')}
      </select>

      <select class="toolbar-select" id="eng-meeting" style="flex:1;min-width:200px">
        <option value="">— Sélectionner un meeting —</option>
      </select>

      <select class="toolbar-select" id="eng-category">
        <option value="">— Sélectionner une catégorie —</option>
        ${CATEGORIES.map(c => `
          <option value="${c}" ${c === selectedCategory ? 'selected' : ''}>${escHtml(c)}</option>
        `).join('')}
      </select>
    </div>

    <!-- Zone principale -->
    <div id="eng-content">
      <div class="eng-placeholder">
        <div class="placeholder-icon">📋</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('eng-meeting');
  if (!sel) return;

  const prev = selectedMeetingId;
  sel.innerHTML = `<option value="">— Sélectionner un meeting —</option>`;

  allMeetings.forEach(m => {
    const d = m.date
      ? new Date(m.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' })
      : '??/??/????';
    const label = `${d} — ${m.location || '?'}`;
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = label;
    if (m.id === prev) opt.selected = true;
    sel.appendChild(opt);
  });

  // Si le meeting précédemment sélectionné n'existe plus, reset
  if (prev && !allMeetings.find(m => m.id === prev)) {
    selectedMeetingId = '';
  }
  renderContent();
}

function renderContent() {
  const content = document.getElementById('eng-content');
  if (!content) return;

  if (!selectedMeetingId || !selectedCategory) {
    content.innerHTML = `
      <div class="eng-placeholder">
        <div class="placeholder-icon">📋</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>`;
    return;
  }

  const meeting = allMeetings.find(m => m.id === selectedMeetingId);

  // Vérifier que la catégorie est bien dans ce meeting
  if (meeting && !(meeting.categories || []).includes(selectedCategory)) {
    content.innerHTML = `
      <div class="eng-placeholder">
        <div class="placeholder-icon">⚠️</div>
        <div class="placeholder-title">La catégorie <strong>${escHtml(selectedCategory)}</strong> n'est pas incluse dans ce meeting.</div>
      </div>`;
    return;
  }

  const engCount = engagedIds.size;
  const totalCount = allDrivers.length;

  content.innerHTML = `
    <!-- En-tête avec compteur et actions rapides -->
    <div class="eng-header card">
      <div class="eng-header-info">
        <div class="eng-header-meeting">
          ${meeting ? escHtml(`${new Date(meeting.date).toLocaleDateString('fr-FR')} — ${meeting.location}`) : ''}
        </div>
        <div class="eng-header-stats">
          <span class="eng-stat">
            <span class="eng-stat-value">${engCount}</span>
            <span class="eng-stat-label">engagé${engCount > 1 ? 's' : ''}</span>
          </span>
          <span class="eng-stat-sep">/</span>
          <span class="eng-stat">
            <span class="eng-stat-value">${totalCount}</span>
            <span class="eng-stat-label">pilote${totalCount > 1 ? 's' : ''} ${escHtml(selectedCategory)}</span>
          </span>
        </div>
      </div>
      <div class="eng-header-actions">
        <button class="btn btn-secondary btn-sm" id="eng-all-btn">✅ Tous engager</button>
        <button class="btn btn-danger btn-sm" id="eng-clear-btn">🗑️ Tout retirer</button>
      </div>
    </div>

    <!-- Liste des pilotes -->
    <div class="eng-list" id="eng-list"></div>
  `;

  document.getElementById('eng-all-btn')?.addEventListener('click', engageAll);
  document.getElementById('eng-clear-btn')?.addEventListener('click', clearAllEngagements);

  renderDriversList();
}

function renderDriversList() {
  const list = document.getElementById('eng-list');
  if (!list) return;

  // Mettre à jour le compteur
  const statVal = document.querySelector('.eng-stat-value');
  if (statVal) statVal.textContent = engagedIds.size;

  const statTotal = document.querySelectorAll('.eng-stat-value')[1];
  if (statTotal && allDrivers.length > 0) statTotal.textContent = allDrivers.length;

  if (allDrivers.length === 0) {
    list.innerHTML = `
      <div class="eng-empty">
        Aucun pilote ${escHtml(selectedCategory)} pour ${selectedYear}.
        <a href="#" data-view="drivers">Ajouter des pilotes →</a>
      </div>`;
    return;
  }

  // Séparer engagés / non engagés
  const engaged    = allDrivers.filter(d =>  engagedIds.has(d.id));
  const notEngaged = allDrivers.filter(d => !engagedIds.has(d.id));

  list.innerHTML = `
    ${engaged.length > 0 ? `
      <div class="eng-group-title">
        <span class="eng-group-dot eng-group-dot--on"></span>
        Engagés (${engaged.length})
      </div>
      ${engaged.map(d => driverCard(d, true)).join('')}
    ` : ''}

    ${notEngaged.length > 0 ? `
      <div class="eng-group-title" style="margin-top:var(--sp-md)">
        <span class="eng-group-dot eng-group-dot--off"></span>
        Non engagés (${notEngaged.length})
      </div>
      ${notEngaged.map(d => driverCard(d, false)).join('')}
    ` : ''}
  `;

  // Binder les toggles
  list.querySelectorAll('.eng-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const driver = allDrivers.find(d => d.id === btn.dataset.id);
      if (driver) toggleEngagement(driver);
    });
  });

  // Lien vers pilotes
  list.querySelector('[data-view="drivers"]')?.addEventListener('click', e => {
    e.preventDefault();
    import('./app.js').then(m => m.showView('drivers'));
  });
}

function driverCard(driver, isEngaged) {
  return `
    <div class="eng-driver-card ${isEngaged ? 'eng-driver-card--on' : ''}">
      <div class="eng-driver-num">${escHtml(driver.carNumber)}</div>
      <div class="eng-driver-name">
        ${escHtml(driver.firstName)} <strong>${escHtml(driver.lastName)}</strong>
      </div>
      <button class="btn eng-toggle-btn ${isEngaged ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}"
        data-id="${driver.id}">
        ${isEngaged ? '✕ Retirer' : '＋ Engager'}
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('eng-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    loadMeetings();
    loadDrivers();
  });

  document.getElementById('eng-meeting')?.addEventListener('change', e => {
    selectedMeetingId = e.target.value;
    engagedIds = new Set();
    loadEngaged();
    renderContent();
  });

  document.getElementById('eng-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value;
    allDrivers  = [];
    engagedIds  = new Set(); 
    renderContent();      
    loadDrivers();        
    loadEngaged();        
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initEngagements() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'engagements') {
      renderView();
      loadMeetings();
      if (selectedCategory) loadDrivers();
      if (selectedMeetingId && selectedCategory) loadEngaged();
    }
  });
}