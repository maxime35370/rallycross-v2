/* ═══════════════════════════════════════════════
   HYBRIDLIVERACE.TEST.JS — Mode hybride RÉEL + SIMULÉ sur une manche en cours.

   Le risque propre à ce mode n'est pas de planter : c'est de produire une
   projection crédible qui contredit un résultat déjà enregistré. Un team qui
   voit « P2 probable » alors que le pilote a réellement fini P7 ne peut pas
   deviner que la simulation a ignoré la donnée réelle.

   Les tests portent donc sur des INVARIANTS, pas sur des valeurs :
   les résultats réels sont bit à bit identiques dans des milliers de tirages,
   leur ordre relatif ne bouge jamais, et aucun pilote ne franchit une borne
   que les résultats acquis lui interdisent.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../js/projection/qualificationState.js';
import {
  simulateFromCheckpoint, simulateRaceRows, makeDrawBuffers, drawRace,
  timeScaleOf, entrantsOfRace, realResultsOfRace, forcedConflicts, hasRealResult,
  whatIfResults, simulateScenarioMatrix, assignChronos,
} from '../js/projection/scenarioSimulator.js';
import { createRng } from '../js/projection/monteCarloEngine.js';
import { buildDriverModels, collectRaceObservations, latentFromPosition } from '../js/projection/driverPerformanceModel.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

const FIELD = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const rot = n => [...FIELD.slice(n), ...FIELD.slice(0, n)];
const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 60000 + i * 700]));

/**
 * Meeting dont la manche `raceNum` est courue par `done` pilotes seulement.
 * `done = []` → manche pas commencée ; `done = FIELD` → manche terminée.
 */
function liveFixture({ raceNum = 4, done = ['C', 'A', 'F'], statuses = {} } = {}) {
  const races = {};
  for (let n = 1; n < raceNum; n++) races[n] = ran(rot(n));
  const partielle = {};
  done.forEach((d, i) => {
    partielle[d] = statuses[d] ? { status: statuses[d] } : 60000 + i * 700;
  });
  for (const d of FIELD) if (!(d in partielle)) partielle[d] = PENDING;
  races[raceNum] = partielle;
  for (let n = raceNum + 1; n <= 4; n++) races[n] = Object.fromEntries(FIELD.map(d => [d, PENDING]));
  return makeMeeting({
    meetingId: 'LIVE', drivers: FIELD, plannedRaces: 4,
    meeting: { date: '2026-08-20', id: 'LIVE' }, races,
  });
}

function ctxOf(opts) {
  const m = mergeFixtures([liveFixture(opts)]);
  return buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
}

function modelsFor(ctx, checkpoint) {
  const ids = FIELD;
  const obs = collectRaceObservations([ctx]).filter(o => o.raceNum <= checkpoint);
  return buildDriverModels({
    driverIds: ids, observations: obs,
    scope: { meetingId: ctx.meetingId, year: 2026, category: ctx.category, circuit: 'Circuit de test' },
  }).models;
}

/** Rejoue `n` fois la manche en cours et renvoie les classements bruts. */
function replayRace(ctx, { checkpoint = 3, raceNum = 4, n = 500, forced = null, seed = 99 } = {}) {
  const ids = entrantsOfRace(ctx, raceNum, FIELD);
  const race = {
    num: raceNum, ids,
    participants: ids.map(id => ({ driverId: id, ...(ctx.driversById[id] || {}) })),
    real: realResultsOfRace(ctx, raceNum),
  };
  const models = modelsFor(ctx, checkpoint);
  const scale = timeScaleOf(ctx, raceNum);
  const bufs = makeDrawBuffers([race]);
  const rng = createRng(seed);
  const out = [];
  for (let k = 0; k < n; k++) {
    drawRace(rng, race, bufs[0]);
    out.push(simulateRaceRows(race, bufs[0], models, forced, scale, TEST_REGULATION));
  }
  return out;
}

