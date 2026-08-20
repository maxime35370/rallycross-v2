/* ═══════════════════════════════════════════════
   STATUSPOINTS.TEST.JS — Un statut simulé vaut exactement ce que dit le
   règlement, comme un statut réel.

   Le risque ici est insidieux : « DNF = 0 point » est une intuition tellement
   naturelle qu'elle finit par se glisser dans un simulateur sans que personne
   ne la remette en cause. Or dans les deux règlements réellement utilisés par
   Rallycross V2, un DNF vaut le barème de la position (engagés + 1) — soit
   13 points sur un plateau de 30, à un point seulement de la dernière place
   classée. Un simulateur qui mettrait 0 sous-estimerait massivement le score
   d'un pilote ayant abandonné, et donc toutes les probabilités qui en dépendent.

   La preuve retenue n'est pas de relire le code mais de COMPARER : pour chaque
   règlement, chaque statut et chaque taille de plateau, le chemin réel
   (documents Firestore → buildMqStandings) et le chemin simulé (scénario
   forcé → buildMqStandings) doivent produire la même position et les mêmes
   points.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { buildMqStandings, calcStatusPoints, mqPoints } from '../js/calc.js';
import {
  simulateRaceRows, makeDrawBuffers, forceableStatuses, FORCEABLE_STATUSES,
} from '../js/projection/scenarioSimulator.js';
import { statusesOf, positionBounds, pointsBounds, raceProgress } from '../js/projection/raceCertainties.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

/**
 * Les deux règlements réellement présents en base, reproduits ici à
 * l'identique. Ils diffèrent justement sur DNS et DSQ_RACE : c'est ce qui rend
 * la comparaison intéressante.
 */
const FFSA = {
  id: 'ffsa',
  sessionConfig: { MQ: { count: 4 }, DF: { count: 1, gridSize: 2 } },
  pointsScale: { MQ: { formula: '44 - position', overrides: { 1: 50, 2: 45, 3: 42 } } },
  statusRules: {
    DNF: { mode: 'engaged_offset', offset: 1 },
    DNS: { mode: 'fixed', points: 0 },
    DSQ: { mode: 'fixed', points: 0 },
    DSQ_RACE: { mode: 'engaged_offset', offset: 3 },
  },
  interimTiebreaker: 'last_manche_time', worstResultDrop: 0,
};

const EURO = {
  ...FFSA, id: 'euro',
  statusRules: {
    DNF: { mode: 'engaged_offset', offset: 1 },
    DNS: { mode: 'engaged_offset', offset: 5 },
    DSQ: { mode: 'fixed', points: 0 },
    DSQ_RACE: { mode: 'engaged_offset', offset: 10 },
  },
  interimTiebreaker: 'best_positions_then_time',
};

const REGLEMENTS = [['FFSA', FFSA], ['Euro RX', EURO], ['test', TEST_REGULATION]];
const STATUTS = ['DNF', 'DNS', 'DSQ', 'DSQ_RACE'];
const TAILLES = [4, 8, 12, 16, 20, 24, 28, 30, 34, 40];

const SCALE = { baseMs: 60000, msPerZ: 1000, source: null };

/** Chemin RÉEL : documents de résultat tels que l'application les écrit. */
function reel(regulation, n, statut) {
  const ids = Array.from({ length: n }, (_, i) => `D${i + 1}`);
  const participants = ids.map((id, i) => ({ driverId: id, carNumber: i + 1 }));
  const results = ids.map((id, i) => i === 0
    ? { driverId: id, ms: null, status: statut }
    : { driverId: id, ms: 60000 + i * 500, status: null });
  return buildMqStandings(participants, results, regulation).find(r => r.driverId === 'D1');
}

