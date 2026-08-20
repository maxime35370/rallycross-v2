/* ═══════════════════════════════════════════════
   QUALIFICATIONHISTORY.JS — Statistiques historiques de qualification.

   Module PUR : ni Firestore, ni DOM.

   Répond à : « historiquement, un pilote dans cette situation après Q1, Q2 ou
   Q3 s'est-il qualifié après la dernière manche ? »

   Deux axes, et l'ordre entre les deux n'est pas cosmétique (ANALYSE.md §4.4) :

     • ÉCART DE RANG AU SEUIL — axe normalisé PRINCIPAL. Comparable entre
       catégories et championnats, monotone sur les données réelles.
     • POINTS ABSOLUS — axe secondaire, proposé uniquement quand le périmètre
       est homogène (championnat + catégorie fixés), avec tranches adaptatives
       et effectif affiché. Un barème « 44 - position » produit des points
       d'autant plus élevés que le plateau est grand : mélanger les catégories
       casse la monotonie de la courbe.

   Le module ne produit que des CONSTATS. Il n'interprète jamais l'intention
   d'un pilote et ne formule aucune consigne de course : les libellés vivent
   dans projectionConfig.MESSAGES et sont vérifiés par un test.
═══════════════════════════════════════════════ */

import {
  CONFIDENCE_LEVELS, MIN_CASES_TO_SHOW_RATE, HISTORY, RESULT_BUCKETS, MESSAGES,
} from './projectionConfig.js';
import {
  resolveQualificationThreshold, isQualifiedByRule, isTrivialQualification,
  gapToThreshold, compareQualificationLabels,
} from './qualificationRules.js';
import {
  buildStateAfterRace, actualNextPhaseDriverIds, raceResultOf,
} from './qualificationState.js';

// ─────────────────────────────────────────────────────────
// CONFIANCE
// ─────────────────────────────────────────────────────────

/**
 * Intervalle de Wilson à 95 %. Préféré à l'intervalle normal : il reste
 * valide sur les petits effectifs et sur les taux proches de 0 ou 100 %,
 * exactement les cas qu'on veut signaler ici.
 *
 * @param {number} successes
 * @param {number} n
 * @param {number} [z=1.96]
 * @returns {{ low: number, high: number, width: number }}
 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!n || n <= 0) return { low: 0, high: 1, width: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const low  = Math.max(0, (centre - margin) / denom);
  const high = Math.min(1, (centre + margin) / denom);
  return { low, high, width: high - low };
}

/**
 * Niveau de confiance d'un taux observé. Dépend du nombre de cas ET de leur
 * dispersion : un effectif suffisant mais un intervalle très large est
 * rétrogradé d'un cran, pour qu'un 80 % fragile ne se lise pas comme un
 * 80 % solide.
 *
 * @param {number} n
 * @param {number} successes
 * @returns {{ level, label, interval, showRate, messages: string[] }}
 */
export function confidenceFor(n, successes) {
  const interval = wilsonInterval(successes, n);
  let index = CONFIDENCE_LEVELS.findIndex(l => n >= l.minCases);
  if (index < 0) index = CONFIDENCE_LEVELS.length - 1;
  // Dispersion : rétrogradation d'un cran si l'intervalle dépasse la largeur
  // tolérée pour le niveau atteint.
  if (interval.width > CONFIDENCE_LEVELS[index].maxIntervalWidth
      && index < CONFIDENCE_LEVELS.length - 1) {
    index += 1;
  }
  const level = CONFIDENCE_LEVELS[index];
  const showRate = n >= MIN_CASES_TO_SHOW_RATE;

  const messages = [];
  if (n > 0 && n < MIN_CASES_TO_SHOW_RATE) messages.push(MESSAGES.fewCases(n));
  if (!showRate) messages.push(MESSAGES.insufficientSample);
  if (level.id === 'low' && showRate) messages.push(MESSAGES.lowConfidence);

  return { level: level.id, label: level.label, interval, showRate, messages, cases: n };
}

/** Bloc de statistiques standard, utilisé partout où l'on affiche un taux. */
export function rateStats(cases) {
  const n = cases.length;
  const qualified = cases.filter(c => c.final?.qualifiedByRule).length;
  return {
    n,
    qualified,
    rate: n ? qualified / n : null,
    confidence: confidenceFor(n, qualified),
  };
}

// ─────────────────────────────────────────────────────────
// OBSERVATIONS
// ─────────────────────────────────────────────────────────

