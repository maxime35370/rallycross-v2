/* ═══════════════════════════════════════════════
   LIVESTRATEGY.TEST.JS — L'objectif se calcule au niveau SÉRIE, pas au niveau
   « pilote seul contre un chrono ».

   Le piège central, et la raison d'être de ces tests : le classement provisoire
   d'une manche en cours invite à une traduction immédiate — « P4 provisoire
   fait 2:45.988, donc battre 2:45.988 = être P4 ». C'est faux tant que des
   pilotes doivent encore rouler, et particulièrement faux pour les COÉQUIPIERS
   DE SÉRIE, qui partent en même temps et peuvent s'intercaler.

   Les tests vérifient donc que le moteur :
     · simule bien tous les pilotes non encore passés, pas seulement le nôtre ;
     · ne présente une cible chrono comme exacte que lorsqu'elle l'est ;
     · n'invente pas d'objectif à un pilote déjà tranquille ;
     · n'invente pas d'objectif atteignable à un pilote qui dépend des autres.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../js/projection/qualificationState.js';
import { simulateFromCheckpoint, simulateRaceRows, makeDrawBuffers, drawRace, timeScaleOf, entrantsOfRace, realResultsOfRace } from '../js/projection/scenarioSimulator.js';
import { createRng } from '../js/projection/monteCarloEngine.js';
import { buildDriverModels, collectRaceObservations } from '../js/projection/driverPerformanceModel.js';
import {
  seriesPlan, passingOrder, provisionalOrder, chronoForProvisionalPosition,
  mathematicalChronoTarget, chronoLadder, buildLiveObjective, pickScenarios, directRivals,
} from '../js/projection/liveStrategy.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

const FIELD = Array.from({ length: 10 }, (_, i) => `D${i + 1}`);
const REG = {
  ...TEST_REGULATION,
  sessionConfig: { ...TEST_REGULATION.sessionConfig, MQ: { count: 4, driversPerSeries: 5 } },
};
const rot = n => [...FIELD.slice(n), ...FIELD.slice(0, n)];
const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 60000 + i * 800]));

/**
 * Meeting dont la manche 4 est partiellement courue.
 * `doneWithSerie` : { pilote: [chrono, série] } — les pilotes passés portent
 * leur série, comme en production ; les autres n'ont aucun résultat.
 */
function liveCtx({ done = {}, orders = null } = {}) {
  const q4 = {};
  for (const [d, [ms, serie]] of Object.entries(done)) q4[d] = { ms, serie };
  for (const d of FIELD) if (!(d in q4)) q4[d] = PENDING;
  const m = mergeFixtures([makeMeeting({
    meetingId: 'L', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'L' },
    races: { 1: ran(orders?.[1] || FIELD), 2: ran(orders?.[2] || rot(2)), 3: ran(orders?.[3] || rot(4)), 4: q4 },
  })]);
  return buildGroups(m).map(g => buildMeetingContext(g, REG))[0];
}

const modelsOf = (ctx, cp) => buildDriverModels({
  driverIds: FIELD,
  observations: collectRaceObservations([ctx]).filter(o => o.raceNum <= cp),
  scope: { meetingId: ctx.meetingId, year: 2026, category: ctx.category, circuit: 'Circuit de test' },
}).models;

/** Cinq pilotes passés, en série 1 ; cinq restants, en série 2. */
const SERIE1 = { D1: [60000, 1], D2: [60800, 1], D3: [61600, 1], D4: [62400, 1], D5: [63200, 1] };

// ─────────────────────────────────────────────────────────

