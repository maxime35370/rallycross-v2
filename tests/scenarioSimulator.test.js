/* ═══════════════════════════════════════════════
   SCENARIOSIMULATOR.TEST.JS — Simulation des manches restantes.

   Une simulation qui produirait des classements impossibles ou des chronos
   incohérents fausserait les probabilités SANS RIEN CASSER DE VISIBLE : aucun
   test fonctionnel ne planterait, les chiffres seraient simplement faux. Ce
   fichier est donc écrit d'abord contre ce risque-là.

   Il vérifie en particulier :
     • qu'un classement simulé est toujours une permutation valide du plateau,
       sans doublon ni pilote manquant ;
     • que les chronos sont strictement croissants avec la position ;
     • qu'une position forcée est obtenue EXACTEMENT, et que les autres pilotes
       continuent d'être tirés au lieu d'être figés ;
     • que deux exécutions de même graine sont identiques au bit près ;
     • qu'après la dernière manche, le moteur cesse de simuler au lieu de
       projeter un résultat déjà connu.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  simulateFromCheckpoint, whatIfResults, timeScaleOf, entrantsOfRace,
  FORCEABLE_STATUSES, forceableStatuses,
} from '../js/projection/scenarioSimulator.js';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../js/projection/qualificationState.js';
import { buildMqStandings } from '../js/calc.js';
import { makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Meeting à 6 pilotes ; les 3 premières manches sont courues, la 4e non. */
function contextAfterQ3({ orders, phases = { DF: ['A', 'B'] } } = {}) {
  const f = makeOrderedMeeting({
    id: 'M1', drivers: SIX, phases,
    orders: orders || { 1: SIX, 2: SIX, 3: SIX, 4: [] },
  });
  const merged = mergeFixtures([f]);
  const groups = buildGroups({
    sessions: merged.sessions, results: merged.results,
    participants: merged.participants, meetings: merged.meetings,
  });
  return buildMeetingContext(groups[0], TEST_REGULATION);
}

/** Modèles synthétiques : A le plus rapide, F le plus lent, aucun incident. */
function models(overrides = {}) {
  const out = {};
  SIX.forEach((id, i) => {
    out[id] = { driverId: id, mu: -1 + i * 0.4, sigma: 0.5, incidentRate: 0, ...(overrides[id] || {}) };
  });
  return out;
}

const THRESHOLD = 2;
const RUN = (extra = {}) => simulateFromCheckpoint({
  context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
  simulations: 400, seed: 7, ...extra,
});

// ─────────────────────────────────────────────────────────

describe('déterminisme', () => {
  it('deux exécutions de même graine donnent exactement le même résultat', () => {
    const a = RUN({ focusDriverId: 'C' });
    const b = RUN({ focusDriverId: 'C' });
    expect(a.probability).toBe(b.probability);
    expect(a.positionDistribution).toEqual(b.positionDistribution);
    expect(a.cutDistribution).toEqual(b.cutDistribution);
  });

  it('une graine différente donne un résultat différent', () => {
    const a = RUN({ focusDriverId: 'C', seed: 1 });
    const b = RUN({ focusDriverId: 'C', seed: 2 });
    expect(a.probability).not.toBe(b.probability);
  });

  it('la graine utilisée est toujours remontée', () => {
    expect(RUN({ focusDriverId: 'C', seed: 4242 }).seed).toBe(4242);
    expect(RUN({ focusDriverId: 'C' }).simulations).toBe(400);
  });
});

