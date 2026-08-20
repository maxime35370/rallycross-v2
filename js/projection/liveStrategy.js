/* ═══════════════════════════════════════════════
   LIVESTRATEGY.JS — Transformer l'état réel d'une manche en une consigne
   transmissible au pilote.

   Module PUR : ni Firestore, ni DOM.

   ── L'erreur que ce module existe pour éviter ──────────────────────────────
   Le classement provisoire d'une manche en cours donne envie d'une traduction
   immédiate : « P4 provisoire fait 2:45.988, donc battre 2:45.988 = être P4 ».
   C'est faux dès qu'il reste des pilotes à courir, et particulièrement faux
   pour les COÉQUIPIERS DE SÉRIE : ils partent en même temps que notre pilote et
   peuvent s'intercaler eux aussi. Un pilote peut faire 2:44.000, battre
   l'ancien P4, et ressortir P6 parce que deux membres de sa propre série ont
   fait mieux encore.

   Le raisonnement se fait donc toujours au niveau de la SÉRIE ENTIÈRE puis du
   CLASSEMENT GLOBAL de la manche : on simule notre pilote ET tous les autres
   pilotes non encore passés, on fusionne avec les chronos réels, et on relit le
   classement complet. Le chrono n'est jamais qu'une TRADUCTION d'un objectif de
   rang, jamais l'objectif lui-même.

   ── Trois natures d'énoncé, jamais mélangées ───────────────────────────────
   · CERTAIN      — tous les chronos qui décident de la position sont connus.
                    « Battre 2:45.988 garantit au moins P4. »
   · MATHÉMATIQUE — vrai quels que soient les résultats restants, par bornes.
                    « Battre 2:45.988 et la qualification est acquise. »
   · PROBABILISTE — d'autres pilotes doivent encore rouler.
                    « Battre 2:45.988 donne 72 % d'être P4 ou mieux. »
═══════════════════════════════════════════════ */

import { buildInterimStandings, mqPoints, calcStatusPoints } from '../calc.js';
import { computeSeriesSizes } from '../calc.js';
import { PROJECTION_MIN_CLASSIFIED_RACES } from './qualificationState.js';
import { realResultsOfRace, simulateFromCheckpoint, forceableStatuses } from './scenarioSimulator.js';
import { statusesOf } from './raceCertainties.js';
import { STRATEGY } from './projectionConfig.js';

// ─────────────────────────────────────────────────────────
// COMPOSITION DES SÉRIES
// ─────────────────────────────────────────────────────────

/**
 * Composition des séries d'une manche.
 *
 * L'appartenance à une série n'est enregistrée que sur les résultats, donc
 * seulement pour les pilotes DÉJÀ PASSÉS. Pour les autres, elle est déduite de
 * la règle de l'application : l'ordre de passage d'une manche est l'inverse du
 * classement de la manche précédente, découpé par computeSeriesSizes().
 *
 * Mesuré sur les données réelles : cette déduction place correctement 98,9 %
 * des pilotes et reproduit exactement 91,7 % des manches. Ce n'est donc pas une
 * certitude, et chaque série déduite est marquée comme telle.
 *
 * Un cas échappe entièrement à la déduction et mérite d'être traité à part :
 * quand il reste moins de pilotes à courir que la taille de la dernière série
 * incomplète, tous les pilotes restants appartiennent forcément à cette série.
 * C'est le cas le plus fréquent au moment où l'objectif compte vraiment, juste
 * avant le passage de notre pilote.
 *
 * @returns {object|null}
 */
