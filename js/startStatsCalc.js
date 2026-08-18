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

import { normalizePoleSide } from './startAnalysisCalc.js';

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
export function toRows(analyses = [], { requireComplete = false } = {}) {
  const out = [];
  for (const a of analyses) {
    // orderCompleteness : 'partial' n'est jamais validable, donc absent ici.
    // 'leaders_only' signifie que SEULES les voitures vues sont certifiées :
    // leurs positions sont fiables, mais l'échantillon peut être biaisé (une
    // voiture est plus souvent filmée quand elle est devant). D'où l'option
    // requireComplete, qui n'admet que les départs intégralement observés.
    const complete = (a.orderCompleteness || 'complete') === 'complete';
    if (requireComplete && !complete) continue;

    for (const r of a.rows) {
      if (r.didNotStart) continue;              // n'était pas sur la grille
      if (r.gridPos == null) continue;          // position de grille inconnue
      const t1 = Number.isFinite(r.turn1Pos) ? r.turn1Pos : null;
      const fin = Number.isFinite(r.finishPosInStart) ? r.finishPosInStart : null;
      out.push({
        ...r,
        turn1Pos: t1,
        finishPosInStart: fin,
        // Les trois transitions, positives quand des places sont GAGNÉES
        gainToTurn1:      t1  != null ? r.gridPos - t1 : null,
        gainTurn1ToFinish: (t1 != null && fin != null) ? t1 - fin : null,
        gainTotal:        fin != null ? r.gridPos - fin : null,
        fromCompleteStart: complete,
        startId: a.id,
        sessionType: a.sessionType,
        category: a.category,
        year: a.year,
        circuitLabel: a.circuitLabel,
        championshipId: a.championshipId,
        gridSource: a.gridSource,
        gridLayoutKey: a.gridLayoutKey,
        gridLanes: a.gridLanes,
        gridRow: r.gridRow ?? null,
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
/**
 * Sens de la piste pour l'ensemble d'analyses affiché.
 *
 * Le couloir 1 est toujours du côté du premier virage. Pour lire un tableau
 * « comme sur la piste », il faut donc savoir de quel côté part la pole :
 *  • 'right'   → couloir 1 à droite, donc de gauche à droite : Cn … C1 ;
 *  • 'left'    → couloir 1 à gauche, ordre naturel C1 … Cn ;
 *  • 'mixed'   → la sélection mélange des circuits orientés différemment,
 *                aucun ordre physique commun n'existe ;
 *  • 'unknown' → orientation inconnue.
 *
 * @param {Array} analyses
 * @param {Object<string,string>} [sideByMeetingId] — repli quand l'analyse ne
 *        porte pas encore `poleSide` (analyses enregistrées avant son ajout)
 * @returns {'left'|'right'|'mixed'|'unknown'}
 */
export function laneOrientation(analyses = [], sideByMeetingId = {}) {
  const sides = new Set();
  for (const a of analyses) {
    const raw = a?.poleSide ?? sideByMeetingId[a?.meetingId];
    if (!raw) continue;
    sides.add(normalizePoleSide(raw));
  }
  if (sides.size === 0) return 'unknown';
  if (sides.size > 1) return 'mixed';
  return [...sides][0];
}

/**
 * Ordonne des lignes de couloir pour une lecture « de gauche à droite sur la
 * piste ». N'inverse que lorsque l'orientation est connue ET unique : sur une
 * sélection mélangée, un ordre physique serait une illusion.
 *
 * @param {Array} stats — sortie de byLane()
 * @param {string} orientation — voir laneOrientation()
 * @returns {Array} nouveau tableau, l'entrée n'est pas modifiée
 */
export function orderLanesForDisplay(stats = [], orientation = 'unknown') {
  return orientation === 'right' ? [...stats].reverse() : [...stats];
}

export function byGridPos(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const k = Number(r.gridPos);
    if (!Number.isInteger(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .map(([gridPos, rs]) => positionStats({ key: 'gridPos', value: gridPos, rows: rs }));
}

/**
 * Indicateurs communs à un groupe de lignes (position de grille, couloir,
 * ligne de grille…). Regrouper le calcul évite trois copies divergentes.
 *
 * @param {{key:string, value:number, rows:Array}} g
 * @returns {object}
 */
function positionStats({ key, value, rows: rs }) {
  const measured = rs.filter(r => r.turn1Pos != null);
  const finished = rs.filter(r => r.finishPosInStart != null);
  const gains = measured.map(r => r.gainToTurn1);

  return {
    [key]: value,
    nStarts: new Set(rs.map(r => r.startId)).size,
    nObservations: rs.length,
    nMeasured: measured.length,
    nFinished: finished.length,
    nFromPartial: rs.filter(r => !r.fromCompleteStart).length,

    // ── Grille → V1 ──
    turn1Mean: mean(measured.map(r => r.turn1Pos)),
    gainMean: mean(gains),
    gainMedian: median(gains),
    leadRate: wilson(measured.filter(r => r.turn1Pos === 1).length, measured.length),
    keptRate: wilson(measured.filter(r => r.gainToTurn1 === 0).length, measured.length),
    gainedRate: wilson(measured.filter(r => r.gainToTurn1 > 0).length, measured.length),
    lostRate: wilson(measured.filter(r => r.gainToTurn1 < 0).length, measured.length),

    // ── V1 → arrivée ──
    gainAfterTurn1Mean: mean(rs.map(r => r.gainTurn1ToFinish).filter(Number.isFinite)),

    // ── Grille → arrivée ──
    finishMean: mean(finished.map(r => r.finishPosInStart)),
    gainTotalMean: mean(rs.map(r => r.gainTotal).filter(Number.isFinite)),
    winRate: wilson(finished.filter(r => r.finishPosInStart === 1).length, finished.length),

    // ── Abandons : comptés, jamais convertis en position ──
    nDnf: rs.filter(r => r.finishStatus === 'DNF').length,
    dnfRate: wilson(rs.filter(r => r.finishStatus === 'DNF').length, rs.length),
  };
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
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .map(([lane, rs]) => positionStats({ key: 'lane', value: lane, rows: rs }));
}

/**
 * Vrai quand, sur l'ensemble des lignes, la position de grille et le couloir
 * désignent la même place — c'est le cas d'une grille à une seule ligne, où la
 * n-ième position EST le n-ième couloir.
 *
 * Dans ce cas `byGridPos()` et `byLane()` produisent des tableaux identiques :
 * la vue peut n'en afficher qu'un seul au lieu de dupliquer les mêmes chiffres.
 *
 * @param {Array} rows
 * @returns {boolean}
 */
export function gridPosEqualsLane(rows = []) {
  const isPos = v => v != null && Number.isInteger(Number(v));
  const usable = rows.filter(r => isPos(r.gridPos) && isPos(r.lane));
  if (usable.length === 0) return false;
  return usable.every(r => Number(r.gridPos) === Number(r.lane));
}

/**
 * Synthèse par LIGNE de grille — n'a de sens qu'en phases finales, les séries
 * de manche n'ayant qu'une seule ligne.
 * @param {Array} rows
 * @returns {Array}
 */
export function byGridRow(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const k = Number(r.gridRow);
    if (!Number.isInteger(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0])
    .map(([gridRow, rs]) => positionStats({ key: 'gridRow', value: gridRow, rows: rs }));
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
export function transitionMatrix(rows = [], size = 0, { from = 'gridPos', to = 'turn1Pos' } = {}) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1) return { size: 0, from, to, nStarts: 0, nPairs: 0, cells: [] };

  const rs = rows.filter(r => Number(r.starters) === n);

  const counts = Array.from({ length: n }, () => new Array(n).fill(0));
  const totals = new Array(n).fill(0);
  let nPairs = 0;
  for (const r of rs) {
    const a = r[from];
    const b = r[to];
    // Une paire n'est comptée que si les DEUX états sont connus. Un abandon
    // (finishPosInStart null) n'est jamais converti en une position fictive.
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a < 1 || a > n || b < 1 || b > n) continue;
    counts[a - 1][b - 1]++;
    totals[a - 1]++;
    nPairs++;
  }

  return {
    size: n,
    from,
    to,
    nStarts: new Set(rs.map(r => r.startId)).size,
    nPairs,
    cells: counts.map((row, i) => row.map(c => ({
      count: c,
      rate: totals[i] ? c / totals[i] : null,
      n: totals[i],
    }))),
  };
}

/** Les trois matrices demandées, pour une taille de grille donnée. */
export function allMatrices(rows = [], size = 0) {
  return {
    gridToTurn1:  transitionMatrix(rows, size, { from: 'gridPos',  to: 'turn1Pos' }),
    turn1ToFinish: transitionMatrix(rows, size, { from: 'turn1Pos', to: 'finishPosInStart' }),
    gridToFinish: transitionMatrix(rows, size, { from: 'gridPos',  to: 'finishPosInStart' }),
  };
}

/**
 * Regroupement de phase : les manches et les phases finales ne se mélangent
 * pas par défaut. Une série de manche est sur UNE ligne et `gridPos` y désigne
 * un couloir ; une grille de finale a plusieurs lignes et `gridPos` y désigne
 * un rang de qualification.
 *
 * @param {string} sessionType
 * @returns {'MQ'|'FINALS'|'OTHER'}
 */
export function phaseGroupOf(sessionType) {
  const t = String(sessionType || '').toUpperCase();
  if (t === 'MQ') return 'MQ';
  if (t === 'QF' || t === 'DF' || t === 'FIN') return 'FINALS';
  return 'OTHER';
}

/** Tailles de grille présentes, de la plus fréquente à la plus rare. */
export function availableSizes(analyses = []) {
  const counts = new Map();
  for (const a of analyses) {
    const k = Number(a.starters);
    if (!Number.isInteger(k) || k < 1) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([starters, count]) => ({ starters, count }));
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

/** Corrélation entre la position de grille et le résultat final. */
export function gridVsFinish(rows = []) {
  const pairs = rows.filter(r => Number.isFinite(r.gridPos) && Number.isFinite(r.finishPosInStart));
  return {
    rho: spearman(pairs.map(r => r.gridPos), pairs.map(r => r.finishPosInStart)),
    n: pairs.length,
  };
}

/** Corrélation entre la position de grille et la position au premier virage. */
export function gridVsTurn1(rows = []) {
  const pairs = rows.filter(r => Number.isFinite(r.gridPos) && Number.isFinite(r.turn1Pos));
  return {
    rho: spearman(pairs.map(r => r.gridPos), pairs.map(r => r.turn1Pos)),
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
    nFromPartial: rows.filter(r => !r.fromCompleteStart).length,
    gainMean: mean(measured.map(r => r.gainToTurn1)),
    correlations: {
      gridToTurn1: gridVsTurn1(rows),
      turn1ToFinish: turn1VsFinish(rows),
      gridToFinish: gridVsFinish(rows),
    },
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