/**
 * Transforme des contextes de meeting en observations pilote, une ligne par
 * pilote et par meeting × catégorie.
 *
 * @param {Array} contexts — sorties de buildMeetingContext()
 * @param {object} [options]
 * @param {object} [options.championshipsById]
 * @param {boolean} [options.requireComplete=true] — n'exploiter que les
 *        meetings dont toutes les manches prévues ont été courues
 * @returns {Array}
 */
export function buildObservations(contexts = [], options = {}) {
  const { championshipsById = {}, requireComplete = true } = options;
  const out = [];

  for (const ctx of contexts) {
    if (!ctx || !ctx.races?.length) continue;
    if (requireComplete && !ctx.isComplete) continue;
    if (!ctx.lastCompletedRace) continue;

    const finalRace = ctx.lastCompletedRace;
    const finalState = buildStateAfterRace(ctx, finalRace);
    if (!finalState.count) continue;

    const threshold = resolveQualificationThreshold({
      regulation: ctx.regulation,
      observedPhaseCounts: ctx.observedPhaseCounts,
      engagedCount: ctx.engagedCount,
    });

    const labels = compareQualificationLabels({
      standings: finalState.standings,
      threshold: threshold.threshold,
      actualDriverIds: actualNextPhaseDriverIds(ctx),
    });

    const trivial = isTrivialQualification(ctx.engagedCount, threshold.threshold);

    // États intermédiaires : un par manche courue avant la dernière.
    const states = {};
    for (const r of ctx.races) {
      if (!r.hasResults || r.num >= finalRace) continue;
      states[r.num] = buildStateAfterRace(ctx, r.num);
    }

    const meeting = ctx.meeting || {};
    const champ = championshipsById[meeting.championshipId] || null;

    for (const d of finalState.standings) {
      const checkpoints = {};
      for (const [num, st] of Object.entries(states)) {
        const row = st.byDriverId[d.driverId];
        if (!row) continue;
        checkpoints[num] = {
          points: row.totalPoints,
          position: row.position,
          gap: gapToThreshold(row.position, threshold.threshold),
        };
      }

      const raceResults = {};
      for (const r of ctx.races) {
        const res = raceResultOf(ctx, r.num, d.driverId);
        if (res) raceResults[r.num] = res;
      }

      out.push({
        key: ctx.key,
        meetingId: ctx.meetingId,
        meetingDate: meeting.date || null,
        meetingLabel: meeting.location || ctx.meetingId,
        circuit: meeting.location || null,
        year: meeting.year ?? null,
        championshipId: meeting.championshipId || null,
        championshipName: champ?.name || null,
        category: ctx.category,

        driverId: d.driverId,
        carNumber: d.carNumber,
        firstName: d.firstName,
        lastName: d.lastName,

        engagedCount: ctx.engagedCount,
        threshold: threshold.threshold,
        thresholdSource: threshold.source,
        thresholdLabel: threshold.label,
        trivial,

        finalRace,
        checkpoints,
        raceResults,
        final: {
          points: d.totalPoints,
          position: d.position,
          gap: gapToThreshold(d.position, threshold.threshold),
          qualifiedByRule: isQualifiedByRule(d.position, threshold.threshold),
          qualifiedActual: labels.byDriverId[d.driverId]?.qualifiedActual ?? null,
        },
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// FILTRES
// ─────────────────────────────────────────────────────────

/**
 * @param {Array} observations
 * @param {object} [f]
 * @param {boolean} [f.includeTrivial=false] — les cas « engagés <= seuil »
 *        sont exclus par défaut : ils sont qualifiés mécaniquement et
 *        gonfleraient tous les taux.
 * @param {number} [f.checkpoint] — n'garder que les observations qui ont un
 *        état reconstruit à ce checkpoint
 */
export function filterObservations(observations = [], f = {}) {
  const includeTrivial = f.includeTrivial ?? !HISTORY.excludeTrivialByDefault;
  return observations.filter(o => {
    if (!includeTrivial && o.trivial) return false;
    if (f.championshipId && o.championshipId !== f.championshipId) return false;
    if (f.category && o.category !== f.category) return false;
    if (f.year && Number(o.year) !== Number(f.year)) return false;
    if (f.circuit && o.circuit !== f.circuit) return false;
    if (f.meetingId && o.meetingId !== f.meetingId) return false;
    if (f.checkpoint && o.checkpoints?.[f.checkpoint] == null) return false;
    return true;
  });
}

/** Valeurs distinctes d'un champ, triées, pour alimenter les sélecteurs. */
export function distinctValues(observations = [], field) {
  return [...new Set(observations.map(o => o[field]).filter(v => v != null))]
    .sort((a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true }));
}

// ─────────────────────────────────────────────────────────
// AXE PRINCIPAL — ÉCART DE RANG AU SEUIL
// ─────────────────────────────────────────────────────────

/**
 * Taux de qualification finale par écart de rang au seuil, à un checkpoint
 * donné. Négatif = dans la zone qualificative, 0 = sur la bulle.
 *
 * @param {Array} observations — déjà filtrées
 * @param {number} checkpoint  — 1, 2, 3…
 * @param {object} [options]
 * @returns {{ rows: Array, total: number, checkpoint: number }}
 */
export function aggregateByGap(observations = [], checkpoint, options = {}) {
  const range = options.gapRange || HISTORY.gapRange;
  const groups = new Map();

  for (const o of observations) {
    const cp = o.checkpoints?.[checkpoint];
    if (!cp || cp.gap == null) continue;
    const gap = Math.min(range.max, Math.max(range.min, cp.gap));
    if (!groups.has(gap)) groups.set(gap, []);
    groups.get(gap).push(o);
  }

  const rows = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gap, cases]) => {
      // Les ecarts extremes sont regroupes dans les tranches de bord : il faut
      // le dire, sinon « -10 places » se lit comme un ecart exact alors qu'il
      // agrege tout ce qui est au-dela.
      const clamped = cases.some(c => c.checkpoints[checkpoint].gap !== gap);
      return {
        gap,
        label: clamped ? `${formatGap(gap)} ${gap < 0 ? 'ou mieux' : 'ou plus'}` : formatGap(gap),
        clamped,
        cases,
        ...rateStats(cases),
      };
    });

  return { rows, total: rows.reduce((n, r) => n + r.n, 0), checkpoint };
}

/** « -2 places », « au seuil », « +1 place ». */
export function formatGap(gap) {
  if (gap === 0) return 'au seuil';
  if (gap < 0)  return `${gap} place${gap <= -2 ? 's' : ''}`;
  return `+${gap} place${gap >= 2 ? 's' : ''}`;
}

// ─────────────────────────────────────────────────────────
// AXE SECONDAIRE — POINTS ABSOLUS, TRANCHES ADAPTATIVES
// ─────────────────────────────────────────────────────────

/**
 * Découpe adaptative d'une série de valeurs.
 *
 * Part de bacs de `minWidth` et fusionne les voisins tant que l'effectif reste
 * sous `targetCases`, sans dépasser `maxWidth`. On ne force donc jamais des
 * tranches de 5 points quand l'échantillon ne les supporte pas, et on ne crée
 * pas non plus de tranche absurdement large pour sauver les apparences.
 *
 * @param {number[]} values
 * @param {object} [opts] — { targetCases, minWidth, maxWidth }
 * @returns {Array<{min:number,max:number,count:number,width:number}>}
 *          `max` est exclusif, sauf pour la dernière tranche.
 */
export function adaptiveBuckets(values = [], opts = {}) {
  const { targetCases, minWidth, maxWidth } = { ...HISTORY.adaptiveBuckets, ...opts };
  const nums = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return [];

  const lo = Math.floor(nums[0] / minWidth) * minWidth;
  const hi = Math.floor(nums[nums.length - 1] / minWidth) * minWidth + minWidth;

  // Bacs élémentaires
  const bins = [];
  for (let e = lo; e < hi; e += minWidth) {
    bins.push({ min: e, max: e + minWidth, count: 0 });
  }
  for (const v of nums) {
    const i = Math.min(bins.length - 1, Math.floor((v - lo) / minWidth));
    bins[i].count++;
  }

  // Fusion gauche → droite
  const out = [];
  let i = 0;
  while (i < bins.length) {
    const cur = { min: bins[i].min, max: bins[i].max, count: bins[i].count };
    i++;
    while (cur.count < targetCases && i < bins.length
           && (bins[i].max - cur.min) <= maxWidth) {
      cur.max = bins[i].max;
      cur.count += bins[i].count;
      i++;
    }
    out.push(cur);
  }

  // Une tranche finale trop maigre est rattachée à la précédente si la largeur
  // le permet ; sinon elle est conservée telle quelle et son effectif parlera
  // de lui-même via le niveau de confiance.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.count < targetCases && (last.max - prev.min) <= maxWidth) {
      prev.max = last.max;
      prev.count += last.count;
      out.pop();
    }
  }

  return out.map(b => ({ ...b, width: b.max - b.min }));
}

