/* ═══════════════════════════════════════════════
   CAMERAMODELS.TEST.JS — Modèles de mouvement apparent de la caméra

   Chaque scénario reproduit un mouvement de caméra PHYSIQUE et vérifie que
   l'arbitrage désigne le modèle qui lui correspond. Le juge n'est jamais le
   résidu d'ajustement — il décroît toujours quand on ajoute des paramètres —
   mais l'erreur laissée-de-côté.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  MODELES_CAMERA, ORDRE_MODELES, ajusterCamera, appliquerCamera,
  erreurLaisseeDeCote, comparerModeles,
} from '../tools/yolox-poc/lib/camera.mjs';

const B = (cx, cy, w) => [cx - w / 2, cy - w * 0.58 / 2, cx + w / 2, cy + w * 0.58 / 2];
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** Huit objets répartis en profondeur : proches et gros en bas, loin et petits en haut. */
const SCENE = [
  [200, 700, 220], [500, 620, 170], [800, 560, 140], [1100, 520, 115],
  [1400, 490, 95], [1650, 470, 80], [900, 600, 150], [1250, 505, 105],
];
const paires = (bouger) => SCENE.map(p => ({ avant: B(...p), apres: B(...bouger(p)) }));

const PANORAMIQUE = ([x, y, w]) => [x - 70, y, w];
const ZOOM = ([x, y, w]) => [960 + (x - 960) * 1.08, 540 + (y - 540) * 1.08, w * 1.08];
const TRAVELLING = ([x, y, w]) => [x - (w / 80) * 35, y, w];   // parallaxe : dépend de la profondeur

describe('physique du mouvement apparent', () => {
  it('un panoramique déplace tout le monde du MÊME vecteur', () => {
    // C'est une rotation : le déplacement apparent ne dépend pas de la
    // profondeur. Une translation globale est donc déjà le modèle exact, et
    // aucun raffinement ne peut faire mieux.
    const c = comparerModeles(paires(PANORAMIQUE));
    expect(c.recommande).toBe('globale');
    expect(c.resultats.globale.erreurLaisseeDeCote).toBeCloseTo(0, 1);
  });

  it('un zoom dépend de la position, en x AUTANT qu\'en y', () => {
    // D'où l'insuffisance d'une affine en y seul, et la pertinence d'une
    // similitude — translation, zoom et roulis — pour une caméra sur trépied.
    const c = comparerModeles(paires(ZOOM));
    expect(c.recommande).toBe('similitude');
    expect(c.resultats.similitude.erreurLaisseeDeCote)
      .toBeLessThan(c.resultats.affineY.erreurLaisseeDeCote);
    // Une translation globale est ici PIRE que de ne rien faire.
    expect(c.resultats.globale.erreurLaisseeDeCote)
      .toBeGreaterThan(c.resultats.aucune.erreurLaisseeDeCote);
  });

  it('un travelling crée un déplacement dépendant de la profondeur', () => {
    // Le seul cas où la taille de boîte, prise comme indice de profondeur,
    // apporte quelque chose qu'aucun modèle purement 2-D ne capture.
    const c = comparerModeles(paires(TRAVELLING));
    expect(['locale', 'affineY']).toContain(c.recommande);
    expect(c.resultats.locale.erreurLaisseeDeCote)
      .toBeLessThan(c.resultats.globale.erreurLaisseeDeCote);
  });
});

describe('erreurLaisseeDeCote', () => {
  it('démasque un modèle qui mémorise au lieu de généraliser', () => {
    // Huit paramètres pour cinq points : le résidu d'ajustement tombe à zéro
    // sans que le modèle ait rien compris. L'erreur laissée-de-côté le dit.
    const cinq = paires(PANORAMIQUE).slice(0, 5);
    expect(ajusterCamera(cinq, 'locale').suffisant).toBe(false);
    expect(erreurLaisseeDeCote(cinq, 'locale')).toBeNull();
  });

  it('refuse de se prononcer sans assez d\'appariements', () => {
    // « aucune » fait exception : c'est le modèle nul, toujours évaluable —
    // c'est même lui qui sert de référence aux autres.
    for (const id of ORDRE_MODELES.filter(x => x !== 'aucune')) {
      expect(erreurLaisseeDeCote(paires(PANORAMIQUE).slice(0, 2), id)).toBeNull();
    }
    expect(erreurLaisseeDeCote(paires(PANORAMIQUE).slice(0, 2), 'aucune')).toBeGreaterThan(0);
  });
});

describe('comparerModeles', () => {
  it('préfère le modèle le plus SIMPLE à gain comparable', () => {
    // Un gain de quelques pour cent ne justifie pas des paramètres
    // supplémentaires : il ne survivra pas au plan suivant.
    const c = comparerModeles(paires(PANORAMIQUE));
    expect(MODELES_CAMERA[c.recommande].params).toBeLessThanOrEqual(MODELES_CAMERA.affineY.params);
  });

  it('ne recommande rien quand il n\'y a rien à corriger', () => {
    const immobile = paires(([x, y, w]) => [x, y, w]);
    expect(comparerModeles(immobile).recommande).toBe('aucune');
  });
});

describe('ajusterCamera / appliquerCamera', () => {
  it('ramène la boîte prédite sur la détection, à un pixel près', () => {
    const p = paires(ZOOM);
    const modele = ajusterCamera(p, 'similitude');
    for (const { avant, apres } of p) {
      const corrige = appliquerCamera(modele, avant);
      const [ax, ay] = centre(corrige), [bx, by] = centre(apres);
      expect(Math.hypot(ax - bx, ay - by)).toBeLessThan(1);
    }
  });

  it('ne touche à rien quand le modèle n\'est pas exploitable', () => {
    const boite = B(500, 500, 160);
    expect(appliquerCamera(null, boite)).toEqual(boite);
    expect(appliquerCamera(ajusterCamera([], 'globale'), boite)).toEqual(boite);
  });

  it('conserve la taille de la boîte : une translation, pas une déformation', () => {
    const modele = ajusterCamera(paires(PANORAMIQUE), 'globale');
    const boite = B(500, 500, 160);
    const corrige = appliquerCamera(modele, boite);
    expect(corrige[2] - corrige[0]).toBeCloseTo(boite[2] - boite[0], 6);
  });

  it('résiste à un objet qui bouge vraiment parmi des objets immobiles', () => {
    // C'est tout l'enjeu : le modèle est ajusté sur des objets qui se
    // déplacent aussi d'eux-mêmes. La repondération doit rejeter l'intrus.
    const p = paires(PANORAMIQUE);
    p[3] = { avant: p[3].avant, apres: B(SCENE[3][0] + 250, SCENE[3][1], SCENE[3][2]) };
    const modele = ajusterCamera(p, 'globale');
    const [dx] = modele.deplacement(p[0].avant);
    expect(dx).toBeCloseTo(-70, 0);
  });
});
