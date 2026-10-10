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
  // Realtime Database (miroir "lecture temps réel à faible coût" des
  // résultats et de l'état régie — voir obs-rtdb-mirror.js). Laisser vide
  // tant que la base n'a pas été créée dans la console Firebase : tout le
  // code RTDB se dégrade silencieusement vers Firestore si ce champ est
  // absent, aucune régression pour un déploiement qui n'en a pas besoin.
  databaseURL: "https://rallycross-1512f-default-rtdb.europe-west1.firebasedatabase.app",
};

export let db = null;
export let rtdb = null;
let _fs = null;       // module firestore (mis en cache)
let _rtdbMod = null;  // module database (mis en cache)
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

/** true si une Realtime Database est configurée pour ce déploiement. */
export function rtdbConfigured() {
  return !!CONFIG.databaseURL;
}

/**
 * Initialise (lazy, idempotent) la Realtime Database. Rend `null` si
 * aucune `databaseURL` n'est configurée — tout le code appelant doit
 * tolérer ce cas (dégradation vers Firestore).
 */
async function initRtdb() {
  if (!CONFIG.databaseURL) return null;
  if (rtdb) return rtdb;
  if (!_app) await initFirebase();
  if (!_rtdbMod) _rtdbMod = await import(SDK + 'firebase-database.js');
  rtdb = _rtdbMod.getDatabase(_app, CONFIG.databaseURL);
  return rtdb;
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
 * @param {(err:Error)=>void} [onErr]
 * @returns {Promise<()=>void>}
 */
export async function watchQuery(col, filters, cb, onErr) {
  const { collection, query, where, onSnapshot } = await fs();
  const cons = (filters || []).map(([f, op, v]) => where(f, op, v));
  return onSnapshot(query(collection(db, col), ...cons),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => { console.error('[overlay] lecture', col, err.code, err.message); onErr && onErr(err); });
}

/** Lecture d'un document unique. */
export async function getDocById(col, id) {
  const { doc, getDoc } = await fs();
  const s = await getDoc(doc(db, col, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/** Abonnement temps réel à un document unique. Renvoie l'arrêt. */
export async function watchDoc(col, id, cb, onErr) {
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, col, id),
    s => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    err => { console.error('[overlay] lecture', col + '/' + id, err.code, err.message); onErr && onErr(err); });
}

// ─────────────────────────────────────────────────────────
// ÉCRITURE (régie uniquement — nécessite authentification)
// ─────────────────────────────────────────────────────────

/** Écrit/merge un document (utilisé par la régie sur obsControl/live). */
export async function setDocMerged(col, id, data) {
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, col, id), data, { merge: true });
}

// ─────────────────────────────────────────────────────────
// REALTIME DATABASE — miroir « lecture peu coûteuse » des données très
// lues en direct (résultats de session, état régie `obsControl`). RTDB
// facture en bande passante/connexions plutôt qu'en lecture × nombre
// d'écouteurs : bien moins cher que Firestore quand beaucoup de
// spectateurs/commentateurs regardent la même donnée en même temps.
// Purement un MIROIR DE LECTURE : Firestore reste la source de vérité
// (écrite en premier, toujours), RTDB ne sert jamais de référence pour un
// calcul (championnat, scores...). Dégradation automatique vers Firestore
// tant que `databaseURL` n'est pas configuré (cf. CONFIG plus haut) — zéro
// changement de comportement pour un déploiement sans RTDB.
// ─────────────────────────────────────────────────────────

/** Écrit/fusionne une valeur RTDB. Best-effort : ne lève jamais — appelé
 *  côté régie EN PLUS de l'écriture Firestore, jamais à sa place. */
export async function setRtdbValue(path, data) {
  try {
    const d = await initRtdb();
    if (!d) return;
    const { ref, update } = _rtdbMod;
    await update(ref(d, path), data);
  } catch (err) {
    console.warn('[overlay] miroir RTDB', path, err?.message || err);
  }
}

/** Supprime une valeur RTDB (best-effort, mêmes garanties que setRtdbValue). */
export async function removeRtdbValue(path) {
  try {
    const d = await initRtdb();
    if (!d) return;
    const { ref, remove } = _rtdbMod;
    await remove(ref(d, path));
  } catch (err) {
    console.warn('[overlay] suppression RTDB', path, err?.message || err);
  }
}

/**
 * Abonnement temps réel brut à un nœud RTDB. Rend `null` si RTDB n'est pas
 * configuré (à l'appelant de se replier sur Firestore dans ce cas).
 */
export async function watchRtdbValue(path, cb, onErr) {
  const d = await initRtdb();
  if (!d) return null;
  const { ref, onValue } = _rtdbMod;
  const unsub = onValue(ref(d, path), snap => cb(snap.val()), err => {
    console.error('[overlay] lecture RTDB', path, err.message);
    onErr && onErr(err);
  });
  return () => unsub();
}

/**
 * Résultats d'une session, RTDB si configuré sinon Firestore (même forme
 * de callback dans les deux cas : tableau de lignes `{id, driverId, ...}`).
 * Partagé par overlay/live.html, control.html (gagnants auto des
 * pronostics) — tout endroit qui écoute `results` par sessionId.
 */
export async function watchSessionResults(sessionId, cb, onErr) {
  const unsub = await watchRtdbValue(`results/${sessionId}`, val => {
    cb(val ? Object.entries(val).map(([driverId, row]) => ({ id: driverId, driverId, ...row })) : []);
  }, onErr);
  if (unsub) {
    backfillRtdbResults(sessionId);   // comble les temps déjà saisis avant/hors miroir — cf. plus bas
    return unsub;
  }
  return watchQuery('results', [['sessionId', '==', sessionId]], cb, onErr);
}

/**
 * Comble le miroir RTDB d'une session avec les temps déjà présents dans
 * Firestore mais absents de RTDB (saisis avant l'activation du miroir, ou
 * par un chemin qui ne le met pas encore à jour). Best-effort, 1 seule
 * lecture Firestore par appel (pas un écouteur) : sans ce correctif, une
 * session déjà en cours affiche un pilote comme « à passer » alors qu'il a
 * déjà un temps, puisque RTDB ne connaît que ce qui a été écrit après coup.
 */
async function backfillRtdbResults(sessionId) {
  try {
    const existing = await fsQuery('results', [['sessionId', '==', sessionId]]);
    existing.forEach(r => {
      // RTDB ne sait pas sérialiser un Timestamp Firestore — on le réduit en nombre.
      const row = { ...r };
      if (row.updatedAt?.toMillis) row.updatedAt = row.updatedAt.toMillis();
      if (row.createdAt?.toMillis) row.createdAt = row.createdAt.toMillis();
      setRtdbValue(`results/${sessionId}/${row.driverId}`, row);
    });
  } catch (err) {
    console.warn('[overlay] comblement RTDB results', sessionId, err?.message || err);
  }
}

/**
 * État régie (`obsControl/{docId}`), RTDB si configuré sinon Firestore —
 * valeur brute (non fusionnée avec DEFAULT_CONTROL, cf. obs-control.js).
 */
export async function watchControlState(docId, cb, onErr) {
  const unsub = await watchRtdbValue(`obsControl/${docId}`, cb, onErr);
  if (unsub) return unsub;
  return watchDoc('obsControl', docId, cb, onErr);
}