/**
 * Taux de qualification par tranche de points à un checkpoint.
 *
 * `comparable` vaut false tant que le périmètre n'est pas homogène : dans ce
 * cas la vue reste calculée mais doit être présentée avec l'avertissement,
 * parce que le barème rend les points non comparables entre catégories.
 *
 * @param {Array} observations
 * @param {number} checkpoint
 * @param {object} [options] — { filters, bucketOptions }
 */
export function aggregateByPoints(observations = [], checkpoint, options = {}) {
  const filters = options.filters || {};
  const missing = HISTORY.pointsAxisRequiresFixed.filter(k => !filters[k]);
  const comparable = missing.length === 0;

  const cases = observations.filter(o => o.checkpoints?.[checkpoint]?.points != null);
  const buckets = adaptiveBuckets(
    cases.map(o => o.checkpoints[checkpoint].points),
    options.bucketOptions,
  );

  const rows = buckets.map((b, i) => {
    const isLast = i === buckets.length - 1;
    const inBucket = cases.filter(o => {
      const p = o.checkpoints[checkpoint].points;
      return p >= b.min && (isLast ? p <= b.max : p < b.max);
    });
    return {
      min: b.min,
      max: b.max,
      width: b.width,
      label: `${b.min}-${isLast ? b.max : b.max - 1} pts`,
      cases: inBucket,
      ...rateStats(inBucket),
    };
  });

  return {
    rows,
    total: cases.length,
    checkpoint,
    comparable,
    missingFilters: missing,
    warning: comparable ? null
      : 'Les points ne sont pas comparables entre catégories : le barème dépend de la taille du plateau. Fixez le championnat et la catégorie pour lire cette vue.',
  };
}