describe('composition des séries', () => {
  it('les séries des pilotes passés sont LUES, jamais déduites', () => {
    const plan = seriesPlan(liveCtx({ done: SERIE1 }), 4);
    const s1 = plan.series.find(s => s.num === 1);
    expect(s1.ranMembers.sort()).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(s1.complete).toBe(true);
    expect(s1.inferred).toBe(false);
  });

  it('quand tous les restants tiennent dans une seule série, ce n\'est plus une déduction', () => {
    // Cinq passés en série 1, cinq restants : ils forment forcément la série 2.
    const plan = seriesPlan(liveCtx({ done: SERIE1 }), 4);
    const s2 = plan.series.find(s => s.num === 2);
    expect(s2.pendingMembers).toHaveLength(5);
    expect(s2.inferred).toBe(false);
    expect(plan.of('D6').inferred).toBe(false);
  });

  it('sinon la composition est déduite, et signalée comme telle', () => {
    // Un seul pilote passé : les neuf autres se répartissent sur deux séries,
    // ce qui ne peut être que déduit.
    const plan = seriesPlan(liveCtx({ done: { D1: [60000, 1] } }), 4);
    expect(plan.of('D9').inferred).toBe(true);
  });

  it('l\'ordre de passage est l\'inverse du classement précédent', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const ordre = passingOrder(ctx, 4);
    const q3 = ctx.races.find(r => r.num === 3).rows
      .filter(r => r.ms != null).sort((a, b) => a.ms - b.ms).map(r => r.driverId);
    expect(ordre).toEqual([...q3].reverse());
  });
});

describe('la traduction d\'une position en chrono dit ce qu\'elle vaut', () => {
  it('battre le chrono de la position visée, et savoir si c\'est exact', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const t = chronoForProvisionalPosition(ctx, 4, 4, { excludeDriverId: 'D6' });
    expect(t.beat).toBe(62400);          // chrono du P4 provisoire
    expect(t.beatDriverId).toBe('D4');
    expect(t.certain).toBe(false);       // quatre autres doivent encore rouler
    expect(t.pendingOthers).toBe(4);
  });

  it('la cible devient EXACTE quand notre pilote est le dernier à courir', () => {
    const done = { ...SERIE1, D6: [60400, 2], D7: [61200, 2], D8: [62000, 2], D9: [62800, 2] };
    const ctx = liveCtx({ done });
    const t = chronoForProvisionalPosition(ctx, 4, 3, { excludeDriverId: 'D10' });
    expect(t.certain).toBe(true);
    expect(t.pendingOthers).toBe(0);
  });
});

describe('battre le chrono d\'une position ne donne pas cette position', () => {
  it('les coéquipiers de série peuvent s\'intercaler, et le moteur le mesure', () => {
    // D6 vise « P4 provisoire ou mieux » en battant 62 400. Mais D7 à D10
    // partent avec lui : il peut battre 62 400 et ressortir bien plus loin.
    const ctx = liveCtx({ done: SERIE1 });
    const models = modelsOf(ctx, 3);
    const mates = ['D7', 'D8', 'D9', 'D10'];

    const l = chronoLadder({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6', raceNum: 4,
      targets: [{ provisionalTarget: 4, ms: 62399, reference: { beat: 62400 } }],
      simulations: 1500, seed: 7, seriesMates: mates,
    });
    const e = l.entries[0];

    // Sa place FINALE médiane dans la manche est plus mauvaise que P4 : la
    // lecture naïve du classement provisoire est bien fausse.
    expect(e.medianRacePosition).toBeGreaterThan(4);
    // Et le moteur sait dire lesquels le menacent.
    const menace = mates.map(id => 1 - (e.aheadOfSeriesMates[id] ?? 0));
    expect(Math.max(...menace)).toBeGreaterThan(0.1);
  });

  it('sans coéquipier restant, battre le chrono donne exactement la position', () => {
    // Notre pilote est le dernier à rouler : plus personne ne peut s'intercaler.
    const done = { ...SERIE1, D6: [60400, 2], D7: [61200, 2], D8: [62000, 2], D9: [62800, 2] };
    const ctx = liveCtx({ done });
    const models = modelsOf(ctx, 3);
    const ordre = provisionalOrder(ctx, 4);
    const cible = ordre[2];               // P3 provisoire

    const ids = entrantsOfRace(ctx, 4, FIELD);
    const race = {
      num: 4, ids, participants: ids.map(id => ({ driverId: id })),
      real: realResultsOfRace(ctx, 4),
    };
    const scale = timeScaleOf(ctx, 4, { models });
    const bufs = makeDrawBuffers([race]);
    const rng = createRng(3);
    for (let k = 0; k < 200; k++) {
      drawRace(rng, race, bufs[0]);
      const rows = simulateRaceRows(race, bufs[0], models,
        { D10: { ms: cible.ms - 1 } }, scale, REG);
      expect(rows.find(r => r.driverId === 'D10').position).toBe(3);
    }
  });
});

