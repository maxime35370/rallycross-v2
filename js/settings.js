/* ═══════════════════════════════════════════════
   SETTINGS.JS — Gestion des championnats
   Réglages : catégories, sessions, barème de points
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { logAudit } from './audit.js';
import { requireAuth } from './auth.js';
import { loadChampionships, renderChampionshipSelector } from './context.js';

async function refreshHeaderSelector() {
  await loadChampionships();
  renderChampionshipSelector();
}
import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// TEMPLATE PAR DÉFAUT
// ─────────────────────────────────────────────────────────

const DEFAULT_CHAMP = {
  name:       'Championnat FFSA Rallycross 2026',
  year:       2026,
  regulation: 'FFSA 2026',
  isActive:   true,

  // Catégories et plages de numéros — règlement FFSA
  categories: [
    { id: 'Supercar',   name: 'Supercar',   freeNumbers: false, carNumberRanges: [{ min: 1,   max: 99  }] },
    { id: 'Super1600',  name: 'Super 1600', freeNumbers: false, carNumberRanges: [{ min: 101, max: 199 }] },
    { id: 'Division 5', name: 'Division 5', freeNumbers: false, carNumberRanges: [{ min: 201, max: 249 }] },
    { id: 'Féminines',  name: 'Féminines',  freeNumbers: false, carNumberRanges: [{ min: 251, max: 299 }] },
    { id: 'D3',         name: 'D3',         freeNumbers: false, carNumberRanges: [{ min: 301, max: 399 }] },
    { id: 'D4',         name: 'D4',         freeNumbers: false, carNumberRanges: [{ min: 401, max: 499 }] },
  ],

  // Nombre de tours par type de session — règlement FFSA
  sessionConfig: {
    EC:  { laps: 1 },          // Essais chrono : meilleur tour (1 seul chronométré)
    MQ:  { laps: 4, count: 4 }, // 4 manches qualificatives de 4 tours
    DF:  { laps: 6 },           // Demi-finales : 6 tours
    FIN: { laps: 7 },           // Finale : 7 tours
  },

  // Barème de points — règlement FFSA 2026
  // MQ : 1er=50, 2e=45, 3e=42, puis 44-position (formule)
  //      + bonus EC top 5 : +5/+4/+3/+2/+1 (géré dans calc.js, pas ici)
  // DF  : 10/8/6/5/4/3/2/1
  // FIN : 15/12/9/7/6/5/4/3
  pointsScale: {
    MQ: {
      formula:   '44 - position',   // Formule de base pour positions 4+
      overrides: {                  // Exceptions pour le podium
        1: 50,
        2: 45,
        3: 42,
      },
    },
    DF: {
      formula:   null,
      overrides: { 1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 },
    },
    FIN: {
      formula:   null,
      overrides: { 1: 15, 2: 12, 3: 9, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3 },
    },
  },

  worstResultDrop: 0,  // Pas de déduction de pire résultat en FFSA par défaut

  // Règles de points pour les statuts spéciaux
  // mode 'engaged_offset' : points = barème(nbEngagés + offset)
  //   ex : 35 engagés, offset=1 → DNF reçoit les points de la 36e place
  // mode 'fixed'          : valeur fixe, indépendante du nombre de pilotes
  statusRules: {
    DNF: {
      mode:   'engaged_offset',
      offset: 1,
    },
    DNS: {
      mode:   'fixed',
      points: 0,
    },
    DSQ_RACE: {
      mode:   'fixed',
      points: 0,
    },
    DSQ: {
      mode:   'fixed',
      points: 0,
    },
  },
};

// ─────────────────────────────────────────────────────────
// CHAMPS DU REGLEMENT (extraits pour reutilisation)
// ─────────────────────────────────────────────────────────

const REGULATION_FIELDS = ['categories', 'sessionConfig', 'pointsScale', 'worstResultDrop', 'statusRules'];

function extractRegulation(data) {
  const reg = {};
  REGULATION_FIELDS.forEach(k => { if (data[k] !== undefined) reg[k] = JSON.parse(JSON.stringify(data[k])); });
  return reg;
}

function applyRegulation(target, regulation) {
  REGULATION_FIELDS.forEach(k => { if (regulation[k] !== undefined) target[k] = JSON.parse(JSON.stringify(regulation[k])); });
}

// ─────────────────────────────────────────────────────────
// HELPERS REGLEMENTS (Firestore)
// ─────────────────────────────────────────────────────────

async function loadReglements() {
  if (!db) return [];
  try {
    const { collection, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await getDocs(collection(db, 'reglements'));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return list;
  } catch (e) {
    console.error('loadReglements:', e);
    return [];
  }
}

async function saveReglement(id, name, data) {
  if (!db) return null;
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const regId = id || `reg_${Date.now()}`;
  const payload = { name, ...extractRegulation(data), updatedAt: new Date() };
  if (!id) payload.createdAt = new Date();
  await setDoc(doc(db, 'reglements', regId), payload);
  logAudit(id ? 'update' : 'create', 'reglement', regId, { label: name });
  return regId;
}

async function deleteReglement(regId, name) {
  if (!db) return;
  const { doc, deleteDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await deleteDoc(doc(db, 'reglements', regId));
  logAudit('delete', 'reglement', regId, { label: name });
}

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let _editingChamp        = null;   // null = liste | 'new' | id existant
let _editData            = null;   // copie de travail
let _activeTab           = 'general';
let _activePointsSession = 'MQ';
let _reglements          = [];     // cache des reglements disponibles

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initSettings() {
  document.addEventListener('viewchange', ({ detail }) => {
    if (detail.view === 'settings') {
      _editingChamp = null;
      renderSettingsList();
    }
  });
}

// ─────────────────────────────────────────────────────────
// VUE LISTE
// ─────────────────────────────────────────────────────────

async function renderSettingsList() {
  const container = document.getElementById('view-settings');
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div> Chargement…</div>`;

  if (!db) {
    container.innerHTML = `
      <div class="settings-page">
        <div class="settings-empty">
          <span class="settings-empty-icon">⚙️</span>
          <p>Firebase non configuré.<br>Rendez-vous dans <strong>Configuration</strong> d'abord.</p>
        </div>
      </div>`;
    return;
  }

  let champs = [];
  try {
    const { collection, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await getDocs(collection(db, 'championships'));
    snap.forEach(d => champs.push({ id: d.id, ...d.data() }));
    champs.sort((a, b) => (b.year - a.year) || (a.name || '').localeCompare(b.name || ''));
  } catch (e) {
    console.error('Settings – erreur chargement :', e);
  }

  _reglements = await loadReglements();

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <div class="settings-header-left">
          <h2 class="settings-title">⚙️ Réglages Championnats</h2>
          <span class="settings-count">${champs.length} championnat${champs.length > 1 ? 's' : ''}</span>
        </div>
        <button class="btn btn-primary" id="btn-new-champ">＋ Nouveau championnat</button>
      </div>

      <div class="champ-list" id="champ-list">
        ${champs.length === 0
          ? `<div class="settings-empty">
               <span class="settings-empty-icon">🏆</span>
               <p>Aucun championnat configuré.<br>Créez le premier !</p>
             </div>`
          : champs.map(c => renderChampCard(c)).join('')
        }
      </div>

      <!-- Section Reglements -->
      <div class="settings-header" style="margin-top:var(--sp-xl)">
        <div class="settings-header-left">
          <h2 class="settings-title">📋 Reglements reutilisables</h2>
          <span class="settings-count">${_reglements.length} reglement${_reglements.length > 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="champ-list" id="reg-list">
        ${_reglements.length === 0
          ? `<div class="settings-empty" style="padding:var(--sp-lg)">
               <p class="text-muted" style="font-size:0.88rem">Aucun reglement sauvegarde.<br>
               Creez un championnat puis utilisez "Sauvegarder comme reglement" dans l'editeur.</p>
             </div>`
          : _reglements.map(r => `
            <div class="champ-card">
              <div class="champ-card-body">
                <div class="champ-card-info">
                  <div class="champ-card-name">📋 ${escHtml(r.name || '—')}</div>
                  <div class="champ-card-meta">
                    <span class="champ-card-reg">${(r.categories || []).length} categories</span>
                  </div>
                </div>
                <div class="champ-card-actions">
                  <button class="btn btn-danger btn-icon reg-delete"
                    data-id="${r.id}" data-name="${escHtml(r.name)}" title="Supprimer">🗑️</button>
                </div>
              </div>
            </div>
          `).join('')
        }
      </div>
    </div>
  `;

  document.getElementById('btn-new-champ')
    ?.addEventListener('click', () => openEditor('new'));

  container.querySelectorAll('.champ-card-edit').forEach(btn =>
    btn.addEventListener('click', () => openEditor(btn.dataset.id)));

  container.querySelectorAll('.champ-card-duplicate').forEach(btn =>
    btn.addEventListener('click', () => duplicateChamp(btn.dataset.id, champs)));

  container.querySelectorAll('.champ-card-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteChamp(btn.dataset.id, btn.dataset.name)));

  container.querySelectorAll('.reg-delete').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Supprimer le reglement "${btn.dataset.name}" ?`)) return;
      await deleteReglement(btn.dataset.id, btn.dataset.name);
      toast('Reglement supprime', 'warning');
      renderSettingsList();
    }));
}

function renderChampCard(c) {
  const cats = (c.categories || []).map(cat =>
    `<span class="champ-cat-pill">${escHtml(cat.name || cat.id)}</span>`
  ).join('');

  return `
    <div class="champ-card ${c.isActive ? 'champ-card--active' : ''}">
      <div class="champ-card-status-bar"></div>
      <div class="champ-card-body">
        <div class="champ-card-info">
          <div class="champ-card-name">${escHtml(c.name || '—')}</div>
          <div class="champ-card-meta">
            <span class="champ-card-year">📅 ${c.year}</span>
            ${c.regulation ? `<span class="champ-card-reg">📋 ${escHtml(c.regulation)}</span>` : ''}
            ${c.reglementId ? `<span class="champ-card-reg" style="color:var(--clr-success)">🔗 Reglement lie</span>` : ''}
            <span class="champ-status ${c.isActive ? 'champ-status--active' : 'champ-status--inactive'}">
              ${c.isActive ? '● Actif' : '○ Inactif'}
            </span>
          </div>
          <div class="champ-card-cats">${cats}</div>
        </div>
        <div class="champ-card-actions">
          <button class="btn btn-ghost btn-icon champ-card-edit"
            data-id="${c.id}" title="Modifier">✏️</button>
          <button class="btn btn-ghost btn-icon champ-card-duplicate"
            data-id="${c.id}" title="Dupliquer">📋</button>
          <button class="btn btn-danger btn-icon champ-card-delete"
            data-id="${c.id}" data-name="${escHtml(c.name)}" title="Supprimer">🗑️</button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// OUVERTURE ÉDITEUR
// ─────────────────────────────────────────────────────────

async function openEditor(champId) {
  _editingChamp        = champId;
  _activeTab           = 'general';
  _activePointsSession = 'MQ';

  if (champId === 'new') {
    _editData = JSON.parse(JSON.stringify(DEFAULT_CHAMP));
  } else {
    if (!db) { toast('Firebase non connecté', 'error'); return; }
    const { doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const snap = await getDoc(doc(db, 'championships', champId));
    if (!snap.exists()) { toast('Championnat introuvable', 'error'); return; }
    const saved = snap.data();
    _editData = {
      ...JSON.parse(JSON.stringify(DEFAULT_CHAMP)),
      ...saved,
      sessionConfig: { ...DEFAULT_CHAMP.sessionConfig, ...(saved.sessionConfig || {}) },
      pointsScale:   { ...DEFAULT_CHAMP.pointsScale,   ...(saved.pointsScale   || {}) },
    };
  }

  renderEditor();
}

// ─────────────────────────────────────────────────────────
// ÉDITEUR 4 ONGLETS
// ─────────────────────────────────────────────────────────

function renderEditor() {
  const container = document.getElementById('view-settings');
  const isNew = _editingChamp === 'new';

  const TAB_LABELS = {
    general:    '⚙️ Général',
    categories: '🏷️ Catégories',
    sessions:   '⏱️ Sessions',
    points:     '🏆 Barème',
  };

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <button class="btn btn-secondary" id="btn-back-list">← Retour</button>
        <h2 class="settings-title">${isNew ? '＋ Nouveau championnat' : `✏️ ${escHtml(_editData.name || 'Championnat')}`}</h2>
        <button class="btn btn-secondary btn-sm" id="btn-save-as-reg">📋 Sauvegarder comme reglement</button>
        <button class="btn btn-primary" id="btn-save-champ">💾 Enregistrer</button>
      </div>

      <div class="editor-tabs-bar">
        ${Object.entries(TAB_LABELS).map(([tab, label]) => `
          <button class="editor-tab ${_activeTab === tab ? 'is-active' : ''}" data-tab="${tab}">
            ${label}
          </button>
        `).join('')}
      </div>

      <div class="editor-content" id="editor-content">
        ${renderTabContent()}
      </div>
    </div>
  `;

  document.getElementById('btn-back-list')?.addEventListener('click', () => {
    syncCurrentTabToData();
    renderSettingsList();
  });
  document.getElementById('btn-save-champ')?.addEventListener('click', saveChamp);
  document.getElementById('btn-save-as-reg')?.addEventListener('click', onSaveAsReglement);

  document.querySelectorAll('.editor-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      syncCurrentTabToData();
      _activeTab = btn.dataset.tab;
      document.querySelectorAll('.editor-tab').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      document.getElementById('editor-content').innerHTML = renderTabContent();
      bindTabEvents();
    });
  });

  bindTabEvents();
}

function renderTabContent() {
  switch (_activeTab) {
    case 'general':    return renderTabGeneral();
    case 'categories': return renderTabCategories();
    case 'sessions':   return renderTabSessions();
    case 'points':     return renderTabPoints();
    default: return '';
  }
}

// ─────────────────────────────────────────────────────────
// ONGLET GÉNÉRAL
// ─────────────────────────────────────────────────────────

function renderTabGeneral() {
  const regOptions = _reglements.map(r =>
    `<option value="${r.id}" ${_editData.reglementId === r.id ? 'selected' : ''}>${escHtml(r.name)}</option>`
  ).join('');

  const linkedReg = _reglements.find(r => r.id === _editData.reglementId);

  return `
    <div class="tab-panel">
      <div class="form-row">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Nom du championnat *</label>
          <input class="form-input" id="f-name" type="text"
            placeholder="ex : Championnat de France RX 2026"
            value="${escHtml(_editData.name || '')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Annee *</label>
          <input class="form-input" id="f-year" type="number"
            min="2000" max="2099" value="${_editData.year || new Date().getFullYear()}">
        </div>
        <div class="form-group">
          <label class="form-label">Reglement / Reference</label>
          <input class="form-input" id="f-regulation" type="text"
            placeholder="ex : FFSA 2026"
            value="${escHtml(_editData.regulation || '')}">
        </div>
      </div>

      <!-- Selecteur de reglement -->
      <div class="form-group" style="margin-top:var(--sp-md);padding:var(--sp-md);background:var(--clr-bg-3);border-radius:var(--r-lg);border:1px solid var(--clr-border)">
        <label class="form-label">📋 Charger un reglement existant</label>
        <div style="display:flex;gap:var(--sp-sm);align-items:center;flex-wrap:wrap">
          <select class="form-select" id="f-reglement-select" style="flex:1;min-width:200px">
            <option value="">— Reglement personnalise —</option>
            ${regOptions}
          </select>
          <button class="btn btn-secondary btn-sm" id="f-load-reglement">Charger</button>
        </div>
        ${linkedReg ? `<div class="text-muted" style="font-size:0.82rem;margin-top:var(--sp-xs)">
          Lie au reglement : <strong style="color:var(--clr-accent-2)">${escHtml(linkedReg.name)}</strong>
          — Les onglets Categories, Sessions et Bareme utilisent ce reglement.
        </div>` : `<div class="text-muted" style="font-size:0.82rem;margin-top:var(--sp-xs)">
          Selectionnez un reglement pour pre-remplir les onglets Categories, Sessions et Bareme.
        </div>`}
      </div>

      <div class="form-group">
        <label class="form-label">Statut</label>
        <label class="settings-toggle">
          <input type="checkbox" id="f-active" ${_editData.isActive ? 'checked' : ''}>
          <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
          <span id="f-active-text" style="font-size:0.9rem;font-weight:500;margin-left:4px">
            ${_editData.isActive ? 'Actif' : 'Inactif'}
          </span>
        </label>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ONGLET CATÉGORIES
// ─────────────────────────────────────────────────────────

function renderTabCategories() {
  const cats = _editData.categories || [];
  return `
    <div class="tab-panel">
      <div class="settings-section-header">
        <span class="settings-section-title">Catégories du championnat</span>
        <button class="btn btn-secondary btn-sm" id="btn-add-cat">＋ Ajouter une catégorie</button>
      </div>
      <div id="cats-list">
        ${cats.length === 0
          ? `<div class="cats-empty text-muted" style="text-align:center;padding:var(--sp-xl);border:2px dashed var(--clr-border-2);border-radius:var(--r-lg)">
               Aucune catégorie. Cliquez sur ＋ pour en ajouter.
             </div>`
          : cats.map((cat, i) => renderCatRow(cat, i)).join('')}
      </div>
    </div>
  `;
}

function renderCatRow(cat, i) {
  const ranges = (cat.carNumberRanges || []).map((r, ri) =>
    renderRangeRow(i, ri, r)
  ).join('');

  return `
    <div class="cat-row" data-cat-idx="${i}">
      <div class="cat-row-header">
        <input class="form-input cat-id" placeholder="ID (SC, S1600…)"
          style="width:120px;flex-shrink:0"
          value="${escHtml(cat.id || '')}" data-field="id">
        <input class="form-input cat-name" placeholder="Nom affiché"
          style="flex:1"
          value="${escHtml(cat.name || '')}" data-field="name">
        <label class="settings-toggle settings-toggle--sm" style="flex-shrink:0">
          <input type="checkbox" class="cat-free-numbers" ${cat.freeNumbers ? 'checked' : ''}>
          <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
          <span style="font-size:0.8rem;margin-left:4px">N° libres</span>
        </label>
        <button class="btn btn-danger btn-icon cat-remove" data-idx="${i}" title="Supprimer la catégorie">🗑️</button>
      </div>

      <div class="cat-ranges" style="padding-top:var(--sp-sm);padding-left:var(--sp-sm)">
        ${cat.freeNumbers
          ? `<span class="text-muted" style="font-size:0.82rem">✓ Numéros libres — aucune restriction de plage</span>`
          : `${ranges}
             <button class="btn btn-ghost btn-sm cat-add-range" data-idx="${i}" style="margin-top:var(--sp-xs)">＋ Ajouter une plage</button>`
        }
      </div>
    </div>
  `;
}

function renderRangeRow(catIdx, rangeIdx, range) {
  return `
    <div class="range-row" data-range-idx="${rangeIdx}">
      <span style="font-size:0.82rem;color:var(--clr-text-3)">De</span>
      <input class="form-input range-min" type="number" min="1" max="9999"
        style="width:72px;padding:5px 8px;text-align:center"
        value="${range.min ?? 1}" data-cat="${catIdx}" data-range="${rangeIdx}">
      <span style="font-size:0.82rem;color:var(--clr-text-3)">à</span>
      <input class="form-input range-max" type="number" min="1" max="9999"
        style="width:72px;padding:5px 8px;text-align:center"
        value="${range.max ?? 999}" data-cat="${catIdx}" data-range="${rangeIdx}">
      <button class="btn btn-ghost btn-icon range-remove"
        data-cat="${catIdx}" data-range="${rangeIdx}" title="Supprimer"
        style="width:26px;height:26px;font-size:0.75rem">✕</button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ONGLET SESSIONS
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// EDITEUR DE GRILLE — lignes x couloirs, entierement libre
// ─────────────────────────────────────────────────────────

function defaultGridLayout(gridSize, lanes, rows) {
  const positions = {};
  let pos = 1;
  for (let r = 0; r < rows && pos <= gridSize; r++) {
    for (let c = 0; c < lanes && pos <= gridSize; c++) {
      positions[r + '-' + c] = pos++;
    }
  }
  return { lanes: lanes, rows: rows, positions: positions };
}

function renderGridEditor(layout, prefix) {
  const lanes = layout?.lanes || 5;
  const rows  = layout?.rows  || 3;
  const pos   = layout?.positions || {};

  var html = '<table class="grid-editor-table"><thead><tr><th></th>';
  for (var c = 0; c < lanes; c++) {
    html += '<th>C' + (c + 1) + '</th>';
  }
  html += '</tr></thead><tbody>';

  for (var r = 0; r < rows; r++) {
    html += '<tr><td class="grid-editor-row-label">L' + (r + 1) + '</td>';
    for (var c2 = 0; c2 < lanes; c2++) {
      var key = r + '-' + c2;
      var val = pos[key] || '';
      var hasVal = val !== '';
      html += '<td><button class="grid-cell' + (hasVal ? ' grid-cell--filled' : '') + '" ' +
        'data-prefix="' + prefix + '" data-row="' + r + '" data-col="' + c2 + '">' +
        (hasVal ? val : '') +
        '</button></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function getNextGridPosition(prefix) {
  var cells = document.querySelectorAll('.grid-cell[data-prefix="' + prefix + '"]');
  var used = new Set();
  cells.forEach(function(btn) {
    var v = parseInt(btn.textContent);
    if (!isNaN(v)) used.add(v);
  });
  for (var i = 1; i <= 30; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

function bindGridCells(prefix) {
  document.querySelectorAll('.grid-cell[data-prefix="' + prefix + '"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.textContent.trim()) {
        btn.textContent = '';
        btn.classList.remove('grid-cell--filled');
      } else {
        var next = getNextGridPosition(prefix);
        if (next !== null) {
          btn.textContent = next;
          btn.classList.add('grid-cell--filled');
        }
      }
    });
  });
}

function readGridLayout(prefix) {
  var lanesInput = document.getElementById('sc-' + prefix + '-lanes');
  var rowsInput  = document.getElementById('sc-' + prefix + '-rows');
  var lanes = parseInt(lanesInput?.value) || 5;
  var rows  = parseInt(rowsInput?.value)  || 3;
  var positions = {};
  document.querySelectorAll('.grid-cell[data-prefix="' + prefix + '"]').forEach(function(btn) {
    var val = parseInt(btn.textContent);
    if (!isNaN(val)) {
      positions[btn.dataset.row + '-' + btn.dataset.col] = val;
    }
  });
  return { lanes: lanes, rows: rows, positions: positions };
}

function renderTabSessions() {
  const sc = _editData.sessionConfig || {};
  const ecEnabled = sc.EC?.enabled !== false;
  const dfCount   = sc.DF?.count ?? 2;
  const dfGrid    = sc.DF?.gridSize ?? 8;
  const finGrid   = sc.FIN?.gridSize ?? 8;
  const dfLayout  = sc.DF?.gridLayout  || defaultGridLayout(dfGrid, 5, 3);
  const finLayout = sc.FIN?.gridLayout || defaultGridLayout(finGrid, 5, 3);

  return `
    <div class="tab-panel">
      <div class="session-config-grid">

        <!-- EC -->
        <div class="session-config-card ${ecEnabled ? '' : 'session-config-card--disabled'}">
          <div class="session-config-label" style="display:flex;align-items:center;gap:var(--sp-sm)">
            <span class="badge badge-ec">EC</span> Essais Chronom\u00e9tr\u00e9s
            <label class="settings-toggle settings-toggle--sm" style="margin-left:auto">
              <input type="checkbox" id="sc-ec-enabled" ${ecEnabled ? 'checked' : ''}>
              <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
            </label>
          </div>
          <div id="sc-ec-fields" style="${ecEnabled ? '' : 'opacity:0.35;pointer-events:none'}">
            <div class="settings-form-row">
              <label class="form-label">Tours par session</label>
              <input class="form-input" id="sc-ec-laps" type="number"
                min="1" max="30" style="width:70px;text-align:center"
                value="${sc.EC?.laps ?? 2}">
            </div>
          </div>
        </div>

        <!-- MQ -->
        <div class="session-config-card">
          <div class="session-config-label"><span class="badge badge-mq">MQ</span> Manches Qualificatives</div>
          <div class="settings-form-row">
            <label class="form-label">Nombre de MQ par meeting</label>
            <input class="form-input" id="sc-mq-count" type="number"
              min="1" max="8" style="width:70px;text-align:center"
              value="${sc.MQ?.count ?? 2}">
          </div>
          <div class="settings-form-row">
            <label class="form-label">Tours par manche</label>
            <input class="form-input" id="sc-mq-laps" type="number"
              min="1" max="30" style="width:70px;text-align:center"
              value="${sc.MQ?.laps ?? 4}">
          </div>
        </div>

        <!-- DF -->
        <div class="session-config-card">
          <div class="session-config-label"><span class="badge badge-df">DF</span> Demi-Finales</div>
          <div class="settings-form-row">
            <label class="form-label">Nombre de demi-finales</label>
            <input class="form-input" id="sc-df-count" type="number"
              min="1" max="4" style="width:70px;text-align:center"
              value="${dfCount}">
          </div>
          <div class="settings-form-row">
            <label class="form-label">Tours par manche</label>
            <input class="form-input" id="sc-df-laps" type="number"
              min="1" max="30" style="width:70px;text-align:center"
              value="${sc.DF?.laps ?? 6}">
          </div>
          <div class="settings-form-row">
            <label class="form-label">Pilotes par grille</label>
            <input class="form-input" id="sc-df-grid" type="number"
              min="2" max="20" style="width:70px;text-align:center"
              value="${dfGrid}">
          </div>
          <div class="grid-editor-section">
            <label class="form-label">Grille de d\u00e9part DF</label>
            <p class="text-muted" style="font-size:0.78rem;margin-bottom:var(--sp-xs)">Cliquez sur une case pour placer la position suivante. Re-cliquez pour retirer. Le c\u00f4t\u00e9 de la p\u00f4le d\u00e9pend du circuit.</p>
            <div class="settings-form-row" style="margin-bottom:var(--sp-sm)">
              <label class="form-label">Couloirs</label>
              <input class="form-input" id="sc-df-lanes" type="number"
                min="2" max="10" style="width:60px;text-align:center"
                value="${dfLayout.lanes || 5}">
              <label class="form-label" style="margin-left:var(--sp-sm)">Lignes</label>
              <input class="form-input" id="sc-df-rows" type="number"
                min="1" max="10" style="width:60px;text-align:center"
                value="${dfLayout.rows || 3}">
              <button class="btn btn-ghost btn-sm" id="sc-df-rebuild">Regen. grille</button>
            </div>
            <div class="grid-editor" id="grid-editor-df">
              ${renderGridEditor(dfLayout, 'df')}
            </div>
          </div>
        </div>

        <!-- FIN -->
        <div class="session-config-card">
          <div class="session-config-label"><span class="badge badge-fin">FIN</span> Finale</div>
          <div class="settings-form-row">
            <label class="form-label">Tours par manche</label>
            <input class="form-input" id="sc-fin-laps" type="number"
              min="1" max="30" style="width:70px;text-align:center"
              value="${sc.FIN?.laps ?? 7}">
          </div>
          <div class="settings-form-row">
            <label class="form-label">Pilotes par grille</label>
            <input class="form-input" id="sc-fin-grid" type="number"
              min="2" max="20" style="width:70px;text-align:center"
              value="${finGrid}">
          </div>
          <div class="grid-editor-section">
            <label class="form-label">Grille de d\u00e9part Finale</label>
            <p class="text-muted" style="font-size:0.78rem;margin-bottom:var(--sp-xs)">Cliquez sur une case pour placer la position suivante. Re-cliquez pour retirer.</p>
            <div class="settings-form-row" style="margin-bottom:var(--sp-sm)">
              <label class="form-label">Couloirs</label>
              <input class="form-input" id="sc-fin-lanes" type="number"
                min="2" max="10" style="width:60px;text-align:center"
                value="${finLayout.lanes || 5}">
              <label class="form-label" style="margin-left:var(--sp-sm)">Lignes</label>
              <input class="form-input" id="sc-fin-rows" type="number"
                min="1" max="10" style="width:60px;text-align:center"
                value="${finLayout.rows || 3}">
              <button class="btn btn-ghost btn-sm" id="sc-fin-rebuild">Regen. grille</button>
            </div>
            <div class="grid-editor" id="grid-editor-fin">
              ${renderGridEditor(finLayout, 'fin')}
            </div>
          </div>
        </div>

      </div>

      <div class="session-config-card session-config-card--drop">
        <div class="session-config-label">\ud83d\uddd1\ufe0f D\u00e9duction de r\u00e9sultats</div>
        <div class="settings-form-row">
          <label class="form-label">Pires r\u00e9sultats ignor\u00e9s sur la saison</label>
          <input class="form-input" id="sc-worst-drop" type="number"
            min="0" max="20" style="width:70px;text-align:center"
            value="${_editData.worstResultDrop ?? 0}">
          <span class="text-muted" style="font-size:0.8rem">0 = aucune d\u00e9duction</span>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ONGLET BARÈME
// ─────────────────────────────────────────────────────────

function renderTabPoints() {
  const SESSION_LABELS = { MQ: 'Manches Qualificatives', DF: 'Demi-Finale', FIN: 'Finale' };
  const ps = _editData.pointsScale  || {};
  const sr = _editData.statusRules  || {};

  return `
    <div class="tab-panel">
      <div class="pts-session-tabs">
        ${Object.keys(SESSION_LABELS).map(s => `
          <button class="pts-session-tab ${_activePointsSession === s ? 'is-active' : ''}" data-session="${s}">
            <span class="badge badge-${s.toLowerCase()}">${s}</span>
            ${SESSION_LABELS[s]}
          </button>
        `).join('')}
      </div>

      <div id="pts-editor">
        ${renderPointsEditor(ps[_activePointsSession] || { formula: null, overrides: {} })}
      </div>

      <!-- ── Statuts spéciaux ── -->
      <div style="margin-top:var(--sp-xl)">
        <div class="settings-section-header" style="margin-bottom:var(--sp-sm)">
          <span class="settings-section-title">⚠️ Statuts spéciaux — Attribution des points</span>
        </div>
        <p class="text-muted" style="font-size:0.82rem;margin-bottom:var(--sp-md);line-height:1.5">
          Définit comment sont calculés les points pour les pilotes non classés normalement.<br>
          Mode <strong style="color:var(--clr-text-2)">nbEngagés + décalage</strong> : utilise le barème à la position (nbEngagés + décalage).
          <br><span style="font-size:0.78rem">Exemple : 35 engagés, décalage 1 → DNF reçoit les points de la 36e place.</span>
        </p>
        <div class="status-rules-grid">
          ${renderStatusRule('DNF',      '🔴 DNF — Abandon en course',               sr.DNF)}
          ${renderStatusRule('DNS',      '⬜ DNS — Non-partant prévu',               sr.DNS)}
          ${renderStatusRule('DSQ_RACE', '🟠 DSQ EC — Disqualifié en course',        sr.DSQ_RACE)}
          ${renderStatusRule('DSQ',      '⚫ DSQ HC — Disqualifié hors course',       sr.DSQ)}
        </div>
      </div>
    </div>
  `;
}

function renderStatusRule(key, label, rule) {
  const r    = rule || {};
  const mode = r.mode || 'fixed';
  return `
    <div class="status-rule-card" data-status-key="${key}">
      <div class="status-rule-label">${label}</div>
      <div class="status-rule-controls">
        <label class="status-rule-mode-label">
          <input type="radio" name="sr-mode-${key}" value="engaged_offset"
            class="sr-mode-radio" data-key="${key}"
            ${mode === 'engaged_offset' ? 'checked' : ''}>
          nbEngagés + décalage
        </label>
        <div class="status-rule-offset" style="${mode !== 'engaged_offset' ? 'opacity:0.35;pointer-events:none' : ''}">
          <span class="text-muted" style="font-size:0.82rem">Décalage :</span>
          <input class="form-input sr-offset" type="number" min="0" max="20"
            style="width:60px;padding:4px 8px;text-align:center"
            data-key="${key}" value="${r.offset ?? 1}">
        </div>
        <label class="status-rule-mode-label">
          <input type="radio" name="sr-mode-${key}" value="fixed"
            class="sr-mode-radio" data-key="${key}"
            ${mode === 'fixed' ? 'checked' : ''}>
          Points fixes
        </label>
        <div class="status-rule-fixed" style="${mode !== 'fixed' ? 'opacity:0.35;pointer-events:none' : ''}">
          <span class="text-muted" style="font-size:0.82rem">Points :</span>
          <input class="form-input sr-fixed" type="number" min="0" max="999"
            style="width:60px;padding:4px 8px;text-align:center"
            data-key="${key}" value="${r.points ?? 0}">
        </div>
      </div>
    </div>
  `;
}

function renderPointsEditor(scale) {
  const overrides = scale.overrides || {};
  const rows = Array.from({ length: 20 }, (_, i) => i + 1).map(pos => {
    const computed    = computeFormula(scale.formula, pos);
    const hasOverride = overrides[pos] !== undefined;
    const medal = pos === 1 ? ' 🥇' : pos === 2 ? ' 🥈' : pos === 3 ? ' 🥉' : '';
    return `
      <tr class="${hasOverride ? 'pts-row--override' : ''}">
        <td class="pts-pos">${pos}${medal}</td>
        <td>
          <input class="form-input pts-override" type="number" min="0" max="999"
            style="width:72px;padding:4px 6px;font-size:0.88rem;text-align:center"
            data-pos="${pos}"
            placeholder="${computed !== null ? computed : '—'}"
            value="${hasOverride ? overrides[pos] : ''}">
        </td>
        <td class="pts-computed ${computed !== null ? '' : 'pts-computed--none'}">
          ${computed !== null ? computed : '—'}
        </td>
        <td class="pts-effective">
          <strong>${hasOverride ? overrides[pos] : (computed !== null ? computed : '—')}</strong>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="form-group" style="margin-bottom:var(--sp-md)">
      <label class="form-label">
        Formule de base
        <span class="text-muted" style="font-weight:400;text-transform:none;font-size:0.78rem;margin-left:6px">
          variable disponible : <code style="background:var(--clr-bg-3);padding:1px 5px;border-radius:3px;color:var(--clr-accent-2)">position</code>
        </span>
      </label>
      <input class="form-input" id="pts-formula" type="text"
        placeholder="ex : 44 - position   (laisser vide si pas de formule)"
        value="${escHtml(scale.formula || '')}">
    </div>

    <div class="pts-table-wrap">
      <table class="pts-table">
        <thead>
          <tr>
            <th>Position</th>
            <th>Valeur manuelle</th>
            <th>Calculée</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <p class="text-muted" style="font-size:0.8rem;margin-top:var(--sp-sm)">
      💡 La valeur <strong>manuelle prend le dessus</strong> sur la formule.
      Les lignes surlignées ont une valeur manuelle active.
    </p>
  `;
}

function computeFormula(formula, position) {
  if (!formula || !formula.trim()) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('position', `"use strict"; return (${formula})`)(position);
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return Math.max(0, Math.round(result));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// BINDING ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindTabEvents() {
  if (_activeTab === 'general') {
    document.getElementById('f-active')?.addEventListener('change', (e) => {
      const txt = document.getElementById('f-active-text');
      if (txt) txt.textContent = e.target.checked ? 'Actif' : 'Inactif';
    });

    document.getElementById('f-load-reglement')?.addEventListener('click', () => {
      const select = document.getElementById('f-reglement-select');
      const regId = select?.value;
      if (!regId) {
        _editData.reglementId = null;
        toast('Reglement personnalise — editez les onglets manuellement', 'info');
        syncCurrentTabToData();
        renderEditor();
        return;
      }
      const reg = _reglements.find(r => r.id === regId);
      if (!reg) return;
      syncCurrentTabToData();
      applyRegulation(_editData, reg);
      _editData.reglementId = regId;
      _editData.regulation  = reg.name;
      toast(`Reglement "${reg.name}" charge`, 'success');
      renderEditor();
    });
  }

  if (_activeTab === 'sessions') {
    // Toggle EC
    document.getElementById('sc-ec-enabled')?.addEventListener('change', (e) => {
      const fields = document.getElementById('sc-ec-fields');
      if (fields) fields.style.cssText = e.target.checked ? '' : 'opacity:0.35;pointer-events:none';
    });

    // Regenerer la grille (bouton ou changement taille)
    var rebuildGridFn = function(prefix) {
      var key = prefix === 'df' ? 'DF' : 'FIN';
      var lanes = parseInt(document.getElementById('sc-' + prefix + '-lanes')?.value) || 5;
      var rows  = parseInt(document.getElementById('sc-' + prefix + '-rows')?.value)  || 3;
      var size  = parseInt(document.getElementById('sc-' + prefix + '-grid')?.value)  || 8;
      var sc = _editData.sessionConfig || {};
      sc[key] = sc[key] || {};
      sc[key].gridLayout = defaultGridLayout(size, lanes, rows);
      var editor = document.getElementById('grid-editor-' + prefix);
      if (editor) {
        editor.innerHTML = renderGridEditor(sc[key].gridLayout, prefix);
        bindGridCells(prefix);
      }
    };
    document.getElementById('sc-df-rebuild')?.addEventListener('click', function() { rebuildGridFn('df'); });
    document.getElementById('sc-fin-rebuild')?.addEventListener('click', function() { rebuildGridFn('fin'); });

    // Bind clics sur les cellules de grille
    bindGridCells('df');
    bindGridCells('fin');
  }

  if (_activeTab === 'categories') {
    document.getElementById('btn-add-cat')?.addEventListener('click', () => {
      syncCurrentTabToData();
      _editData.categories.push({ id: '', name: '', freeNumbers: false, carNumberRanges: [{ min: 1, max: 999 }] });
      document.getElementById('editor-content').innerHTML = renderTabContent();
      bindTabEvents();
    });

    document.querySelectorAll('.cat-remove').forEach(btn =>
      btn.addEventListener('click', () => {
        syncCurrentTabToData();
        _editData.categories.splice(parseInt(btn.dataset.idx), 1);
        document.getElementById('editor-content').innerHTML = renderTabContent();
        bindTabEvents();
      })
    );

    document.querySelectorAll('.cat-free-numbers').forEach(cb =>
      cb.addEventListener('change', () => {
        syncCurrentTabToData();
        document.getElementById('editor-content').innerHTML = renderTabContent();
        bindTabEvents();
      })
    );

    document.querySelectorAll('.cat-add-range').forEach(btn =>
      btn.addEventListener('click', () => {
        syncCurrentTabToData();
        const idx = parseInt(btn.dataset.idx);
        if (!_editData.categories[idx].carNumberRanges) _editData.categories[idx].carNumberRanges = [];
        _editData.categories[idx].carNumberRanges.push({ min: 1, max: 999 });
        document.getElementById('editor-content').innerHTML = renderTabContent();
        bindTabEvents();
      })
    );

    document.querySelectorAll('.range-remove').forEach(btn =>
      btn.addEventListener('click', () => {
        syncCurrentTabToData();
        _editData.categories[parseInt(btn.dataset.cat)].carNumberRanges.splice(parseInt(btn.dataset.range), 1);
        document.getElementById('editor-content').innerHTML = renderTabContent();
        bindTabEvents();
      })
    );
  }

  if (_activeTab === 'points') {
    document.querySelectorAll('.pts-session-tab').forEach(btn =>
      btn.addEventListener('click', () => {
        syncCurrentTabToData();
        _activePointsSession = btn.dataset.session;
        document.getElementById('editor-content').innerHTML = renderTabContent();
        bindTabEvents();
      })
    );

    document.getElementById('pts-formula')?.addEventListener('input', (e) => {
      const formula = e.target.value.trim();
      document.querySelectorAll('.pts-override').forEach(input => {
        const pos      = parseInt(input.dataset.pos);
        const computed = computeFormula(formula, pos);
        const val      = computed !== null ? String(computed) : '—';
        input.placeholder = val;
        const row = input.closest('tr');
        if (!row) return;
        row.querySelector('.pts-computed').textContent = val;
        row.querySelector('.pts-computed').classList.toggle('pts-computed--none', computed === null);
        if (!input.value.trim()) row.querySelector('.pts-effective strong').textContent = val;
      });
    });

    document.querySelectorAll('.pts-override').forEach(input =>
      input.addEventListener('input', (e) => {
        const row    = e.target.closest('tr');
        if (!row) return;
        const formula  = document.getElementById('pts-formula')?.value.trim();
        const pos      = parseInt(e.target.dataset.pos);
        const computed = computeFormula(formula, pos);
        const manual   = e.target.value.trim();
        row.querySelector('.pts-effective strong').textContent =
          manual !== '' ? manual : (computed !== null ? String(computed) : '—');
        row.classList.toggle('pts-row--override', manual !== '');
      })
    );

    // Radios statuts spéciaux : activer/désactiver les champs selon le mode
    document.querySelectorAll('.sr-mode-radio').forEach(radio =>
      radio.addEventListener('change', (e) => {
        const key  = e.target.dataset.key;
        const card = document.querySelector(`.status-rule-card[data-status-key="${key}"]`);
        if (!card) return;
        const isOffset = e.target.value === 'engaged_offset';
        const offsetDiv = card.querySelector('.status-rule-offset');
        const fixedDiv  = card.querySelector('.status-rule-fixed');
        if (offsetDiv) offsetDiv.style.cssText = isOffset ? '' : 'opacity:0.35;pointer-events:none';
        if (fixedDiv)  fixedDiv.style.cssText  = isOffset ? 'opacity:0.35;pointer-events:none' : '';
      })
    );
  }
}

// ─────────────────────────────────────────────────────────
// SYNC FORMULAIRES → _editData
// ─────────────────────────────────────────────────────────

function syncCurrentTabToData() {
  switch (_activeTab) {

    case 'general':
      _editData.name       = (document.getElementById('f-name')?.value || '').trim();
      _editData.year       = parseInt(document.getElementById('f-year')?.value) || new Date().getFullYear();
      _editData.regulation = (document.getElementById('f-regulation')?.value || '').trim();
      _editData.isActive   = document.getElementById('f-active')?.checked ?? true;
      break;

    case 'categories':
      document.querySelectorAll('.cat-row').forEach((row, i) => {
        if (!_editData.categories[i]) return;
        _editData.categories[i].id          = (row.querySelector('[data-field="id"]')?.value || '').trim();
        _editData.categories[i].name        = (row.querySelector('[data-field="name"]')?.value || '').trim();
        _editData.categories[i].freeNumbers = row.querySelector('.cat-free-numbers')?.checked ?? false;
        row.querySelectorAll('.range-row').forEach((rr, ri) => {
          if (!_editData.categories[i].carNumberRanges?.[ri]) return;
          _editData.categories[i].carNumberRanges[ri].min = parseInt(rr.querySelector('.range-min')?.value) || 1;
          _editData.categories[i].carNumberRanges[ri].max = parseInt(rr.querySelector('.range-max')?.value) || 999;
        });
      });
      break;

    case 'sessions': {
      _editData.sessionConfig         = _editData.sessionConfig || {};
      _editData.sessionConfig.EC      = _editData.sessionConfig.EC  || {};
      _editData.sessionConfig.MQ      = _editData.sessionConfig.MQ  || {};
      _editData.sessionConfig.DF      = _editData.sessionConfig.DF  || {};
      _editData.sessionConfig.FIN     = _editData.sessionConfig.FIN || {};

      // EC
      _editData.sessionConfig.EC.enabled = document.getElementById('sc-ec-enabled')?.checked ?? true;
      _editData.sessionConfig.EC.laps    = parseInt(document.getElementById('sc-ec-laps')?.value)  || 2;

      // MQ
      _editData.sessionConfig.MQ.count = parseInt(document.getElementById('sc-mq-count')?.value) || 2;
      _editData.sessionConfig.MQ.laps  = parseInt(document.getElementById('sc-mq-laps')?.value)  || 4;

      // DF
      _editData.sessionConfig.DF.count    = parseInt(document.getElementById('sc-df-count')?.value) || 2;
      _editData.sessionConfig.DF.laps     = parseInt(document.getElementById('sc-df-laps')?.value)  || 6;
      _editData.sessionConfig.DF.gridSize = parseInt(document.getElementById('sc-df-grid')?.value)  || 8;
      _editData.sessionConfig.DF.gridLayout = readGridLayout('df');

      // FIN
      _editData.sessionConfig.FIN.laps     = parseInt(document.getElementById('sc-fin-laps')?.value) || 7;
      _editData.sessionConfig.FIN.gridSize = parseInt(document.getElementById('sc-fin-grid')?.value) || 8;
      _editData.sessionConfig.FIN.gridLayout = readGridLayout('fin');

      _editData.worstResultDrop = parseInt(document.getElementById('sc-worst-drop')?.value) || 0;
      break;
    }

    case 'points': {
      _editData.pointsScale = _editData.pointsScale || {};
      _editData.pointsScale[_activePointsSession] = _editData.pointsScale[_activePointsSession] || { formula: null, overrides: {} };
      _editData.pointsScale[_activePointsSession].formula =
        (document.getElementById('pts-formula')?.value || '').trim() || null;
      const overrides = {};
      document.querySelectorAll('.pts-override').forEach(input => {
        const val = input.value.trim();
        if (val !== '') overrides[parseInt(input.dataset.pos)] = parseInt(val);
      });
      _editData.pointsScale[_activePointsSession].overrides = overrides;

      // Sync statusRules
      _editData.statusRules = _editData.statusRules || {};
      ['DNF', 'DNS', 'DSQ_RACE', 'DSQ'].forEach(key => {
        const modeEl  = document.querySelector(`.sr-mode-radio[data-key="${key}"]:checked`);
        const mode    = modeEl?.value || 'fixed';
        const offsetEl = document.querySelector(`.sr-offset[data-key="${key}"]`);
        const fixedEl  = document.querySelector(`.sr-fixed[data-key="${key}"]`);
        _editData.statusRules[key] = mode === 'engaged_offset'
          ? { mode: 'engaged_offset', offset: parseInt(offsetEl?.value ?? 1) || 1 }
          : { mode: 'fixed',          points: parseInt(fixedEl?.value  ?? 0) || 0 };
      });
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────
// SAUVEGARDER COMME REGLEMENT
// ─────────────────────────────────────────────────────────

async function onSaveAsReglement() {
  if (!requireAuth()) return;
  syncCurrentTabToData();
  const defaultName = _editData.regulation || _editData.name || 'Nouveau reglement';
  const name = window.prompt('Nom du reglement :', defaultName);
  if (!name) return;

  try {
    const regId = await saveReglement(_editData.reglementId, name, _editData);
    _editData.reglementId = regId;
    _editData.regulation  = name;
    _reglements = await loadReglements();
    toast(`Reglement "${name}" sauvegarde`, 'success');
    renderEditor();
  } catch (e) {
    console.error('Save as reglement:', e);
    toast('Erreur lors de la sauvegarde du reglement', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// SAUVEGARDE
// ─────────────────────────────────────────────────────────

async function saveChamp() {
  if (!requireAuth()) return;
  syncCurrentTabToData();

  if (!_editData.name)                    { toast('Le nom est obligatoire', 'error'); return; }
  if (!_editData.year)                    { toast("L'année est obligatoire", 'error'); return; }
  if (!(_editData.categories || []).length) { toast('Ajoutez au moins une catégorie', 'error'); return; }
  if (!db)                                { toast('Firebase non configuré', 'error'); return; }

  const btn = document.getElementById('btn-save-champ');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enregistrement…'; }

  try {
    const { doc, setDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const id      = _editingChamp === 'new' ? `champ_${Date.now()}` : _editingChamp;
    const payload = { ..._editData, updatedAt: new Date() };
    if (_editingChamp === 'new') payload.createdAt = new Date();

    await setDoc(doc(db, 'championships', id), payload);
    logAudit(_editingChamp === 'new' ? 'create' : 'update', 'championship', id, { label: _editData.name });
    toast(`✅ "${_editData.name}" enregistré`, 'success');
    refreshHeaderSelector();
    renderSettingsList();
  } catch (e) {    console.error('Settings – sauvegarde :', e);
    toast('Erreur lors de la sauvegarde', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 Enregistrer'; }
  }
}

// ─────────────────────────────────────────────────────────
// DUPLIQUER
// ─────────────────────────────────────────────────────────

async function duplicateChamp(champId, champs) {
  if (!requireAuth()) return;
  const original = champs.find(c => c.id === champId);
  if (!original || !db) return;
  const copy = JSON.parse(JSON.stringify(original));
  delete copy.id;
  copy.name     = `${copy.name} (copie)`;
  copy.isActive = false;
  try {
    const { doc, setDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const dupId = `champ_${Date.now()}`;
    await setDoc(doc(db, 'championships', dupId), {
      ...copy, createdAt: new Date(), updatedAt: new Date(),
    });
    logAudit('create', 'championship', dupId, { label: `${copy.name} (copie de ${original.name})` });
    toast(`📋 "${original.name}" dupliqué`, 'success');
    refreshHeaderSelector();
    renderSettingsList();
  } catch (e) {
    console.error('Settings – duplication :', e);
    toast('Erreur lors de la duplication', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// SUPPRIMER
// ─────────────────────────────────────────────────────────

async function deleteChamp(champId, name) {
  if (!requireAuth()) return;
  if (!window.confirm(`Supprimer "${name}" ?\nCette action est irréversible.`)) return;
  if (!db) return;
  try {
    const { doc, deleteDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    await deleteDoc(doc(db, 'championships', champId));
    logAudit('delete', 'championship', champId, { label: name });
    toast(`🗑️ "${name}" supprimé`, 'success');
    refreshHeaderSelector();
    renderSettingsList();
  } catch (e) {
    console.error('Settings – suppression :', e);
    toast('Erreur lors de la suppression', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// EXPORT UTILITAIRE — pour les autres modules
// ─────────────────────────────────────────────────────────

/**
 * Retourne la config du championnat actif (ou par ID).
 * @param {string} [champId]
 * @returns {Promise<Object|null>}
 */
export async function getChampionshipConfig(champId) {
  if (!db) return null;
  try {
    const { collection, doc, getDoc, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    if (champId) {
      const snap = await getDoc(doc(db, 'championships', champId));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
    const snap = await getDocs(collection(db, 'championships'));
    let active = null;
    snap.forEach(d => {
      const data = d.data();
      if (data.isActive && !active) active = { id: d.id, ...data };
    });
    return active;
  } catch (e) {
    console.error('getChampionshipConfig :', e);
    return null;
  }
}