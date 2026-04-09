/* ═══════════════════════════════════════════════
   DRIVERS.JS — Gestion des pilotes
   CRUD Firestore + filtre numéro/catégorie + auto-détection catégorie
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast, showView, categoryBadge } from './app.js';
import { escHtml, sanitize, CATEGORIES } from './utils.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { showDriverProfile } from './driverProfile.js';

// ─────────────────────────────────────────────────────────
// PLAGES DE NUMÉROS → CATÉGORIE
// ─────────────────────────────────────────────────────────

const CAR_NUMBER_RANGES = [
  { min: 1,   max: 99,  category: 'Supercar',  code: 'SC'    },
  { min: 101, max: 199, category: 'Super1600', code: 'S1600' },
  { min: 201, max: 249, category: 'Division 5', code: 'D5'   },
  { min: 251, max: 299, category: 'Féminines', code: 'F'     },
  { min: 301, max: 399, category: 'D3',        code: 'D3'    },
  { min: 401, max: 499, category: 'D4',        code: 'D4'    },
];

/**
 * Retourne la catégorie correspondant à un numéro de voiture.
 * @param {number} num
 * @returns {{ category: string, code: string }|null}
 */
function getCategoryFromNumber(num) {
  const n = parseInt(num);
  if (isNaN(n)) return null;
  return CAR_NUMBER_RANGES.find(r => n >= r.min && n <= r.max) || null;
}

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allDrivers   = [];      // tous les pilotes chargés
let unsubscribe  = null;    // listener Firestore
let editingId    = null;    // ID du pilote en cours d'édition

// Filtres actifs
let filterYear   = new Date().getFullYear();
let filterCat    = '';      // '' = toutes
let filterNum    = '';      // recherche saisie libre

// ─────────────────────────────────────────────────────────
// FIRESTORE — CRUD
// ─────────────────────────────────────────────────────────

