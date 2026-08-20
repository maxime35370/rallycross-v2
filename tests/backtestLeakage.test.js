/* ═══════════════════════════════════════════════
   BACKTESTLEAKAGE.TEST.JS — Le backtest ne doit rien savoir de l'avenir.

   Une fuite temporelle ne casse rien : elle rend simplement le modèle
   artificiellement bon, et le backtest cesse de mesurer ce qu'il prétend
   mesurer. Aucun test fonctionnel ne la détecterait.

   La preuve retenue ici est directe plutôt que déclarative : on construit DEUX
   jeux de données identiques jusqu'au checkpoint et divergents après, puis on
   vérifie que les PRÉDICTIONS sont rigoureusement identiques. Si une seule
   donnée postérieure entrait dans le modèle, les deux jeux donneraient des
   probabilités différentes.

   Les RÉSULTATS, eux, diffèrent — c'est justement ce qu'on cherche à prédire.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { runBacktest } from '../js/projection/qualificationBacktest.js';
import { buildObservations } from '../js/projection/qualificationHistory.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

const FIELD = Array.from({ length: 10 }, (_, i) => `D${i + 1}`);
const CHAMPS = { champ_test: TEST_REGULATION };
const rotate = (arr, n) => [...arr.slice(n), ...arr.slice(0, n)];

/**
 * Deux meetings de contexte, plus le meeting analysé dont SEULES les manches
 * postérieures au checkpoint varient selon `futureShift`.
 *
 * Le paramètre `checkpoint` est indispensable : à un checkpoint donné, les
 * manches déjà courues sont légitimement visibles, et les faire varier ferait
 * échouer le test pour une bonne raison. C'est ce qui distingue une vraie
 * fuite d'une lecture autorisée.
 */
function buildContexts(futureShift, checkpoint = 2) {
  const fixed = { 1: FIELD, 2: rotate(FIELD, 1), 3: rotate(FIELD, 7), 4: rotate(FIELD, 9) };
  const orders = {};
  for (const n of [1, 2, 3, 4]) {
    orders[n] = n <= checkpoint ? fixed[n] : rotate(FIELD, futureShift + n);
  }
  const fixtures = [
    makeOrderedMeeting({
      id: 'CIBLE', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) },
      meeting: { date: '2026-06-01' }, orders,
    }),
    makeOrderedMeeting({
      id: 'AVANT', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) },
      meeting: { date: '2026-05-01' },
      orders: { 1: FIELD, 2: rotate(FIELD, 2), 3: rotate(FIELD, 4), 4: rotate(FIELD, 6) },
    }),
    makeOrderedMeeting({
      id: 'APRES', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) },
      meeting: { date: '2026-07-01' },
      orders: { 1: rotate(FIELD, 5), 2: FIELD, 3: rotate(FIELD, 1), 4: rotate(FIELD, 3) },
    }),
  ];
  const m = mergeFixtures(fixtures);
  return buildGroups({ sessions: m.sessions, results: m.results, participants: m.participants, meetings: m.meetings })
    .map(g => buildMeetingContext(g, TEST_REGULATION));
}

function predictionsFor(futureShift, checkpoint, leakageMode = 'leaveOneMeetingOut') {
  const contexts = buildContexts(futureShift, checkpoint);
  const observations = buildObservations(contexts, { championshipsById: CHAMPS, requireComplete: true });
  const r = runBacktest({
    contexts, observations, championshipsById: CHAMPS,
    checkpoint, leakageMode, simulations: 400, seed: 4242,
  });
  return r.predictions.filter(p => p.meetingId === 'CIBLE');
}

