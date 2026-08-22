/* ═══════════════════════════════════════════════
   APPARENCESIGNATURE.TEST.JS — Sonde d'apparence, logique pure

   La sonde ne décide de rien : elle mesure si les livrées sont séparables.
   Ces tests vérifient donc surtout qu'elle ne PRÉTEND pas séparer ce qui ne
   l'est pas — un histogramme qui déclarerait deux voitures identiques
   « différentes » ferait prendre une mauvaise décision d'architecture.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  PROFIL, TAILLE_SIGNATURE, rgbVersHsv, signature, distance, moyenner,
  separabilite, traverseeDeCoupure, signatureImage, detecterCoupures,
  comparerGroupes, METHODE_APPARENCE, distanceMemoire, tailler, evaluerAppariement,
} from '../tools/yolox-poc/lib/apparence.mjs';

/** Image RGBA unie, dans laquelle on peint des rectangles. */
function image(w, h, [r, g, b] = [0, 0, 0]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
  return px;
}
function peindre(px, w, [x1, y1, x2, y2], [r, g, b]) {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

describe('conversion de couleur', () => {
  it('place le rouge, le vert et le bleu à un tiers de tour les uns des autres', () => {
    expect(rgbVersHsv(255, 0, 0)[0]).toBeCloseTo(0, 3);
    expect(rgbVersHsv(0, 255, 0)[0]).toBeCloseTo(1 / 3, 3);
    expect(rgbVersHsv(0, 0, 255)[0]).toBeCloseTo(2 / 3, 3);
  });

  it('donne une saturation nulle au gris, quelle que soit sa clarté', () => {
    expect(rgbVersHsv(128, 128, 128)[1]).toBe(0);
    expect(rgbVersHsv(240, 240, 240)[1]).toBe(0);
  });
});

describe('signature d\'une boîte', () => {
  const W = 200, H = 200;

  it('somme à 1 et a la longueur annoncée', () => {
    const px = peindre(image(W, H), W, [50, 50, 150, 150], [220, 30, 30]);
    const s = signature(px, W, H, [50, 50, 150, 150]);
    expect(s).toHaveLength(TAILLE_SIGNATURE);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });

  it('sépare deux livrées de teintes opposées', () => {
    const rouge = signature(peindre(image(W, H), W, [50, 50, 150, 150], [220, 30, 30]), W, H, [50, 50, 150, 150]);
    const bleu = signature(peindre(image(W, H), W, [50, 50, 150, 150], [30, 30, 220]), W, H, [50, 50, 150, 150]);
    expect(distance(rouge, bleu)).toBeGreaterThan(0.9);
  });

  it('sépare le blanc du noir, que la teinte ne distingue pas', () => {
    // C'est le cas qui condamne un histogramme de teinte seule : sans le
    // canal « achromatique », deux livrées sur cinq tomberaient dans le même
    // seau. En rallycross, blanc et noir sont des livrées courantes.
    const blanc = signature(peindre(image(W, H), W, [50, 50, 150, 150], [245, 245, 245]), W, H, [50, 50, 150, 150]);
    const noir = signature(peindre(image(W, H), W, [50, 50, 150, 150], [20, 20, 20]), W, H, [50, 50, 150, 150]);
    expect(distance(blanc, noir)).toBeGreaterThan(0.9);
  });

  it('distingue deux livrées de MÊMES couleurs mais d\'agencement inversé', () => {
    // Sans zonage, ces deux boîtes auraient exactement le même histogramme.
    const haut = image(W, H);
    peindre(haut, W, [50, 50, 150, 100], [220, 30, 30]);
    peindre(haut, W, [50, 100, 150, 150], [30, 30, 220]);
    const bas = image(W, H);
    peindre(bas, W, [50, 50, 150, 100], [30, 30, 220]);
    peindre(bas, W, [50, 100, 150, 150], [220, 30, 30]);
    const a = signature(haut, W, H, [50, 50, 150, 150]);
    const b = signature(bas, W, H, [50, 50, 150, 150]);
    expect(distance(a, b)).toBeGreaterThan(0.5);
  });

  it('reste proche d\'elle-même quand la boîte est décalée de quelques pixels', () => {
    const px = peindre(image(W, H), W, [40, 40, 160, 160], [220, 140, 20]);
    const a = signature(px, W, H, [50, 50, 150, 150]);
    const b = signature(px, W, H, [56, 54, 156, 154]);
    expect(distance(a, b)).toBeLessThan(0.2);
  });

  it('rogne les bords, pour ne pas mesurer le décor', () => {
    // Fond vert vif tout autour, voiture rouge au centre : la marge doit
    // empêcher le fond d'entrer dans la signature.
    const px = image(W, H, [0, 200, 0]);
    peindre(px, W, [60, 60, 140, 140], [220, 30, 30]);
    const s = signature(px, W, H, [50, 50, 150, 150]);
    const plein = signature(peindre(image(W, H), W, [50, 50, 150, 150], [220, 30, 30]), W, H, [50, 50, 150, 150]);
    expect(distance(s, plein)).toBeLessThan(0.35);
  });

  it('refuse une boîte trop petite plutôt que de rendre du bruit', () => {
    expect(signature(image(W, H), W, H, [10, 10, 14, 14])).toBeNull();
    expect(signature(image(W, H), W, H, [10, 10, 10, 10])).toBeNull();
  });
});

describe('distance et moyenne', () => {
  it('vaut zéro entre une signature et elle-même', () => {
    const px = peindre(image(100, 100), 100, [20, 20, 80, 80], [200, 50, 50]);
    const s = signature(px, 100, 100, [20, 20, 80, 80]);
    expect(distance(s, s)).toBe(0);
  });

  it('renvoie null plutôt que de comparer ce qui n\'est pas comparable', () => {
    expect(distance(null, [0.5, 0.5])).toBeNull();
    expect(distance([1], [0.5, 0.5])).toBeNull();
  });

  it('pondère les observations récentes plus fort que les anciennes', () => {
    const a = [1, 0], b = [0, 1];
    const m = moyenner([a, a, a, b]);
    expect(m[1]).toBeGreaterThan(0.25);   // la dernière pèse plus qu'un quart
    expect(m[0] + m[1]).toBeCloseTo(1, 3);
  });

  it('ignore les observations absentes', () => {
    expect(moyenner([null, [1, 0], null])).toEqual([1, 0]);
    expect(moyenner([null, null])).toBeNull();
  });
});

describe('pouvoir séparateur mesuré', () => {
  const sig = (a, b) => [a, b];

  it('reconnaît des pistes franchement distinctes', () => {
    const obs = [];
    for (const t of [0, 1, 2, 3]) {
      obs.push({ t, id: 1, sig: sig(0.95, 0.05) });
      obs.push({ t, id: 2, sig: sig(0.05, 0.95) });
    }
    const s = separabilite(obs);
    expect(s.tauxPlusProche).toBe(1);
    expect(s.contraste).toBeGreaterThan(1);
  });

  it('n\'affirme rien quand deux pistes se ressemblent', () => {
    // Deux livrées quasi identiques, avec du bruit : la sonde doit le DIRE,
    // pas produire un taux flatteur. C'est le résultat qui interdirait de
    // câbler l'apparence dans l'association.
    const obs = [];
    for (const t of [0, 1, 2, 3, 4, 5]) {
      const bruit = ((t * 7) % 5) / 100;
      obs.push({ t, id: 1, sig: sig(0.5 + bruit, 0.5 - bruit) });
      obs.push({ t, id: 2, sig: sig(0.5 - bruit, 0.5 + bruit) });
    }
    const s = separabilite(obs);
    expect(s.contraste).toBeLessThan(2);
    expect(s.margeMediane).toBeLessThan(0.1);
  });

  it('ne laisse pas une observation se reconnaître elle-même', () => {
    // Une piste vue une seule fois ne peut pas servir de référence à
    // elle-même : sans cette exclusion, le taux vaudrait 100 % par construction.
    const obs = [
      { t: 0, id: 1, sig: sig(1, 0) }, { t: 1, id: 1, sig: sig(0, 1) },
      { t: 0, id: 2, sig: sig(0, 1) }, { t: 1, id: 2, sig: sig(1, 0) },
    ];
    expect(separabilite(obs).tauxPlusProche).toBe(0);
  });

  it('ignore les observations sans signature', () => {
    const s = separabilite([{ t: 0, id: 1, sig: null }, { t: 0, id: 2, sig: sig(1, 0) }]);
    expect(s.observations).toBe(1);
  });
});

describe('traversée d\'une coupure', () => {
  it('rend l\'appariement optimal des identités d\'avant vers celles d\'après', () => {
    const obs = [
      { t: 0, id: 1, sig: [1, 0, 0] }, { t: 0.5, id: 1, sig: [0.9, 0.1, 0] },
      { t: 0, id: 2, sig: [0, 1, 0] }, { t: 0.5, id: 2, sig: [0, 0.9, 0.1] },
      { t: 1.5, id: 7, sig: [0, 0.95, 0.05] },   // c'est l'ancienne 2
      { t: 1.5, id: 8, sig: [0.95, 0.05, 0] },   // c'est l'ancienne 1
    ];
    const r = traverseeDeCoupure(obs, 1.0, { fenetre: 1.0 });
    const lien = Object.fromEntries(r.paires.map(p => [p.avant, p.apres]));
    expect(lien).toEqual({ 1: 8, 2: 7 });
    expect(r.coherence).toBe(1);
  });

  it('rend une marge faible quand le choix n\'est pas tranché', () => {
    const obs = [
      { t: 0, id: 1, sig: [0.5, 0.5] }, { t: 0, id: 2, sig: [0.5, 0.5] },
      { t: 1.5, id: 7, sig: [0.5, 0.5] }, { t: 1.5, id: 8, sig: [0.5, 0.5] },
    ];
    const r = traverseeDeCoupure(obs, 1.0);
    expect(r.paires.every(p => p.marge === 0)).toBe(true);
  });

  it('ne rend aucune paire si un côté de la coupure est vide', () => {
    const r = traverseeDeCoupure([{ t: 0, id: 1, sig: [1, 0] }], 1.0);
    expect(r.paires).toEqual([]);
  });
});

describe('profil', () => {
  it('garde un canal achromatique, sans quoi blanc et noir se confondraient', () => {
    expect(PROFIL.binsValeur).toBeGreaterThanOrEqual(2);
    expect(PROFIL.zones).toBeGreaterThanOrEqual(2);
  });
});

describe('changements de plan mesurés sur l\'image', () => {
  const W = 160, H = 120;
  /** Image « scène » : bandes horizontales de teintes données. */
  const scene = (teintes) => {
    const px = image(W, H);
    const bande = Math.ceil(H / teintes.length);
    teintes.forEach((c, i) => peindre(px, W, [0, i * bande, W, Math.min(H, (i + 1) * bande)], c));
    return px;
  };
  const sig = (px) => signatureImage(px, W, H, { pas: 1 });

  it('distingue deux scènes différentes, et reconnaît la même', () => {
    const a = sig(scene([[200, 40, 40], [40, 160, 40], [60, 60, 200]]));
    const b = sig(scene([[200, 40, 40], [40, 160, 40], [60, 60, 200]]));
    const c = sig(scene([[60, 60, 200], [200, 200, 40], [30, 30, 30]]));
    expect(distance(a, b)).toBe(0);
    expect(distance(a, c)).toBeGreaterThan(0.5);
  });

  it('voit la RÉPARTITION, pas seulement les couleurs présentes', () => {
    // Mêmes couleurs, ordre inversé : un histogramme global ne verrait rien.
    // Deux plans d'une même course partagent bitume, herbe et ciel — c'est
    // leur place dans le cadre qui change.
    const a = sig(scene([[200, 40, 40], [40, 160, 40]]));
    const b = sig(scene([[40, 160, 40], [200, 40, 40]]));
    expect(distance(a, b)).toBeGreaterThan(0.5);
  });

  it('signale une coupure isolée', () => {
    const A = sig(scene([[200, 40, 40], [40, 160, 40]]));
    const Bq = sig(scene([[40, 40, 200], [220, 220, 40]]));
    const serie = [0, 1, 2, 3].map(t => ({ t, sig: A }))
      .concat([4, 5, 6, 7].map(t => ({ t, sig: Bq })));
    const { coupures } = detecterCoupures(serie);
    expect(coupures.map(c => c.t)).toEqual([4]);
  });

  it('ne signale rien sur un panoramique, si rapide soit-il', () => {
    // Un panoramique fait monter TOUT le voisinage : la distance est grande à
    // chaque pas, donc aucun pas n'est un pic isolé. C'est le faux positif
    // que le détecteur fondé sur le comportement du suivi ne savait pas éviter.
    const serie = [];
    for (let t = 0; t < 12; t++) {
      const px = image(W, H);
      // le décor défile : la bande colorée traverse le cadre
      const x = (t * 22) % W;
      peindre(px, W, [0, 0, W, H], [30, 120, 30]);
      peindre(px, W, [x, 0, Math.min(W, x + 40), H], [210, 60, 40]);
      serie.push({ t, sig: sig(px) });
    }
    expect(detecterCoupures(serie).coupures).toEqual([]);
  });

  it('ne signale rien sur une scène fixe qui frémit', () => {
    const serie = [];
    for (let t = 0; t < 12; t++) {
      const px = scene([[200, 40, 40], [40, 160, 40]]);
      peindre(px, W, [t % 3, 0, (t % 3) + 2, 4], [255, 255, 255]);   // bruit minuscule
      serie.push({ t, sig: sig(px) });
    }
    expect(detecterCoupures(serie).coupures).toEqual([]);
  });

  it('rend la série de distances, pour que le seuil soit relisible', () => {
    const A = sig(scene([[200, 40, 40]]));
    const { distances } = detecterCoupures([{ t: 0, sig: A }, { t: 1, sig: A }, { t: 2, sig: A }]);
    expect(distances).toHaveLength(2);
    expect(distances[0]).toHaveProperty('t');
    expect(distances[0]).toHaveProperty('d');
  });

  it('supporte une série trop courte pour conclure', () => {
    expect(detecterCoupures([]).coupures).toEqual([]);
    expect(detecterCoupures([{ t: 0, sig: [1, 0] }]).coupures).toEqual([]);
  });
});

describe('comparaison de deux groupes de part et d\'autre d\'une coupure', () => {
  const g = (id, ...v) => ({ id, sig: v });

  it('rend la matrice complète, le meilleur, le second et la marge', () => {
    const r = comparerGroupes(
      [g('A1', 1, 0, 0), g('A2', 0, 1, 0)],
      [g('B1', 0, 0.95, 0.05), g('B2', 0.95, 0.05, 0), g('B3', 0, 0.05, 0.95)],
    );
    expect(r.matrice).toHaveLength(2);
    expect(r.matrice[0]).toHaveLength(3);
    expect(r.lignes[0].meilleur).toBe(1);        // A1 → B2
    expect(r.lignes[1].meilleur).toBe(0);        // A2 → B1
    expect(r.lignes[0].marge).toBeGreaterThan(0);
    expect(r.lignes[0].distanceSecond).toBeGreaterThan(r.lignes[0].distanceMeilleur);
  });

  it('signale quand deux voitures d\'avant réclament la même d\'après', () => {
    // Deux livrées identiques avant, une seule qui leur ressemble après :
    // l'apparence se CONTREDIT, et c'est un fait à lire avant toute décision.
    const r = comparerGroupes(
      [g('A1', 1, 0), g('A2', 1, 0)],
      [g('B1', 0.98, 0.02), g('B2', 0, 1)],
    );
    expect(r.reclamations[0]).toBe(2);
    // L'appariement optimal, lui, ne peut pas donner deux fois la même.
    expect(new Set(r.optimal).size).toBe(2);
    expect(r.lignes.some(l => !l.concordant)).toBe(true);
  });

  it('distingue le plus proche ligne à ligne de l\'appariement global', () => {
    const r = comparerGroupes([g('A1', 1, 0), g('A2', 1, 0)], [g('B1', 1, 0), g('B2', 0.9, 0.1)]);
    expect(r.lignes.every(l => l.meilleur === 0)).toBe(true);
    expect(new Set(r.optimal)).toEqual(new Set([0, 1]));
  });

  it('ignore les voitures sans signature au lieu de les compter', () => {
    const r = comparerGroupes([g('A1', 1, 0), { id: 'A2', sig: null }], [g('B1', 1, 0)]);
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0].idAvant).toBe('A1');
  });

  it('ne rend rien plutôt que d\'inventer quand un côté est vide', () => {
    expect(comparerGroupes([], [g('B1', 1, 0)]).lignes).toEqual([]);
    expect(comparerGroupes([g('A1', 1, 0)], []).matrice).toEqual([]);
  });

  it('porte un identifiant de méthode que le rapport citera', () => {
    expect(METHODE_APPARENCE).toMatch(/^hsv-zonee\/\d+$/);
  });
});