export function seriesPlan(context, raceNum) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race) return null;

  const perSeries = Number(context?.regulation?.sessionConfig?.MQ?.driversPerSeries) || 5;
  const mode = context?.regulation?.seriesDistributionMode || 'ffsa';
  const sizes = computeSeriesSizes(race.engagedCount, perSeries, mode);

  // Appartenances ENREGISTRÉES : la source de vérité. Elles ne sont portées que
  // par les résultats, donc uniquement par les pilotes déjà passés — c'est
  // qualificationState qui les a déjà regroupées par série.
  const known = new Map();
  for (const s of race.series?.known || []) {
    for (const id of s.driverIds) known.set(id, s.num);
  }

  const pending = new Set(race.pendingDriverIds);
  const ordre = passingOrder(context, raceNum);

  // Répartition : les appartenances ENREGISTRÉES sont placées d'abord et ne
  // sont jamais déplacées ; les pilotes restants remplissent les places encore
  // libres, dans l'ordre de passage. Déduire indépendamment des séries déjà
  // connues produirait des séries de tailles impossibles — un pilote déduit
  // atterrissant dans une série déjà complète.
  const assignment = new Map();
  const restant = sizes.map(n => n);
  for (const [id, num] of known) {
    assignment.set(id, { serie: num, inferred: false });
    if (restant[num - 1] != null) restant[num - 1] -= 1;
  }

  let serieCourante = 0;
  for (const id of ordre) {
    if (assignment.has(id)) continue;
    while (serieCourante < restant.length && restant[serieCourante] <= 0) serieCourante++;
    if (serieCourante >= restant.length) break;
    assignment.set(id, { serie: serieCourante + 1, inferred: true });
    restant[serieCourante] -= 1;
  }

  // Cas certain : moins de pilotes restants que la taille de la dernière série
  // non terminée — ils y sont tous, sans déduction.
  const seriesRestantes = [...new Set([...pending].map(id => assignment.get(id)?.serie).filter(v => v != null))];
  const toutRestantDansUneSerie = seriesRestantes.length === 1
    && pending.size <= (sizes[seriesRestantes[0] - 1] ?? Infinity);
  if (toutRestantDansUneSerie) {
    for (const id of pending) {
      assignment.set(id, { serie: seriesRestantes[0], inferred: false });
    }
  }

  const series = sizes.map((size, i) => {
    const num = i + 1;
    const membres = [...assignment.entries()].filter(([, v]) => v.serie === num).map(([id]) => id);
    const restants = membres.filter(id => pending.has(id));
    return {
      num, expectedSize: size, members: membres,
      pendingMembers: restants,
      ranMembers: membres.filter(id => !pending.has(id)),
      inferred: membres.some(id => assignment.get(id)?.inferred),
      complete: membres.length > 0 && restants.length === 0,
      inProgress: restants.length > 0 && restants.length < membres.length,
    };
  });

  return {
    raceNum, sizes, series, assignment,
    rowsById: new Map((race.rows || []).map(r => [r.driverId, r])),
    /** Série d'un pilote, avec l'indication de sa fiabilité. */
    of: (driverId) => {
      const a = assignment.get(driverId);
      return a ? series.find(s => s.num === a.serie) && { ...series.find(s => s.num === a.serie), inferred: a.inferred } : null;
    },
  };
}

/**
 * Ordre de passage déduit : inverse du classement de la manche précédente, les
 * pilotes non classés d'abord. C'est la règle appliquée par l'écran de
 * chronométrage pour composer la grille.
 */
export function passingOrder(context, raceNum) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  const prev = (context?.races || []).find(r => r.num === raceNum - 1);
  const ids = (race?.rows || []).map(r => r.driverId);
  if (!prev) return [...ids];

  const rang = new Map((prev.rows || [])
    .filter(r => r.ms != null && !r.status)
    .sort((a, b) => a.ms - b.ms)
    .map((r, i) => [r.driverId, i]));

  const classes = ids.filter(id => rang.has(id)).sort((a, b) => rang.get(b) - rang.get(a));
  const autres = ids.filter(id => !rang.has(id));
  return [...autres, ...classes];
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT PROVISOIRE ET BORNES DE CHRONO
// ─────────────────────────────────────────────────────────

/** Classement provisoire de la manche : uniquement les chronos réels, triés. */
export function provisionalOrder(context, raceNum) {
  const real = realResultsOfRace(context, raceNum, 'live') || {};
  return Object.entries(real)
    .filter(([, r]) => r.ms != null && !r.status)
    .map(([driverId, r]) => ({ driverId, ms: r.ms }))
    .sort((a, b) => a.ms - b.ms)
    .map((x, i) => ({ ...x, provisionalPosition: i + 1 }));
}

/**
 * Chrono à réaliser pour occuper la position provisoire `target`.
 *
 * C'est une TRADUCTION d'un objectif de rang, et elle n'est exacte que contre
 * les pilotes déjà passés. Elle ne dit rien des pilotes encore à courir — d'où
 * `certain`, vrai uniquement quand plus personne d'autre ne doit rouler.
 *
 * @returns {object|null} { target, beat, upper, certain, realAhead }
 */
export function chronoForProvisionalPosition(context, raceNum, target, { excludeDriverId = null } = {}) {
  const ordre = provisionalOrder(context, raceNum).filter(x => x.driverId !== excludeDriverId);
  const race = (context?.races || []).find(r => r.num === raceNum);
  const autresRestants = (race?.pendingDriverIds || []).filter(id => id !== excludeDriverId);

  if (target < 1) return null;
  // Pour être `target`-ième, il faut battre le pilote actuellement `target`-ième.
  const aBattre = ordre[target - 1] || null;
  const devant = ordre[target - 2] || null;

  return {
    target,
    /** Chrono à battre strictement. Null si la position est libre. */
    beat: aBattre ? aBattre.ms : null,
    beatDriverId: aBattre ? aBattre.driverId : null,
    /** Borne haute : rester derrière ce chrono conserve la position visée. */
    upper: devant ? devant.ms : null,
    upperDriverId: devant ? devant.driverId : null,
    realAhead: target - 1,
    /** Exact seulement si plus aucun autre pilote ne doit courir. */
    certain: autresRestants.length === 0,
    pendingOthers: autresRestants.length,
  };
}

