/* ═══════════════════════════════════════════════
   PERSONS.JS — Fiches pilotes (personnes physiques)
   CRUD Firestore independant du championnat
   Phase 1 : collection `persons` + UI basique
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, sanitize } from './utils.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { showPersonProfile } from './personProfile.js';

// ─────────────────────────────────────────────────────────
// ETAT LOCAL
// ─────────────────────────────────────────────────────────

let allPersons  = [];
let unsubscribe = null;
let editingId   = null;
let filterText  = '';

// ─────────────────────────────────────────────────────────
// FIRESTORE — CRUD
// ─────────────────────────────────────────────────────────

async function loadPersons() {
  if (!db) { toast('Firebase non connecté', 'error'); return; }

  const { collection, query, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  if (unsubscribe) unsubscribe();

  const q = query(collection(db, 'persons'), orderBy('lastName', 'asc'));

  unsubscribe = onSnapshot(q, snap => {
    allPersons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, err => {
    console.error(err);
    toast('Erreur de chargement des fiches pilotes', 'error');
  });
}

async function savePerson(data) {
  if (!db) { toast('Firebase non connecté', 'error'); return false; }
  if (!requireAuth()) return false;

  const { collection, doc, addDoc, updateDoc, serverTimestamp, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    // Duplicate check: firstName + lastName (case-insensitive)
    const fnLower = (data.firstName || '').toLowerCase();
    const lnLower = (data.lastName || '').toLowerCase();
    const existing = allPersons.find(p =>
      p.id !== editingId &&
      (p.firstName || '').toLowerCase() === fnLower &&
      (p.lastName || '').toLowerCase() === lnLower
    );
    if (existing) {
      const ok = window.confirm(
        'Une fiche existe deja pour ' + data.firstName + ' ' + data.lastName + '.\n\n' +
        'Voulez-vous quand meme creer une nouvelle fiche ?\n' +
        '(Par exemple en cas d\'homonyme)'
      );
      if (!ok) return false;
    }

    if (editingId) {
      await updateDoc(doc(db, 'persons', editingId), { ...data, updatedAt: serverTimestamp() });
      await logAudit('update', 'person', editingId, data.firstName + ' ' + data.lastName);
      toast('Fiche mise a jour', 'success');
    } else {
      const ref = await addDoc(collection(db, 'persons'), { ...data, createdAt: serverTimestamp() });
      await logAudit('create', 'person', ref.id, data.firstName + ' ' + data.lastName);
      toast('Fiche creee', 'success');
    }
    return true;
  } catch (e) {
    console.error(e);
    toast('Erreur d\'enregistrement', 'error');
    return false;
  }
}

async function deletePerson(id) {
  if (!db) { toast('Firebase non connecté', 'error'); return; }
  if (!requireAuth()) return;

  const person = allPersons.find(p => p.id === id);
  if (!person) return;

  const label = (person.firstName || '') + ' ' + (person.lastName || '');
  if (!window.confirm('Supprimer la fiche de ' + label + ' ?\n\nCela ne supprime pas les inscriptions championnat (drivers) existantes.')) return;

  const { doc, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    await deleteDoc(doc(db, 'persons', id));
    await logAudit('delete', 'person', id, label);
    toast('Fiche supprimee', 'success');
  } catch (e) {
    console.error(e);
    toast('Erreur de suppression', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// FILTRAGE
// ─────────────────────────────────────────────────────────

function getFilteredPersons() {
  if (!filterText) return allPersons;
  const needle = filterText.toLowerCase();
  return allPersons.filter(p => {
    const fn = (p.firstName || '').toLowerCase();
    const ln = (p.lastName  || '').toLowerCase();
    const lic = (p.licenseNumber || '').toLowerCase();
    return fn.includes(needle) || ln.includes(needle) || lic.includes(needle);
  });
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const container = document.getElementById('view-persons');
  if (!container) return;

  container.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🏃 <span>Fiches Pilotes</span></h2>
      <button class="btn btn-primary" id="prs-add-btn">+ Nouvelle fiche</button>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <input
        class="toolbar-input"
        type="text"
        id="prs-filter"
        placeholder="🔍 Rechercher par nom, prenom ou licence"
        value="${escHtml(filterText)}"
        style="flex:1;min-width:220px"
      >
      <span class="text-muted" id="prs-counter"></span>
    </div>

    <div class="std-note" style="padding:var(--sp-sm) 0">
      Une fiche represente une personne physique, independante des championnats.
      Les inscriptions championnat (numero de course, categorie) sont gerees dans la vue Pilotes.
    </div>

    <div class="table-wrap mt-md">
      <table id="prs-table">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Prenom</th>
            <th class="center">Licence</th>
            <th class="center">Nationalite</th>
            <th class="center" style="width:100px">Actions</th>
          </tr>
        </thead>
        <tbody id="prs-tbody"></tbody>
      </table>
    </div>

    <!-- Modal ajout/edition -->
    <div class="modal-backdrop" id="prs-modal">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title" id="prs-modal-title">Nouvelle fiche pilote</span>
          <button class="modal-close" id="prs-modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="prs-firstname">Prenom *</label>
              <input class="form-input" type="text" id="prs-firstname" maxlength="50" placeholder="Jean">
            </div>
            <div class="form-group">
              <label class="form-label" for="prs-lastname">Nom *</label>
              <input class="form-input" type="text" id="prs-lastname" maxlength="50" placeholder="DUPONT">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="prs-license">Numero de licence</label>
              <input class="form-input" type="text" id="prs-license" maxlength="30" placeholder="Optionnel">
            </div>
            <div class="form-group">
              <label class="form-label" for="prs-birthdate">Date de naissance</label>
              <input class="form-input" type="date" id="prs-birthdate">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="prs-nationality">Nationalite</label>
              <input class="form-input" type="text" id="prs-nationality" maxlength="50" placeholder="France">
            </div>
            <div class="form-group">
              <label class="form-label" for="prs-team">Ecurie / Team</label>
              <input class="form-input" type="text" id="prs-team" maxlength="80" placeholder="Optionnel">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="prs-notes">Notes</label>
            <textarea class="form-input" id="prs-notes" rows="3" maxlength="500" placeholder="Remarques, infos complementaires..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="prs-modal-cancel">Annuler</button>
          <button class="btn btn-primary" id="prs-modal-save">💾 Enregistrer</button>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('prs-tbody');
  const counter = document.getElementById('prs-counter');
  if (!tbody) return;

  const persons = getFilteredPersons();

  if (counter) counter.textContent = persons.length + ' fiche' + (persons.length > 1 ? 's' : '');

  if (persons.length === 0) {
    tbody.innerHTML = `
      <tr><td class="table-empty" colspan="5">
        ${allPersons.length === 0
          ? 'Aucune fiche pilote. Cliquez sur « Nouvelle fiche ».'
          : 'Aucune fiche ne correspond a la recherche.'}
      </td></tr>`;
    return;
  }

  tbody.innerHTML = persons.map(p => `
    <tr>
      <td><strong>${escHtml(p.lastName || '')}</strong></td>
      <td>${escHtml(p.firstName || '')}</td>
      <td class="center">${p.licenseNumber ? escHtml(p.licenseNumber) : '<span class="text-muted">—</span>'}</td>
      <td class="center">${p.nationality ? escHtml(p.nationality) : '<span class="text-muted">—</span>'}</td>
      <td class="center">
        <button class="btn btn-ghost btn-sm prs-profile-btn" data-id="${p.id}" title="Stats globales">📊</button>
        <button class="btn btn-ghost btn-sm prs-edit-btn" data-id="${p.id}" title="Modifier">✏️</button>
        <button class="btn btn-danger btn-sm prs-delete-btn" data-id="${p.id}" title="Supprimer">🗑️</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.prs-profile-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const p = allPersons.find(x => x.id === btn.dataset.id);
      if (p) showPersonProfile(p);
    })
  );
  tbody.querySelectorAll('.prs-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEdit(btn.dataset.id))
  );
  tbody.querySelectorAll('.prs-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => deletePerson(btn.dataset.id))
  );
}

// ─────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────

function openAdd() {
  if (!requireAuth()) return;
  editingId = null;
  document.getElementById('prs-modal-title').textContent = 'Nouvelle fiche pilote';
  document.getElementById('prs-firstname').value = '';
  document.getElementById('prs-lastname').value = '';
  document.getElementById('prs-license').value = '';
  document.getElementById('prs-birthdate').value = '';
  document.getElementById('prs-nationality').value = '';
  document.getElementById('prs-team').value = '';
  document.getElementById('prs-notes').value = '';
  document.getElementById('prs-modal').classList.add('is-open');
  setTimeout(() => document.getElementById('prs-firstname')?.focus(), 50);
}

function openEdit(id) {
  if (!requireAuth()) return;
  const p = allPersons.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  document.getElementById('prs-modal-title').textContent = 'Modifier la fiche';
  document.getElementById('prs-firstname').value = p.firstName || '';
  document.getElementById('prs-lastname').value = p.lastName || '';
  document.getElementById('prs-license').value = p.licenseNumber || '';
  document.getElementById('prs-birthdate').value = p.birthDate || '';
  document.getElementById('prs-nationality').value = p.nationality || '';
  document.getElementById('prs-team').value = p.team || '';
  document.getElementById('prs-notes').value = p.notes || '';
  document.getElementById('prs-modal').classList.add('is-open');
}

function closeModal() {
  document.getElementById('prs-modal')?.classList.remove('is-open');
  editingId = null;
}

async function onSave() {
  const firstName = sanitize(document.getElementById('prs-firstname')?.value || '').trim();
  const lastName  = sanitize(document.getElementById('prs-lastname')?.value  || '').trim();

  if (!firstName || !lastName) {
    toast('Prenom et nom obligatoires', 'warning');
    return;
  }

  const data = {
    firstName,
    lastName,
    licenseNumber: sanitize(document.getElementById('prs-license')?.value || '').trim(),
    birthDate:     document.getElementById('prs-birthdate')?.value || '',
    nationality:   sanitize(document.getElementById('prs-nationality')?.value || '').trim(),
    team:          sanitize(document.getElementById('prs-team')?.value || '').trim(),
    notes:         sanitize(document.getElementById('prs-notes')?.value || '').trim(),
  };

  const ok = await savePerson(data);
  if (ok) closeModal();
}

// ─────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('prs-add-btn')?.addEventListener('click', openAdd);
  document.getElementById('prs-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('prs-modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('prs-modal-save')?.addEventListener('click', onSave);

  document.getElementById('prs-modal')?.addEventListener('click', e => {
    if (e.target.id === 'prs-modal') closeModal();
  });

  ['prs-firstname', 'prs-lastname', 'prs-license', 'prs-nationality', 'prs-team'].forEach(id => {
    document.getElementById(id)?.addEventListener('keypress', e => {
      if (e.key === 'Enter') onSave();
    });
  });

  document.getElementById('prs-filter')?.addEventListener('input', e => {
    filterText = e.target.value || '';
    renderTable();
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initPersons() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'persons') {
      renderView();
      loadPersons();
    }
  });
}
