/* ═══════════════════════════════════════════════
   APP.JS — Router de vues, menu burger, utilitaires UI
   Point d'entrée principal de l'application
═══════════════════════════════════════════════ */

// ── Mapping vues → titres ──────────────────────
const VIEW_TITLES = {
  home:          'Accueil',
  drivers:       'Pilotes',
  meetings:      'Meetings',
  engagements:   'Engagements',
  sessions:      'Sessions',
  timing:        'Chronométrage',
  standings:     'Classements',
  championship:  'Championnat',
  spectator:     '📺 Mode Spectateur',
  stats:         '📊 Statistiques',
  config:        'Configuration',
  settings:      'Reglages Championnats',
  audit:         'Journal d\'audit',
};

// ── État courant ───────────────────────────────
let currentView = 'home';

// ─────────────────────────────────────────────────────────
// ROUTER DE VUES
// ─────────────────────────────────────────────────────────

/**
 * Affiche une vue et masque les autres.
 * @param {string} viewId - L'identifiant de la vue
 */
export function showView(viewId) {
  if (!VIEW_TITLES[viewId]) return;

  // Masquer toutes les vues
  document.querySelectorAll('.view').forEach(el => {
    el.style.display = 'none';
  });

  // Afficher la vue cible
  const target = document.getElementById(`view-${viewId}`);
  if (target) target.style.display = '';

  // Mettre à jour le titre header
  const titleEl = document.getElementById('header-view-title');
  if (titleEl) titleEl.textContent = VIEW_TITLES[viewId] || viewId;

  // Mettre à jour le menu actif
  document.querySelectorAll('.menu-item').forEach(el => {
    el.classList.toggle('is-active', el.dataset.view === viewId);
  });

  currentView = viewId;
  closeMenu();

  // Déclencher l'événement pour que la vue puisse s'initialiser
  document.dispatchEvent(new CustomEvent('viewchange', { detail: { view: viewId } }));
}

// ─────────────────────────────────────────────────────────
// MENU BURGER
// ─────────────────────────────────────────────────────────

function openMenu() {
  document.getElementById('menu-drawer').classList.add('is-open');
  document.getElementById('menu-overlay').classList.add('is-open');
  document.getElementById('burger-btn').classList.add('is-open');
  document.getElementById('burger-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('menu-drawer').setAttribute('aria-hidden', 'false');
}

function closeMenu() {
  document.getElementById('menu-drawer').classList.remove('is-open');
  document.getElementById('menu-overlay').classList.remove('is-open');
  document.getElementById('burger-btn').classList.remove('is-open');
  document.getElementById('burger-btn').setAttribute('aria-expanded', 'false');
  document.getElementById('menu-drawer').setAttribute('aria-hidden', 'true');
}

function toggleMenu() {
  const isOpen = document.getElementById('menu-drawer').classList.contains('is-open');
  isOpen ? closeMenu() : openMenu();
}

// ─────────────────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────

let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

/**
 * Affiche une notification toast.
 * @param {string} message - Message à afficher
 * @param {'success'|'error'|'warning'|'info'} type - Type de toast
 * @param {number} duration - Durée en ms (défaut 3000)
 */
export function toast(message, type = 'info', duration = 3000) {
  ensureToastContainer();

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;

  toastContainer.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'toastOut 0.25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

// ─────────────────────────────────────────────────────────
// MODAL UTILITAIRE
// ─────────────────────────────────────────────────────────

/**
 * Ouvre une modal existante dans le DOM.
 * @param {string} modalId - ID de l'élément .modal-backdrop
 */
export function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('is-open');
}

/**
 * Ferme une modal existante dans le DOM.
 * @param {string} modalId - ID de l'élément .modal-backdrop
 */
export function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('is-open');
}

// ─────────────────────────────────────────────────────────
// FIREBASE STATUS (dans le menu)
// ─────────────────────────────────────────────────────────

/**
 * Met à jour l'indicateur de statut Firebase dans le menu.
 * @param {'connected'|'disconnected'|'pending'} status
 * @param {string} label
 */
