/* ═══════════════════════════════════════════════
   RACECERTAINTIES.JS — Ce qui est DÉMONTRÉ pendant qu'une manche se court.

   Module PUR : ni Firestore, ni DOM.

   Pendant une manche en cours, deux natures d'information coexistent et ne
   doivent jamais être mélangées :

     · ce qui est ACQUIS — vrai dans tous les déroulements encore possibles ;
     · ce qui est PROBABLE — vrai dans une proportion des tirages.

   Ce module ne produit QUE la première. Aucun énoncé sorti d'ici ne dépend
   d'un tirage aléatoire, d'un modèle de performance ou d'une graine : chacun
   se démontre à partir des résultats déjà enregistrés et du règlement. Une
   valeur qu'on ne peut pas démontrer n'est pas approchée ici, elle est
   simplement absente — c'est au bloc simulation de dire « dans X % des
   tirages ».

   ── Les bornes de position ─────────────────────────────────────────────────
   Le raisonnement tient en une phrase : un pilote qui a déjà couru ne peut
   plus être dépassé par un pilote déjà couru. Son classement final dans la
   manche est donc encadré exactement :

     · meilleure position possible = pilotes réels déjà devant + 1
       (aucun de ceux qui sont derrière ne peut repasser devant) ;
     · pire position possible = cette même valeur + pilotes restant à courir
       (au pire, tous le devancent).

   Ces deux bornes sont ATTEIGNABLES, donc c'est le meilleur encadrement
   possible, pas une approximation prudente.

   ── La qualification mathématique ──────────────────────────────────────────
   Elle n'a de sens que si la manche en cours est la DERNIÈRE : tant qu'une
   manche reste à disputer, tout reste ouvert et la qualification demeure une
   probabilité. Le calcul est volontairement CONSERVATEUR : chaque adversaire
   est crédité de son meilleur résultat encore possible, même si tous ne
   peuvent évidemment pas gagner la même manche. Une conclusion « qualifié »
   est donc valide à coup sûr ; l'absence de conclusion ne prouve rien.
═══════════════════════════════════════════════ */

import { mqPoints, calcStatusPoints, buildInterimStandings } from '../calc.js';
import { PROJECTION_MIN_CLASSIFIED_RACES } from './qualificationState.js';
import { realResultsOfRace } from './scenarioSimulator.js';
import { MESSAGES } from './projectionConfig.js';

// ─────────────────────────────────────────────────────────
// ÉTAT RÉEL D'UNE MANCHE
// ─────────────────────────────────────────────────────────

/**
 * Photographie factuelle d'une manche : qui a couru, qui reste, où en sont les
 * séries. Aucune inférence.
 *
 * Mode 'live' : on lit l'état réel courant, terminé ou non. Ce module décrit ce
 * qui EST, il ne nourrit aucun tirage — la précaution anti-fuite du simulateur
 * n'a donc pas lieu d'être ici.
 *
 * @returns {object|null}
 */
export function raceProgress(context, raceNum, mode = 'live') {
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race) return null;
  const real = realResultsOfRace(context, raceNum, mode) || {};

  const finishers = Object.entries(real)
    .filter(([, r]) => r.ms != null && !r.status)
    .map(([driverId, r]) => ({ driverId, ms: r.ms }))
    .sort((a, b) => a.ms - b.ms);
  const withStatus = Object.entries(real)
    .filter(([, r]) => r.status)
    .map(([driverId, r]) => ({ driverId, status: r.status }));

  return {
    raceNum,
    engagedCount: race.engagedCount,
    ranCount: finishers.length + withStatus.length,
    pendingCount: race.pendingDriverIds.length,
    pendingDriverIds: [...race.pendingDriverIds],
    finishers,
    withStatus,
    isInProgress: race.isInProgress,
    isComplete: race.isComplete,
    hasStarted: race.hasResults,
    series: race.series,
  };
}