// ─────────────────────────────────────────────────────────

describe('les résultats réels sont repris tels quels', () => {
  it('le chrono d\'un pilote déjà passé est identique dans les 2 000 tirages', () => {
    const ctx = ctxOf();
    const reels = realResultsOfRace(ctx, 4);
    const vus = new Map(Object.keys(reels).map(id => [id, new Set()]));

    for (const rows of replayRace(ctx, { n: 2000 })) {
      for (const [id, r] of Object.entries(reels)) {
        const row = rows.find(x => x.driverId === id);
        vus.get(id).add(`${row.ms}|${row.status}`);
      }
    }
    for (const [id, valeurs] of vus) {
      expect([...valeurs], `pilote ${id}`).toHaveLength(1);
      expect([...valeurs][0]).toBe(`${reels[id].ms}|${reels[id].status}`);
    }
  });

  it('l\'ordre relatif des pilotes réels ne change JAMAIS', () => {
    const ctx = ctxOf();
    const reels = realResultsOfRace(ctx, 4);
    const attendu = Object.entries(reels)
      .filter(([, r]) => r.ms != null && !r.status)
      .sort((a, b) => a[1].ms - b[1].ms).map(([id]) => id);

    for (const rows of replayRace(ctx, { n: 1000 })) {
      const observe = rows
        .filter(r => attendu.includes(r.driverId))
        .sort((a, b) => a.position - b.position).map(r => r.driverId);
      expect(observe).toEqual(attendu);
    }
  });

  it('un pilote réellement 3e ne termine JAMAIS devant les deux pilotes réels devant lui', () => {
    // C (P1 réel), A (P2 réel), F (P3 réel) : F ne peut pas finir mieux que P3,
    // ni moins bien que P3 + le nombre de pilotes restant à courir.
    const ctx = ctxOf();
    let minF = Infinity, maxF = 0;
    for (const rows of replayRace(ctx, { n: 2000 })) {
      const f = rows.find(r => r.driverId === 'F');
      minF = Math.min(minF, f.position);
      maxF = Math.max(maxF, f.position);
    }
    expect(minF).toBeGreaterThanOrEqual(3);
    expect(maxF).toBeLessThanOrEqual(3 + 5);
  });

  it('la borne haute est atteignable : elle n\'est pas une marge de prudence', () => {
    // Un seul pilote restant : F ne peut finir que P3 ou P4, et les deux
    // doivent réellement apparaître.
    const ctx = ctxOf({ done: ['C', 'A', 'F', 'B', 'D', 'E', 'G'] });
    const vues = new Set();
    for (const rows of replayRace(ctx, { n: 500 })) {
      vues.add(rows.find(r => r.driverId === 'F').position);
    }
    expect([...vues].sort()).toEqual([3, 4]);
  });

  it('un statut réel (DNF) est conservé, jamais transformé en chrono', () => {
    const ctx = ctxOf({ done: ['C', 'A', 'F'], statuses: { A: 'DNF' } });
    for (const rows of replayRace(ctx, { n: 300 })) {
      const a = rows.find(r => r.driverId === 'A');
      expect(a.status).toBe('DNF');
      expect(a.ms).toBeNull();
      expect(a.position).toBe(FIELD.length + 1);
    }
  });

  it('recalculer ne modifie pas les données de départ', () => {
    const ctx = ctxOf();
    const avant = JSON.stringify(ctx.races);
    simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models: modelsFor(ctx, 3), threshold: 4,
      focusDriverId: 'F', simulations: 200, seed: 5,
    });
    replayRace(ctx, { n: 50 });
    expect(JSON.stringify(ctx.races)).toBe(avant);
  });
});

