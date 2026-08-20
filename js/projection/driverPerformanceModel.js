/* ═══════════════════════════════════════════════
   DRIVERPERFORMANCEMODEL.JS — Distribution de performance d'un pilote.

   Module PUR : ni Firestore, ni DOM.

   ── Le problème ────────────────────────────────────────────────────────────
   Une PLACE n'est pas une grandeur additionnable : être 5e sur 30 et 5e sur 8
   ne dit pas la même chose, et la moyenne de deux places n'a pas de sens.
   Le modèle travaille donc sur une « force » latente z, obtenue en convertissant
   le rang normalisé par la fonction probit :

       u = (place - 0,5) / engagés          (correction de continuité)
       z = Φ⁻¹(u)

   z vaut 0 pour le milieu de plateau, est négatif devant, positif derrière, et
   reste comparable d'une manche à l'autre quelle que soit la taille du plateau.

   ── Le modèle ──────────────────────────────────────────────────────────────
   Pour chaque pilote on estime :
     • μ  — sa force moyenne ;
     • σ  — sa variabilité d'une manche à l'autre, incertitude sur μ comprise ;
     • p  — sa probabilité d'incident (DNF / DNS / DSQ).

   Une manche simulée tire z ~ Normale(μ, σ) ; le classement est l'ordre des z.

   ── Pourquoi de la contraction (shrinkage) ─────────────────────────────────
   Avec 8 meetings d'historique, un pilote peut n'avoir que trois manches. Une
   moyenne brute sur trois observations produirait des distributions bien trop
   confiantes, et un Monte-Carlo trop confiant donne des probabilités qui
   paraissent précises et se trompent. On applique donc une contraction
   bayésienne standard vers la moyenne du plateau :

       μ = μ_observé × nEff / (nEff + priorStrength)

   Un pilote très observé garde sa moyenne ; un pilote peu observé est ramené
   vers le milieu de plateau. La même logique s'applique à σ et au taux
   d'incident. Toutes les constantes vivent dans projectionConfig, pour être
   recalibrées au backtesting plutôt que devinées une fois pour toutes.

   ── Priorité des sources ───────────────────────────────────────────────────
   Meeting en cours > saison en cours > même circuit > historique général.
   Les poids ne sont pas appliqués tels quels : chaque source pèse
   `poids × nombre d'observations`, pour qu'une source prioritaire mais vide ne
   prenne pas le pas sur une source secondaire fournie.
═══════════════════════════════════════════════ */

import { normalQuantile } from './monteCarloEngine.js';
import { PERFORMANCE_SOURCE_WEIGHTS, PERFORMANCE_MODEL } from './projectionConfig.js';

/** Ordre de priorité des sources, du plus spécifique au plus général. */
export const SOURCE_IDS = ['currentMeeting', 'currentSeason', 'sameCircuit', 'overall'];

export const SOURCE_LABELS = {
  currentMeeting: 'manches déjà courues de ce meeting',
  currentSeason:  'saison en cours, même catégorie',
  sameCircuit:    'ce circuit, autres meetings',
  overall:        'historique général du pilote',
};

// ─────────────────────────────────────────────────────────
// OBSERVATIONS
// ─────────────────────────────────────────────────────────

/**
 * Force latente d'un résultat de manche.
 *
 * @param {number} position — place au classement de la manche
 * @param {number} engagedCount
 * @returns {number|null} null si la place n'est pas exploitable
 */
export function latentFromPosition(position, engagedCount) {
  if (!position || !engagedCount || engagedCount < 2) return null;
  const u = (position - 0.5) / engagedCount;
  if (!(u > 0) || !(u < 1)) return null;
  return normalQuantile(u);
}

/**
 * Extrait les observations de manche exploitables d'une liste de contextes.
 *
 * @param {Array} contexts — sorties de buildMeetingContext()
 * @param {object} [options]
 * @param {string} [options.excludeMeetingId] — meeting à retirer entièrement
 * @param {string} [options.beforeDate] — ne garder que les meetings antérieurs
 * @param {number} [options.maxRaceNum] — ne garder que les manches <= N
 * @returns {Array} observations
 */
