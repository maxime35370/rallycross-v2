/* ═══════════════════════════════════════════════
   QUALIFICATIONRULES.JS — Règles de qualification après les manches.

   Module PUR : ni Firestore, ni DOM.

   Répond à trois questions que l'application ne stocke nulle part :
     1. combien de places qualificatives y a-t-il réellement ?
     2. un pilote est-il qualifié au sens de la règle sportive ?
     3. le règlement du championnat est-il seulement supporté par le module ?

   Points établis par l'audit (docs/qualification-projection/ANALYSE.md) :
     • §4.2 — aucun document ne porte de flag « qualifié » : il est dérivé.
       La règle dérivée concorde à 98,4 % avec la présence réelle en phase
       suivante ; les écarts sont des forfaits remplacés par des suppléants.
       D'où DEUX labels distincts, jamais confondus.
     • §4.3 — le seuil ne se lit pas seulement dans le règlement : le déroulé
       réel peut sauter les QF, voire les DF (finale directe).
     • §4.5 — quand les engagés tiennent tous dans les places qualificatives,
       la qualification est mécanique et le cas ne dit rien.
     • §4.7 — worstResultDrop est déclaré mais non implémenté dans calc.js.
═══════════════════════════════════════════════ */

import { MESSAGES } from './projectionConfig.js';

/** Ordre des phases finales, de la plus précoce à la plus tardive. */
export const PHASE_ORDER = ['QF', 'DF', 'FIN'];

// ─────────────────────────────────────────────────────────
// SUPPORT DU RÈGLEMENT
// ─────────────────────────────────────────────────────────

/**
 * Vérifie que le règlement n'utilise aucune règle que le module ne sait pas
 * reproduire fidèlement. Mieux vaut refuser de projeter que produire une
 * probabilité fausse sans le dire.
 *
 * @param {object} [regulation]
 * @returns {{ supported: boolean, reasons: string[], message: string|null }}
 */
export function checkRegulationSupport(regulation) {
  const reasons = [];

  // calc.js somme TOUTES les manches sans jamais retirer la plus mauvaise.
  // Tant que worstResultDrop vaut 0 c'est sans effet ; au-delà, historique et
  // projection divergeraient silencieusement du classement affiché.
  const drop = Number(regulation?.worstResultDrop) || 0;
  if (drop > 0) {
    reasons.push(`worstResultDrop = ${drop} : le retrait du plus mauvais résultat n'est pas appliqué par le calcul des classements.`);
  }

  return {
    supported: reasons.length === 0,
    reasons,
    message: reasons.length ? MESSAGES.unsupportedRegulation : null,
  };
}

// ─────────────────────────────────────────────────────────
// SEUIL DE QUALIFICATION
// ─────────────────────────────────────────────────────────

/**
 * Nombre de places qualificatives prévu par le règlement, sans regarder ce qui
 * s'est réellement passé.
 *
 * @param {object} [regulation]
 * @returns {{ threshold: number|null, phase: string|null }}
 */
export function thresholdFromRegulation(regulation) {
  const sc = regulation?.sessionConfig || {};
  if (sc.QF?.enabled) {
    const n = (Number(sc.QF.count) || 0) * (Number(sc.QF.gridSize) || 0);
    if (n > 0) return { threshold: n, phase: 'QF' };
  }
  if (sc.DF) {
    const n = (Number(sc.DF.count) || 0) * (Number(sc.DF.gridSize) || 0);
    if (n > 0) return { threshold: n, phase: 'DF' };
  }
  if (sc.FIN?.gridSize) {
    const n = Number(sc.FIN.gridSize) || 0;
    if (n > 0) return { threshold: n, phase: 'FIN' };
  }
  return { threshold: null, phase: null };
}

/**
 * Seuil de qualification EFFECTIF.
 *
 * Ordre de résolution — l'observation prime, parce que le règlement décrit une
 * intention alors que le déroulé décrit ce qui a réellement départagé les
 * pilotes (Euro RX RX3/RX5 : QF vides, passage MQ→DF direct, seuil 12 et non
 * 24 ; RX4 à Nyirád et Mondello : ni QF ni DF, finale directe, seuil 6).
 *
 *   1. première phase finale réellement peuplée (QF, puis DF, puis FIN) ;
 *   2. à défaut, le règlement ;
 *   3. à défaut, le nombre d'engagés (tout le monde passe).
 *
 * @param {object} params
 * @param {object} [params.regulation]
 * @param {object} [params.observedPhaseCounts] — { QF: n, DF: n, FIN: n }
 * @param {number} [params.engagedCount]
 * @returns {{ threshold: number|null, source: string, phase: string|null, label: string }}
 */