describe('chronos : ni impossibles, ni dupliqués', () => {
  it('les chronos classés sont strictement croissants et tous distincts', () => {
    for (const opts of [{ done: [] }, { done: ['C'] }, { done: ['C', 'A', 'F'] }, { done: FIELD.slice(0, 7) }]) {
      const ctx = ctxOf(opts);
      for (const rows of replayRace(ctx, { n: 300 })) {
        const classes = rows.filter(r => r.ms != null && !r.status).sort((a, b) => a.position - b.position);
        const vus = new Set();
        let precedent = -Infinity;
        for (const r of classes) {
          expect(r.ms, `chrono positif (${JSON.stringify(opts)})`).toBeGreaterThan(0);
          expect(r.ms, `strictement croissant (${JSON.stringify(opts)})`).toBeGreaterThan(precedent);
          expect(vus.has(r.ms), `doublon de chrono (${JSON.stringify(opts)})`).toBe(false);
          vus.add(r.ms);
          precedent = r.ms;
        }
        const positions = classes.map(r => r.position);
        expect(positions).toEqual(positions.map((_, i) => i + 1));
      }
    }
  });

  it('un pilote simulé peut se glisser entre deux pilotes réels sans les déplacer', () => {
    const ctx = ctxOf();
    let intercale = 0;
    for (const rows of replayRace(ctx, { n: 500 })) {
      const c = rows.find(r => r.driverId === 'C').position;
      const a = rows.find(r => r.driverId === 'A').position;
      if (a - c > 1) intercale++;
      expect(c).toBeLessThan(a);   // l'ordre réel tient dans tous les cas
    }
    expect(intercale).toBeGreaterThan(0);
  });

  it('assignChronos respecte les ancres réelles à la milliseconde près', () => {
    const scale = { baseMs: 60000, msPerZ: 1000, source: 4 };
    const order = [
      { driverId: 'X', real: false, key: 59000 },
      { driverId: 'C', real: true, ms: 60000 },
      { driverId: 'Y', real: false, key: 60100 },
      { driverId: 'Z', real: false, key: 60200 },
      { driverId: 'A', real: true, ms: 60700 },
      { driverId: 'W', real: false, key: 61000 },
    ];
    const ms = assignChronos(order, scale, 6);
    expect(ms[1]).toBe(60000);
    expect(ms[4]).toBe(60700);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1]);
    expect(new Set(ms).size).toBe(ms.length);
    expect(ms[0]).toBeGreaterThan(0);
  });
});

describe('progression du réel : 0 %, 25 %, 50 %, 75 %, 100 %', () => {
  const seuil = 4;

  it('la probabilité converge vers un fait à mesure que le réel arrive', () => {
    const etapes = [0, 2, 4, 6, 8].map(k => {
      const ctx = ctxOf({ done: rot(2).slice(0, k) });
      const checkpoint = ctx.lastCompletedRace;
      const run = simulateFromCheckpoint({
        context: ctx, checkpoint, models: modelsFor(ctx, 3), threshold: seuil,
        focusDriverId: 'C', simulations: 800, seed: 4242,
      });
      return { k, checkpoint, probability: run.probability, simulations: run.simulations, deterministic: run.deterministic };
    });

    // 0 pilote passé : la manche n'a pas commencé, tout est simulé.
    expect(etapes[0].checkpoint).toBe(3);
    expect(etapes[0].deterministic).toBe(false);

    // Toutes les étapes intermédiaires restent probabilistes.
    for (const e of etapes.slice(0, 4)) {
      expect(e.probability).toBeGreaterThanOrEqual(0);
      expect(e.probability).toBeLessThanOrEqual(1);
      expect(e.simulations).toBeGreaterThan(0);
    }

    // 100 % des pilotes passés : plus rien à simuler, c'est un fait.
    expect(etapes[4].checkpoint).toBe(4);
    expect(etapes[4].deterministic).toBe(true);
    expect(etapes[4].simulations).toBe(0);
    expect([0, 1]).toContain(etapes[4].probability);
  });

  it('l\'incertitude sur la position se resserre quand le réel arrive', () => {
    const etendue = (k) => {
      const ctx = ctxOf({ done: rot(2).slice(0, k) });
      const run = simulateFromCheckpoint({
        context: ctx, checkpoint: ctx.lastCompletedRace, models: modelsFor(ctx, 3),
        threshold: seuil, focusDriverId: 'C', simulations: 1500, seed: 4242,
      });
      const places = run.positionDistribution.map(e => e.value);
      return Math.max(...places) - Math.min(...places);
    };
    // C fait partie des deux premiers passés : dès que son résultat est acquis,
    // l'éventail de ses classements finaux possibles ne peut que se réduire.
    expect(etendue(2)).toBeLessThanOrEqual(etendue(0));
  });
});

