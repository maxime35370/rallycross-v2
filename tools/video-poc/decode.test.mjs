/* Tests du module pur — `node --test decode.test.mjs`.
   Ils portent sur ce qui casse silencieusement : l'ordre des ancres, la
   formule de décodage, le comportement par classe de la NMS, et le retour
   au repère d'origine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  letterboxParams, decodeYolox, nms, iou, toOriginal, toNormalizedBoxes,
  vehicleGroupOf, STRIDES, COCO_CLASSES, VEHICLE_IDS,
} from './decode.mjs';

const N_ATTRS = 85;
const N_ANCHORS = 52 * 52 + 26 * 26 + 13 * 13;   // 3549

/** Fabrique un tenseur nul, puis y place une détection à l'ancre voulue. */
function makeTensor(entries = []) {
  const data = new Float32Array(N_ANCHORS * N_ATTRS);
  for (const e of entries) {
    const o = e.index * N_ATTRS;
    data[o] = e.dx; data[o + 1] = e.dy; data[o + 2] = e.lw; data[o + 3] = e.lh;
    data[o + 4] = e.obj;
    data[o + 5 + e.classId] = e.cls;
  }
  return data;
}

test('la grille reconstruite a exactement 3549 ancres', () => {
  const total = STRIDES.reduce((s, st) => s + (416 / st) ** 2, 0);
  assert.equal(total, N_ANCHORS);
  assert.doesNotThrow(() => decodeYolox(makeTensor(), [1, N_ANCHORS, N_ATTRS], {}));
});

test('une taille d\'entrée incohérente échoue au lieu de produire des boîtes fausses', () => {
  assert.throws(
    () => decodeYolox(makeTensor(), [1, 999, N_ATTRS], {}),
    /Grille incohérente/,
  );
});

test('décodage : centre et taille au pas 8, première ancre', () => {
  // index 0 → niveau pas 8, gx = 0, gy = 0
  const data = makeTensor([{ index: 0, dx: 0.5, dy: 0.25, lw: 0, lh: 0, obj: 0.9, cls: 0.8, classId: 2 }]);
  const [b] = decodeYolox(data, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1 });
  // cx = (0.5 + 0) * 8 = 4 ; cy = (0.25 + 0) * 8 = 2 ; w = h = exp(0) * 8 = 8
  assert.equal((b.x1 + b.x2) / 2, 4);
  assert.equal((b.y1 + b.y2) / 2, 2);
  assert.equal(b.x2 - b.x1, 8);
  assert.equal(b.className, 'car');
  assert.ok(Math.abs(b.score - 0.72) < 1e-6, 'score = objectness × classe');
});

test('l\'ordre des niveaux est bien 8 puis 16 puis 32', () => {
  // Première ancre du niveau 16 : juste après les 52×52 du niveau 8.
  const idx16 = 52 * 52;
  const data = makeTensor([{ index: idx16, dx: 0, dy: 0, lw: 0, lh: 0, obj: 0.9, cls: 0.9, classId: 2 }]);
  const [b] = decodeYolox(data, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1 });
  assert.equal(b.x2 - b.x1, 16, 'la boîte doit porter le pas 16, pas 8');
  assert.equal((b.x1 + b.x2) / 2, 0);

  // Première ancre du niveau 32.
  const idx32 = 52 * 52 + 26 * 26;
  const d2 = makeTensor([{ index: idx32, dx: 0, dy: 0, lw: 0, lh: 0, obj: 0.9, cls: 0.9, classId: 2 }]);
  const [b2] = decodeYolox(d2, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1 });
  assert.equal(b2.x2 - b2.x1, 32);
});

test('à l\'intérieur d\'un niveau, l\'ordre est ligne par ligne', () => {
  // index 53 au pas 8 → gx = 1, gy = 1 (52 colonnes par ligne)
  const data = makeTensor([{ index: 53, dx: 0, dy: 0, lw: 0, lh: 0, obj: 0.9, cls: 0.9, classId: 2 }]);
  const [b] = decodeYolox(data, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1 });
  assert.equal((b.x1 + b.x2) / 2, 8, 'gx = 1 → cx = 8');
  assert.equal((b.y1 + b.y2) / 2, 8, 'gy = 1 → cy = 8');
});

test('le filtre de classes ne laisse passer que les véhicules', () => {
  const data = makeTensor([
    { index: 0,  dx: 0, dy: 0, lw: 0, lh: 0, obj: 0.9, cls: 0.9, classId: 0 },  // person
    { index: 10, dx: 0, dy: 0, lw: 0, lh: 0, obj: 0.9, cls: 0.9, classId: 2 },  // car
  ]);
  const all = decodeYolox(data, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1 });
  const veh = decodeYolox(data, [1, N_ANCHORS, N_ATTRS], { scoreThreshold: 0.1, classIds: VEHICLE_IDS });
  assert.equal(all.length, 2);
  assert.equal(veh.length, 1);
  assert.equal(veh[0].className, 'car');
});