// ─────────────────────────────────────────────────────────
// OBJECTIF MATHÉMATIQUE
// ─────────────────────────────────────────────────────────

/**
 * Le chrono le plus LENT qui garantisse encore la qualification, quels que
 * soient les résultats restants.
 *
 * Le raisonnement est un encadrement, pas une simulation : si notre pilote a
 * `k` pilotes réels devant lui, sa pire position finale dans la manche est
 * `k + 1 + (pilotes restants)`. On en déduit son total minimum garanti, puis on
 * compte les adversaires qui peuvent encore le dépasser en les créditant chacun
 * de leur meilleur résultat possible. Une conclusion « acquis » est donc valide
 * à coup sûr.
 *
 * On cherche le seuil le PLUS PERMISSIF : annoncer « bats tout le monde » à un
 * pilote déjà tranquille serait une consigne fausse.
 *
 * @returns {object|null}
 */
export function mathematicalChronoTarget({
  context, raceNum, driverId, threshold, checkpoint = null,
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race || threshold == null) return null;
  const cp = checkpoint ?? context.lastCompletedRace;
  const reg = context.regulation;

  const ordre = provisionalOrder(context, raceNum).filter(x => x.driverId !== driverId);
  const autresRestants = (race.pendingDriverIds || []).filter(id => id !== driverId);
  const laterRaces = (context.races || []).filter(r => r.num > raceNum);

  const completed = (context.races || [])
    .filter(r => r.isComplete && r.num <= cp).map(r => ({ num: r.num, rows: r.rows }));
  const standings = buildInterimStandings(completed, context.ecBonus, reg, { minClassifiedRaces });
  const totals = new Map(standings.map(d => [d.driverId, d.totalPoints]));
  if (!totals.has(driverId)) return null;

  const n = race.engagedCount;
  const meilleurPossible = Math.max(mqPoints(1, reg) ?? 0,
    ...statusesOf(reg).map(st => calcStatusPoints(st, 'MQ', n, reg) ?? 0));

  /** Majorant du total final d'un adversaire. */
  const maxOf = (id) => {
    let total = totals.get(id) ?? 0;
    const row = race.rows.find(r => r.driverId === id);
    total += (row && (row.ms != null || row.status)) ? (row.points ?? 0) : meilleurPossible;
    // Les manches encore à disputer après celle-ci laissent tout ouvert.
    for (const r of laterRaces) {
      if (r.rows.some(x => x.driverId === id)) total += meilleurPossible;
    }
    return total;
  };

  /** Le pilote est-il qualifié à coup sûr avec `devant` pilotes réels devant ? */
  const acquis = (devant) => {
    const pire = devant + 1 + autresRestants.length;
    let minTotal = (totals.get(driverId) ?? 0) + (mqPoints(pire, reg) ?? 0);
    // Une manche ultérieure peut encore rapporter zéro : la borne basse ne
    // bouge pas. On ne suppose rien de favorable.
    let peuventPasser = 0;
    for (const d of standings) {
      if (d.driverId === driverId) continue;
      if (maxOf(d.driverId) >= minTotal) peuventPasser++;
    }
    return { ok: peuventPasser + 1 <= threshold, peuventPasser, pire, minTotal };
  };

  // Balayage du plus permissif au plus exigeant : on garde le premier qui tient.
  for (let devant = ordre.length; devant >= 0; devant--) {
    const v = acquis(devant);
    if (!v.ok) continue;
    const aBattre = ordre[devant] || null;   // le (devant+1)-ième réel
    return {
      raceNum, driverId, threshold,
      maxRealAhead: devant,
      /** Chrono à battre. Null = aucun chrono à battre, la place est déjà prise. */
      beat: aBattre ? aBattre.ms : null,
      beatDriverId: aBattre ? aBattre.driverId : null,
      /** Vrai si même le pire résultat possible suffit : aucun objectif requis. */
      unconditional: devant === ordre.length,
      worstPosition: v.pire, minTotal: v.minTotal, rivalsAbleToPass: v.peuventPasser,
      laterRaces: laterRaces.map(r => r.num),
    };
  }
  return { raceNum, driverId, threshold, maxRealAhead: null, beat: null, unconditional: false, impossible: true };
}

