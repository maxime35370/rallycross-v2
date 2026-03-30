/* ═══════════════════════════════════════════════
   CONFIG.JS — Vue Configuration Firebase
   Saisie des clés, sauvegarde localStorage, test connexion
═══════════════════════════════════════════════ */

import { getStoredConfig, saveConfig, clearConfig, initFirebase } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// CHAMPS DE LA CONFIG FIREBASE
// ─────────────────────────────────────────────────────────

const FIELDS = [
  { key: 'apiKey',            label: 'API Key',              placeholder: 'AIzaSy...' },
  { key: 'authDomain',        label: 'Auth Domain',          placeholder: 'mon-projet.firebaseapp.com' },
  { key: 'projectId',         label: 'Project ID',           placeholder: 'mon-projet' },
  { key: 'storageBucket',     label: 'Storage Bucket',       placeholder: 'mon-projet.appspot.com' },
  { key: 'messagingSenderId', label: 'Messaging Sender ID',  placeholder: '123456789' },
  { key: 'appId',             label: 'App ID',               placeholder: '1:123456789:web:abc...' },
];

// ─────────────────────────────────────────────────────────
// RENDU DE LA VUE
// ─────────────────────────────────────────────────────────

function render() {
  const config = getStoredConfig() || {};
  const isConfigured = !!config.projectId;

  const fieldsHtml = FIELDS.map(f => `
    <div class="form-group">
      <label class="form-label" for="cfg-${f.key}">${escHtml(f.label)}</label>
      <input
        class="form-input"
        type="text"
        id="cfg-${f.key}"
        name="${f.key}"
        value="${escHtml(config[f.key] || '')}"
        placeholder="${escHtml(f.placeholder)}"
        autocomplete="off"
        spellcheck="false"
      >
    </div>
  `).join('');

  const view = document.getElementById('view-config');
  view.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">⚙️ Configuration <span>Firebase</span></h2>
    </div>

    <!-- Statut actuel -->
    <div class="config-status-bar ${isConfigured ? 'config-status-bar--ok' : 'config-status-bar--warn'}">
      <span class="config-status-icon">${isConfigured ? '✅' : '⚠️'}</span>
      <span>${isConfigured
        ? `Projet connecté : <strong>${escHtml(config.projectId)}</strong>`
        : 'Aucun projet Firebase configuré. Renseignez vos clés ci-dessous.'
      }</span>
    </div>

    <!-- Aide -->
    <div class="config-help card mt-md">
      <div class="card-title">Comment trouver ces informations ?</div>
      <ol class="config-help-list">
        <li>Aller sur <a href="https://console.firebase.google.com" target="_blank" rel="noopener">console.firebase.google.com</a></li>
        <li>Créer un projet ou en sélectionner un existant</li>
        <li>Aller dans <strong>Paramètres du projet</strong> (⚙️ en haut à gauche)</li>
        <li>Section <strong>Vos applications</strong> → Ajouter une app Web si besoin</li>
        <li>Copier le bloc <code>firebaseConfig</code> et renseigner les champs ci-dessous</li>
      </ol>
    </div>

    <!-- Formulaire -->
    <div class="card mt-md">
      <div class="card-title">Paramètres de connexion</div>
      <form id="config-form" autocomplete="off">
        ${fieldsHtml}
        <div class="config-actions">
          <button type="submit" class="btn btn-primary">💾 Enregistrer et connecter</button>
          ${isConfigured ? `<button type="button" class="btn btn-danger" id="cfg-clear-btn">🗑️ Supprimer la config</button>` : ''}
        </div>
      </form>
    </div>

    <!-- Zone de test -->
    <div class="card mt-md" id="config-test-area" style="display:none">
      <div class="card-title">Test de connexion</div>
      <div id="config-test-result"></div>
    </div>
  `;

  // ── Events ────────────────────────────────────────
  document.getElementById('config-form')
    ?.addEventListener('submit', onSave);

  document.getElementById('cfg-clear-btn')
    ?.addEventListener('click', onClear);
}

// ─────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────

async function onSave(e) {
  e.preventDefault();

  const config = {};
  let hasEmpty = false;

  FIELDS.forEach(f => {
    const val = document.getElementById(`cfg-${f.key}`)?.value?.trim() || '';
    config[f.key] = val;
    if (!val) hasEmpty = true;
  });

  if (hasEmpty) {
    toast('Tous les champs sont obligatoires.', 'error');
    return;
  }

  // Sauvegarde
  saveConfig(config);
  toast('Configuration sauvegardée, connexion en cours…', 'info');

  // Tentative de connexion
  const testArea   = document.getElementById('config-test-area');
  const testResult = document.getElementById('config-test-result');
  testArea.style.display = '';
  testResult.innerHTML = `<div class="loading-state"><div class="spinner"></div> Connexion à Firebase…</div>`;

  const ok = await initFirebase();

  if (ok) {
    testResult.innerHTML = `
      <div class="config-test-ok">
        <span>✅</span>
        <span>Connexion réussie ! Projet : <strong>${escHtml(config.projectId)}</strong></span>
      </div>`;
    toast('Firebase connecté !', 'success');
    // Re-render pour mettre à jour le statut
    setTimeout(render, 800);
  } else {
    testResult.innerHTML = `
      <div class="config-test-error">
        <span>❌</span>
        <span>Échec de la connexion. Vérifiez vos clés Firebase.</span>
      </div>`;
    toast('Échec de connexion Firebase.', 'error');
  }
}

function onClear() {
  if (!window.confirm('Supprimer la configuration Firebase ? Le site ne pourra plus se connecter.')) return;
  clearConfig();
  toast('Configuration supprimée.', 'warning');
  render();
}

// ─────────────────────────────────────────────────────────
// STYLES SPÉCIFIQUES À LA VUE CONFIG
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('config-styles')) return;
  const style = document.createElement('style');
  style.id = 'config-styles';
  style.textContent = `
    .config-status-bar {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-md) var(--sp-lg);
      border-radius: var(--r-md);
      border: 1px solid;
      font-size: 0.92rem;
      margin-bottom: var(--sp-md);
    }
    .config-status-bar--ok {
      background: var(--clr-success-dim);
      border-color: var(--clr-success);
      color: var(--clr-success);
    }
    .config-status-bar--warn {
      background: var(--clr-warning-dim);
      border-color: var(--clr-warning);
      color: var(--clr-warning);
    }
    .config-status-icon { font-size: 1.1rem; flex-shrink: 0; }

    .config-help-list {
      list-style: decimal;
      padding-left: var(--sp-lg);
      margin-top: var(--sp-sm);
      display: flex;
      flex-direction: column;
      gap: var(--sp-xs);
      font-size: 0.88rem;
      color: var(--clr-text-2);
      line-height: 1.6;
    }
    .config-help-list code {
      background: var(--clr-bg-3);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.82rem;
      color: var(--clr-accent-2);
    }

    .config-actions {
      display: flex;
      gap: var(--sp-sm);
      flex-wrap: wrap;
      margin-top: var(--sp-lg);
      padding-top: var(--sp-md);
      border-top: 1px solid var(--clr-border);
    }

    .config-test-ok,
    .config-test-error {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: var(--sp-md);
      border-radius: var(--r-md);
      font-size: 0.92rem;
    }
    .config-test-ok    { background: var(--clr-success-dim); color: var(--clr-success); }
    .config-test-error { background: var(--clr-danger-dim);  color: var(--clr-danger); }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT — Écoute l'événement de navigation
// ─────────────────────────────────────────────────────────

export function initConfig() {
  injectStyles();
  document.addEventListener('viewchange', e => {
    if (e.detail.view === 'config') render();
  });
}