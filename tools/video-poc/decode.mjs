/* ═══════════════════════════════════════════════
   DECODE.MJS — Post-traitement YOLOX, PUR et TESTÉ.

   Aucune dépendance : ni Node, ni navigateur, ni ONNX Runtime. Ce module
   reçoit le tenseur de sortie brut et rend des boîtes exploitables.

   C'est LA pièce que le POC doit dé-risquer : si la V1 se fait, ce fichier
   part tel quel dans `js/video/` et sert au navigateur sans modification.
   Il est donc écrit selon la convention maison — calcul pur d'un côté,
   entrées/sorties de l'autre (cf. js/calc.js, js/projection/*).

   ── Ce que produit l'export ONNX officiel de YOLOX ──────────────────────
   Vérifié sur `yolox_tiny.onnx` (release 0.1.1rc0, Megvii, Apache 2.0) :
     entrée  `images`  [1, 3, 416, 416]
     sortie  `output`  [1, 3549, 85]

   3549 = 52² + 26² + 13², soit les trois niveaux de la FPN aux pas 8, 16 et
   32, concaténés DANS CET ORDRE. 85 = 4 (boîte) + 1 (objectness) + 80 (COCO).

   Le script d'export met `decode_in_inference = False`, donc :
     • objectness et scores de classe ont DÉJÀ reçu leur sigmoïde ;
     • les coordonnées, elles, sont BRUTES et doivent être ramenées dans
       l'image : c'est le rôle de `decodeYolox()`.
   Appliquer une seconde sigmoïde aux scores est l'erreur classique : elle
   ne fait pas planter, elle écrase seulement toutes les confiances vers 0,5.
═══════════════════════════════════════════════ */

/** Pas des trois niveaux, dans l'ordre de concaténation du modèle. */
export const STRIDES = [8, 16, 32];

/** Les 80 classes COCO, dans l'ordre du modèle. */
export const COCO_CLASSES = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light',
  'fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow',
  'elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee',
  'skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard',
  'tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch',
  'potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard',
  'cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase',
  'scissors','teddy bear','hair drier','toothbrush',
];

/**
 * Classes retenues pour compter une « voiture ».
 *
 * `car` seul ne suffit pas : une voiture de rallycross, carrossée haut et
 * large, sort régulièrement en `truck`. Les exclure ferait chuter le rappel
 * pour une raison purement lexicale, sans rapport avec la capacité du
 * détecteur à voir l'objet.
 */
export const VEHICLE_CLASSES = ['car', 'truck', 'bus'];
export const VEHICLE_IDS = VEHICLE_CLASSES.map(n => COCO_CLASSES.indexOf(n));

// ─────────────────────────────────────────────────────────
// LETTERBOX
// ─────────────────────────────────────────────────────────

/**
 * Paramètres de la mise à l'échelle YOLOX.
 *
 * Attention à deux détails qui ne se voient pas : YOLOX **ne centre pas**
 * l'image dans le carré — elle est collée en HAUT À GAUCHE, le reste étant
 * rempli à 114. Et le rapport d'aspect est conservé. Centrer, ou étirer,
 * décale toutes les boîtes sans jamais produire d'erreur visible dans les
 * scores : le symptôme est un décalage systématique, pas une exception.
 *
 * @param {number} srcW @param {number} srcH
 * @param {number} netW @param {number} netH
 * @returns {{ratio:number, newW:number, newH:number}}
 */
export function letterboxParams(srcW, srcH, netW, netH) {
  const ratio = Math.min(netW / srcW, netH / srcH);
  return {
    ratio,
    newW: Math.round(srcW * ratio),
    newH: Math.round(srcH * ratio),
  };
}

// ─────────────────────────────────────────────────────────
// DÉCODAGE
// ─────────────────────────────────────────────────────────

/**
 * Transforme la sortie brute en boîtes, dans le repère de l'image
 * REDIMENSIONNÉE (pas encore celle d'origine — voir `toOriginal`).
 *
 * Pour chaque point d'ancrage (gx, gy) de pas `s` :
 *     cx = (brut₀ + gx) · s        w = exp(brut₂) · s
 *     cy = (brut₁ + gy) · s        h = exp(brut₃) · s
 *     score = objectness × probabilité de la meilleure classe
 *
 * @param {Float32Array} data — le tenseur `output` aplati
 * @param {number[]} dims — ses dimensions, [1, N, 85]
 * @param {object} [opts]
 * @param {number} [opts.netW=416] @param {number} [opts.netH=416]
 * @param {number} [opts.scoreThreshold=0.1] — crible précoce, avant la NMS
 * @param {number[]|null} [opts.classIds=null] — null = toutes les classes
 * @returns {Array<{x1,y1,x2,y2,score,classId,className}>}
 */