async function loadDrivers() {
  if (!db) { toast('Firebase non connecté', 'error'); return; }

  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // Arrêter le listener précédent si existant
  if (unsubscribe) unsubscribe();

  const q = query(
    collection(db, 'drivers'),
    where('year', '==', filterYear),
    orderBy('carNumber', 'asc')
  );

  unsubscribe = onSnapshot(q, snap => {
    allDrivers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, err => {
    console.error(err);
    toast('Erreur de chargement des pilotes', 'error');
  });
}

async function saveDriver(data) {
  if (!db) { toast('Firebase non connecté', 'error'); return false; }
  if (!requireAuth()) return false;

  const { collection, doc, addDoc, updateDoc, query, where, getDocs } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  // Vérifier doublon numéro (même année, même catégorie, pas le même pilote)
  const q = query(
    collection(db, 'drivers'),
    where('year',      '==', data.year),
    where('carNumber', '==', data.carNumber),
    where('category',  '==', data.category)
  );
  const snap = await getDocs(q);
  const duplicate = snap.docs.find(d => d.id !== editingId);
  if (duplicate) {
    toast(`N° ${data.carNumber} déjà utilisé en ${data.category} pour ${data.year}`, 'error');
    return false;
  }

  try {
    if (editingId) {
      const ref = doc(db, 'drivers', editingId);
      await updateDoc(ref, data);
      logAudit('update', 'driver', editingId, { label: `${data.firstName} ${data.lastName} #${data.carNumber}` });
      toast('Pilote modifié ✓', 'success');
    } else {
      const newRef = await addDoc(collection(db, 'drivers'), {
        ...data,
        createdAt: new Date(),
      });
      logAudit('create', 'driver', newRef.id, { label: `${data.firstName} ${data.lastName} #${data.carNumber}` });
      toast('Pilote ajouté ✓', 'success');
    }
    return true;
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
    return false;
  }
}

async function deleteDriver(id) {
  if (!db) return;
  if (!requireAuth()) return;
  const { doc, deleteDoc, collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  try {
    // Collections liées à supprimer en cascade
    const cascadeCollections = [
      'engagements',
      'sessionParticipants',
      'results',
      'interimStandings',
      'meetingStandings',
    ];

    for (const col of cascadeCollections) {
      const snap = await getDocs(query(
        collection(db, col),
        where('driverId', '==', id)
      ));
      if (!snap.empty) {
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }

    // Supprimer le pilote lui-même
    const driverData = allDrivers.find(d => d.id === id);
    await deleteDoc(doc(db, 'drivers', id));
    logAudit('delete', 'driver', id, { label: driverData ? `${driverData.firstName} ${driverData.lastName} #${driverData.carNumber}` : id });
    toast('Pilote et toutes ses données supprimés', 'warning');
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la suppression', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// FILTRAGE
// ─────────────────────────────────────────────────────────

function getFilteredDrivers() {
  return allDrivers.filter(d => {
    // Filtre catégorie
    if (filterCat && d.category !== filterCat) return false;

    // Filtre numéro (recherche partielle)
    if (filterNum) {
      const num = String(d.carNumber);
      if (!num.includes(filterNum)) return false;
    }

    return true;
  });
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  const view = document.getElementById('view-drivers');
  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">👥 <span>Pilotes</span></h2>
      <div class="section-actions">
        <button class="btn btn-primary" id="drv-add-btn">＋ Ajouter un pilote</button>
      </div>
    </div>

    <!-- Filtres -->
    <div class="toolbar">
      <!-- Filtre année -->
      <select class="toolbar-select" id="drv-filter-year">
        ${years.map(y => `
          <option value="${y}" ${y === filterYear ? 'selected' : ''}>${y}</option>
        `).join('')}
      </select>

      <!-- Filtre catégorie -->
      <select class="toolbar-select" id="drv-filter-cat">
        <option value="">Toutes catégories</option>
        ${CAR_NUMBER_RANGES.map(r => `
          <option value="${r.category}" ${filterCat === r.category ? 'selected' : ''}>
            ${r.category} (${r.code}) — N°${r.min}–${r.max}
          </option>
        `).join('')}
      </select>

      <!-- Filtre numéro -->
      <input
        class="toolbar-input"
        type="number"
        id="drv-filter-num"
        placeholder="🔍 Filtrer par N°"
        value="${filterNum}"
        min="1" max="500"
        style="width: 150px"
      >

      <!-- Compteur -->
      <span class="drv-counter text-muted" id="drv-counter"></span>
    </div>

    <!-- Légende des plages -->
    <div class="drv-ranges" id="drv-ranges">
      ${CAR_NUMBER_RANGES.map(r => `
        <div class="drv-range-pill drv-range-${r.code.toLowerCase()}">
          <span class="drv-range-code">${r.code}</span>
          <span class="drv-range-nums">${r.min}–${r.max}</span>
        </div>
      `).join('')}
    </div>

    <!-- Tableau -->
    <div class="table-wrap mt-md">
      <table id="drv-table">
        <thead>
          <tr>
            <th class="center" style="width:70px">N°</th>
            <th>Pilote</th>
            <th>Catégorie</th>
            <th class="center" style="width:80px">Saison</th>
            <th class="center" style="width:100px">Actions</th>
          </tr>
        </thead>
        <tbody id="drv-tbody"></tbody>
      </table>
    </div>

    <!-- Modal ajout/édition -->
    <div class="modal-backdrop" id="drv-modal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title" id="drv-modal-title">Ajouter un pilote</span>
          <button class="modal-close" id="drv-modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="drv-firstname">Prénom *</label>
              <input class="form-input" type="text" id="drv-firstname" maxlength="50" placeholder="Jean">
            </div>
            <div class="form-group">
              <label class="form-label" for="drv-lastname">Nom *</label>
              <input class="form-input" type="text" id="drv-lastname" maxlength="50" placeholder="DUPONT">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="drv-carnum">Numéro de voiture *</label>
            <input
              class="form-input"
              type="number"
              id="drv-carnum"
              min="1" max="500"
              placeholder="Ex: 42 → Supercar"
            >
            <!-- Badge catégorie auto-détectée -->
            <div id="drv-cat-preview" class="drv-cat-preview" style="display:none"></div>
          </div>

          <!-- Catégorie (lecture seule, remplie auto) -->
          <div class="form-group">
            <label class="form-label">Catégorie <span class="text-muted">(détectée automatiquement)</span></label>
            <input class="form-input" type="text" id="drv-category" readonly
              placeholder="Saisir un N° de voiture valide (1–500)">
          </div>

          <div class="form-group">
            <label class="form-label" for="drv-year">Saison *</label>
            <select class="form-select" id="drv-year">
              ${years.map(y => `
                <option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>
              `).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="drv-modal-cancel">Annuler</button>
          <button class="btn btn-primary" id="drv-modal-save">💾 Enregistrer</button>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  renderTable();
}

function renderTable() {
  const tbody   = document.getElementById('drv-tbody');
  const counter = document.getElementById('drv-counter');
  if (!tbody) return;

  const drivers = getFilteredDrivers();

  if (counter) counter.textContent = `${drivers.length} pilote${drivers.length > 1 ? 's' : ''}`;

  if (drivers.length === 0) {
    tbody.innerHTML = `
      <tr><td class="table-empty" colspan="5">
        ${allDrivers.length === 0
          ? 'Aucun pilote pour cette saison. Cliquez sur « Ajouter un pilote ».'
          : 'Aucun pilote ne correspond aux filtres.'}
      </td></tr>`;
    return;
  }

  tbody.innerHTML = drivers.map(d => `
    <tr>
      <td class="center">
        <span class="drv-num">${escHtml(d.carNumber)}</span>
      </td>
      <td>
        <span class="drv-fullname">${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></span>
      </td>
      <td>${categoryBadge(d.category)}</td>
      <td class="center text-muted">${escHtml(d.year)}</td>
      <td class="center">
        <div class="drv-actions">
          <button class="btn btn-ghost btn-icon drv-profile-btn" data-id="${d.id}" title="Fiche pilote">📊</button>
          <button class="btn btn-ghost btn-icon drv-edit-btn"    data-id="${d.id}" title="Modifier">✏️</button>
          <button class="btn btn-danger btn-icon drv-del-btn"    data-id="${d.id}" title="Supprimer">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  // Rebinder les boutons du tableau (regénéré à chaque render)
  document.querySelectorAll('.drv-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEdit(btn.dataset.id))
  );
  document.querySelectorAll('.drv-del-btn').forEach(btn =>
    btn.addEventListener('click', () => onDelete(btn.dataset.id))
  );
  document.querySelectorAll('.drv-profile-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const driver = allDrivers.find(d => d.id === btn.dataset.id);
      if (driver) showDriverProfile(driver);
    })
  );
}

// ─────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────

function openAdd() {
  editingId = null;
  document.getElementById('drv-modal-title').textContent = 'Ajouter un pilote';
  document.getElementById('drv-firstname').value = '';
  document.getElementById('drv-lastname').value  = '';
  document.getElementById('drv-carnum').value    = '';
  document.getElementById('drv-category').value  = '';
  document.getElementById('drv-year').value      = String(filterYear);
  hideCatPreview();
  document.getElementById('drv-modal').classList.add('is-open');
  document.getElementById('drv-firstname').focus();
}

function openEdit(id) {
  const driver = allDrivers.find(d => d.id === id);
  if (!driver) return;

  editingId = id;
  document.getElementById('drv-modal-title').textContent = 'Modifier le pilote';
  document.getElementById('drv-firstname').value = driver.firstName || '';
  document.getElementById('drv-lastname').value  = driver.lastName  || '';
  document.getElementById('drv-carnum').value    = driver.carNumber || '';
  document.getElementById('drv-category').value  = driver.category  || '';
  document.getElementById('drv-year').value      = String(driver.year);
  showCatPreview(driver.carNumber);
  document.getElementById('drv-modal').classList.add('is-open');
  document.getElementById('drv-firstname').focus();
}

function closeModal() {
  document.getElementById('drv-modal').classList.remove('is-open');
  editingId = null;
}

// ─────────────────────────────────────────────────────────
// PRÉVISUALISATION CATÉGORIE
// ─────────────────────────────────────────────────────────

function showCatPreview(num) {
  const preview = document.getElementById('drv-cat-preview');
  const catInput = document.getElementById('drv-category');
  if (!preview || !catInput) return;

  const match = getCategoryFromNumber(num);
  if (match) {
    catInput.value = match.category;
    preview.style.display = 'flex';
    preview.innerHTML = `
      <span>✓ Numéro valide :</span>
      ${categoryBadge(match.category)}
      <span class="text-muted">(${match.code} — N°${match.min}–${match.max})</span>
    `;
    preview.className = 'drv-cat-preview drv-cat-preview--ok';
  } else {
    const n = parseInt(num);
    catInput.value = '';
    if (!isNaN(n) && num !== '') {
      preview.style.display = 'flex';
      preview.innerHTML = `<span>⚠️ Numéro hors plage (1–500)</span>`;
      preview.className = 'drv-cat-preview drv-cat-preview--err';
    } else {
      hideCatPreview();
    }
  }
}

function hideCatPreview() {
  const preview = document.getElementById('drv-cat-preview');
  if (preview) preview.style.display = 'none';
}

// ─────────────────────────────────────────────────────────
// VALIDATION & SAUVEGARDE
// ─────────────────────────────────────────────────────────

async function onSave() {
  const firstName = sanitize(document.getElementById('drv-firstname').value, 50);
  const lastName  = sanitize(document.getElementById('drv-lastname').value,  50);
  const carNum    = parseInt(document.getElementById('drv-carnum').value);
  const year      = parseInt(document.getElementById('drv-year').value);

  if (!firstName) { toast('Prénom obligatoire', 'error'); return; }
  if (!lastName)  { toast('Nom obligatoire', 'error'); return; }
  if (!carNum || isNaN(carNum)) { toast('Numéro de voiture obligatoire', 'error'); return; }

  const match = getCategoryFromNumber(carNum);
  if (!match) {
    toast('Numéro de voiture hors plage (1–500)', 'error');
    return;
  }

  const data = {
    firstName,
    lastName,
    carNumber: carNum,
    category:  match.category,
    year,
  };

  const ok = await saveDriver(data);
  if (ok) closeModal();
}

async function onDelete(id) {
  const driver = allDrivers.find(d => d.id === id);
  if (!driver) return;
  await showDeleteConfirmModal(driver);
}

/**
 * Modale de confirmation de suppression avec détail complet
 * de toutes les données qui seront supprimées.
 */
async function showDeleteConfirmModal(driver) {
  const { collection, query, where, getDocs, orderBy } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  // ── Récupérer toutes les données liées ────────────────
  const [engSnap, partSnap, resSnap, interimSnap, meetingSnap] = await Promise.all([
    getDocs(query(collection(db, 'engagements'),        where('driverId', '==', driver.id))),
    getDocs(query(collection(db, 'sessionParticipants'),where('driverId', '==', driver.id))),
    getDocs(query(collection(db, 'results'),            where('driverId', '==', driver.id))),
    getDocs(query(collection(db, 'interimStandings'),   where('driverId', '==', driver.id))),
    getDocs(query(collection(db, 'meetingStandings'),   where('driverId', '==', driver.id))),
  ]);

  const engagements  = engSnap.docs.map(d => d.data());
  const participants = partSnap.docs.map(d => d.data());
  const results      = resSnap.docs.map(d => d.data());

  // ── Récupérer les noms des sessions ──────────────────
  const sessionIds = [...new Set(participants.map(p => p.sessionId))];
  const sessionsMap = {};
  for (const sid of sessionIds) {
    try {
      const sSnap = await getDocs(query(
        collection(db, 'sessions'), where('__name__', '==', sid)
      ));
      // Fallback : chercher par ID direct
      const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
      );
      const sDoc = await getDoc(doc(db, 'sessions', sid));
      if (sDoc.exists()) sessionsMap[sid] = sDoc.data();
    } catch {}
  }

  // ── Récupérer les noms des meetings ──────────────────
  const meetingIds = [...new Set(engagements.map(e => e.meetingId))];
  const meetingsMap = {};
  for (const mid of meetingIds) {
    try {
      const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
      );
      const mDoc = await getDoc(doc(db, 'meetings', mid));
      if (mDoc.exists()) meetingsMap[mid] = mDoc.data();
    } catch {}
  }

  // ── Grouper les résultats par session ─────────────────
  const resultsBySession = {};
  results.forEach(r => {
    if (!resultsBySession[r.sessionId]) resultsBySession[r.sessionId] = [];
    resultsBySession[r.sessionId].push(r);
  });

  // ── Construire le HTML de détail ──────────────────────
  const SESSION_LABELS = { EC: 'Essais', MQ: 'MQ', DF: 'DF', FIN: 'Finale' };

  const meetingBlocks = meetingIds.map(mid => {
    const meeting = meetingsMap[mid];
    const dateStr = meeting?.date ? new Date(meeting.date).toLocaleDateString('fr-FR') : '?';
    const location = meeting?.location || '?';

    const sessionsForMeeting = participants
      .filter(p => {
        const s = sessionsMap[p.sessionId];
        return s?.meetingId === mid;
      })
      .sort((a, b) => {
        const sa = sessionsMap[a.sessionId];
        const sb = sessionsMap[b.sessionId];
        return (sa?.order ?? 99) - (sb?.order ?? 99);
      });

    const sessionRows = sessionsForMeeting.map(p => {
      const s = sessionsMap[p.sessionId];
      const label = s ? `${SESSION_LABELS[s.type] || s.type}${s.num ? s.num : ''}` : '?';
      const res = resultsBySession[p.sessionId]?.[0];
      let timeStr = '<span class="text-muted">Pas de temps</span>';
      if (res?.ms) {
        const m = Math.floor(res.ms / 60000);
        const sec = Math.floor((res.ms % 60000) / 1000);
        const ms = res.ms % 1000;
        timeStr = `<strong class="text-success">${m}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}</strong>`;
      } else if (res?.status) {
        timeStr = `<span class="badge badge-${res.status.toLowerCase().replace('_race','')}">${res.status === 'DSQ_RACE' ? 'DSQ EC' : res.status === 'DSQ' ? 'DSQ HC' : res.status}</span>`;
      }
      return `
        <div class="drv-del-session-row">
          <span class="badge badge-${(s?.type || 'mq').toLowerCase()}">${label}</span>
          <span>${timeStr}</span>
        </div>`;
    }).join('');

    return `
      <div class="drv-del-meeting">
        <div class="drv-del-meeting-title">📅 ${dateStr} — ${escHtml(location)}</div>
        ${sessionsForMeeting.length === 0
          ? '<div class="text-muted" style="font-size:0.8rem;padding:4px 0">Engagé mais aucune session assignée</div>'
          : sessionRows}
      </div>`;
  }).join('');

  // Impacts sur les classements
  const hasInterim  = !interimSnap.empty;
  const hasMeeting  = !meetingSnap.empty;
  const hasTimes    = results.length > 0;

  const impactHtml = (hasInterim || hasMeeting || hasTimes) ? `
    <div class="drv-del-impact">
      <div class="drv-del-impact-title">⚠️ Impacts sur les classements</div>
      ${hasTimes ? `<div class="drv-del-impact-row">🔄 Les points MQ et le classement intermédiaire devront être recalculés et re-sauvegardés</div>` : ''}
      ${hasInterim ? `<div class="drv-del-impact-row">🔄 La répartition DF1/DF2 (Auto DF) devra être relancée</div>` : ''}
      ${hasMeeting ? `<div class="drv-del-impact-row">🔄 Le classement du meeting devra être re-sauvegardé</div>` : ''}
      ${(hasInterim || hasMeeting) ? `<div class="drv-del-impact-row">🔄 Vérifier les qualifiés Finale et les remplaçants</div>` : ''}
    </div>
  ` : '';

  // ── Afficher la modale ────────────────────────────────
  let modal = document.getElementById('drv-delete-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'drv-delete-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <span class="modal-title" id="drv-del-title"></span>
          <button class="modal-close" id="drv-del-close">✕</button>
        </div>
        <div class="modal-body" id="drv-del-body"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="drv-del-cancel">Annuler</button>
          <button class="btn btn-danger"    id="drv-del-confirm">🗑️ Supprimer définitivement</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('drv-del-close')?.addEventListener('click',  () => modal.classList.remove('is-open'));
    document.getElementById('drv-del-cancel')?.addEventListener('click', () => modal.classList.remove('is-open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('is-open'); });
  }

  document.getElementById('drv-del-title').textContent =
    `Supprimer ${driver.firstName} ${driver.lastName} — N°${driver.carNumber}`;

  document.getElementById('drv-del-body').innerHTML = `
    <div class="drv-del-summary">
      <span>🏁 ${engagements.length} meeting(s)</span>
      <span>📋 ${participants.length} session(s)</span>
      <span>⏱️ ${results.length} temps saisis</span>
    </div>

    ${meetingIds.length === 0
      ? '<div class="text-muted" style="padding:var(--sp-md)">Aucune donnée associée à ce pilote.</div>'
      : meetingBlocks}

    ${impactHtml}
  `;

  // Brancher le bouton confirmer
  const confirmBtn = document.getElementById('drv-del-confirm');
  const newBtn = confirmBtn.cloneNode(true); // retirer les anciens listeners
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  // Reset état du bouton à chaque ouverture
  newBtn.disabled = false;
  newBtn.textContent = '🗑️ Supprimer définitivement';

  newBtn.addEventListener('click', async () => {
    newBtn.disabled = true;
    newBtn.textContent = '⏳ Suppression…';
    modal.classList.remove('is-open');
    await deleteDriver(driver.id);
    // Reset pour la prochaine utilisation
    newBtn.disabled = false;
    newBtn.textContent = '🗑️ Supprimer définitivement';
  });

  modal.classList.add('is-open');
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  // Bouton ajouter
  document.getElementById('drv-add-btn')
    ?.addEventListener('click', openAdd);

  // Modal fermeture
  document.getElementById('drv-modal-close')
    ?.addEventListener('click', closeModal);
  document.getElementById('drv-modal-cancel')
    ?.addEventListener('click', closeModal);
  document.getElementById('drv-modal')
    ?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  // Sauvegarde
  document.getElementById('drv-modal-save')
    ?.addEventListener('click', onSave);

  // Enter dans le formulaire
  ['drv-firstname', 'drv-lastname', 'drv-carnum'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') onSave();
    });
  });

  // Auto-détection catégorie au changement du numéro
  document.getElementById('drv-carnum')
    ?.addEventListener('input', e => showCatPreview(e.target.value));

  // Filtres
  document.getElementById('drv-filter-year')?.addEventListener('change', e => {
    filterYear = parseInt(e.target.value);
    loadDrivers();
  });

  document.getElementById('drv-filter-cat')?.addEventListener('change', e => {
    filterCat = e.target.value;
    // Si on filtre par catégorie, effacer le filtre numéro pour éviter confusion
    filterNum = '';
    const numInput = document.getElementById('drv-filter-num');
    if (numInput) numInput.value = '';
    renderTable();
  });

  document.getElementById('drv-filter-num')?.addEventListener('input', e => {
    filterNum = e.target.value.trim();
    // Mettre à jour le filtre catégorie selon la plage du numéro saisi
    if (filterNum) {
      const match = getCategoryFromNumber(filterNum);
      if (match) {
        filterCat = match.category;
        const catSelect = document.getElementById('drv-filter-cat');
        if (catSelect) catSelect.value = match.category;
      }
    } else {
      // Réinitialiser le filtre catégorie quand on efface le numéro
      filterCat = '';
      const catSelect = document.getElementById('drv-filter-cat');
      if (catSelect) catSelect.value = '';
    }
    renderTable();
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initDrivers() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'drivers') {
      renderView();
      loadDrivers();
    }
  });
}