/**
 * APRÈS le passage de notre pilote : combien d'adversaires restants devraient le
 * devancer pour que sa qualification cesse d'être acquise ?
 *
 * La lecture s'inverse — ce n'est plus lui qui agit. Son chrono est figé, donc
 * sa position finale dans la manche ne dépend plus que du NOMBRE de pilotes
 * restants qui le battront. On fait donc varier ce nombre, de zéro à tous, et on
 * cherche le dernier pour lequel la qualification reste démontrée.
 *
 * C'est un énoncé de CERTITUDE : le calcul est un encadrement, chaque adversaire
 * étant crédité de son meilleur résultat encore possible.
 *
 * @returns {object|null} { pendingCount, maxBeatenBy, safeWhatever, statement }
 */
export function resilienceAfterRun({
  context, raceNum, driverId, threshold, checkpoint = null,
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race || threshold == null) return null;
  const cp = checkpoint ?? context.lastCompletedRace;
  const reg = context.regulation;

  const row = race.rows.find(r => r.driverId === driverId);
  if (!row || (row.ms == null && !row.status)) return null;      // pas encore passé
  const restants = race.pendingDriverIds.filter(id => id !== driverId);

  const ordre = provisionalOrder(context, raceNum);
  const devantReels = ordre.findIndex(x => x.driverId === driverId);
  if (devantReels < 0) return null;                               // statut, pas de chrono

  const completed = (context.races || [])
    .filter(r => r.isComplete && r.num <= cp).map(r => ({ num: r.num, rows: r.rows }));
  const standings = buildInterimStandings(completed, context.ecBonus, reg, { minClassifiedRaces });
  const totals = new Map(standings.map(d => [d.driverId, d.totalPoints]));
  if (!totals.has(driverId)) return null;

  const n = race.engagedCount;
  const laterRaces = (context.races || []).filter(r => r.num > raceNum);
  const meilleurPossible = Math.max(mqPoints(1, reg) ?? 0,
    ...statusesOf(reg).map(st => calcStatusPoints(st, 'MQ', n, reg) ?? 0));

  const maxOf = (id) => {
    let total = totals.get(id) ?? 0;
    const r = race.rows.find(x => x.driverId === id);
    total += (r && (r.ms != null || r.status)) ? (r.points ?? 0) : meilleurPossible;
    for (const later of laterRaces) {
      if (later.rows.some(x => x.driverId === id)) total += meilleurPossible;
    }
    return total;
  };

  /** Qualification démontrée si exactement `j` pilotes restants le devancent ? */
  const acquis = (j) => {
    const position = devantReels + 1 + j;
    const minTotal = (totals.get(driverId) ?? 0) + (mqPoints(position, reg) ?? 0);
    let peuventPasser = 0;
    for (const d of standings) {
      if (d.driverId === driverId) continue;
      if (maxOf(d.driverId) >= minTotal) peuventPasser++;
    }
    return peuventPasser + 1 <= threshold;
  };

  let max = -1;
  for (let j = 0; j <= restants.length; j++) {
    if (!acquis(j)) break;
    max = j;
  }

  return {
    raceNum, driverId, threshold,
    provisionalPosition: devantReels + 1,
    ms: row.ms ?? null,
    pendingCount: restants.length,
    /** Nombre maximum de pilotes restants pouvant le devancer sans le sortir. */
    maxBeatenBy: max < 0 ? null : max,
    /** Vrai si même tous les pilotes restants devant lui le laissent qualifié. */
    safeWhatever: max >= restants.length,
    /** Vrai si sa qualification n'est déjà plus démontrable. */
    notDemonstrable: max < 0,
    laterRaces: laterRaces.map(r => r.num),
  };
}

// ─────────────────────────────────────────────────────────
// CONCURRENTS DIRECTS — PAR IMPACT MESURÉ
// ─────────────────────────────────────────────────────────

/**
 * Adversaires qui pèsent réellement sur la qualification, mesurés et non
 * supposés.
 *
 * Deux étapes, pour ne pas payer une simulation complète par adversaire :
 *   1. CRIBLE, gratuit — sur la passe de base déjà calculée, on lit la
 *      fréquence à laquelle chacun finit devant le pilote analysé. Un adversaire
 *      qui ne le devance jamais, ou toujours, ne fait pas basculer sa
 *      qualification.
 *   2. MESURE CAUSALE, sur les seuls candidats retenus — amplitude entre
 *      « il réussit au mieux » et « il abandonne », à tirages identiques. C'est
 *      un effet, pas une corrélation.
 *
 * La proximité au classement n'entre nulle part : sur données réelles, l'ordre
 * d'impact ne suit pas l'ordre du classement.
 */
