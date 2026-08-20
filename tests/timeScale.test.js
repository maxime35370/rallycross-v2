/* ═══════════════════════════════════════════════
   TIMESCALE.TEST.JS — L'échelle de temps, et pourquoi elle ne compte que
   pendant une manche en cours.

   Deux propriétés opposées, qui expliquent à elles seules l'histoire de ce
   composant :

   1. En simulation PURE, l'échelle n'a aucun effet sur le classement. Les
      positions viennent de l'ordre des forces tirées, et les chronos émis sont
      une fonction croissante du rang. On peut donc multiplier l'échelle par
      cent sans déplacer un seul pilote — c'est ce qui garantit qu'améliorer
      l'estimation ne change RIEN aux backtests des lots précédents.

   2. En mode HYBRIDE, elle décide de tout. Les chronos réels sont comparés aux
      forces tirées : une échelle trop large place tous les pilotes restants
      derrière tous les pilotes déjà passés, et la projection s'effondre pour
      une raison purement instrumentale.

   Le piège concret, mesuré sur les données réelles : les séries ne sont pas
   tirées au sort. Les premiers passés sont les plus lents du plateau. Lire leur
   rang comme un quantile du plateau fait exploser la pente estimée.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  timeScaleOf, simulateRaceRows, makeDrawBuffers, drawRace,
  simulateFromCheckpoint, entrantsOfRace, realResultsOfRace,
} from '../js/projection/scenarioSimulator.js';
import { createRng } from '../js/projection/monteCarloEngine.js';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../js/projection/qualificationState.js';
import { buildDriverModels, collectRaceObservations } from '../js/projection/driverPerformanceModel.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

const FIELD = Array.from({ length: 12 }, (_, i) => `D${i + 1}`);
const rot = n => [...FIELD.slice(n), ...FIELD.slice(0, n)];

/** Chronos réalistes : 60 s en tête, 12 s d'étendue sur tout le plateau. */
const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 60000 + Math.round(i * 12000 / (FIELD.length - 1))]));

/**
 * Meeting dont la manche 4 est courue par une SÉRIE, et pas n'importe laquelle :
 * celle des pilotes les plus lents, comme dans la réalité.
 */
function ctxSerieLente({ taille = 4 } = {}) {
  const lents = rot(0).slice(-taille);         // les derniers de Q1..Q3
  const q4 = {};
  lents.forEach((d, i) => { q4[d] = 68000 + i * 1500; });   // chronos de fin de plateau
  for (const d of FIELD) if (!(d in q4)) q4[d] = PENDING;
  const m = mergeFixtures([makeMeeting({
    meetingId: 'L', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'L' },
    races: { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: q4 },
  })]);
  return { ctx: buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION))[0], lents };
}

function modelsOf(ctx, checkpoint) {
  return buildDriverModels({
    driverIds: FIELD,
    observations: collectRaceObservations([ctx]).filter(o => o.raceNum <= checkpoint),
    scope: { meetingId: ctx.meetingId, year: 2026, category: ctx.category, circuit: 'Circuit de test' },
  }).models;
}

// ─────────────────────────────────────────────────────────

