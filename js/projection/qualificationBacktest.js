/* ═══════════════════════════════════════════════
   QUALIFICATIONBACKTEST.JS — Le Monte-Carlo apporte-t-il quelque chose ?

   Module PUR : ni Firestore, ni DOM.

   Le module ne cherche pas à valider le Monte-Carlo : il cherche à savoir s'il
   fait MIEUX que la table historique du LOT 1. Trois prédicteurs sont mis en
   concurrence sur exactement les mêmes cas :

     • CLIMATOLOGIE — le taux de qualification global, identique pour tout le
       monde. C'est le prédicteur trivial : tout modèle qui ne le bat pas ne
       sert à rien.
     • HISTORIQUE — le taux observé chez les pilotes ayant eu le même écart au
       seuil au même checkpoint, meeting analysé exclu.
     • MONTE-CARLO — la simulation des manches restantes.

   ── Fuite temporelle ───────────────────────────────────────────────────────
   Quand un meeting est backtesté, AUCUNE donnée postérieure au checkpoint de
   ce meeting n'entre dans le modèle : ni ses manches suivantes, ni son
   résultat. Deux régimes sont proposés, et le second est le plus sévère :

     • 'leaveOneMeetingOut' — le meeting analysé est retiré en entier de
       l'historique, les autres meetings de la saison sont utilisés. C'est la
       consigne littérale : aucune donnée future DU MEETING analysé.
     • 'strictlyPrior' — seuls les meetings antérieurs en date sont utilisés,
       comme si l'on projetait réellement ce jour-là. Plus honnête encore, mais
       le premier meeting de la saison se retrouve alors sans historique.

   Les deux sont mesurés : leur écart dit combien le premier régime est
   optimiste.

   Deux fuites plus discrètes ont été identifiées et traitées :

     • LA LISTE DES PARTANTS d'une manche à venir. Sur 8 des 30 groupes, le
       plateau de Q4 est plus petit que celui d'après Q3 : lire les inscrits de
       Q4 reviendrait à connaître d'avance des forfaits. Le backtest reconduit
       donc le plateau du checkpoint (`entrantsSource: 'checkpoint'`).

     • LE SEUIL DE QUALIFICATION, que l'application ne stocke pas et qu'on
       retrouve en comptant les partants de la phase suivante. Sur 9 des 30
       groupes il diffère du règlement — surtout en Euro RX, où des catégories
       à 15 engagés passent en demi-finales directes (12 places) au lieu des
       24 places de quarts prévues au règlement. Le nombre de places est une
       donnée de FORMAT, connue avant le meeting, pas un résultat : l'utiliser
       est légitime, et lui substituer la valeur du règlement serait faux
       plutôt que prudent. Il subsiste un résidu assumé : lorsqu'un qualifié
       déclare forfait, le comptage des partants reflète ce forfait. Le cas est
       rare (voir `thresholdDivergences` dans la sortie) et joue sur une place.
═══════════════════════════════════════════════ */

import { buildStateAfterRace } from './qualificationState.js';
import {
  resolveQualificationThreshold, thresholdFromRegulation,
  isTrivialQualification, gapToThreshold,
} from './qualificationRules.js';
import { selectComparables, filterObservations } from './qualificationHistory.js';
import { collectRaceObservations, buildDriverModels } from './driverPerformanceModel.js';
import { simulateFromCheckpoint } from './scenarioSimulator.js';
import { SIMULATION, HISTORY } from './projectionConfig.js';

export const LEAKAGE_MODES = ['leaveOneMeetingOut', 'strictlyPrior'];

// ─────────────────────────────────────────────────────────
// MESURES
// ─────────────────────────────────────────────────────────

/**
 * Score de Brier : moyenne des carrés d'écart entre probabilité annoncée et
 * réalité (0 ou 1). Plus bas = meilleur ; 0,25 correspond à annoncer 50 %
 * partout. Il pénalise à la fois l'erreur de sens et l'excès d'assurance,
 * ce qui est exactement ce qu'on veut surveiller sur un modèle entraîné sur
 * huit meetings.
 */