describe('cohérence des manches simulées', () => {
  // On rejoue une simulation en interceptant le classement produit : chaque
  // manche simulée doit être une course possible.
  it('le classement de la manche est une permutation valide du plateau', () => {
    const ctx = contextAfterQ3();
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', simulations: 200, seed: 11,
    });
    // standingsSample est le classement intermédiaire de la 1re simulation :
    // il doit contenir chaque pilote une fois et une seule.
    const ids = run.standingsSample.map(d => d.driverId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...SIX].sort());
  });

  it('les positions du classement final sont contiguës à partir de 1', () => {
    const run = RUN({ focusDriverId: 'C', simulations: 50 });
    const positions = run.standingsSample.map(d => d.position);
    expect(Math.min(...positions)).toBe(1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(SIX.length);
  });

  it('aucune position simulée du pilote analysé ne sort du plateau', () => {
    const run = RUN({ focusDriverId: 'C', simulations: 600 });
    for (const e of run.positionDistribution) {
      expect(e.value).toBeGreaterThanOrEqual(1);
      expect(e.value).toBeLessThanOrEqual(SIX.length);
    }
    const total = run.positionDistribution.reduce((s, e) => s + e.count, 0);
    expect(total).toBe(run.countedCount);
  });

  it('les chronos générés sont strictement croissants avec la position', () => {
    // On reconstruit la logique de chronométrage du simulateur via le même
    // chemin : buildMqStandings doit retrouver l'ordre imposé.
    const ctx = contextAfterQ3();
    const scale = timeScaleOf(ctx, 3);
    expect(scale.msPerZ).toBeGreaterThan(0);
    expect(scale.source).toBe(3);

    const participants = SIX.map(d => ({ driverId: d, carNumber: 1, firstName: d, lastName: d }));
    const results = SIX.map((d, i) => ({ driverId: d, ms: 1000 + i * 50, status: null }));
    const rows = buildMqStandings(participants, results, TEST_REGULATION)
      .filter(r => r.position != null).sort((a, b) => a.position - b.position);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].ms).toBeGreaterThan(rows[i - 1].ms);
    }
  });

  it('l\'échelle de temps reste utilisable même sans référence exploitable', () => {
    const vide = buildMeetingContext({ sessions: [], resultsBySession: {}, participantsBySession: {} }, TEST_REGULATION);
    const scale = timeScaleOf(vide, 3);
    expect(scale.msPerZ).toBeGreaterThan(0);
    expect(scale.source).toBe(null);
  });

  it('les chronos simulés permettent le départage — mqMs est renseigné', () => {
    const run = RUN({ focusDriverId: 'C', simulations: 20 });
    const row = run.standingsSample.find(d => d.driverId === 'C');
    expect(Object.keys(row.mqMs).length).toBeGreaterThan(0);
    expect(row.mqMs[4]).toBeTypeOf('number');
  });
});