/**
 * Phrase honnête sur l'avancement en séries.
 *
 * Le nombre de PILOTES passés est toujours connu. Le nombre de SÉRIES
 * terminées ne l'est que si au moins une série est renseignée : une série
 * n'est déclarée terminée que si ses membres connus atteignent la taille
 * attendue par le règlement, ce qui interdit qu'un pilote encore à courir lui
 * appartienne — le compte est donc exact, pas approché. La formulation dit
 * malgré tout d'où il vient, parce qu'une série non renseignée resterait
 * invisible.
 *
 * Quand aucun résultat ne porte de série, on le dit plutôt que de déduire une
 * précision qui n'existe pas.
 */
export function describeProgress(progress) {
  if (!progress) return null;
  const s = progress.series;
  const drivers = MESSAGES.raceInProgress(progress.raceNum, progress.ranCount, progress.engagedCount);
  const determinable = Boolean(s?.anyAssigned && s.expectedCount > 0);
  return {
    drivers,
    series: determinable
      ? MESSAGES.seriesFromEntered(s.completeCount, s.expectedCount)
      : MESSAGES.seriesUnknown,
    seriesKnown: determinable,
    /** Toutes les appartenances sont connues : le compte ne dépend d'aucune hypothèse. */
    membershipFullyKnown: Boolean(s?.membershipFullyKnown),
  };
}

// ─────────────────────────────────────────────────────────
// BORNES DE POSITION DANS LA MANCHE
// ─────────────────────────────────────────────────────────

/**
 * Encadrement exact du classement d'un pilote dans la manche en cours.
 *
 * @returns {object|null} { hasRun, status, provisionalPosition, bestPosition,
 *                          worstPosition, exact, reachable }
 */
export function positionBounds(context, raceNum, driverId, mode = 'live') {
  const progress = raceProgress(context, raceNum, mode);
  if (!progress) return null;

  const engaged = progress.engagedCount;
  const pending = progress.pendingCount;
  const mine = progress.withStatus.find(x => x.driverId === driverId);

  // Statut déjà enregistré : la position est fixée par le règlement, elle ne
  // bougera plus. C'est la certitude la plus forte qui soit.
  if (mine) {
    const position = mine.status === 'DNF' ? engaged + 1
      : mine.status === 'DSQ_RACE' ? engaged + 3
      : null;
    return {
      hasRun: true, status: mine.status, provisionalPosition: position,
      bestPosition: position, worstPosition: position, exact: true,
      ranAhead: null, pendingCount: pending, engagedCount: engaged,
    };
  }

  const idx = progress.finishers.findIndex(f => f.driverId === driverId);
  if (idx >= 0) {
    // A déjà couru : personne derrière lui ne peut repasser devant.
    const best = idx + 1;
    return {
      hasRun: true, status: null,
      provisionalPosition: best,
      bestPosition: best,
      worstPosition: best + pending,
      exact: pending === 0,
      ranAhead: idx, pendingCount: pending, engagedCount: engaged,
    };
  }

  // Pas encore couru : tout reste ouvert entre la victoire et la dernière place
  // des pilotes classés. Un abandon le placerait au-delà, hors classement.
  const potentialFinishers = progress.finishers.length + pending;
  return {
    hasRun: false, status: null, provisionalPosition: null,
    bestPosition: 1,
    worstPosition: potentialFinishers,
    exact: false,
    ranAhead: null, pendingCount: pending, engagedCount: engaged,
  };
}

/**
 * Points minimum et maximum encore atteignables sur la manche.
 *
 * Le barème n'est pas supposé monotone : on balaie réellement les positions
 * possibles. Un barème comportant une exception ne produira donc pas une borne
 * fausse.
 */
export function pointsBounds(bounds, regulation) {
  if (!bounds) return null;
  if (bounds.status) {
    const p = calcStatusPoints(bounds.status, 'MQ', bounds.engagedCount, regulation);
    return { min: p, max: p, exact: true, includesIncident: true };
  }
  let min = Infinity, max = -Infinity;
  for (let pos = bounds.bestPosition; pos <= bounds.worstPosition; pos++) {
    const p = mqPoints(pos, regulation) ?? 0;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  // Un pilote encore à courir peut aussi abandonner : la borne basse doit en
  // tenir compte, sans quoi elle ne serait pas une borne.
  let includesIncident = false;
  if (!bounds.hasRun) {
    for (const status of ['DNF', 'DNS', 'DSQ']) {
      const p = calcStatusPoints(status, 'MQ', bounds.engagedCount, regulation) ?? 0;
      if (p < min) { min = p; includesIncident = true; }
    }
  }
  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    exact: bounds.exact && min === max,
    includesIncident,
  };
}

