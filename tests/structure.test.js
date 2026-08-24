/* NIVEAU DE REPRÉSENTATION — ce que les données supportent réellement.

   Les cas sont construits pour que la réponse soit connue d'avance : un nuage
   plan tourné garde un rang 2, un nuage volumique vu sous plusieurs angles
   monte à 3, et un peloton où l'on se double n'est plus rigide du tout. */

import { describe, it, expect } from 'vitest';
import {
  METHODE_STRUCTURE, matriceMesure, valeursSingulieres, spectre,
  homographie, appliquerH, normaliser, comparerModelesGeometriques,
  similitudeMoindresCarres, appliquerSim, rigidite, repereGroupe,
} from '../tools/yolox-poc/lib/structure.mjs';

/** Projette un nuage 3D par une caméra affine d'angles donnés. */
const projeter = (pts3, theta, phi, echelle = 1) => pts3.map(([x, y, z]) => [
  echelle * (x * Math.cos(theta) - z * Math.sin(theta)),
  echelle * (y * Math.cos(phi) + (x * Math.sin(theta) + z * Math.cos(theta)) * Math.sin(phi)),
]);

const NUAGE_PLAN = [[0, 0, 0], [200, 30, 0], [400, -10, 0], [600, 40, 0], [800, 5, 0]];
const NUAGE_VOLUME = [[0, 0, 0], [200, 30, 150], [400, -10, -120], [600, 40, 90], [800, 5, -60]];

describe('rang de la matrice de mesure', () => {
  it('vaut 2 pour un nuage PLAN vu sous plusieurs angles', () => {
    const vues = [0, 0.2, 0.4, 0.6].map(t => projeter(NUAGE_PLAN, t, 0.3, 1));
    const m = matriceMesure(vues);
    const s = spectre(valeursSingulieres(m.W));
    // Toute l'énergie tient dans les deux premières composantes.
    expect(s.residuApres2).toBeLessThan(1e-6);
    expect(s.rang).toBeLessThanOrEqual(2);
    expect(s.troisSurUn).toBeLessThan(1e-6);            // aucune 3ᵉ dimension
  });

  it('monte à 3 pour un nuage VOLUMIQUE vu sous plusieurs angles', () => {
    // Des angles franchement différents : c'est la ROTATION en profondeur
    // qui révèle la troisième dimension. Vue sous un seul angle, une sculpture
    // est indiscernable de son ombre.
    const vues = [0, 0.6, 1.2, 1.8].map(t => projeter(NUAGE_VOLUME, t, 0.5, 1));
    const s = spectre(valeursSingulieres(matriceMesure(vues).W));
    // σ₃ porte quelque chose et σ₄ est nulle : c'est la signature d'un rang 3.
    // Son POIDS en énergie reste minime — c'est pourquoi le décrochage, et
    // non l'énergie cumulée, est le bon juge.
    expect(s.decrochage3).toBeGreaterThan(1000);   // six ordres de grandeur d’écart
    expect(s.troisSurUn).toBeGreaterThan(1e-3);
    expect(s.residuApres3).toBeLessThan(1e-6);
  });

  it('ne descend PAS quand le nuage se déforme — rien à factoriser', () => {
    // Un peloton où une voiture en double une autre : la structure change.
    const vues = [];
    for (let k = 0; k < 8; k++) {
      vues.push(NUAGE_PLAN.map(([x, y], i) => [x + (i === 1 ? 90 * k : 0), y, 0])
        .map(([x, y]) => [x, y]));
    }
    const s = spectre(valeursSingulieres(matriceMesure(vues).W));
    expect(s.residuApres2).toBeGreaterThan(0);
  });

  it('refuse une matrice mal formée plutôt que de rendre un chiffre creux', () => {
    expect(matriceMesure([])).toBeNull();
    expect(matriceMesure([[[0, 0], [1, 1]]])).toBeNull();             // 2 points
    expect(matriceMesure([[[0, 0], [1, 1], [2, 2]], [[0, 0]]])).toBeNull();  // tailles différentes
  });
});

describe('homographie', () => {
  it('reconstruit exactement une homographie connue', () => {
    const H0 = [[1.2, 0.1, 30], [-0.05, 0.9, -20], [0.0002, 0.0001, 1]];
    const A = [[0, 0], [100, 0], [100, 80], [0, 80], [50, 40]];
    const B = A.map(p => appliquerH(H0, p));
    const nA = normaliser(A), nB = normaliser(B);
    const H = homographie(A.map((p, i) => [nA.appliquer(p), nB.appliquer(B[i])]));
    for (let i = 0; i < A.length; i++) {
      const q = nB.inverse(appliquerH(H, nA.appliquer(A[i])));
      expect(q[0]).toBeCloseTo(B[i][0], 3);
      expect(q[1]).toBeCloseTo(B[i][1], 3);
    }
  });

  it('refuse moins de quatre correspondances', () => {
    expect(homographie([[[0, 0], [1, 1]], [[1, 0], [2, 1]], [[0, 1], [1, 2]]])).toBeNull();
  });
});