describe('en simulation pure, l\'échelle n\'a aucun effet sur le classement', () => {
  const m = mergeFixtures([makeMeeting({
    meetingId: 'P', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'P' },
    races: { 1: ran(FIELD), 2: ran(rot(3)), 3: ran(rot(7)), 4: Object.fromEntries(FIELD.map(d => [d, PENDING])) },
  })]);
  const ctx = buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
  const models = modelsOf(ctx, 3);

  it('multiplier l\'échelle par cent ne déplace aucun pilote', () => {
    const ids = entrantsOfRace(ctx, 4, FIELD);
    const race = { num: 4, ids, participants: ids.map(id => ({ driverId: id })), real: null };
    const rejoue = (scale) => {
      const bufs = makeDrawBuffers([race]);
      const rng = createRng(11);
      const out = [];
      for (let k = 0; k < 200; k++) {
        drawRace(rng, race, bufs[0]);
        out.push(simulateRaceRows(race, bufs[0], models, null, scale, TEST_REGULATION)
          .map(r => `${r.driverId}:${r.position}:${r.points}`).join('|'));
      }
      return out;
    };
    const normal = rejoue({ baseMs: 60000, msPerZ: 1000, source: null });
    const enorme = rejoue({ baseMs: 999000, msPerZ: 100000, source: null });
    expect(enorme).toEqual(normal);
  });

  it('la probabilité finale est insensible à l\'échelle, sans résultat réel', () => {
    // Deux meetings au classement RIGOUREUSEMENT identique — mêmes ordres
    // d'arrivée donc mêmes points — mais dont les chronos sont dix fois plus
    // étalés. L'échelle estimée est donc dix fois plus grande, et la projection
    // doit pourtant être la même au tirage près : sans résultat réel, il n'y a
    // rien à comparer à un chrono.
    const etale = (order) => Object.fromEntries(order.map((d, i) => [d, 600000 + i * 12000]));
    const m10 = mergeFixtures([makeMeeting({
      meetingId: 'P', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'P' },
      races: { 1: etale(FIELD), 2: etale(rot(3)), 3: etale(rot(7)), 4: Object.fromEntries(FIELD.map(d => [d, PENDING])) },
    })]);
    const ctx10 = buildGroups(m10).map(g => buildMeetingContext(g, TEST_REGULATION))[0];

    const s1 = timeScaleOf(ctx, 3, { models });
    const s10 = timeScaleOf(ctx10, 3, { models: modelsOf(ctx10, 3) });
    expect(s10.msPerZ).toBeGreaterThan(s1.msPerZ * 5);   // échelles réellement différentes

    const args = { checkpoint: 3, models, threshold: 6, focusDriverId: 'D6', simulations: 1500, seed: 3 };
    expect(simulateFromCheckpoint({ ...args, context: ctx10 }).probability)
      .toBe(simulateFromCheckpoint({ ...args, context: ctx }).probability);
  });
});

describe('sur une manche en cours, l\'échelle reste réaliste', () => {
  it('une série lente ne fait pas exploser la dispersion estimée', () => {
    const { ctx } = ctxSerieLente();
    const models = modelsOf(ctx, 3);
    const complete = timeScaleOf(ctx, 3, { models });
    const enCours = timeScaleOf(ctx, 4, { models });

    expect(enCours.source).toBe(4);
    expect(enCours.shrunk).toBe(true);
    expect(enCours.basis).toBe('model');
    // La pente reste du même ordre que celle d'une manche complète : c'est tout
    // ce qu'on lui demande. Sans correction, elle était plusieurs fois trop
    // grande parce que quatre pilotes lents étaient lus comme les quatre
    // meilleurs du plateau.
    expect(enCours.msPerZ).toBeLessThan(complete.msPerZ * 2);
    expect(enCours.msPerZ).toBeGreaterThan(complete.msPerZ / 2);
  });

  it('le niveau suit les chronos réels de la manche, pas ceux de la précédente', () => {
    // Manche 4 nettement plus lente que les précédentes : l'échelle doit s'y
    // adapter, sinon les pilotes restants seraient tous simulés trop rapides.
    const { ctx: normal } = ctxSerieLente();
    const lents = rot(0).slice(-4);
    const q4 = {};
    lents.forEach((d, i) => { q4[d] = 90000 + i * 1500; });   // +22 s
    for (const d of FIELD) if (!(d in q4)) q4[d] = PENDING;
    const m = mergeFixtures([makeMeeting({
      meetingId: 'L', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'L' },
      races: { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: q4 },
    })]);
    const ralenti = buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
    const a = timeScaleOf(normal.ctx ?? normal, 4, { models: modelsOf(normal, 3) });
    const b = timeScaleOf(ralenti, 4, { models: modelsOf(ralenti, 3) });
    expect(b.baseMs).toBeGreaterThan(a.baseMs + 15000);
  });

  it('sans modèle, l\'échelle reste calculable et ordonnée', () => {
    const { ctx } = ctxSerieLente();
    const s = timeScaleOf(ctx, 4);
    expect(s.msPerZ).toBeGreaterThan(0);
    expect(Number.isFinite(s.baseMs)).toBe(true);
  });

  it('aucune manche exploitable : échelle neutre plutôt qu\'erreur', () => {
    const s = timeScaleOf({ races: [] }, 4, {});
    expect(s).toMatchObject({ baseMs: 60000, msPerZ: 1000, source: null, basis: 'none' });
  });
});

