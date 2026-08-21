/* ═══════════════════════════════════════════════
   YOLOXDETECT.TEST.JS — Couche pure du banc de détection

   Couvre le pré-traitement géométrique, le décodage de la sortie du réseau,
   la fusion des classes véhicule et le calcul des mesures. Ne couvre PAS
   l'inférence elle-même : elle est vérifiée par comparaison avec
   l'implémentation de référence YOLOX (voir tools/yolox-poc/README.md).

   Le point le plus important de ce fichier est `mergeVehicleDetections` :
   sans elle, un même véhicule détecté à la fois en « car » et en « truck »
   compterait deux fois, ce qui gonflerait le rappel tout en ruinant la
   précision — exactement le genre de chiffre flatteur et faux qu'on refuse.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  INPUT_SIZE, MODELS, DEFAULT_MODEL, COCO_CLASSES, VEHICLE_CLASSES, VEHICLE_CLASS_IDS,
  anchorCount, assertAnchorCount,
  letterbox, buildGrids, decodeOutput, iou, mergeVehicleDetections,
  scoreImage, aggregate, verdict,
} from '../tools/yolox-poc/lib/detect.mjs';

describe('registre des modèles', () => {
  it('déclare tiny et s, avec des tailles d\'entrée DIFFÉRENTES', () => {
    // C'est le piège de l'ajout de YOLOX-s : tiny travaille en 416, s en 640.
    // Réutiliser 416 pour s ne lèverait aucune erreur, cela produirait
    // simplement des boîtes fausses.
    expect(Object.keys(MODELS).sort()).toEqual(['s', 'tiny']);
    expect(MODELS.tiny.inputSize).toBe(416);
    expect(MODELS.s.inputSize).toBe(640);
    expect(DEFAULT_MODEL).toBe('tiny');
    expect(INPUT_SIZE).toBe(MODELS.tiny.inputSize);
  });

  it('pointe sur des poids ONNX publiés par le projet YOLOX', () => {
    for (const m of Object.values(MODELS)) {
      expect(m.file).toMatch(/\.onnx$/);
      expect(m.url).toMatch(/^https:\/\/github\.com\/Megvii-BaseDetection\/YOLOX\//);
      expect(m.url.endsWith(m.file)).toBe(true);
    }
  });
});

describe('anchorCount / assertAnchorCount', () => {
  it('donne le nombre d\'ancres de chaque modèle', () => {
    expect(anchorCount(416)).toBe(3549);
    expect(anchorCount(640)).toBe(8400);
    expect(buildGrids(640).count).toBe(8400);
  });

  it('refuse une sortie qui ne correspond pas à la taille d\'entrée', () => {
    // Le cas exact qu'on veut rendre impossible : décoder les 8400 ancres de
    // YOLOX-s avec les grilles de 416, ou l'inverse.
    expect(() => assertAnchorCount(3549 * 85, 640)).toThrow(/incompatible/);
    expect(() => assertAnchorCount(8400 * 85, 416)).toThrow(/incompatible/);
  });

  it('accepte les couples cohérents', () => {
    expect(assertAnchorCount(3549 * 85, 416)).toBe(true);
    expect(assertAnchorCount(8400 * 85, 640)).toBe(true);
  });
});

describe('classes retenues', () => {
  it('ne garde que des véhicules', () => {
    expect(VEHICLE_CLASSES).toEqual(['car', 'truck', 'bus']);
    // Une voiture de rallycross n'existe pas dans COCO : le modèle hésite
    // entre ces trois-là selon l'angle. Tout le reste est du bruit ici.
    expect(VEHICLE_CLASSES).not.toContain('person');
    expect(VEHICLE_CLASS_IDS.every(i => i >= 0)).toBe(true);
    expect(VEHICLE_CLASS_IDS.map(i => COCO_CLASSES[i])).toEqual(VEHICLE_CLASSES);
  });
});

describe('letterbox', () => {
  it('conserve le ratio et cale l\'image en haut à gauche', () => {
    expect(letterbox(1920, 1080)).toMatchObject({ width: 416, height: 234 });
    expect(letterbox(1920, 1080).ratio).toBeCloseTo(416 / 1920, 6);
  });

  it('traite une image carrée sans marge', () => {
    expect(letterbox(416, 416)).toMatchObject({ ratio: 1, width: 416, height: 416 });
  });

  it('gère une image plus haute que large', () => {
    const b = letterbox(600, 1200);
    expect(b.height).toBe(416);
    expect(b.width).toBe(208);
  });
});

describe('buildGrids', () => {
  it('produit les 3549 ancres de YOLOX en 416', () => {
    const g = buildGrids(INPUT_SIZE);
    expect(g.count).toBe(52 * 52 + 26 * 26 + 13 * 13);
    expect(g.count).toBe(3549);
    expect(g.strides[0]).toBe(8);
    expect(g.strides[g.count - 1]).toBe(32);
  });

  it('parcourt chaque grille ligne par ligne', () => {
    const g = buildGrids(16, [8]);
    expect(g.gx).toEqual([0, 1, 0, 1]);
    expect(g.gy).toEqual([0, 0, 1, 1]);
  });
});

describe('decodeOutput', () => {
  /** Sortie brute où une seule ancre porte un objet. */
  function raw(anchor, { cx, cy, w, h, obj, classId, prob }) {
    const grids = buildGrids(INPUT_SIZE);
    const data = new Float32Array(grids.count * 85);
    const o = anchor * 85;
    data[o] = cx; data[o + 1] = cy; data[o + 2] = w; data[o + 3] = h;
    data[o + 4] = obj; data[o + 5 + classId] = prob;
    return { data, grids };
  }

  it('applique la grille, le pas et l\'exponentielle', () => {
    // Ancre 0 : grille (0,0), pas 8. Centre = (0.5 + 0) × 8 = 4.
    // Largeur = exp(0) × 8 = 8. Ratio 0.5 → tout est doublé dans l'image.
    const { data, grids } = raw(0, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 0.9, classId: 2, prob: 0.9 });
    const [d] = decodeOutput(data, grids, 0.5, { scoreThreshold: 0.5 });
    expect(d.label).toBe('car');
    expect(d.box.map(v => Math.round(v))).toEqual([0, 0, 16, 16]);
  });

  it('multiplie objectness et probabilité de classe', () => {
    const { data, grids } = raw(0, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 0.8, classId: 2, prob: 0.5 });
    const [d] = decodeOutput(data, grids, 1, { scoreThreshold: 0.1 });
    expect(d.score).toBeCloseTo(0.4, 6);
  });

  it('écarte ce qui est sous le seuil', () => {
    const { data, grids } = raw(0, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 0.8, classId: 2, prob: 0.5 });
    expect(decodeOutput(data, grids, 1, { scoreThreshold: 0.5 })).toEqual([]);
  });

  it('décode à l\'identique en 640, seule la grille change', () => {
    const grids = buildGrids(640);
    const data = new Float32Array(grids.count * 85);
    // Ancre 0 : grille (0,0), pas 8 — comme en 416.
    data[0] = 0.5; data[1] = 0.5; data[2] = 0; data[3] = 0;
    data[4] = 0.9; data[5 + 2] = 0.9;
    const [d] = decodeOutput(data, grids, 1, { scoreThreshold: 0.5 });
    expect(d.label).toBe('car');
    expect(d.box.map(v => Math.round(v))).toEqual([0, 0, 8, 8]);
  });

  it('ne renvoie que les classes demandées', () => {
    const { data, grids } = raw(0, { cx: 0.5, cy: 0.5, w: 0, h: 0, obj: 0.9, classId: 0, prob: 0.9 });
    expect(decodeOutput(data, grids, 1, { scoreThreshold: 0.3 })[0].label).toBe('person');
    expect(decodeOutput(data, grids, 1, { scoreThreshold: 0.3, classIds: VEHICLE_CLASS_IDS })).toEqual([]);
  });
});