export function directRivals({
  context, checkpoint, models, threshold, driverId,
  baseRun, candidates = STRATEGY.rivalCandidates,
  simulations = STRATEGY.rivalSimulations,
  seed, minImpact = STRATEGY.directRivalMinImpact,
  liveResults = 'inProgress',
} = {}) {
  const standings = baseRun?.standingsSample || [];
  const rivals = (baseRun?.rivals || []).filter(r => r.probabilityAhead != null);

  // Crible : ceux dont la présence devant est incertaine sont les seuls à
  // pouvoir faire basculer quoi que ce soit.
  const screened = rivals
    .filter(r => r.driverId !== driverId)
    .map(r => ({ ...r, uncertainty: 1 - Math.abs(2 * r.probabilityAhead - 1) }))
    .sort((a, b) => b.uncertainty - a.uncertainty)
    .slice(0, candidates);

  const races = (context?.races || []).filter(r => r.num > checkpoint).map(r => r.num);
  const raceNum = races[0];

  const out = [];
  for (const r of screened) {
    // Un adversaire déjà passé n'est plus une variable : son résultat est acquis.
    const real = realResultsOfRace(context, raceNum, liveResults)?.[r.driverId];
    if (real) {
      out.push({
        ...r, settled: true, impact: 0,
        probabilityAhead: r.probabilityAhead,
      });
      continue;
    }
    const run = (forced) => simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId: driverId,
      forced: { [raceNum]: { [r.driverId]: forced } },
      simulations, seed, liveResults,
    }).probability;

    const auMieux = run({ position: 1 });
    const pire = forceableStatuses(context?.regulation).includes('DNF') ? run({ status: 'DNF' }) : run({ position: 99 });
    out.push({
      ...r, settled: false,
      probabilityIfRivalBest: auMieux,
      probabilityIfRivalOut: pire,
      impact: (pire ?? 0) - (auMieux ?? 0),
    });
  }

  out.sort((a, b) => b.impact - a.impact);
  return {
    all: out,
    direct: out.filter(r => r.impact >= minImpact),
    minImpact,
    /** Position au classement des concurrents retenus, pour comparaison. */
    positions: Object.fromEntries(standings.map(d => [d.driverId, d.position])),
  };
}

// ─────────────────────────────────────────────────────────
// ÉCHELLE DE CHRONOS CIBLES
// ─────────────────────────────────────────────────────────

/**
 * Pour une série de chronos candidats, ce que chacun implique réellement.
 *
 * Chaque hypothèse est évaluée en simulant TOUS les pilotes non encore passés,
 * coéquipiers de série compris. C'est ce qui distingue cette échelle d'une
 * lecture naïve du classement provisoire : réaliser le chrono de l'actuel P4 ne
 * donne pas P4 si deux membres de notre propre série font mieux.
 */
export function chronoLadder({
  context, checkpoint, models, threshold, driverId, raceNum,
  targets, simulations = STRATEGY.targetSimulations, seed,
  seriesMates = [], liveResults = 'inProgress',
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const entries = [];
  for (const t of targets) {
    // Une manche non commencée n'a pas de classement provisoire : l'hypothèse
    // porte alors sur une PLACE, seule formulation qui ait un sens avant le
    // premier chrono. Dès qu'un chrono réel existe, on repasse au chrono, qui
    // lui n'est pas ambigu.
    const hypothese = t.ms != null ? { ms: t.ms }
      : t.status ? { status: t.status }
        : { position: t.position };
    const run = simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId: driverId,
      forced: { [raceNum]: { [driverId]: hypothese } },
      simulations, seed, liveResults, minClassifiedRaces,
      trackRaceOutcome: raceNum,
      aheadOfIds: seriesMates,
    });
    entries.push({
      ...t,
      probability: run.probability,
      medianRacePosition: run.raceOutcome?.medianPosition ?? null,
      racePositionDistribution: run.raceOutcome?.positionDistribution ?? [],
      medianRacePoints: run.raceOutcome?.medianPoints ?? null,
      /** Fréquence à laquelle notre pilote devance chaque coéquipier de série. */
      aheadOfSeriesMates: run.raceOutcome?.aheadOf ?? {},
      samples: run.raceOutcome?.samples ?? 0,
    });
  }
  return { raceNum, entries, seed, simulations };
}

/**
 * Probabilité, pour chaque coéquipier de série encore à courir, de battre un
 * chrono donné. C'est la réponse directe à « battre 2:45.988 suffit-il ? ».
 */
export function seriesMateThreat({
  context, checkpoint, models, threshold, driverId, raceNum, ms,
  seriesMates = [], simulations = STRATEGY.targetSimulations, seed, liveResults = 'inProgress',
} = {}) {
  if (!seriesMates.length) return [];
  const run = simulateFromCheckpoint({
    context, checkpoint, models, threshold, focusDriverId: driverId,
    forced: { [raceNum]: { [driverId]: { ms } } },
    simulations, seed, liveResults,
    trackRaceOutcome: raceNum, aheadOfIds: seriesMates,
  });
  const ahead = run.raceOutcome?.aheadOf || {};
  return seriesMates.map(id => ({
    driverId: id,
    ...(context.driversById?.[id] || {}),
    /** Probabilité que CE pilote batte le chrono visé. */
    probabilityBeatsTarget: ahead[id] != null ? 1 - ahead[id] : null,
  })).sort((a, b) => (b.probabilityBeatsTarget ?? 0) - (a.probabilityBeatsTarget ?? 0));
}

