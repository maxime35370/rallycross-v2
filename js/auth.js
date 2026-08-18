/* ═══════════════════════════════════════════════
   AUTH.JS — Authentification Firebase
   Login/logout admin, protection des vues d'ecriture
═══════════════════════════════════════════════ */

import { toast, showView } from './app.js';

// ── Etat ───────────────────────────────────────
let auth = null;
let currentUser = null;

// Vues réservées à l'ADMIN (édition + configuration) : masquées dans le menu et
// l'accueil, et bloquées à l'accès pour tout autre visiteur (anonyme ou e-mail
// non-admin). Lecture libre pour tous : home, standings, championship, stats, spectator.
const PROTECTED_VIEWS = [
  'persons', 'drivers', 'meetings', 'engagements', 'sessions', 'timing',
  'startAnalysis', 'audit', 'config', 'settings',
];

// ⚠️ DOIT correspondre à l'allowlist des RÈGLES FIRESTORE (fonction isRegie()).
// Le(s) e-mail(s) avec le(s)quel(s) tu te connectes en administrateur.
const ADMIN_EMAILS = ['maxime.theard@gmail.com'];

// ─────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────

export function getUser() {
  return currentUser;
}

export function isAuthenticated() {
  return currentUser !== null;
}

/** Vrai UNIQUEMENT pour l'administrateur : connecté, NON anonyme, e-mail autorisé.
 *  C'est ce qui débloque l'édition, la config et les vues réservées. */
export function isAdmin() {
  return !!currentUser
      && !currentUser.isAnonymous
      && ADMIN_EMAILS.includes((currentUser.email || '').toLowerCase());
}

export function isProtectedView(viewId) {
  return PROTECTED_VIEWS.includes(viewId);
}

/**
 * Verifie que l'utilisateur est connecte avant une action d'ecriture.
 * Affiche un toast d'erreur si non connecte.
 * @returns {boolean} true si authentifie, false sinon
 */
export function requireAuth() {
  if (isAdmin()) return true;
  toast("Action réservée à l'administrateur.", 'error');
  return false;
}

// ─────────────────────────────────────────────────────────
// UI : Barre d'auth dans le menu
// ─────────────────────────────────────────────────────────

function renderAuthUI() {
  const container = document.getElementById('menu-auth');
  if (!container) return;

  if (currentUser && !currentUser.isAnonymous) {
    container.innerHTML = `
      <div class="auth-logged">
        <span class="auth-user-icon">👤</span>
        <span class="auth-user-email">${currentUser.email}</span>
        <button class="btn btn-sm btn-danger" id="auth-logout-btn">Deconnexion</button>
      </div>
    `;
    document.getElementById('auth-logout-btn')
      ?.addEventListener('click', logout);
  } else {
    container.innerHTML = `
      <div class="auth-login-form">
        <input class="form-input form-input-sm" type="email"    id="auth-email" placeholder="Email" autocomplete="email">
        <input class="form-input form-input-sm" type="password" id="auth-pass"  placeholder="Mot de passe" autocomplete="current-password">
        <button class="btn btn-sm btn-primary" id="auth-login-btn">Connexion</button>
        <div class="auth-error" id="auth-error"></div>
      </div>
    `;
    document.getElementById('auth-login-btn')
      ?.addEventListener('click', onLoginClick);

    // Enter key to login
    document.getElementById('auth-pass')
      ?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onLoginClick();
      });
  }
}

// ─────────────────────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────────────────────

async function onLoginClick() {
  const email = document.getElementById('auth-email')?.value?.trim();
  const pass  = document.getElementById('auth-pass')?.value;
  const errEl = document.getElementById('auth-error');

  if (!email || !pass) {
    if (errEl) errEl.textContent = 'Email et mot de passe requis.';
    return;
  }

  try {
    if (errEl) errEl.textContent = '';
    const { signInWithEmailAndPassword } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
    );
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged will handle the rest
  } catch (err) {
    console.error('Login error:', err);
    const messages = {
      'auth/user-not-found':      'Utilisateur introuvable.',
      'auth/wrong-password':      'Mot de passe incorrect.',
      'auth/invalid-email':       'Email invalide.',
      'auth/too-many-requests':   'Trop de tentatives. Reessayez plus tard.',
      'auth/invalid-credential':  'Identifiants invalides.',
    };
    const msg = messages[err.code] || 'Erreur de connexion.';
    if (errEl) errEl.textContent = msg;
  }
}