export function resolveQualificationThreshold({ regulation, observedPhaseCounts, engagedCount } = {}) {
  for (const phase of PHASE_ORDER) {
    const n = Number(observedPhaseCounts?.[phase]) || 0;
    if (n > 0) {
      return {
        threshold: n, source: 'observed', phase,
        label: `${n} places — observé : ${n} partants en ${phaseLabel(phase)}`,
      };
    }
  }

  const reg = thresholdFromRegulation(regulation);
  if (reg.threshold) {
    return {
      threshold: reg.threshold, source: 'regulation', phase: reg.phase,
      label: `${reg.threshold} places — règlement : ${phaseLabel(reg.phase)}`,
    };
  }

  if (engagedCount > 0) {
    return {
      threshold: engagedCount, source: 'engaged', phase: null,
      label: `${engagedCount} places — aucune phase finale connue, tous les engagés retenus`,
    };
  }

  return { threshold: null, source: 'unknown', phase: null, label: 'Seuil de qualification inconnu' };
}

function phaseLabel(phase) {
  if (phase === 'QF')  return 'quarts de finale';
  if (phase === 'DF')  return 'demi-finales';
  if (phase === 'FIN') return 'finale';
  return 'phase suivante';
}

// ─────────────────────────────────────────────────────────
// LABELS DE QUALIFICATION
// ─────────────────────────────────────────────────────────

/**
 * Qualification au sens de la RÈGLE SPORTIVE. C'est ce que le modèle prédit
 * et ce contre quoi le backtesting se calibre.
 *
 * @param {number|null} position — position au classement intermédiaire final
 * @param {number|null} threshold
 * @returns {boolean}
 */
export function isQualifiedByRule(position, threshold) {
  if (position == null || threshold == null) return false;
  return position <= threshold;
}

/**
 * Cas trivial : autant ou moins d'engagés que de places. Tout le monde passe
 * mécaniquement, l'observation n'apporte aucune information et gonflerait les
 * taux si elle entrait dans les statistiques.
 */
export function isTrivialQualification(engagedCount, threshold) {
  if (!engagedCount || threshold == null) return false;
  return engagedCount <= threshold;
}

/**
 * Écart de rang au seuil — l'axe normalisé principal.
 * Négatif = dans la zone qualificative, 0 = pile sur la bulle, positif = dehors.
 *
 * @param {number|null} position
 * @param {number|null} threshold
 * @returns {number|null}
 */
export function gapToThreshold(position, threshold) {
  if (position == null || threshold == null) return null;
  return position - threshold;
}

/**
 * Confronte la règle sportive à ce qui s'est réellement passé.
 *
 * `qualifiedActual` n'est JAMAIS utilisé pour projeter : un forfait n'est pas
 * prédictible, et l'inclure polluerait la calibration d'une erreur
 * irréductible. Il sert au diagnostic (écran « Qualité des données ») et à
 * repérer les forfaits/repêchages.
 *
 * @param {object} params
 * @param {Array}  params.standings — classement intermédiaire final
 * @param {number|null} params.threshold
 * @param {Set|Array} [params.actualDriverIds] — pilotes réellement présents en phase suivante
 * @returns {{ byDriverId: object, divergences: Array, hasActual: boolean }}
 */
export function compareQualificationLabels({ standings = [], threshold, actualDriverIds } = {}) {
  const actual = actualDriverIds instanceof Set
    ? actualDriverIds
    : new Set(actualDriverIds || []);
  const hasActual = actual.size > 0;

  const byDriverId = {};
  const divergences = [];

  for (const d of standings) {
    const byRule = isQualifiedByRule(d.position, threshold);
    const isActual = hasActual ? actual.has(d.driverId) : null;
    byDriverId[d.driverId] = { qualifiedByRule: byRule, qualifiedActual: isActual };
    if (hasActual && byRule !== isActual) {
      divergences.push({
        driverId: d.driverId,
        carNumber: d.carNumber,
        firstName: d.firstName,
        lastName: d.lastName,
        position: d.position,
        totalPoints: d.totalPoints,
        qualifiedByRule: byRule,
        qualifiedActual: isActual,
        kind: byRule ? 'absent_de_la_phase_suivante' : 'present_sans_etre_classe_qualifie',
      });
    }
  }

  // Pilotes présents en phase suivante mais absents du classement intermédiaire
  // (typiquement : moins de manches classées que le minimum exigé).
  if (hasActual) {
    const known = new Set(standings.map(d => d.driverId));
    for (const id of actual) {
      if (known.has(id)) continue;
      byDriverId[id] = { qualifiedByRule: false, qualifiedActual: true };
      divergences.push({
        driverId: id, carNumber: null, firstName: null, lastName: null,
        position: null, totalPoints: null,
        qualifiedByRule: false, qualifiedActual: true,
        kind: 'present_sans_classement_intermediaire',
      });
    }
  }

  return { byDriverId, divergences, hasActual };
}

/** Libellé lisible d'un type de divergence. */
export function describeDivergence(kind) {
  if (kind === 'absent_de_la_phase_suivante')
    return 'Classé qualifié mais absent de la phase suivante — forfait probable.';
  if (kind === 'present_sans_etre_classe_qualifie')
    return 'Présent en phase suivante sans être classé qualifié — repêchage / suppléant probable.';
  if (kind === 'present_sans_classement_intermediaire')
    return 'Présent en phase suivante mais absent du classement intermédiaire — pas assez de manches classées.';
  return kind;
}