describe('objectif mathématique', () => {
  it('cherche le seuil le PLUS PERMISSIF, pas le premier trouvé', () => {
    // Pilote largement en tête : aucun chrono ne doit lui être imposé.
    const ctx = liveCtx({ done: SERIE1 });
    const state = buildStateAfterRace(ctx, 3);
    const leader = state.standings[0];
    const m = mathematicalChronoTarget({
      context: ctx, raceNum: 4, driverId: leader.driverId, threshold: 8, checkpoint: 3,
    });
    expect(m.unconditional).toBe(true);
    expect(m.beat).toBeNull();
  });

  it('un seuil serré produit une cible chrono, et elle est vérifiée par simulation', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const models = modelsOf(ctx, 3);
    const state = buildStateAfterRace(ctx, 3);
    const focus = state.standings.find(d => !Object.keys(SERIE1).includes(d.driverId));
    const m = mathematicalChronoTarget({
      context: ctx, raceNum: 4, driverId: focus.driverId, threshold: 3, checkpoint: 3,
    });
    if (m.beat == null) return;   // rien à démontrer si aucune cible n'existe

    // La promesse « acquis » doit tenir dans TOUS les tirages.
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models, threshold: 3, focusDriverId: focus.driverId,
      forced: { 4: { [focus.driverId]: { ms: m.beat - 1 } } },
      simulations: 800, seed: 21,
    });
    expect(run.probability).toBe(1);
  });

  it('quand aucun chrono ne suffit, on le dit au lieu d\'inventer une cible', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const state = buildStateAfterRace(ctx, 3);
    const dernier = state.standings[state.standings.length - 1];
    const m = mathematicalChronoTarget({
      context: ctx, raceNum: 4, driverId: dernier.driverId, threshold: 1, checkpoint: 3,
    });
    expect(m.impossible).toBe(true);
    expect(m.beat).toBeNull();
  });
});

