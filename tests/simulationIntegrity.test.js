/* ═══════════════════════════════════════════════
   SIMULATIONINTEGRITY.TEST.JS — Un classement simulé est une VRAIE course.

   Exigence : pour chaque itération Monte-Carlo et chaque manche simulée, les
   pilotes classés doivent former une permutation exclusive du plateau. P1 est
   attribuée à un pilote et un seul, P2 à un autre, et ainsi de suite. Tirer
   une position indépendamment pour chaque pilote produirait des doublons —
   deux P1 dans la même manche — et fausserait silencieusement toutes les
   probabilités, sans qu'aucun test fonctionnel ne s'en aperçoive.

   Ce fichier ne teste pas une intention, il teste la propriété. Il la vérifie
   sur des dizaines de milliers de manches simulées, sur plusieurs graines, avec
   et sans résultats forcés, et sur les deux manches d'une projection après Q2.

   Les DNF / DNS / DSQ échappent à la permutation, et c'est normal : ce ne sont
   pas des places. Leur placement suit exactement la convention de
   buildMqStandings (DNF à `engagés + 1`, DSQ_RACE à `engagés + 3`), qui est
   celle de l'application.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  simulateRaceRows, simulateFromCheckpoint, makeDrawBuffers, drawRace, timeScaleOf,
} from '../js/projection/scenarioSimulator.js';
import { createRng } from '../js/projection/monteCarloEngine.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

// ─────────────────────────────────────────────────────────
// OUTILLAGE
// ─────────────────────────────────────────────────────────

const FIELD = Array.from({ length: 12 }, (_, i) => `D${i + 1}`);

const race = {
  num: 3,
  ids: [...FIELD],
  participants: FIELD.map((d, i) => ({ driverId: d, carNumber: i + 1, firstName: d, lastName: d })),
};

/** Modèles variés : forces différentes, dispersion réelle, incidents possibles. */
function models({ incidentRate = 0 } = {}) {
  const out = {};
  FIELD.forEach((id, i) => {
    out[id] = { driverId: id, mu: -1.2 + i * 0.22, sigma: 0.6, incidentRate };
  });
  return out;
}

const SCALE = { baseMs: 60000, msPerZ: 1500, source: 3 };

/**
 * Vérifie qu'un classement de manche est une course possible.
 * Renvoie un diagnostic lisible plutôt qu'un booléen, pour qu'un échec dise
 * immédiatement CE QUI cloche.
 */
function auditRace(rows, fieldSize) {
  const classified = rows.filter(r => !r.status && r.position != null);
  const positions = classified.map(r => r.position).sort((a, b) => a - b);
  const ids = rows.map(r => r.driverId);

  return {
    duplicatePositions: positions.length !== new Set(positions).size,
    positions,
    // Les places classées doivent être exactement 1, 2, …, k sans trou.
    contiguousFromOne: positions.every((p, i) => p === i + 1),
    duplicateDrivers: ids.length !== new Set(ids).size,
    everyDriverPresent: new Set(ids).size === fieldSize,
    classifiedCount: classified.length,
    // Chronos strictement croissants avec la place.
    timesOrdered: classified
      .slice().sort((a, b) => a.position - b.position)
      .every((r, i, arr) => i === 0 || r.ms > arr[i - 1].ms),
  };
}

