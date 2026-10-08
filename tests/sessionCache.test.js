/* SESSIONCACHE — le cache ne doit se (re)créer QUE quand chaque participant
   a un état définitif (temps ou statut), disparaître sinon, et la lecture
   via getResults() (calc.js) doit alors coûter 1 document au lieu de N.

   Le SDK Firestore est chargé depuis un CDN ; on le remplace ici par une
   base en mémoire (tests/helpers/fakeFirestore.js, alias dans vitest.config.js). */

import { describe, it, expect, beforeEach } from 'vitest';

const { store, counter } = (globalThis.__fakeFirestore ||= {
  store: {},
  counter: { docs: 0, queries: 0 },
});

const {
  isSessionComplete, buildSessionCacheData, refreshSessionCache, getCachedResults,
  invalidateSessionCache, getCachedMeetingResults,
} = await import('../js/sessionCache.js');
const { getResults } = await import('../js/calc.js');

function seedSession(sessionId, { type = 'MQ', n = 5, allDone = true } = {}) {
  store.sessionParticipants = store.sessionParticipants || [];
  store.results = store.results || [];
  for (let d = 1; d <= n; d++) {
    const driverId = `d${d}`;
    store.sessionParticipants.push({
      id: `${sessionId}_${driverId}`, sessionId, driverId,
      carNumber: d, firstName: `P${d}`, lastName: `N${d}`,
    });
    const hasResult = allDone || d < n; // si !allDone, le dernier pilote reste sans résultat
    if (hasResult) {
      store.results.push({
        id: `${sessionId}_${driverId}`, sessionId, driverId,
        ms: d === 1 ? null : 60000 + d, status: d === 1 ? 'DNF' : null,
      });
    }
  }
  return { id: sessionId, type, meetingId: 'M1', category: 'Supercar', year: 2026 };
}

/** Déclare N sessions d'un meeting (plusieurs catégories) dans la fausse
 *  collection `sessions`, nécessaire pour que getMeetingSessionIds() sache
 *  combien de manches sont prévues en tout. */
function seedMeetingSessions(meetingId, sessionIds) {
  store.sessions = store.sessions || [];
  for (const id of sessionIds) store.sessions.push({ id, meetingId });
}

beforeEach(() => {
  store.sessionParticipants = [];
  store.results = [];
  store.sessionCache = [];
  store.sessions = [];
  store.meetingCacheProgress = [];
  store.meetingCache = [];
  counter.docs = 0;
  counter.queries = 0;
});

describe('isSessionComplete', () => {
  it('false si un participant n\'a ni temps ni statut', () => {
    const participants = [{ driverId: 'd1' }, { driverId: 'd2' }];
    const results = [{ driverId: 'd1', ms: 60000, status: null }];
    expect(isSessionComplete(participants, results)).toBe(false);
  });

  it('true si chaque participant a un temps ou un statut special', () => {
    const participants = [{ driverId: 'd1' }, { driverId: 'd2' }];
    const results = [
      { driverId: 'd1', ms: 60000, status: null },
      { driverId: 'd2', ms: null, status: 'DNS' },
    ];
    expect(isSessionComplete(participants, results)).toBe(true);
  });

  it('false si aucun participant (rien à mettre en cache)', () => {
    expect(isSessionComplete([], [])).toBe(false);
  });
});

describe('refreshSessionCache / getCachedResults', () => {
  it('crée le cache quand la manche MQ est complète', async () => {
    const session = seedSession('MQ1', { type: 'MQ', n: 5, allDone: true });
    await refreshSessionCache({}, session);
    const cached = await getCachedResults({}, 'MQ1');
    expect(cached).not.toBeNull();
    expect(cached.length).toBe(5);
  });

  it('ne crée pas le cache tant qu\'un pilote n\'a pas de résultat', async () => {
    const session = seedSession('MQ2', { type: 'MQ', n: 5, allDone: false });
    await refreshSessionCache({}, session);
    const cached = await getCachedResults({}, 'MQ2');
    expect(cached).toBeNull();
  });

  it('supprime un cache devenu obsolète (pilote retiré, plus complet)', async () => {
    const session = seedSession('MQ3', { type: 'MQ', n: 5, allDone: true });
    await refreshSessionCache({}, session);
    expect(await getCachedResults({}, 'MQ3')).not.toBeNull();

    // Un 6e pilote est ajouté sans résultat encore saisi : la manche n'est
    // plus complète, le cache doit disparaître plutôt que de rester affiché
    // avec un pilote manquant.
    store.sessionParticipants.push({ id: 'MQ3_d6', sessionId: 'MQ3', driverId: 'd6', carNumber: 6 });
    await refreshSessionCache({}, session);
    expect(await getCachedResults({}, 'MQ3')).toBeNull();
  });

  it('prend aussi en charge QF/DF/FIN', async () => {
    const session = seedSession('FIN1', { type: 'FIN', n: 8, allDone: true });
    await refreshSessionCache({}, session);
    const cached = await getCachedResults({}, 'FIN1');
    expect(cached).not.toBeNull();
    expect(cached.length).toBe(8);
  });

  it('invalidateSessionCache supprime sans recalcul (réassignation QF/DF/Finale)', async () => {
    const session = seedSession('DF1', { type: 'DF', n: 8, allDone: true });
    await refreshSessionCache({}, session);
    expect(await getCachedResults({}, 'DF1')).not.toBeNull();

    await invalidateSessionCache({}, session);
    expect(await getCachedResults({}, 'DF1')).toBeNull();
  });
});

