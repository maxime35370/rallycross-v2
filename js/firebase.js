/* ═══════════════════════════════════════════════
   FIREBASE.JS — Initialisation Firebase
   Config par defaut integree, surchargeable via localStorage.
═══════════════════════════════════════════════ */

import { setFirebaseStatus } from './app.js';

// Instance Firestore exportée (null tant que non initialisé)
export let db = null;

// ─────────────────────────────────────────────────────────
// CONFIG PAR DÉFAUT
// ─────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  apiKey: "AIzaSyBv2Fh-YDX1kEnKHWxQhxXYl_x5EwRrk1E",
  authDomain: "rallycross-1512f.firebaseapp.com",
  projectId: "rallycross-1512f",
  storageBucket: "rallycross-1512f.firebasestorage.app",
  messagingSenderId: "123635957863",
  appId: "1:123635957863:web:f229eb25637dd0656794c2",
};

// ─────────────────────────────────────────────────────────
// CLÉ DE STOCKAGE LOCAL
// ─────────────────────────────────────────────────────────
const LS_KEY = 'rx_firebase_config';

/**
 * Récupère la config Firebase : localStorage en priorité, sinon config par défaut.
 * @returns {object|null}
 */
export function getStoredConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

/**
 * Sauvegarde la config Firebase dans localStorage.
 * @param {object} config
 */
export function saveConfig(config) {
  localStorage.setItem(LS_KEY, JSON.stringify(config));
}

/**
 * Supprime la config Firebase du localStorage.
 */
export function clearConfig() {
  localStorage.removeItem(LS_KEY);
}

// ─────────────────────────────────────────────────────────
// INITIALISATION
// ─────────────────────────────────────────────────────────

/**
 * Tente d'initialiser Firebase avec la config stockée.
 * Met à jour l'indicateur de statut dans le menu.
 */
export async function initFirebase() {
  const config = getStoredConfig();

  if (!config || !config.projectId) {
    setFirebaseStatus('disconnected', 'Firebase non configuré');
    return false;
  }

  try {
    setFirebaseStatus('pending', 'Connexion…');

    // Import dynamique du SDK Firebase (via CDN ESM)
    const { initializeApp, getApps, deleteApp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'
    );
    const { getFirestore } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    // Éviter les doublons d'initialisation (hot-reload)
    getApps().forEach(app => deleteApp(app));

    const app = initializeApp(config);

    // Initialiser Firestore avec cache offline persistent
    const { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch {
      // Fallback si deja initialise ou non supporte
      db = getFirestore(app);
    }

    await maybeConnectEmulators(app);

    setFirebaseStatus('connected', `Connecté · ${config.projectId}`);
    return true;

  } catch (err) {
    console.error('Firebase init error:', err);
    setFirebaseStatus('disconnected', 'Erreur de connexion');
    return false;
  }
}

/**
 * Retourne true si Firebase est initialisé.
 */
export function isReady() {
  return db !== null;
}

// ─────────────────────────────────────────────────────────
// ÉMULATEURS — DÉVELOPPEMENT LOCAL UNIQUEMENT
// ─────────────────────────────────────────────────────────

/**
 * Bascule l'application sur les émulateurs Firestore et Auth.
 *
 * DOUBLE VERROU, et les deux comptent :
 *   1. l'hôte doit être `localhost` ou `127.0.0.1` ;
 *   2. l'URL doit porter `?emulator`.
 *
 * Ni l'un ni l'autre ne peut être satisfait sur rxchrono.netlify.app. Même
 * si quelqu'un ajoutait le paramètre, le premier verrou refuserait — et
 * dans le pire des cas, le navigateur pointerait vers un port de sa propre
 * machine, où il n'y a rien. Aucune donnée de production n'est joignable
 * par ce chemin.
 *
 * À quoi ça sert : pouvoir lancer l'application complète contre des données
 * de test, pour vérifier un écran réellement plutôt que sur parole.
 */
async function maybeConnectEmulators(app) {
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const demande = /[?&]emulator(=|&|$)/.test(window.location.search);
  if (!local || !demande) return;

  try {
    const { connectFirestoreEmulator } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    connectFirestoreEmulator(db, '127.0.0.1', 8080);

    const { getAuth, connectAuthEmulator } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'
    );
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });

    console.info('[firebase] ÉMULATEURS LOCAUX — aucune donnée de production');
    document.body?.setAttribute('data-emulator', '1');
  } catch (err) {
    console.error('[firebase] émulateurs injoignables', err);
  }
}