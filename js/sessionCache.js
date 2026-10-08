/* ═══════════════════════════════════════════════
   SESSIONCACHE.JS — cache agrégé "résultat d'une manche" + "meeting complet"

   Pour une session (EC/MQ/QF/DF/FIN) donnée, regroupe en UN SEUL document Firestore
   (collection `sessionCache`, id = sessionId) le résultat de tous ses
   pilotes, dès que chacun d'eux a un état définitif (temps ou statut
   DNS/DNF/DSQ/DSQ_RACE). Tant que ce n'est pas le cas, aucun cache n'est
   créé/conservé — getCachedResults() retombe alors sur la lecture directe
   de `results` chez l'appelant.

   Le cache est toujours régénéré en RECALCUL COMPLET (jamais incrémental),
   pour rester auto-réparant si deux onglets régie écrivent en parallèle ou
   si l'un plante avant d'avoir régénéré le cache : la prochaine écriture
   réussie, quelle qu'elle soit, repart d'une lecture fraîche de `results`.

   QF/DF/FIN sont réassignées EN LOT par sessions.js (auto QF/DF/Finale,
   gestion des forfaits) : chaque réassignation vide `results` avant de
   réaffecter les participants, donc sessions.js appelle explicitement
   invalidateSessionCache() juste après chaque vidage, pour ne jamais
   laisser un ancien cache "complet" survivre à une redistribution.

   CACHE MEETING (toutes divisions confondues) — au lieu de revérifier
   l'état de chaque manche à chaque fois, un compteur par meeting
   (`meetingCacheProgress/{meetingId}`, { completeCount, totalSessions })
   est ajusté de ±1 chaque fois qu'une manche change d'état complet/
   incomplet. Dès que completeCount atteint totalSessions, le cache
   meeting (`meetingCache/{meetingId}`) est construit en regroupant le
   cache de chaque manche. Lecture/écriture du compteur + de la manche
   se fait dans UNE SEULE transaction Firestore pour rester correct même
   si deux manches de catégories différentes se terminent en même temps. */

const SPECIAL_STATUSES      = ['DNS', 'DNF', 'DSQ', 'DSQ_RACE'];
const CACHEABLE_TYPES       = ['EC', 'MQ', 'QF', 'DF', 'FIN'];
const COLLECTION            = 'sessionCache';
const PROGRESS_COLLECTION   = 'meetingCacheProgress';
const MEETING_COLLECTION    = 'meetingCache';

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

/** Liste des sessionId de TOUTES les catégories d'un meeting (pas filtré
 *  par catégorie, contrairement aux lectures habituelles de l'app). */
async function getMeetingSessionIds(db, meetingId) {
  const { collection, query, where, getDocs } = await fsHelpers();
  const snap = await getDocs(query(collection(db, 'sessions'), where('meetingId', '==', meetingId)));
  return snap.docs.map(d => d.id);
}

/**
 * Applique en UNE transaction : l'écriture (ou suppression) du cache de la
 * session, puis — seulement si son état complet/incomplet a changé — l'ajustement
 * du compteur du meeting et, le cas échéant, la construction/suppression du
 * cache meeting. Toutes les lectures de la transaction sont faites avant la
 * moindre écriture (règle Firestore : get() puis set()/delete(), jamais l'inverse).
 */