export function brierScore(predictions = []) {
  const usable = predictions.filter(p => p.probability != null);
  if (!usable.length) return null;
  const sum = usable.reduce((s, p) => s + (p.probability - (p.outcome ? 1 : 0)) ** 2, 0);
  return sum / usable.length;
}

/**
 * Score de compétence : progression relative face à la climatologie.
 * Positif = mieux que le prédicteur trivial, négatif = moins bien.
 */
export function skillScore(brier, referenceBrier) {
  if (brier == null || !referenceBrier) return null;
  return 1 - brier / referenceBrier;
}

/** Justesse au-dessus d'un seuil de décision configurable. */
export function accuracy(predictions = [], decisionThreshold = 0.5) {
  const usable = predictions.filter(p => p.probability != null);
  if (!usable.length) return null;
  const ok = usable.filter(p => (p.probability >= decisionThreshold) === !!p.outcome).length;
  return { rate: ok / usable.length, correct: ok, total: usable.length, decisionThreshold };
}

/**
 * Calibration : parmi les pilotes annoncés entre 70 et 80 %, combien se sont
 * réellement qualifiés ? Un modèle calibré colle la diagonale.
 */
export function calibrationBins(predictions = [], binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: i / binCount, to: (i + 1) / binCount,
    label: `${Math.round(100 * i / binCount)}–${Math.round(100 * (i + 1) / binCount)} %`,
    n: 0, observed: 0, predictedSum: 0,
  }));
  for (const p of predictions) {
    if (p.probability == null) continue;
    const idx = Math.min(binCount - 1, Math.floor(p.probability * binCount));
    bins[idx].n++;
    bins[idx].predictedSum += p.probability;
    if (p.outcome) bins[idx].observed++;
  }
  return bins.map(b => ({
    ...b,
    observedRate: b.n ? b.observed / b.n : null,
    meanPredicted: b.n ? b.predictedSum / b.n : null,
    gap: b.n ? (b.observed / b.n) - (b.predictedSum / b.n) : null,
  }));
}

/** Toutes les mesures d'un prédicteur, d'un coup. */
export function evaluate(predictions, referenceBrier, decisionThreshold) {
  const brier = brierScore(predictions);
  return {
    n: predictions.filter(p => p.probability != null).length,
    coverage: predictions.length ? predictions.filter(p => p.probability != null).length / predictions.length : 0,
    brier,
    skill: skillScore(brier, referenceBrier),
    accuracy: accuracy(predictions, decisionThreshold),
    calibration: calibrationBins(predictions),
  };
}

// ─────────────────────────────────────────────────────────
// BACKTEST
// ─────────────────────────────────────────────────────────

/**
 * Rejoue chaque meeting historique depuis un checkpoint et compare les
 * prédicteurs à la réalité.
 *
 * @param {object} params
 * @param {Array}  params.contexts
 * @param {Array}  params.observations — historique du LOT 1 (déjà construit)
 * @param {object} [params.championshipsById]
 * @param {number} [params.checkpoint=3]
 * @param {string} [params.leakageMode='leaveOneMeetingOut']
 * @param {number} [params.simulations]
 * @param {number} [params.seed]
 * @param {number} [params.decisionThreshold=0.5]
 * @param {string} [params.entrantsSource='checkpoint'] — voir scenarioSimulator
 * @param {Function} [params.onProgress] — (done, total) pour l'interface
 * @returns {object}
 */
