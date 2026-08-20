/* ═══════════════════════════════════════════════
   QUALIFICATIONSTATE.TEST.JS — Reconstruction de l'état après chaque manche.

   C'est la brique dont dépend tout le reste : si l'état après Q1/Q2/Q3 est
   faux, l'historique, la calibration et la future simulation le sont aussi.

   Deux points font l'objet d'une attention particulière :
     • le checkpoint après Q1, historiquement impossible parce que calc.js
       exigeait 2 manches classées (ANALYSE.md §1) ;
     • le traitement des statuts, qui doit rester STRICTEMENT identique à
       celui de l'application, sinon historique et projection deviennent
       incomparables (ANALYSE.md §4.9).
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { DEFAULT_MIN_CLASSIFIED_RACES } from '../js/calc.js';
import {
  buildGroups, buildMeetingContext, buildStateAfterRace, buildAllStates,
  raceResultOf, firstPopulatedPhase, actualNextPhaseDriverIds,
  PROJECTION_MIN_CLASSIFIED_RACES,
} from '../js/projection/qualificationState.js';
import { makeMeeting, makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

/** Raccourci : fixture → contexte prêt à interroger. */
function contextOf(fixture, regulation = TEST_REGULATION) {
  const merged = mergeFixtures([fixture]);
  const groups = buildGroups({
    sessions: merged.sessions, results: merged.results,
    participants: merged.participants, meetings: merged.meetings,
  });
  expect(groups).toHaveLength(1);
  return buildMeetingContext(groups[0], regulation);
}

const BASIC = () => makeOrderedMeeting({
  id: 'M1',
  orders: {
    1: ['A', 'B', 'C', 'D'],
    2: ['B', 'A', 'D', 'C'],
    3: ['A', 'C', 'B', 'D'],
    4: ['C', 'A', 'B', 'D'],
  },
  phases: { DF: ['A', 'B'] },
});

describe('découpage en groupes meeting × catégorie', () => {
  it('sépare deux catégories du même meeting', () => {
    const f1 = makeOrderedMeeting({ id: 'M1', category: 'Cat1', orders: { 1: ['A', 'B'] } });
    const f2 = makeOrderedMeeting({ id: 'M1', category: 'Cat2', orders: { 1: ['C', 'D'] } });
    const merged = mergeFixtures([f1, f2]);
    const groups = buildGroups({ ...merged, meetings: [f1.meeting] });
    expect(groups.map(g => g.category).sort()).toEqual(['Cat1', 'Cat2']);
  });

  it('ignore les sessions sans meeting ou sans catégorie', () => {
    const groups = buildGroups({ sessions: [{ id: 's', type: 'MQ' }] });
    expect(groups).toEqual([]);
  });
});

describe('contexte du meeting', () => {
  it('ordonne les manches et repère la dernière courue', () => {
    const ctx = contextOf(BASIC());
    expect(ctx.races.map(r => r.num)).toEqual([1, 2, 3, 4]);
    expect(ctx.lastCompletedRace).toBe(4);
    expect(ctx.isComplete).toBe(true);
    expect(ctx.engagedCount).toBe(4);
  });

  it('une manche sans aucun résultat n\'est pas considérée comme courue', () => {
    const f = makeMeeting({
      drivers: ['A', 'B'],
      races: { 1: { A: 1000, B: 1100 }, 2: { A: 1000, B: 1100 }, 3: {}, 4: {} },
      plannedRaces: 4,
    });
    const ctx = contextOf(f);
    expect(ctx.completedRaces).toEqual([1, 2]);
    expect(ctx.lastCompletedRace).toBe(2);
    expect(ctx.isComplete).toBe(false);
  });

  it('un meeting à venir (engagés chargés, zéro résultat) n\'est jamais exploité', () => {
    // Cas réel : Loheac / Mayenne / Dreux ont leurs sessionParticipants mais
    // aucun résultat. Sans ce garde-fou ils entreraient comme 100 % de DNS.
    const f = makeMeeting({ drivers: ['A', 'B', 'C'], races: { 1: {}, 2: {}, 3: {}, 4: {} } });
    const ctx = contextOf(f);
    expect(ctx.lastCompletedRace).toBe(0);
    expect(ctx.isComplete).toBe(false);
    expect(buildAllStates(ctx)).toEqual({});
  });

  it('recense les partants des phases finales', () => {
    const ctx = contextOf(BASIC());
    expect(ctx.observedPhaseCounts).toEqual({ QF: 0, DF: 2, FIN: 0 });
    expect(firstPopulatedPhase(ctx)).toBe('DF');
    expect([...actualNextPhaseDriverIds(ctx)].sort()).toEqual(['A', 'B']);
  });
});

describe('checkpoint après Q1 — le blocage historique', () => {
  it('la règle par défaut de l\'application vide le classement après Q1', () => {
    const ctx = contextOf(BASIC());
    const st = buildStateAfterRace(ctx, 1, { minClassifiedRaces: DEFAULT_MIN_CLASSIFIED_RACES });
    expect(st.count).toBe(0);
  });

  it('la règle du module de projection le rend exploitable', () => {
    const ctx = contextOf(BASIC());
    const st = buildStateAfterRace(ctx, 1);
    expect(PROJECTION_MIN_CLASSIFIED_RACES).toBe(1);
    expect(st.count).toBe(4);
    expect(st.standings.map(d => d.driverId)).toEqual(['A', 'B', 'C', 'D']);
    expect(st.standings[0].totalPoints).toBe(9);   // 10 - 1
    expect(st.standings[3].totalPoints).toBe(6);   // 10 - 4
  });

  it('les manches restantes sont déduites, pas codées en dur', () => {
    const ctx = contextOf(BASIC());
    expect(buildStateAfterRace(ctx, 1).remainingRaces).toEqual([2, 3, 4]);
    expect(buildStateAfterRace(ctx, 3).remainingRaces).toEqual([4]);
    expect(buildStateAfterRace(ctx, 4).remainingRaces).toEqual([]);
  });
});

