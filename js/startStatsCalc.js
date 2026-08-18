/* ═══════════════════════════════════════════════
   STARTSTATSCALC.JS — Statistiques des départs.

   Module PUR : aucune dépendance Firestore ni DOM, donc entièrement testable
   (tests/startStatsCalc.test.js).

   Règle absolue : seules les analyses `status === 'validated'` sont prises en
   compte. Une proposition non validée n'entre JAMAIS dans une statistique.

   Deux compteurs sont toujours exposés, car les confondre gonflerait
   artificiellement la confiance qu'on accorde aux chiffres :
     • nStarts       — nombre de DÉPARTS physiques (l'unité d'observation) ;
     • nObservations — nombre de lignes pilote × départ.

   Les statistiques par couloir portent sur le COULOIR BRUT (1, 2, 3…), qui est
   la vue principale. Le regroupement intérieur / milieu / extérieur reste une
   lecture secondaire, calculée à l'affichage.

   Voir docs/video-analysis/ARCHITECTURE.md §4.8.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// SÉLECTION DES DONNÉES
// ─────────────────────────────────────────────────────────

/**
 * Ne conserve que les analyses réellement exploitables.
 * @param {Array} analyses — documents startAnalyses
 * @returns {Array}
 */
export function validatedOnly(analyses = []) {
  return analyses.filter(a => a && a.status === 'validated' && Array.isArray(a.rows));
}

/**
 * Filtre les analyses sur les critères de l'interface.
 * Tout critère absent ou vide n'est pas appliqué.
 *
 * @param {Array} analyses
 * @param {object} [f]
 * @param {string} [f.championshipId]
 * @param {number} [f.year]
 * @param {string} [f.circuitLabel]
 * @param {string} [f.category]
 * @param {string} [f.sessionType] — 'MQ' | 'QF' | 'DF' | 'FIN'
 * @param {string} [f.gridSource]  — 'mq_couloir' | 'grid_layout' | 'manual'
 * @param {string} [f.gridLayoutKey]
 * @param {number} [f.starters]    — pour comparer des grilles de même taille
 * @returns {Array}
 */
export function filterAnalyses(analyses = [], f = {}) {
  return validatedOnly(analyses).filter(a => {
    if (f.championshipId && a.championshipId !== f.championshipId) return false;
    if (f.year && Number(a.year) !== Number(f.year)) return false;
    if (f.circuitLabel && a.circuitLabel !== f.circuitLabel) return false;
    if (f.category && a.category !== f.category) return false;
    if (f.sessionType && a.sessionType !== f.sessionType) return false;
    if (f.gridSource && a.gridSource !== f.gridSource) return false;
    if (f.gridLayoutKey && a.gridLayoutKey !== f.gridLayoutKey) return false;
    if (f.starters && Number(a.starters) !== Number(f.starters)) return false;
    return true;
  });
}

/**
 * Lignes exploitables d'un jeu d'analyses : pilotes réellement partis, avec une
 * position de grille connue. Chaque ligne est enrichie du contexte du départ,
 * pour permettre les regroupements sans re-jointure.
 *
 * @param {Array} analyses — déjà filtrées
 * @returns {Array}
 */
