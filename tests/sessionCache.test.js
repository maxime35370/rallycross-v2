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

const { isSessionComplete, buildSessionCacheData, refreshSessionCache, getCachedResults } =
  await import('../js/sessionCache.js');
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

beforeEach(() => {
  store.sessionParticipants = [];
  store.results = [];
  store.sessionCache = [];
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

  it('ignore les types QF/DF/FIN (pas encore pris en charge)', async () => {
    const session = seedSession('FIN1', { type: 'FIN', n: 5, allDone: true });
    await refreshSessionCache({}, session);
    expect(await getCachedResults({}, 'FIN1')).toBeNull();
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