describe('mémoire d\'apparence', () => {
  const s = (...v) => v;
  const obs = (t, sig) => ({ t, sig });

  it('agrège les VECTEURS pour la moyenne, les DISTANCES pour les autres', () => {
    // Mémoire : une observation identique à la cible, une très éloignée.
    const memoire = [obs(0, s(1, 0)), obs(1, s(0, 1))];
    const cible = s(1, 0);
    // le minimum retient la vue qui ressemble
    expect(distanceMemoire(memoire, cible, 'min')).toBe(0);
    // la moyenne mélange les deux points de vue et s'éloigne des deux
    expect(distanceMemoire(memoire, cible, 'moyenne')).toBeGreaterThan(0.2);
    // le quantile bas se range du côté du minimum sans y être collé
    const q = distanceMemoire(memoire, cible, 'q25');
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(distanceMemoire(memoire, cible, 'moyenne'));
  });

  it('refuse une agrégation inconnue au lieu de choisir à ma place', () => {
    expect(() => distanceMemoire([obs(0, s(1, 0))], s(1, 0), 'mediane')).toThrow(/inconnue/);
  });

  it('rend null quand la mémoire est vide', () => {
    expect(distanceMemoire([], s(1, 0), 'min')).toBeNull();
    expect(distanceMemoire([obs(0, s(1, 0))], null, 'min')).toBeNull();
  });

  it('taille par nombre et par récence', () => {
    const m = [obs(1, s(1, 0)), obs(2, s(1, 0)), obs(3, s(1, 0)), obs(4, s(1, 0))];
    expect(tailler(m, { taille: 2 })).toHaveLength(2);
    expect(tailler(m, { taille: 2 })[0].t).toBe(3);          // les plus RÉCENTES
    expect(tailler(m, { recence: 1.5, tFin: 4 })).toHaveLength(2);
    expect(tailler(m, {})).toHaveLength(4);
  });
});