// ─────────────────────────────────────────────────────────
// OBJECTIF, PRÊT À AFFICHER
// ─────────────────────────────────────────────────────────

/**
 * Chronos candidats.
 *
 * Les positions sont réparties sur TOUT le classement provisoire, pas seulement
 * sur sa tête : c'est dans la zone où la probabilité bascule que l'objectif se
 * décide, et cette zone n'est pas connue d'avance. Une échelle limitée aux dix
 * premières places afficherait dix fois « 100 % » et ne dirait rien.
 *
 * Le dernier candidat correspond à « derrière tout le monde » : sans lui, on ne
 * saurait pas si un mauvais résultat reste compatible avec la qualification.
 */
function candidateTargets(context, raceNum, driverId, max) {
  const ordre = provisionalOrder(context, raceNum).filter(x => x.driverId !== driverId);

  // Manche pas encore commencée : aucune référence chrono n'existe. L'échelle
  // porte alors sur les places de la manche, ce qui reste la question utile
  // pour préparer la manche suivante après Q1, Q2 ou Q3.
  if (!ordre.length) {
    const race = (context?.races || []).find(r => r.num === raceNum);
    const n = race?.engagedCount || 0;
    if (!n) return [];
    const pas = Math.max(1, Math.ceil(n / Math.max(1, max - 1)));
    const places = new Set([1]);
    for (let p = 1; p <= n; p += pas) places.add(p);
    places.add(n);
    return [...places].sort((a, b) => a - b).map(position => ({
      kind: 'position', rank: position, position,
      label: `P${position} de la manche`,
      reference: { target: position, beat: null, certain: false },
    }));
  }

  const positions = new Set();
  const n = ordre.length;
  const pas = Math.max(1, Math.ceil(n / Math.max(1, max - 1)));
  for (let p = 1; p <= n; p += pas) positions.add(p);
  positions.add(n);                        // juste devant le dernier réel
  positions.add(1);                        // devant tout le monde

  const cibles = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const t = chronoForProvisionalPosition(context, raceNum, p, { excludeDriverId: driverId });
    if (!t?.beat) continue;
    // Un chrono strictement meilleur, d'un millième : traduction la plus fidèle
    // de « faire mieux que ».
    cibles.push({
      kind: 'chrono', rank: p, provisionalTarget: p, ms: t.beat - 1,
      label: `P${p} au provisoire`, reference: t,
    });
  }
  // « Derrière tous les pilotes déjà passés » : hypothèse basse indispensable.
  const dernier = ordre[n - 1];
  cibles.push({
    kind: 'chrono', rank: n + 1, provisionalTarget: n + 1, ms: dernier.ms + 1000,
    behindAll: true, label: 'derrière tous les pilotes déjà passés',
    reference: { target: n + 1, beat: null, certain: false },
  });
  return cibles;
}

/**
 * Bloc OBJECTIF complet pour un pilote, dans l'état réel du meeting.
 *
 * Quatre situations sont distinguées, parce qu'imposer une cible agressive à un
 * pilote déjà tranquille — ou inventer une cible atteignable à un pilote qui
 * dépend des autres — serait une consigne fausse :
 *
 *   · ACQUIS      — la qualification est démontrée, aucun objectif de résultat.
 *   · CONFORTABLE — large plage de résultats compatible ; seul le risque
 *                   d'abandon mérite d'être transmis.
 *   · DÉPENDANT   — même le meilleur résultat possible ne suffit pas seul.
 *   · OBJECTIF    — cas normal : une cible de rang, traduite en chrono.
 *
 * Et si notre pilote est déjà passé, la lecture s'inverse : ce n'est plus lui
 * qui agit, ce sont les autres.
 */
