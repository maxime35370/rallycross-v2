/* ═══════════════════════════════════════════════
   STRATEGYTARGETCALCULATOR.JS — Résultat cible et rendement décroissant.

   Module PUR : ni Firestore, ni DOM.

   ── La règle du « résultat cible », énoncée précisément ────────────────────
   Soit P(k) la probabilité de qualification finale quand on impose la place k
   au pilote sur la manche analysée, les autres pilotes restant simulés.

   Le gain marginal MOYEN d'une amélioration de la place k jusqu'à la victoire :

       G(k) = ( P(1) − P(k) ) / (k − 1)          pour k ≥ 2

   soit le nombre de points de pourcentage gagnés PAR PLACE si le pilote passait
   de la place k à la première.

   Le résultat cible est alors :

       T = max { k ≥ 1 : pour tout j de 2 à k, G(j) < τ }

   c'est-à-dire la place la PLUS BASSE telle que, depuis cette place et depuis
   toutes les places meilleures, améliorer encore rapporte en moyenne moins de
   τ point de pourcentage par place. τ est `TARGET.diminishingReturnPctPerPosition`,
   configurable, valant 1,0 par défaut.

   Deux choix méritent d'être justifiés :

   • Pourquoi une moyenne depuis P(1) plutôt que le gain d'une seule place ?
     Parce qu'un gain place-à-place calculé sur un Monte-Carlo porte du bruit :
     deux places voisines peuvent s'inverser par hasard, et la cible sauterait
     d'une exécution à l'autre. La moyenne cumulée lisse ce bruit sans masquer
     une vraie rupture de pente. Les gains place-à-place restent exposés
     séparément, parce que c'est cette lecture-là que le team veut voir.

   • Pourquoi une condition sur TOUT le préfixe plutôt que sur le seul k ?
     Sans elle, un creux accidentel loin dans la courbe pourrait satisfaire la
     condition alors que la zone intermédiaire, elle, rapporte beaucoup. La
     condition de préfixe garantit que la cible est atteinte de façon continue.

   Le résultat est une PROJECTION STATISTIQUE, pas une consigne : la formulation
   produite décrit un gain estimé faible, jamais une conduite à tenir.
═══════════════════════════════════════════════ */

import { TARGET, CLASSIFICATION, MESSAGES } from './projectionConfig.js';

// ─────────────────────────────────────────────────────────
// GAINS MARGINAUX
// ─────────────────────────────────────────────────────────

/**
 * Gain de probabilité, en points de pourcentage, apporté par le gain d'UNE
 * place — de la place k à la place k−1.
 *
 * @param {Array} entries — sortie de whatIfResults().entries
 * @returns {Array<{ from, to, gainPct, probabilityFrom, probabilityTo }>}
 */
export function marginalGains(entries = []) {
  const byPosition = positionsOf(entries);
  const out = [];
  for (let i = 1; i < byPosition.length; i++) {
    const worse = byPosition[i];      // place la plus élevée (moins bonne)
    const better = byPosition[i - 1];
    if (worse.probability == null || better.probability == null) continue;
    out.push({
      from: worse.position,
      to: better.position,
      probabilityFrom: worse.probability,
      probabilityTo: better.probability,
      gainPct: 100 * (better.probability - worse.probability),
    });
  }
  return out.reverse();   // de la place la plus basse vers la meilleure
}

/** Entrées « position », triées par place croissante, probabilité connue. */
function positionsOf(entries = []) {
  return entries
    .filter(e => e.kind === 'position' && e.position != null && e.probability != null)
    .sort((a, b) => a.position - b.position);
}

// ─────────────────────────────────────────────────────────
// RÉSULTAT CIBLE
// ─────────────────────────────────────────────────────────

/**
 * Calcule le résultat cible selon la règle documentée en tête de fichier.
 *
 * @param {Array} entries — sortie de whatIfResults().entries
 * @param {object} [options]
 * @param {number} [options.thresholdPct] — τ, en points de pourcentage
 * @returns {object}
 */
