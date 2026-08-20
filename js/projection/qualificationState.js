/* ═══════════════════════════════════════════════
   QUALIFICATIONSTATE.JS — Reconstruction de l'état du classement à
   n'importe quel moment des manches qualificatives.

   Module PUR : ni Firestore, ni DOM. Les documents sont chargés en amont par
   qualificationData.js et passés ici tels quels.

   C'est le SEUL endroit du module qui sait recomposer un classement, et il ne
   recompose rien lui-même : il délègue à calc.js (buildMqStandings,
   buildEcStandings, buildInterimStandings), donc barèmes, statuts, points de
   manche et règles de départage sont exactement ceux de l'application.

   Le module ne connaît ni « Q3 » ni « Q4 » : il connaît une liste ordonnée de
   manches et un index de dernière manche terminée. C'est ce qui permet au même
   code de servir les checkpoints après Q1, Q2, Q3 et Q4.
═══════════════════════════════════════════════ */

import {
  buildMqStandings, buildEcStandings, buildInterimStandings,
  DEFAULT_MIN_CLASSIFIED_RACES,
} from '../calc.js';
import { PHASE_ORDER } from './qualificationRules.js';

/**
 * Le classement intermédiaire est une notion de classement, pas d'attribution
 * de points : à un checkpoint intermédiaire, on veut voir TOUS les pilotes
 * ayant couru, y compris après une seule manche. Le défaut de calc.js
 * (2 manches classées) est conservé pour l'application existante ; le module
 * de projection utilise 1.
 */
export const PROJECTION_MIN_CLASSIFIED_RACES = 1;

// ─────────────────────────────────────────────────────────
// GROUPES MEETING × CATÉGORIE
// ─────────────────────────────────────────────────────────

/**
 * Découpe des documents bruts en groupes meeting × catégorie, seule maille où
 * un classement intermédiaire a un sens.
 *
 * @param {object} params
 * @param {Array} params.sessions
 * @param {Array} params.results
 * @param {Array} params.participants
 * @param {Array} [params.meetings]
 * @returns {Array} groupes { key, meetingId, category, meeting, sessions,
 *                            resultsBySession, participantsBySession }
 */
export function buildGroups({ sessions = [], results = [], participants = [], meetings = [] } = {}) {
  const meetingById = {};
  meetings.forEach(m => { meetingById[m.id] = m; });

  const resultsBySession = {};
  results.forEach(r => { (resultsBySession[r.sessionId] ||= []).push(r); });
  const participantsBySession = {};
  participants.forEach(p => { (participantsBySession[p.sessionId] ||= []).push(p); });

  const groups = {};
  for (const s of sessions) {
    if (!s.meetingId || !s.category) continue;
    const key = `${s.meetingId}||${s.category}`;
    if (!groups[key]) {
      groups[key] = {
        key,
        meetingId: s.meetingId,
        category:  s.category,
        meeting:   meetingById[s.meetingId] || null,
        sessions:  [],
        resultsBySession,
        participantsBySession,
      };
    }
    groups[key].sessions.push(s);
  }
  return Object.values(groups);
}

// ─────────────────────────────────────────────────────────
// CONTEXTE D'UN GROUPE
// ─────────────────────────────────────────────────────────

/**
 * Pré-calcule tout ce qui ne dépend pas du checkpoint : classement de chaque
 * manche, bonus essais, effectifs, partants des phases finales.
 *
 * @param {object} group — sortie de buildGroups()
 * @param {object} [regulation]
 * @returns {object} contexte
 */
export function buildMeetingContext(group, regulation) {
  const sessions = group?.sessions || [];
  const resBy = group?.resultsBySession || {};
  const parBy = group?.participantsBySession || {};

  const mqSessions = sessions
    .filter(s => s.type === 'MQ' && s.num != null)
    .sort((a, b) => a.num - b.num);

  const races = mqSessions.map(s => {
    const results = resBy[s.id] || [];
    const raw = parBy[s.id] || [];
    const { participants, duplicates } = dedupeParticipants(raw);
    return {
      num: s.num,
      sessionId: s.id,
      engagedCount: participants.length,
      /** Documents sessionParticipants en double sur ce pilote et cette manche. */
      duplicateParticipants: duplicates,
      // Une manche est « courue » dès qu'un résultat exploitable existe.
      // Indispensable : les meetings à venir ont déjà leurs participants
      // chargés mais aucun résultat, et compteraient sinon comme 100 % de DNS.
      hasResults: results.some(r => r.ms != null || r.status),
      rows: buildMqStandings(participants, results, regulation),
    };
  });

  const ecSession = sessions.find(s => s.type === 'EC');
  const ecBonus = {};
  if (ecSession) {
    buildEcStandings(parBy[ecSession.id] || [], resBy[ecSession.id] || [], regulation)
      .forEach(r => { ecBonus[r.driverId] = r.bonusPoints ?? 0; });
  }

  // Index des pilotes vus dans le groupe, toutes sessions confondues. Sert au
  // selecteur de pilote de l'interface et permet de nommer un pilote absent du
  // classement intermediaire (cas d'un repechage sans manche classee).
  const driversById = {};
  for (const s of sessions) {
    for (const p of parBy[s.id] || []) {
      if (!driversById[p.driverId]) {
        driversById[p.driverId] = {
          driverId: p.driverId, carNumber: p.carNumber,
          firstName: p.firstName, lastName: p.lastName,
        };
      }
    }
  }

  const observedPhaseCounts = {};
  const observedPhaseDriverIds = {};
  for (const phase of PHASE_ORDER) {
    const ids = new Set();
    sessions.filter(s => s.type === phase).forEach(s => {
      (parBy[s.id] || []).forEach(p => ids.add(p.driverId));
    });
    observedPhaseCounts[phase] = ids.size;
    observedPhaseDriverIds[phase] = ids;
  }

  const completedRaces = races.filter(r => r.hasResults).map(r => r.num);

  return {
    key: group?.key,
    meetingId: group?.meetingId,
    category: group?.category,
    meeting: group?.meeting || null,
    regulation: regulation || null,
    races,
    ecBonus,
    driversById,
    observedPhaseCounts,
    observedPhaseDriverIds,
    plannedRaceCount: races.length,
    completedRaces,
    lastCompletedRace: completedRaces.length ? Math.max(...completedRaces) : 0,
    /** Effectif du meeting : le plus grand plateau observé sur une manche. */
    engagedCount: races.reduce((n, r) => Math.max(n, r.engagedCount), 0),
    /** Manches courues sans interruption depuis la première. */
    isComplete: races.length > 0 && races.every(r => r.hasResults),
  };
}