describe('cumul des points au fil des manches', () => {
  it('additionne bien les manches successives', () => {
    const ctx = contextOf(BASIC());
    const s1 = buildStateAfterRace(ctx, 1).byDriverId;
    const s2 = buildStateAfterRace(ctx, 2).byDriverId;
    const s3 = buildStateAfterRace(ctx, 3).byDriverId;

    expect(s1.A.totalPoints).toBe(9);              // P1
    expect(s2.A.totalPoints).toBe(9 + 8);          // P1 puis P2
    expect(s3.A.totalPoints).toBe(9 + 8 + 9);      // P1, P2, P1
    expect(s3.D.totalPoints).toBe(6 + 7 + 6);      // P4, P3, P4
  });

  it('le classement se réordonne à chaque checkpoint', () => {
    const ctx = contextOf(BASIC());
    expect(buildStateAfterRace(ctx, 1).standings.map(d => d.driverId)).toEqual(['A', 'B', 'C', 'D']);
    expect(buildStateAfterRace(ctx, 4).standings[0].driverId).toBe('A');
  });

  it('buildAllStates couvre toutes les manches courues', () => {
    const states = buildAllStates(contextOf(BASIC()));
    expect(Object.keys(states).sort()).toEqual(['1', '2', '3', '4']);
  });
});

describe('statuts — comportement strictement aligné sur l\'application', () => {
  const withStatuses = () => makeMeeting({
    drivers: ['A', 'B', 'C', 'D'],
    races: {
      1: { A: 1000, B: 1100, C: { status: 'DNF' }, D: { status: 'DNS' } },
      2: { A: 1000, B: 1100, C: 1200, D: 1300 },
      3: { A: 1000, B: 1100, C: 1200, D: { status: 'DSQ_RACE' } },
      4: { A: 1000, B: 1100, C: 1200, D: 1300 },
    },
  });

  it('un DNF est classé engagés + 1 et marque les points correspondants', () => {
    const ctx = contextOf(withStatuses());
    const r = raceResultOf(ctx, 1, 'C');
    expect(r.status).toBe('DNF');
    expect(r.position).toBe(null);          // le statut prime sur la position technique
    expect(r.points).toBe(5);               // 10 - (4 engagés + 1)
  });

  it('un DNS ne marque aucun point et ne compte pas comme manche classée', () => {
    const ctx = contextOf(withStatuses());
    expect(raceResultOf(ctx, 1, 'D').points).toBe(0);
    // D n'a qu'une manche « classée » après Q2 (la 2), donc absent sous la
    // règle par défaut mais présent sous celle de la projection.
    expect(buildStateAfterRace(ctx, 2, { minClassifiedRaces: 2 }).byDriverId.D).toBeUndefined();
    expect(buildStateAfterRace(ctx, 2).byDriverId.D.totalPoints).toBe(6);
  });

  it('un DSQ_RACE est classé engagés + 3 mais ses points viennent de statusRules', () => {
    const ctx = contextOf(withStatuses());
    const r = raceResultOf(ctx, 3, 'D');
    expect(r.status).toBe('DSQ_RACE');
    // Le placement (engagés + 3) sert au classement de la manche ; les points,
    // eux, sont ceux de statusRules — ici { mode: 'fixed', points: 0 }.
    const row = ctx.races.find(x => x.num === 3).rows.find(x => x.driverId === 'D');
    expect(row.position).toBe(4 + 3);
    expect(r.points).toBe(0);
  });

  it('le statut prime toujours sur la position, pour ne pas passer pour un mauvais chrono', () => {
    const ctx = contextOf(withStatuses());
    expect(raceResultOf(ctx, 1, 'C')).toMatchObject({ status: 'DNF', position: null });
    expect(raceResultOf(ctx, 2, 'C')).toMatchObject({ status: null, position: 3 });
  });

  it('renvoie null pour une manche non courue ou un pilote absent', () => {
    const ctx = contextOf(withStatuses());
    expect(raceResultOf(ctx, 9, 'A')).toBe(null);
    expect(raceResultOf(ctx, 1, 'INCONNU')).toBe(null);
  });
});

describe('départage — les chronos doivent être exploités', () => {
  it('deux pilotes à égalité de points sont départagés par la dernière manche', () => {
    // A et B finissent à égalité de points ; A est devant en manche 2 (dernière).
    const f = makeMeeting({
      drivers: ['A', 'B'],
      races: {
        1: { A: 1200, B: 1000 },   // B devant
        2: { A: 1000, B: 1200 },   // A devant
      },
      plannedRaces: 2,
    });
    const ctx = contextOf(f);
    const st = buildStateAfterRace(ctx, 2);
    expect(st.standings[0].totalPoints).toBe(st.standings[1].totalPoints);
    expect(st.standings[0].driverId).toBe('A');
    // Les chronos par manche sont conservés : sans eux, aucun départage possible.
    expect(st.standings[0].mqMs).toEqual({ 1: 1200, 2: 1000 });
    expect(st.standings[0].mqPos).toEqual({ 1: 2, 2: 1 });
  });
});