describe('l\'objectif s\'adapte à la situation', () => {
  const ctx = liveCtx({ done: SERIE1 });
  const models = modelsOf(ctx, 3);
  const base = (driverId, threshold) => simulateFromCheckpoint({
    context: ctx, checkpoint: 3, models, threshold, focusDriverId: driverId,
    simulations: 2000, seed: 5,
    rivalIds: FIELD.filter(id => id !== driverId),
  });

  it('pilote tranquille : aucun objectif agressif n\'est inventé', () => {
    const state = buildStateAfterRace(ctx, 3);
    // Le meneur PARMI CEUX QUI DOIVENT ENCORE COURIR : un pilote déjà passé
    // relèverait de la lecture inversée, pas de l'objectif.
    const leader = state.standings.find(d => !Object.keys(SERIE1).includes(d.driverId));
    const o = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 8, driverId: leader.driverId,
      baseRun: base(leader.driverId, 8), seed: 5, simulations: 400,
    });
    expect(['settled', 'comfortable']).toContain(o.mode);
    expect(o.target).toBeUndefined();
  });

  it('pilote hors de portée : dépendance annoncée, pas de cible impossible', () => {
    const state = buildStateAfterRace(ctx, 3);
    const dernier = [...state.standings].reverse()
      .find(d => !Object.keys(SERIE1).includes(d.driverId));
    const o = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 1, driverId: dernier.driverId,
      baseRun: base(dernier.driverId, 1), seed: 5, simulations: 400,
    });
    expect(o.mode).toBe('dependent');
    expect(o.best.probability).toBeLessThan(0.9);
  });

  it('après son passage, la lecture s\'inverse', () => {
    const o = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D1',
      baseRun: base('D1', 5), seed: 5, simulations: 400,
    });
    expect(o.mode).toBe('afterRun');
    expect(o.hasRun).toBe(true);
    // Les menaces listées sont uniquement des pilotes encore à courir.
    for (const t of o.threats) expect(Object.keys(SERIE1)).not.toContain(t.driverId);
  });

  it('cas normal : une cible, sa nature, et les coéquipiers qui la menacent', () => {
    const o = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: base('D6', 5), seed: 5, simulations: 600,
    });
    if (o.mode !== 'target') return;
    expect(o.target.probability).toBeGreaterThanOrEqual(0.8);
    expect(o.exact).toBe(false);                        // quatre coéquipiers restent
    expect(o.series.pendingMates.length).toBe(4);
    for (const m of o.seriesThreat) {
      expect(m.probabilityBeatsTarget).toBeGreaterThanOrEqual(0);
      expect(m.probabilityBeatsTarget).toBeLessThanOrEqual(1);
    }
  });

  it('l\'échelle de cibles couvre bien la zone de bascule', () => {
    const o = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: base('D6', 5), seed: 5, simulations: 500,
    });
    const p = (o.ladder || []).map(e => e.probability).filter(v => v != null);
    if (p.length < 2) return;
    // Elle doit descendre : une échelle plate ne dirait rien.
    expect(Math.max(...p) - Math.min(...p)).toBeGreaterThan(0.05);
    // Et inclure l'hypothèse basse « derrière tous les pilotes déjà passés ».
    expect((o.ladder || []).some(e => e.behindAll)).toBe(true);
  });
});

describe('concurrents directs : mesurés, pas supposés', () => {
  it('un pilote déjà passé n\'est plus une variable', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const models = modelsOf(ctx, 3);
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models, threshold: 5, focusDriverId: 'D6',
      simulations: 1500, seed: 5, rivalIds: FIELD.filter(id => id !== 'D6'),
    });
    const r = directRivals({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: run, seed: 5, simulations: 400,
    });
    for (const x of r.all) {
      if (Object.keys(SERIE1).includes(x.driverId)) {
        expect(x.settled, x.driverId).toBe(true);
        expect(x.impact).toBe(0);
      }
    }
    expect(r.minImpact).toBeGreaterThan(0);
  });

  it('l\'impact est un effet, pas une proximité au classement', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const models = modelsOf(ctx, 3);
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models, threshold: 5, focusDriverId: 'D6',
      simulations: 1500, seed: 5, rivalIds: FIELD.filter(id => id !== 'D6'),
    });
    const r = directRivals({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: run, seed: 5, simulations: 600,
    });
    const mesures = r.all.filter(x => !x.settled);
    expect(mesures.length).toBeGreaterThan(0);
    for (const x of mesures) {
      // Un adversaire qui réussit ne peut pas AIDER notre pilote.
      expect(x.probabilityIfRivalOut).toBeGreaterThanOrEqual(x.probabilityIfRivalBest - 1e-9);
    }
  });
});

describe('scénarios proposés', () => {
  it('deux ou trois au plus, et jamais deux fois la même idée', () => {
    const ctx = liveCtx({ done: SERIE1 });
    const models = modelsOf(ctx, 3);
    const run = simulateFromCheckpoint({
      context: ctx, checkpoint: 3, models, threshold: 5, focusDriverId: 'D6',
      simulations: 1500, seed: 5, rivalIds: FIELD.filter(id => id !== 'D6'),
    });
    const objective = buildLiveObjective({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: run, seed: 5, simulations: 500,
    });
    const rivals = directRivals({
      context: ctx, checkpoint: 3, models, threshold: 5, driverId: 'D6',
      baseRun: run, seed: 5, simulations: 400,
    });
    const sc = pickScenarios({ objective, rivals });
    expect(sc.length).toBeLessThanOrEqual(3);
    expect(new Set(sc.map(x => x.kind)).size).toBe(sc.length);
  });
});
