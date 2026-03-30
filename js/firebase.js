/* ═══════════════════════════════════════════════
   FIREBASE.JS — Initialisation Firebase depuis localStorage
   Les clés ne sont jamais codées en dur.
═══════════════════════════════════════════════ */

import { setFirebaseStatus } from './app.js';

// Instance Firestore exportée (null tant que non initialisé)
export let db = null;

// ─────────────────────────────────────────────────────────
// CLÉ DE STOCKAGE LOCAL
// ─────────────────────────────────────────────────────────
const LS_KEY = 'rx_firebase_config';

/**
 * Récupère la config Firebase depuis localStorage.
 * @returns {object|null}
 */
export function getStoredConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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
    db = getFirestore(app);

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