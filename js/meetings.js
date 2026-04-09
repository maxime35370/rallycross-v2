/* ═══════════════════════════════════════════════
   MEETINGS.JS — Gestion des meetings
   CRUD + génération automatique des sessions Firestore
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, sanitize, formatDate, CATEGORIES } from './utils.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { getActiveChampionshipId, getActiveChampionship } from './context.js';

// ─────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────

const SESSION_TEMPLATES = [
  { type: 'EC',  label: 'Essais chronométrés',    tours: 1, order: 0 },
  { type: 'MQ',  label: 'Manche qualificative 1', tours: 4, order: 1, num: 1 },
  { type: 'MQ',  label: 'Manche qualificative 2', tours: 4, order: 2, num: 2 },
  { type: 'MQ',  label: 'Manche qualificative 3', tours: 4, order: 3, num: 3 },
  { type: 'MQ',  label: 'Manche qualificative 4', tours: 4, order: 4, num: 4 },
  { type: 'DF',  label: 'Demi-finale 1',          tours: 6, order: 5, num: 1 },
  { type: 'DF',  label: 'Demi-finale 2',          tours: 6, order: 6, num: 2 },
  { type: 'FIN', label: 'Finale',                 tours: 7, order: 7 },
];

const NB_MQ_OPTIONS = [1, 2, 3, 4];

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings  = [];
let unsubscribe  = null;
let editingId    = null;
let filterYear   = new Date().getFullYear();

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Génère le nom affiché d'un meeting depuis sa date et son lieu.
 */
function meetingName(meeting) {
  const d = meeting.date
    ? new Date(meeting.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '??/??/????';
  return `${d} — ${meeting.location || '?'}`;
}

/**
 * Formate une date ISO (YYYY-MM-DD) en dd/mm/yyyy.
 */
function isoToDisplay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — MEETINGS
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) { toast('Firebase non connecté', 'error'); return; }

  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  if (unsubscribe) unsubscribe();

  const champId = getActiveChampionshipId();
  const constraints = [
    where('year', '==', filterYear),
    orderBy('date', 'asc'),
  ];
  // Filtrer par championnat si un est selectionne
  if (champId) constraints.unshift(where('championshipId', '==', champId));

  const q = query(collection(db, 'meetings'), ...constraints);

  unsubscribe = onSnapshot(q, snap => {
    allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, err => {
    console.error(err);
    toast('Erreur de chargement des meetings', 'error');
  });
}

async function saveMeeting(data) {
  if (!db) { toast('Firebase non connecté', 'error'); return null; }
  if (!requireAuth()) return null;

  const { collection, doc, addDoc, updateDoc, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    if (editingId) {
      // Mise à jour uniquement les champs du meeting
      // (les sessions ne sont pas régénérées à l'édition,
      //  sauf si nbMQ change — géré séparément)
      const ref = doc(db, 'meetings', editingId);
      const existing = allMeetings.find(m => m.id === editingId);
      await updateDoc(ref, {
        date:       data.date,
        location:   data.location,
        year:       data.year,
        categories: data.categories,
        nbMQ:       data.nbMQ,
      });
      logAudit('update', 'meeting', editingId, { label: `${data.location} ${data.date}` });
      toast('Meeting modifié ✓', 'success');
      return editingId;

    } else {
      // Création du meeting (lie au championnat actif)
      const champId = getActiveChampionshipId();
      const meetRef = await addDoc(collection(db, 'meetings'), {
        ...data,
        championshipId: champId || null,
        createdAt: new Date(),
      });

      // Génération automatique des sessions dans un batch
      await generateSessions(meetRef.id, data);

      logAudit('create', 'meeting', meetRef.id, { label: `${data.location} ${data.date}` });
      toast('Meeting créé + sessions générées ✓', 'success');
      return meetRef.id;
    }
  } catch (err) {
    console.error(err);
    toast('Erreur lors de la sauvegarde', 'error');
    return null;
  }
}

/**
 * Génère les sessions Firestore pour un meeting.
 * Une session par type + par catégorie sélectionnée.
 */
