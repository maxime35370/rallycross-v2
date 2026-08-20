/* ═══════════════════════════════════════════════
   RACEINPROGRESS.TEST.JS — Une manche partiellement courue n'est pas
   une manche terminée.

   C'est la correction la plus critique du module, parce que la confusion
   entre « des résultats existent » et « la manche est finie » ne provoque
   aucune erreur visible : elle produit silencieusement

     · un classement intermédiaire mélangeant des totaux sur 3 et sur 4
       manches, donc un ordre faux ;
     · l'entrée du meeting EN COURS dans l'historique du LOT 1 avec une
       manche incomplète, donc une base de référence polluée pour TOUS les
       autres meetings.

   Les tests ci-dessous prouvent les trois propriétés demandées : le meeting
   n'est pas terminé, il ne produit aucune observation historique, et la
   baseline historique est rigoureusement inchangée en sa présence.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  buildGroups, buildMeetingContext, buildStateAfterRace, buildAllStates,
  raceResultOf, seriesStateOf,
} from '../js/projection/qualificationState.js';
import { buildObservations, buildHistoricalOutlook } from '../js/projection/qualificationHistory.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

const CHAMPS = { champ_test: TEST_REGULATION };
const FIELD = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Manche entièrement courue : l'ordre du tableau est l'ordre d'arrivée. */
const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 1000 + i * 100]));

/**
 * Manche partiellement courue : `order` a couru, `rest` est engagé mais pas
 * encore passé (aucun document résultat, comme en production).
 */
const partial = (order, rest) => ({
  ...ran(order),
  ...Object.fromEntries(rest.map(d => [d, PENDING])),
});

/** Meeting terminé, servant de référence historique stable. */
function pastMeeting(id, date, shift) {
  const rot = n => [...FIELD.slice(n), ...FIELD.slice(0, n)];
  return makeMeeting({
    meetingId: id, drivers: FIELD, plannedRaces: 4,
    meeting: { date, id },
    phases: { DF: FIELD.slice(0, 3) },
    races: { 1: ran(rot(shift)), 2: ran(rot(shift + 1)), 3: ran(rot(shift + 2)), 4: ran(rot(shift + 3)) },
  });
}

/** Meeting du jour, dont la manche `raceNum` est en cours. */
function liveMeeting({ raceNum = 4, ranDrivers = ['C', 'A'] } = {}) {
  const rest = FIELD.filter(d => !ranDrivers.includes(d));
  const races = {};
  for (let n = 1; n < raceNum; n++) races[n] = ran([...FIELD.slice(n), ...FIELD.slice(0, n)]);
  races[raceNum] = partial(ranDrivers, rest);
  for (let n = raceNum + 1; n <= 4; n++) races[n] = Object.fromEntries(FIELD.map(d => [d, PENDING]));
  return makeMeeting({
    meetingId: 'LIVE', drivers: FIELD, plannedRaces: 4,
    meeting: { date: '2026-08-20', id: 'LIVE' },
    phases: {}, races,
  });
}

function contextsOf(fixtures) {
  const m = mergeFixtures(fixtures);
  return buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION));
}

const liveCtx = (opts) => contextsOf([liveMeeting(opts)]).find(c => c.meetingId === 'LIVE');

// ─────────────────────────────────────────────────────────

