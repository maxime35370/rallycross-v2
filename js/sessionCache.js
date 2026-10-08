/* ═══════════════════════════════════════════════
   SESSIONCACHE.JS — cache agrégé "résultat d'une manche"

   Pour une session EC/MQ donnée, regroupe en UN SEUL document Firestore
   (collection `sessionCache`, id = sessionId) le résultat de tous ses
   pilotes, dès que chacun d'eux a un état définitif (temps ou statut
   DNS/DNF/DSQ/DSQ_RACE). Tant que ce n'est pas le cas, aucun cache n'est
   créé/conservé — getCachedResults() retombe alors sur la lecture directe
   de `results` chez l'appelant.

   Le cache est toujours régénéré en RECALCUL COMPLET (jamais incrémental),
   pour rester auto-réparant si deux onglets régie écrivent en parallèle ou
   si l'un plante avant d'avoir régénéré le cache : la prochaine écriture
   réussie, quelle qu'elle soit, repart d'une lecture fraîche de `results`.

   Volontairement limité à EC/MQ dans un premier temps : les sessions
   QF/DF/FIN sont réassignées en lot par sessions.js (auto QF/DF/Finale,
   gestion des forfaits), qui ne déclenche pas encore ce cache — l'y
   brancher viendra dans un second temps, après revue séparée de ces
   flux plus sensibles. */

const SPECIAL_STATUSES = ['DNS', 'DNF', 'DSQ', 'DSQ_RACE'];
const CACHEABLE_TYPES  = ['EC', 'MQ'];
const COLLECTION       = 'sessionCache';

async function fsHelpers() {
  return import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
}

/**
 * Une manche est "complète" quand chaque participant inscrit a un résultat
 * avec un temps OU un statut spécial. Tant qu'un seul participant n'a ni
 * l'un ni l'autre (pas encore chronométré), on ne mets pas en cache.
 *
 * @param {Array} participants — documents sessionParticipants de la session
 * @param {Array} results      — documents results de la session
 */
export function isSessionComplete(participants = [], results = []) {
  if (!participants.length) return false;
  const resultMap = new Map(results.map(r => [r.driverId, r]));
  return participants.every(p => {
    const r = resultMap.get(p.driverId);
    return !!r && (r.ms != null || SPECIAL_STATUSES.includes(r.status));
  });
}

/** Construit le document de cache à partir des résultats déjà lus. */
export function buildSessionCacheData(session, results = []) {
  return {
    sessionId:   session.id,
    meetingId:   session.meetingId ?? null,
    category:    session.category ?? null,
    year:        session.year ?? null,
    sessionType: session.type ?? null,
    results,
    updatedAt:   new Date(),
  };
}

async function fetchRaw(db, sessionId) {
  const { collection, query, where, getDocs } = await fsHelpers();
  const [resSnap, partSnap] = await Promise.all([
    getDocs(query(collection(db, 'results'), where('sessionId', '==', sessionId))),
    getDocs(query(collection(db, 'sessionParticipants'), where('sessionId', '==', sessionId))),
  ]);
  return {
    results:      resSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    participants: partSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };
}

/**
 * Régénère (ou supprime) le cache d'une session après une écriture dans
 * `results`. Toujours un recalcul complet — jamais incrémental. Best-effort :
 * une erreur ici ne doit jamais faire échouer la sauvegarde du temps elle-même,
 * donc appelée en "fire and forget" par les appelants, erreurs journalisées
 * seulement en console.
 *
 * @param {object} db
 * @param {object} session — document session (id, type, meetingId, category, year)
 */
export async function refreshSessionCache(db, session) {
  if (!db || !session?.id) return;
  if (!CACHEABLE_TYPES.includes(session.type)) return;

  try {
    const { results, participants } = await fetchRaw(db, session.id);
    const { doc, setDoc, deleteDoc } = await fsHelpers();
    const ref = doc(db, COLLECTION, session.id);

    if (isSessionComplete(participants, results)) {
      await setDoc(ref, buildSessionCacheData(session, results));
    } else {
      // Pas (ou plus) complète : on retire un cache devenu perime plutot que
      // de laisser un ancien resultat incomplet trainer (ex: un pilote
      // ajoute/retire apres coup).
      await deleteDoc(ref).catch(() => {});
    }
  } catch (err) {
    console.error('refreshSessionCache', session?.id, err);
  }
}

/**
 * Lit le cache d'une session, s'il existe. Retourne null si absent (manche
 * pas encore complète, ou type non pris en charge) — l'appelant doit alors
 * retomber sur sa lecture directe habituelle de `results`.
 */
export async function getCachedResults(db, sessionId) {
  if (!db || !sessionId) return null;
  try {
    const { doc, getDoc } = await fsHelpers();
    const snap = await getDoc(doc(db, COLLECTION, sessionId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return Array.isArray(data?.results) ? data.results : null;
  } catch (err) {
    console.error('getCachedResults', sessionId, err);
    return null;
  }
}