/** Simule `n` manches et renvoie leurs classements. */
function manyRaces(n, { seed = 1, forced = null, incidentRate = 0 } = {}) {
  const rng = createRng(seed);
  const [buf] = makeDrawBuffers([race]);
  const m = models({ incidentRate });
  const out = [];
  for (let i = 0; i < n; i++) {
    drawRace(rng, race, buf);
    out.push(simulateRaceRows(race, buf, m, forced, SCALE, TEST_REGULATION));
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// PERMUTATION EXCLUSIVE
// ─────────────────────────────────────────────────────────

describe('une manche simulée est une permutation exclusive du plateau', () => {
  it('aucune position classée n\'est jamais dupliquée — 5 000 manches', () => {
    const bad = [];
    for (const rows of manyRaces(5000)) {
      const a = auditRace(rows, FIELD.length);
      if (a.duplicatePositions) bad.push(a.positions.join(','));
    }
    expect(bad).toEqual([]);
  });

  it('les places vont de 1 à N sans trou ni saut', () => {
    for (const rows of manyRaces(2000)) {
      const a = auditRace(rows, FIELD.length);
      expect(a.contiguousFromOne).toBe(true);
      expect(a.classifiedCount).toBe(FIELD.length);
    }
  });

  it('chaque pilote apparaît exactement une fois', () => {
    for (const rows of manyRaces(2000)) {
      const a = auditRace(rows, FIELD.length);
      expect(a.duplicateDrivers).toBe(false);
      expect(a.everyDriverPresent).toBe(true);
    }
  });

  it('la propriété tient sur plusieurs graines', () => {
    for (const seed of [1, 2, 7, 42, 1234, 99999, 20260101]) {
      for (const rows of manyRaces(500, { seed })) {
        const a = auditRace(rows, FIELD.length);
        expect(a.duplicatePositions, `graine ${seed}`).toBe(false);
        expect(a.contiguousFromOne, `graine ${seed}`).toBe(true);
      }
    }
  });

  it('reste vraie quand des abandons surviennent', () => {
    let sawIncident = false;
    for (const rows of manyRaces(3000, { incidentRate: 0.25 })) {
      const a = auditRace(rows, FIELD.length);
      expect(a.duplicatePositions).toBe(false);
      expect(a.contiguousFromOne).toBe(true);
      expect(a.everyDriverPresent).toBe(true);
      if (a.classifiedCount < FIELD.length) sawIncident = true;
    }
    expect(sawIncident).toBe(true);   // le test aurait été vide sinon
  });

  it('les abandons suivent la convention de l\'application, sans occuper de place classée', () => {
    const rows = manyRaces(1, { forced: { D1: { status: 'DNF' }, D2: { status: 'DSQ_RACE' } } })[0];
    const byId = Object.fromEntries(rows.map(r => [r.driverId, r]));
    expect(byId.D1.position).toBe(FIELD.length + 1);
    expect(byId.D2.position).toBe(FIELD.length + 3);
    // Aucun des deux n'occupe une place de 1 à N.
    const classified = rows.filter(r => !r.status).map(r => r.position);
    expect(classified).not.toContain(byId.D1.position);
    expect(new Set(classified).size).toBe(classified.length);
  });
});

// ─────────────────────────────────────────────────────────
// RÉSULTATS FORCÉS
// ─────────────────────────────────────────────────────────

describe('un résultat forcé ne casse pas l\'exclusivité', () => {
  it('un pilote forcé P1 est l\'UNIQUE P1', () => {
    for (const rows of manyRaces(3000, { forced: { D7: { position: 1 } } })) {
      const p1 = rows.filter(r => !r.status && r.position === 1);
      expect(p1).toHaveLength(1);
      expect(p1[0].driverId).toBe('D7');
    }
  });

  it('un pilote forcé P5 est l\'UNIQUE P5, avec exactement 4 pilotes devant', () => {
    for (const rows of manyRaces(3000, { forced: { D3: { position: 5 } } })) {
      const p5 = rows.filter(r => !r.status && r.position === 5);
      expect(p5).toHaveLength(1);
      expect(p5[0].driverId).toBe('D3');
      const devant = rows.filter(r => !r.status && r.position != null && r.position < 5);
      expect(devant).toHaveLength(4);
      expect(devant.map(r => r.driverId)).not.toContain('D3');
    }
  });

  it('la dernière place forcée reste unique elle aussi', () => {
    const n = FIELD.length;
    for (const rows of manyRaces(1000, { forced: { D4: { position: n } } })) {
      const last = rows.filter(r => !r.status && r.position === n);
      expect(last).toHaveLength(1);
      expect(last[0].driverId).toBe('D4');
    }
  });

  it('la permutation reste complète et sans doublon avec un forçage', () => {
    for (const p of [1, 2, 5, 8, 12]) {
      for (const rows of manyRaces(400, { forced: { D6: { position: p } }, seed: 100 + p })) {
        const a = auditRace(rows, FIELD.length);
        expect(a.duplicatePositions, `P${p}`).toBe(false);
        expect(a.contiguousFromOne, `P${p}`).toBe(true);
        expect(a.everyDriverPresent, `P${p}`).toBe(true);
      }
    }
  });

  it('deux pilotes forcés sur des places distinctes les obtiennent tous les deux', () => {
    for (const rows of manyRaces(500, { forced: { D2: { position: 3 }, D9: { position: 7 } } })) {
      const byId = Object.fromEntries(rows.map(r => [r.driverId, r]));
      expect(byId.D2.position).toBe(3);
      expect(byId.D9.position).toBe(7);
      const a = auditRace(rows, FIELD.length);
      expect(a.duplicatePositions).toBe(false);
      expect(a.contiguousFromOne).toBe(true);
    }
  });

  it('quand trop peu de pilotes terminent, la place forcée est ramenée au dernier rang possible', () => {
    // Cas limite assumé : on ne peut pas avoir 4 pilotes devant s'il n'en
    // termine que deux. Le pilote prend alors la meilleure place atteignable,
    // et l'exclusivité reste entière.
    const m = models({ incidentRate: 1 });
    m.D1.incidentRate = 0; m.D2.incidentRate = 0;
    const rng = createRng(5);
    const [buf] = makeDrawBuffers([race]);
    drawRace(rng, race, buf);
    const rows = simulateRaceRows(race, buf, m, { D5: { position: 9 } }, SCALE, TEST_REGULATION);
    const a = auditRace(rows, FIELD.length);
    expect(a.duplicatePositions).toBe(false);
    expect(a.contiguousFromOne).toBe(true);
    expect(a.classifiedCount).toBe(3);                  // D1, D2 et le pilote forcé
    expect(rows.find(r => r.driverId === 'D5').position).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────
// CHRONOS
// ─────────────────────────────────────────────────────────

describe('les chronos ne contredisent jamais le classement', () => {
  it('un pilote classé devant a toujours un chrono strictement inférieur', () => {
    for (const rows of manyRaces(3000, { incidentRate: 0.15 })) {
      expect(auditRace(rows, FIELD.length).timesOrdered).toBe(true);
    }
  });

  it('c\'est vrai aussi avec un résultat forcé', () => {
    for (const rows of manyRaces(1000, { forced: { D8: { position: 4 } } })) {
      expect(auditRace(rows, FIELD.length).timesOrdered).toBe(true);
    }
  });

  it('deux pilotes n\'ont jamais exactement le même chrono', () => {
    // Sans cela, buildMqStandings pourrait les départager arbitrairement.
    for (const rows of manyRaces(2000)) {
      const ms = rows.filter(r => r.ms != null).map(r => r.ms);
      expect(new Set(ms).size).toBe(ms.length);
    }
  });

  it('les abandons n\'ont pas de chrono', () => {
    for (const rows of manyRaces(500, { incidentRate: 0.3 })) {
      for (const r of rows.filter(x => x.status)) expect(r.ms).toBe(null);
    }
  });
});

// ─────────────────────────────────────────────────────────
// DEUX MANCHES — PROJECTION APRÈS Q2
// ─────────────────────────────────────────────────────────

describe('après Q2, Q3 ET Q4 respectent chacune la propriété', () => {
  const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];

  function contextAfterQ2() {
    const f = makeOrderedMeeting({
      id: 'M1', drivers: SIX, phases: { DF: ['A', 'B'] },
      orders: { 1: SIX, 2: SIX, 3: [], 4: [] },
    });
    const merged = mergeFixtures([f]);
    return buildMeetingContext(buildGroups({
      sessions: merged.sessions, results: merged.results,
      participants: merged.participants, meetings: merged.meetings,
    })[0], TEST_REGULATION);
  }

  const sixModels = Object.fromEntries(SIX.map((id, i) => [id,
    { driverId: id, mu: -0.8 + i * 0.3, sigma: 0.6, incidentRate: 0.05 }]));

  /** Positions de chaque manche, lues sur le classement intermédiaire simulé. */
  const racePositions = (standings, raceNum) => standings
    .map(d => d.mqPos?.[raceNum])
    .filter(p => p != null);

  it('chaque manche d\'une simulation est une permutation, sur 300 graines', () => {
    const ctx = contextAfterQ2();
    for (let seed = 1; seed <= 300; seed++) {
      const run = simulateFromCheckpoint({
        context: ctx, checkpoint: 2, models: sixModels, threshold: 2,
        focusDriverId: 'C', simulations: 1, seed,
      });
      for (const raceNum of [3, 4]) {
        const pos = racePositions(run.standingsSample, raceNum);
        const classified = pos.filter(p => p <= SIX.length).sort((a, b) => a - b);
        expect(new Set(classified).size, `graine ${seed} Q${raceNum}`).toBe(classified.length);
        expect(classified.every((p, i) => p === i + 1), `graine ${seed} Q${raceNum}`).toBe(true);
      }
    }
  });

  it('forcer P6 en Q3 et P8 en Q4 respecte les deux contraintes indépendamment', () => {
    // Plateau plus large, pour que P8 existe.
    const twelve = Array.from({ length: 12 }, (_, i) => `D${i + 1}`);
    const f = makeOrderedMeeting({
      id: 'M2', drivers: twelve, phases: { DF: ['D1', 'D2'] },
      orders: { 1: twelve, 2: twelve, 3: [], 4: [] },
    });
    const merged = mergeFixtures([f]);
    const ctx = buildMeetingContext(buildGroups({
      sessions: merged.sessions, results: merged.results,
      participants: merged.participants, meetings: merged.meetings,
    })[0], TEST_REGULATION);
    const m = Object.fromEntries(twelve.map((id, i) => [id,
      { driverId: id, mu: -1 + i * 0.2, sigma: 0.6, incidentRate: 0 }]));

    for (let seed = 1; seed <= 200; seed++) {
      const run = simulateFromCheckpoint({
        context: ctx, checkpoint: 2, models: m, threshold: 4,
        focusDriverId: 'D5', simulations: 1, seed,
        forced: { 3: { D5: { position: 6 } }, 4: { D5: { position: 8 } } },
      });
      const focus = run.standingsSample.find(d => d.driverId === 'D5');
      expect(focus.mqPos[3], `graine ${seed}`).toBe(6);
      expect(focus.mqPos[4], `graine ${seed}`).toBe(8);

      for (const [raceNum, forcedPos] of [[3, 6], [4, 8]]) {
        const others = run.standingsSample
          .filter(d => d.driverId !== 'D5')
          .map(d => d.mqPos[raceNum])
          .filter(p => p != null && p <= twelve.length);
        // Personne d'autre n'occupe la place forcée…
        expect(others, `graine ${seed} Q${raceNum}`).not.toContain(forcedPos);
        // …et exactement forcedPos - 1 pilotes sont devant.
        expect(others.filter(p => p < forcedPos)).toHaveLength(forcedPos - 1);
      }
    }
  });

  it('l\'échelle de temps produit des chronos ordonnés sur un contexte réel', () => {
    const ctx = contextAfterQ2();
    const scale = timeScaleOf(ctx, 2);
    expect(scale.msPerZ).toBeGreaterThan(0);
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 2, models: sixModels, threshold: 2,
      focusDriverId: 'C', simulations: 1, seed: 3,
    });
    for (const raceNum of [3, 4]) {
      const rows = run.standingsSample
        .filter(d => d.mqMs?.[raceNum] != null)
        .map(d => ({ pos: d.mqPos[raceNum], ms: d.mqMs[raceNum] }))
        .sort((a, b) => a.pos - b.pos);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].ms).toBeGreaterThan(rows[i - 1].ms);
      }
    }
  });
});