async function generateSessions(meetingId, meetingData) {
  const { collection, writeBatch, doc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  const batch = writeBatch(db);
  const sessionsCol = collection(db, 'sessions');

  // Templates actifs selon nbMQ
  const activeTemplates = SESSION_TEMPLATES.filter(t => {
    if (t.type === 'MQ') return t.num <= meetingData.nbMQ;
    return true;
  });

  // Créer une session par template × catégorie
  meetingData.categories.forEach(category => {
    activeTemplates.forEach(tpl => {
      const ref = doc(sessionsCol);
      batch.set(ref, {
        meetingId,
        category,
        type:      tpl.type,
        label:     tpl.label,
        tours:     tpl.tours,
        order:     tpl.order,
        num:       tpl.num || null,
        year:      meetingData.year,
        status:    'pending',   // 'pending' | 'open' | 'closed'
        createdAt: new Date(),
      });
    });
  });

  await batch.commit();
}

async function deleteMeeting(id) {
  if (!db) return;
  if (!requireAuth()) return;

  const { doc, deleteDoc, collection, query, where, getDocs, writeBatch } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  if (!window.confirm('Supprimer ce meeting et TOUTES ses données associées ?\n\n• Sessions\n• Participants\n• Temps saisis\n• Engagements\n• Classements\n\nCette action est irréversible.')) return;

  try {
    // Collections à nettoyer par meetingId
    const collections = [
      'sessions',
      'sessionParticipants',
      'results',
      'engagements',
      'meetingStandings',
    ];

    for (const col of collections) {
      const snap = await getDocs(query(
        collection(db, col),
        where('meetingId', '==', id)
      ));
      if (!snap.empty) {
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }

    // Supprimer le meeting lui-même
    const meetData = allMeetings.find(m => m.id === id);
    await deleteDoc(doc(db, 'meetings', id));
    logAudit('delete', 'meeting', id, { label: meetData ? `${meetData.location} ${meetData.date}` : id });
    toast('Meeting et toutes ses données supprimés', 'warning');

  } catch (err) {
    console.error(err);
    toast('Erreur lors de la suppression', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  const view = document.getElementById('view-meetings');
  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📅 <span>Meetings</span></h2>
      <div class="section-actions">
        <button class="btn btn-primary" id="mtg-add-btn">＋ Créer un meeting</button>
      </div>
    </div>

    <!-- Filtre année -->
    <div class="toolbar">
      <select class="toolbar-select" id="mtg-filter-year">
        ${years.map(y => `
          <option value="${y}" ${y === filterYear ? 'selected' : ''}>${y}</option>
        `).join('')}
      </select>
      <span class="text-muted" id="mtg-counter" style="font-size:0.82rem;margin-left:auto"></span>
    </div>

    <!-- Tableau -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Circuit / Lieu</th>
            <th>Catégories</th>
            <th class="center">MQ</th>
            <th class="center">Sessions</th>
            <th class="center" style="width:100px">Actions</th>
          </tr>
        </thead>
        <tbody id="mtg-tbody"></tbody>
      </table>
    </div>

    <!-- Modal création / édition -->
    <div class="modal-backdrop" id="mtg-modal">
      <div class="modal" style="max-width:540px">
        <div class="modal-header">
          <span class="modal-title" id="mtg-modal-title">Créer un meeting</span>
          <button class="modal-close" id="mtg-modal-close">✕</button>
        </div>
        <div class="modal-body">

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="mtg-date">Date *</label>
              <input class="form-input" type="date" id="mtg-date">
            </div>
            <div class="form-group">
              <label class="form-label" for="mtg-year">Saison *</label>
              <select class="form-select" id="mtg-year">
                ${years.map(y => `
                  <option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>
                `).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="mtg-location">Circuit / Lieu *</label>
            <input class="form-input" type="text" id="mtg-location" maxlength="80"
              placeholder="Ex: Circuit de Lohéac">
          </div>

          <div class="form-group">
            <label class="form-label">
              Nombre de manches qualificatives
              <span class="text-muted">(4 par défaut)</span>
            </label>
            <div class="mtg-mq-selector" id="mtg-mq-selector">
              ${NB_MQ_OPTIONS.map(n => `
                <button type="button" class="mtg-mq-btn ${n === 4 ? 'is-active' : ''}" data-n="${n}">
                  ${n} MQ
                </button>
              `).join('')}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Côté Pole Position</label>
            <div class="mtg-pole-selector" id="mtg-pole-selector">
              <button type="button" class="mtg-pole-btn is-active" data-side="droite">
                ▶ Droite <span class="mtg-pole-hint">1er virage à droite</span>
              </button>
              <button type="button" class="mtg-pole-btn" data-side="gauche">
                ◀ Gauche <span class="mtg-pole-hint">1er virage à gauche</span>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">
              Catégories concernées *
              <span class="text-muted">(au moins une)</span>
            </label>
            <div class="mtg-cat-grid" id="mtg-cat-grid">
              ${CATEGORIES.map(cat => `
                <label class="mtg-cat-checkbox">
                  <input type="checkbox" value="${cat}" checked>
                  <span class="mtg-cat-label">${escHtml(cat)}</span>
                </label>
              `).join('')}
            </div>
          </div>

          <!-- Résumé des sessions qui seront créées -->
          <div class="mtg-sessions-preview card" id="mtg-sessions-preview">
            <div class="card-title">Sessions qui seront générées</div>
            <div id="mtg-preview-content"></div>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="mtg-modal-cancel">Annuler</button>
          <button class="btn btn-primary" id="mtg-modal-save">💾 Enregistrer</button>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  updateSessionsPreview();
  renderTable();
}

function renderTable() {
  const tbody   = document.getElementById('mtg-tbody');
  const counter = document.getElementById('mtg-counter');
  if (!tbody) return;

  if (counter) counter.textContent = `${allMeetings.length} meeting${allMeetings.length > 1 ? 's' : ''}`;

  if (allMeetings.length === 0) {
    tbody.innerHTML = `
      <tr><td class="table-empty" colspan="6">
        Aucun meeting pour ${filterYear}. Cliquez sur « Créer un meeting ».
      </td></tr>`;
    return;
  }

  tbody.innerHTML = allMeetings.map(m => {
    const cats = (m.categories || []).map(c => categoryBadgeSmall(c)).join(' ');
    const nbSessions = SESSION_TEMPLATES.filter(t =>
      t.type !== 'MQ' || (t.num <= (m.nbMQ || 4))
    ).length * (m.categories || []).length;

    return `
      <tr>
        <td><span class="mtg-date">${isoToDisplay(m.date)}</span></td>
        <td><strong>${escHtml(m.location)}</strong></td>
        <td><div class="mtg-cats">${cats}</div></td>
        <td class="center">
          <span class="mtg-mq-badge">${m.nbMQ || 4}</span>
        </td>
        <td class="center text-muted">${nbSessions}</td>
        <td class="center">
          <div style="display:flex;gap:4px;justify-content:center">
            <button class="btn btn-ghost btn-icon mtg-edit-btn" data-id="${m.id}" title="Modifier">✏️</button>
            <button class="btn btn-danger btn-icon mtg-del-btn" data-id="${m.id}" title="Supprimer">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('.mtg-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEdit(btn.dataset.id))
  );
  document.querySelectorAll('.mtg-del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteMeeting(btn.dataset.id))
  );
}

// ─────────────────────────────────────────────────────────
// PRÉVISUALISATION DES SESSIONS
// ─────────────────────────────────────────────────────────

function updateSessionsPreview() {
  const preview = document.getElementById('mtg-preview-content');
  if (!preview) return;

  const nbMQ = getSelectedNbMQ();
  const cats = getSelectedCategories();

  if (cats.length === 0) {
    preview.innerHTML = `<span class="text-muted" style="font-size:0.85rem">Sélectionnez au moins une catégorie.</span>`;
    return;
  }

  const activeTypes = SESSION_TEMPLATES.filter(t =>
    t.type !== 'MQ' || t.num <= nbMQ
  );
  const total = activeTypes.length * cats.length;

  preview.innerHTML = `
    <div class="mtg-preview-grid">
      ${cats.map(cat => `
        <div class="mtg-preview-cat">
          <div class="mtg-preview-cat-name">${categoryBadgeSmall(cat)}</div>
          <div class="mtg-preview-sessions">
            ${activeTypes.map(t => `
              <span class="mtg-preview-session mtg-preview-${t.type.toLowerCase()}">
                ${t.type === 'MQ' ? `MQ${t.num}` : t.type === 'DF' ? `DF${t.num}` : t.type}
              </span>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
    <div class="mtg-preview-total">
      Total : <strong>${total} session${total > 1 ? 's' : ''}</strong>
      (${activeTypes.length} types × ${cats.length} catégorie${cats.length > 1 ? 's' : ''})
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// HELPERS MODAL
// ─────────────────────────────────────────────────────────

function getSelectedNbMQ() {
  const active = document.querySelector('.mtg-mq-btn.is-active');
  return active ? parseInt(active.dataset.n) : 4;
}

function getSelectedCategories() {
  return Array.from(
    document.querySelectorAll('#mtg-cat-grid input[type=checkbox]:checked')
  ).map(cb => cb.value);
}

function setNbMQ(n) {
  // Boutons côté pole
  document.querySelectorAll('.mtg-pole-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mtg-pole-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  document.querySelectorAll('.mtg-mq-btn').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.n) === n);
  });
  updateSessionsPreview();
}

function categoryBadgeSmall(cat) {
  const map = {
    'Supercar':   'badge-supercar',
    'Super1600':  'badge-super1600',
    'Division 5': 'badge-d5',
    'Féminines':  'badge-feminines',
    'D3':         'badge-d3',
    'D4':         'badge-d4',
  };
  const cls = map[cat] || 'badge-d4';
  return `<span class="badge ${cls}">${escHtml(cat)}</span>`;
}

// ─────────────────────────────────────────────────────────
// MODAL OPEN / CLOSE
// ─────────────────────────────────────────────────────────

function openAdd() {
  editingId = null;
  document.getElementById('mtg-modal-title').textContent = 'Créer un meeting';
  document.getElementById('mtg-date').value     = new Date().toISOString().split('T')[0];
  document.getElementById('mtg-location').value = '';
  document.getElementById('mtg-year').value     = String(filterYear);

  // Tout cocher par défaut
  document.querySelectorAll('#mtg-cat-grid input[type=checkbox]')
    .forEach(cb => cb.checked = true);

  setNbMQ(4);
  updateSessionsPreview();

  // Afficher le preview (masqué en édition)
  const preview = document.getElementById('mtg-sessions-preview');
  if (preview) preview.style.display = '';

  document.getElementById('mtg-modal').classList.add('is-open');
  document.getElementById('mtg-location').focus();
}

function openEdit(id) {
  const m = allMeetings.find(x => x.id === id);
  if (!m) return;

  editingId = id;
  document.getElementById('mtg-modal-title').textContent = 'Modifier le meeting';
  document.getElementById('mtg-date').value     = m.date     || '';
  document.getElementById('mtg-location').value = m.location || '';
  document.getElementById('mtg-year').value     = String(m.year);

  // Cocher les catégories du meeting
  document.querySelectorAll('#mtg-cat-grid input[type=checkbox]').forEach(cb => {
    cb.checked = (m.categories || []).includes(cb.value);
  });

  setNbMQ(m.nbMQ || 4);

  // Masquer le preview en édition (les sessions existent déjà)
  const preview = document.getElementById('mtg-sessions-preview');
  if (preview) preview.style.display = 'none';

  document.getElementById('mtg-modal').classList.add('is-open');
  document.getElementById('mtg-location').focus();
}

function closeModal() {
  document.getElementById('mtg-modal').classList.remove('is-open');
  editingId = null;
}

// ─────────────────────────────────────────────────────────
// SAUVEGARDE
// ─────────────────────────────────────────────────────────

async function onSave() {
  const date     = document.getElementById('mtg-date').value;
  const location = sanitize(document.getElementById('mtg-location').value, 80);
  const year     = parseInt(document.getElementById('mtg-year').value);
  const nbMQ     = getSelectedNbMQ();
  const cats     = getSelectedCategories();

  if (!date)          { toast('Date obligatoire', 'error'); return; }
  if (!location)      { toast('Lieu / circuit obligatoire', 'error'); return; }
  if (cats.length === 0) { toast('Sélectionnez au moins une catégorie', 'error'); return; }

  const poleSide = document.querySelector('.mtg-pole-btn.is-active')?.dataset.side || 'droite';
  const data = { date, location, year, nbMQ, categories: cats, poleSide };

  const btn = document.getElementById('mtg-modal-save');
  btn.disabled = true;
  btn.textContent = '⏳ Enregistrement…';

  const id = await saveMeeting(data);

  btn.disabled = false;
  btn.textContent = '💾 Enregistrer';

  if (id) closeModal();
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('mtg-add-btn')
    ?.addEventListener('click', openAdd);

  document.getElementById('mtg-modal-close')
    ?.addEventListener('click', closeModal);
  document.getElementById('mtg-modal-cancel')
    ?.addEventListener('click', closeModal);
  document.getElementById('mtg-modal')
    ?.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  document.getElementById('mtg-modal-save')
    ?.addEventListener('click', onSave);

  document.getElementById('mtg-filter-year')?.addEventListener('change', e => {
    filterYear = parseInt(e.target.value);
    loadMeetings();
  });

  // Sélecteur nombre MQ
  // Boutons côté pole
  document.querySelectorAll('.mtg-pole-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mtg-pole-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  document.querySelectorAll('.mtg-mq-btn').forEach(btn => {
    btn.addEventListener('click', () => setNbMQ(parseInt(btn.dataset.n)));
  });

  // Cases catégories → mise à jour préview
  document.querySelectorAll('#mtg-cat-grid input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', updateSessionsPreview);
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initMeetings() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'meetings') {
      renderView();
      loadMeetings();
    }
  });
}