/** Chemin SIMULÉ : le statut est imposé par un scénario « et si ». */
function simule(regulation, n, statut) {
  const ids = Array.from({ length: n }, (_, i) => `D${i + 1}`);
  const race = { num: 1, ids, participants: ids.map((id, i) => ({ driverId: id, carNumber: i + 1 })) };
  const buf = makeDrawBuffers([race])[0];
  ids.forEach((_, i) => { buf.latent[i] = i; buf.incident[i] = 1; });
  const models = Object.fromEntries(ids.map(id => [id, { mu: 0, sigma: 1, incidentRate: 0 }]));
  return simulateRaceRows(race, buf, models, { D1: { status: statut } }, SCALE, regulation)
    .find(r => r.driverId === 'D1');
}

// ─────────────────────────────────────────────────────────

describe('réel et simulé passent par le même barème de statut', () => {
  for (const [nom, reg] of REGLEMENTS) {
    for (const statut of STATUTS) {
      it(`${nom} — ${statut} : mêmes points et même position sur ${TAILLES.length} tailles de plateau`, () => {
        for (const n of TAILLES) {
          const a = reel(reg, n, statut);
          const b = simule(reg, n, statut);
          expect(b.points, `${nom} ${statut} ${n} engagés — points`).toBe(a.points);
          expect(b.position, `${nom} ${statut} ${n} engagés — position`).toBe(a.position);
          expect(b.status).toBe(statut);
          expect(b.ms).toBeNull();
        }
      });
    }
  }

  it('un pilote qui abandonne pendant le tirage suit le même barème qu\'un DNF forcé', () => {
    // Le DNF « naturel » (tiré via incidentRate) et le DNF « imposé » doivent
    // être indiscernables : sinon la probabilité globale et la probabilité
    // conditionnelle reposeraient sur deux barèmes différents.
    for (const [nom, reg] of REGLEMENTS) {
      const n = 20;
      const ids = Array.from({ length: n }, (_, i) => `D${i + 1}`);
      const race = { num: 1, ids, participants: ids.map((id, i) => ({ driverId: id, carNumber: i + 1 })) };
      const buf = makeDrawBuffers([race])[0];
      ids.forEach((_, i) => { buf.latent[i] = i; buf.incident[i] = 1; });
      buf.incident[0] = 0;   // D1 abandonne naturellement
      const models = Object.fromEntries(ids.map(id => [id, { mu: 0, sigma: 1, incidentRate: 0 }]));
      models.D1 = { mu: 0, sigma: 1, incidentRate: 0.5 };
      const tire = simulateRaceRows(race, buf, models, null, SCALE, reg).find(r => r.driverId === 'D1');
      const force = simule(reg, n, 'DNF');
      expect(tire.points, nom).toBe(force.points);
      expect(tire.position, nom).toBe(force.position);
    }
  });
});

describe('aucun statut ne vaut zéro « par défaut »', () => {
  it('en FFSA comme en Euro RX, un DNF rapporte des points', () => {
    for (const n of [12, 20, 30]) {
      expect(calcStatusPoints('DNF', 'MQ', n, FFSA)).toBe(44 - (n + 1));
      expect(calcStatusPoints('DNF', 'MQ', n, EURO)).toBe(44 - (n + 1));
      // À un seul point de la dernière place classée : un abandon coûte cher
      // au classement, pas au score.
      expect(mqPoints(n, FFSA) - calcStatusPoints('DNF', 'MQ', n, FFSA)).toBe(1);
    }
  });

  it('les deux règlements divergent sur DNS et DSQ_RACE, et le moteur les suit', () => {
    expect(calcStatusPoints('DNS', 'MQ', 30, FFSA)).toBe(0);
    expect(calcStatusPoints('DNS', 'MQ', 30, EURO)).toBe(9);
    expect(calcStatusPoints('DSQ_RACE', 'MQ', 30, FFSA)).toBe(11);
    expect(calcStatusPoints('DSQ_RACE', 'MQ', 30, EURO)).toBe(4);

    // Et le chemin simulé reproduit cette divergence sans la connaître.
    expect(simule(FFSA, 30, 'DNS').points).toBe(0);
    expect(simule(EURO, 30, 'DNS').points).toBe(9);
    expect(simule(FFSA, 30, 'DSQ_RACE').points).toBe(11);
    expect(simule(EURO, 30, 'DSQ_RACE').points).toBe(4);
  });

  it('la taille du plateau change réellement les points d\'un statut à offset', () => {
    const petits = calcStatusPoints('DNF', 'MQ', 8, FFSA);
    const grands = calcStatusPoints('DNF', 'MQ', 30, FFSA);
    expect(petits).toBeGreaterThan(grands);
  });
});