test('letterbox : rapport conservé, jamais d\'agrandissement au-delà du cadre', () => {
  const p = letterboxParams(1920, 1080, 416, 416);
  assert.ok(Math.abs(p.ratio - 416 / 1920) < 1e-9);
  assert.equal(p.newW, 416);
  assert.equal(p.newH, 234);
});

test('IoU : identiques = 1, disjointes = 0', () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), 0);
  // moitié recouverte : inter 50, union 150
  assert.ok(Math.abs(iou(a, { x1: 5, y1: 0, x2: 15, y2: 10 }) - 50 / 150) < 1e-9);
});

test('la NMS agit PAR CLASSE — deux voitures côte à côte survivent si elles sont de classes différentes', () => {
  const car   = { x1: 0, y1: 0, x2: 10, y2: 10, score: 0.9, classId: 2 };
  const truck = { x1: 1, y1: 0, x2: 11, y2: 10, score: 0.8, classId: 7 };
  const car2  = { x1: 1, y1: 0, x2: 11, y2: 10, score: 0.8, classId: 2 };
  assert.equal(nms([car, truck], 0.45).length, 2, 'classes différentes → les deux restent');
  assert.equal(nms([car, car2], 0.45).length, 1, 'même classe et fort recouvrement → une seule');
});

test('retour au repère d\'origine et bornage aux dimensions de l\'image', () => {
  const boxes = [{ x1: -10, y1: -10, x2: 208, y2: 208, score: 0.9, classId: 2 }];
  const [b] = toOriginal(boxes, 0.5, 800, 600);
  assert.equal(b.x1, 0, 'les coordonnées négatives sont ramenées au bord');
  assert.equal(b.y1, 0);
  assert.equal(b.x2, 416);
  assert.equal(b.y2, 416);
});

test('les boîtes normalisées respectent le contrat de videoPlayer.renderBoxes()', () => {
  const [b] = toNormalizedBoxes(
    [{ x1: 100, y1: 50, x2: 300, y2: 200, score: 0.77, className: 'car' }], 1000, 500,
  );
  assert.deepEqual(
    { x: b.x, y: b.y, width: b.width, height: b.height },
    { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
  );
  assert.equal(b.confidence, 0.77);
  assert.equal(b.status, 'unknown');
});

test('la table COCO est complète et « car » est bien à l\'indice 2', () => {
  assert.equal(COCO_CLASSES.length, 80);
  assert.equal(COCO_CLASSES[2], 'car');
  assert.deepEqual(VEHICLE_IDS, [2, 7, 5]);
});

test('car/truck/bus partagent un couloir de NMS — le doublon de classe disparaît', () => {
  // Cas RÉELLEMENT observé pendant le POC : un pick-up sort en `car` 70 %
  // ET en `truck` 51 %, boîtes quasi superposées.
  const car   = { x1: 0,  y1: 0, x2: 100, y2: 60, score: 0.70, classId: 2 };
  const truck = { x1: 2,  y1: 1, x2: 102, y2: 61, score: 0.51, classId: 7 };
  assert.equal(nms([car, truck], 0.45).length, 2, 'par classe : le doublon survit');
  const merged = nms([car, truck], 0.45, vehicleGroupOf);
  assert.equal(merged.length, 1, 'groupe véhicule : un seul rectangle');
  assert.equal(merged[0].classId, 2, 'le plus sûr est conservé');
});

test('la fusion des classes véhicule n\'affecte pas les autres objets', () => {
  // Une personne DEVANT une voiture : deux objets réels, deux boîtes.
  const car    = { x1: 0, y1: 0, x2: 100, y2: 60, score: 0.90, classId: 2 };
  const person = { x1: 5, y1: 2, x2: 95,  y2: 58, score: 0.80, classId: 0 };
  assert.equal(nms([car, person], 0.45, vehicleGroupOf).length, 2);
});

test('deux voitures côte à côte peu recouvrantes survivent à la fusion', () => {
  // Le cas du premier virage : concurrents flanc contre flanc, IoU modérée.
  const a = { x1: 0,  y1: 0, x2: 100, y2: 60, score: 0.9, classId: 2 };
  const b = { x1: 70, y1: 0, x2: 170, y2: 60, score: 0.8, classId: 7 };
  assert.ok(iou(a, b) < 0.45, 'IoU sous le seuil');
  assert.equal(nms([a, b], 0.45, vehicleGroupOf).length, 2);
});