describe('une manche partiellement courue n\'est pas terminée', () => {
  it('la manche en cours est marquée en cours, pas terminée', () => {
    const ctx = liveCtx();
    const q4 = ctx.races.find(r => r.num === 4);

    expect(q4.hasResults).toBe(true);      // des résultats existent…
    expect(q4.isComplete).toBe(false);     // …mais la manche n'est pas finie
    expect(q4.isInProgress).toBe(true);
    expect(q4.ranCount).toBe(2);
    expect(q4.engagedCount).toBe(6);
    expect(q4.pendingDriverIds.sort()).toEqual(['B', 'D', 'E', 'F']);
  });

  it('le meeting n\'est pas considéré comme terminé', () => {
    const ctx = liveCtx();
    expect(ctx.isComplete).toBe(false);
    expect(ctx.lastCompletedRace).toBe(3);
    expect(ctx.completedRaces).toEqual([1, 2, 3]);
    expect(ctx.raceInProgress).toBe(4);
    expect(ctx.inProgressRace.num).toBe(4);
  });

  it('une manche non commencée n\'est ni terminée ni en cours', () => {
    const ctx = liveCtx({ raceNum: 3 });
    const q4 = ctx.races.find(r => r.num === 4);
    expect(q4.hasResults).toBe(false);
    expect(q4.isComplete).toBe(false);
    expect(q4.isInProgress).toBe(false);
    expect(q4.ranCount).toBe(0);
    expect(ctx.raceInProgress).toBe(3);
  });

  it('un pilote pas encore passé n\'a pas de résultat, celui qui a couru en a un', () => {
    const ctx = liveCtx();
    expect(raceResultOf(ctx, 4, 'B')).toBeNull();
    expect(raceResultOf(ctx, 4, 'C')).toMatchObject({ position: 1 });
  });

  it('un document résultat vide vaut « pas encore couru »', () => {
    // Variante défensive : si un document existe mais ne porte ni chrono ni
    // statut, il ne doit pas compter comme une participation.
    const vide = makeMeeting({
      meetingId: 'VIDE', drivers: FIELD, plannedRaces: 4,
      meeting: { date: '2026-08-20', id: 'VIDE' },
      races: {
        1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD),
        4: { ...ran(['C', 'A']), ...Object.fromEntries(['B', 'D', 'E', 'F'].map(d => [d, { ms: null, status: null }])) },
      },
    });
    const ctx = contextsOf([vide])[0];
    const q4 = ctx.races.find(r => r.num === 4);
    expect(q4.isComplete).toBe(false);
    expect(q4.ranCount).toBe(2);
    expect(q4.pendingDriverIds.sort()).toEqual(['B', 'D', 'E', 'F']);
  });
});

describe('un classement ne se fonde jamais sur une manche en cours', () => {
  it('l\'état demandé après Q4 ignore la manche en cours', () => {
    const ctx = liveCtx();
    const apresQ3 = buildStateAfterRace(ctx, 3);
    const apresQ4 = buildStateAfterRace(ctx, 4);
    // Sans ce filtre, A et C auraient les points de 4 manches et les autres
    // ceux de 3 : le classement serait faux, sans le moindre signal d'erreur.
    expect(apresQ4.standings).toEqual(apresQ3.standings);
  });

  it('aucun checkpoint n\'est ouvert sur la manche en cours', () => {
    const states = buildAllStates(liveCtx());
    expect(Object.keys(states).map(Number).sort()).toEqual([1, 2, 3]);
  });

  it('tous les pilotes classés au checkpoint ont couru le même nombre de manches', () => {
    const ctx = liveCtx();
    const state = buildStateAfterRace(ctx, ctx.lastCompletedRace);
    // `mqCount` est le nombre de manches classées : il doit valoir 3 pour
    // tout le monde, et surtout pas 4 pour les deux pilotes déjà passés en Q4.
    const counts = new Set(state.standings.map(d => d.mqCount));
    expect(state.count).toBe(6);
    expect([...counts]).toEqual([3]);
  });
});

describe('un meeting en cours ne pollue pas l\'historique', () => {
  const passe = [pastMeeting('P1', '2026-05-01', 0), pastMeeting('P2', '2026-06-01', 2), pastMeeting('P3', '2026-07-01', 4)];

  it('il ne produit aucune observation historique', () => {
    const ctx = liveCtx();
    const obs = buildObservations([ctx], { championshipsById: CHAMPS, requireComplete: true });
    expect(obs).toHaveLength(0);
  });

  it('la baseline historique est rigoureusement identique avec ou sans lui', () => {
    const sans = buildObservations(contextsOf(passe), { championshipsById: CHAMPS, requireComplete: true });
    const avec = buildObservations(contextsOf([...passe, liveMeeting()]), { championshipsById: CHAMPS, requireComplete: true });

    expect(sans.length).toBeGreaterThan(0);
    expect(avec).toEqual(sans);
    expect(avec.some(o => o.meetingId === 'LIVE')).toBe(false);
  });

  it('les taux historiques affichés sont inchangés', () => {
    const outlook = (contexts) => buildHistoricalOutlook({
      observations: buildObservations(contexts, { championshipsById: CHAMPS, requireComplete: true }),
      checkpoint: 3, finalRace: 4,
      driver: { points: 20, position: 3, gap: 0 },
      filters: { championshipId: 'champ_test', category: 'TestCat' },
    });
    expect(outlook(contextsOf([...passe, liveMeeting()]))).toEqual(outlook(contextsOf(passe)));
  });

  it('une fois la manche terminée, le meeting entre normalement dans l\'historique', () => {
    // Preuve que le garde-fou n'est pas simplement trop strict.
    const fini = makeMeeting({
      meetingId: 'LIVE', drivers: FIELD, plannedRaces: 4,
      meeting: { date: '2026-08-20', id: 'LIVE' },
      phases: { DF: FIELD.slice(0, 3) },
      races: { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: ran(FIELD) },
    });
    const ctx = contextsOf([fini])[0];
    expect(ctx.isComplete).toBe(true);
    expect(ctx.raceInProgress).toBeNull();
    expect(buildObservations([ctx], { championshipsById: CHAMPS, requireComplete: true })).toHaveLength(6);
  });
});