describe('la liste des statuts vient du règlement, pas du code', () => {
  it('forceableStatuses lit statusRules', () => {
    expect(forceableStatuses(FFSA)).toEqual(['DNF', 'DNS', 'DSQ', 'DSQ_RACE']);
    expect(forceableStatuses({ statusRules: { DNF: {}, PENALITE: {} } })).toEqual(['DNF', 'PENALITE']);
    expect(forceableStatuses(null)).toEqual(FORCEABLE_STATUSES);
  });

  it('statusesOf suit la même règle côté certitudes', () => {
    expect(statusesOf(EURO)).toEqual(['DNF', 'DNS', 'DSQ', 'DSQ_RACE']);
    expect(statusesOf({})).toEqual([]);
  });
});

describe('les bornes de points d\'une manche en cours utilisent le vrai barème', () => {
  const FIELD = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  function liveCtx(regulation, statuses = {}) {
    const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 60000 + i * 700]));
    const q4 = {};
    ['C', 'A', 'F'].forEach((d, i) => {
      q4[d] = statuses[d] ? { status: statuses[d] } : 60000 + i * 700;
    });
    for (const d of FIELD) if (!(d in q4)) q4[d] = PENDING;
    const m = mergeFixtures([makeMeeting({
      meetingId: 'L', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'L' },
      races: { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: q4 },
    })]);
    return buildGroups(m).map(g => buildMeetingContext(g, regulation))[0];
  }

  it('la position d\'un DNF acquis est LUE dans le classement, jamais recalculée', () => {
    for (const [nom, reg] of REGLEMENTS) {
      const ctx = liveCtx(reg, { A: 'DNF' });
      const b = positionBounds(ctx, 4, 'A');
      const row = raceProgress(ctx, 4).rowsById.get('A');
      expect(b.provisionalPosition, nom).toBe(row.position);
      expect(b.fixedPoints, nom).toBe(row.points);
      expect(pointsBounds(b, reg).min, nom).toBe(row.points);
    }
  });

  it('la borne basse d\'un pilote restant est le pire statut du règlement, pas zéro', () => {
    const ctx = liveCtx(FFSA);
    const bornes = pointsBounds(positionBounds(ctx, 4, 'B'), FFSA);
    const pire = Math.min(...statusesOf(FFSA).map(s => calcStatusPoints(s, 'MQ', 8, FFSA)));
    expect(bornes.min).toBe(pire);
    expect(bornes.includesIncident).toBe(true);
  });

  it('en Euro RX, aucun statut ne descend à zéro sauf DSQ — la borne le reflète', () => {
    const ctx = liveCtx(EURO);
    const bornes = pointsBounds(positionBounds(ctx, 4, 'B'), EURO);
    expect(calcStatusPoints('DSQ', 'MQ', 8, EURO)).toBe(0);
    expect(bornes.min).toBe(0);
    // Sans DSQ, la borne serait bien supérieure : la valeur n'est pas un zéro
    // arbitraire mais celle d'un statut réellement défini.
    const sansDsq = Math.min(...['DNF', 'DNS', 'DSQ_RACE'].map(s => calcStatusPoints(s, 'MQ', 8, EURO)));
    expect(sansDsq).toBeGreaterThan(0);
  });
});
