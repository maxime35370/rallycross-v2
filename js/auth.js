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
  'audit', 'config', 'settings',
  'access',   // écran d'attribution des licences — régie uniquement
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

/** Compte réel — connecté ET non anonyme. L'auth anonyme des pronostics
 *  ne doit jamais être confondue avec un compte team. */
export function isRealUser() {
  return !!currentUser && !currentUser.isAnonymous;
}

/** Compte réel dont l'adresse est vérifiée. C'est la condition que les
 *  règles Firestore exigent pour CONSOMMER une licence : sans elle, la
 *  lecture de `licenses` est refusée côté serveur. L'interface s'aligne
 *  pour pouvoir l'expliquer au lieu d'afficher une erreur brute. */
export function isVerifiedUser() {
  return isRealUser() && currentUser.emailVerified === true;
}

/** 'login' | 'signup' — le formulaire du menu bascule entre les deux. */
let _authMode = 'login';

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

  // ── Connecté ────────────────────────────────────────────
  if (currentUser && !currentUser.isAnonymous) {
    // L'adresse non vérifiée n'est pas une erreur : c'est une étape. On le
    // dit ici, une fois, plutôt que de laisser Stratégie Live afficher un
    // refus dont l'utilisateur ne comprendrait pas la cause.
    const nonVerifie = currentUser.emailVerified !== true;
    container.innerHTML = `
      <div class="auth-logged">
        <span class="auth-user-icon">👤</span>
        <span class="auth-user-email">${escapeAttr(currentUser.email || '')}</span>
        <button class="btn btn-sm btn-danger" id="auth-logout-btn">Déconnexion</button>
      </div>
      ${nonVerifie ? `
        <div class="auth-notice">
          <span>✉️ Adresse non vérifiée — l'accès Stratégie Live la demande.</span>
          <button class="btn btn-sm btn-secondary" id="auth-verify-btn">Renvoyer l'e-mail</button>
        </div>` : ''}
      <div class="auth-error" id="auth-error"></div>
    `;
    document.getElementById('auth-logout-btn')?.addEventListener('click', logout);
    document.getElementById('auth-verify-btn')?.addEventListener('click', onSendVerification);
    return;
  }

  // ── Anonyme ou déconnecté ───────────────────────────────
  const signup = _authMode === 'signup';
  container.innerHTML = `
    <div class="auth-login-form">
      <div class="auth-form-title">${signup ? 'Créer un compte' : 'Connexion team'}</div>
      <input class="form-input form-input-sm" type="email" id="auth-email"
             placeholder="Adresse e-mail" autocomplete="email">
      <input class="form-input form-input-sm" type="password" id="auth-pass"
             placeholder="Mot de passe" autocomplete="${signup ? 'new-password' : 'current-password'}">
      <button class="btn btn-sm btn-primary" id="auth-submit-btn">
        ${signup ? 'Créer mon compte' : 'Connexion'}
      </button>
      <div class="auth-links">
        <button class="btn-link" id="auth-toggle-btn">
          ${signup ? "J'ai déjà un compte" : 'Créer un compte'}
        </button>
        ${signup ? '' : '<button class="btn-link" id="auth-reset-btn">Mot de passe oublié</button>'}
      </div>
      <div class="auth-error" id="auth-error"></div>
    </div>
  `;

  document.getElementById('auth-submit-btn')
    ?.addEventListener('click', () => (signup ? onSignupClick() : onLoginClick()));
  document.getElementById('auth-toggle-btn')?.addEventListener('click', () => {
    _authMode = signup ? 'login' : 'signup';
    renderAuthUI();
  });
  document.getElementById('auth-reset-btn')?.addEventListener('click', onResetClick);
  document.getElementById('auth-pass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (signup ? onSignupClick() : onLoginClick());
  });
}

/** Échappement minimal pour une insertion en texte — l'adresse vient du
 *  fournisseur d'identité, mais elle traverse une interpolation HTML. */
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setAuthError(msg, kind = 'error') {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'auth-error' + (kind === 'ok' ? ' auth-error--ok' : '');
}

// ─────────────────────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────────────────────

const AUTH_SDK = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const AUTH_MESSAGES = {
  'auth/user-not-found':          'Utilisateur introuvable.',
  'auth/wrong-password':          'Mot de passe incorrect.',
  'auth/invalid-email':           'Adresse e-mail invalide.',
  'auth/too-many-requests':       'Trop de tentatives. Réessayez plus tard.',
  'auth/invalid-credential':      'Identifiants invalides.',
  'auth/email-already-in-use':    'Un compte existe déjà avec cette adresse.',
  'auth/weak-password':           'Mot de passe trop court (6 caractères minimum).',
  'auth/missing-email':           'Adresse e-mail requise.',
  'auth/operation-not-allowed':   "La création de compte n'est pas activée sur ce projet Firebase.",
};