describe('iou', () => {
  it('vaut 1 sur deux boîtes identiques, 0 sur deux disjointes', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
  it('mesure un recouvrement partiel', () => {
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150, 6);
  });
});

describe('mergeVehicleDetections', () => {
  // Cas MESURÉ sur l'image de référence de YOLOX : le même véhicule ressort
  // en « car » à 0,770 et en « truck » à 0,465.
  const reelles = [
    { label: 'car', score: 0.770, box: [470.4, 80.6, 688.3, 169.6] },
    { label: 'truck', score: 0.465, box: [473.0, 78.9, 689.9, 168.9] },
  ];

  it('fusionne un même véhicule vu sous deux classes', () => {
    const r = mergeVehicleDetections(reelles);
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('car');
    expect(r[0].score).toBe(0.770);
    // L'hésitation du modèle est une information, pas un déchet.
    expect(r[0].alsoDetectedAs).toEqual(['truck']);
    expect(r[0].suppressed).toBe(1);
  });

  it('garde deux véhicules distincts', () => {
    const r = mergeVehicleDetections([...reelles, { label: 'car', score: 0.6, box: [10, 10, 100, 100] }]);
    expect(r).toHaveLength(2);
  });

  it('conserve toujours le meilleur score, quel que soit l\'ordre d\'entrée', () => {
    const r = mergeVehicleDetections([...reelles].reverse());
    expect(r[0].score).toBe(0.770);
  });

  it('respecte le seuil d\'IoU', () => {
    const presque = [
      { label: 'car', score: 0.9, box: [0, 0, 100, 100] },
      { label: 'car', score: 0.8, box: [60, 0, 160, 100] },   // IoU = 0.25
    ];
    expect(mergeVehicleDetections(presque, 0.45)).toHaveLength(2);
    expect(mergeVehicleDetections(presque, 0.2)).toHaveLength(1);
  });

  it('ne modifie pas le tableau reçu', () => {
    const entree = [...reelles];
    mergeVehicleDetections(entree);
    expect(entree).toHaveLength(2);
    expect(entree[0].alsoDetectedAs).toBeUndefined();
  });
});