export function collectRaceObservations(contexts = [], options = {}) {
  const { excludeMeetingId, beforeDate, maxRaceNum } = options;
  const out = [];

  for (const ctx of contexts) {
    if (!ctx?.races?.length) continue;
    if (excludeMeetingId && ctx.meetingId === excludeMeetingId) continue;
    const meeting = ctx.meeting || {};
    if (beforeDate && !(String(meeting.date || '') < String(beforeDate))) continue;

    for (const race of ctx.races) {
      if (!race.hasResults) continue;
      if (maxRaceNum != null && race.num > maxRaceNum) continue;
      for (const row of race.rows) {
        // Une manche non courue par le pilote (ni chrono ni statut) n'apprend
        // rien : ni sur son rythme, ni sur son risque d'incident.
        if (row.points == null) continue;
        out.push({
          driverId: row.driverId,
          raceNum: race.num,
          meetingId: ctx.meetingId,
          category: ctx.category,
          championshipId: meeting.championshipId || null,
          year: meeting.year ?? null,
          circuit: meeting.location || null,
          date: meeting.date || null,
          engagedCount: race.engagedCount,
          status: row.status || null,
          position: row.status ? null : row.position,
          latent: row.status ? null : latentFromPosition(row.position, race.engagedCount),
        });
      }
    }
  }
  return out;
}

/**
 * Classe une observation dans une source, relativement à un contexte d'analyse.
 * Une observation appartient à la source la PLUS spécifique qui la contient.
 */
export function sourceOf(observation, scope = {}) {
  if (scope.meetingId && observation.meetingId === scope.meetingId) return 'currentMeeting';
  if (scope.year != null && observation.year === scope.year
      && (!scope.category || observation.category === scope.category)) return 'currentSeason';
  if (scope.circuit && observation.circuit === scope.circuit) return 'sameCircuit';
  return 'overall';
}

// ─────────────────────────────────────────────────────────
// MODÈLE
// ─────────────────────────────────────────────────────────

/**
 * Construit le modèle de performance de chaque pilote.
 *
 * @param {object} params
 * @param {string[]} params.driverIds — pilotes à modéliser
 * @param {Array}  params.observations — sortie de collectRaceObservations()
 * @param {object} params.scope — { meetingId, year, category, circuit }
 * @param {object} [params.weights] — surcharge de PERFORMANCE_SOURCE_WEIGHTS
 * @param {object} [params.config]  — surcharge de PERFORMANCE_MODEL
 * @returns {{ models: object, pooled: object }}
 */
export function buildDriverModels({ driverIds = [], observations = [], scope = {}, weights, config } = {}) {
  const W = { ...PERFORMANCE_SOURCE_WEIGHTS, ...(weights || {}) };
  const C = { ...PERFORMANCE_MODEL, ...(config || {}) };
  const maxWeight = Math.max(...SOURCE_IDS.map(id => W[id] || 0)) || 1;

  // Indexation par pilote, une seule passe.
  const byDriver = new Map();
  for (const o of observations) {
    if (!byDriver.has(o.driverId)) byDriver.set(o.driverId, []);
    byDriver.get(o.driverId).push(o);
  }

  // Références de plateau : dispersion et taux d'incident observés sur
  // l'ensemble du matériau disponible. Servent de prior pour les pilotes peu
  // observés — le prior n'est donc pas une constante inventée.
  const pooled = pooledReferences(observations, C);

  const models = {};
  for (const driverId of driverIds) {
    models[driverId] = buildOne(driverId, byDriver.get(driverId) || [], scope, W, C, pooled, maxWeight);
  }
  return { models, pooled };
}

function pooledReferences(observations, C) {
  // Dispersion intra-pilote : moyenne des variances individuelles, calculée
  // seulement sur les pilotes ayant au moins deux manches classées.
  const byDriver = new Map();
  let incidents = 0, total = 0;
  for (const o of observations) {
    total++;
    if (o.status) { incidents++; continue; }
    if (o.latent == null) continue;
    if (!byDriver.has(o.driverId)) byDriver.set(o.driverId, []);
    byDriver.get(o.driverId).push(o.latent);
  }

  let varSum = 0, varCount = 0;
  for (const zs of byDriver.values()) {
    if (zs.length < 2) continue;
    const m = zs.reduce((s, z) => s + z, 0) / zs.length;
    const v = zs.reduce((s, z) => s + (z - m) * (z - m), 0) / (zs.length - 1);
    varSum += v; varCount++;
  }

  const dispersion = varCount
    ? clamp(Math.sqrt(varSum / varCount), C.minSigma, C.maxSigma)
    : C.defaultDispersion;
  const incidentRate = total ? incidents / total : C.defaultIncidentRate;

  return { dispersion, incidentRate, drivers: byDriver.size, observations: total, incidents };
}

