/* ═══════════════════════════════════════════════
   AUDIT.JS — Journal d'audit des modifications
   Enregistre qui a fait quoi et quand dans Firestore.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml } from './utils.js';

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
  }
}

// ─────────────────────────────────────────────────────────
// AFFICHAGE DU JOURNAL (vue admin)
// ─────────────────────────────────────────────────────────

async function loadAuditLog(limit = 50) {
  if (!db) return [];
  const { collection, query, orderBy, getDocs, limitFn } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  ).then(m => ({ ...m, limitFn: m.limit }));

  const snap = await getDocs(
    query(collection(db, 'auditLog'), orderBy('timestamp', 'desc'), limitFn(limit))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

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
  driver: 'Pilote',
  meeting: 'Meeting',
  session: 'Session',
  result: 'Resultat',
  engagement: 'Engagement',
  sessionParticipant: 'Participant',
};

async function render() {
  const view = document.getElementById('view-audit');
  if (!view) return;

  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📋 Journal <span>d'audit</span></h2>
      <div class="section-actions">
        <button class="btn btn-secondary btn-sm" id="audit-refresh-btn">Rafraichir</button>
      </div>
    </div>
    <div class="loading-state"><div class="spinner"></div> Chargement du journal…</div>
  `;

  document.getElementById('audit-refresh-btn')
    ?.addEventListener('click', render);

  const logs = await loadAuditLog(100);

  if (logs.length === 0) {
    view.querySelector('.loading-state').innerHTML = `
      <div class="table-empty">Aucune action enregistree pour le moment.</div>
    `;
    return;
  }

  const rows = logs.map(log => {
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

  view.querySelector('.loading-state').outerHTML = `
    <div class="table-wrap">
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
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initAudit() {
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'audit') render();
  });
}