describe('similitude et homographie mises en concurrence', () => {
  it('l\'homographie ne gagne rien quand une similitude explique tout', () => {
    const A = [[0, 0], [200, 30], [400, -10], [600, 40], [800, 5]];
    const s = { m: [1.3, 0.7], ca: [0, 0], cb: [500, 200] };
    const B = A.map(p => appliquerSim(s, p));
    const r = comparerModelesGeometriques(A, B);
    // Les deux expliquent parfaitement : le gain est nul ou négatif.
    expect(r.similitude.medianeHorsAjustement).toBeLessThan(1e-3);
    expect(r.gainHomographie).toBeLessThan(1e-3);
  });

  it('exige au moins cinq points — sans quoi il n\'y a rien à laisser de côté', () => {
    expect(comparerModelesGeometriques([[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [2, 0], [0, 2], [2, 2]])).toBeNull();
  });
});

describe('rigidité du groupe', () => {
  it('vaut zéro pour une figure rigide, quelle que soit la caméra', () => {
    const vues = [0, 0.3, 0.6].map(t => projeter(NUAGE_PLAN, t, 0.2, 1 + t));
    const r = rigidite(vues);
    expect(r.cvMedian).toBeLessThan(0.05);
  });

  it('monte franchement dès qu\'une voiture en dépasse une autre', () => {
    const vues = [];
    for (let k = 0; k < 8; k++) vues.push(NUAGE_PLAN.map(([x, y], i) => [x + (i === 1 ? 100 * k : 0), y]));
    expect(rigidite(vues).cvMax).toBeGreaterThan(0.2);
  });
});

describe('méthode', () => {
  it('est identifiée dans le module', () => {
    expect(METHODE_STRUCTURE).toBe('rang-svd+homographie/1');
  });
});

describe('repère du groupe — l\'état monde au niveau ①', () => {
  const REF = new Map([[1, [0, 0]], [2, [200, 30]], [3, [400, -10]], [4, [600, 40]], [5, [800, 5]]]);

  it('retrouve les positions de référence quand la caméra bouge', () => {
    // Le même groupe, vu avec un zoom, une rotation et un décalage.
    const s = { m: [1.7, 0.9], ca: [0, 0], cb: [1200, 700] };
    const observees = [...REF].map(([id, p]) => ({ id, point: appliquerSim(s, p) }));
    const r = repereGroupe(REF, observees);
    for (const [id, attendu] of REF) {
      const p = r.positions.get(id);
      expect(p[0]).toBeCloseTo(attendu[0], 6);
      expect(p[1]).toBeCloseTo(attendu[1], 6);
    }
    expect(r.residuMoyen).toBeLessThan(1e-6);
  });

  it('estime la caméra : échelle, orientation, centre', () => {
    const s = { m: [2, 0], ca: [0, 0], cb: [500, 300] };
    const observees = [...REF].map(([id, p]) => ({ id, point: appliquerSim(s, p) }));
    const r = repereGroupe(REF, observees);
    expect(r.camera.echelle).toBeCloseTo(2, 3);
    expect(Math.abs(r.camera.angleDeg)).toBeLessThan(0.01);
  });

  it('place aussi une voiture ABSENTE de la référence, sans la refuser', () => {
    const s = { m: [1.2, 0.3], ca: [0, 0], cb: [100, 50] };
    const observees = [...REF].map(([id, p]) => ({ id, point: appliquerSim(s, p) }));
    observees.push({ id: 9, point: appliquerSim(s, [1000, 20]) });   // une sixième voiture
    const r = repereGroupe(REF, observees);
    expect(r.positions.get(9)[0]).toBeCloseTo(1000, 4);
    expect(r.appuis).toBe(5);          // seules les cinq connues servent d'appui
  });

  it('refuse avec moins de deux appuis plutôt que d\'inventer un repère', () => {
    expect(repereGroupe(REF, [{ id: 1, point: [0, 0] }])).toBeNull();
    expect(repereGroupe(REF, [{ id: 77, point: [0, 0] }, { id: 78, point: [9, 9] }])).toBeNull();
  });
});
