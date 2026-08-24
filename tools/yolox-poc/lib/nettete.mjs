/* ═══════════════════════════════════════════════
   NETTETE.MJS — Quantifier le flou et le mouvement d'une zone d'image

   Module PUR : des pixels en entrée, des nombres en sortie. Aucun modèle,
   aucun seuil, aucune décision.

   Pourquoi ces deux mesures, et pas une seule
   ───────────────────────────────────────────
   Une détection ratée peut l'être pour deux raisons opposées, et les
   confondre mènerait à la mauvaise correction :

     · la zone est FLOUE — la voiture bouge vite, l'obturateur l'étale, les
       contours disparaissent. Le détecteur n'a plus de structure à saisir ;
     · la zone BOUGE d'une image à l'autre sans être floue — la voiture est
       nette mais se déplace, ce qui gêne l'association temporelle, pas la
       détection.

   `nettete` répond à la première question, `mouvement` à la seconde. Les deux
   sont indépendantes : une voiture peut être nette et rapide (obturateur
   court), ou floue et lente (mise au point ratée).
═══════════════════════════════════════════════ */

/** Identifiant de méthode, à retrouver dans les rapports. */
export const METHODE_NETTETE = 'laplacien+diff/1';

/** Luminance perçue, en une seule passe sur la zone demandée. */
function luminance(rgba, largeur, hauteur, [x1, y1, x2, y2]) {
  const gx1 = Math.max(0, Math.floor(x1)), gy1 = Math.max(0, Math.floor(y1));
  const gx2 = Math.min(largeur, Math.ceil(x2)), gy2 = Math.min(hauteur, Math.ceil(y2));
  const l = gx2 - gx1, h = gy2 - gy1;
  if (l < 3 || h < 3) return null;
  const g = new Float32Array(l * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < l; x++) {
      const i = ((gy1 + y) * largeur + (gx1 + x)) * 4;
      g[y * l + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { g, l, h };
}

/**
 * NETTETÉ : variance du laplacien sur la zone.
 *
 * Le laplacien répond aux changements brusques d'intensité — les contours.
 * Une image nette en a beaucoup et de forts, une image floue peu et de
 * faibles. Sa VARIANCE résume cela en un nombre, et c'est la mesure de flou
 * la plus répandue parce qu'elle ne demande ni référence ni apprentissage.
 *
 * Deux valeurs sont rendues :
 *   · `variance`, brute — comparable entre zones de même contraste ;
 *   · `relative`, divisée par la variance de la luminance — comparable entre
 *     une voiture sombre et une voiture claire, ce que la brute n'est pas.
 *
 * @returns {?{variance:number, relative:number, pixels:number}}
 */
export function nettete(rgba, largeur, hauteur, boite) {
  const z = luminance(rgba, largeur, hauteur, boite);
  if (!z) return null;
  const { g, l, h } = z;

  let somme = 0, sommeCarres = 0, n = 0;
  let sommeL = 0, sommeL2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < l - 1; x++) {
      const i = y * l + x;
      const lap = g[i - l] + g[i + l] + g[i - 1] + g[i + 1] - 4 * g[i];
      sommeL += lap; sommeL2 += lap * lap;
      somme += g[i]; sommeCarres += g[i] * g[i];
      n += 1;
    }
  }
  if (!n) return null;
  const varianceLap = sommeL2 / n - (sommeL / n) ** 2;
  const varianceLum = sommeCarres / n - (somme / n) ** 2;
  return {
    variance: Number(varianceLap.toFixed(2)),
    // Sans dimension : un contour vaut ce qu'il vaut RELATIVEMENT au contraste
    // local. Une livrée noire mate et une livrée blanche ne se comparent pas
    // autrement.
    relative: Number((varianceLum > 1e-6 ? varianceLap / varianceLum : 0).toFixed(4)),
    pixels: n,
  };
}

/**
 * MOUVEMENT : différence absolue moyenne entre deux images, sur la zone.
 *
 * Exprimée en niveaux de gris (0–255). Elle dit de combien la zone a changé,
 * sans distinguer un déplacement d'un changement d'éclairage — c'est
 * volontaire : les deux gênent l'association de la même façon.
 *
 * @returns {?{moyenne:number, pixels:number}}
 */
export function mouvement(rgbaA, rgbaB, largeur, hauteur, boite) {
  const a = luminance(rgbaA, largeur, hauteur, boite);
  const b = luminance(rgbaB, largeur, hauteur, boite);
  if (!a || !b || a.g.length !== b.g.length) return null;
  let somme = 0;
  for (let i = 0; i < a.g.length; i++) somme += Math.abs(a.g[i] - b.g[i]);
  return {
    moyenne: Number((somme / a.g.length).toFixed(2)),
    pixels: a.g.length,
  };
}

/**
 * Distance de la boîte au bord de l'image, en pixels, côté par côté.
 *
 * Une boîte qui touche un bord est TRONQUÉE : la voiture continue au-delà du
 * cadre. C'est une information de nature différente d'une boîte petite ou
 * floue — elle explique une détection instable sans qu'aucun réglage n'y
 * puisse rien.
 */
export function distancesAuBord([x1, y1, x2, y2], largeur, hauteur) {
  const d = {
    gauche: Math.round(x1), haut: Math.round(y1),
    droite: Math.round(largeur - x2), bas: Math.round(hauteur - y2),
  };
  d.min = Math.min(d.gauche, d.haut, d.droite, d.bas);
  return d;
}
