/* ═══════════════════════════════════════════════
   DATAQUALITY.JS — Audit de l'historique réellement exploitable.

   Module PUR : ni Firestore, ni DOM.

   Reprend dans l'application l'audit qui a servi à rédiger
   docs/qualification-projection/ANALYSE.md, pour qu'il reste vérifiable en
   permanence plutôt que figé dans un document : combien de meetings sont
   réellement complets, combien de cas sont exploitables, où la règle sportive
   diverge de ce qui s'est passé, et quels règlements bloquent la projection.

   Un chiffre affiché ailleurs dans le module doit pouvoir se retrouver ici.
═══════════════════════════════════════════════ */

import { DEFAULT_MIN_CLASSIFIED_RACES } from '../calc.js';
import {
  resolveQualificationThreshold, isTrivialQualification,
  compareQualificationLabels, checkRegulationSupport, describeDivergence,
} from './qualificationRules.js';
import {
  buildStateAfterRace, actualNextPhaseDriverIds, firstPopulatedPhase,
  PROJECTION_MIN_CLASSIFIED_RACES,
} from './qualificationState.js';

/** Décompte des résultats d'une manche, à partir de son classement. */
export function raceCompleteness(race) {
  const rows = race?.rows || [];
  return {
    num: race?.num ?? null,
    engaged: race?.engagedCount ?? 0,
    results: rows.filter(r => r.ms != null || r.status).length,
    timed: rows.filter(r => r.ms != null && !r.status).length,
    withStatus: rows.filter(r => r.status).length,
    empty: rows.filter(r => r.ms == null && !r.status).length,
    hasResults: !!race?.hasResults,
    duplicates: race?.duplicateParticipants || 0,
  };
}

/**
 * Rapport complet, groupe par groupe.
 *
 * @param {Array} contexts — sorties de buildMeetingContext()
 * @param {object} [options] — { championshipsById }
 */
export function buildDataQualityReport(contexts = [], options = {}) {
  const championshipsById = options.championshipsById || {};
  const groups = [];
  const divergences = [];
  const blockers = new Map();

  for (const ctx of contexts) {
    if (!ctx) continue;
    const meeting = ctx.meeting || {};
    const champ = championshipsById[meeting.championshipId] || null;

    const races = (ctx.races || []).map(raceCompleteness);
    const ranRaces = races.filter(r => r.hasResults);

    const threshold = resolveQualificationThreshold({
      regulation: ctx.regulation,
      observedPhaseCounts: ctx.observedPhaseCounts,
      engagedCount: ctx.engagedCount,
    });
    const trivial = isTrivialQualification(ctx.engagedCount, threshold.threshold);

    // Couverture des checkpoints sous les deux règles : c'est ce comparatif qui
    // rend visible le blocage historique du checkpoint après Q1.
    const checkpointCoverage = {};
    for (const r of ctx.races || []) {
      if (!r.hasResults) continue;
      checkpointCoverage[r.num] = {
        withDefaultRule: buildStateAfterRace(ctx, r.num, { minClassifiedRaces: DEFAULT_MIN_CLASSIFIED_RACES }).count,
        withProjectionRule: buildStateAfterRace(ctx, r.num, { minClassifiedRaces: PROJECTION_MIN_CLASSIFIED_RACES }).count,
      };
    }

    let groupDivergences = [];
    if (ctx.isComplete && ctx.lastCompletedRace) {
      const finalState = buildStateAfterRace(ctx, ctx.lastCompletedRace);
      const cmp = compareQualificationLabels({
        standings: finalState.standings,
        threshold: threshold.threshold,
        actualDriverIds: actualNextPhaseDriverIds(ctx),
      });
      groupDivergences = cmp.divergences.map(d => ({
        ...d,
        // Un pilote absent du classement intermediaire n'a ni numero ni nom
        // dans la comparaison : on les recupere dans l'index du meeting.
        carNumber: d.carNumber ?? ctx.driversById?.[d.driverId]?.carNumber ?? null,
        firstName: d.firstName ?? ctx.driversById?.[d.driverId]?.firstName ?? null,
        lastName:  d.lastName  ?? ctx.driversById?.[d.driverId]?.lastName  ?? null,
        description: describeDivergence(d.kind),
        meetingId: ctx.meetingId,
        meetingLabel: meeting.location || ctx.meetingId,
        meetingDate: meeting.date || null,
        category: ctx.category,
        championshipName: champ?.name || null,
        threshold: threshold.threshold,
        thresholdLabel: threshold.label,
      }));
      divergences.push(...groupDivergences);
    }

    const support = checkRegulationSupport(ctx.regulation);
    if (!support.supported && champ) {
      blockers.set(champ.id, { championshipId: champ.id, championshipName: champ.name, reasons: support.reasons });
    }

    groups.push({
      key: ctx.key,
      meetingId: ctx.meetingId,
      meetingLabel: meeting.location || ctx.meetingId,
      meetingDate: meeting.date || null,
      year: meeting.year ?? null,
      championshipId: meeting.championshipId || null,
      championshipName: champ?.name || null,
      category: ctx.category,
      engagedCount: ctx.engagedCount,
      plannedRaceCount: ctx.plannedRaceCount,
      ranRaceCount: ranRaces.length,
      isComplete: ctx.isComplete,
      hasAnyResult: ranRaces.length > 0,
      races,
      duplicateParticipants: races.reduce((n, r) => n + (r.duplicates || 0), 0),
      threshold: threshold.threshold,
      thresholdSource: threshold.source,
      thresholdLabel: threshold.label,
      nextPhase: firstPopulatedPhase(ctx),
      trivial,
      checkpointCoverage,
      divergenceCount: groupDivergences.length,
      regulationSupported: support.supported,
      regulationIssues: support.reasons,
    });
  }

  groups.sort((a, b) =>
    String(a.meetingDate).localeCompare(String(b.meetingDate))
    || String(a.category).localeCompare(String(b.category)));

  const complete = groups.filter(g => g.isComplete);
  const coverage = { withDefaultRule: {}, withProjectionRule: {} };
  for (const g of complete) {
    for (const [num, c] of Object.entries(g.checkpointCoverage)) {
      coverage.withDefaultRule[num] = (coverage.withDefaultRule[num] || 0) + c.withDefaultRule;
      coverage.withProjectionRule[num] = (coverage.withProjectionRule[num] || 0) + c.withProjectionRule;
    }
  }

  return {
    summary: {
      totalGroups: groups.length,
      completeGroups: complete.length,
      partialGroups: groups.filter(g => g.hasAnyResult && !g.isComplete).length,
      emptyGroups: groups.filter(g => !g.hasAnyResult).length,
      trivialGroups: complete.filter(g => g.trivial).length,
      exploitableGroups: complete.filter(g => !g.trivial).length,
      meetings: new Set(complete.map(g => g.meetingId)).size,
      seasons: [...new Set(complete.map(g => g.year).filter(y => y != null))].sort(),
      championships: [...new Set(complete.map(g => g.championshipName).filter(Boolean))].sort(),
      circuits: [...new Set(complete.map(g => g.meetingLabel).filter(Boolean))].sort(),
      checkpointCoverage: coverage,
      divergenceCount: divergences.length,
      duplicateParticipants: groups.reduce((n, g) => n + g.duplicateParticipants, 0),
      groupsWithDuplicates: groups.filter(g => g.duplicateParticipants > 0).length,
      thresholdSources: countBy(complete, g => g.thresholdSource),
    },
    groups,
    divergences,
    blockers: [...blockers.values()],
  };
}

function countBy(rows, fn) {
  const out = {};
  for (const r of rows) {
    const k = fn(r);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
