/* ═══════════════════════════════════════════════
   PROJECTIONDATAQUALITY.TEST.JS — Écran « Qualité des données ».

   L'écran doit rester HONNÊTE : c'est lui qui dit à l'utilisateur sur quoi
   reposent les taux affichés ailleurs. Un meeting incomplet compté comme
   complet, ou une divergence règle/réalité silencieuse, feraient plus de
   dégâts qu'une absence de statistique.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { buildDataQualityReport, raceCompleteness } from '../js/projection/dataQuality.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { makeMeeting, makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

const CHAMPS = { champ_test: TEST_REGULATION };
const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];

function reportOf(fixtures) {
  const merged = mergeFixtures(fixtures);
  const groups = buildGroups({
    sessions: merged.sessions, results: merged.results,
    participants: merged.participants, meetings: merged.meetings,
  });
  const contexts = groups.map(g => buildMeetingContext(g, TEST_REGULATION));
  return buildDataQualityReport(contexts, { championshipsById: CHAMPS });
}

const complet = (id, phases = { DF: ['A', 'B'] }) => makeOrderedMeeting({
  id, drivers: SIX, phases,
  orders: { 1: SIX, 2: SIX, 3: SIX, 4: SIX },
});

describe('complétude d\'une manche', () => {
  it('décompte chronos, statuts et documents vides', () => {
    const f = makeMeeting({
      drivers: ['A', 'B', 'C'],
      races: { 1: { A: 1000, B: { status: 'DNF' }, C: { ms: null, status: null } } },
      plannedRaces: 1,
    });
    const merged = mergeFixtures([f]);
    const ctx = buildMeetingContext(buildGroups({ ...merged, meetings: merged.meetings })[0], TEST_REGULATION);
    const c = raceCompleteness(ctx.races[0]);
    expect(c).toMatchObject({ num: 1, engaged: 3, timed: 1, withStatus: 1, empty: 1, hasResults: true });
  });
});

describe('classement des groupes', () => {
  it('distingue complet, partiel et vide', () => {
    const partiel = makeMeeting({
      drivers: SIX, plannedRaces: 4,
      races: { 1: Object.fromEntries(SIX.map((d, i) => [d, 1000 + i])), 2: {}, 3: {}, 4: {} },
      meetingId: 'P1',
    });
    const vide = makeMeeting({ drivers: SIX, plannedRaces: 4, races: { 1: {}, 2: {}, 3: {}, 4: {} }, meetingId: 'V1' });
    const r = reportOf([complet('C1'), partiel, vide]);
    expect(r.summary.completeGroups).toBe(1);
    expect(r.summary.partialGroups).toBe(1);
    expect(r.summary.emptyGroups).toBe(1);
  });

  it('un meeting à venir n\'est jamais compté comme exploitable', () => {
    const vide = makeMeeting({ drivers: SIX, plannedRaces: 4, races: { 1: {}, 2: {}, 3: {}, 4: {} }, meetingId: 'V1' });
    const r = reportOf([vide]);
    expect(r.summary.completeGroups).toBe(0);
    expect(r.groups[0].hasAnyResult).toBe(false);
    expect(r.groups[0].ranRaceCount).toBe(0);
  });

  it('sépare les cas triviaux des cas exploitables', () => {
    const trivial = makeOrderedMeeting({
      id: 'T1', drivers: ['A', 'B'], phases: { DF: ['A', 'B'] },
      orders: { 1: ['A', 'B'], 2: ['A', 'B'], 3: ['A', 'B'], 4: ['A', 'B'] },
    });
    const r = reportOf([complet('C1'), trivial]);
    expect(r.summary.completeGroups).toBe(2);
    expect(r.summary.trivialGroups).toBe(1);
    expect(r.summary.exploitableGroups).toBe(1);
  });
});

describe('couverture des checkpoints — le blocage après Q1 rendu visible', () => {
  it('compare la règle par défaut et celle de la projection', () => {
    const r = reportOf([complet('C1')]);
    const cov = r.summary.checkpointCoverage;
    expect(cov.withDefaultRule['1']).toBe(0);    // règle historique : classement vide
    expect(cov.withProjectionRule['1']).toBe(6); // règle projection : exploitable
    expect(cov.withDefaultRule['2']).toBe(6);
    expect(cov.withProjectionRule['2']).toBe(6);
  });

  it('détaille la couverture groupe par groupe', () => {
    const r = reportOf([complet('C1')]);
    expect(r.groups[0].checkpointCoverage['1']).toEqual({ withDefaultRule: 0, withProjectionRule: 6 });
  });
});

describe('divergences règle / réalité', () => {
  it('n\'en signale aucune quand tout concorde', () => {
    const r = reportOf([complet('C1', { DF: ['A', 'B'] })]);
    expect(r.summary.divergenceCount).toBe(0);
    expect(r.groups[0].divergenceCount).toBe(0);
  });

  it('retrouve un forfait et son suppléant, avec le contexte du meeting', () => {
    const r = reportOf([complet('C1', { DF: ['A', 'C'] })]);
    expect(r.divergences).toHaveLength(2);
    const forfait = r.divergences.find(d => d.driverId === 'B');
    expect(forfait).toMatchObject({
      qualifiedByRule: true, qualifiedActual: false,
      kind: 'absent_de_la_phase_suivante',
      category: 'TestCat', threshold: 2,
    });
    expect(forfait.description).toMatch(/forfait/i);
    expect(forfait.meetingLabel).toBeTruthy();
    const supplant = r.divergences.find(d => d.driverId === 'C');
    expect(supplant.kind).toBe('present_sans_etre_classe_qualifie');
    expect(supplant.description).toMatch(/suppléant/i);
  });

  it('les divergences restent consultables une par une', () => {
    const r = reportOf([complet('C1', { DF: ['A', 'C'] }), complet('C2', { DF: ['A', 'D'] })]);
    expect(r.summary.divergenceCount).toBe(4);
    expect(new Set(r.divergences.map(d => d.meetingId))).toEqual(new Set(['C1', 'C2']));
  });
});

describe('seuils et règlements', () => {
  it('trace la provenance du seuil', () => {
    const r = reportOf([complet('C1')]);
    expect(r.groups[0].thresholdSource).toBe('observed');
    expect(r.groups[0].nextPhase).toBe('DF');
    expect(r.summary.thresholdSources).toEqual({ observed: 1 });
  });

  it('remonte un règlement non supporté comme bloquant', () => {
    const merged = mergeFixtures([complet('C1')]);
    const groups = buildGroups({ ...merged, meetings: merged.meetings });
    const reg = { ...TEST_REGULATION, worstResultDrop: 1 };
    const contexts = groups.map(g => buildMeetingContext(g, reg));
    const r = buildDataQualityReport(contexts, { championshipsById: { champ_test: reg } });
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0].reasons[0]).toMatch(/worstResultDrop/);
    expect(r.groups[0].regulationSupported).toBe(false);
  });
});

describe('synthèse', () => {
  it('récapitule saisons, meetings et championnats couverts', () => {
    const r = reportOf([complet('C1'), complet('C2')]);
    expect(r.summary.meetings).toBe(2);
    expect(r.summary.seasons).toEqual([2026]);
    expect(r.summary.championships).toEqual(['Championnat de test']);
  });

  it('tolère une entrée vide', () => {
    const r = buildDataQualityReport([]);
    expect(r.summary.totalGroups).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.divergences).toEqual([]);
  });
});

describe('participations en double', () => {
  // Cas réel constaté en base : sessionParticipants utilise un identifiant
  // aléatoire (contrairement à results, qui a un id déterministe), donc rien
  // n'empêche d'inscrire deux fois le même pilote à une manche.
  const withDuplicates = () => {
    const f = complet('C1');
    const mq1 = f.sessions.find(s => s.type === 'MQ' && s.num === 1);
    const original = f.participants.find(p => p.sessionId === mq1.id && p.driverId === 'A');
    f.participants.push({ ...original, id: original.id + '_bis' });
    f.participants.push({ ...original, id: original.id + '_ter' });
    return f;
  };

  it('ne compte pas deux fois un pilote dans les engagés', () => {
    const r = reportOf([withDuplicates()]);
    expect(r.groups[0].engagedCount).toBe(6);
    expect(r.groups[0].races[0].engaged).toBe(6);
  });

  it('signale les doublons plutôt que de les masquer', () => {
    const r = reportOf([withDuplicates()]);
    expect(r.groups[0].races[0].duplicates).toBe(2);
    expect(r.groups[0].duplicateParticipants).toBe(2);
    expect(r.summary.duplicateParticipants).toBe(2);
    expect(r.summary.groupsWithDuplicates).toBe(1);
  });

  it('un jeu de données sain n\'en déclare aucun', () => {
    const r = reportOf([complet('C1')]);
    expect(r.summary.duplicateParticipants).toBe(0);
    expect(r.summary.groupsWithDuplicates).toBe(0);
  });

  it('le classement de la manche ne fait pas apparaître le pilote deux fois', () => {
    const merged = mergeFixtures([withDuplicates()]);
    const ctx = buildMeetingContext(buildGroups({ ...merged, meetings: merged.meetings })[0], TEST_REGULATION);
    const ids = ctx.races[0].rows.map(r => r.driverId);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ctx.races[0].rows.filter(r => r.driverId === 'A')).toHaveLength(1);
  });
});