describe('notation d\'un appariement contre la vérité', () => {
  // La matrice réellement mesurée sur la coupure Kerlabo, image 348 → 354.
  const KERLABO = [
    [0.4967, 0.6100, 0.6540, 0.6241, 0.4810],
    [0.6049, 0.6372, 0.7105, 0.5365, 0.6135],
    [0.5273, 0.5749, 0.6330, 0.5365, 0.5314],
    [0.6613, 0.6689, 0.7495, 0.6849, 0.6365],
  ];
  const VERITE = [4, 3, 2, 1];      // A1→B8, A2→B7, A3→B6, A4→B4

  it('reproduit le témoin mesuré sur la vraie coupure', () => {
    const r = evaluerAppariement(KERLABO, VERITE);
    expect(r.notesPlusProche.justes).toBe(2);
    expect(r.notesOptimal.justes).toBe(3);
    expect(r.coutOptimal).toBe(2.2137);
    expect(r.coutVerite).toBe(2.3194);
    expect(r.ecartVeriteOptimal).toBe(0.1057);
    expect(r.margeGlobale).toBe(0.0198);
    expect(r.contradictions).toBe(1);
  });

  it('montre que l\'unicité seule vaut une bonne réponse de plus', () => {
    const r = evaluerAppariement(KERLABO, VERITE);
    // A4 : le plus proche désigne B8, déjà prise par A1 ; l'appariement global
    // lui rend B4, qui est la bonne.
    expect(r.plusProche[3]).toBe(4);
    expect(r.optimal[3]).toBe(1);
    expect(r.notesOptimal.justes).toBeGreaterThan(r.notesPlusProche.justes);
  });

  it('rend un écart NÉGATIF quand la vérité est l\'appariement optimal', () => {
    const parfait = [[0.1, 0.9], [0.9, 0.1]];
    const r = evaluerAppariement(parfait, [0, 1]);
    expect(r.ecartVeriteOptimal).toBe(0);
    expect(r.notesOptimal.justes).toBe(2);
  });

  it('compte à part les lignes sans vérité au lieu de les compter fausses', () => {
    const r = evaluerAppariement([[0.1, 0.9], [0.9, 0.1]], [0, null]);
    expect(r.notesOptimal.justes).toBe(1);
    expect(r.notesOptimal.faux).toBe(0);
    expect(r.notesOptimal.sansVerite).toBe(1);
    expect(r.coutVerite).toBeNull();
    expect(r.ecartVeriteOptimal).toBeNull();
  });

  it('ne rend rien plutôt que d\'inventer sur une matrice vide', () => {
    expect(evaluerAppariement([], [])).toBeNull();
    expect(evaluerAppariement([[]], [])).toBeNull();
  });
});