async function applySessionTransition(db, session, isComplete, cacheData) {
  const { doc, runTransaction } = await fsHelpers();
  const cacheRef = doc(db, COLLECTION, session.id);

  // Sans meetingId, pas de suivi de compteur possible : on se contente de
  // l'écriture/suppression du cache de la session elle-même, hors transaction.
  if (!session.meetingId) {
    const { setDoc, deleteDoc } = await fsHelpers();
    if (isComplete) await setDoc(cacheRef, cacheData);
    else await deleteDoc(cacheRef).catch(() => {});
    return;
  }

  const sessionIds   = await getMeetingSessionIds(db, session.meetingId);
  const totalSessions = sessionIds.length;
  const progressRef  = doc(db, PROGRESS_COLLECTION, session.meetingId);
  const meetingRef   = doc(db, MEETING_COLLECTION, session.meetingId);

  await runTransaction(db, async (tx) => {
    // ── 1. LECTURES ──
    const cacheSnap    = await tx.get(cacheRef);
    const wasComplete  = cacheSnap.exists();
    const transitioned = wasComplete !== isComplete;

    let newCount = null;
    if (transitioned) {
      const progressSnap = await tx.get(progressRef);
      const prevCount = progressSnap.exists() ? (progressSnap.data().completeCount || 0) : 0;
      newCount = Math.max(0, prevCount + (isComplete ? 1 : -1));
    }

    const shouldBuildMeeting = transitioned && totalSessions > 0 && newCount >= totalSessions;

    let otherSessionCaches = null;
    if (shouldBuildMeeting) {
      otherSessionCaches = [];
      for (const id of sessionIds) {
        if (id === session.id) { otherSessionCaches.push({ id, data: cacheData }); continue; }
        const s = await tx.get(doc(db, COLLECTION, id));
        otherSessionCaches.push({ id, data: s.exists() ? s.data() : null });
      }
    }

    let meetingExistedBefore = false;
    if (transitioned && !shouldBuildMeeting) {
      meetingExistedBefore = (await tx.get(meetingRef)).exists();
    }

    // ── 2. ÉCRITURES ──
    if (isComplete) tx.set(cacheRef, cacheData);
    else if (wasComplete) tx.delete(cacheRef);

    if (!transitioned) return;

    tx.set(progressRef, {
      meetingId: session.meetingId, completeCount: newCount, totalSessions, updatedAt: new Date(),
    });

    if (shouldBuildMeeting) {
      const allPresent = otherSessionCaches.every(s => s.data);
      if (allPresent) {
        const sessions = {};
        otherSessionCaches.forEach(s => { sessions[s.id] = s.data; });
        tx.set(meetingRef, { meetingId: session.meetingId, sessions, updatedAt: new Date() });
      }
    } else if (meetingExistedBefore) {
      tx.delete(meetingRef);
    }
  });
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
    const complete  = isSessionComplete(participants, results);
    const cacheData = complete ? buildSessionCacheData(session, results) : null;
    await applySessionTransition(db, session, complete, cacheData);
  } catch (err) {
    console.error('refreshSessionCache', session?.id, err);
  }
}

/**
 * Supprime sans recalcul le cache d'une session dont on sait que `results`
 * vient d'être vidé (réassignation QF/DF/Finale, forfait) : moins cher
 * qu'un refreshSessionCache (pas de relecture), le cache se recréera de
 * lui-même dès la prochaine saisie de temps complète via timing.js.
 *
 * @param {object} db
 * @param {object} session — document session (id, type, meetingId, category, year)
 */
export async function invalidateSessionCache(db, session) {
  if (!db || !session?.id) return;
  try {
    await applySessionTransition(db, session, false, null);
  } catch (err) {
    console.error('invalidateSessionCache', session?.id, err);
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

/**
 * Lit le cache d'un meeting entier (toutes catégories), s'il existe —
 * c-à-d si TOUTES ses manches sont complètes. Retourne null sinon ;
 * l'appelant retombe alors sur une lecture manche par manche.
 * @returns {Promise<null|Object<string,object>>} { sessionId → doc de cache de la manche }
 */
export async function getCachedMeetingResults(db, meetingId) {
  if (!db || !meetingId) return null;
  try {
    const { doc, getDoc } = await fsHelpers();
    const snap = await getDoc(doc(db, MEETING_COLLECTION, meetingId));
    if (!snap.exists()) return null;
    const data = snap.data();
    return data?.sessions && typeof data.sessions === 'object' ? data.sessions : null;
  } catch (err) {
    console.error('getCachedMeetingResults', meetingId, err);
    return null;
  }
}
