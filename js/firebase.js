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