export function decodeYolox(data, dims, {
  netW = 416, netH = 416, scoreThreshold = 0.1, classIds = null,
} = {}) {
  const [, nAnchors, nAttrs] = dims;
  const nClasses = nAttrs - 5;
  const keep = classIds ? new Set(classIds) : null;

  // Table des ancres, reconstruite dans le MÊME ordre que le modèle :
  // niveau par niveau (pas croissant), et à l'intérieur d'un niveau,
  // ligne par ligne. Toute autre convention produit des boîtes plausibles
  // mais fausses — le pire des symptômes, parce qu'il n'alerte pas.
  const anchors = [];
  for (const s of STRIDES) {
    const gw = Math.floor(netW / s), gh = Math.floor(netH / s);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) anchors.push(gx, gy, s);
    }
  }
  if (anchors.length / 3 !== nAnchors) {
    throw new Error(
      `Grille incohérente : ${anchors.length / 3} ancres reconstruites pour ` +
      `${nAnchors} sorties. Vérifier la taille d'entrée (${netW}×${netH}) et les pas.`
    );
  }

  const out = [];
  for (let i = 0; i < nAnchors; i++) {
    const o = i * nAttrs;
    const objectness = data[o + 4];
    // Crible très en amont : inutile de chercher la meilleure classe sur une
    // ancre dont l'objectness ne pourra jamais atteindre le seuil.
    if (objectness < scoreThreshold) continue;

    let bestId = -1, bestProb = 0;
    for (let c = 0; c < nClasses; c++) {
      const p = data[o + 5 + c];
      if (p > bestProb) { bestProb = p; bestId = c; }
    }
    if (bestId < 0) continue;
    if (keep && !keep.has(bestId)) continue;

    const score = objectness * bestProb;
    if (score < scoreThreshold) continue;

    const gx = anchors[i * 3], gy = anchors[i * 3 + 1], s = anchors[i * 3 + 2];
    const cx = (data[o]     + gx) * s;
    const cy = (data[o + 1] + gy) * s;
    const w  = Math.exp(data[o + 2]) * s;
    const h  = Math.exp(data[o + 3]) * s;

    out.push({
      x1: cx - w / 2, y1: cy - h / 2,
      x2: cx + w / 2, y2: cy + h / 2,
      score, classId: bestId, className: COCO_CLASSES[bestId],
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// NMS
// ─────────────────────────────────────────────────────────

/** Intersection sur union de deux boîtes. */
export function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter);
}

/**
 * Groupe de NMS d'une détection.
 *
 * ── Pourquoi ce n'est PAS simplement la classe ──────────────────────────
 * Mesuré pendant le POC, sur l'image de référence de YOLOX : un même
 * pick-up reçoit DEUX boîtes quasi superposées, `car` à 70 % et `truck` à
 * 51 %. Une NMS strictement par classe les conserve toutes les deux, parce
 * qu'elles ne se concurrencent jamais.
 *
 * Or `car`, `truck` et `bus` désignent ici **la même chose** : une voiture
 * de course. Les laisser dans des couloirs séparés produirait un doublon
 * systématique par véhicule — précision divisée par deux, et deux
 * rectangles à trier pour l'opérateur là où un seul suffit.
 *
 * Ils partagent donc un couloir unique. Les autres classes gardent le leur :
 * une personne et une voiture qui se superposent sont deux objets réels.
 */
export function vehicleGroupOf(box) {
  return VEHICLE_IDS.includes(box.classId) ? 'vehicle' : box.classId;
}

/**
 * Suppression des non-maxima, par groupe.
 *
 * @param {Array} boxes
 * @param {number} [iouThreshold=0.45]
 * @param {(box:object)=>string|number} [groupOf] — couloir de concurrence.
 *        Par défaut la classe ; passer `vehicleGroupOf` pour fusionner
 *        car/truck/bus (voir ci-dessus).
 */
export function nms(boxes, iouThreshold = 0.45, groupOf = (b) => b.classId) {
  const groups = new Map();
  for (const b of boxes) {
    const g = groupOf(b);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  const kept = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.score - a.score);
    const alive = [];
    for (const cand of group) {
      if (alive.every(k => iou(cand, k) <= iouThreshold)) alive.push(cand);
    }
    kept.push(...alive);
  }
  return kept.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────
// RETOUR AU REPÈRE D'ORIGINE
// ─────────────────────────────────────────────────────────

/**
 * Ramène des boîtes du repère réseau vers celui de l'image d'origine, et
 * les borne à ses dimensions. Un objet coupé par le bord produit sinon des
 * coordonnées négatives, que l'affichage rendrait hors cadre.
 */
export function toOriginal(boxes, ratio, srcW, srcH) {
  return boxes.map(b => ({
    ...b,
    x1: Math.max(0,    b.x1 / ratio),
    y1: Math.max(0,    b.y1 / ratio),
    x2: Math.min(srcW, b.x2 / ratio),
    y2: Math.min(srcH, b.y2 / ratio),
  })).filter(b => b.x2 > b.x1 && b.y2 > b.y1);
}

/**
 * Conversion au format attendu par `videoPlayer.renderBoxes()` :
 * coordonnées NORMALISÉES 0..1, largeur/hauteur plutôt que coins.
 *
 * C'est ce qui rend le POC directement branchable : `js/videoPlayerCalc.js`
 * expose déjà `sanitizeBoxes()` et `projectBox()` sur exactement ce contrat.
 */
export function toNormalizedBoxes(boxes, srcW, srcH) {
  return boxes.map(b => ({
    x: b.x1 / srcW,
    y: b.y1 / srcH,
    width:  (b.x2 - b.x1) / srcW,
    height: (b.y2 - b.y1) / srcH,
    confidence: b.score,
    label: b.className,
    status: 'unknown',
  }));
}

/**
 * Chaîne complète : sortie brute → boîtes dans l'image d'origine.
 * @returns {Array<{x1,y1,x2,y2,score,classId,className}>}
 */
export function postprocess(data, dims, {
  srcW, srcH, netW = 416, netH = 416,
  scoreThreshold = 0.1, iouThreshold = 0.45, classIds = null,
  mergeVehicleClasses = true,
} = {}) {
  const { ratio } = letterboxParams(srcW, srcH, netW, netH);
  const raw = decodeYolox(data, dims, { netW, netH, scoreThreshold, classIds });
  const groupOf = mergeVehicleClasses ? vehicleGroupOf : undefined;
  return toOriginal(nms(raw, iouThreshold, groupOf), ratio, srcW, srcH);
}
