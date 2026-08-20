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
  computeSeriesSizes, DEFAULT_MIN_CLASSIFIED_RACES,
} from '../calc.js';
import { dedupeParticipants, sessionParticipantId } from '../utils.js';
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
    const { participants, duplicates } = dedupeParticipants(raw, s.id);
    // Inscriptions portant encore un identifiant aleatoire. Leur presence est
    // normale (documents anterieurs a la protection) ; ce qui ne le serait pas,
    // c'est qu'il en apparaisse de NOUVEAUX : cela signifierait que la regle
    // Firestore n'est pas deployee. D'ou la conservation de la date la plus
    // recente, seul indicateur observable depuis l'application.
    const legacy = raw.filter(p => p.id && p.id !== sessionParticipantId(s.id, p.driverId));
    const legacyNewest = legacy.reduce((max, p) => {
      const d = p.createdAt?.toDate?.()?.toISOString?.() ?? (typeof p.createdAt === 'string' ? p.createdAt : null);
      return d && (!max || d > max) ? d : max;
    }, null);
    // Un pilote a REELLEMENT couru si et seulement si son resultat porte un
    // chrono ou un statut. Critere verifie sur les donnees de production :
    // sur 2 755 resultats de manche, aucun n'a ni l'un ni l'autre. Un pilote
    // pas encore passe n'a donc simplement pas de document exploitable.
    const ranIds = new Set(results.filter(r => r.ms != null || r.status).map(r => r.driverId));
    const pendingDriverIds = participants.map(p => p.driverId).filter(id => !ranIds.has(id));

    return {
      num: s.num,
      sessionId: s.id,
      engagedCount: participants.length,
      /** Documents sessionParticipants en double sur ce pilote et cette manche. */
      duplicateParticipants: duplicates.length,
      legacyIdCount: legacy.length,
      legacyNewest,

      // `hasResults` signifie « au moins un pilote a couru », PAS « la manche
      // est terminee ». Confondre les deux faisait entrer un meeting en cours
      // dans l'historique avec une manche incomplete, et produisait un
      // classement melangeant des totaux sur 3 et sur 4 manches.
      hasResults: ranIds.size > 0,
      ranCount: ranIds.size,
      pendingDriverIds,
      /** Terminee : TOUS les engages ont un resultat reel. */
      isComplete: participants.length > 0 && pendingDriverIds.length === 0,
      /** En cours : commencee mais pas finie. */
      isInProgress: ranIds.size > 0 && pendingDriverIds.length > 0,

      series: seriesStateOf(participants, results, ranIds, regulation),
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

  // Seules les manches TERMINEES fondent un checkpoint : une manche en cours
  // ne peut pas servir d'etat de reference, ses points n'etant acquis que pour
  // une partie du plateau.
  const completedRaces = races.filter(r => r.isComplete).map(r => r.num);
  const inProgress = races.find(r => r.isInProgress) || null;

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
    /** Manche actuellement en cours, ou null. */
    raceInProgress: inProgress ? inProgress.num : null,
    inProgressRace: inProgress,
    /** Effectif du meeting : le plus grand plateau observé sur une manche. */
    engagedCount: races.reduce((n, r) => Math.max(n, r.engagedCount), 0),
    /** Toutes les manches prevues sont integralement courues. */
    isComplete: races.length > 0 && races.every(r => r.isComplete),
  };
}

/**
 * Etat des series d'une manche.
 *
 * La structure ATTENDUE (nombre de series et tailles) est toujours calculable
 * depuis le nombre d'engages et le reglement. En revanche l'APPARTENANCE d'un
 * pilote a une serie n'est connue que si le champ `serie` a ete saisi — il est
 * facultatif, et n'est renseigne en pratique que pour les pilotes ayant deja
 * couru. On ne peut donc pas deduire de facon fiable combien de series sont
 * terminees quand des pilotes restent a courir sans serie assignee.
 *
 * D'ou la distinction explicite : le compte de PILOTES est fiable, le compte de
 * SERIES ne l'est que si toutes les appartenances sont connues. L'interface doit
 * dire laquelle des deux elle affiche.
 */
export function seriesStateOf(participants, results, ranIds, regulation) {
  const n = participants.length;
  const perSeries = Number(regulation?.sessionConfig?.MQ?.driversPerSeries) || 5;
  const mode = regulation?.seriesDistributionMode || 'ffsa';
  const expectedSizes = n > 0 ? computeSeriesSizes(n, perSeries, mode) : [];

  const byNum = new Map();
  let assigned = 0;
  for (const r of results) {
    if (r.serie == null) continue;
    assigned++;
    if (!byNum.has(r.serie)) byNum.set(r.serie, []);
    byNum.get(r.serie).push(r.driverId);
  }

  // Une serie n'est declaree terminee que si sa composition est connue ET
  // complete ET que tous ses membres ont couru. Sans cela, elle est « inconnue »
  // plutot que supposee.
  const known = [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(([num, driverIds]) => {
    const expectedSize = expectedSizes[num - 1] ?? null;
    const allRan = driverIds.every(id => ranIds.has(id));
    return {
      num, driverIds,
      size: driverIds.length,
      expectedSize,
      complete: allRan && expectedSize != null && driverIds.length === expectedSize,
    };
  });

  return {
    expectedCount: expectedSizes.length,
    expectedSizes,
    known,
    completeCount: known.filter(x => x.complete).length,
    /** Vrai si chaque pilote a une serie connue : le compte de series est alors sur. */
    membershipFullyKnown: n > 0 && assigned === n,
    /**
     * Au moins un pilote porte une serie. Le compte de series TERMINEES reste
     * exact meme sans connaitre toutes les appartenances : une serie n'est
     * declaree terminee que si ses membres connus atteignent la taille attendue,
     * ce qui interdit qu'un pilote encore a courir lui appartienne.
     */
    anyAssigned: assigned > 0,
  };
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
  // `isComplete` et non `hasResults` : une manche en cours n'a distribue ses
  // points qu'a une partie du plateau et ne peut pas fonder un classement.
  const races = (context?.races || []).filter(r => r.num <= raceNum && r.isComplete);

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
    if (!r.isComplete) continue;
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
  if (!race) return null;
  const row = race.rows.find(r => r.driverId === driverId);
  // Un pilote qui n'a pas encore couru n'a pas de resultat, meme si la manche
  // a commence pour d'autres.
  if (!row || (row.ms == null && !row.status)) return null;
  return {
    position: row.status ? null : row.position,
    status: row.status || null,
    points: row.points ?? null,
    ms: row.ms ?? null,
    engagedCount: race.engagedCount,
  };
}