describe('scoreImage — mesures issues de l\'annotation humaine', () => {
  it('calcule rappel, précision et rappel critique', () => {
    const s = scoreImage({
      carsDetectable: 5, missed: 1, truePositives: 4, falsePositives: 1,
      carsOrderCritical: 3, missedOrderCritical: 0,
    });
    expect(s.recall).toBeCloseTo(0.8, 6);
    expect(s.precision).toBeCloseTo(0.8, 6);
    expect(s.criticalRecall).toBe(1);
    expect(s.coherent).toBe(true);
  });

  it('refuse de deviner tant que l\'annotation manque', () => {
    // Le modèle ne connaît pas la vérité terrain : sans annotation, il n'y a
    // pas de rappel, et surtout pas un rappel de 100 %.
    const s = scoreImage({ truePositives: 4, falsePositives: 0 });
    expect(s.recall).toBeNull();
    expect(s.criticalRecall).toBeNull();
    expect(s.precision).toBe(1);
  });

  it('signale une annotation qui se contredit', () => {
    const s = scoreImage({ carsDetectable: 5, missed: 1, truePositives: 2, falsePositives: 0 });
    expect(s.coherent).toBe(false);
  });

  it('distingue un rappel critique parfait d\'un rappel global imparfait', () => {
    // Rater la sixième voiture ne fausse pas l'ordre ; rater celle qui se
    // dispute la première place, si.
    const s = scoreImage({
      carsDetectable: 6, missed: 1, truePositives: 5, falsePositives: 0,
      carsOrderCritical: 2, missedOrderCritical: 0,
    });
    expect(s.recall).toBeCloseTo(5 / 6, 6);
    expect(s.criticalRecall).toBe(1);
  });
});

describe('aggregate', () => {
  it('somme les comptes au lieu de moyenner les taux', () => {
    // Une image à 6 voitures ne doit pas peser autant qu'une image à 2.
    const a = [
      { carsDetectable: 6, missed: 0, truePositives: 6, falsePositives: 0 },
      { carsDetectable: 2, missed: 1, truePositives: 1, falsePositives: 0 },
    ];
    const g = aggregate(a);
    expect(g.carsDetectable).toBe(8);
    expect(g.recall).toBeCloseTo(7 / 8, 6);       // 0.875, et non (1 + 0.5) / 2 = 0.75
  });

  it('ignore les champs absents sans casser', () => {
    const g = aggregate([{ truePositives: 3, falsePositives: 1 }]);
    expect(g.recall).toBeNull();
    expect(g.precision).toBeCloseTo(0.75, 6);
  });

  it('renvoie des zéros sur une liste vide', () => {
    expect(aggregate([])).toMatchObject({ images: 0, carsDetectable: 0, recall: null });
  });
});

describe('verdict', () => {
  it('applique la règle convenue', () => {
    expect(verdict(0.95).code).toBe('go');
    expect(verdict(0.9).code).toBe('go');
    expect(verdict(0.85).code).toBe('go_assiste');
    expect(verdict(0.8).code).toBe('go_assiste');
    expect(verdict(0.79).code).toBe('yolox_s');
  });

  it('ne tranche pas sans annotation', () => {
    expect(verdict(null).code).toBe('inconnu');
  });
});