export function setFirebaseStatus(status, label) {
  const dot   = document.getElementById('status-dot');
  const lbl   = document.getElementById('status-label');
  const alert = document.getElementById('home-alert');

  if (dot) {
    dot.className = `status-dot ${status}`;
  }
  if (lbl) lbl.textContent = label;

  // Afficher/masquer l'alerte d'accueil
  if (alert) {
    alert.style.display = status === 'connected' ? 'none' : 'flex';
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS HTML
// ─────────────────────────────────────────────────────────

/**
 * Retourne le badge HTML pour une catégorie de pilote.
 * @param {string} category
 */
export function categoryBadge(category) {
  const key = (category || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const map = {
    supercar:   'badge-supercar',
    super1600:  'badge-super1600',
    division5:  'badge-d5',
    d5:         'badge-d5',
    feminines:  'badge-feminines',
    d3:         'badge-d3',
    d4:         'badge-d4',
  };
  const cls = map[key] || 'badge-d4';
  return `<span class="badge ${cls}">${category}</span>`;
}

/**
 * Retourne le badge HTML pour un type de session.
 * @param {string} type  — 'EC' | 'MQ' | 'DF' | 'FIN'
 */
export function sessionBadge(type) {
  const map = {
    EC:  { cls: 'badge-ec',  label: 'Essais' },
    MQ:  { cls: 'badge-mq',  label: 'Qualif.' },
    DF:  { cls: 'badge-df',  label: '½ Finale' },
    FIN: { cls: 'badge-fin', label: 'Finale' },
  };
  const b = map[type?.toUpperCase()] || { cls: 'badge-d4', label: type };
  return `<span class="badge ${b.cls}">${b.label}</span>`;
}

/**
 * Retourne le badge HTML pour un statut de course.
 * @param {string} status  — 'DNS' | 'DNF' | 'DSQ' | 'DSQ_RACE'
 */
export function statusBadge(status) {
  const map = {
    DNS:      { cls: 'badge-dns', label: 'DNS' },
    DNF:      { cls: 'badge-dnf', label: 'DNF' },
    DSQ:      { cls: 'badge-dsq', label: 'DSQ HC' },
    DSQ_RACE: { cls: 'badge-dsq', label: 'DSQ EC' },
  };
  const b = map[status?.toUpperCase()];
  if (!b) return '';
  return `<span class="badge ${b.cls}">${b.label}</span>`;
}

// ─────────────────────────────────────────────────────────
// CONFIRMATION (dialog natif simple)
// ─────────────────────────────────────────────────────────

/**
 * Demande une confirmation avant action destructrice.
 * @param {string} message
 * @returns {boolean}
 */
export function confirm(message) {
  return window.confirm(message);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

function init() {
  // Burger button
  document.getElementById('burger-btn')
    ?.addEventListener('click', toggleMenu);

  // Fermer via overlay
  document.getElementById('menu-overlay')
    ?.addEventListener('click', closeMenu);

  // Fermer via bouton ×
  document.getElementById('menu-close-btn')
    ?.addEventListener('click', closeMenu);

  // Liens du menu
  document.querySelectorAll('.menu-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      showView(el.dataset.view);
    });
  });

  // Cards de l'accueil
  document.querySelectorAll('.home-card[data-view]').forEach(el => {
    el.addEventListener('click', () => showView(el.dataset.view));
  });

  // Lien dans l'alerte accueil
  document.querySelector('#home-alert [data-view]')
    ?.addEventListener('click', e => {
      e.preventDefault();
      showView(e.target.dataset.view);
    });

  // Fermer drawer avec Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });

  // Vue initiale
  showView('home');

  // Charger Firebase et les modules au démarrage
  loadApp();
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT DIFFÉRÉ DES MODULES
// ─────────────────────────────────────────────────────────

async function loadApp() {
  // Charger firebase.js (qui tentera de s'initialiser depuis localStorage)
  const { initFirebase } = await import('./firebase.js');
  await initFirebase();

  // Charger l'authentification (apres Firebase)
  const { initAuth } = await import('./auth.js');
  await initAuth();

  // Modules des vues — chargés une seule fois au démarrage
  const { initConfig }   = await import('./config.js');
  const { initDrivers }  = await import('./drivers.js');
  const { initMeetings } = await import('./meetings.js');
  initConfig();
  initDrivers();
  const { initEngagements } = await import('./engagements.js');
  initMeetings();
  initEngagements();

  const { initSessions } = await import('./sessions.js');
  const { initTiming }     = await import('./timing.js');
  const { initStandings }      = await import('./standings.js');
  const { initChampionship }   = await import('./championship.js');
  const { initSpectator }      = await import('./spectator.js');
  const { initStats }          = await import('./stats.js');
  const { initSettings } = await import('./settings.js');
  const { initAudit }    = await import('./audit.js');
  initSessions();
  initTiming();
  initStandings();
  initChampionship();
  initSpectator();
  initStats();
  initSettings();
  initAudit();

  // Initialiser le QR code sur la page d'accueil
  initHomeQr();
}

// ─────────────────────────────────────────────────────────
// QR CODE SPECTATEUR (page d'accueil)
// ─────────────────────────────────────────────────────────

async function initHomeQr() {
  try {
    const { generateQrHtml, getSpectatorUrl } = await import('./qrcode.js');
    const url = getSpectatorUrl();
    const container = document.getElementById('home-qr-code');
    const urlEl     = document.getElementById('home-qr-url');
    const copyBtn   = document.getElementById('home-qr-copy');

    if (container) container.innerHTML = generateQrHtml(url, 180);
    if (urlEl)     urlEl.textContent = url;
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(url).then(() => {
          toast('Lien copie !', 'success');
        }).catch(() => {
          toast('Erreur de copie', 'error');
        });
      });
    }
  } catch (err) {
    console.error('QR init error:', err);
  }
}

// Démarrage après chargement du DOM
document.addEventListener('DOMContentLoaded', init);