// ─────────────────────────────────────────────────────────
// QUALIFICATION MATHÉMATIQUE
// ─────────────────────────────────────────────────────────

/**
 * Total de points encore atteignable par chaque pilote à l'issue du meeting.
 *
 * Manches à venir non commencées comprises : un pilote qui a encore deux
 * manches à courir peut encore marquer sur les deux. Le majorant est
 * volontairement large — il sert à démontrer une impossibilité, jamais à
 * estimer un résultat.
 */
function reachableTotals(context, { checkpoint, regulation, minClassifiedRaces }) {
  const completed = (context?.races || [])
    .filter(r => r.isComplete && r.num <= checkpoint)
    .map(r => ({ num: r.num, rows: r.rows }));
  const standings = buildInterimStandings(completed, context?.ecBonus, regulation, { minClassifiedRaces });

  const openRaces = (context?.races || []).filter(r => r.num > checkpoint);
  const out = new Map();

  for (const d of standings) {
    let min = d.totalPoints, max = d.totalPoints;
    for (const race of openRaces) {
      // Pilote non inscrit sur cette manche : elle ne peut rien lui rapporter.
      if (!race.rows.some(r => r.driverId === d.driverId)) continue;
      const b = positionBounds(context, race.num, d.driverId);
      const pb = b ? pointsBounds(b, regulation) : null;
      if (!pb) continue;
      min += pb.min ?? 0;
      max += pb.max ?? 0;
    }
    out.set(d.driverId, { driverId: d.driverId, now: d.totalPoints, min, max, position: d.position });
  }
  return { totals: out, standings };
}

/**
 * Qualification ou élimination DÉMONTRÉE.
 *
 * Renvoie `state: 'qualified'` seulement s'il est impossible qu'assez
 * d'adversaires terminent devant, en créditant chacun d'eux de son meilleur
 * résultat encore possible. Renvoie `'eliminated'` seulement si assez
 * d'adversaires sont hors d'atteinte même dans le meilleur déroulement du
 * pilote. Dans tous les autres cas : `'undecided'` — ce qui n'est pas un demi
 * verdict, mais l'absence de verdict.
 *
 * Les égalités de points comptent contre la conclusion : un ex aequo se
 * départage sur des critères que ce module ne cherche pas à anticiper.
 */