export function buildLiveObjective({
  context, checkpoint, models, threshold, driverId,
  baseRun, seed, simulations = STRATEGY.targetSimulations,
  maxTargets = STRATEGY.maxTargets, liveResults = 'inProgress',
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const raceNum = context?.raceInProgress ?? (context?.races || []).find(r => r.num > checkpoint)?.num ?? null;
  if (raceNum == null) return null;

  const race = context.races.find(r => r.num === raceNum);
  const plan = seriesPlan(context, raceNum);
  const maSerie = plan?.of(driverId) || null;
  const dejaCouru = !race.pendingDriverIds.includes(driverId);
  const mate = maSerie ? maSerie.pendingMembers.filter(id => id !== driverId) : [];
  const autresRestants = race.pendingDriverIds.filter(id => id !== driverId);

  const maths = mathematicalChronoTarget({
    context, raceNum, driverId, threshold, checkpoint, minClassifiedRaces,
  });

  const commun = {
    raceNum, driverId, threshold,
    series: maSerie ? {
      num: maSerie.num, expectedSize: maSerie.expectedSize,
      inferred: maSerie.inferred,
      pendingMates: mate.map(id => ({ driverId: id, ...(context.driversById?.[id] || {}) })),
      ranMembers: maSerie.ranMembers.length,
    } : null,
    pendingOthers: autresRestants.length,
    hasRun: dejaCouru,
    probability: baseRun?.probability ?? null,
    mathematical: maths,
  };

  // ── Après notre passage : la question s'inverse ──────────────────────────
  if (dejaCouru) {
    const menaces = (baseRun?.rivals || [])
      .filter(r => r.probabilityAhead != null && autresRestants.includes(r.driverId))
      .sort((a, b) => (b.probabilityAhead ?? 0) - (a.probabilityAhead ?? 0));
    return {
      ...commun, mode: 'afterRun',
      settled: Boolean(maths?.unconditional),
      resilience: resilienceAfterRun({ context, raceNum, driverId, threshold, checkpoint, minClassifiedRaces }),
      threats: menaces,
      remainingToRun: autresRestants.length,
    };
  }

  // ── Qualification déjà démontrée : aucun objectif ────────────────────────
  if (maths?.unconditional) {
    return { ...commun, mode: 'settled' };
  }

  const evaluer = (targets) => chronoLadder({
    context, checkpoint, models, threshold, driverId, raceNum,
    targets, simulations, seed, seriesMates: mate, liveResults, minClassifiedRaces,
  }).entries;

  // Risque d'incident : c'est souvent la seule information utile à un pilote
  // confortable, et elle manque à toute échelle de places.
  const statutPire = forceableStatuses(context?.regulation).includes('DNF') ? 'DNF' : null;
  const incident = statutPire ? {
    status: statutPire,
    probability: simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId: driverId,
      forced: { [raceNum]: { [driverId]: { status: statutPire } } },
      simulations, seed, liveResults, minClassifiedRaces,
    }).probability,
  } : null;

  const cibles = candidateTargets(context, raceNum, driverId, maxTargets);
  let entries = cibles.length ? evaluer(cibles) : [];

  // Affinage autour de la bascule. Un balayage régulier situe la frontière à
  // quelques places près ; or c'est précisément la place charnière qui est la
  // consigne. On ne raffine que l'intervalle utile, pour ne pas payer une
  // simulation par place du plateau.
  if (entries.length > 1) {
    const tri = [...entries].sort((a, b) => a.rank - b.rank);
    const ok = [...tri].reverse().find(e => (e.probability ?? 0) >= STRATEGY.targetConfidence);
    const ko = tri.find(e => (e.probability ?? 0) < STRATEGY.targetConfidence
      && (!ok || e.rank > ok.rank));
    if (ok && ko && ko.rank - ok.rank > 1) {
      const manquantes = [];
      for (let p = ok.rank + 1; p < ko.rank; p++) {
        if (ok.kind === 'position') {
          manquantes.push({ kind: 'position', rank: p, position: p, label: `P${p} de la manche`, reference: { target: p, beat: null, certain: false } });
          continue;
        }
        const t = chronoForProvisionalPosition(context, raceNum, p, { excludeDriverId: driverId });
        if (t?.beat) manquantes.push({ kind: 'chrono', rank: p, provisionalTarget: p, ms: t.beat - 1, label: `P${p} au provisoire`, reference: t });
      }
      if (manquantes.length) {
        entries = [...entries, ...evaluer(manquantes)].sort((a, b) => a.rank - b.rank);
      }
    }
  }
  const ladder = { entries };

  // Meilleur résultat encore possible : sert à détecter la dépendance.
  const meilleur = ladder.entries.length ? ladder.entries[0] : null;
  const proba = baseRun?.probability ?? null;

  if (meilleur && meilleur.probability != null && meilleur.probability < STRATEGY.dependentBelow) {
    return {
      ...commun, mode: 'dependent', incident,
      best: meilleur, ladder: ladder.entries,
      /** Adversaires dont dépend la qualification, à mesurer séparément. */
    };
  }

  if (proba != null && proba >= STRATEGY.comfortableAbove) {
    return { ...commun, mode: 'comfortable', incident, ladder: ladder.entries };
  }

  // ── Cas normal : la cible la plus permissive atteignant la confiance visée
  const atteignables = ladder.entries
    .filter(e => e.probability != null && e.probability >= STRATEGY.targetConfidence)
    .sort((a, b) => b.rank - a.rank);
  const cible = atteignables[0] || null;
  // Si même « derrière tous les pilotes déjà passés » suffit, aucune consigne de
  // résultat n'a de sens : le dire vaut mieux que d'inventer une cible.
  const aucunObjectifUtile = Boolean(cible?.behindAll);

  // La cible est-elle EXACTE ? Elle ne l'est que si plus personne d'autre ne
  // doit rouler — coéquipiers de série compris.
  const exact = autresRestants.length === 0;

  if (aucunObjectifUtile) {
    return { ...commun, mode: 'comfortable', incident, ladder: ladder.entries, coversWorstCase: true };
  }

  // « Juste derrière » : la place immédiatement moins bonne. C'est ce qui donne
  // sa valeur à la cible — une consigne dont le manquement ne change rien n'en
  // est pas une.
  const juste = ladder.entries
    .filter(e => e.rank > (cible?.rank ?? -1))
    .sort((a, b) => a.rank - b.rank)[0] || null;

  return {
    ...commun, mode: 'target', incident,
    target: cible,
    /** Probabilité si la cible est atteinte, et si elle est manquée d'une place. */
    probabilityAtTarget: cible?.probability ?? null,
    justBehind: juste,
    exact,
    lastOfSeries: mate.length === 0 && autresRestants.length > 0,
    ladder: ladder.entries,
    /** Coéquipiers susceptibles de s'intercaler sur la cible retenue. */
    seriesThreat: cible
      ? mate.map(id => ({
          driverId: id, ...(context.driversById?.[id] || {}),
          probabilityBeatsTarget: cible.aheadOfSeriesMates?.[id] != null
            ? 1 - cible.aheadOfSeriesMates[id] : null,
        })).sort((a, b) => (b.probabilityBeatsTarget ?? 0) - (a.probabilityBeatsTarget ?? 0))
      : [],
  };
}