async function logout() {
  try {
    const { signOut } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
    );
    await signOut(auth);
    toast('Deconnecte.', 'info');
  } catch (err) {
    console.error('Logout error:', err);
    toast('Erreur de deconnexion.', 'error');
  }
}

// ─────────────────────────────────────────────────────────
// PROTECTION DES VUES
// ─────────────────────────────────────────────────────────

let _currentView  = 'home';
let _authResolved = false;   // true dès que Firebase a donné l'état d'auth initial

function onViewChange(e) {
  const viewId = e.detail?.view;
  if (!viewId) return;
  _currentView = viewId;
  enforceViewAccess();
}

/**
 * Contrôle d'accès aux vues réservées. Pour un non-admin, l'accès est simplement
 * impossible : au lieu d'un écran qui inviterait à se connecter, on le renvoie
 * directement au mode spectateur (vue publique).
 * On attend l'état d'auth réel (_authResolved) avant d'agir, pour ne pas
 * rediriger l'administrateur pendant le chargement de sa session.
 */
function enforceViewAccess() {
  if (!_authResolved) return;                                  // statut pas encore connu → on attend
  if (!isProtectedView(_currentView) || isAdmin()) return;     // vue libre ou admin → rien à faire
  toast('Accès impossible.', 'error');
  // Différé : on laisse le dispatch 'viewchange' courant se terminer avant de
  // rediriger (évite une ré-entrance showView → viewchange imbriqué).
  setTimeout(() => {
    if (_authResolved && isProtectedView(_currentView) && !isAdmin()) showView('spectator');
  }, 0);
}

/** Masque/affiche les entrées réservées à l'admin (menu, accueil, statut Firebase)
 *  en basculant la classe `is-admin` sur <body> (le CSS fait le reste). */
function applyAdminVisibility() {
  document.body.classList.toggle('is-admin', isAdmin());
}

/** Le formulaire de connexion est masqué au public. Il n'apparaît que si l'URL
 *  contient `?login` (URL « secrète » à garder pour l'admin) — évite d'inviter
 *  n'importe qui à tenter de se connecter. Une fois connecté, l'UI « Déconnexion »
 *  s'affiche normalement (sans le paramètre). */
function applyLoginVisibility() {
  const show = /[?&]login(=|&|$)/.test(window.location.search);
  document.body.classList.toggle('show-login', show);
}

// ─────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────

export async function initAuth() {
  // Toujours afficher l'UI d'auth dans le menu
  document.addEventListener('viewchange', onViewChange);
  renderAuthUI();
  applyAdminVisibility();    // état initial : non-admin → entrées d'édition/config masquées
  applyLoginVisibility();    // formulaire de connexion masqué sauf URL ?login

  // Initialiser Firebase Auth si Firebase est pret
  try {
    const { getApps } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
    );
    const apps = getApps();
    if (apps.length === 0) return;

    const { getAuth, onAuthStateChanged } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
    );
    auth = getAuth(apps[0]);

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      _authResolved = true;
      renderAuthUI();
      applyAdminVisibility();
      enforceViewAccess();   // statut connu : un non-admin sur une vue réservée est renvoyé au spectateur

      // Toast UNIQUEMENT pour l'admin (une session anonyme — votes pronostics —
      // ne doit rien notifier).
      if (isAdmin()) {
        toast(`Connecté : ${user.email}`, 'success');
      }

      document.dispatchEvent(
        new CustomEvent('authchange', { detail: { user } })
      );
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}