// ─────────────────────────────────────────────────────────
// RÉSULTATS D'UNE MANCHE
// ─────────────────────────────────────────────────────────

/** Regroupe un résultat de manche : le statut prime toujours sur la position. */
export function resultBucketOf(result) {
  if (!result) return null;
  if (result.status) return RESULT_BUCKETS.find(b => b.status) || null;
  if (result.position == null) return null;
  return RESULT_BUCKETS.find(b => !b.status && result.position >= b.min && result.position <= b.max) || null;
}

/**
 * Distribution des résultats obtenus sur une manche par un groupe
 * d'observations — sans aucune interprétation de ce que ces résultats
 * signifieraient sur l'attitude des pilotes.
 */
export function resultDistribution(observations = [], raceNum) {
  const results = observations
    .map(o => o.raceResults?.[raceNum])
    .filter(Boolean);

  const byBucket = RESULT_BUCKETS.map(b => {
    const cases = results.filter(r => resultBucketOf(r)?.id === b.id);
    return { id: b.id, label: b.label, n: cases.length, share: results.length ? cases.length / results.length : 0 };
  });

  const positions = results.map(r => r.position).filter(p => p != null).sort((a, b) => a - b);
  const mid = positions.length ? positions[Math.floor(positions.length / 2)] : null;
  const mean = positions.length ? positions.reduce((s, p) => s + p, 0) / positions.length : null;

  const byPosition = [];
  for (const p of new Set(positions)) {
    byPosition.push({ position: p, n: positions.filter(x => x === p).length });
  }
  byPosition.sort((a, b) => a.position - b.position);

  return {
    raceNum,
    total: results.length,
    classified: positions.length,
    withStatus: results.length - positions.length,
    median: mid,
    mean,
    byBucket,
    byPosition,
  };
}

/**
 * Taux de qualification finale CONDITIONNEL au résultat obtenu sur une manche.
 * C'est la lecture « qu'ont fait les pilotes comparables, et que leur est-il
 * arrivé ensuite ? » — un constat, rien de plus.
 */
export function conditionalQualificationByResult(observations = [], raceNum) {
  return RESULT_BUCKETS.map(b => {
    const cases = observations.filter(o => resultBucketOf(o.raceResults?.[raceNum])?.id === b.id);
    return { id: b.id, label: b.label, ...rateStats(cases) };
  });
}

// ─────────────────────────────────────────────────────────
// CAS COMPARABLES
// ─────────────────────────────────────────────────────────

/**
 * Sélectionne les cas historiques comparables à une situation donnée, en
 * élargissant progressivement le périmètre jusqu'à atteindre un effectif
 * exploitable. La stratégie retenue est renvoyée : l'utilisateur doit toujours
 * pouvoir savoir sur quoi le taux affiché a été calculé.
 *
 * @param {Array} observations
 * @param {object} params — { checkpoint, gap, championshipId, category }
 * @param {object} [options] — { minCases, strategies }
 * @returns {{ cases, strategy, label, widened, tried }}
 */