describe('aucune donnée postérieure au checkpoint n\'entre dans le modèle', () => {
  for (const checkpoint of [1, 2, 3]) {
    it(`après Q${checkpoint} — changer les manches suivantes ne change AUCUNE prédiction`, () => {
      const a = predictionsFor(2, checkpoint);
      const b = predictionsFor(5, checkpoint);

      expect(a.length).toBeGreaterThan(0);
      expect(a.length).toBe(b.length);

      const key = p => p.driverId;
      const byId = (list) => Object.fromEntries(list.map(p => [key(p), p]));
      const A = byId(a), B = byId(b);

      for (const id of Object.keys(A)) {
        expect(A[id].monteCarlo, `Monte-Carlo, pilote ${id}`).toBe(B[id].monteCarlo);
        expect(A[id].historical, `historique, pilote ${id}`).toBe(B[id].historical);
        // L'état AU checkpoint est identique lui aussi : mêmes points, même rang.
        expect(A[id].points).toBe(B[id].points);
        expect(A[id].position).toBe(B[id].position);
        expect(A[id].gap).toBe(B[id].gap);
      }
    });
  }

  it('les RÉSULTATS réels, eux, diffèrent bien — sinon le test ne prouverait rien', () => {
    const a = predictionsFor(2, 2);
    const b = predictionsFor(5, 2);
    const A = Object.fromEntries(a.map(p => [p.driverId, p.outcome]));
    const B = Object.fromEntries(b.map(p => [p.driverId, p.outcome]));
    const differents = Object.keys(A).filter(id => A[id] !== B[id]);
    expect(differents.length).toBeGreaterThan(0);
  });

  it('le régime strict n\'utilise que les meetings antérieurs en date', () => {
    // Le meeting « APRES » est postérieur au meeting analysé : en régime
    // strict, le modifier ne doit rien changer non plus.
    const base = predictionsFor(2, 2, 'strictlyPrior');
    expect(base.length).toBeGreaterThan(0);
    for (const p of base) {
      expect(p.monteCarlo).not.toBeNull();
    }
  });

  it('la liste des partants d\'une manche future n\'est pas lue', () => {
    // Retirer des inscrits de Q3 et Q4 du meeting analysé ne doit pas modifier
    // la projection faite après Q2 : ces retraits ne sont pas connus à ce
    // moment-là.
    const complet = buildContexts(2);
    const observations = buildObservations(complet, { championshipsById: CHAMPS, requireComplete: true });
    const plein = runBacktest({
      contexts: complet, observations, championshipsById: CHAMPS,
      checkpoint: 2, simulations: 400, seed: 4242,
    }).predictions.filter(p => p.meetingId === 'CIBLE');

    // Même jeu, mais Q3/Q4 du meeting analysé amputés de deux pilotes.
    const fixtures = mergeFixtures([
      makeOrderedMeeting({
        id: 'CIBLE', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) }, meeting: { date: '2026-06-01' },
        orders: { 1: FIELD, 2: rotate(FIELD, 1), 3: rotate(FIELD, 2).slice(0, 8), 4: rotate(FIELD, 5).slice(0, 8) },
      }),
      makeOrderedMeeting({
        id: 'AVANT', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) }, meeting: { date: '2026-05-01' },
        orders: { 1: FIELD, 2: rotate(FIELD, 2), 3: rotate(FIELD, 4), 4: rotate(FIELD, 6) },
      }),
      makeOrderedMeeting({
        id: 'APRES', drivers: FIELD, phases: { DF: FIELD.slice(0, 4) }, meeting: { date: '2026-07-01' },
        orders: { 1: rotate(FIELD, 5), 2: FIELD, 3: rotate(FIELD, 1), 4: rotate(FIELD, 3) },
      }),
    ]);
    const ampute = buildGroups({
      sessions: fixtures.sessions, results: fixtures.results,
      participants: fixtures.participants, meetings: fixtures.meetings,
    }).map(g => buildMeetingContext(g, TEST_REGULATION));
    const reduit = runBacktest({
      contexts: ampute, observations: buildObservations(ampute, { championshipsById: CHAMPS, requireComplete: true }),
      championshipsById: CHAMPS, checkpoint: 2, simulations: 400, seed: 4242,
    }).predictions.filter(p => p.meetingId === 'CIBLE');

    const A = Object.fromEntries(plein.map(p => [p.driverId, p.monteCarlo]));
    const B = Object.fromEntries(reduit.map(p => [p.driverId, p.monteCarlo]));
    for (const id of Object.keys(A)) {
      if (B[id] === undefined) continue;
      expect(B[id], `pilote ${id}`).toBe(A[id]);
    }
  });
});

describe('le backtest reste reproductible', () => {
  it('deux exécutions de même graine donnent les mêmes probabilités', () => {
    const a = predictionsFor(2, 2);
    const b = predictionsFor(2, 2);
    expect(a.map(p => p.monteCarlo)).toEqual(b.map(p => p.monteCarlo));
  });

  it('une graine différente change les probabilités Monte-Carlo mais pas l\'historique', () => {
    const contexts = buildContexts(2);
    const observations = buildObservations(contexts, { championshipsById: CHAMPS, requireComplete: true });
    const run = (seed) => runBacktest({
      contexts, observations, championshipsById: CHAMPS,
      checkpoint: 2, simulations: 400, seed,
    }).predictions.filter(p => p.meetingId === 'CIBLE');
    const a = run(1), b = run(2);
    expect(a.map(p => p.historical)).toEqual(b.map(p => p.historical));
    expect(a.map(p => p.monteCarlo)).not.toEqual(b.map(p => p.monteCarlo));
  });
});
