/* ═══════════════════════════════════════════════
   AUTH.JS — Authentification Firebase
   Login/logout admin, protection des vues d'ecriture
═══════════════════════════════════════════════ */

import { toast, showView } from './app.js';

// ── Etat ───────────────────────────────────────
let auth = null;
let currentUser = null;

// Vues qui necessitent une authentification (ecriture)
const PROTECTED_VIEWS = [
  'drivers', 'meetings', 'engagements', 'sessions', 'timing',
];

// Vues en lecture seule (pas besoin d'auth)
// home, standings, championship, stats, spectator, config

// ─────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────

export function getUser() {
  return currentUser;
}

export function isAuthenticated() {
  return currentUser !== null;
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
  if (currentUser) return true;
  toast('Connexion requise pour cette action', 'error');
  return false;
}

// ─────────────────────────────────────────────────────────
// UI : Barre d'auth dans le menu
// ─────────────────────────────────────────────────────────

function renderAuthUI() {
  const container = document.getElementById('menu-auth');
  if (!container) return;

  if (currentUser) {
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

function onViewChange(e) {
  const viewId = e.detail?.view;
  if (!viewId) return;

  if (isProtectedView(viewId) && !isAuthenticated()) {
    // Afficher un overlay d'avertissement dans la vue
    const viewEl = document.getElementById(`view-${viewId}`);
    if (!viewEl) return;

    // Ne pas bloquer si un overlay existe deja
    if (viewEl.querySelector('.auth-gate')) return;

    const gate = document.createElement('div');
    gate.className = 'auth-gate';
    gate.innerHTML = `
      <div class="auth-gate-content">
        <div class="auth-gate-icon">🔒</div>
        <h3>Connexion requise</h3>
        <p>Connectez-vous via le menu pour acceder a cette section en ecriture.</p>
        <p class="auth-gate-hint">Mode lecture seule actif — les modifications sont desactivees.</p>
      </div>
    `;
    viewEl.prepend(gate);
  }
}

function removeAuthGates() {
  document.querySelectorAll('.auth-gate').forEach((el) => el.remove());
}

// ─────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────

export async function initAuth() {
  // Toujours afficher l'UI d'auth dans le menu
  document.addEventListener('viewchange', onViewChange);
  renderAuthUI();

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
      renderAuthUI();

      if (user) {
        toast(`Connecte : ${user.email}`, 'success');
        removeAuthGates();
      }

      document.dispatchEvent(
        new CustomEvent('authchange', { detail: { user } })
      );
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}
