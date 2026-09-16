/* ═══════════════════════════════════════════════
   TURN1ANALYSISCALC.TEST.JS — Le raisonnement du classement au premier virage

   Ce que ces tests protègent avant tout : la règle « une case vide coûte moins
   cher qu'une case fausse ». Un appariement qui décide quand il ne devrait pas
   alimenterait les statistiques avec des positions inventées.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  retirerEmboitees, deGaucheADroite, apparierVoitures, buildV1Proposal,
  grilleVueCamera, MARGE_MIN,
} from '../js/turn1AnalysisCalc.js';
import { isV1OrderProposal, applyV1OrderProposal } from '../js/startAnalysisCalc.js';

// Signatures jouets : des histogrammes à trois cases suffisent à exercer la
// distance de Bhattacharyya et l'affectation.
const S = (...v) => Float64Array.from(v);
const ROUGE = S(1, 0, 0);
const VERT  = S(0, 1, 0);
const BLEU  = S(0, 0, 1);
const PRESQUE_ROUGE = S(0.9, 0.1, 0);
// Deux décos réellement confondables : l'écart entre les deux distances tombe
// à 1,2 %, sous la marge de 6 % retenue. C'est le cas que l'appariement doit
// refuser de trancher.
const JUMELLE_A = S(0.50, 0.30, 0.20);
const JUMELLE_B = S(0.52, 0.28, 0.20);
const ENTRE_LES_DEUX = S(0.51, 0.29, 0.20);

describe('retirerEmboitees', () => {
  const voiture = { box: [100, 100, 300, 250] };
  // Le liseré mesuré sur le pavillon : 131 × 52 px, dans la voiture.
  const liseré = { box: [140, 110, 271, 162] };

  it('retire une boîte largement contenue dans une plus grande', () => {
    expect(retirerEmboitees([voiture, liseré])).toEqual([voiture]);
  });

  it('garde deux voitures qui se touchent sans se contenir', () => {
    const a = { box: [0, 0, 100, 100] }, b = { box: [90, 0, 190, 100] };
    expect(retirerEmboitees([a, b])).toHaveLength(2);
  });

  it('garde la grande quand deux boîtes se recouvrent à moitié seulement', () => {
    const a = { box: [0, 0, 100, 100] }, b = { box: [50, 0, 150, 100] };
    expect(retirerEmboitees([a, b])).toHaveLength(2);
  });

  it('ne retire jamais la plus grande des deux', () => {
    expect(retirerEmboitees([liseré, voiture])).toEqual([voiture]);
  });

  it('laisse passer une liste vide ou unique', () => {
    expect(retirerEmboitees([])).toEqual([]);
    expect(retirerEmboitees([voiture])).toEqual([voiture]);
  });

  it('ignore une boîte dégénérée plutôt que de diviser par zéro', () => {
    const plate = { box: [10, 10, 10, 10] };
    expect(() => retirerEmboitees([voiture, plate])).not.toThrow();
  });
});

describe('deGaucheADroite', () => {
  it('range par abscisse du centre, pas par bord gauche', () => {
    // Une voiture large mais plus à gauche du bord doit rester après une
    // étroite dont le centre est avant elle.
    const large = { box: [0, 0, 300, 100] };    // centre 150
    const etroite = { box: [90, 0, 120, 100] }; // centre 105
    expect(deGaucheADroite([large, etroite])).toEqual([etroite, large]);
  });

  it('ne modifie pas la liste reçue', () => {
    const l = [{ box: [200, 0, 300, 100] }, { box: [0, 0, 100, 100] }];
    const copie = [...l];
    deGaucheADroite(l);
    expect(l).toEqual(copie);
  });
});

describe('apparierVoitures', () => {
  it('rend chaque voiture à son numéro quand les décos sont distinctes', () => {
    const r = apparierVoitures({
      signaturesDepart: [ROUGE, VERT, BLEU],
      signaturesV1: [BLEU, ROUGE, VERT],       // ordre de passage au virage
      numeros: [12, 7, 3],
    });
    expect(r.map(x => x.carNumber)).toEqual([3, 12, 7]);
    expect(r.map(x => x.position)).toEqual([1, 2, 3]);
    expect(r.every(x => x.raison === null)).toBe(true);
  });

  it('minimise le coût TOTAL, pas le meilleur de chacun', () => {
    // Les deux pointées ressemblent le plus à ROUGE ; le glouton donnerait
    // ROUGE à la première et laisserait la seconde sans rien de bon.
    const r = apparierVoitures({
      signaturesDepart: [ROUGE, PRESQUE_ROUGE],
      signaturesV1: [PRESQUE_ROUGE, ROUGE],
      numeros: [12, 7],
    });
    expect(r.map(x => x.carNumber)).toEqual([7, 12]);
  });

  it('ne décide pas quand deux candidats sont trop proches — marge par défaut', () => {
    const r = apparierVoitures({
      signaturesDepart: [JUMELLE_A, JUMELLE_B],
      signaturesV1: [ENTRE_LES_DEUX],
      numeros: [12, 7],
    });
    expect(r[0].carNumber).toBeNull();
    expect(r[0].raison).toBe('deux candidats trop proches');
    expect(r[0].confiance).toBe(0);
    // La distance reste rapportée : on doit pouvoir constater qu'elle était bonne.
    expect(r[0].distance).toBeGreaterThan(0);
    expect(r[0].ecart).toBeLessThan(MARGE_MIN);
  });

  it('une marge plus tolérante finit par trancher ce même cas', () => {
    const r = apparierVoitures({
      signaturesDepart: [JUMELLE_A, JUMELLE_B],
      signaturesV1: [ENTRE_LES_DEUX],
      numeros: [12, 7], margeMin: 0.005,
    });
    expect(r[0].carNumber).not.toBeNull();
  });

  it('écarte une signature illisible plutôt que de l\'apparier au hasard', () => {
    const r = apparierVoitures({
      signaturesDepart: [ROUGE, VERT],
      signaturesV1: [null],
      numeros: [12, 7],
    });
    expect(r[0].carNumber).toBeNull();
    expect(r[0].raison).toBe('aucun candidat exploitable');
    expect(r[0].distance).toBeNull();
  });

  it('avec un seul candidat, il n\'y a rien à confondre', () => {
    const r = apparierVoitures({
      signaturesDepart: [ROUGE], signaturesV1: [ROUGE], numeros: [12],
    });
    expect(r[0].carNumber).toBe(12);
    expect(r[0].ecart).toBe(1);
  });

  it('plus de voitures au virage que sur la grille : le surplus reste non décidé', () => {
    const r = apparierVoitures({
      signaturesDepart: [ROUGE, VERT],
      signaturesV1: [ROUGE, VERT, BLEU],
      numeros: [12, 7],
    });
    expect(r).toHaveLength(3);
    expect(r[2].carNumber).toBeNull();
  });

  it('moins de voitures au virage : on ne classe que ce qui a été pointé', () => {
    const r = apparierVoitures({
      signaturesDepart: [ROUGE, VERT, BLEU],
      signaturesV1: [VERT],
      numeros: [12, 7, 3],
    });
    expect(r).toHaveLength(1);
    expect(r[0].carNumber).toBe(7);
  });

  it('sans rien à apparier, rend une liste vide plutôt que de jeter', () => {
    expect(apparierVoitures()).toEqual([]);
    expect(apparierVoitures({ signaturesV1: [ROUGE], signaturesDepart: [] })).toEqual([]);
  });

  it('la marge par défaut reste celle mesurée', () => {
    expect(MARGE_MIN).toBe(0.06);
  });
});

describe('buildV1Proposal', () => {
  const APPARIEMENT = [
    { position: 1, carNumber: 3, confiance: 0.4123, raison: null },
    { position: 2, carNumber: null, confiance: 0, raison: 'deux candidats trop proches' },
    { position: 3, carNumber: 12, confiance: 0.88, raison: null },
  ];
  const NOMS = new Map([[3, 'A. Roux'], [12, 'C. Nauy']]);

  it('produit un document que « Analyse des départs » reconnaît', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12, 7, 3] });
    expect(isV1OrderProposal(doc)).toBe(true);
  });

  it('porte les positions décidées, et garde trace des indécises', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12, 7, 3], noms: NOMS });
    expect(doc.positions).toHaveLength(3);
    expect(doc.positions[0]).toMatchObject({ carNumber: 3, turn1Pos: 1, pilote: 'A. Roux' });
    expect(doc.positions[1]).toMatchObject({ carNumber: null, turn1Pos: null });
    expect(doc.positions[2]).toMatchObject({ carNumber: 12, turn1Pos: 3, pilote: 'C. Nauy' });
  });

  it('arrondit la confiance sans la perdre', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12, 7, 3] });
    expect(doc.positions[0].confiance).toBe(0.412);
  });

  it('le document traverse vraiment jusqu\'aux lignes du départ', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12, 7, 3], noms: NOMS });
    const rows = [
      { driverId: 'a', carNumber: 12 }, { driverId: 'b', carNumber: 7 }, { driverId: 'c', carNumber: 3 },
    ];
    const { rows: maj, applied } = applyV1OrderProposal({ rows, proposal: doc, starters: 3 });
    expect(applied).toBe(2);                               // la non décidée n'entre pas
    expect(maj.find(r => r.carNumber === 3).autoTurn1Pos).toBe(1);
    expect(maj.find(r => r.carNumber === 12).autoTurn1Pos).toBe(3);
    expect(maj.find(r => r.carNumber === 7).autoTurn1Pos ?? null).toBeNull();
  });

  it('ne touche jamais aux positions saisies à la main', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12, 7, 3] });
    const rows = [{ driverId: 'c', carNumber: 3, turn1Pos: 5 }];
    const { rows: maj } = applyV1OrderProposal({ rows, proposal: doc, starters: 5 });
    expect(maj[0].turn1Pos).toBe(5);
  });

  it('un timecode absent ne devient pas l\'instant 0', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12] });
    expect(doc.startAt).toBeNull();
    expect(doc.turn1At).toBeNull();
  });

  it('garde l\'identité du départ pour ne pas remplir le mauvais', () => {
    const doc = buildV1Proposal({ appariement: APPARIEMENT, numeros: [12], startId: 'sess9_s4' });
    expect(doc.startId).toBe('sess9_s4');
  });
});

describe('grilleVueCamera', () => {
  const DRIVERS = [
    { carNumber: 3, lane: 3 }, { carNumber: 12, lane: 1 }, { carNumber: 7, lane: 2 },
  ];

  it('pole à gauche : le couloir 1 est à gauche de l\'image', () => {
    expect(grilleVueCamera(DRIVERS, 'left').map(d => d.carNumber)).toEqual([12, 7, 3]);
  });

  it('pole à droite : l\'ordre s\'inverse', () => {
    expect(grilleVueCamera(DRIVERS, 'right').map(d => d.carNumber)).toEqual([3, 7, 12]);
  });

  it('accepte le côté écrit en français', () => {
    expect(grilleVueCamera(DRIVERS, 'droite').map(d => d.carNumber)).toEqual([3, 7, 12]);
  });

  it('l\'opérateur peut inverser quand la caméra filme de l\'autre côté', () => {
    expect(grilleVueCamera(DRIVERS, 'left', true).map(d => d.carNumber)).toEqual([3, 7, 12]);
  });

  it('un couloir manquant part en fin de grille plutôt que de fausser l\'ordre', () => {
    const avecTrou = [...DRIVERS, { carNumber: 99, lane: null }];
    expect(grilleVueCamera(avecTrou, 'left').map(d => d.carNumber)).toEqual([12, 7, 3, 99]);
  });

  it('ne modifie pas la liste reçue', () => {
    const copie = [...DRIVERS];
    grilleVueCamera(DRIVERS, 'right');
    expect(DRIVERS).toEqual(copie);
  });
});
