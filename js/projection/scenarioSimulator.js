/* ═══════════════════════════════════════════════
   SCENARIOSIMULATOR.JS — Simulation séquentielle des manches restantes.

   Module PUR : ni Firestore, ni DOM.

   ── Principe ───────────────────────────────────────────────────────────────
   Le simulateur ne connaît ni « Q3 » ni « Q4 » : il prend l'état réel après la
   dernière manche courue, et rejoue les manches restantes DANS L'ORDRE. À
   chaque manche il fabrique de vrais documents de résultat, puis les passe à
   buildMqStandings() et buildInterimStandings() — le code de l'application.

   C'est délibérément plus coûteux qu'un calcul de points direct, et c'est le
   point important : barème, placement des DNF à `engagés + 1`, points de
   statut, règles de départage et détection des ex aequo sont EXACTEMENT ceux
   qui produisent le classement affiché. Une simulation qui ré-implémenterait
   ces règles finirait par diverger sans que personne ne s'en aperçoive.

   ── Chronos ────────────────────────────────────────────────────────────────
   Chaque manche simulée produit une position ET un chrono cohérent avec elle.
   Ce n'est pas un ornement : compareInterimTiebreaker() départage les ex aequo
   au chrono en mode FIA. Sans chrono plausible, les égalités seraient tranchées
   arbitrairement — et l'écart de probabilité correspondant serait invisible.
   Les chronos sont dérivés de l'échelle de temps réellement observée sur la
   dernière manche courue du meeting, et sont strictement croissants avec la
   position : aucun classement impossible ne peut être produit.

   ── Manche EN COURS : mode hybride réel + simulé ────────────────────────────
   Une manche partiellement courue n'est ni ignorée ni traitée comme finie :
   les résultats déjà acquis sont REPRIS TELS QUELS et seuls les pilotes non
   encore passés sont tirés. Le classement de la manche est ensuite produit par
   buildMqStandings() sur le mélange des deux, donc par le code de l'application.

   La donnée réelle est immuable, et cette immuabilité est structurelle plutôt
   que déclarative : un pilote déjà passé n'est jamais tiré, jamais forçable, et
   son chrono sert d'ANCRE. Les chronos simulés sont répartis dans les
   intervalles laissés libres entre ces ancres. Il en découle mécaniquement que
   l'ordre relatif des pilotes réels est le même dans les 10 000 tirages, et que
   personne ne peut « doubler » un pilote réel autrement qu'en s'intercalant à
   une place que le classement autorise.

   Cas particulier volontaire : quand une manche n'a AUCUN résultat réel, la
   formule de chrono retombe exactement sur celle d'avant le mode hybride, au
   millième près. Une manche entièrement simulée est donc rigoureusement
   inchangée.

   ── Scénarios forcés ───────────────────────────────────────────────────────
   Forcer un résultat pour le pilote analysé ne fige QUE lui : les autres
   continuent d'être tirés normalement, et le classement est recalculé en
   entier. Les tirages des autres pilotes sont en outre identiques d'un
   scénario à l'autre (mêmes nombres aléatoires), pour que l'écart entre
   « P8 » et « P7 » mesure la différence de scénario et non le bruit.
═══════════════════════════════════════════════ */

import { buildMqStandings, buildInterimStandings } from '../calc.js';
import { createRng, randomNormal, createTally } from './monteCarloEngine.js';
import { latentFromPosition } from './driverPerformanceModel.js';
import { PROJECTION_MIN_CLASSIFIED_RACES } from './qualificationState.js';
import { isQualifiedByRule } from './qualificationRules.js';
import { SIMULATION } from './projectionConfig.js';

/**
 * Statuts qu'un scénario peut forcer, à défaut de règlement connu.
 * Préférer `forceableStatuses(regulation)`, qui lit les statuts réellement
 * définis par le championnat.
 */
export const FORCEABLE_STATUSES = ['DNF', 'DNS', 'DSQ'];

/**
 * Statuts forçables d'après le RÈGLEMENT.
 *
 * Les points d'un statut ne sont pas une constante du simulateur : selon le
 * championnat et le nombre d'engagés, un DNF peut valoir près d'une dernière
 * place, et un DNS peut rapporter des points. Énumérer les statuts ici plutôt
 * que dans une constante évite qu'un championnat traitant un statut à part reste
 * invisible dans les scénarios.
 */
