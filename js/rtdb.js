/* ═══════════════════════════════════════════════
   RTDB.JS — Miroir Realtime Database (lecture peu coûteuse)

   Firestore facture une lecture PAR document ET PAR écouteur connecté :
   avec beaucoup de spectateurs/commentateurs qui regardent la même session
   en direct, le coût réel est (lectures Firestore) × (nombre de viewers).
   La Realtime Database facture en bande passante/connexions, pas par
   lecture × écouteur — beaucoup moins cher pour ce cas précis (1 régie
   écrit, N spectateurs ne font que lire).

   Règle stricte : Firestore reste la SEULE source de vérité, écrite en
   premier systématiquement. RTDB n'est qu'un miroir de lecture, écrit en
   best-effort (ne bloque et ne fait jamais échouer la saisie régie) et
   jamais utilisé comme référence pour un calcul (championnat, scores…).

   Tant qu'aucune `databaseURL` n'est configurée (cf. js/config.js), tout
   ici se dégrade silencieusement vers Firestore : zéro changement de
   comportement pour un déploiement qui n'a pas activé RTDB.
═══════════════════════════════════════════════ */

import { db, getRtdb } from './firebase.js';

/** Écrit/fusionne une valeur RTDB. Best-effort : ne lève jamais. */
export async function setRtdbValue(path, data) {
  try {
    const rtdb = await getRtdb();
    if (!rtdb) return;
    const { ref, update } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'
    );
    await update(ref(rtdb, path), data);
  } catch (err) {
    console.warn('[rtdb] miroir', path, err?.message || err);
  }
}

/** Supprime une valeur RTDB (best-effort, mêmes garanties que setRtdbValue). */
export async function removeRtdbValue(path) {
  try {
    const rtdb = await getRtdb();
    if (!rtdb) return;
    const { ref, remove } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'
    );
    await remove(ref(rtdb, path));
  } catch (err) {
    console.warn('[rtdb] suppression', path, err?.message || err);
  }
}

/**
 * Mirrore un résultat (`results/{sessionId}_{driverId}` côté Firestore)
 * vers `results/{sessionId}/{driverId}` côté RTDB. Appelé APRÈS
 * l'écriture Firestore réussie, jamais à sa place.
 */
export function mirrorResult(sessionId, driverId, data) {
  setRtdbValue(`results/${sessionId}/${driverId}`, data);
}

/** Mirrore la suppression d'un résultat. */
export function mirrorClearResult(sessionId, driverId) {
  removeRtdbValue(`results/${sessionId}/${driverId}`);
}

/**
 * Abonnement temps réel brut à un nœud RTDB. Rend `null` si RTDB n'est
 * pas configuré (repli Firestore à la charge de l'appelant).
 */
async function watchRtdbValue(path, cb, onErr) {
  const rtdb = await getRtdb();
  if (!rtdb) return null;
  const { ref, onValue } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'
  );
  const unsub = onValue(ref(rtdb, path), snap => cb(snap.val()), err => {
    console.error('[rtdb] lecture', path, err.message);
    onErr && onErr(err);
  });
  return () => unsub();
}

/**
 * Résultats d'une session, RTDB si configuré sinon Firestore — même forme
 * de callback dans les deux cas (tableau de lignes `{id, driverId, ...}`,
 * identique à ce que renvoyait l'ancien `onSnapshot` filtré par sessionId).
 */
export async function watchSessionResultsRtdb(sessionId, cb, onErr) {
  const unsub = await watchRtdbValue(`results/${sessionId}`, val => {
    cb(val ? Object.entries(val).map(([driverId, row]) => ({ id: driverId, driverId, ...row })) : []);
  }, onErr);
  if (unsub) return unsub;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  return onSnapshot(query(collection(db, 'results'), where('sessionId', '==', sessionId)),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => { console.error('[rtdb] repli Firestore results', err.code, err.message); onErr && onErr(err); });
}