/**
 * Dédoublonne les participations par pilote.
 *
 * Les documents `sessionParticipants` sont créés avec un identifiant aléatoire,
 * contrairement aux `results` qui utilisent `${sessionId}_${driverId}` : rien
 * n'empêche donc structurellement qu'un pilote soit inscrit deux fois à la même
 * manche, et le cas se produit réellement en base. Un doublon fausserait deux
 * choses à la fois : le nombre d'engagés, qui sert au calcul des points DNF
 * (`mode: 'engaged_offset'`), et la détection des qualifications mécaniques.
 *
 * @returns {{ participants: Array, duplicates: number }}
 */
export function dedupeParticipants(rows = []) {
  const seen = new Set();
  const participants = [];
  let duplicates = 0;
  for (const p of rows) {
    if (seen.has(p.driverId)) { duplicates++; continue; }
    seen.add(p.driverId);
    participants.push(p);
  }
  return { participants, duplicates };
}

/** Première phase finale réellement peuplée, ou null. */
export function firstPopulatedPhase(context) {
  for (const phase of PHASE_ORDER) {
    if ((context?.observedPhaseCounts?.[phase] || 0) > 0) return phase;
  }
  return null;
}

/** Pilotes réellement présents dans la première phase finale peuplée. */
export function actualNextPhaseDriverIds(context) {
  const phase = firstPopulatedPhase(context);
  return phase ? context.observedPhaseDriverIds[phase] : new Set();
}

// ─────────────────────────────────────────────────────────
// ÉTAT À UN CHECKPOINT
// ─────────────────────────────────────────────────────────

/**
 * État du classement après la manche `raceNum`.
 *
 * @param {object} context — sortie de buildMeetingContext()
 * @param {number} raceNum — 1, 2, 3, 4…
 * @param {object} [options]
 * @param {number} [options.minClassifiedRaces=1]
 * @returns {{ raceNum, standings, byDriverId, count, remainingRaces }}
 */
export function buildStateAfterRace(context, raceNum, options) {
  const minClassifiedRaces = options?.minClassifiedRaces ?? PROJECTION_MIN_CLASSIFIED_RACES;
  const races = (context?.races || []).filter(r => r.num <= raceNum && r.hasResults);

  const standings = races.length
    ? buildInterimStandings(
        races.map(r => ({ num: r.num, rows: r.rows })),
        context.ecBonus,
        context.regulation,
        { minClassifiedRaces },
      )
    : [];

  const byDriverId = {};
  standings.forEach(d => { byDriverId[d.driverId] = d; });

  return {
    raceNum,
    standings,
    byDriverId,
    count: standings.length,
    /** Manches prévues restant à disputer après ce checkpoint. */
    remainingRaces: (context?.races || []).filter(r => r.num > raceNum).map(r => r.num),
  };
}

/**
 * États après chacune des manches courues. Clé = numéro de manche.
 * C'est la brique qui rend le moteur générique : un checkpoint n'est rien
 * d'autre qu'une entrée de cette table.
 */
export function buildAllStates(context, options) {
  const out = {};
  for (const r of context?.races || []) {
    if (!r.hasResults) continue;
    out[r.num] = buildStateAfterRace(context, r.num, options);
  }
  return out;
}

/**
 * Résultat brut d'un pilote sur une manche, tel qu'il doit être classé.
 *
 * Le STATUT prime sur la position : buildMqStandings place les DNF en
 * `engagés + 1`, ce qui les ferait passer pour un mauvais résultat chiffré
 * alors que ce n'en est pas un.
 *
 * @returns {{ position: number|null, status: string|null, points: number|null, ms: number|null }|null}
 */
export function raceResultOf(context, raceNum, driverId) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race || !race.hasResults) return null;
  const row = race.rows.find(r => r.driverId === driverId);
  if (!row) return null;
  return {
    position: row.status ? null : row.position,
    status: row.status || null,
    points: row.points ?? null,
    ms: row.ms ?? null,
    engagedCount: race.engagedCount,
  };
}