export function runBacktest({
  contexts = [], observations = [], championshipsById = {},
  checkpoint = 3, leakageMode = 'leaveOneMeetingOut',
  simulations = SIMULATION.backtestSimulations,
  seed = SIMULATION.defaultSeed,
  decisionThreshold = 0.5,
  entrantsSource = 'checkpoint',
  onProgress = null,
} = {}) {
  const usableHistory = filterObservations(observations);
  const globalRate = usableHistory.length
    ? usableHistory.filter(o => o.final.qualifiedByRule).length / usableHistory.length
    : null;

  // Meetings exploitables : complets, non triviaux, et disposant du checkpoint.
  const targets = [];
  for (const ctx of contexts) {
    if (!ctx?.isComplete || !ctx.lastCompletedRace) continue;
    if (ctx.lastCompletedRace <= checkpoint) continue;
    const th = resolveQualificationThreshold({
      regulation: ctx.regulation,
      observedPhaseCounts: ctx.observedPhaseCounts,
      engagedCount: ctx.engagedCount,
    });
    if (th.threshold == null) continue;
    if (isTrivialQualification(ctx.engagedCount, th.threshold)) continue;
    targets.push({ ctx, threshold: th.threshold, thresholdSource: th.source });
  }

  const predictions = [];
  let fallbackUsed = 0;
  let done = 0;

  for (const { ctx, threshold } of targets) {
    const state = buildStateAfterRace(ctx, checkpoint);
    const finalState = buildStateAfterRace(ctx, ctx.lastCompletedRace);
    const finalById = new Map(finalState.standings.map(d => [d.driverId, d]));

    // ── Modèle de performance, sans fuite ──
    const modelObservations = collectRaceObservations(contexts).filter(o => {
      // Jamais les manches postérieures au checkpoint DU MEETING analysé.
      if (o.meetingId === ctx.meetingId) return o.raceNum <= checkpoint;
      if (leakageMode === 'strictlyPrior') {
        return String(o.date || '') < String(ctx.meeting?.date || '');
      }
      return true;
    });

    const { models } = buildDriverModels({
      driverIds: state.standings.map(d => d.driverId),
      observations: modelObservations,
      scope: {
        meetingId: ctx.meetingId, year: ctx.meeting?.year,
        category: ctx.category, circuit: ctx.meeting?.location,
      },
    });

    const run = simulateFromCheckpoint({
      context: ctx, checkpoint, models, threshold,
      simulations, seed, trackAllDrivers: true, entrantsSource,
    });

    // ── Historique, meeting analysé exclu ──
    const history = usableHistory.filter(o => {
      if (o.meetingId === ctx.meetingId) return false;
      if (leakageMode === 'strictlyPrior') {
        return String(o.meetingDate || '') < String(ctx.meeting?.date || '');
      }
      return true;
    });

    for (const d of state.standings) {
      const outcomeRow = finalById.get(d.driverId);
      if (!outcomeRow) continue;
      const outcome = outcomeRow.position != null && outcomeRow.position <= threshold;
      const gap = gapToThreshold(d.position, threshold);

      const comparable = selectComparables(history, {
        checkpoint, gap,
        championshipId: ctx.meeting?.championshipId,
        category: ctx.category,
      });
      let historical = comparable.cases.length
        ? comparable.cases.filter(o => o.final.qualifiedByRule).length / comparable.cases.length
        : null;
      if (historical == null) { historical = globalRate; fallbackUsed++; }

      predictions.push({
        meetingId: ctx.meetingId,
        meetingLabel: ctx.meeting?.location || ctx.meetingId,
        meetingDate: ctx.meeting?.date || null,
        category: ctx.category,
        championshipId: ctx.meeting?.championshipId || null,
        championshipName: championshipsById[ctx.meeting?.championshipId]?.name || null,
        driverId: d.driverId,
        carNumber: d.carNumber, firstName: d.firstName, lastName: d.lastName,
        position: d.position, points: d.totalPoints, gap, threshold,
        outcome,
        historical,
        historicalCases: comparable.cases.length,
        monteCarlo: run.allProbabilities?.[d.driverId] ?? null,
        climatology: globalRate,
      });
    }

    done++;
    if (onProgress) onProgress(done, targets.length);
  }

  // Combien de groupes ont un seuil qui ne se deduit pas du seul reglement :
  // c'est la mesure du residu discute en tete de fichier.
  const thresholdDivergences = targets.filter(t => {
    const reg = thresholdFromRegulation(t.ctx.regulation);
    return reg.threshold !== t.threshold;
  }).length;

  return summarise({
    predictions, checkpoint, leakageMode, simulations, seed,
    decisionThreshold, globalRate, fallbackUsed, groups: targets.length,
    entrantsSource, thresholdDivergences,
  });
}

