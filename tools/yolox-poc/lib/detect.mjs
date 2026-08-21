/* ═══════════════════════════════════════════════
   DETECT.MJS — Logique pure du banc de détection YOLOX

   Aucun accès au DOM, au réseau ni à ONNX Runtime : uniquement les
   mathématiques de pré-traitement, de décodage et de fusion, pour qu'elles
   soient testables sans navigateur et sans modèle (`tests/yoloxDetect.test.js`).

   Le modèle est YOLOX-tiny exporté en ONNX (Apache 2.0), entrée
   `images` [1,3,416,416] flottante, sortie `output` [1,3549,85].
   Convention d'entrée héritée de l'implémentation de référence : image
   redimensionnée en conservant le ratio, collée en HAUT À GAUCHE d'un fond
   gris 114, canaux en **BGR**, valeurs **0–255 non normalisées**.
═══════════════════════════════════════════════ */

/**
 * Modèles disponibles.
 *
 * ⚠️ La taille d'entrée n'est PAS commune : YOLOX-tiny travaille en 416 et
 * produit 3549 ancres, YOLOX-s en 640 et en produit 8400. Décoder une sortie
 * de 8400 ancres avec les grilles de 416 ne donne pas une erreur, cela donne
 * des boîtes fausses — d'où `assertAnchorCount()`, appelé avant tout décodage.
 *
 * Tout le reste — pré-traitement, décodage, fusion, seuils — est rigoureusement
 * identique d'un modèle à l'autre : c'est la condition pour que la comparaison
 * tiny / s ait un sens.
 */
export const MODELS = {
  tiny: {
    id: 'tiny',
    label: 'YOLOX-tiny',
    file: 'yolox_tiny.onnx',
    inputSize: 416,
    approxMo: 20,
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx',
  },
  s: {
    id: 's',
    label: 'YOLOX-s',
    file: 'yolox_s.onnx',
    inputSize: 640,
    approxMo: 35,
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx',
  },
};

export const DEFAULT_MODEL = 'tiny';

/** Taille d'entrée par défaut — celle de YOLOX-tiny. */
export const INPUT_SIZE = MODELS.tiny.inputSize;

export const STRIDES = [8, 16, 32];

/** Nombre d'ancres attendu pour une taille d'entrée : 416 → 3549, 640 → 8400. */
export function anchorCount(size, strides = STRIDES) {
  return strides.reduce((t, s) => t + (size / s) ** 2, 0);
}

/**
 * Garde-fou : la sortie du réseau doit correspondre aux grilles utilisées.
 * Sans lui, charger YOLOX-s avec les grilles de tiny produirait silencieusement
 * des boîtes fausses au lieu d'une erreur.
 */
export function assertAnchorCount(rawLength, size, classCount = 80) {
  const attendu = anchorCount(size) * (5 + classCount);
  if (rawLength !== attendu) {
    throw new Error(
      `sortie de ${rawLength} valeurs incompatible avec une entrée de ${size} px `
      + `(${attendu} attendues) : le modèle et la taille d'entrée ne correspondent pas`);
  }
  return true;
}

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
  'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * Classes COCO retenues pour le rallycross.
 *
 * Une voiture de rallycross n'existe pas dans COCO : le modèle la range selon
 * l'angle et la carrosserie tantôt en `car`, tantôt en `truck`, parfois en
 * `bus`. Les trois désignent ici le même objet — d'où la fusion du §fusion.
 * `person`, `bicycle` et le reste sont écartés : ils polluent le comptage sans
 * rien apporter à l'ordre au premier virage.
 */
export const VEHICLE_CLASSES = ['car', 'truck', 'bus'];

export const VEHICLE_CLASS_IDS = VEHICLE_CLASSES.map(c => COCO_CLASSES.indexOf(c));

// ─────────────────────────────────────────────────────────
// PRÉ-TRAITEMENT
// ─────────────────────────────────────────────────────────

/**
 * Géométrie du redimensionnement à ratio conservé.
 * @returns {{ratio:number, width:number, height:number}} dimensions utiles
 *          dans le carré d'entrée ; le reste est du remplissage gris.
 */