describe('écart relatif, et pourquoi l\'écart brut ne suffit pas', () => {
  it('normalise par l\'échelle des distances', () => {
    // Deux descripteurs, le second rendant des distances deux fois plus
    // petites : l'écart BRUT est deux fois plus petit, alors que rien n'a
    // changé dans le classement. Mesuré sur Kerlabo, c'est ce qui faisait
    // passer « 3 bandes · min · 8 obs » pour un progrès (+0,088 contre
    // +0,1057) alors que les deux valent 4,8 % une fois normalisés.
    const grande = [[0.4, 0.8], [0.8, 0.4]];
    const petite = grande.map(l => l.map(d => d / 2));
    const a = evaluerAppariement(grande, [1, 0]);
    const b = evaluerAppariement(petite, [1, 0]);
    expect(b.ecartVeriteOptimal).toBeLessThan(a.ecartVeriteOptimal);
    expect(b.ecartRelatif).toBeCloseTo(a.ecartRelatif, 6);
  });

  it('rend un écart relatif nul quand la vérité est l\'optimum', () => {
    const r = evaluerAppariement([[0.1, 0.9], [0.9, 0.1]], [0, 1]);
    expect(r.ecartRelatif).toBe(0);
  });

  it('reste null sans vérité complète', () => {
    expect(evaluerAppariement([[0.1, 0.9], [0.9, 0.1]], [0, null]).ecartRelatif).toBeNull();
  });

  it('montre qu\'un candidat parasite en plus peut voler une bonne réponse', () => {
    // Le défaut du run réel : trois boîtes de public restées cochées. Le coût
    // de la VÉRITÉ ne change pas — elle ne somme que les vraies paires — mais
    // l'optimum devient moins cher, donc l'écart gonfle, et une colonne
    // parasite peut capturer une ligne.
    const propre = [[0.50, 0.60], [0.60, 0.50]];
    const pollue = propre.map(l => [...l, 0.45]);       // un intrus proche de tous
    const a = evaluerAppariement(propre, [0, 1]);
    const b = evaluerAppariement(pollue, [0, 1]);
    expect(b.coutVerite).toBe(a.coutVerite);
    expect(b.coutOptimal).toBeLessThan(a.coutOptimal);
    expect(b.notesOptimal.justes).toBeLessThan(a.notesOptimal.justes);
  });
});
