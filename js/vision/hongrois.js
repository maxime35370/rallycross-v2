/* ═══════════════════════════════════════════════
   HONGROIS.JS — Affectation optimale

   Extrait du tracker pour être utilisable sans lui : l'analyse du premier
   virage a besoin d'apparier cinq voitures à cinq numéros, et rien d'autre.
   Charger deux mille lignes de suivi temporel pour cela n'aurait pas de sens.

   Module pur : aucune dépendance, aucun accès au DOM.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// AFFECTATION OPTIMALE — ALGORITHME HONGROIS
// ─────────────────────────────────────────────────────────

/**
 * Affectation de coût minimal entre lignes et colonnes.
 *
 * Pourquoi pas « la boîte la plus proche » : au rallycross deux voitures se
 * touchent presque. Une association gloutonne donne à la première piste sa
 * meilleure détection, quitte à voler celle dont une autre piste avait un
 * besoin bien plus impérieux — c'est le mécanisme classique de l'échange
 * d'identité. L'affectation hongroise minimise le coût TOTAL et supprime ce
 * cas de figure.
 *
 * @param {number[][]} cout — matrice lignes × colonnes
 * @returns {number[]} pour chaque ligne, l'indice de colonne, ou -1
 */
export function hungarian(cout) {
  const n = cout.length;
  const m = n ? cout[0].length : 0;
  if (!n || !m) return new Array(n).fill(-1);

  // L'implémentation par chemins augmentants exige n ≤ m : on complète avec
  // des lignes fictives à coût nul, écartées à la fin.
  const k = Math.max(n, m);
  const GRAND = 1e9;
  const c = Array.from({ length: k }, (_, i) => Array.from({ length: k },
    (_, j) => (i < n && j < m ? cout[i][j] : GRAND)));

  const u = new Array(k + 1).fill(0);
  const v = new Array(k + 1).fill(0);
  const p = new Array(k + 1).fill(0);
  const way = new Array(k + 1).fill(0);

  for (let i = 1; i <= k; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(k + 1).fill(Infinity);
    const vu = new Array(k + 1).fill(false);
    do {
      vu[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= k; j++) {
        if (vu[j]) continue;
        const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= k; j++) {
        if (vu[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const res = new Array(n).fill(-1);
  for (let j = 1; j <= k; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < n && j - 1 < m) res[i] = j - 1;
  }
  return res;
}
