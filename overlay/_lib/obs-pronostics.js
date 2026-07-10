/* ═══════════════════════════════════════════════
   OBS-PRONOSTICS.JS — Pronostics spectateurs
   1 pronostic = 1 document `pronostics/{id}` (question + pilotes + statut).
   Les votes vivent en sous-collection `pronostics/{id}/votes/{uid}`
   (1 doc par spectateur → recharger la page ne recrée pas de vote).

   Confidentialité (cf. règles Firestore) :
   - lecture du doc pronostic : publique (question, pilotes, statut, et
     décompte agrégé `tally` écrit UNIQUEMENT à la fermeture) ;
   - lecture des votes individuels : régie (compte non-anonyme) seulement ;
   - un spectateur ne peut lire/écrire QUE son propre vote, et seulement
     tant que le pronostic est « open ».

   Même app Firebase que les overlays (init idempotente partagée).
═══════════════════════════════════════════════ */

import { db, initFirebase } from './obs-firebase.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
let _fs = null, _auth = null;

async function fs() { if (!_fs) _fs = await import(SDK + 'firebase-firestore.js'); return _fs; }
async function authMod() { if (!_auth) _auth = await import(SDK + 'firebase-auth.js'); return _auth; }

export const PRONO_COL = 'pronostics';

/** Statuts d'un pronostic. */
export const PRONO_STATUS = { DRAFT: 'draft', OPEN: 'open', CLOSED: 'closed', REVEALED: 'revealed' };

// ─────────────────────────────────────────────────────────
// LECTURE — publique (régie, overlay, spectateur)
// ─────────────────────────────────────────────────────────

/** Abonnement temps réel à la liste des pronostics (plus récents d'abord). */
export async function watchPronostics(cb, onErr) {
  await initFirebase();
  const { collection, query, orderBy, onSnapshot } = await fs();
  return onSnapshot(
    query(collection(db, PRONO_COL), orderBy('createdAt', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => { console.error('[prono] liste', err.code, err.message); onErr && onErr(err); }
  );
}

/** Abonnement temps réel à un pronostic unique (pour l'overlay à l'antenne). */
export async function watchPronostic(id, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, PRONO_COL, id),
    s => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    err => { console.error('[prono] doc', err.code, err.message); onErr && onErr(err); });
}

// ─────────────────────────────────────────────────────────
// RÉGIE — écriture (compte non-anonyme requis par les règles)
// ─────────────────────────────────────────────────────────

/**
 * Crée un pronostic (statut brouillon par défaut).
 * @param {{question,type,category,meetingId,championshipId,options,status?}} data
 * @returns {Promise<string>} id du nouveau doc
 */
export async function createPronostic(data, nowMs) {
  await initFirebase();
  const { collection, addDoc } = await fs();
  const ref = await addDoc(collection(db, PRONO_COL), {
    question:       data.question || '',
    type:           data.type || 'custom',
    category:       data.category || '',
    meetingId:      data.meetingId || '',
    championshipId: data.championshipId || '',
    options:        Array.isArray(data.options) ? data.options : [],
    status:         data.status || PRONO_STATUS.DRAFT,
    correctDriverId:'',
    tally:          {},
    totalVotes:     0,
    createdAt:      nowMs || Date.now(),
  });
  return ref.id;
}

/** Met à jour (merge) un pronostic. */
export async function updatePronostic(id, patch) {
  await initFirebase();
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, PRONO_COL, id), patch, { merge: true });
}

/** Supprime un pronostic (les votes en sous-collection restent orphelins côté Firestore ; sans impact d'affichage). */
export async function deletePronostic(id) {
  await initFirebase();
  const { doc, deleteDoc } = await fs();
  await deleteDoc(doc(db, PRONO_COL, id));
}

/** Ouvre les votes. */
export function openPronostic(id, nowMs) {
  return updatePronostic(id, { status: PRONO_STATUS.OPEN, openedAt: nowMs || Date.now(), correctDriverId: '' });
}