describe('le comportement est générique, pas spécifique à Q4', () => {
  for (const raceNum of [2, 3, 4]) {
    it(`Q${raceNum} en cours : dernier checkpoint = Q${raceNum - 1}, aucune observation`, () => {
      const ctx = liveCtx({ raceNum });
      expect(ctx.isComplete).toBe(false);
      expect(ctx.raceInProgress).toBe(raceNum);
      expect(ctx.lastCompletedRace).toBe(raceNum - 1);
      expect(buildObservations([ctx], { championshipsById: CHAMPS, requireComplete: true })).toHaveLength(0);
    });
  }

  it('Q1 en cours : aucun checkpoint disponible du tout', () => {
    const ctx = liveCtx({ raceNum: 1 });
    expect(ctx.lastCompletedRace).toBe(0);
    expect(ctx.raceInProgress).toBe(1);
    expect(buildStateAfterRace(ctx, 1).count).toBe(0);
  });
});

describe('le nombre de séries terminées n\'est affirmé que s\'il est connu', () => {
  const REG = { ...TEST_REGULATION, sessionConfig: { ...TEST_REGULATION.sessionConfig, MQ: { count: 4, driversPerSeries: 3 } } };
  const participants = FIELD.map((d, i) => ({ driverId: d, carNumber: i + 1 }));

  it('séries connues et complètes : le compte est fiable', () => {
    const results = [
      { driverId: 'A', ms: 1000, serie: 1 }, { driverId: 'B', ms: 1100, serie: 1 }, { driverId: 'C', ms: 1200, serie: 1 },
      { driverId: 'D', ms: 1300, serie: 2 }, { driverId: 'E', ms: 1400, serie: 2 }, { driverId: 'F', ms: 1500, serie: 2 },
    ];
    const st = seriesStateOf(participants, results, new Set(FIELD), REG);
    expect(st.expectedCount).toBe(2);
    expect(st.membershipFullyKnown).toBe(true);
    expect(st.completeCount).toBe(2);
  });

  it('une série dont tous les membres n\'ont pas couru n\'est pas terminée', () => {
    const results = [
      { driverId: 'A', ms: 1000, serie: 1 }, { driverId: 'B', ms: 1100, serie: 1 }, { driverId: 'C', ms: 1200, serie: 1 },
      { driverId: 'D', ms: null, status: null, serie: 2 }, { driverId: 'E', ms: null, status: null, serie: 2 }, { driverId: 'F', ms: null, status: null, serie: 2 },
    ];
    const st = seriesStateOf(participants, results, new Set(['A', 'B', 'C']), REG);
    expect(st.membershipFullyKnown).toBe(true);
    expect(st.completeCount).toBe(1);
  });

  it('appartenances inconnues : on ne déduit aucun compte de séries', () => {
    // Les pilotes restant à courir n'ont pas de série renseignée : on sait
    // combien de PILOTES ont couru, pas combien de SÉRIES sont finies.
    const results = [
      { driverId: 'A', ms: 1000, serie: 1 }, { driverId: 'B', ms: 1100, serie: 1 }, { driverId: 'C', ms: 1200, serie: 1 },
    ];
    const st = seriesStateOf(participants, results, new Set(['A', 'B', 'C']), REG);
    expect(st.membershipFullyKnown).toBe(false);
    expect(st.expectedCount).toBe(2);
    expect(st.completeCount).toBe(1);
  });
});