function lire() {
  return {
    email: document.getElementById('auth-email')?.value?.trim() || '',
    pass:  document.getElementById('auth-pass')?.value || '',
  };
}

async function onLoginClick() {
  const { email, pass } = lire();
  if (!email || !pass) { setAuthError('Adresse et mot de passe requis.'); return; }
  try {
    setAuthError('');
    const { signInWithEmailAndPassword } = await import(AUTH_SDK);
    await signInWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged prend le relais.
  } catch (err) {
    console.error('Login error:', err);
    setAuthError(AUTH_MESSAGES[err.code] || 'Erreur de connexion.');
  }
}

/**
 * Création de compte.
 *
 * L'e-mail de vérification part immédiatement : les règles Firestore
 * exigent une adresse vérifiée pour lire une licence, donc un compte non
 * vérifié ne verrait jamais son accès. Autant le demander tout de suite
 * plutôt qu'au moment où l'utilisateur cherche à s'en servir.
 *
 * Le document `users/{uid}` est créé dans la foulée, avec l'adresse du
 * jeton — c'est ce qui permet à l'administrateur de retrouver le compte
 * pour le rattacher à un team. Sans lui, un client tout juste inscrit
 * serait invisible.
 */
async function onSignupClick() {
  const { email, pass } = lire();
  if (!email || !pass) { setAuthError('Adresse et mot de passe requis.'); return; }
  try {
    setAuthError('');
    const { createUserWithEmailAndPassword, sendEmailVerification } = await import(AUTH_SDK);
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    try { await sendEmailVerification(cred.user); } catch (e) { console.warn('Verification mail:', e); }
    await ensureUserDoc(cred.user);
    _authMode = 'login';
    toast('Compte créé. Vérifiez votre boîte e-mail.', 'success', 6000);
  } catch (err) {
    console.error('Signup error:', err);
    setAuthError(AUTH_MESSAGES[err.code] || 'Erreur à la création du compte.');
  }
}

async function onResetClick() {
  const { email } = lire();
  if (!email) { setAuthError('Saisissez votre adresse, puis relancez.'); return; }
  try {
    const { sendPasswordResetEmail } = await import(AUTH_SDK);
    await sendPasswordResetEmail(auth, email);
    setAuthError('E-mail de réinitialisation envoyé.', 'ok');
  } catch (err) {
    console.error('Reset error:', err);
    setAuthError(AUTH_MESSAGES[err.code] || "Erreur d'envoi.");
  }
}

async function onSendVerification() {
  if (!currentUser) return;
  try {
    const { sendEmailVerification } = await import(AUTH_SDK);
    await sendEmailVerification(currentUser);
    setAuthError('E-mail de vérification renvoyé.', 'ok');
  } catch (err) {
    console.error('Verification error:', err);
    setAuthError(AUTH_MESSAGES[err.code] || "Erreur d'envoi.");
  }
}

/**
 * Crée `users/{uid}` s'il n'existe pas.
 *
 * Volontairement silencieux en cas d'échec : ce document sert au confort
 * de l'administrateur, pas à l'authentification. Un échec ne doit pas
 * empêcher quelqu'un de se connecter.
 */
async function ensureUserDoc(user) {
  if (!user || user.isAnonymous) return;
  try {
    const { db } = await import('./firebase.js');
    if (!db) return;
    const { doc, getDoc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    const ref = doc(db, 'users', user.uid);
    if ((await getDoc(ref)).exists()) return;
    await setDoc(ref, {
      email: user.email || '',
      displayName: user.displayName || '',
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('users/{uid} non créé :', e?.code || e?.message);
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

/** Le formulaire de connexion était masqué derrière `?login`, pour ne pas
 *  inviter le public à se connecter à un outil qui n'était qu'administratif.
 *  Il devient visible : un team qui achète un accès doit pouvoir se connecter
 *  sans URL secrète. Les vues d'édition restent masquées par `.is-admin`, et
 *  la protection réelle reste dans les règles Firestore. */
function applyLoginVisibility() {
  document.body.classList.add('show-login');
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

      // Droits commerciaux : abonnement en temps réel, pour qu'une
      // révocation prenne effet sans que le team ait à recharger.
      // Import dynamique volontaire : licenses.js lit getUser() et
      // isAdmin() d'ici, un import statique croiserait les deux modules.
      import('./access/licenses.js')
        .then(m => m.subscribeMyAccess(user))
        .catch(e => console.error('Accès commercial :', e));

      // Le document `users/{uid}` peut manquer pour un compte créé avant
      // cette version, ou si sa création avait échoué. On rattrape ici :
      // sans lui, l'administrateur ne verrait pas le compte à rattacher.
      if (user && !user.isAnonymous) ensureUserDoc(user);

      document.dispatchEvent(
        new CustomEvent('authchange', { detail: { user } })
      );
    });
  } catch (err) {
    console.error('Auth init error:', err);
  }
}