/**
 * Lit tous les votes et agrège le décompte par pilote.
 * @returns {Promise<{counts:Object,total:number}>}
 */
export async function tallyVotes(id) {
  await initFirebase();
  const { collection, getDocs } = await fs();
  const snap = await getDocs(collection(db, PRONO_COL, id, 'votes'));
  const counts = {}; let total = 0;
  snap.forEach(d => { const v = d.data().driverId; if (v) { counts[v] = (counts[v] || 0) + 1; total++; } });
  return { counts, total };
}

/** Ferme les votes et fige le décompte agrégé dans le doc (lisible par le public). */
export async function closePronostic(id, nowMs) {
  const t = await tallyVotes(id);
  await updatePronostic(id, {
    status: PRONO_STATUS.CLOSED, tally: t.counts, totalVotes: t.total, closedAt: nowMs || Date.now(),
  });
  return t;
}

/** Révèle le gagnant (réel) et rafraîchit le décompte figé. */
export async function revealPronostic(id, correctDriverId, nowMs) {
  const t = await tallyVotes(id);
  await updatePronostic(id, {
    status: PRONO_STATUS.REVEALED, correctDriverId: correctDriverId || '',
    tally: t.counts, totalVotes: t.total, revealedAt: nowMs || Date.now(),
  });
  return t;
}

/** Abonnement temps réel aux votes bruts (VUE RÉGIE UNIQUEMENT — décompte live privé). */
export async function watchVotes(id, cb, onErr) {
  await initFirebase();
  const { collection, onSnapshot } = await fs();
  return onSnapshot(collection(db, PRONO_COL, id, 'votes'),
    snap => {
      const counts = {}; let total = 0;
      snap.forEach(d => { const v = d.data().driverId; if (v) { counts[v] = (counts[v] || 0) + 1; total++; } });
      cb({ counts, total });
    },
    err => { console.error('[prono] votes', err.code, err.message); onErr && onErr(err); });
}

// ─────────────────────────────────────────────────────────
// SPECTATEUR — auth anonyme + vote
// ─────────────────────────────────────────────────────────

/**
 * Garantit une session anonyme SANS écraser une session existante.
 * - Page spectateur : pas d'utilisateur → connexion anonyme.
 * - Page régie : déjà connecté (email/mot de passe) → ne fait rien, renvoie l'uid régie.
 * @returns {Promise<string>} uid
 */
export async function ensureAnon() {
  await initFirebase();
  const { getAuth, signInAnonymously, onAuthStateChanged } = await authMod();
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser.uid;
  // attend l'état initial (persistance locale) avant de décider
  await new Promise(res => { const off = onAuthStateChanged(auth, () => { off(); res(); }); });
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}

/** uid courant (ou null). */
export async function currentUid() {
  await initFirebase();
  const { getAuth } = await authMod();
  return getAuth().currentUser?.uid || null;
}

/** Lit le vote du spectateur pour un pronostic (son propre doc). */
export async function myVote(id, uid) {
  await initFirebase();
  const { doc, getDoc } = await fs();
  const s = await getDoc(doc(db, PRONO_COL, id, 'votes', uid));
  return s.exists() ? (s.data().driverId || null) : null;
}

/** Abonnement temps réel au propre vote du spectateur (pour refléter un changement). */
export async function watchMyVote(id, uid, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, PRONO_COL, id, 'votes', uid),
    s => cb(s.exists() ? (s.data().driverId || null) : null),
    err => { onErr && onErr(err); });
}

/** Enregistre / modifie le vote du spectateur (autorisé tant que le pronostic est ouvert). */
export async function castVote(id, uid, driverId, nowMs) {
  await initFirebase();
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, PRONO_COL, id, 'votes', uid), { driverId, at: nowMs || Date.now() }, { merge: true });
}
