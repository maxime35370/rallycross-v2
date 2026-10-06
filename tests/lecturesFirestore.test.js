/* LECTURES FIRESTORE — le classement intermédiaire calculé en mémoire doit
   donner EXACTEMENT le même résultat que la lecture complète, et coûter moins
   de documents lus.

   Le SDK Firestore est chargé depuis un CDN par calc.js ; on le remplace ici par
   une base en mémoire qui COMPTE les documents renvoyés (c'est ce que Firestore
   facture). Aucune donnée réelle, aucune connexion. */

import { describe, it, expect, beforeEach } from 'vitest';

// Base en mémoire + compteur : voir tests/helpers/fakeFirestore.js (alias dans vitest.config.js)
const { store, counter } = (globalThis.__fakeFirestore ||= {
  store: {},
  counter: { docs: 0, queries: 0 },
});

const { calcInterimStandings, buildInterimFromData } = await import('../js/calc.js');

/** Meeting type : EC + 4 MQ, N pilotes, chronos déterministes. */
function seed(n) {
  store.results = [];
  store.sessionParticipants = [];
  const sessions = [{ id: 'EC', type: 'EC', num: null }];
  for (let i = 1; i <= 4; i++) sessions.push({ id: `MQ${i}`, type: 'MQ', num: i });
  for (const s of sessions) {
    for (let d = 1; d <= n; d++) {
      const driverId = `d${d}`;
      store.sessionParticipants.push({
        id: `${s.id}_${driverId}`, sessionId: s.id, driverId,
        carNumber: d, firstName: `P${d}`, lastName: `N${d}`,
      });
      // quelques statuts pour exercer les cas particuliers
      const status = d % 11 === 0 ? 'DNF' : d % 13 === 0 ? 'DNS' : null;
      store.results.push({
        id: `${s.id}_${driverId}`, sessionId: s.id, driverId,
        ms: status ? null : 60000 + ((d * 7919 + s.id.length * 31 + (s.num || 0) * 17) % 5000),
        status,
      });
    }
  }
  return sessions;
}

beforeEach(() => { counter.docs = 0; counter.queries = 0; });

describe('classement intermédiaire : lecture complète vs calcul en mémoire', () => {
  for (const n of [15, 20, 30]) {
    it(`donne le même classement avec ${n} pilotes`, async () => {
      const sessions = seed(n);
      const viaLecture = await calcInterimStandings({}, sessions);

      const resultsBySession = {};
      const participantsBySession = {};
      for (const s of sessions) {
        resultsBySession[s.id] = store.results.filter(r => r.sessionId === s.id);
        participantsBySession[s.id] = store.sessionParticipants.filter(p => p.sessionId === s.id);
      }
      const enMemoire = buildInterimFromData(sessions, resultsBySession, participantsBySession);

      expect(viaLecture.length).toBeGreaterThan(0);
      expect(enMemoire).toEqual(viaLecture);
    });
  }

  it('la lecture complète coûte 10×N documents, le calcul en mémoire 0', async () => {
    const sessions = seed(20);
    await calcInterimStandings({}, sessions);
    expect(counter.docs).toBe(10 * 20);     // 5 sessions × (N résultats + N participants)
    expect(counter.queries).toBe(10);

    counter.docs = 0;
    buildInterimFromData(sessions, {}, {});
    expect(counter.docs).toBe(0);
  });

  it('sans MQ ni EC, renvoie un tableau vide (comme avant)', async () => {
    expect(await calcInterimStandings({}, [])).toEqual([]);
    expect(buildInterimFromData([], {}, {})).toEqual([]);
  });

  it('tolère une session sans données', () => {
    const sessions = [{ id: 'EC', type: 'EC' }, { id: 'MQ1', type: 'MQ', num: 1 }];
    expect(() => buildInterimFromData(sessions)).not.toThrow();
  });
});