function summarise(r) {
  const asPred = (key) => r.predictions.map(p => ({ probability: p[key], outcome: p.outcome }));

  const climatology = evaluate(asPred('climatology'), null, r.decisionThreshold);
  const reference = climatology.brier;
  const historical = evaluate(asPred('historical'), reference, r.decisionThreshold);
  const monteCarlo = evaluate(asPred('monteCarlo'), reference, r.decisionThreshold);

  // Découpage par écart au seuil : c'est là que se joue l'utilité réelle. Un
  // modèle peut avoir un bon Brier global juste en étant sûr de lui loin du
  // seuil, là où tout le monde a raison.
  const byGap = groupBy(r.predictions, p => clampGap(p.gap))
    .map(([gap, rows]) => ({
      gap,
      n: rows.length,
      observedRate: rows.filter(x => x.outcome).length / rows.length,
      historical: brierScore(rows.map(p => ({ probability: p.historical, outcome: p.outcome }))),
      monteCarlo: brierScore(rows.map(p => ({ probability: p.monteCarlo, outcome: p.outcome }))),
    }))
    .sort((a, b) => a.gap - b.gap);

  const byCategory = groupBy(r.predictions, p => `${p.championshipName || '?'} / ${p.category}`)
    .map(([key, rows]) => ({
      key, n: rows.length,
      observedRate: rows.filter(x => x.outcome).length / rows.length,
      historical: brierScore(rows.map(p => ({ probability: p.historical, outcome: p.outcome }))),
      monteCarlo: brierScore(rows.map(p => ({ probability: p.monteCarlo, outcome: p.outcome }))),
    }))
    .sort((a, b) => b.n - a.n);

  const verdict = compareVerdict(historical.brier, monteCarlo.brier);

  return {
    checkpoint: r.checkpoint,
    leakageMode: r.leakageMode,
    entrantsSource: r.entrantsSource,
    thresholdDivergences: r.thresholdDivergences,
    simulations: r.simulations,
    seed: r.seed,
    decisionThreshold: r.decisionThreshold,
    groups: r.groups,
    cases: r.predictions.length,
    baseRate: r.globalRate,
    historicalFallbacks: r.fallbackUsed,
    climatology, historical, monteCarlo,
    byGap, byCategory,
    verdict,
    predictions: r.predictions,
  };
}

/**
 * Conclusion explicite, y compris quand elle est défavorable au Monte-Carlo.
 * Le seuil d'indécision évite de proclamer un vainqueur sur un écart de Brier
 * qui tient dans le bruit.
 */
export function compareVerdict(historicalBrier, monteCarloBrier, tolerance = 0.005) {
  if (historicalBrier == null || monteCarloBrier == null) {
    return { winner: 'unknown', label: 'Comparaison impossible : un des deux prédicteurs n\'a pas produit assez de valeurs.' };
  }
  const delta = historicalBrier - monteCarloBrier;
  if (Math.abs(delta) < tolerance) {
    return {
      winner: 'tie', delta,
      label: 'Écart de Brier score non significatif : le Monte-Carlo ne fait pas mieux que la table historique. '
           + 'L\'historique reste l\'estimateur principal ; le Monte-Carlo garde son utilité comme moteur de scénarios « et si ».',
    };
  }
  if (delta > 0) {
    return {
      winner: 'monteCarlo', delta,
      label: `Le Monte-Carlo améliore le Brier score de ${delta.toFixed(4)}.`,
    };
  }
  return {
    winner: 'historical', delta,
    label: `Le Monte-Carlo DÉGRADE le Brier score de ${(-delta).toFixed(4)} : l'historique reste l'estimateur principal. `
         + 'Le Monte-Carlo n\'est conservé que pour les scénarios « et si ».',
  };
}

function clampGap(gap) {
  if (gap == null) return 0;
  return Math.min(HISTORY.gapRange.max, Math.max(HISTORY.gapRange.min, gap));
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()];
}
