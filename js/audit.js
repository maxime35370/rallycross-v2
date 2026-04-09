/* ═══════════════════════════════════════════════
   AUDIT.JS — Journal d'audit des modifications
   Enregistre qui a fait quoi et quand dans Firestore.
   Filtres par entite, action et recherche textuelle.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml } from './utils.js';
import { toast } from './app.js';

// ─────────────────────────────────────────────────────────
// ENREGISTREMENT D'UN EVENEMENT
// ─────────────────────────────────────────────────────────

/**
 * Enregistre une action dans le journal d'audit.
 * @param {string} action   — Type d'action (create, update, delete)
 * @param {string} entity   — Entite concernee (driver, meeting, session, result, engagement)
 * @param {string} entityId — ID du document concerne
 * @param {object} details  — Donnees supplementaires (ancien/nouveau valeur, etc.)
 */
export async function logAudit(action, entity, entityId, details = {}) {
  if (!db) return;

  try {
    const { collection, addDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    // Recuperer l'utilisateur courant
    let userEmail = 'anonyme';
    try {
      const { getAuth } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
      );
      const auth = getAuth();
      if (auth.currentUser) {
        userEmail = auth.currentUser.email;
      }
    } catch { /* pas d'auth, on continue */ }

    await addDoc(collection(db, 'auditLog'), {
      action,
      entity,
      entityId: entityId || '',
      details,
      userEmail,
      timestamp: serverTimestamp(),
      clientTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Audit log error:', err);
    toast(`Audit log: ${err.code || err.message}`, 'warning', 5000);
  }
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT DES LOGS
// ─────────────────────────────────────────────────────────

async function loadAuditLog(maxResults = 200) {
  if (!db) return [];
  const fs = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );

  try {
    const snap = await fs.getDocs(
      fs.query(
        fs.collection(db, 'auditLog'),
        fs.orderBy('timestamp', 'desc'),
        fs.limit(maxResults)
      )
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('Audit log query error:', err);
    try {
      const snap = await fs.getDocs(fs.collection(db, 'auditLog'));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      docs.sort((a, b) => {
        const ta = a.timestamp?.toMillis?.() || 0;
        const tb = b.timestamp?.toMillis?.() || 0;
        return tb - ta;
      });
      return docs.slice(0, maxResults);
    } catch (e2) {
      console.error('Audit log fallback error:', e2);
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────
// CONSTANTES AFFICHAGE
// ─────────────────────────────────────────────────────────

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const ACTION_LABELS = {
  create: { label: 'Creation', cls: 'badge-ec' },
  update: { label: 'Modification', cls: 'badge-mq' },
  delete: { label: 'Suppression', cls: 'badge-dns' },
};

const ENTITY_LABELS = {
  driver:             'Pilote',
  meeting:            'Meeting',
  session:            'Session',
  result:             'Resultat',
  engagement:         'Engagement',
  sessionParticipant: 'Participant',
  championship:       'Championnat',
  reglement:          'Reglement',
};

// ─────────────────────────────────────────────────────────
// ETAT DES FILTRES
// ─────────────────────────────────────────────────────────

let _allLogs       = [];
let _filterEntity  = '';   // '' = toutes
let _filterAction  = '';   // '' = toutes
let _filterSearch  = '';   // recherche texte libre

function applyFilters() {
  let filtered = _allLogs;

  if (_filterEntity) {
    filtered = filtered.filter(l => l.entity === _filterEntity);
  }
  if (_filterAction) {
    filtered = filtered.filter(l => l.action === _filterAction);
  }
  if (_filterSearch) {
    const q = _filterSearch.toLowerCase();
    filtered = filtered.filter(l => {
      const detail = (l.details?.label || l.details?.name || l.entityId || '').toLowerCase();
      const user   = (l.userEmail || '').toLowerCase();
      return detail.includes(q) || user.includes(q);
    });
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderRows(logs) {
  const tbody = document.getElementById('audit-tbody');
  const count = document.getElementById('audit-count');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">Aucun resultat pour ces filtres.</td></tr>`;
  } else {
    tbody.innerHTML = logs.map(log => {
      const act = ACTION_LABELS[log.action] || { label: log.action, cls: 'badge-d4' };
      const ent = ENTITY_LABELS[log.entity] || log.entity;
      const detailStr = log.details?.label || log.details?.name || log.entityId || '';
      return `
        <tr>
          <td class="audit-time">${formatTimestamp(log.timestamp)}</td>
          <td><span class="badge ${act.cls}">${act.label}</span></td>
          <td>${escHtml(ent)}</td>
          <td>${escHtml(detailStr)}</td>
          <td class="audit-user">${escHtml(log.userEmail)}</td>
        </tr>
      `;
    }).join('');
  }

  if (count) count.textContent = `${logs.length} action${logs.length > 1 ? 's' : ''}`;
}

async function render() {
  const view = document.getElementById('view-audit');
  if (!view) return;

  // Detecter les entites presentes dans les logs pour le filtre
  const entityOptions = Object.entries(ENTITY_LABELS)
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join('');

  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📋 Journal <span>d'audit</span></h2>
      <div class="section-actions">
        <span class="text-muted" id="audit-count" style="font-size:0.82rem"></span>
        <button class="btn btn-secondary btn-sm" id="audit-refresh-btn">Rafraichir</button>
      </div>
    </div>

    <!-- Filtres -->
    <div class="toolbar" id="audit-filters">
      <input class="toolbar-input" id="audit-search" type="text"
        placeholder="Rechercher (pilote, meeting, utilisateur...)"
        style="flex:1;min-width:180px">
      <select class="toolbar-select" id="audit-filter-entity">
        <option value="">Toutes les entites</option>
        ${entityOptions}
      </select>
      <select class="toolbar-select" id="audit-filter-action">
        <option value="">Toutes les actions</option>
        <option value="create">Creation</option>
        <option value="update">Modification</option>
        <option value="delete">Suppression</option>
      </select>
    </div>

    <div class="loading-state" id="audit-loading"><div class="spinner"></div> Chargement du journal…</div>

    <div class="table-wrap" id="audit-table-wrap" style="display:none">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Action</th>
            <th>Entite</th>
            <th>Detail</th>
            <th>Utilisateur</th>
          </tr>
        </thead>
        <tbody id="audit-tbody"></tbody>
      </table>
    </div>
  `;

  // Bind filtres
  document.getElementById('audit-refresh-btn')?.addEventListener('click', render);

  document.getElementById('audit-filter-entity')?.addEventListener('change', (e) => {
    _filterEntity = e.target.value;
    renderRows(applyFilters());
  });

  document.getElementById('audit-filter-action')?.addEventListener('change', (e) => {
    _filterAction = e.target.value;
    renderRows(applyFilters());
  });

  let searchTimeout = null;
  document.getElementById('audit-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      _filterSearch = e.target.value.trim();
      renderRows(applyFilters());
    }, 250);
  });

  // Charger les logs
  try {
    _allLogs = await loadAuditLog(200);
  } catch (err) {
    console.error('Audit render error:', err);
    _allLogs = [];
  }

  const loading  = document.getElementById('audit-loading');
  const tableWrap = document.getElementById('audit-table-wrap');

  if (loading) loading.style.display = 'none';
  if (tableWrap) tableWrap.style.display = '';

  if (_allLogs.length === 0) {
    if (tableWrap) tableWrap.innerHTML = `
      <div class="table-empty" style="padding:var(--sp-xl)">Aucune action enregistree pour le moment.</div>
    `;
    return;
  }

  renderRows(applyFilters());
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initAudit() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'audit') {
      _filterEntity = '';
      _filterAction = '';
      _filterSearch = '';
      render();
    }
  });
}