export function mathematicalVerdict({
  context, checkpoint, driverId, threshold,
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const regulation = context?.regulation;
  if (!context || !driverId || threshold == null) return null;

  const { totals } = reachableTotals(context, { checkpoint, regulation, minClassifiedRaces });
  const me = totals.get(driverId);
  if (!me) return null;

  let canPassMe = 0, certainlyAhead = 0;
  const threats = [];
  for (const [id, t] of totals) {
    if (id === driverId) continue;
    // Peut finir devant : son maximum atteint ou dépasse mon minimum.
    if (t.max >= me.min) { canPassMe++; threats.push(id); }
    // Est devant à coup sûr : son minimum dépasse mon maximum.
    if (t.min > me.max) certainlyAhead++;
  }

  const state = canPassMe + 1 <= threshold ? 'qualified'
    : certainlyAhead >= threshold ? 'eliminated'
      : 'undecided';

  return {
    driverId, threshold, state,
    minTotal: me.min, maxTotal: me.max, currentTotal: me.now,
    /** Adversaires encore capables de finir devant, au sens le plus large. */
    rivalsAbleToPass: canPassMe,
    /** Adversaires hors d'atteinte même dans le meilleur cas. */
    rivalsOutOfReach: certainlyAhead,
    threats,
    /** Le verdict n'est valable que si aucune autre manche ne suit. */
    racesStillOpen: (context.races || []).filter(r => r.num > checkpoint && !r.isComplete).map(r => r.num),
  };
}

// ─────────────────────────────────────────────────────────
// SYNTHÈSE
// ─────────────────────────────────────────────────────────

/**
 * Bloc CERTITUDES complet pour un pilote, prêt à afficher.
 *
 * Chaque énoncé produit ici est démontrable. Rien n'y entre qui dépende d'un
 * tirage : c'est la règle qui donne son sens au bloc, et la seule chose qui
 * empêche un team de lire une projection comme un fait.
 *
 * @returns {object}
 */
export function buildRaceCertainties({
  context, driverId, threshold, checkpoint = null,
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const cp = checkpoint ?? context?.lastCompletedRace ?? 0;
  const raceNum = context?.raceInProgress ?? null;
  const progress = raceNum != null ? raceProgress(context, raceNum) : null;
  const bounds = raceNum != null ? positionBounds(context, raceNum, driverId) : null;
  const points = bounds ? pointsBounds(bounds, context?.regulation) : null;

  // Une manche encore à disputer APRÈS celle-ci interdit tout verdict : le
  // classement final n'est pas déterminé par cette manche seule.
  const laterRaces = (context?.races || []).filter(r => raceNum != null && r.num > raceNum);
  const isLastRace = raceNum != null && laterRaces.length === 0;
  const verdict = isLastRace
    ? mathematicalVerdict({ context, checkpoint: cp, driverId, threshold, minClassifiedRaces })
    : null;

  const statements = [];
  const add = (kind, text) => statements.push({ kind, text });

  if (bounds && bounds.hasRun) {
    if (bounds.status) {
      add('position', `Manche ${raceNum} terminée sur ${bounds.status} : résultat acquis, il ne changera plus.`);
    } else if (bounds.exact) {
      add('position', `Manche ${raceNum} terminée à la position P${bounds.bestPosition} : résultat acquis.`);
    } else {
      add('position', `Résultat de la manche ${raceNum} acquis : ne peut pas terminer mieux que P${bounds.bestPosition}, ni moins bien que P${bounds.worstPosition}.`);
      add('position', `Les ${bounds.ranAhead} pilote${bounds.ranAhead > 1 ? 's' : ''} déjà classé${bounds.ranAhead > 1 ? 's' : ''} devant ne peu${bounds.ranAhead > 1 ? 'vent' : 't'} plus être rejoint${bounds.ranAhead > 1 ? 's' : ''} sur cette manche.`);
    }
    if (points && points.min === points.max) {
      add('points', `Points de la manche ${raceNum} acquis : ${points.min}.`);
    } else if (points) {
      add('points', `Points de la manche ${raceNum} compris entre ${points.min} et ${points.max}.`);
    }
  } else if (bounds && progress?.hasStarted) {
    add('position', `Pas encore passé en manche ${raceNum} : toutes les places de P1 à P${bounds.worstPosition} restent atteignables.`);
  }

  if (verdict && verdict.state === 'qualified') {
    add('qualification', `Qualification acquise : au plus ${verdict.rivalsAbleToPass} pilote${verdict.rivalsAbleToPass > 1 ? 's' : ''} peu${verdict.rivalsAbleToPass > 1 ? 'vent' : 't'} encore terminer devant, pour ${threshold} place${threshold > 1 ? 's' : ''}.`);
  } else if (verdict && verdict.state === 'eliminated') {
    add('qualification', `Qualification impossible : ${verdict.rivalsOutOfReach} pilotes sont hors d'atteinte pour ${threshold} place${threshold > 1 ? 's' : ''}.`);
  }

  return {
    raceNum, checkpoint: cp,
    progress,
    description: describeProgress(progress),
    bounds, points,
    isLastRace,
    verdict,
    /** Vrai tant qu'une manche suit : on reste sur SIMULATION / PROBABILITÉ. */
    stillAProjection: !isLastRace,
    statements,
  };
}

/**
 * Le pilote est-il déjà qualifié ou éliminé par le seul jeu des règles, sans
 * qu'aucune manche ne reste à courir ? Sert de garde-fou à l'affichage.
 */
export function isSettled(certainties) {
  return Boolean(certainties?.verdict && certainties.verdict.state !== 'undecided');
}