/**
 * Libellé de situation, dérivé du mode. Une seule échelle, pour qu'un même mot
 * veuille toujours dire la même chose à l'écran.
 */
export const SITUATION_LABELS = {
  settled:     { key: 'settled',     label: 'QUALIFICATION ACQUISE', tone: 'green' },
  comfortable: { key: 'comfortable', label: 'CONFORTABLE',           tone: 'green' },
  target:      { key: 'target',      label: 'SENSIBLE',              tone: 'orange' },
  dependent:   { key: 'dependent',   label: 'DÉPENDANCE AUX CONCURRENTS', tone: 'red' },
  afterRun:    { key: 'afterRun',    label: 'RÉSULTAT ACQUIS',       tone: 'neutral' },
};

/**
 * Deux ou trois scénarios stratégiques, choisis pour être LISIBLES.
 *
 * Trente combinaisons seraient exactes et inutilisables. On retient donc des
 * hypothèses de nature différente — un objectif propre, une dépendance à un
 * concurrent — et on écarte les variantes redondantes d'une même idée.
 */
export function pickScenarios({ objective, rivals, max = STRATEGY.maxScenarios } = {}) {
  const out = [];
  const ladder = objective?.ladder || [];

  // 1. L'objectif propre le plus permissif qui tienne la confiance visée.
  if (objective?.target) {
    out.push({
      kind: 'ownResult',
      label: `${objective.target.label} ou mieux`,
      ms: objective.target.ms,
      probability: objective.target.probability,
      reference: objective.target.reference,
    });
  }

  // 2. Un cran plus ambitieux, s'il change vraiment quelque chose.
  const plusHaut = ladder
    .filter(e => objective?.target && e.rank < objective.target.rank)
    .sort((a, b) => b.rank - a.rank)[0];
  if (plusHaut && objective?.target
      && (plusHaut.probability ?? 0) - (objective.target.probability ?? 0) >= STRATEGY.directRivalMinImpact) {
    out.push({
      kind: 'ownResultBetter',
      label: `${plusHaut.label} ou mieux`,
      ms: plusHaut.ms, probability: plusHaut.probability,
      reference: plusHaut.reference,
    });
  }

  // 3. La dépendance la plus forte à un concurrent, si elle pèse plus que le
  //    gain d'un cran supplémentaire.
  const rival = (rivals?.direct || [])[0];
  if (rival && !rival.settled) {
    out.push({
      kind: 'rival',
      label: `Si #${rival.carNumber ?? '?'} ${rival.lastName || ''} ne termine pas la manche`,
      probability: rival.probabilityIfRivalOut,
      impact: rival.impact,
      driverId: rival.driverId,
    });
  }

  return out.slice(0, max);
}