export function computeTargetResult(entries = [], options = {}) {
  const tau = options.thresholdPct ?? TARGET.diminishingReturnPctPerPosition;
  const positions = positionsOf(entries);

  if (positions.length === 0) {
    return { target: null, targetLabel: null, thresholdPct: tau, averageGains: [], reason: 'aucun scénario exploitable' };
  }
  const best = positions[0];

  // G(j) pour chaque place, et recherche du plus long préfixe sous τ.
  const averageGains = positions.map(p => ({
    position: p.position,
    probability: p.probability,
    averageGainPct: p.position <= best.position
      ? null
      : 100 * (best.probability - p.probability) / (p.position - best.position),
  }));

  let target = best.position;
  for (let i = 1; i < averageGains.length; i++) {
    const g = averageGains[i];
    if (g.averageGainPct == null || g.averageGainPct >= tau) break;
    target = g.position;
  }

  const targetRow = averageGains.find(g => g.position === target) || averageGains[0];
  const worst = positions[positions.length - 1];

  // Trois régimes, parce que « au-delà de P30 » n'a pas de sens quand P30 est
  // la dernière place du plateau, et « au-delà de P1 » n'en a pas non plus.
  const regime = target >= worst.position ? 'flat'
    : target <= best.position ? 'sensitive'
    : 'normal';
  const statement = regime === 'flat' ? MESSAGES.targetFlat
    : regime === 'sensitive' ? MESSAGES.targetSensitive
    : MESSAGES.targetBeyond(`P${target}`);

  return {
    target,
    targetLabel: `P${target}`,
    regime,
    thresholdPct: tau,
    probabilityAtTarget: targetRow.probability,
    probabilityAtBest: best.probability,
    probabilityAtWorst: worst.probability,
    averageGainAtTarget: targetRow.averageGainPct,
    averageGains,
    /** Formulation descriptive, centralisée : jamais une consigne de course. */
    statement,
    rule: 'T = plus grande place k telle que, pour toute place j de 2 à k, '
        + `(P(1) − P(j)) / (j − 1) < ${tau} point de pourcentage par place`,
  };
}

// ─────────────────────────────────────────────────────────
// CLASSIFICATION STRATÉGIQUE
// ─────────────────────────────────────────────────────────

export const CLASSIFICATION_LABELS = {
  green:  { id: 'green',  label: 'VERT',   description: 'Qualification très probable, et le gain estimé d\'un meilleur résultat reste faible.' },
  orange: { id: 'orange', label: 'ORANGE', description: 'La qualification dépend du résultat de la manche restante ou de celui des adversaires.' },
  red:    { id: 'red',    label: 'ROUGE',  description: 'Un gros résultat augmente fortement la probabilité estimée de qualification.' },
};

/**
 * Classe la situation à partir de la probabilité courante et de la sensibilité
 * de cette probabilité au résultat de la manche restante.
 *
 * Aucun seuil n'est codé ici : tout vient de CLASSIFICATION, pour être
 * recalibré sans toucher au calcul.
 *
 * @param {object} params
 * @param {number} params.probability — probabilité sans résultat forcé
 * @param {object} [params.target] — sortie de computeTargetResult()
 * @param {object} [params.config]
 */
export function classifyStrategy({ probability, target, config } = {}) {
  const C = { ...CLASSIFICATION, ...(config || {}) };
  if (probability == null) {
    return { ...CLASSIFICATION_LABELS.orange, reason: 'probabilité indisponible' };
  }

  // Sensibilité : écart de probabilité entre le meilleur et le pire résultat
  // possible sur la manche restante. C'est ce qui distingue une situation
  // solide d'une situation qui tient à un seul résultat.
  const spreadPct = target?.averageGains?.length
    ? 100 * (target.probabilityAtBest - target.averageGains[target.averageGains.length - 1].probability)
    : null;

  if (probability >= C.green.minProbability
      && (target?.averageGainAtTarget == null || target.averageGainAtTarget <= C.green.maxMarginalGainPct)) {
    return {
      ...CLASSIFICATION_LABELS.green, probability, spreadPct,
      reason: `probabilité ≥ ${Math.round(100 * C.green.minProbability)} % et gain marginal moyen ≤ ${C.green.maxMarginalGainPct} pt/place`,
    };
  }
  if (probability >= C.orange.minProbability) {
    return {
      ...CLASSIFICATION_LABELS.orange, probability, spreadPct,
      reason: `probabilité comprise entre ${Math.round(100 * C.orange.minProbability)} % et ${Math.round(100 * C.green.minProbability)} %`,
    };
  }
  return {
    ...CLASSIFICATION_LABELS.red, probability, spreadPct,
    reason: `probabilité < ${Math.round(100 * C.orange.minProbability)} %`,
  };
}