export function forceableStatuses(regulation) {
  const known = Object.keys(regulation?.statusRules || {});
  if (!known.length) return [...FORCEABLE_STATUSES];
  const ordre = ['DNF', 'DNS', 'DSQ', 'DSQ_RACE'];
  return known.sort((a, b) => {
    const ia = ordre.indexOf(a), ib = ordre.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// ─────────────────────────────────────────────────────────
// PRÉPARATION
// ─────────────────────────────────────────────────────────

/**
 * Échelle de temps du meeting : la droite qui relie une FORCE latente à un
 * CHRONO plausible.
 *
 * ── À quoi elle sert exactement ────────────────────────────────────────────
 * En simulation pure, elle ne sert à rien : les positions sortent de l'ordre
 * des forces tirées, et les chronos émis sont une fonction croissante du rang.
 * Multiplier l'échelle par dix ne changerait pas un seul classement.
 *
 * Elle devient en revanche déterminante en mode HYBRIDE, où des chronos réels
 * sont comparés aux forces tirées des pilotes restants. Une échelle fausse
 * classe alors tous les pilotes déjà passés devant tous les autres, et fait
 * s'effondrer la projection pour une raison purement instrumentale.
 *
 * ── Pourquoi le rang ne suffit pas sur une manche en cours ─────────────────
 * Les séries ne sont pas tirées au sort. Mesuré sur les données réelles : le
 * rang moyen des pilotes de la série 1 est 17,9 sur ~30, celui de la dernière
 * série 3,0. Les premiers passés sont les plus lents du plateau, par
 * construction. Les traiter comme un échantillon représentatif — c'est-à-dire
 * lire leur rang comme un quantile du plateau — décale l'échelle et fait
 * paraître les pilotes restants beaucoup plus lents qu'ils ne sont.
 *
 * L'ajustement porte donc sur la FORCE ESTIMÉE de chaque pilote (µ de son
 * modèle) et non sur son rang, dès que les modèles sont disponibles. Cette
 * régression est insensible à la composition des séries : elle compare chaque
 * chrono à ce qu'on attendait de CE pilote.
 *
 * La pente est ramenée vers celle de la dernière manche COMPLÈTE, d'autant plus
 * fortement que les finisseurs observés sont peu nombreux. Le NIVEAU vient
 * toujours des chronos réellement enregistrés : c'est ce qui capte l'évolution
 * de la piste d'une manche à l'autre.
 *
 * @param {object} context
 * @param {number} upToRace — dernière manche exploitable
 * @param {object} [options]
 * @param {object} [options.models] — modèles de performance, fortement conseillés
 * @param {number} [options.priorWeight=8] — poids de la pente de référence
 * @returns {{ baseMs, msPerZ, source, samples, basis, shrunk, reference }}
 */
export function timeScaleOf(context, upToRace, options = {}) {
  const priorWeight = options.priorWeight ?? 8;
  const models = options.models || null;
  const races = (context?.races || [])
    .filter(r => r.hasResults && r.num <= upToRace)
    .sort((a, b) => b.num - a.num);

  /**
   * Ajustement moindres carrés du chrono sur une abscisse de force.
   * `basis` dit d'où vient cette abscisse : le modèle du pilote, ou son rang
   * parmi les finisseurs observés à défaut de modèle.
   */
  const fit = (race, useModels) => {
    const finishers = (race.rows || [])
      .filter(r => r.ms != null && !r.status && r.position != null)
      .sort((a, b) => a.ms - b.ms);
    const k = finishers.length;
    if (k < 2) return null;

    const points = [];
    for (let i = 0; i < k; i++) {
      const m = useModels ? models?.[finishers[i].driverId] : null;
      // Rang parmi les finisseurs OBSERVÉS : sur une manche complète c'est le
      // plateau entier, donc une lecture correcte du quantile.
      const z = useModels && m ? m.mu : latentFromPosition(i + 1, k);
      if (z == null || !Number.isFinite(z)) continue;
      points.push([z, finishers[i].ms]);
    }
    if (points.length < 2) return null;

    let sz = 0, sm = 0, szz = 0, szm = 0;
    for (const [z, ms] of points) { sz += z; sm += ms; szz += z * z; szm += z * ms; }
    const n = points.length;
    const varZ = szz - sz * sz / n;
    if (!(varZ > 1e-9)) return null;
    const slope = (szm - sz * sm / n) / varZ;
    if (!(slope > 0)) return null;

    return {
      slope, meanZ: sz / n, meanMs: sm / n, k: n,
      complete: Boolean(race.isComplete), num: race.num,
      basis: useModels && models ? 'model' : 'rank',
    };
  };

  const fits = [];
  for (const race of races) {
    // Sur une manche EN COURS, l'abscisse « rang » est biaisée par la
    // composition des séries : on n'utilise que les modèles.
    const f = fit(race, Boolean(models)) || (race.isComplete ? fit(race, false) : null);
    if (f) fits.push(f);
  }
  if (!fits.length) {
    // Aucune référence exploitable : échelle neutre. Les chronos resteront
    // ordonnés, ce qui est tout ce dont le départage a besoin.
    return { baseMs: 60000, msPerZ: 1000, source: null, samples: 0, basis: 'none', shrunk: false, reference: null };
  }

  const cible = fits[0];
  // Référence de dispersion : la manche complète la plus récente, seule à
  // observer tout le plateau.
  const reference = fits.find(f => f.complete && f.num !== cible.num)
    || (cible.complete ? cible : null);

  let slope = cible.slope;
  let shrunk = false;
  if (!cible.complete && reference && reference.num !== cible.num) {
    slope = (cible.k * cible.slope + priorWeight * reference.slope) / (cible.k + priorWeight);
    shrunk = true;
  }

  // La droite passe par le barycentre des points observés : le niveau vient
  // donc toujours des chronos réellement enregistrés sur cette manche.
  const fieldSize = (context?.races || []).find(r => r.num === cible.num)?.engagedCount || cible.k;
  const z0 = latentFromPosition(1, fieldSize) ?? 0;
  const baseMs = cible.meanMs + slope * (z0 - cible.meanZ);

  return {
    baseMs, msPerZ: slope, source: cible.num,
    samples: cible.k, basis: cible.basis, shrunk,
    reference: reference ? { num: reference.num, msPerZ: reference.slope } : null,
  };
}

/** Pilotes engagés sur une manche : ses inscrits, sinon ceux du checkpoint. */
export function entrantsOfRace(context, raceNum, fallbackDriverIds = []) {
  const race = (context?.races || []).find(r => r.num === raceNum);
  const fromRace = race?.rows?.map(r => r.driverId) || [];
  return fromRace.length ? fromRace : [...fallbackDriverIds];
}

/** Documents `sessionParticipants` synthétiques, construits une seule fois. */
function participantsFor(context, driverIds) {
  return driverIds.map(id => {
    const d = context.driversById?.[id] || {};
    return {
      driverId: id, carNumber: d.carNumber ?? null,
      firstName: d.firstName ?? null, lastName: d.lastName ?? null,
    };
  });
}

/**
 * Résultats DÉJÀ ACQUIS sur une manche, sous la forme attendue par le
 * simulateur.
 *
 * @param {object} context
 * @param {number} raceNum
 * @param {string} [mode='inProgress'] — quelles manches peuvent fournir du réel.
 *        'inProgress' : uniquement une manche commencée et non terminée. C'est
 *        le seul régime sûr par défaut pour la SIMULATION : une manche
 *        postérieure au checkpoint et déjà terminée existe en backtest, et lire
 *        ses résultats serait une fuite temporelle caractérisée.
 *        'live' : toute manche ayant au moins un résultat, terminée ou non.
 *        Réservé à la lecture de l'état réel courant (bloc CERTITUDES), jamais
 *        au tirage.
 *        'none' : aucune reprise de réel, simulation pure.
 * @returns {object|null} { driverId: { ms, status } } ou null
 */
export function realResultsOfRace(context, raceNum, mode = 'inProgress') {
  if (mode === 'none') return null;
  const race = (context?.races || []).find(r => r.num === raceNum);
  if (!race) return null;
  if (mode === 'inProgress' && !race.isInProgress) return null;
  if (mode === 'live' && !race.hasResults) return null;

  const out = {};
  for (const row of race.rows || []) {
    if (row.ms == null && !row.status) continue;
    out[row.driverId] = { ms: row.ms ?? null, status: row.status || null };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Scénarios « et si » qui prétendraient réécrire une donnée déjà acquise.
 *
 * Un pilote qui a déjà roulé n'a plus de résultat hypothétique : il a un
 * résultat. Le moteur REFUSE le scénario plutôt que de l'appliquer
 * silencieusement — un what-if silencieusement ignoré afficherait une
 * probabilité conditionnelle sans condition, c'est-à-dire un chiffre faux.
 *
 * @returns {Array} [{ raceNum, driverId, real }]
 */
export function forcedConflicts(context, forced, mode = 'inProgress') {
  const out = [];
  for (const [num, byDriver] of Object.entries(forced || {})) {
    const real = realResultsOfRace(context, Number(num), mode);
    if (!real) continue;
    for (const driverId of Object.keys(byDriver || {})) {
      if (real[driverId]) out.push({ raceNum: Number(num), driverId, real: real[driverId] });
    }
  }
  return out;
}

/** Le pilote a-t-il déjà un résultat acquis sur cette manche ? */
export function hasRealResult(context, raceNum, driverId, mode = 'inProgress') {
  return Boolean(realResultsOfRace(context, raceNum, mode)?.[driverId]);
}

// ─────────────────────────────────────────────────────────
// SIMULATION D'UNE MANCHE
// ─────────────────────────────────────────────────────────

/**
 * Tire l'aléa d'une manche pour TOUS les pilotes, y compris ceux dont le
 * résultat sera forcé.
 *
 * Tirer aussi pour les pilotes forcés peut sembler gaspilleur ; c'est au
 * contraire indispensable. La position d'un tirage dans le flux reste ainsi la
 * même d'un scénario à l'autre, si bien que les autres pilotes vivent
 * exactement les mêmes courses. Sans cela, comparer « P8 » et « P7 »
 * reviendrait à comparer deux univers différents.
 */
export function drawRace(rng, race, buf) {
  for (let i = 0; i < race.ids.length; i++) {
    buf.incident[i] = rng();
    buf.latent[i] = randomNormal(rng);
  }
}

/** Tampons de tirage réutilisables pour une liste de manches. */
export function makeDrawBuffers(races) {
  return races.map(r => ({
    incident: new Float64Array(r.ids.length),
    latent: new Float64Array(r.ids.length),
  }));
}

/**
 * Attribue les chronos d'une manche à partir de l'ordre d'arrivée.
 *
 * Les entrées RÉELLES sont des ancres : leur chrono est recopié à l'identique,
 * jamais recalculé. Les entrées simulées sont réparties dans les intervalles
 * libres entre deux ancres. Trois propriétés en découlent, et ce sont
 * exactement celles dont le classement a besoin :
 *
 *   · les chronos réels sont conservés au millième près ;
 *   · les chronos sont strictement croissants avec la position, donc aucun
 *     classement impossible ne peut sortir d'ici ;
 *   · deux pilotes n'ont jamais le même chrono, donc aucun ex aequo arbitraire.
 *
 * Sans aucune ancre — manche entièrement simulée — la formule utilisée est
 * MOT POUR MOT celle d'avant le mode hybride : une manche simulée de bout en
 * bout produit donc exactement les mêmes chronos qu'auparavant.
 *
 * @param {Array} order — entrées classées : { driverId, ms, real }
 * @param {object} scale
 * @param {number} fieldSize — plateau de la manche, pour la formule de rang
 * @returns {number[]} chronos, dans l'ordre de `order`
 */
export function assignChronos(order, scale, fieldSize) {
  const out = new Array(order.length);
  const step = Math.max(1, Math.round(Math.abs(scale.msPerZ) * 0.05));
  const z0 = latentFromPosition(1, fieldSize) ?? 0;
  /** Formule historique : chrono déduit du RANG dans la manche. */
  const byRank = (p) => Math.round(scale.baseMs + scale.msPerZ * ((latentFromPosition(p + 1, fieldSize) ?? 0) - z0)) + p;

  let i = 0;
  while (i < order.length) {
    if (order[i].real) { out[i] = order[i].ms; i++; continue; }

    let j = i;
    while (j < order.length && !order[j].real) j++;
    const k = j - i;
    const lo = i > 0 ? out[i - 1] : null;
    const hi = j < order.length ? order[j].ms : null;

    for (let t = 0; t < k; t++) {
      if (lo == null && hi == null) {
        // Aucune ancre : comportement historique, à l'identique.
        out[i + t] = byRank(i + t);
      } else if (lo != null && hi != null) {
        // Intervalle borné des deux côtés. Quand la place le permet, on reste
        // sur des millisecondes entières, plus crédibles à la lecture ;
        // l'espacement régulier garantit alors la stricte croissance.
        out[i + t] = (hi - lo >= k + 1)
          ? lo + Math.round((hi - lo) * (t + 1) / (k + 1))
          : (hi > lo ? lo + (hi - lo) * (t + 1) / (k + 1) : lo + 1e-6 * (t + 1));
      } else if (hi != null) {
        // Pilotes simulés DEVANT le premier réel : on descend sous son chrono.
        const room = Math.min(step, Math.max(1, Math.floor((hi - 1) / Math.max(1, k))));
        out[i + t] = hi - (k - t) * room;
      } else {
        // Pilotes simulés DERRIÈRE le dernier réel : on remonte au-dessus.
        out[i + t] = lo + (t + 1) * step;
      }
    }
    i = j;
  }
  return out;
}

/**
 * Produit le classement d'une manche, via buildMqStandings.
 *
 * Point unique de vérité de la simulation d'une manche : le simulateur simple
 * et la matrice de scénarios passent tous deux par ici. Deux implémentations
 * des mêmes règles finiraient immanquablement par diverger.
 *
 * `race.real` porte les résultats déjà acquis. Un pilote qui y figure n'est ni
 * tiré, ni forcé, ni déplacé : la donnée réelle prime sur tout le reste.
 *
 * @param {object} race — { num, ids, participants, real? }
 * @param {object} buf — tampons remplis par drawRace()
 * @param {object} models
 * @param {object|null} forcedHere — { driverId: { position } | { status } }
 * @param {object} scale — sortie de timeScaleOf()
 * @param {object} regulation
 * @returns {Array} lignes de classement
 */
export function simulateRaceRows(race, buf, models, forcedHere, scale, regulation) {
  const real = race.real || null;
  const finishers = [];    // { driverId, key, ms, real }
  const incidents = [];    // { driverId, status }
  const forcedPlaced = []; // { driverId, position }
  const n = race.ids.length;
  const z0 = latentFromPosition(1, n) ?? 0;

  for (let i = 0; i < n; i++) {
    const id = race.ids[i];

    // 1. Donnée acquise : elle passe avant le tirage ET avant le scénario.
    const r = real?.[id];
    if (r) {
      if (r.status) incidents.push({ driverId: id, status: r.status });
      else finishers.push({ driverId: id, key: r.ms, ms: r.ms, real: true });
      continue;
    }

    // 2. Résultat imposé par un scénario « et si ».
    const f = forcedHere?.[id];
    if (f) {
      if (f.status) incidents.push({ driverId: id, status: f.status });
      // Chrono imposé : c'est l'hypothèse la plus directement actionnable
      // pendant une manche en cours — « si je fais 2:44.500 ». Il se comporte
      // comme un résultat réel : il ancre le classement et n'est pas déplacé.
      // Contrairement à une PLACE imposée, il n'a besoin d'aucune convention :
      // une place n'a de sens qu'une fois la manche finie.
      else if (f.ms != null) finishers.push({ driverId: id, key: f.ms, ms: f.ms, real: true });
      else if (f.position) forcedPlaced.push({ driverId: id, position: f.position });
      continue;
    }

    // 3. Pilote encore à courir : tirage.
    const m = models[id];
    if (!m) { incidents.push({ driverId: id, status: 'DNS' }); continue; }
    if (buf.incident[i] < m.incidentRate) { incidents.push({ driverId: id, status: 'DNF' }); continue; }
    const x = m.mu + m.sigma * buf.latent[i];
    finishers.push({ driverId: id, key: scale.baseMs + scale.msPerZ * (x - z0), real: false });
  }

  // Classement de la manche : les chronos réels et les forces simulées sont
  // comparés sur la MÊME échelle de temps, ce qui est précisément ce qui permet
  // à un pilote encore à courir de se placer devant ou derrière un pilote déjà
  // passé, sans jamais modifier l'ordre relatif de ceux qui ont déjà couru.
  finishers.sort((a, b) => a.key - b.key);
  const order = finishers;

  // Insertion des résultats forcés à leur place exacte : les autres pilotes se
  // décalent, exactement comme dans une vraie manche.
  forcedPlaced.sort((a, b) => a.position - b.position);
  for (const f of forcedPlaced) {
    const at = Math.min(Math.max(0, f.position - 1), order.length);
    order.splice(at, 0, { driverId: f.driverId, key: null, real: false });
  }

  const chronos = assignChronos(order, scale, n);
  const results = new Array(order.length + incidents.length);
  for (let p = 0; p < order.length; p++) {
    results[p] = { driverId: order[p].driverId, ms: chronos[p], status: null };
  }
  for (let k = 0; k < incidents.length; k++) {
    results[order.length + k] = { driverId: incidents[k].driverId, ms: null, status: incidents[k].status };
  }

  return buildMqStandings(race.participants, results, regulation);
}

// ─────────────────────────────────────────────────────────
// SIMULATION
// ─────────────────────────────────────────────────────────

/**
 * Simule les manches restantes depuis un checkpoint.
 *
 * @param {object} params
 * @param {object} params.context      — sortie de buildMeetingContext()
 * @param {number} params.checkpoint   — dernière manche réellement courue
 * @param {object} params.models       — { driverId → modèle de performance }
 * @param {number} params.threshold    — places qualificatives
 * @param {string} [params.focusDriverId]
 * @param {object} [params.forced]     — { raceNum: { driverId: { position } | { status } } }
 * @param {number} [params.simulations]
 * @param {number} [params.seed]
 * @param {string[]} [params.rivalIds] — adversaires à suivre nommément
 * @param {string} [params.entrantsSource='session'] — d'où vient la liste des
 *        partants d'une manche à venir. 'session' lit les inscrits réels de la
 *        session (bon en direct : un forfait déjà connu doit être pris en
 *        compte). 'checkpoint' reconduit le plateau du checkpoint — c'est le
 *        seul régime admissible en backtest, où la liste d'inscrits d'une
 *        manche future révélerait des forfaits qu'on ne pouvait pas connaître.
 * @param {number} [params.trackRaceOutcome] — suivre la place et les points du
 *        pilote analysé DANS cette manche. Pendant une manche en cours, c'est
 *        cette place-là qui se joue, pas seulement le classement final.
 * @param {string[]} [params.aheadOfIds] — adversaires dont on compte la
 *        fréquence à laquelle le pilote analysé les devance DANS cette manche.
 * @param {number} [params.trackStateAfterRace] — suivre aussi l'état du pilote
 *        analysé APRÈS cette manche intermédiaire. Répond à « si je fais P8 en
 *        Q3, dans quelle situation j'arrive avant Q4 ? ».
 * @param {boolean} [params.trackAllDrivers] — compter la qualification de TOUS
 *        les pilotes en une seule passe. Indispensable au backtest : une passe
 *        par meeting au lieu d'une par pilote, soit trente fois moins de calcul.
 * @param {string} [params.liveResults='inProgress'] — reprise des résultats
 *        déjà acquis sur une manche EN COURS. 'inProgress' est le régime normal
 *        en direct ; 'none' impose une simulation pure et est utilisé par le
 *        backtest, où aucune manche n'est censée être en cours.
 * @param {number} [params.minClassifiedRaces]
 * @returns {object}
 */
export function simulateFromCheckpoint({
  context, checkpoint, models = {}, threshold,
  focusDriverId = null, forced = null,
  simulations = SIMULATION.profiles[SIMULATION.defaultProfile],
  seed = SIMULATION.defaultSeed,
  rivalIds = [],
  trackAllDrivers = false,
  trackStateAfterRace = null,
  trackRaceOutcome = null,
  aheadOfIds = [],
  entrantsSource = 'session',
  liveResults = 'inProgress',
  // Le defaut de calc.js (2 manches classees) viderait le classement au
  // checkpoint apres Q1 : le simulateur n'aurait alors AUCUN partant et
  // renverrait silencieusement zero probabilite. On aligne donc le defaut sur
  // celui du module de projection.
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  // `isComplete` : une manche en cours n'a distribué ses points qu'à une partie
  // du plateau et ne peut pas entrer dans l'état de départ. Elle est reprise
  // plus bas, résultat par résultat, dans la manche simulée correspondante.
  const completed = (context?.races || [])
    .filter(r => r.isComplete && r.num <= checkpoint)
    .map(r => ({ num: r.num, rows: r.rows }));

  const conflicts = forcedConflicts(context, forced, liveResults);
  if (conflicts.length) {
    const c = conflicts[0];
    throw new Error(
      `Résultat déjà acquis en manche ${c.raceNum} pour ${c.driverId} : ` +
      'un scénario ne peut pas réécrire une donnée réelle.',
    );
  }

  const remaining = (context?.races || [])
    .filter(r => r.num > checkpoint)
    .map(r => r.num)
    .sort((a, b) => a - b);

  const baseStandings = buildInterimStandings(
    completed, context?.ecBonus, context?.regulation, { minClassifiedRaces },
  );
  const checkpointDriverIds = baseStandings.map(d => d.driverId);

  // Plus aucune manche à simuler : le résultat est un FAIT, pas une projection.
  // Même appel, même sortie — le moteur n'a pas de cas particulier « après Q4 ».
  if (!remaining.length) {
    const row = baseStandings.find(d => d.driverId === focusDriverId) || null;
    return finalResult({
      simulations: 0, seed, remaining, threshold, focusDriverId,
      deterministic: true,
      probability: row ? (isQualifiedByRule(row.position, threshold) ? 1 : 0) : null,
      positionTally: null, pointsTally: null, cutTally: null,
      rivals: [], standingsSample: baseStandings,
      allProbabilities: trackAllDrivers
        ? Object.fromEntries(baseStandings.map(d => [d.driverId, isQualifiedByRule(d.position, threshold) ? 1 : 0]))
        : null,
    });
  }

  // Préparation hors boucle : tout ce qui ne dépend pas du tirage.
  const races = remaining.map(num => {
    const ids = entrantsSource === 'checkpoint'
      ? [...checkpointDriverIds]
      : entrantsOfRace(context, num, checkpointDriverIds);
    return {
      num, ids, participants: participantsFor(context, ids),
      real: realResultsOfRace(context, num, liveResults),
    };
  });
  // La manche en cours est la référence de temps la plus fraîche du meeting :
  // ses chronos réels servent d'échelle aux pilotes qui restent à passer.
  const scale = timeScaleOf(context, context?.raceInProgress != null && liveResults !== 'none'
    ? Math.max(checkpoint, context.raceInProgress) : checkpoint, { models });
  const rng = createRng(seed);

  const positionTally = createTally();
  const pointsTally = createTally();
  const cutTally = createTally();
  const interPosition = createTally();
  const interPoints = createTally();
  const interGap = createTally();
  const rivalAhead = new Map(rivalIds.map(id => [id, 0]));
  const racePosition = createTally();
  const racePoints = createTally();
  const beatenInRace = new Map(aheadOfIds.map(id => [id, 0]));
  let raceCounted = 0;
  const allQualified = trackAllDrivers ? new Map(checkpointDriverIds.map(id => [id, 0])) : null;
  const allSeen = trackAllDrivers ? new Map(checkpointDriverIds.map(id => [id, 0])) : null;
  let qualified = 0, counted = 0;
  let standingsSample = null;

  // Tampons réutilisés : une simulation ne doit pas déclencher d'allocation
  // inutile, le backtest en enchaîne des millions.
  const draws = makeDrawBuffers(races);

  for (let sim = 0; sim < simulations; sim++) {
    const simulated = [];

    for (let ri = 0; ri < races.length; ri++) {
      const race = races[ri];
      const buf = draws[ri];
      drawRace(rng, race, buf);
      simulated.push({
        num: race.num,
        rows: simulateRaceRows(race, buf, models, forced?.[race.num] || null, scale, context.regulation),
      });
    }

    // Résultat du pilote DANS la manche suivie : c'est l'objectif immédiat
    // que le team peut transmettre, avant même le classement final.
    if (trackRaceOutcome && focusDriverId) {
      const r = simulated.find(x => x.num === trackRaceOutcome);
      const me = r?.rows.find(x => x.driverId === focusDriverId);
      if (me) {
        raceCounted++;
        if (me.position != null) racePosition.add(me.position);
        if (me.points != null) racePoints.add(me.points);
        for (const id of beatenInRace.keys()) {
          const other = r.rows.find(x => x.driverId === id);
          if (other && me.position != null && other.position != null && me.position < other.position) {
            beatenInRace.set(id, beatenInRace.get(id) + 1);
          }
        }
      }
    }

    // État intermédiaire : la situation dans laquelle le pilote aborde la
    // manche suivante. C'est une information distincte de la probabilité
    // finale, et souvent plus parlante pour un team.
    if (trackStateAfterRace && focusDriverId) {
      const upTo = buildInterimStandings(
        [...completed, ...simulated.filter(r => r.num <= trackStateAfterRace)],
        context.ecBonus, context.regulation, { minClassifiedRaces },
      );
      const row = upTo.find(d => d.driverId === focusDriverId);
      if (row) {
        interPosition.add(row.position);
        interPoints.add(row.totalPoints);
        if (threshold != null) interGap.add(row.position - threshold);
      }
    }

    const standings = buildInterimStandings(
      [...completed, ...simulated], context.ecBonus, context.regulation, { minClassifiedRaces },
    );
    if (sim === 0) standingsSample = standings;

    // Score de coupure : total du dernier qualifié. Sa distribution dit à quel
    // niveau se joue réellement la qualification, ce qu'aucune probabilité
    // seule ne montre.
    if (threshold != null && standings.length >= threshold) {
      cutTally.add(standings[threshold - 1].totalPoints);
    }

    if (trackAllDrivers) {
      for (const d of standings) {
        if (!allSeen.has(d.driverId)) { allSeen.set(d.driverId, 0); allQualified.set(d.driverId, 0); }
        allSeen.set(d.driverId, allSeen.get(d.driverId) + 1);
        if (isQualifiedByRule(d.position, threshold)) allQualified.set(d.driverId, allQualified.get(d.driverId) + 1);
      }
    }

    if (focusDriverId) {
      const row = standings.find(d => d.driverId === focusDriverId);
      if (row) {
        counted++;
        positionTally.add(row.position);
        pointsTally.add(row.totalPoints);
        if (isQualifiedByRule(row.position, threshold)) qualified++;
        for (const id of rivalAhead.keys()) {
          const r = standings.find(d => d.driverId === id);
          if (r && r.position < row.position) rivalAhead.set(id, rivalAhead.get(id) + 1);
        }
      }
    }
  }

  const rivals = [...rivalAhead.entries()]
    .map(([driverId, ahead]) => ({
      driverId,
      ...(context.driversById?.[driverId] || {}),
      probabilityAhead: counted ? ahead / counted : null,
    }))
    .sort((a, b) => (b.probabilityAhead ?? 0) - (a.probabilityAhead ?? 0));

  const allProbabilities = trackAllDrivers
    ? Object.fromEntries([...allSeen.entries()].map(([id, seen]) => [id, seen ? allQualified.get(id) / seen : null]))
    : null;

  return finalResult({
    simulations, seed, remaining, threshold, focusDriverId,
    deterministic: false, allProbabilities,
    probability: counted ? qualified / counted : null,
    qualifiedCount: qualified, countedCount: counted,
    positionTally, pointsTally, cutTally, rivals, standingsSample,
    timeScale: scale,
    raceOutcome: trackRaceOutcome && raceCounted ? {
      raceNum: trackRaceOutcome,
      samples: raceCounted,
      medianPosition: racePosition.quantile(0.5),
      meanPosition: racePosition.mean,
      positionDistribution: racePosition.entries(),
      medianPoints: racePoints.quantile(0.5),
      /** Fréquence à laquelle le pilote analysé devance chacun, dans CETTE manche. */
      aheadOf: Object.fromEntries([...beatenInRace.entries()]
        .map(([id, n]) => [id, n / raceCounted])),
    } : null,
    intermediate: trackStateAfterRace ? {
      raceNum: trackStateAfterRace,
      medianPosition: interPosition.quantile(0.5),
      meanPosition: interPosition.mean,
      medianPoints: interPoints.quantile(0.5),
      medianGap: interGap.quantile(0.5),
      positionDistribution: interPosition.entries(),
      gapDistribution: interGap.entries(),
      samples: interPosition.total,
    } : null,
  });
}

function finalResult(r) {
  return {
    seed: r.seed,
    simulations: r.simulations,
    deterministic: r.deterministic,
    remainingRaces: r.remaining,
    threshold: r.threshold,
    focusDriverId: r.focusDriverId,
    probability: r.probability,
    qualifiedCount: r.qualifiedCount ?? null,
    countedCount: r.countedCount ?? null,
    positionDistribution: r.positionTally ? r.positionTally.entries() : [],
    meanPosition: r.positionTally ? r.positionTally.mean : null,
    medianPosition: r.positionTally ? r.positionTally.quantile(0.5) : null,
    meanPoints: r.pointsTally ? r.pointsTally.mean : null,
    medianPoints: r.pointsTally ? r.pointsTally.quantile(0.5) : null,
    cutDistribution: r.cutTally ? r.cutTally.entries() : [],
    medianCut: r.cutTally ? r.cutTally.quantile(0.5) : null,
    cutRange: r.cutTally && r.cutTally.total
      ? { low: r.cutTally.quantile(0.1), high: r.cutTally.quantile(0.9) } : null,
    rivals: r.rivals || [],
    intermediate: r.intermediate ?? null,
    raceOutcome: r.raceOutcome ?? null,
    allProbabilities: r.allProbabilities ?? null,
    standingsSample: r.standingsSample || null,
    timeScale: r.timeScale || null,
  };
}

// ─────────────────────────────────────────────────────────
// SCÉNARIOS « ET SI »
// ─────────────────────────────────────────────────────────

/**
 * Probabilité de qualification pour chaque résultat imposé au pilote analysé
 * sur une manche donnée.
 *
 * Tous les scénarios partagent la même graine : les autres pilotes vivent donc
 * exactement les mêmes courses d'un scénario à l'autre. La comparaison entre
 * deux positions forcées est ainsi débarrassée du bruit de tirage, ce qui est
 * indispensable pour que le calcul du résultat cible ne réagisse pas au hasard.
 *
 * @param {object} params — ceux de simulateFromCheckpoint(), plus :
 * @param {number} params.raceNum — manche sur laquelle imposer le résultat
 * @param {number[]} [params.positions] — places à tester (défaut : toutes)
 * @param {string[]} [params.statuses]  — statuts à tester
 * @returns {{ raceNum, entries: Array, seed, simulations }}
 */
export function whatIfResults({
  context, checkpoint, models, threshold, focusDriverId,
  raceNum, positions, statuses = null,
  simulations = SIMULATION.whatIfSimulations,
  seed = SIMULATION.defaultSeed,
  entrantsSource = 'session',
  liveResults = 'inProgress',
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  // Le pilote a déjà couru cette manche : il n'y a plus de scénario à explorer,
  // seulement un fait. On le dit explicitement plutôt que de renvoyer un tableau
  // vide, qui passerait pour une absence de données.
  const acquired = realResultsOfRace(context, raceNum, liveResults)?.[focusDriverId] || null;
  if (acquired) {
    return {
      raceNum, entries: [], seed, simulations: 0, entrants: 0,
      unavailable: 'alreadyRaced', realResult: acquired,
    };
  }

  const baseStandings = buildInterimStandings(
    (context?.races || []).filter(r => r.isComplete && r.num <= checkpoint).map(r => ({ num: r.num, rows: r.rows })),
    context?.ecBonus, context?.regulation, { minClassifiedRaces },
  );
  const entrants = entrantsSource === 'checkpoint'
    ? baseStandings.map(d => d.driverId)
    : entrantsOfRace(context, raceNum, baseStandings.map(d => d.driverId));
  const places = positions?.length
    ? positions
    : Array.from({ length: entrants.length }, (_, i) => i + 1);
  const statutsTestes = statuses?.length ? statuses : forceableStatuses(context?.regulation);

  const entries = [];
  for (const position of places) {
    const run = simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId,
      forced: { [raceNum]: { [focusDriverId]: { position } } },
      simulations, seed, entrantsSource, liveResults, minClassifiedRaces,
    });
    entries.push({
      kind: 'position', position, label: `P${position}`,
      probability: run.probability, medianPoints: run.medianPoints,
      medianPosition: run.medianPosition,
    });
  }
  for (const status of statutsTestes) {
    const run = simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId,
      forced: { [raceNum]: { [focusDriverId]: { status } } },
      simulations, seed, entrantsSource, liveResults, minClassifiedRaces,
    });
    entries.push({
      kind: 'status', status, label: status,
      probability: run.probability, medianPoints: run.medianPoints,
      medianPosition: run.medianPosition,
    });
  }

  return { raceNum, entries, seed, simulations, entrants: entrants.length, unavailable: null, realResult: null };
}

// ─────────────────────────────────────────────────────────
// MATRICE DE SCÉNARIOS CROISÉS
// ─────────────────────────────────────────────────────────

/**
 * Probabilité de qualification pour chaque combinaison d'hypothèses sur DEUX
 * manches — typiquement Q3 en lignes et Q4 en colonnes après Q2.
 *
 * ── Pourquoi ce n'est pas une simple double boucle ─────────────────────────
 * Mesuré sur un plateau réel de 30 pilotes : une manche restante coûte
 * 0,117 ms par tirage, deux manches 0,170 ms. Une matrice complète
 * 30 × 30 × 10 000 tirages représente donc **26 minutes de calcul**, ce qui
 * est hors de question dans un navigateur.
 *
 * Trois leviers sont appliqués :
 *
 *   1. MUTUALISATION DE LA LIGNE. Pour une hypothèse de ligne donnée, la
 *      manche de ligne — et toute manche qui n'est ni celle de ligne ni celle
 *      de colonne — n'est simulée QU'UNE FOIS par tirage, puis réutilisée pour
 *      toutes les colonnes. Le coût passe de (lignes × colonnes) simulations
 *      complètes à (lignes) simulations plus (lignes × colonnes) recalculs de
 *      classement.
 *
 *   2. NOMBRES ALÉATOIRES COMMUNS. Toutes les cellules partagent la même
 *      graine : les autres pilotes vivent exactement les mêmes courses dans
 *      toute la matrice. Les ÉCARTS entre cellules sont donc estimés bien plus
 *      précisément que les valeurs absolues — or c'est la comparaison entre
 *      cellules qui intéresse le lecteur.
 *
 *   3. HYPOTHÈSES SÉLECTIONNÉES. Les lignes et colonnes sont une liste de
 *      places stratégiques, pas tout le plateau. Une matrice 8 × 9 suffit à
 *      montrer quelles combinaisons laissent de la marge.
 *
 * Le nombre de tirages reste explicite dans la sortie : une cellule à 1 500
 * tirages porte une incertitude d'environ ±1,3 point, ce que l'interface doit
 * afficher plutôt que de laisser croire à une précision qu'elle n'a pas.
 *
 * @param {object} params
 * @param {object} params.context
 * @param {number} params.checkpoint
 * @param {object} params.models
 * @param {number} params.threshold
 * @param {string} params.focusDriverId
 * @param {number} [params.rowRace] — manche des lignes (défaut : checkpoint + 1)
 * @param {number} [params.colRace] — manche des colonnes (défaut : dernière)
 * @param {Array} params.rowScenarios — [{ kind, position } | { kind, status }]
 * @param {Array} params.colScenarios
 * @param {number} [params.simulations]
 * @param {number} [params.seed]
 * @param {Function} [params.onRowDone] — (fait, total) pour la progression
 * @returns {object}
 */
export function simulateScenarioMatrix({
  context, checkpoint, models = {}, threshold, focusDriverId,
  rowRace, colRace, rowScenarios = [], colScenarios = [],
  simulations = SIMULATION.matrixSimulations,
  seed = SIMULATION.defaultSeed,
  liveResults = 'inProgress',
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
  onRowDone = null,
} = {}) {
  const completed = (context?.races || [])
    .filter(r => r.isComplete && r.num <= checkpoint)
    .map(r => ({ num: r.num, rows: r.rows }));
  const remaining = (context?.races || [])
    .filter(r => r.num > checkpoint).map(r => r.num).sort((a, b) => a - b);

  const rowNum = rowRace ?? remaining[0];
  const colNum = colRace ?? remaining[remaining.length - 1];
  if (!remaining.length || rowNum == null || colNum == null || rowNum === colNum) {
    return { cells: [], rowRace: rowNum, colRace: colNum, simulations: 0, seed, unsupported: true };
  }
  // Le pilote a déjà couru l'une des deux manches croisées : la matrice n'a
  // plus d'objet sur cet axe, son résultat y est acquis.
  const acquiredAxis = [rowNum, colNum].find(num => realResultsOfRace(context, num, liveResults)?.[focusDriverId]);
  if (acquiredAxis != null) {
    return {
      cells: [], rowRace: rowNum, colRace: colNum, simulations: 0, seed,
      unsupported: true, unavailable: 'alreadyRaced', acquiredRace: acquiredAxis,
    };
  }

  const baseStandings = buildInterimStandings(completed, context?.ecBonus, context?.regulation, { minClassifiedRaces });
  const checkpointIds = baseStandings.map(d => d.driverId);
  const races = remaining.map(num => {
    const ids = entrantsOfRace(context, num, checkpointIds);
    return {
      num, ids, participants: participantsFor(context, ids),
      real: realResultsOfRace(context, num, liveResults),
    };
  });
  const scale = timeScaleOf(context, context?.raceInProgress != null && liveResults !== 'none'
    ? Math.max(checkpoint, context.raceInProgress) : checkpoint, { models });
  const colIndex = races.findIndex(r => r.num === colNum);

  const cells = [];
  for (let ri = 0; ri < rowScenarios.length; ri++) {
    const row = rowScenarios[ri];
    // Même graine pour chaque ligne : les autres pilotes vivent les mêmes
    // courses dans toute la matrice.
    const rng = createRng(seed);
    const draws = makeDrawBuffers(races);
    const counts = new Array(colScenarios.length).fill(0);
    const seen = new Array(colScenarios.length).fill(0);
    const interPos = createTally();

    for (let sim = 0; sim < simulations; sim++) {
      // Toutes les manches sauf celle des colonnes : simulées une seule fois
      // et réutilisées pour chaque colonne.
      const fixed = [];
      for (let i = 0; i < races.length; i++) {
        drawRace(rng, races[i], draws[i]);
        if (i === colIndex) continue;
        const forcedHere = races[i].num === rowNum ? { [focusDriverId]: forcedOf(row) } : null;
        fixed.push({ num: races[i].num, rows: simulateRaceRows(races[i], draws[i], models, forcedHere, scale, context.regulation) });
      }

      // Situation dans laquelle le pilote aborde la manche de colonne.
      const upTo = buildInterimStandings(
        [...completed, ...fixed.filter(r => r.num <= rowNum)],
        context.ecBonus, context.regulation, { minClassifiedRaces },
      );
      const interRow = upTo.find(d => d.driverId === focusDriverId);
      if (interRow) interPos.add(interRow.position);

      // Tableau de manches monté une seule fois par tirage : seule la dernière
      // entrée change d'une colonne à l'autre.
      const payload = [...completed, ...fixed, null];
      const last = payload.length - 1;

      for (let ci = 0; ci < colScenarios.length; ci++) {
        payload[last] = {
          num: colNum,
          rows: simulateRaceRows(
            races[colIndex], draws[colIndex], models,
            { [focusDriverId]: forcedOf(colScenarios[ci]) }, scale, context.regulation,
          ),
        };
        const standings = buildInterimStandings(
          payload, context.ecBonus, context.regulation, { minClassifiedRaces },
        );
        const focus = standings.find(d => d.driverId === focusDriverId);
        if (!focus) continue;
        seen[ci]++;
        if (isQualifiedByRule(focus.position, threshold)) counts[ci]++;
      }
    }

    cells.push({
      row: { ...row, label: labelOf(row) },
      medianPositionAfterRow: interPos.quantile(0.5),
      columns: colScenarios.map((col, ci) => ({
        col: { ...col, label: labelOf(col) },
        probability: seen[ci] ? counts[ci] / seen[ci] : null,
        samples: seen[ci],
      })),
    });
    if (onRowDone) onRowDone(ri + 1, rowScenarios.length);
  }

  return {
    cells, rowRace: rowNum, colRace: colNum,
    simulations, seed,
    /** Incertitude indicative d'une cellule, en points de pourcentage. */
    marginOfErrorPct: 100 * Math.sqrt(0.25 / Math.max(1, simulations)),
    unsupported: false,
  };
}

function forcedOf(scenario) {
  return scenario.kind === 'status' ? { status: scenario.status } : { position: scenario.position };
}

function labelOf(scenario) {
  return scenario.kind === 'status' ? scenario.status : `P${scenario.position}`;
}

/**
 * Hypothèses par défaut : des places réparties sur tout le plateau, plus
 * l'abandon. Volontairement peu nombreuses — la matrice sert à repérer les
 * combinaisons qui laissent de la marge, pas à tabuler chaque place.
 */
export function defaultScenarioLadder(fieldSize) {
  const wanted = [1, 3, 5, 8, 10, 12, 15, 20];
  const positions = [...new Set(wanted.filter(p => p <= fieldSize))];
  if (fieldSize > 0 && !positions.includes(fieldSize)) positions.push(fieldSize);
  return [
    ...positions.map(position => ({ kind: 'position', position })),
    { kind: 'status', status: 'DNF' },
  ];
}
