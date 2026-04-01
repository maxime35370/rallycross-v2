/* ═══════════════════════════════════════════════
   MEETINGS.JS — Gestion des meetings
   CRUD + génération automatique des sessions Firestore
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, sanitize, formatDate, CATEGORIES } from './utils.js';

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

  const q = query(
    collection(db, 'meetings'),
    where('year', '==', filterYear),
    orderBy('date', 'asc')
  );

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
      toast('Meeting modifié ✓', 'success');
      return editingId;

    } else {
      // Création du meeting
      const meetRef = await addDoc(collection(db, 'meetings'), {
        ...data,
        createdAt: new Date(),
      });

      // Génération automatique des sessions dans un batch
      await generateSessions(meetRef.id, data);

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
    await deleteDoc(doc(db, 'meetings', id));
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
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('meetings-styles')) return;
  const style = document.createElement('style');
  style.id = 'meetings-styles';
  style.textContent = `
    .mtg-date { font-family: var(--font-condensed); font-size: 0.95rem; font-weight: 600; }
    .mtg-cats { display: flex; flex-wrap: wrap; gap: 3px; }
    .mtg-mq-badge {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--clr-accent-dim); border: 1px solid var(--clr-accent);
      border-radius: var(--r-sm);
      font-family: var(--font-display); font-size: 0.82rem; font-weight: 700;
      color: var(--clr-accent-2);
    }

    /* Sélecteur nb MQ */
    .mtg-pole-selector { display: flex; gap: var(--sp-sm); margin-top: var(--sp-xs); }
    .mtg-pole-btn {
      flex: 1; padding: 10px var(--sp-sm);
      background: var(--clr-surface); border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md); color: var(--clr-text-2);
      font-size: 0.88rem; font-weight: 600; cursor: pointer;
      transition: all var(--tr-fast); text-align: center;
    }
    .mtg-pole-btn.is-active { background: var(--clr-accent-dim); border-color: var(--clr-accent); color: var(--clr-accent-2); }
    .mtg-pole-hint { display: block; font-size: 0.72rem; color: var(--clr-text-3); font-weight: 400; margin-top: 2px; }
    .mtg-pole-btn.is-active .mtg-pole-hint { color: var(--clr-accent); }

    .mtg-mq-selector {
      display: flex; gap: var(--sp-sm);
    }
    .mtg-mq-btn {
      flex: 1;
      padding: 8px;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md);
      color: var(--clr-text-2);
      font-family: var(--font-condensed);
      font-size: 0.9rem; font-weight: 600;
      cursor: pointer;
      transition: all var(--tr-fast);
    }
    .mtg-mq-btn:hover  { border-color: var(--clr-accent); color: var(--clr-text); }
    .mtg-mq-btn.is-active {
      background: var(--clr-accent-dim);
      border-color: var(--clr-accent);
      color: var(--clr-accent-2);
    }

    /* Checkboxes catégories */
    .mtg-cat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--sp-sm);
    }
    .mtg-cat-checkbox {
      display: flex; align-items: center; gap: var(--sp-sm);
      padding: 8px 10px;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-md);
      cursor: pointer;
      transition: all var(--tr-fast);
    }
    .mtg-cat-checkbox:hover { border-color: var(--clr-accent); }
    .mtg-cat-checkbox input[type=checkbox] { accent-color: var(--clr-accent); width: 15px; height: 15px; }
    .mtg-cat-label { font-size: 0.88rem; font-weight: 500; }

    /* Preview sessions */
    .mtg-sessions-preview { margin-top: var(--sp-md); }
    .mtg-preview-grid { display: flex; flex-direction: column; gap: var(--sp-sm); margin-bottom: var(--sp-sm); }
    .mtg-preview-cat { display: flex; align-items: center; gap: var(--sp-sm); flex-wrap: wrap; }
    .mtg-preview-cat-name { min-width: 80px; }
    .mtg-preview-sessions { display: flex; gap: 4px; flex-wrap: wrap; }
    .mtg-preview-session {
      padding: 2px 7px;
      border-radius: 4px;
      font-family: var(--font-condensed);
      font-size: 0.72rem; font-weight: 700;
      letter-spacing: 0.05em;
    }
    .mtg-preview-ec  { background: var(--clr-info-dim);    color: var(--clr-info); }
    .mtg-preview-mq  { background: var(--clr-warning-dim); color: var(--clr-warning); }
    .mtg-preview-df  { background: rgba(255,119,48,0.18);  color: #ff7730; }
    .mtg-preview-fin { background: var(--clr-accent-dim);  color: var(--clr-accent); }
    .mtg-preview-total {
      font-size: 0.82rem; color: var(--clr-text-3);
      border-top: 1px solid var(--clr-border);
      padding-top: var(--sp-sm); margin-top: var(--sp-xs);
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initMeetings() {
  injectStyles();
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'meetings') {
      renderView();
      loadMeetings();
    }
  });
}