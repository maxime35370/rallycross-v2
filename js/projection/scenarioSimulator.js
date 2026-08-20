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

/** Statuts qu'un scénario peut forcer, dans l'ordre d'affichage. */
export const FORCEABLE_STATUSES = ['DNF', 'DNS', 'DSQ'];

// ─────────────────────────────────────────────────────────
// PRÉPARATION
// ─────────────────────────────────────────────────────────

/**
 * Échelle de temps du meeting, déduite de la dernière manche courue.
 *
 * On ne cherche pas à prédire un chrono : on cherche à produire des écarts
 * plausibles et strictement ordonnés, à la bonne échelle pour ce circuit.
 *
 * @returns {{ baseMs: number, msPerZ: number, source: number|null }}
 */
export function timeScaleOf(context, upToRace) {
  const races = (context?.races || [])
    .filter(r => r.hasResults && r.num <= upToRace)
    .sort((a, b) => b.num - a.num);

  for (const race of races) {
    const finishers = race.rows
      .filter(r => r.ms != null && !r.status && r.position != null)
      .sort((a, b) => a.position - b.position);
    if (finishers.length < 2) continue;

    const first = finishers[0], last = finishers[finishers.length - 1];
    const zFirst = latentFromPosition(first.position, race.engagedCount);
    const zLast = latentFromPosition(last.position, race.engagedCount);
    const dz = (zLast ?? 0) - (zFirst ?? 0);
    const dms = last.ms - first.ms;
    if (dz > 1e-6 && dms > 0) {
      return { baseMs: first.ms, msPerZ: dms / dz, source: race.num };
    }
  }
  // Aucune référence exploitable : échelle neutre. Les chronos resteront
  // ordonnés, ce qui est tout ce dont le départage a besoin.
  return { baseMs: 60000, msPerZ: 1000, source: null };
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
 * @param {boolean} [params.trackAllDrivers] — compter la qualification de TOUS
 *        les pilotes en une seule passe. Indispensable au backtest : une passe
 *        par meeting au lieu d'une par pilote, soit trente fois moins de calcul.
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
  entrantsSource = 'session',
  // Le defaut de calc.js (2 manches classees) viderait le classement au
  // checkpoint apres Q1 : le simulateur n'aurait alors AUCUN partant et
  // renverrait silencieusement zero probabilite. On aligne donc le defaut sur
  // celui du module de projection.
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const completed = (context?.races || [])
    .filter(r => r.hasResults && r.num <= checkpoint)
    .map(r => ({ num: r.num, rows: r.rows }));

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
    return { num, ids, participants: participantsFor(context, ids) };
  });
  const scale = timeScaleOf(context, checkpoint);
  const rng = createRng(seed);

  const positionTally = createTally();
  const pointsTally = createTally();
  const cutTally = createTally();
  const rivalAhead = new Map(rivalIds.map(id => [id, 0]));
  const allQualified = trackAllDrivers ? new Map(checkpointDriverIds.map(id => [id, 0])) : null;
  const allSeen = trackAllDrivers ? new Map(checkpointDriverIds.map(id => [id, 0])) : null;
  let qualified = 0, counted = 0;
  let standingsSample = null;

  // Tampons réutilisés : une simulation ne doit pas déclencher d'allocation
  // inutile, le backtest en enchaîne des millions.
  const draws = races.map(r => ({
    incident: new Float64Array(r.ids.length),
    latent: new Float64Array(r.ids.length),
  }));

  for (let sim = 0; sim < simulations; sim++) {
    const simulated = [];

    for (let ri = 0; ri < races.length; ri++) {
      const race = races[ri];
      const buf = draws[ri];

      // On tire TOUJOURS pour tous les pilotes, y compris ceux dont le
      // résultat est forcé : la position d'un tirage dans le flux reste ainsi
      // la même d'un scénario à l'autre, ce qui rend les scénarios comparables.
      for (let i = 0; i < race.ids.length; i++) {
        buf.incident[i] = rng();
        buf.latent[i] = randomNormal(rng);
      }

      const forcedHere = forced?.[race.num] || null;
      const finishers = [];   // { driverId, x }
      const incidents = [];   // { driverId, status }
      const forcedPlaced = []; // { driverId, position }

      for (let i = 0; i < race.ids.length; i++) {
        const id = race.ids[i];
        const f = forcedHere?.[id];
        if (f) {
          if (f.status) incidents.push({ driverId: id, status: f.status });
          else if (f.position) forcedPlaced.push({ driverId: id, position: f.position });
          continue;
        }
        const m = models[id];
        if (!m) { incidents.push({ driverId: id, status: 'DNS' }); continue; }
        if (buf.incident[i] < m.incidentRate) { incidents.push({ driverId: id, status: 'DNF' }); continue; }
        finishers.push({ driverId: id, x: m.mu + m.sigma * buf.latent[i] });
      }

      finishers.sort((a, b) => a.x - b.x);
      const order = finishers.map(f => f.driverId);

      // Insertion des résultats forcés à leur place exacte : les autres
      // pilotes se décalent, exactement comme dans une vraie manche.
      forcedPlaced.sort((a, b) => a.position - b.position);
      for (const f of forcedPlaced) {
        const at = Math.min(Math.max(0, f.position - 1), order.length);
        order.splice(at, 0, f.driverId);
      }

      // Chronos : dérivés du RANG FINAL, donc strictement croissants avec la
      // position. Aucun classement incohérent ne peut sortir d'ici.
      const n = race.ids.length;
      const results = new Array(order.length + incidents.length);
      const z0 = latentFromPosition(1, n) ?? 0;
      for (let p = 0; p < order.length; p++) {
        const z = latentFromPosition(p + 1, n) ?? 0;
        results[p] = {
          driverId: order[p],
          ms: Math.round(scale.baseMs + scale.msPerZ * (z - z0)) + p,
          status: null,
        };
      }
      for (let k = 0; k < incidents.length; k++) {
        results[order.length + k] = { driverId: incidents[k].driverId, ms: null, status: incidents[k].status };
      }

      simulated.push({ num: race.num, rows: buildMqStandings(race.participants, results, context.regulation) });
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
  raceNum, positions, statuses = FORCEABLE_STATUSES,
  simulations = SIMULATION.whatIfSimulations,
  seed = SIMULATION.defaultSeed,
  entrantsSource = 'session',
  minClassifiedRaces = PROJECTION_MIN_CLASSIFIED_RACES,
} = {}) {
  const baseStandings = buildInterimStandings(
    (context?.races || []).filter(r => r.hasResults && r.num <= checkpoint).map(r => ({ num: r.num, rows: r.rows })),
    context?.ecBonus, context?.regulation, { minClassifiedRaces },
  );
  const entrants = entrantsSource === 'checkpoint'
    ? baseStandings.map(d => d.driverId)
    : entrantsOfRace(context, raceNum, baseStandings.map(d => d.driverId));
  const places = positions?.length
    ? positions
    : Array.from({ length: entrants.length }, (_, i) => i + 1);

  const entries = [];
  for (const position of places) {
    const run = simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId,
      forced: { [raceNum]: { [focusDriverId]: { position } } },
      simulations, seed, entrantsSource, minClassifiedRaces,
    });
    entries.push({
      kind: 'position', position, label: `P${position}`,
      probability: run.probability, medianPoints: run.medianPoints,
      medianPosition: run.medianPosition,
    });
  }
  for (const status of statuses) {
    const run = simulateFromCheckpoint({
      context, checkpoint, models, threshold, focusDriverId,
      forced: { [raceNum]: { [focusDriverId]: { status } } },
      simulations, seed, entrantsSource, minClassifiedRaces,
    });
    entries.push({
      kind: 'status', status, label: status,
      probability: run.probability, medianPoints: run.medianPoints,
      medianPosition: run.medianPosition,
    });
  }

  return { raceNum, entries, seed, simulations, entrants: entrants.length };
}