describe('aucun résultat réel : rien ne change par rapport à la simulation pure', () => {
  it('manche non commencée et mode « none » donnent exactement le même résultat', () => {
    const ctx = ctxOf({ done: [] });
    const args = {
      context: ctx, checkpoint: 3, models: modelsFor(ctx, 3), threshold: 4,
      focusDriverId: 'C', simulations: 600, seed: 20260101,
    };
    const hybride = simulateFromCheckpoint(args);
    const pur = simulateFromCheckpoint({ ...args, liveResults: 'none' });
    expect(hybride.probability).toBe(pur.probability);
    expect(hybride.positionDistribution).toEqual(pur.positionDistribution);
    expect(hybride.cutDistribution).toEqual(pur.cutDistribution);
  });

  it('la formule de chrono d\'une manche entièrement simulée est inchangée', () => {
    // Preuve directe : sans ancre réelle, assignChronos retombe sur la formule
    // « rang » utilisée avant le mode hybride.
    const scale = { baseMs: 61234, msPerZ: 987, source: 2 };
    const order = FIELD.map((d, i) => ({ driverId: d, real: false, key: 1000 + i }));
    const ms = assignChronos(order, scale, FIELD.length);

    // Reproduction littérale de la formule d'avant le mode hybride.
    const n = FIELD.length;
    const z0 = latentFromPosition(1, n);
    const ancienne = FIELD.map((_, p) =>
      Math.round(scale.baseMs + scale.msPerZ * (latentFromPosition(p + 1, n) - z0)) + p);

    expect(ms).toEqual(ancienne);
  });
});

describe('un résultat acquis n\'est pas un scénario', () => {
  it('forcedConflicts repère la tentative de réécriture', () => {
    const ctx = ctxOf();
    expect(forcedConflicts(ctx, { 4: { C: { position: 5 } } })).toHaveLength(1);
    expect(forcedConflicts(ctx, { 4: { B: { position: 5 } } })).toHaveLength(0);
    expect(hasRealResult(ctx, 4, 'C')).toBe(true);
    expect(hasRealResult(ctx, 4, 'B')).toBe(false);
  });

  it('simulateFromCheckpoint refuse de simuler un scénario contradictoire', () => {
    const ctx = ctxOf();
    expect(() => simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models: modelsFor(ctx, 3), threshold: 4,
      focusDriverId: 'C', forced: { 4: { C: { position: 8 } } }, simulations: 10,
    })).toThrow(/déjà acquis/);
  });

  it('whatIfResults renvoie une indisponibilité explicite, pas un tableau vide', () => {
    const ctx = ctxOf();
    const r = whatIfResults({
      context: ctx, checkpoint: 3, models: modelsFor(ctx, 3), threshold: 4,
      focusDriverId: 'C', raceNum: 4, simulations: 50,
    });
    expect(r.unavailable).toBe('alreadyRaced');
    expect(r.entries).toEqual([]);
    expect(r.realResult.ms).toBe(60000);
  });

  it('le what-if reste disponible pour un pilote qui n\'a pas encore couru', () => {
    const ctx = ctxOf();
    const r = whatIfResults({
      context: ctx, checkpoint: 3, models: modelsFor(ctx, 3), threshold: 4,
      focusDriverId: 'B', raceNum: 4, positions: [1, 4, 8], simulations: 120,
    });
    expect(r.unavailable).toBeNull();
    // 3 places testées + les statuts définis par le règlement de test (4).
    expect(r.entries.length).toBe(3 + 4);
    // Une place forcée devant les pilotes réels reste possible : B n'a pas couru.
    expect(r.entries.find(e => e.label === 'P1').probability).not.toBeNull();
  });

  it('la matrice refuse un axe dont le résultat est acquis', () => {
    const ctx = ctxOf({ raceNum: 3, done: ['C', 'A'] });
    const m = simulateScenarioMatrix({
      context: ctx, checkpoint: 2, models: modelsFor(ctx, 2), threshold: 4,
      focusDriverId: 'C', rowScenarios: [{ kind: 'position', position: 1 }],
      colScenarios: [{ kind: 'position', position: 1 }], simulations: 20,
    });
    expect(m.unavailable).toBe('alreadyRaced');
    expect(m.acquiredRace).toBe(3);
  });
});