export function toRows(analyses = []) {
  const out = [];
  for (const a of analyses) {
    for (const r of a.rows) {
      if (r.didNotStart) continue;              // n'était pas sur la grille
      if (r.gridPos == null) continue;          // position de grille inconnue
      out.push({
        ...r,
        startId: a.id,
        sessionType: a.sessionType,
        category: a.category,
        year: a.year,
        circuitLabel: a.circuitLabel,
        championshipId: a.championshipId,
        gridSource: a.gridSource,
        gridLayoutKey: a.gridLayoutKey,
        gridLanes: a.gridLanes,
        starters: a.starters,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// OUTILS STATISTIQUES
// ─────────────────────────────────────────────────────────

/** Moyenne, ou null si aucune valeur. */
export function mean(values = []) {
  const v = values.filter(x => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

/** Médiane, ou null. Moins sensible que la moyenne aux abandons. */
export function median(values = []) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Intervalle de confiance de Wilson à 95 % pour une proportion.
 *
 * Préféré à l'intervalle normal parce qu'il reste correct sur de PETITS
 * échantillons et près de 0 % ou 100 % — exactement notre cas au démarrage.
 * Sans lui, 3 succès sur 4 se lirait « 75 % » avec la même assurance que
 * 150 sur 200.
 *
 * @param {number} successes
 * @param {number} total
 * @returns {{rate:number, low:number, high:number, n:number}|null}
 */
export function wilson(successes, total) {
  const n = Number(total);
  const k = Number(successes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const z = 1.959963985;                       // 95 %
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    rate: p,
    low: Math.max(0, (centre - spread) / d),
    high: Math.min(1, (centre + spread) / d),
    n,
  };
}

/**
 * Corrélation de rang de Spearman.
 * On compare des RANGS (positions), pas des grandeurs : Pearson serait
 * inadapté. Gère les ex aequo par rangs moyens.
 *
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null} entre -1 et 1, null si moins de 3 paires
 */
export function spearman(xs = [], ys = []) {
  const pairs = xs.map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;

  const rankOf = (values) => {
    const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;             // rangs moyens pour les ex aequo
      for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };

  const rx = rankOf(pairs.map(p => p[0]));
  const ry = rankOf(pairs.map(p => p[1]));
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;       // aucune variation : indéfini
  return num / Math.sqrt(dx * dy);
}

// ─────────────────────────────────────────────────────────
// STATISTIQUES PAR POSITION DE GRILLE
// ─────────────────────────────────────────────────────────

/**
 * Synthèse par position de départ.
 *
 * ⚠️ `gridPos` n'a pas la même signification selon la phase : en MQ c'est un
 * index de COULOIR sans hiérarchie, en phase finale un RANG DE QUALIFICATION.
 * Les agréger ensemble mélangerait deux concepts — filtrer par `sessionType`
 * ou `gridSource` en amont.
 *
 * @param {Array} rows — issues de toRows()
 * @returns {Array<{gridPos, nStarts, nObservations, keptLeadRate, tookLeadRate,
 *                  gainMean, gainMedian, turn1Mean, finishMean}>}
 */
export function byGridPos(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const k = Number(r.gridPos);
    if (!Number.isInteger(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([gridPos, rs]) => {
    const measured = rs.filter(r => Number.isFinite(r.turn1Pos));
    const gains = measured.map(r => r.gridPos - r.turn1Pos);   // + = places gagnées
    const leads = measured.filter(r => r.turn1Pos === 1).length;

    return {
      gridPos,
      nStarts: new Set(rs.map(r => r.startId)).size,
      nObservations: rs.length,
      nMeasured: measured.length,
      // P1 conserve-t-il la tête ? Les autres la prennent-ils ?
      keptLeadRate: gridPos === 1 ? wilson(leads, measured.length) : null,
      tookLeadRate: gridPos !== 1 ? wilson(leads, measured.length) : null,
      gainMean: mean(gains),
      gainMedian: median(gains),
      turn1Mean: mean(measured.map(r => r.turn1Pos)),
      finishMean: mean(rs.map(r => r.finishPosInStart).filter(Number.isFinite)),
    };
  });
}

/**
 * Synthèse par COULOIR BRUT — la vue principale des statistiques de couloir.
 *
 * Les couloirs ne sont comparables qu'à géométrie identique : filtrer en amont
 * par `gridLayoutKey`, sinon « couloir 3 » ne désigne pas la même place d'un
 * règlement à l'autre.
 *
 * @param {Array} rows
 * @returns {Array}
 */
export function byLane(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const k = Number(r.lane);
    if (!Number.isInteger(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([lane, rs]) => {
    const measured = rs.filter(r => Number.isFinite(r.turn1Pos));
    const gains = measured.map(r => r.gridPos - r.turn1Pos);
    return {
      lane,
      nStarts: new Set(rs.map(r => r.startId)).size,
      nObservations: rs.length,
      nMeasured: measured.length,
      gainMean: mean(gains),
      gainMedian: median(gains),
      leadRate: wilson(measured.filter(r => r.turn1Pos === 1).length, measured.length),
      turn1Mean: mean(measured.map(r => r.turn1Pos)),
      finishMean: mean(rs.map(r => r.finishPosInStart).filter(Number.isFinite)),
    };
  });
}

/**
 * Matrice de transition grille → premier virage.
 *
 * ⚠️ Calculée pour UNE taille de grille : mélanger des départs à 3 et à 8
 * voitures produirait des pourcentages ininterprétables. Filtrer en amont
 * sur `starters`.
 *
 * @param {Array} rows
 * @param {number} size — nombre de partants
 * @returns {{size:number, nStarts:number, cells:Array<Array<{count,rate,n}>>}}
 */
export function transitionMatrix(rows = [], size = 0) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1) return { size: 0, nStarts: 0, cells: [] };

  const rs = rows.filter(r => Number(r.starters) === n
    && Number.isInteger(r.gridPos) && r.gridPos <= n);

  const counts = Array.from({ length: n }, () => new Array(n).fill(0));
  const totals = new Array(n).fill(0);
  for (const r of rs) {
    if (!Number.isFinite(r.turn1Pos) || r.turn1Pos < 1 || r.turn1Pos > n) continue;
    counts[r.gridPos - 1][r.turn1Pos - 1]++;
    totals[r.gridPos - 1]++;
  }

  return {
    size: n,
    nStarts: new Set(rs.map(r => r.startId)).size,
    cells: counts.map((row, i) => row.map(c => ({
      count: c,
      rate: totals[i] ? c / totals[i] : null,
      n: totals[i],
    }))),
  };
}

/**
 * Corrélation entre la position au premier virage et le résultat final.
 * Répond à : « la course se joue-t-elle au départ ? »
 *
 * @param {Array} rows
 * @returns {{rho:number|null, n:number}}
 */
export function turn1VsFinish(rows = []) {
  const pairs = rows.filter(r => Number.isFinite(r.turn1Pos) && Number.isFinite(r.finishPosInStart));
  return {
    rho: spearman(pairs.map(r => r.turn1Pos), pairs.map(r => r.finishPosInStart)),
    n: pairs.length,
  };
}

// ─────────────────────────────────────────────────────────
// SYNTHÈSE GLOBALE
// ─────────────────────────────────────────────────────────

/**
 * Chiffres d'ensemble d'une sélection, avec la taille d'échantillon toujours
 * visible — un pourcentage sans son `n` n'a aucune valeur.
 *
 * @param {Array} analyses — déjà filtrées et validées
 * @returns {object}
 */
export function summary(analyses = []) {
  const rows = toRows(analyses);
  const measured = rows.filter(r => Number.isFinite(r.turn1Pos));
  const sizes = new Map();
  for (const a of analyses) {
    const k = Number(a.starters);
    sizes.set(k, (sizes.get(k) || 0) + 1);
  }
  return {
    nStarts: analyses.length,
    nObservations: rows.length,
    nMeasured: measured.length,
    nCircuits: new Set(analyses.map(a => a.circuitLabel).filter(Boolean)).size,
    nCategories: new Set(analyses.map(a => a.category).filter(Boolean)).size,
    bySize: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([starters, count]) => ({ starters, count })),
    gainMean: mean(measured.map(r => r.gridPos - r.turn1Pos)),
    correlation: turn1VsFinish(rows),
  };
}

/**
 * Seuil en dessous duquel un pourcentage ne doit pas être affiché comme tel :
 * on montre alors l'effectif brut. Évite de lire 3/4 comme « 75 % ».
 */
export const MIN_N_FOR_RATE = 10;

/**
 * Formate une proportion pour l'affichage, en refusant de donner un
 * pourcentage quand l'échantillon est trop faible.
 *
 * @param {{rate:number, n:number}|null} w — résultat de wilson()
 * @returns {string}
 */
export function formatRate(w) {
  if (!w || !w.n) return '—';
  if (w.n < MIN_N_FOR_RATE) return `${Math.round(w.rate * w.n)}/${w.n}`;
  return `${(w.rate * 100).toFixed(0)} %`;
}