describe('les pilotes déjà passés ne sont pas avantagés par construction', () => {
  it('une série lente ne se retrouve pas en tête du classement final simulé', () => {
    // Test de non-régression du défaut mesuré : avec l'ancienne échelle, les
    // quatre pilotes les plus lents du plateau, passés en premier, finissaient
    // systématiquement aux quatre premières places.
    const { ctx, lents } = ctxSerieLente();
    const models = modelsOf(ctx, 3);
    const ids = entrantsOfRace(ctx, 4, FIELD);
    const race = {
      num: 4, ids, participants: ids.map(id => ({ driverId: id })),
      real: realResultsOfRace(ctx, 4),
    };
    const scale = timeScaleOf(ctx, 4, { models });
    const bufs = makeDrawBuffers([race]);
    const rng = createRng(4321);

    let sommeRang = 0, n = 0;
    for (let k = 0; k < 400; k++) {
      drawRace(rng, race, bufs[0]);
      const rows = simulateRaceRows(race, bufs[0], models, null, scale, TEST_REGULATION);
      for (const id of lents) { sommeRang += rows.find(r => r.driverId === id).position; n++; }
    }
    const rangMoyen = sommeRang / n;
    // Ces pilotes sont les derniers du plateau : leur place moyenne doit être
    // dans la seconde moitié, et surtout pas dans les toutes premières.
    expect(rangMoyen).toBeGreaterThan(FIELD.length / 2);
  });
});

describe('conditionner sur un résultat réel équivaut à conditionner sur le même résultat tiré', () => {
  it('la moyenne des probabilités conditionnelles retombe sur la probabilité initiale', () => {
    // Loi des espérances itérées. Un moteur qui avantagerait les pilotes déjà
    // passés ferait dériver cette moyenne — c'est exactement le symptôme qu'a
    // produit l'ancienne échelle de temps.
    const drivers = FIELD;
    const base = mergeFixtures([makeMeeting({
      meetingId: 'T', drivers, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'T' },
      races: { 1: ran(drivers), 2: ran(rot(3)), 3: ran(rot(7)), 4: Object.fromEntries(drivers.map(d => [d, PENDING])) },
    })]);
    const ctx0 = buildGroups(base).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
    const models = modelsOf(ctx0, 3);
    const THRESHOLD = 6, FOCUS = 'D7';

    const p0 = simulateFromCheckpoint({
      context: ctx0, checkpoint: 3, models, threshold: THRESHOLD,
      focusDriverId: FOCUS, simulations: 6000, seed: 20260101,
    }).probability;

    // Groupe passant en premier : les quatre derniers du classement, comme dans
    // la réalité où les séries sont composées du plus lent au plus rapide.
    const serie = buildStateAfterRace(ctx0, 3).standings.slice(-4).map(d => d.driverId);

    const ids = entrantsOfRace(ctx0, 4, drivers);
    const race = { num: 4, ids, participants: ids.map(id => ({ driverId: id })), real: null };
    const scale = timeScaleOf(ctx0, 3, { models });
    const bufs = makeDrawBuffers([race]);
    const rng = createRng(555);

    const M = 40;
    const apres = [];
    for (let m = 0; m < M; m++) {
      drawRace(rng, race, bufs[0]);
      const rows = simulateRaceRows(race, bufs[0], models, null, scale, TEST_REGULATION);
      const q4 = {};
      for (const d of drivers) {
        if (!serie.includes(d)) { q4[d] = PENDING; continue; }
        const row = rows.find(r => r.driverId === d);
        q4[d] = row.status ? { status: row.status } : Math.round(row.ms);
      }
      const inj = mergeFixtures([makeMeeting({
        meetingId: 'T', drivers, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'T' },
        races: { 1: ran(drivers), 2: ran(rot(3)), 3: ran(rot(7)), 4: q4 },
      })]);
      const ctx = buildGroups(inj).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
      apres.push(simulateFromCheckpoint({
        context: ctx, checkpoint: 3, models, threshold: THRESHOLD,
        focusDriverId: FOCUS, simulations: 1200,
        // Graine propre à chaque scénario : sinon les recalculs partagent le
        // même bruit et l'écart type mesuré serait illusoire.
        seed: 20260101 + 977 * m,
      }).probability);
    }

    const moy = apres.reduce((a, b) => a + b, 0) / M;
    const et = Math.sqrt(apres.reduce((s, p) => s + (p - moy) ** 2, 0) / (M - 1));
    const erreurType = et / Math.sqrt(M);

    // La série révélée déplace réellement la probabilité : sans cela le test ne
    // prouverait rien.
    expect(Math.max(...apres) - Math.min(...apres)).toBeGreaterThan(0.02);
    // Et pourtant la moyenne retombe sur la valeur initiale.
    expect(Math.abs(moy - p0)).toBeLessThan(Math.max(0.02, 4 * erreurType));
  });
});
