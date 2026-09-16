/* ═══════════════════════════════════════════════
   IMAGE.MJS — Adaptateur d'entrées/sorties pour Node.

   Volontairement séparé de `decode.mjs` : dans le navigateur, le
   redimensionnement se fera par `canvas.drawImage()` et la lecture par
   `createImageBitmap()`. Seul CE fichier serait alors remplacé — le calcul
   pur, lui, ne bouge pas. C'est la même séparation que
   `js/projection/qualificationData.js` face aux modules purs voisins.
═══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Décode un JPEG ou un PNG en RGBA brut.
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
export function loadImage(path) {
  const buf = readFileSync(path);
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Prépare le tenseur d'entrée du modèle.
 *
 * Reproduit `yolox/data/data_augment.py::preproc` :
 *   • rapport d'aspect conservé, image collée EN HAUT À GAUCHE ;
 *   • remplissage à 114 ;
 *   • valeurs laissées en 0–255, SANS division par 255 ni moyenne/écart-type
 *     (l'export standard n'en attend pas — c'est le mode `--legacy` qui les
 *     applique, et il concerne d'anciens poids) ;
 *   • disposition CHW.
 *
 * L'ordre des canaux est un PARAMÈTRE et non une constante : le démonstrateur
 * officiel lit ses images avec OpenCV, donc en BGR, et ne convertit jamais.
 * Se tromper ici ne provoque aucune erreur — seulement des détections plus
 * rares et moins sûres. Le POC mesure donc les deux (voir `run.mjs`) plutôt
 * que de faire confiance à la documentation.
 *
 * @param {{width,height,data}} img
 * @param {number} netW @param {number} netH
 * @param {'BGR'|'RGB'} channelOrder
 * @returns {{tensor:Float32Array, ratio:number}}
 */
export function preprocess(img, netW = 416, netH = 416, channelOrder = 'BGR') {
  const ratio = Math.min(netW / img.width, netH / img.height);
  const newW = Math.round(img.width * ratio);
  const newH = Math.round(img.height * ratio);

  const tensor = new Float32Array(3 * netH * netW).fill(114);
  const plane = netH * netW;
  // Indices de canal dans le tenseur de sortie, selon l'ordre demandé.
  const [c0, c1, c2] = channelOrder === 'BGR' ? [2, 1, 0] : [0, 1, 2];

  // Bilinéaire — équivalent du INTER_LINEAR d'OpenCV utilisé par YOLOX.
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) / ratio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = sy - y0;

    for (let x = 0; x < newW; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) / ratio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = sx - x0;

      const i00 = (y0 * img.width + x0) * 4, i01 = (y0 * img.width + x1) * 4;
      const i10 = (y1 * img.width + x0) * 4, i11 = (y1 * img.width + x1) * 4;
      const dst = y * netW + x;

      for (let ch = 0; ch < 3; ch++) {
        const top = img.data[i00 + ch] * (1 - wx) + img.data[i01 + ch] * wx;
        const bot = img.data[i10 + ch] * (1 - wx) + img.data[i11 + ch] * wx;
        const v = top * (1 - wy) + bot * wy;
        tensor[[c0, c1, c2][ch] * plane + dst] = v;
      }
    }
  }
  return { tensor, ratio };
}

// ─────────────────────────────────────────────────────────
// SORTIE ANNOTÉE
// ─────────────────────────────────────────────────────────

const PALETTE = [
  [0, 220, 120], [255, 170, 0], [80, 170, 255], [255, 90, 90],
  [200, 120, 255], [255, 235, 60], [0, 210, 210], [255, 130, 200],
];

/** Trace un rectangle plein de `thickness` pixels dans un tampon RGBA. */
function strokeRect(data, w, h, x1, y1, x2, y2, rgb, thickness = 3) {
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  };
  const xa = Math.round(x1), ya = Math.round(y1);
  const xb = Math.round(x2), yb = Math.round(y2);
  for (let t = 0; t < thickness; t++) {
    for (let x = xa; x <= xb; x++) { put(x, ya + t); put(x, yb - t); }
    for (let y = ya; y <= yb; y++) { put(xa + t, y); put(xb - t, y); }
  }
}

/**
 * Écrit une copie annotée de l'image. Rectangles seulement : les libellés et
 * les scores vivent dans le rapport HTML, qui sait afficher du texte.
 */
export function writeAnnotated(img, boxes, outPath) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data.subarray(0, img.width * img.height * 4));
  boxes.forEach((b, i) => {
    strokeRect(png.data, img.width, img.height, b.x1, b.y1, b.x2, b.y2,
               PALETTE[i % PALETTE.length], 3);
  });
  return PNG.sync.write(png);
}
