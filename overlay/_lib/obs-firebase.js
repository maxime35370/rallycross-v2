/* ═══════════════════════════════════════════════
   OBS-FIREBASE.JS — Connexion Firestore autonome pour les overlays
   Même projet Firebase que l'application principale.
   Volontairement découplé de js/firebase.js (qui dépend du shell
   de l'app : menu, statut, DOM). Ici on veut une init minimale,
   utilisable depuis une page overlay nue ou la régie.
═══════════════════════════════════════════════ */

const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';

// Config du projet (identique à js/firebase.js).
const CONFIG = {
  apiKey: "AIzaSyBv2Fh-YDX1kEnKHWxQhxXYl_x5EwRrk1E",
  authDomain: "rallycross-1512f.firebaseapp.com",
  projectId: "rallycross-1512f",
  storageBucket: "rallycross-1512f.firebasestorage.app",
  messagingSenderId: "123635957863",
  appId: "1:123635957863:web:f229eb25637dd0656794c2",
};

export let db = null;
let _fs = null;       // module firestore (mis en cache)
let _app = null;

/** Charge (une fois) le module Firestore CDN. */
async function fs() {
  if (!_fs) _fs = await import(SDK + 'firebase-firestore.js');
  return _fs;
}

/** Initialise Firebase + Firestore. Idempotent. */
export async function initFirebase() {
  if (db) return db;
  const { initializeApp, getApps } = await import(SDK + 'firebase-app.js');
  const { getFirestore } = await fs();
  _app = getApps()[0] || initializeApp(CONFIG);
  db = getFirestore(_app);
  return db;
}

// ─────────────────────────────────────────────────────────
// LECTURE
// ─────────────────────────────────────────────────────────

/**
 * Requête ponctuelle. filters = [[champ, op, valeur], ...].
 * @returns {Promise<Array<{id:string}>>}
 */
export async function fsQuery(col, filters = []) {
  const { collection, query, where, getDocs } = await fs();
  const cons = filters.map(([f, op, v]) => where(f, op, v));
  const snap = await getDocs(query(collection(db, col), ...cons));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Abonnement temps réel à une requête. Renvoie la fonction d'arrêt.
 * @param {(rows:Array)=>void} cb
 * @returns {Promise<()=>void>}
 */
export async function watchQuery(col, filters, cb) {
  const { collection, query, where, onSnapshot } = await fs();
  const cons = (filters || []).map(([f, op, v]) => where(f, op, v));
  return onSnapshot(query(collection(db, col), ...cons), snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

/** Lecture d'un document unique. */
export async function getDocById(col, id) {
  const { doc, getDoc } = await fs();
  const s = await getDoc(doc(db, col, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/** Abonnement temps réel à un document unique. Renvoie l'arrêt. */
export async function watchDoc(col, id, cb) {
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, col, id), s => cb(s.exists() ? { id: s.id, ...s.data() } : null));
}

// ─────────────────────────────────────────────────────────
// ÉCRITURE (régie uniquement — nécessite authentification)
// ─────────────────────────────────────────────────────────

/** Écrit/merge un document (utilisé par la régie sur obsControl/live). */
export async function setDocMerged(col, id, data) {
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, col, id), data, { merge: true });
}