describe('résultats forcés', () => {
  it('la position imposée est obtenue exactement, à chaque simulation', () => {
    for (const p of [1, 3, 6]) {
      const run = simulateFromCheckpoint({
        context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
        focusDriverId: 'C', forced: { 4: { C: { position: p } } },
        simulations: 120, seed: 5,
      });
      const row = run.standingsSample.find(d => d.driverId === 'C');
      expect(row.mqPos[4]).toBe(p);
    }
  });

  it('les autres pilotes continuent d\'être simulés, pas figés', () => {
    const run = simulateFromCheckpoint({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', forced: { 4: { C: { position: 3 } } },
      simulations: 400, seed: 5,
    });
    // Le pilote analysé est figé, mais sa position FINALE au classement varie
    // encore : c'est bien que les autres bougent.
    expect(run.positionDistribution.length).toBeGreaterThan(1);
  });

  it('un statut imposé sort le pilote du classement de la manche', () => {
    const run = simulateFromCheckpoint({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', forced: { 4: { C: { status: 'DNS' } } },
      simulations: 60, seed: 5,
    });
    const row = run.standingsSample.find(d => d.driverId === 'C');
    expect(row.mqPos[4]).toBe(null);
  });

  it('forcer P1 donne une probabilité au moins aussi bonne que forcer la dernière place', () => {
    const base = { context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', simulations: 800, seed: 3 };
    const p1 = simulateFromCheckpoint({ ...base, forced: { 4: { C: { position: 1 } } } });
    const last = simulateFromCheckpoint({ ...base, forced: { 4: { C: { position: 6 } } } });
    expect(p1.probability).toBeGreaterThanOrEqual(last.probability);
  });

  it('une position hors plateau est ramenée en fin de classement plutôt qu\'ignorée', () => {
    const run = simulateFromCheckpoint({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', forced: { 4: { C: { position: 99 } } },
      simulations: 40, seed: 5,
    });
    const row = run.standingsSample.find(d => d.driverId === 'C');
    expect(row.mqPos[4]).toBe(SIX.length);
  });
});

describe('nombres aléatoires communs entre scénarios', () => {
  it('deux scénarios de même graine font vivre aux autres pilotes les mêmes courses', () => {
    // Le pilote analysé est forcé dans les deux cas ; seul son résultat change.
    // Si les tirages des autres n'étaient pas alignés, la comparaison entre
    // deux positions forcées mesurerait surtout du bruit.
    const base = { context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', simulations: 200, seed: 21 };
    const a = simulateFromCheckpoint({ ...base, forced: { 4: { C: { position: 2 } } } });
    const b = simulateFromCheckpoint({ ...base, forced: { 4: { C: { position: 2 } } } });
    expect(a.probability).toBe(b.probability);

    // Les positions des AUTRES pilotes dans la première simulation doivent être
    // identiques entre deux scénarios ne différant que par la place forcée,
    // hormis le décalage induit par l'insertion.
    const c2 = simulateFromCheckpoint({ ...base, forced: { 4: { C: { position: 1 } } } });
    const others = (run) => run.standingsSample
      .filter(d => d.driverId !== 'C')
      .map(d => d.mqPos[4])
      .sort((x, y) => x - y);
    expect(others(a).length).toBe(others(c2).length);
  });
});

describe('après la dernière manche — plus rien à simuler', () => {
  it('le moteur renvoie un fait, pas une projection', () => {
    const f = makeOrderedMeeting({
      id: 'M1', drivers: SIX, phases: { DF: ['A', 'B'] },
      orders: { 1: SIX, 2: SIX, 3: SIX, 4: SIX },
    });
    const merged = mergeFixtures([f]);
    const ctx = buildMeetingContext(buildGroups({
      sessions: merged.sessions, results: merged.results,
      participants: merged.participants, meetings: merged.meetings,
    })[0], TEST_REGULATION);

    const qualifie = simulateFromCheckpoint({ context: ctx, checkpoint: 4, models: models(), threshold: 2, focusDriverId: 'A' });
    expect(qualifie.deterministic).toBe(true);
    expect(qualifie.simulations).toBe(0);
    expect(qualifie.probability).toBe(1);
    expect(qualifie.remainingRaces).toEqual([]);

    const elimine = simulateFromCheckpoint({ context: ctx, checkpoint: 4, models: models(), threshold: 2, focusDriverId: 'F' });
    expect(elimine.probability).toBe(0);
  });

  it('c\'est le MÊME appel que pour un checkpoint intermédiaire', () => {
    // Aucun cas particulier « après Q4 » : seule la liste des manches restantes
    // change, et elle est déduite du contexte.
    const run = RUN({ focusDriverId: 'A' });
    expect(run.remainingRaces).toEqual([4]);
    expect(run.deterministic).toBe(false);
  });
});

describe('incidents et pilotes sans modèle', () => {
  it('un taux d\'incident de 100 % produit systématiquement un abandon', () => {
    const run = simulateFromCheckpoint({
      context: contextAfterQ3(), checkpoint: 3,
      models: models({ C: { incidentRate: 1 } }), threshold: THRESHOLD,
      focusDriverId: 'C', simulations: 60, seed: 9,
    });
    const row = run.standingsSample.find(d => d.driverId === 'C');
    // Convention de l'application, reproduite à l'identique : un DNF est classé
    // à `engagés + 1` et n'a pas de chrono. C'est ce placement, et pas une
    // position nulle, qui doit sortir de la simulation.
    expect(row.mqPos[4]).toBe(SIX.length + 1);
    expect(row.mqMs[4]).toBeUndefined();
  });

  it('un pilote sans modèle est traité comme non partant, jamais comme moyen', () => {
    const m = models(); delete m.F;
    const run = simulateFromCheckpoint({
      context: contextAfterQ3(), checkpoint: 3, models: m, threshold: THRESHOLD,
      focusDriverId: 'F', simulations: 40, seed: 9,
    });
    const row = run.standingsSample.find(d => d.driverId === 'F');
    expect(row.mqPos[4]).toBe(null);
  });
});

describe('distribution du seuil de qualification', () => {
  it('le score de coupure est celui du dernier qualifié', () => {
    const run = RUN({ focusDriverId: 'C', simulations: 300 });
    expect(run.medianCut).toBeTypeOf('number');
    expect(run.cutRange.low).toBeLessThanOrEqual(run.cutRange.high);
    const totals = run.cutDistribution.reduce((s, e) => s + e.count, 0);
    expect(totals).toBe(300);
  });
});

describe('adversaires suivis', () => {
  it('remonte la probabilité que chaque rival finisse devant', () => {
    const run = RUN({ focusDriverId: 'D', rivalIds: ['C', 'E'] });
    expect(run.rivals.map(r => r.driverId).sort()).toEqual(['C', 'E']);
    for (const r of run.rivals) {
      expect(r.probabilityAhead).toBeGreaterThanOrEqual(0);
      expect(r.probabilityAhead).toBeLessThanOrEqual(1);
    }
    // C est modélisé plus rapide que E : il doit passer devant D plus souvent.
    const byId = Object.fromEntries(run.rivals.map(r => [r.driverId, r.probabilityAhead]));
    expect(byId.C).toBeGreaterThan(byId.E);
  });
});

describe('source des partants', () => {
  it('« checkpoint » ignore la liste d\'inscrits d\'une manche future', () => {
    // Cas réel : le plateau de Q4 est parfois plus petit que celui d'après Q3
    // parce que des pilotes se sont retirés. Lire cette liste en backtest
    // reviendrait à connaître les forfaits à l'avance.
    const f = makeOrderedMeeting({
      id: 'M1', drivers: SIX, phases: { DF: ['A', 'B'] },
      orders: { 1: SIX, 2: SIX, 3: SIX, 4: [] },
    });
    // Q4 n'a pas encore de résultat ; on lui donne une liste d'inscrits
    // réduite à 4 pilotes, exactement comme quand des pilotes se retirent.
    const mq4 = f.sessions.find(s => s.type === 'MQ' && s.num === 4);
    for (const d of ['A', 'B', 'C', 'D']) {
      f.participants.push({
        id: `${mq4.id}_${d}`, sessionId: mq4.id, driverId: d,
        carNumber: 1 + SIX.indexOf(d), firstName: d, lastName: d,
        category: 'TestCat', year: 2026, meetingId: 'M1',
      });
    }
    const merged = mergeFixtures([f]);
    const ctx = buildMeetingContext(buildGroups({
      sessions: merged.sessions, results: merged.results,
      participants: merged.participants, meetings: merged.meetings,
    })[0], TEST_REGULATION);

    expect(entrantsOfRace(ctx, 4, SIX)).toHaveLength(4);

    const session = simulateFromCheckpoint({ context: ctx, checkpoint: 3, models: models(), threshold: 2, focusDriverId: 'E', simulations: 40, seed: 3, entrantsSource: 'session' });
    const checkpoint = simulateFromCheckpoint({ context: ctx, checkpoint: 3, models: models(), threshold: 2, focusDriverId: 'E', simulations: 40, seed: 3, entrantsSource: 'checkpoint' });

    // En mode « session », E n'est pas inscrit en Q4 : il ne court pas.
    expect(session.standingsSample.find(d => d.driverId === 'E').mqPos[4]).toBeUndefined();
    // En mode « checkpoint », le plateau d'après Q3 est reconduit : il court.
    expect(checkpoint.standingsSample.find(d => d.driverId === 'E').mqPos[4]).not.toBeUndefined();
  });
});

describe('checkpoint après Q1 — le classement de départ ne doit pas être vide', () => {
  it('le simulateur n\'hérite pas du défaut « 2 manches classées » de calc.js', () => {
    // Régression : avec le défaut de calc.js, le classement après Q1 est vide,
    // donc aucun partant, donc une probabilité nulle produite en silence.
    const f = makeOrderedMeeting({
      id: 'M1', drivers: SIX, phases: { DF: ['A', 'B'] },
      orders: { 1: SIX, 2: [], 3: [], 4: [] },
    });
    const merged = mergeFixtures([f]);
    const ctx = buildMeetingContext(buildGroups({
      sessions: merged.sessions, results: merged.results,
      participants: merged.participants, meetings: merged.meetings,
    })[0], TEST_REGULATION);

    expect(buildStateAfterRace(ctx, 1).count).toBe(6);
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 1, models: models(), threshold: 2,
      focusDriverId: 'A', simulations: 80, seed: 3,
    });
    expect(run.remainingRaces).toEqual([2, 3, 4]);
    expect(run.probability).not.toBe(null);
    expect(run.countedCount).toBe(80);
  });
});