describe('générique : Q2, Q3 ou Q4 en cours, même comportement', () => {
  for (const raceNum of [2, 3, 4]) {
    it(`manche ${raceNum} en cours : réel repris, pilotes restants simulés`, () => {
      const ctx = ctxOf({ raceNum, done: ['C', 'A', 'F'] });
      expect(ctx.raceInProgress).toBe(raceNum);
      expect(ctx.lastCompletedRace).toBe(raceNum - 1);

      const reels = realResultsOfRace(ctx, raceNum);
      expect(Object.keys(reels).sort()).toEqual(['A', 'C', 'F']);

      const run = simulateFromCheckpoint({
        context: ctx, checkpoint: ctx.lastCompletedRace, models: modelsFor(ctx, raceNum - 1),
        threshold: 4, focusDriverId: 'F', simulations: 300, seed: 7,
      });
      expect(run.probability).not.toBeNull();
      expect(run.remainingRaces[0]).toBe(raceNum);

      // Le résultat réel de F en manche `raceNum` tient dans tous les tirages.
      for (const rows of replayRace(ctx, { raceNum, checkpoint: raceNum - 1, n: 200 })) {
        expect(rows.find(r => r.driverId === 'F').ms).toBe(61400);
      }
    });
  }

  it('le mode « none » ignore le réel : c\'est ce qui protège le backtest', () => {
    const ctx = ctxOf();
    expect(realResultsOfRace(ctx, 4, 'none')).toBeNull();

    // En mode hybride le chrono de C est figé ; en mode pur il est tiré, donc
    // il varie. C'est la démonstration que le backtest ne lit pas le futur.
    const chronos = (mode) => {
      const ids = entrantsOfRace(ctx, 4, FIELD);
      const race = {
        num: 4, ids, participants: ids.map(id => ({ driverId: id, ...(ctx.driversById[id] || {}) })),
        real: realResultsOfRace(ctx, 4, mode),
      };
      const models = modelsFor(ctx, 3);
      const scale = timeScaleOf(ctx, 3);
      const bufs = makeDrawBuffers([race]);
      const rng = createRng(3);
      const vus = new Set();
      for (let k = 0; k < 200; k++) {
        drawRace(rng, race, bufs[0]);
        const row = simulateRaceRows(race, bufs[0], models, null, scale, TEST_REGULATION).find(r => r.driverId === 'C');
        vus.add(`${row.ms}|${row.status}`);
      }
      return vus;
    };
    expect(chronos('inProgress').size).toBe(1);
    expect(chronos('none').size).toBeGreaterThan(1);
  });
});

describe('l\'état de départ n\'inclut jamais la manche en cours', () => {
  it('les points de la manche en cours ne sont comptés pour personne', () => {
    const ctx = ctxOf();
    const state = buildStateAfterRace(ctx, ctx.lastCompletedRace);
    expect(new Set(state.standings.map(d => d.mqCount))).toEqual(new Set([3]));
  });
});