export function selectComparables(observations = [], params = {}, options = {}) {
  const { checkpoint, gap, championshipId, category } = params;
  const minCases = options.minCases ?? MIN_CASES_TO_SHOW_RATE;
  const strategies = options.strategies || HISTORY.comparableStrategies;
  const context = { championshipId, category };
  const tried = [];

  let fallback = null;
  for (const st of strategies) {
    const cases = observations.filter(o => {
      const cp = o.checkpoints?.[checkpoint];
      if (!cp || cp.gap == null || gap == null) return false;
      if (Math.abs(cp.gap - gap) > st.gapTolerance) return false;
      return st.match.every(k => o[k] === context[k]);
    });
    tried.push({ id: st.id, label: st.label, n: cases.length });
    if (fallback === null) fallback = { cases, strategy: st.id, label: st.label, widened: false, tried };
    if (cases.length >= minCases) {
      return { cases, strategy: st.id, label: st.label, widened: st.id !== strategies[0].id, tried };
    }
  }

  // Aucune stratégie n'atteint l'effectif minimal : on renvoie la plus large,
  // en l'annonçant comme telle plutôt qu'en masquant la faiblesse.
  const last = strategies[strategies.length - 1];
  const cases = observations.filter(o => {
    const cp = o.checkpoints?.[checkpoint];
    if (!cp || cp.gap == null || gap == null) return false;
    return Math.abs(cp.gap - gap) <= last.gapTolerance;
  });
  return { cases, strategy: last.id, label: last.label, widened: true, tried };
}

// ─────────────────────────────────────────────────────────
// LECTURE STRATÉGIQUE HISTORIQUE (sans Monte-Carlo)
// ─────────────────────────────────────────────────────────

/**
 * Synthèse historique pour un pilote en situation réelle, à n'importe quel
 * checkpoint. C'est la valeur stratégique du LOT 1 : elle ne simule rien, elle
 * ne fait que rapprocher la situation courante de situations mesurées.
 *
 * @param {object} params
 * @param {Array}  params.observations — historique déjà filtré des cas triviaux
 * @param {number} params.checkpoint
 * @param {object} params.driver — { points, position, gap }
 * @param {number} params.finalRace — numéro de la dernière manche du meeting
 * @param {object} [params.filters] — { championshipId, category, … }
 * @returns {object}
 */
export function buildHistoricalOutlook({
  observations = [], checkpoint, driver = {}, finalRace, filters = {},
} = {}) {
  const comparable = selectComparables(observations, {
    checkpoint,
    gap: driver.gap,
    championshipId: filters.championshipId,
    category: filters.category,
  });

  const stats = rateStats(comparable.cases);

  // Points : lecture proposée seulement si le périmètre est homogène.
  const pointsAgg = aggregateByPoints(
    filterObservations(observations, filters),
    checkpoint,
    { filters },
  );
  const pointsBucket = driver.points == null ? null
    : pointsAgg.rows.find((r, i) => {
        const isLast = i === pointsAgg.rows.length - 1;
        return driver.points >= r.min && (isLast ? driver.points <= r.max : driver.points < r.max);
      }) || null;

  // Manches restantes : ce qu'ont fait les cas comparables, et ce qui leur est
  // arrivé ensuite.
  const remaining = [];
  for (let n = checkpoint + 1; n <= (finalRace || 0); n++) {
    remaining.push({
      raceNum: n,
      distribution: resultDistribution(comparable.cases, n),
      conditional: conditionalQualificationByResult(comparable.cases, n),
    });
  }

  const messages = [...stats.confidence.messages];
  if (comparable.widened) {
    messages.push(`Périmètre élargi pour atteindre un effectif exploitable : ${comparable.label}.`);
  }
  if (stats.n > 0 && stats.confidence.showRate) {
    messages.push(MESSAGES.historicalObservation(stats.n, stats.qualified));
  }

  return {
    checkpoint,
    driver,
    comparable: { ...stats, strategy: comparable.strategy, label: comparable.label, widened: comparable.widened, tried: comparable.tried },
    pointsView: {
      available: pointsAgg.comparable && !!pointsBucket,
      warning: pointsAgg.warning,
      missingFilters: pointsAgg.missingFilters,
      bucket: pointsBucket ? {
        label: pointsBucket.label, n: pointsBucket.n, qualified: pointsBucket.qualified,
        rate: pointsBucket.rate, confidence: pointsBucket.confidence,
      } : null,
    },
    remaining,
    messages,
  };
}