describe('getResults() (calc.js) : lit le cache quand il existe', () => {
  it('coûte 1 document via le cache au lieu de N en lecture directe', async () => {
    const session = seedSession('MQ4', { type: 'MQ', n: 20, allDone: true });
    await refreshSessionCache({}, session);

    counter.docs = 0; counter.queries = 0;
    const viaCache = await getResults({}, 'MQ4');
    expect(viaCache.length).toBe(20);
    expect(counter.docs).toBe(1); // 1 lecture du doc de cache, pas 20

    // Retombe sur la lecture directe tant qu'aucun cache n'existe.
    const sessionIncomplete = seedSession('MQ5', { type: 'MQ', n: 20, allDone: false });
    counter.docs = 0; counter.queries = 0;
    const direct = await getResults({}, sessionIncomplete.id);
    expect(direct.length).toBe(19); // n-1 résultats écrits dans seedSession(allDone:false)
    expect(counter.docs).toBe(19);
  });

  it('donne le même contenu que la lecture directe (même manche, cache ou pas)', async () => {
    const session = seedSession('MQ6', { type: 'MQ', n: 10, allDone: true });
    const direct = store.results.filter(r => r.sessionId === 'MQ6').map(r => ({ id: r.id, ...r }));

    await refreshSessionCache({}, session);
    const viaCache = await getResults({}, 'MQ6');

    const norm = rows => rows.map(r => ({ driverId: r.driverId, ms: r.ms, status: r.status }))
      .sort((a, b) => a.driverId.localeCompare(b.driverId));
    expect(norm(viaCache)).toEqual(norm(direct));
  });
});

describe('cache meeting (toutes catégories) — compteur + agrégation', () => {
  it('se construit seulement quand TOUTES les manches du meeting sont complètes', async () => {
    seedMeetingSessions('MEET1', ['S1', 'S2', 'S3']);
    const s1 = seedSession('S1', { type: 'EC',  n: 5, allDone: true });
    const s2 = seedSession('S2', { type: 'MQ',  n: 5, allDone: true });
    const s3 = seedSession('S3', { type: 'FIN', n: 5, allDone: true });
    s1.meetingId = s2.meetingId = s3.meetingId = 'MEET1';

    await refreshSessionCache({}, s1);
    expect(await getCachedMeetingResults({}, 'MEET1')).toBeNull(); // 1/3

    await refreshSessionCache({}, s2);
    expect(await getCachedMeetingResults({}, 'MEET1')).toBeNull(); // 2/3

    await refreshSessionCache({}, s3);
    const meeting = await getCachedMeetingResults({}, 'MEET1'); // 3/3
    expect(meeting).not.toBeNull();
    expect(Object.keys(meeting).sort()).toEqual(['S1', 'S2', 'S3']);
    expect(meeting.S1.results.length).toBe(5);
  });

  it('disparaît si une manche redevient incomplète après coup (ex. forfait tardif)', async () => {
    seedMeetingSessions('MEET2', ['A1', 'A2']);
    const a1 = seedSession('A1', { type: 'EC', n: 4, allDone: true });
    const a2 = seedSession('A2', { type: 'FIN', n: 4, allDone: true });
    a1.meetingId = a2.meetingId = 'MEET2';

    await refreshSessionCache({}, a1);
    await refreshSessionCache({}, a2);
    expect(await getCachedMeetingResults({}, 'MEET2')).not.toBeNull();

    // Une réassignation vide A2 : invalidateSessionCache (comme sessions.js
    // le fait pour de vrai lors d'un Auto Finale / forfait).
    await invalidateSessionCache({}, a2);
    expect(await getCachedMeetingResults({}, 'MEET2')).toBeNull();
  });

  it('un meeting de 1 seule manche se complète dès que celle-ci est complète', async () => {
    seedMeetingSessions('MEET3', ['B1']);
    const b1 = seedSession('B1', { type: 'EC', n: 3, allDone: true });
    b1.meetingId = 'MEET3';
    await refreshSessionCache({}, b1);
    expect(await getCachedMeetingResults({}, 'MEET3')).not.toBeNull();
  });
});