export function letterbox(width, height, size = INPUT_SIZE) {
  const ratio = Math.min(size / height, size / width);
  return {
    ratio,
    width: Math.floor(width * ratio),
    height: Math.floor(height * ratio),
  };
}

// ─────────────────────────────────────────────────────────
// DÉCODAGE
// ─────────────────────────────────────────────────────────

/**
 * Grilles et pas de YOLOX pour une taille d'entrée donnée.
 * 416 → 52² + 26² + 13² = 3549 ancres, dans cet ordre.
 */
export function buildGrids(size = INPUT_SIZE, strides = STRIDES) {
  const gx = [], gy = [], st = [];
  for (const stride of strides) {
    const n = size / stride;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) { gx.push(x); gy.push(y); st.push(stride); }
    }
  }
  return { gx, gy, strides: st, count: st.length };
}

/**
 * Transforme la sortie brute du réseau en boîtes exprimées dans l'image
 * d'origine, et en scores par classe.
 *
 * La sortie porte, par ancre : cx, cy, w, h (en unités de grille), un score
 * d'objectness, puis 80 probabilités de classe. Le score final d'une classe
 * est le PRODUIT objectness × probabilité — c'est la convention YOLOX, et
 * s'en écarter décalerait tous les seuils.
 *
 * @param {ArrayLike<number>} raw — 3549 × 85 valeurs, à plat
 * @param {{gx:number[], gy:number[], strides:number[], count:number}} grids
 * @param {number} ratio — celui de `letterbox()`
 * @param {{scoreThreshold?:number, classIds?:number[]}} [opts]
 * @returns {Array<{classId:number, label:string, score:number, box:number[]}>}
 *          `box` = [x1, y1, x2, y2] en pixels de l'image d'origine
 */