function buildOne(driverId, obs, scope, W, C, pooled, maxWeight) {
  const bySource = {};
  for (const id of SOURCE_IDS) bySource[id] = { id, label: SOURCE_LABELS[id], latents: [], races: 0, incidents: 0 };

  for (const o of obs) {
    const bucket = bySource[sourceOf(o, scope)];
    bucket.races++;
    if (o.status) bucket.incidents++;
    else if (o.latent != null) bucket.latents.push(o.latent);
  }

  // Moyenne pondérée : poids de source × nombre d'observations de la source.
  let weightSum = 0, weighted = 0;
  const sources = [];
  for (const id of SOURCE_IDS) {
    const b = bySource[id];
    const n = b.latents.length;
    const mean = n ? b.latents.reduce((s, z) => s + z, 0) / n : null;
    const weight = (W[id] || 0) * n;
    if (weight > 0) { weightSum += weight; weighted += weight * mean; }
    sources.push({ id: b.id, label: b.label, races: b.races, classified: n, incidents: b.incidents, mean, weight });
  }

  const observedMean = weightSum ? weighted / weightSum : 0;
  // Effectif efficace, exprimé en « manches du meeting en cours » : une manche
  // de l'historique général compte moins qu'une manche de ce meeting-ci.
  const nEff = weightSum / maxWeight;
  const shrink = nEff / (nEff + C.priorStrength);
  const mu = observedMean * shrink;

  // Dispersion propre au pilote, contractée vers la dispersion de plateau.
  const allLatents = SOURCE_IDS.flatMap(id => bySource[id].latents);
  const nz = allLatents.length;
  let ownVar = null;
  if (nz >= 2) {
    const m = allLatents.reduce((s, z) => s + z, 0) / nz;
    ownVar = allLatents.reduce((s, z) => s + (z - m) * (z - m), 0) / (nz - 1);
  }
  const k = C.dispersionPrior;
  const blendedVar = ownVar != null
    ? (nz * ownVar + k * pooled.dispersion * pooled.dispersion) / (nz + k)
    : pooled.dispersion * pooled.dispersion;

  // L'incertitude sur μ s'ajoute à la variance de tirage : c'est elle qui
  // empêche un pilote vu deux fois de recevoir une distribution étroite.
  const muVar = (pooled.dispersion * pooled.dispersion) / (nEff + C.priorStrength);
  const sigma = clamp(Math.sqrt(blendedVar + muVar), C.minSigma, C.maxSigma);

  // Taux d'incident, contracté vers le taux de plateau.
  const races = SOURCE_IDS.reduce((s, id) => s + bySource[id].races, 0);
  const incidents = SOURCE_IDS.reduce((s, id) => s + bySource[id].incidents, 0);
  const a = C.incidentPrior;
  const incidentRate = clamp(
    (incidents + a * pooled.incidentRate) / (races + a),
    C.minIncidentRate, C.maxIncidentRate,
  );

  return {
    driverId,
    mu, sigma, incidentRate,
    observedMean, nEff, shrink,
    races, classified: nz, incidents,
    sources: sources.filter(s => s.races > 0),
    /** Vrai quand le modèle repose surtout sur le prior plutôt que sur le pilote. */
    weaklyObserved: nEff < C.priorStrength,
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Résumé lisible d'un modèle, pour le panneau « Pourquoi ? ».
 * Décrit des observations, jamais une intention de pilotage.
 */
export function describeModel(model) {
  if (!model) return [];
  const out = [
    ['Manches observées', `${model.races} (dont ${model.classified} classées)`],
    ['Force estimée', `${model.mu >= 0 ? '+' : ''}${model.mu.toFixed(2)} (0 = milieu de plateau)`],
    ['Dispersion', model.sigma.toFixed(2)],
    ['Taux d\'incident retenu', `${(100 * model.incidentRate).toFixed(1)} %`],
    ['Contraction vers le plateau', `${Math.round(100 * (1 - model.shrink))} %`],
  ];
  for (const s of model.sources) {
    out.push([s.label, `${s.races} manche${s.races > 1 ? 's' : ''}${s.mean != null ? ` · force moyenne ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(2)}` : ''}`]);
  }
  return out;
}
