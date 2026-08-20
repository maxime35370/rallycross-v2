/* ═══════════════════════════════════════════════
   MONTECARLOENGINE.JS — Tirage aléatoire reproductible.

   Module PUR : ni Firestore, ni DOM, et surtout AUCUN appel à Math.random().

   Tout le hasard du module passe par un générateur à graine explicite. Deux
   raisons, également importantes :
     • un résultat affiché doit pouvoir être rejoué à l'identique pour être
       débogué ou contesté — la graine est exposée dans les sorties ;
     • le backtesting compare des variantes de modèle : si le bruit changeait
       d'une exécution à l'autre, une différence de Brier score ne voudrait
       rien dire.

   Le générateur est mulberry32 : 32 bits d'état, période 2³², qualité
   largement suffisante pour du Monte-Carlo de ce volume, et surtout
   déterministe et portable — le même code donne la même suite dans Node et
   dans le navigateur, ce qu'aucun générateur natif ne garantit.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// GÉNÉRATEUR
// ─────────────────────────────────────────────────────────

/**
 * Générateur uniforme [0, 1) à graine.
 *
 * @param {number} seed — entier ; la même graine donne toujours la même suite
 * @returns {() => number}
 */
export function createRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Dérive une graine fille d'une graine mère et d'un libellé.
 *
 * Permet à chaque scénario « et si » d'avoir son propre flux sans dépendre de
 * l'ordre dans lequel les scénarios sont calculés : le résultat de « Q4 = P8 »
 * ne doit pas changer selon qu'on a calculé « Q4 = P7 » avant ou non.
 *
 * @param {number} seed
 * @param {string} label
 * @returns {number}
 */
export function deriveSeed(seed, label) {
  let h = (Number(seed) >>> 0) || 1;
  const s = String(label);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ─────────────────────────────────────────────────────────
// LOIS
// ─────────────────────────────────────────────────────────

/**
 * Tirage normal centré réduit (Box-Muller). Consomme deux uniformes ;
 * la seconde valeur n'est pas mise en cache, pour que la consommation du flux
 * reste strictement prévisible — condition d'un déterminisme réel.
 */
export function randomNormal(rng) {
  let u = rng();
  if (u <= Number.EPSILON) u = Number.EPSILON;
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fonction de répartition de la loi normale centrée réduite. */
export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Quantile de la loi normale centrée réduite (fonction probit).
 *
 * Sert à convertir un rang normalisé en « force » latente : une place dans une
 * manche n'est pas une grandeur additionnable, alors qu'un z l'est. C'est ce
 * qui rend comparables des manches de tailles différentes.
 *
 * Approximation d'Acklam, précision ~1,15e-9 en valeur absolue.
 */
export function normalQuantile(p) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
         / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
          / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
       / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Fonction d'erreur (Abramowitz & Stegun 7.1.26). */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

// ─────────────────────────────────────────────────────────
// AGRÉGATION DES TIRAGES
// ─────────────────────────────────────────────────────────

/**
 * Accumulateur de distribution discrète, sans conserver les tirages.
 *
 * Un backtest lance des dizaines de millions de tirages : garder chaque
 * échantillon coûterait plus cher que la simulation elle-même.
 */
export function createTally() {
  const counts = new Map();
  let total = 0, sum = 0, sumSq = 0;
  return {
    add(value, weight = 1) {
      counts.set(value, (counts.get(value) || 0) + weight);
      total += weight;
      if (typeof value === 'number') { sum += value * weight; sumSq += value * value * weight; }
    },
    get total() { return total; },
    get mean() { return total ? sum / total : null; },
    get sd() {
      if (!total) return null;
      const m = sum / total;
      return Math.sqrt(Math.max(0, sumSq / total - m * m));
    },
    /** Médiane sur les valeurs numériques, par cumul des effectifs. */
    quantile(q) {
      const keys = [...counts.keys()].filter(k => typeof k === 'number').sort((x, y) => x - y);
      if (!keys.length) return null;
      const target = q * total;
      let acc = 0;
      for (const k of keys) { acc += counts.get(k); if (acc >= target) return k; }
      return keys[keys.length - 1];
    },
    /** [{ value, count, share }] trié par valeur croissante. */
    entries() {
      return [...counts.entries()]
        .sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number')
          ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0])))
        .map(([value, count]) => ({ value, count, share: total ? count / total : 0 }));
    },
    count(value) { return counts.get(value) || 0; },
  };
}