export function decodeOutput(raw, grids, ratio, { scoreThreshold = 0.3, classIds = null } = {}) {
  const NB_CLASSES = 80;
  const STRIDE = 5 + NB_CLASSES;
  const wanted = classIds || COCO_CLASSES.map((_, i) => i);
  const out = [];

  for (let a = 0; a < grids.count; a++) {
    const o = a * STRIDE;
    const objectness = raw[o + 4];
    // Aucune classe ne peut dépasser l'objectness : on écarte l'ancre d'emblée.
    if (objectness < scoreThreshold) continue;

    const s = grids.strides[a];
    const cx = (raw[o] + grids.gx[a]) * s;
    const cy = (raw[o + 1] + grids.gy[a]) * s;
    const w = Math.exp(raw[o + 2]) * s;
    const h = Math.exp(raw[o + 3]) * s;

    for (const c of wanted) {
      const score = objectness * raw[o + 5 + c];
      if (score < scoreThreshold) continue;
      out.push({
        classId: c,
        label: COCO_CLASSES[c],
        score,
        box: [
          (cx - w / 2) / ratio, (cy - h / 2) / ratio,
          (cx + w / 2) / ratio, (cy + h / 2) / ratio,
        ],
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// SUPPRESSION DES DOUBLONS
// ─────────────────────────────────────────────────────────

/** Intersection sur union de deux boîtes [x1,y1,x2,y2]. */
export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const aireA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const aireB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = aireA + aireB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Suppression des non-maxima **commune à toutes les classes véhicule**.
 *
 * C'est le point qui compte pour le rallycross. Mesuré sur l'image de
 * référence de YOLOX : le même camion ressort en `car` à 0,770 ET en `truck` à
 * 0,465. Une NMS classe par classe garderait les deux et compterait deux
 * véhicules là où il n'y en a qu'un — ce qui gonflerait artificiellement le
 * rappel tout en ruinant la précision.
 *
 * La détection conservée garde la trace des étiquettes concurrentes dans
 * `alsoDetectedAs` : l'hésitation du modèle entre `car` et `truck` est une
 * information, pas un déchet.
 *
 * @param {Array} detections — sortie de `decodeOutput()`
 * @param {number} [iouThreshold]
 * @returns {Array} détections retenues, du score le plus élevé au plus bas
 */
export function mergeVehicleDetections(detections, iouThreshold = 0.45) {
  const tri = [...detections].sort((a, b) => b.score - a.score);
  const gardees = [];

  for (const d of tri) {
    const chevauche = gardees.find(g => iou(g.box, d.box) > iouThreshold);
    if (chevauche) {
      if (!chevauche.alsoDetectedAs.includes(d.label) && d.label !== chevauche.label) {
        chevauche.alsoDetectedAs.push(d.label);
      }
      chevauche.suppressed += 1;
      continue;
    }
    gardees.push({ ...d, alsoDetectedAs: [], suppressed: 0 });
  }
  return gardees;
}

// ─────────────────────────────────────────────────────────
// MESURES — uniquement à partir d'annotations humaines
// ─────────────────────────────────────────────────────────

/**
 * Rappel et précision d'une image, calculés **exclusivement** sur ce qu'un
 * humain a annoté. Le modèle ne connaît pas la vérité terrain : lui laisser
 * compter ses propres succès produirait un chiffre qui ne mesure rien.
 *
 * @param {object} a — annotation d'une image
 * @param {number|null} a.carsDetectable — voitures dont plus de la moitié de la
 *        carrosserie est visible ; c'est le dénominateur du rappel
 * @param {number|null} a.carsOrderCritical — voitures dont l'absence fausserait
 *        l'ordre au premier virage
 * @param {number} a.missed — voitures détectables non détectées
 * @param {number} a.missedOrderCritical — parmi elles, celles critiques pour l'ordre
 * @param {number} a.truePositives — détections validées
 * @param {number} a.falsePositives — détections rejetées (y compris doublons)
 * @returns {{recall:number|null, precision:number|null, criticalRecall:number|null,
 *            coherent:boolean}}
 */
export function scoreImage({
  carsDetectable = null, carsOrderCritical = null,
  missed = 0, missedOrderCritical = 0,
  truePositives = 0, falsePositives = 0,
} = {}) {
  const det = Number.isFinite(carsDetectable) ? carsDetectable : null;
  const crit = Number.isFinite(carsOrderCritical) ? carsOrderCritical : null;

  return {
    recall: det && det > 0 ? (det - missed) / det : null,
    precision: truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : null,
    criticalRecall: crit && crit > 0 ? (crit - missedOrderCritical) / crit : null,
    // Les deux chemins doivent donner le même nombre de détections justes :
    // sinon l'annotation se contredit et le chiffre ne veut rien dire.
    coherent: det == null || det - missed === truePositives,
  };
}

/** Agrégat sur plusieurs images, en sommant les comptes — jamais en moyennant
 *  des taux, ce qui donnerait le même poids à une image de 2 voitures et à une
 *  image de 6. */
export function aggregate(annotations = []) {
  const somme = (f) => annotations.reduce((t, a) => t + (Number(f(a)) || 0), 0);
  const detectable = somme(a => a.carsDetectable);
  const critique = somme(a => a.carsOrderCritical);
  const rates = somme(a => a.missed);
  const ratesCritiques = somme(a => a.missedOrderCritical);
  const vp = somme(a => a.truePositives);
  const fp = somme(a => a.falsePositives);

  return {
    images: annotations.length,
    carsDetectable: detectable,
    carsOrderCritical: critique,
    missed: rates,
    missedOrderCritical: ratesCritiques,
    truePositives: vp,
    falsePositives: fp,
    recall: detectable > 0 ? (detectable - rates) / detectable : null,
    precision: vp + fp > 0 ? vp / (vp + fp) : null,
    criticalRecall: critique > 0 ? (critique - ratesCritiques) / critique : null,
  };
}

/**
 * Règle de décision convenue. Elle porte sur l'ÉTAPE 1 seulement — la
 * détection — et ne dit rien de la fiabilité de l'ordre au premier virage,
 * qui dépend encore du suivi, de l'association et de l'ordonnancement.
 */
export function verdict(recall) {
  if (recall == null) return { code: 'inconnu', label: 'annotation incomplète' };
  if (recall >= 0.9) return { code: 'go', label: 'GO' };
  if (recall >= 0.8) return { code: 'go_assiste', label: 'GO assisté' };
  return { code: 'yolox_s', label: 'tester YOLOX-s sur exactement ces images' };
}