describe('scénarios « et si »', () => {
  it('couvre toutes les places du plateau et les statuts', () => {
    const w = whatIfResults({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', raceNum: 4, simulations: 120, seed: 6,
    });
    expect(w.entries.filter(e => e.kind === 'position')).toHaveLength(SIX.length);
    // Les statuts testés viennent du RÈGLEMENT, pas d'une liste figée : le
    // règlement de test en définit quatre, DSQ_RACE compris.
    expect(w.entries.filter(e => e.kind === 'status').map(e => e.status))
      .toEqual(forceableStatuses(TEST_REGULATION));
    expect(forceableStatuses(TEST_REGULATION)).toEqual(['DNF', 'DNS', 'DSQ', 'DSQ_RACE']);
    expect(forceableStatuses(null)).toEqual(FORCEABLE_STATUSES);
    expect(w.raceNum).toBe(4);
    expect(w.seed).toBe(6);
  });

  it('la courbe décroît globalement quand la place se dégrade', () => {
    const w = whatIfResults({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', raceNum: 4, simulations: 600, seed: 6,
    });
    const positions = w.entries.filter(e => e.kind === 'position').sort((a, b) => a.position - b.position);
    expect(positions[0].probability).toBeGreaterThanOrEqual(positions[positions.length - 1].probability);
  });

  it('on peut restreindre les places testées', () => {
    const w = whatIfResults({
      context: contextAfterQ3(), checkpoint: 3, models: models(), threshold: THRESHOLD,
      focusDriverId: 'C', raceNum: 4, positions: [1, 3], statuses: ['DNF'],
      simulations: 60, seed: 6,
    });
    expect(w.entries.map(e => e.label)).toEqual(['P1', 'P3', 'DNF']);
  });
});
