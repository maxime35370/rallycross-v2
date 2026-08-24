/* ═══════════════════════════════════════════════
   TRACKERCORE.TEST.JS — Suivi temporel, logique pure

   Les scénarios sont synthétiques et volontairement extrêmes : c'est le seul
   moyen de vérifier un tracker sans vérité terrain annotée. Chacun reproduit
   une situation observée sur le corpus Kerlabo — détection manquée, boîte
   fusionnée sur deux voitures, panoramique de caméra, voitures qui se frôlent.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { centre } from '../tools/yolox-poc/lib/track.mjs';
import { iou } from '../tools/yolox-poc/lib/detect.mjs';
import {
  ETATS, DEFAULTS, RAISONS, REFUS, Suivi, Predicteur, hungarian, decalageCamera,
  estimerDecalageGlobal, rapportTaille, recouvrement, mesurer, signauxSuspects, concorder,
  detecterRuptures, ventilerAutourDesRuptures, coherenceSpatiale, reinitialiserIds,
  boiteFusionnee,
} from '../tools/yolox-poc/lib/track.mjs';

/** Boîte carrée centrée, pour écrire des scénarios lisibles. */
const B = (cx, cy, w = 160, h = 90) => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
const det = (box, score = 0.8) => ({ box, score, label: 'car' });

/** Déroule une séquence : `positions[i]` = détections de l'instant i. */
function derouler(positions, options = {}) {
  const s = new Suivi({ dt: 0.25, ...options });
  positions.forEach((dets, i) => s.pas(i * (options.dt ?? 0.25), dets));
  return s;
}

// ─────────────────────────────────────────────────────────
// AFFECTATION
// ─────────────────────────────────────────────────────────

describe('hungarian', () => {
  it('trouve l\'affectation de coût minimal', () => {
    expect(hungarian([[1, 2], [2, 1]])).toEqual([0, 1]);
    expect(hungarian([[2, 1], [1, 2]])).toEqual([1, 0]);
  });

  it('résout le cas où une association gloutonne se tromperait', () => {
    // La ligne 0 préfère la colonne 0 (coût 1) — mais la ligne 1 n'a QUE la
    // colonne 0 d'utilisable. Le glouton donnerait 0→0 puis échouerait ;
    // l'affectation optimale sacrifie 0 pour un total plus faible.
    const cout = [[1, 2], [3, 99]];
    expect(hungarian(cout)).toEqual([1, 0]);
  });

  it('gère des matrices rectangulaires dans les deux sens', () => {
    expect(hungarian([[1, 5, 9]]).length).toBe(1);
    const r = hungarian([[1], [5], [9]]);
    expect(r.filter(x => x >= 0)).toHaveLength(1);
    expect(r[0]).toBe(0);
  });

  it('renvoie un tableau vide sur une entrée vide', () => {
    expect(hungarian([])).toEqual([]);
    expect(hungarian([[]])).toEqual([-1]);
  });
});

// ─────────────────────────────────────────────────────────
// PRÉDICTEUR
// ─────────────────────────────────────────────────────────

describe('Predicteur', () => {
  it('extrapole un mouvement rectiligne après quelques mesures', () => {
    const p = new Predicteur(B(100, 100));
    for (let i = 1; i <= 6; i++) p.corriger(B(100 + i * 20, 100), 0.25);
    const [vx] = p.vitesse;
    expect(vx).toBeGreaterThan(40);          // ~80 px/s attendus
    const suivant = p.predire(0.25);
    expect((suivant[0] + suivant[2]) / 2).toBeGreaterThan(215);
  });

  it('amortit la vitesse quand la mesure manque', () => {
    // Sans amortissement, une piste perdue filerait en ligne droite à l'infini
    // et se raccrocherait à n'importe quoi sur son chemin.
    const p = new Predicteur(B(100, 100));
    for (let i = 1; i <= 5; i++) p.corriger(B(100 + i * 20, 100), 0.25);
    const v0 = Math.abs(p.vitesse[0]);
    p.avancerSansMesure(0.25);
    p.avancerSansMesure(0.25);
    expect(Math.abs(p.vitesse[0])).toBeLessThan(v0);
  });

  it('encaisse un décalage de caméra sans changer de taille', () => {
    const p = new Predicteur(B(100, 100, 80, 50));
    p.decaler(30, -10);
    const b = p.boite;
    expect((b[0] + b[2]) / 2).toBeCloseTo(130, 6);
    expect(b[2] - b[0]).toBeCloseTo(80, 6);
  });
});

describe('decalageCamera', () => {
  it('isole un panoramique malgré des objets qui bougent vraiment', () => {
    // Quatre boîtes décalées de +40 par la caméra, une cinquième qui, en plus,
    // avance de 100 : la médiane ignore l'intruse.
    const paires = [
      { avant: B(100, 100), apres: B(140, 100) },
      { avant: B(200, 100), apres: B(240, 100) },
      { avant: B(300, 100), apres: B(340, 100) },
      { avant: B(400, 100), apres: B(540, 100) },
    ];
    const { dx, dy } = decalageCamera(paires);
    expect(dx).toBeCloseTo(40, 6);
    expect(dy).toBeCloseTo(0, 6);
  });

  it('ne se prononce pas sous trois paires', () => {
    expect(decalageCamera([{ avant: B(0, 0), apres: B(10, 0) }])).toMatchObject({ dx: 0, dy: 0 });
  });
});

// ─────────────────────────────────────────────────────────
// SUIVI — CAS NOMINAL
// ─────────────────────────────────────────────────────────

describe('Suivi — cinq voitures qui avancent', () => {
  const sequence = Array.from({ length: 12 }, (_, k) =>
    [0, 1, 2, 3, 4].map(i => det(B(200 + i * 160 + k * 12, 400))));

  it('maintient cinq pistes distinctes du début à la fin', () => {
    const s = derouler(sequence);
    const vivantes = s.actives;
    expect(vivantes).toHaveLength(5);
    expect(new Set(vivantes.map(p => p.id)).size).toBe(5);
    expect(vivantes.every(p => p.state === ETATS.DETECTED)).toBe(true);
  });

  it('conserve le même identifiant tout du long', () => {
    const s = derouler(sequence);
    const premiers = s.journal[2].tracks.map(t => t.id).sort();
    const derniers = s.journal.at(-1).tracks.map(t => t.id).sort();
    expect(derniers).toEqual(premiers);
  });

  it('ne confirme pas une piste sur une seule apparition', () => {
    const s = derouler([sequence[0]]);
    expect(s.actives.every(p => p.state === ETATS.TENTATIVE)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// SUIVI — DÉTECTION MANQUÉE
// ─────────────────────────────────────────────────────────

describe('Suivi — YOLOX rate momentanément une voiture', () => {
  function sequenceAvecTrou(nbTrous) {
    return Array.from({ length: 12 }, (_, k) => {
      const toutes = [0, 1, 2].map(i => det(B(200 + i * 200 + k * 12, 400)));
      // La voiture du milieu disparaît des détections pendant `nbTrous` pas.
      return (k >= 4 && k < 4 + nbTrous) ? [toutes[0], toutes[2]] : toutes;
    });
  }

  it('ne supprime pas la piste et la raccroche ensuite, avec le même identifiant', () => {
    const s = derouler(sequenceAvecTrou(2));
    expect(s.actives).toHaveLength(3);
    const milieu = s.pistes.find(p => p.id === 2);
    expect(milieu.state).toBe(ETATS.DETECTED);
    expect(milieu.losses).toBe(1);            // une perte temporaire, pas trois pistes
    expect(s.pistes).toHaveLength(3);         // aucune piste supplémentaire créée
  });

  it('passe par un état explicitement NON détecté pendant le trou', () => {
    // Le tracker doit dire qu'il extrapole, jamais faire passer une position
    // devinée pour une observation.
    const s = derouler(sequenceAvecTrou(2));
    const pendant = s.journal[5].tracks.find(t => t.id === 2);
    expect([ETATS.PREDICTED, ETATS.OCCLUDED]).toContain(pendant.state);
    expect(pendant.score).toBe(0.8);          // dernier score connu, pas un score inventé
    expect(pendant.ambiguous).toBe(true);
  });

  it('finit par abandonner une piste absente trop longtemps', () => {
    const s = derouler(sequenceAvecTrou(9));
    const milieu = s.pistes.find(p => p.id === 2);
    expect(milieu.state).not.toBe(ETATS.DETECTED);
  });
});

// ─────────────────────────────────────────────────────────
// SUIVI — BANDE BASSE
// ─────────────────────────────────────────────────────────

describe('Suivi — la bande basse sauve, mais ne crée jamais', () => {
  it('raccroche une piste existante avec une détection faible', () => {
    const seq = Array.from({ length: 10 }, (_, k) => {
      const b = det(B(300 + k * 15, 400));
      // Aux pas 4 et 5, la confiance s'effondre sous le seuil du banc.
      return (k === 4 || k === 5) ? [{ ...b, score: 0.18 }] : [b];
    });
    const s = derouler(seq);
    expect(s.pistes).toHaveLength(1);
    expect(s.pistes[0].rescued).toBeGreaterThan(0);
    expect(s.pistes[0].state).toBe(ETATS.DETECTED);
  });

  it('n\'ouvre aucune piste sur une détection faible isolée', () => {
    // Sinon le seuil de 0,30 du banc ne voudrait plus rien dire.
    const s = derouler([
      [det(B(300, 400), 0.15)],
      [det(B(315, 400), 0.15)],
      [det(B(330, 400), 0.15)],
    ]);
    expect(s.pistes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────
// SUIVI — FUSION DE DEUX VOITURES
// ─────────────────────────────────────────────────────────

describe('boiteFusionnee — cas réel de Kerlabo à 11,6 s', () => {
  // Coordonnées RELEVÉES sur le run, pas inventées : les trois boîtes prédites
  // et la détection que le suivi a jetée. La piste 17 est la voiture ; les
  // deux autres ne font que l'effleurer.
  const PREDITE_17 = [1113, 543, 1458, 703];      // aire 55 200 · IoU 0,779
  const PREDITE_18 = [1190, 573, 1381, 715];      // aire 27 122 · IoU 0,434
  const PREDITE_36 = [975, 560, 1164, 681];       // aire 22 869 · IoU 0,124
  const DETECTION = [1101, 543, 1417, 689];       // aire 46 136
  const reglages = { iouRecover: DEFAULTS.iouRecover, mergeAreaRatio: DEFAULTS.mergeAreaRatio };

  it('reconnaît les trois pistes que la détection effleure', () => {
    const v = boiteFusionnee(DETECTION, [PREDITE_17, PREDITE_18, PREDITE_36], reglages);
    expect(v.touchees).toEqual([0, 1, 2]);
    expect(v.meilleurIou).toBeCloseTo(0.779, 2);
  });

  it('ne déclare PAS une fusion une boîte qu\'une seule piste explique déjà', () => {
    // La détection est plus PETITE que la boîte prédite de la piste 17 : elle
    // ne peut pas être « deux voitures dans une boîte ». C'est sa voiture.
    const v = boiteFusionnee(DETECTION, [PREDITE_17, PREDITE_18, PREDITE_36], reglages);
    expect(v.rapport).toBeLessThan(DEFAULTS.mergeAreaRatio);
    expect(v.fusion).toBe(false);
  });

  it('deux voisines qui effleurent ne changent pas le verdict', () => {
    // Le même verdict doit tenir que la piste 17 soit seule ou entourée : ce
    // qui décide, c'est la boîte que la détection recouvre le mieux.
    const seule = boiteFusionnee(DETECTION, [PREDITE_17, PREDITE_18], reglages);
    const entouree = boiteFusionnee(DETECTION, [PREDITE_17, PREDITE_18, PREDITE_36], reglages);
    expect(entouree.fusion).toBe(seule.fusion);
  });

  it('reconnaît toujours une VRAIE fusion — cas réel à 5,3 s', () => {
    // Relevé sur le même run : aucune des deux pistes n'explique la boîte
    // (IoU 0,131 et 0,188), et elle est 1,42 fois plus grande que la plus
    // grande des deux. Là, c'est bien une boîte pour deux voitures.
    const v = boiteFusionnee([995, 468, 1225, 591],
      [[996, 423, 1163, 496], [1122, 443, 1323, 542]], reglages);
    expect(v.meilleurIou).toBeLessThan(0.2);
    expect(v.fusion).toBe(true);
  });

  it('une seule piste touchée n\'est jamais une fusion', () => {
    const v = boiteFusionnee(DETECTION, [PREDITE_17], reglages);
    expect(v.touchees).toEqual([0]);
    expect(v.fusion).toBe(false);
  });
});

describe('Suivi — une boîte engloutit deux voitures', () => {
  // Cas observé sur `milieu_v1` : deux pistes bien établies, puis une seule
  // détection large qui les recouvre toutes les deux, puis re-séparation.
  // Tailles explicites : la fusion se reconnaît au RAPPORT d'aire, deux voitures
  // de 100 × 60 avalées par une boîte de 230 × 70.
  const seq = [];
  for (let k = 0; k < 5; k++) seq.push([det(B(300 + k * 10, 400, 100, 60)), det(B(420 + k * 10, 400, 100, 60))]);
  for (let k = 5; k < 8; k++) seq.push([det(B(400 + k * 10, 400, 230, 70), 0.62)]);
  for (let k = 8; k < 13; k++) seq.push([det(B(300 + k * 10, 400, 100, 60)), det(B(420 + k * 10, 400, 100, 60))]);

  it('ne transforme pas deux voitures en une seule', () => {
    const s = derouler(seq);
    const vivantes = s.actives.filter(p => p.state !== ETATS.LOST);
    expect(vivantes.length).toBeGreaterThanOrEqual(2);
    expect(s.pistes.filter(p => p.hits >= 3)).toHaveLength(2);
  });

  it('marque la piste avalée comme occluse, pas comme détectée', () => {
    const s = derouler(seq);
    const pendant = s.journal[6];
    const etats = pendant.tracks.map(t => t.state);
    expect(etats).toContain(ETATS.OCCLUDED);
    const occluse = pendant.tracks.find(t => t.state === ETATS.OCCLUDED);
    expect(occluse.occludedBy).not.toBeNull();
    expect(occluse.ambiguous).toBe(true);
  });

  it('récupère les deux pistes à la re-séparation, sans en créer de nouvelles', () => {
    const s = derouler(seq);
    const fin = s.journal.at(-1);
    const suivies = fin.tracks.filter(t => t.state === ETATS.DETECTED);
    expect(suivies).toHaveLength(2);
    // Deux voitures au départ, deux à l'arrivée : aucune identité inventée.
    expect(new Set(fin.tracks.map(t => t.id)).size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────
// SUIVI — PANORAMIQUE
// ─────────────────────────────────────────────────────────

describe('Suivi — la caméra suit le peloton', () => {
  // Toutes les boîtes glissent de 90 px par pas : c'est la caméra qui bouge,
  // pas les voitures les unes par rapport aux autres.
  const seq = Array.from({ length: 10 }, (_, k) =>
    [0, 1, 2, 3, 4].map(i => det(B(300 + i * 150 - k * 90, 400))));

  it('garde les cinq pistes grâce à la compensation', () => {
    const s = derouler(seq, { cameraCompensation: true });
    expect(s.actives.filter(p => p.state === ETATS.DETECTED)).toHaveLength(5);
    expect(s.pistes).toHaveLength(5);
  });

  it('n\'invente aucune piste supplémentaire pendant le panoramique', () => {
    // Le vrai risque d'un panoramique : les prédictions décrochent, les pistes
    // sont abandonnées et de nouvelles naissent à côté. Cinq voitures doivent
    // rester cinq pistes.
    const s = derouler(seq, { cameraCompensation: true });
    expect(s.pistes).toHaveLength(5);
    expect(s.pistes.every(p => p.losses === 0)).toBe(true);
  });

  it('le biais mesuré reste petit : le filtre absorbe déjà le mouvement commun', () => {
    // S'il valait −90, c'est qu'on compterait le déplacement deux fois.
    const s = derouler(seq, { cameraCompensation: true });
    expect(Math.abs(s.derniereCamera.dx)).toBeLessThan(45);
  });
});

// ─────────────────────────────────────────────────────────
// MESURES
// ─────────────────────────────────────────────────────────

describe('mesurer', () => {
  const seq = Array.from({ length: 20 }, (_, k) =>
    [0, 1, 2, 3, 4].map(i => det(B(200 + i * 160 + k * 8, 400))));

  it('rend compte des pistes, de leur durée et de l\'instant du V1', () => {
    const s = derouler(seq);
    const m = mesurer(s, { cible: 5, tV1: 4.0 });
    expect(m.instants).toBe(20);
    expect(m.pistesLongues).toBe(5);
    expect(m.pistesLonguesAtteintCible).toBe(true);
    expect(m.auV1.suivies).toBe(5);
    expect(m.auV1.ids).toHaveLength(5);
    // Au tout premier instant, aucune piste n'est encore confirmée : c'est
    // voulu, une apparition unique ne fait pas une voiture.
    expect(m.parInstant[0].suivies).toBe(0);
    expect(m.parInstant.at(-1).suivies).toBe(5);
  });

  it('compte séparément pertes, sauvetages et reprises', () => {
    const s = derouler(seq);
    const m = mesurer(s);
    expect(m).toHaveProperty('pertesTemporaires');
    expect(m).toHaveProperty('sauvetagesBandeBasse');
    expect(m).toHaveProperty('reprisesApresOcclusion');
  });

  it('ne renvoie rien sans instant analysé', () => {
    expect(mesurer(new Suivi())).toBeNull();
  });
});

describe('signauxSuspects', () => {
  it('repère un relais : une piste s\'éteint, une autre naît au même endroit', () => {
    // Signature classique d'un identifiant perdu puis réattribué.
    const seq = [];
    for (let k = 0; k < 4; k++) seq.push([det(B(300 + k * 10, 400))]);
    for (let k = 0; k < 6; k++) seq.push([]);                        // trou long : la piste meurt
    for (let k = 0; k < 4; k++) seq.push([det(B(340 + k * 10, 400))]);
    const signaux = signauxSuspects(derouler(seq));
    expect(signaux.some(x => x.type === 'relais')).toBe(true);
  });

  it('repère un croisement de deux pistes', () => {
    // Peut être un vrai dépassement — c'est précisément ce qu'il faut aller
    // regarder au premier virage.
    const seq = Array.from({ length: 10 }, (_, k) => [
      det(B(300 + k * 20, 380)),
      det(B(460 - k * 20, 520)),
    ]);
    const signaux = signauxSuspects(derouler(seq));
    expect(signaux.some(x => x.type === 'echange')).toBe(true);
  });

  it('ne signale rien sur une trajectoire régulière et isolée', () => {
    const s = derouler(Array.from({ length: 10 }, (_, k) => [det(B(300 + k * 12, 400))]));
    expect(signauxSuspects(s)).toEqual([]);
  });
});

describe('concorder', () => {
  it('déclare concordantes deux fréquences qui donnent le même résultat', () => {
    const a = { pistesLongues: 5, auV1: { suivies: 5 } };
    const b = { pistesLongues: 5, auV1: { suivies: 5 } };
    expect(concorder(a, b).concordant).toBe(true);
  });

  it('déclare discordantes deux fréquences qui divergent', () => {
    // La discordance PROUVE qu'au moins une des deux se trompe ; la
    // concordance, elle, ne prouve rien.
    const a = { pistesLongues: 5, auV1: { suivies: 5 } };
    const b = { pistesLongues: 3, auV1: { suivies: 2 } };
    expect(concorder(a, b).concordant).toBe(false);
  });
});

describe('réglages par défaut', () => {
  it('garde le seuil du banc et n\'utilise la bande basse que pour sauver', () => {
    expect(DEFAULTS.highScore).toBe(0.30);
    expect(DEFAULTS.lowScore).toBeLessThan(DEFAULTS.highScore);
  });

  it('tolère plus longtemps une occlusion identifiée qu\'une simple absence', () => {
    expect(DEFAULTS.dureeOcclusionMax).toBeGreaterThan(DEFAULTS.dureeAvantAbandon);
  });

  it('exprime toutes les tolérances en SECONDES, jamais en pas', () => {
    // En pas, une tolérance de 3 valait 0,75 s à 4 Hz et 0,30 s à 10 Hz :
    // augmenter la fréquence resserrait silencieusement tous les délais.
    for (const clef of ['dureeAvantAbandon', 'dureeOcclusionMax', 'dureeReactivation', 'dureeConfirmation']) {
      expect(DEFAULTS[clef]).toBeGreaterThan(0);
    }
    expect(DEFAULTS).not.toHaveProperty('maxAge');
    expect(DEFAULTS).not.toHaveProperty('minHits');
  });
});

// ─────────────────────────────────────────────────────────
// FRAGMENTATION — les cas mesurés sur Kerlabo
// ─────────────────────────────────────────────────────────

describe('Suivi — grille de départ : 7 détections pour 5 voitures', () => {
  // Relevé réel : à t = 3,000 s, YOLOX-s rend 7 détections pour 5 voitures ;
  // les deux parasites sont plus petits, moins sûrs, et posés SUR des voitures
  // déjà détectées. Ils survivent à la fusion à IoU 0,45 parce qu'ils sont
  // décalés — c'est l'inclusion, pas l'IoU, qui les trahit.
  const grille = (k) => {
    const d = [0, 1, 2, 3, 4].map(i => det(B(300 + i * 170 + k * 10, 400, 160, 90), 0.85));
    d.push(det(B(300 + k * 10 + 20, 400, 80, 50), 0.45));
    d.push(det(B(300 + 4 * 170 + k * 10 - 20, 400, 85, 52), 0.44));
    return d;
  };
  const seq = Array.from({ length: 13 }, (_, k) => grille(k));

  it('ne crée que cinq identités', () => {
    const s = derouler(seq);
    expect(s.pistes).toHaveLength(5);
    expect(s.confirmees).toHaveLength(5);
    expect(s.doublonsEcartes).toBeGreaterThan(0);
  });

  it('impute chaque doublon à la piste qu\'il recouvre', () => {
    const s = derouler(seq);
    expect(s.pistes.filter(p => p.doublonsAbsorbes > 0).length).toBe(2);
  });

  it('n\'écarte jamais une détection MEILLEURE que la piste qu\'elle recouvre', () => {
    // Sinon, au départ où les cinq boîtes se chevauchent déjà, une vraie
    // voiture mieux détectée que sa voisine disparaîtrait.
    const s = new Suivi({ dt: 0.25 });
    s.pas(0, [det(B(400, 400, 160, 90), 0.40), det(B(410, 400, 150, 88), 0.90)]);
    expect(s.pistes).toHaveLength(2);
  });
});

describe('Suivi — indépendance à la fréquence', () => {
  // Baseline mesurée sur Kerlabo : passer de 4 à 10 Hz faisait bondir les
  // pistes de 46 à 90 et les pertes de 66 à 219. Une même séquence physique
  // doit donner le même suivi, quelle que soit la cadence d'échantillonnage.
  const voitures = (t) => [0, 1, 2, 3, 4].map(i => det(B(300 + i * 170 + t * 60, 400, 160, 90), 0.85));
  const rejouer = (dt) => {
    const s = new Suivi({ dt });
    for (let k = 0; k * dt <= 4 + 1e-9; k++) s.pas(Number((k * dt).toFixed(3)), voitures(k * dt));
    return mesurer(s, { cible: 5, tV1: 4 });
  };

  it('donne le même nombre de pistes confirmées à 2, 4 et 10 Hz', () => {
    const a = rejouer(0.5), b = rejouer(0.25), c = rejouer(0.1);
    expect([a.pistesConfirmeesCreees, b.pistesConfirmeesCreees, c.pistesConfirmeesCreees]).toEqual([5, 5, 5]);
    expect([a.auV1.suivies, b.auV1.suivies, c.auV1.suivies]).toEqual([5, 5, 5]);
  });

  it('tolère la même DURÉE d\'absence quelle que soit la fréquence', () => {
    // Un trou de 0,5 s : la piste doit survivre aux deux cadences.
    const avecTrou = (dt) => {
      const s = new Suivi({ dt });
      for (let k = 0; k * dt <= 4 + 1e-9; k++) {
        const t = Number((k * dt).toFixed(3));
        const toutes = voitures(t);
        s.pas(t, (t >= 2 && t < 2.5) ? [toutes[0], toutes[2], toutes[3], toutes[4]] : toutes);
      }
      return s;
    };
    for (const dt of [0.25, 0.1]) {
      const s = avecTrou(dt);
      expect(s.pistes).toHaveLength(5);
      expect(s.confirmees).toHaveLength(5);
    }
  });
});

describe('Suivi — réactivation d\'une piste abandonnée', () => {
  it('reprend l\'identifiant au lieu d\'en fabriquer un nouveau', () => {
    // Sans repêchage, toute voiture perdue plus d'une seconde revenait sous un
    // NOUVEL identifiant — indiscernable d'un vrai échange d'identité.
    const seq = [];
    for (let k = 0; k < 6; k++) seq.push([det(B(300 + k * 12, 400, 160, 90))]);
    for (let k = 0; k < 5; k++) seq.push([]);                    // 1,25 s d'absence
    for (let k = 0; k < 6; k++) seq.push([det(B(372 + k * 12, 400, 160, 90))]);
    const s = derouler(seq);
    expect(s.pistes).toHaveLength(1);
    expect(s.pistes[0].reactivated).toBe(1);
    expect(mesurer(s).reactivations).toBe(1);
  });

  it('ne repêche plus au-delà de la fenêtre', () => {
    const seq = [];
    for (let k = 0; k < 6; k++) seq.push([det(B(300, 400, 160, 90))]);
    for (let k = 0; k < 12; k++) seq.push([]);                   // 3 s : trop
    for (let k = 0; k < 6; k++) seq.push([det(B(300, 400, 160, 90))]);
    expect(derouler(seq).pistes).toHaveLength(2);
  });
});

describe('Predicteur — la mesure ne doit pas faire avancer l\'état deux fois', () => {
  it('ne dépasse pas la cible après une absence', () => {
    // Défaut corrigé : `corriger()` recevait le temps écoulé depuis la dernière
    // DÉTECTION, alors que l'état avait déjà été avancé à chaque pas. La
    // position corrigée dépassait la cible, l'IoU s'effondrait au pas suivant,
    // et la piste se fragmentait.
    const p = new Predicteur(B(100, 400, 100, 60));
    for (let i = 1; i <= 5; i++) p.corriger(B(100 + i * 20, 400, 100, 60), 0.25);
    p.avancerSansMesure(0.25);
    p.avancerSansMesure(0.25);
    p.corriger(B(260, 400, 100, 60), 0.25);
    const [cx] = centre(p.boite);
    expect(cx).toBeGreaterThan(200);
    expect(cx).toBeLessThan(320);
  });
});

describe('recouvrement', () => {
  it('mesure l\'inclusion, pas l\'intersection sur union', () => {
    const grande = B(400, 400, 200, 120), petite = B(400, 400, 80, 50);
    expect(recouvrement(petite, grande)).toBeCloseTo(1, 6);
    expect(recouvrement(grande, petite)).toBeLessThan(0.2);
  });
});

describe('mesurer — compteurs de fragmentation', () => {
  const seq = Array.from({ length: 16 }, (_, k) =>
    [0, 1, 2, 3, 4].map(i => det(B(200 + i * 170 + k * 8, 400, 160, 90))));

  it('distingue les pistes créées des pistes confirmées', () => {
    const m = mesurer(derouler(seq), { cible: 5, tV1: 3 });
    expect(m.pistesConfirmeesCreees).toBe(5);
    expect(m.pistesJamaisConfirmees).toBe(0);
    expect(m.dureeMedianePistes).toBeGreaterThan(0);
    expect(m.nouvellesPistesParSeconde).toBeCloseTo(5 / m.duree, 2);
  });

  it('trace la raison de chaque création et de chaque suppression', () => {
    const m = mesurer(derouler(seq));
    expect(m.raisons.creation[RAISONS.NOUVELLE]).toBe(5);
    expect(m.raisons).toHaveProperty('suppression');
    expect(m.suppressions).toBe(0);
  });

  it('compte séparément doublons écartés et réactivations', () => {
    const m = mesurer(derouler(seq));
    expect(m).toHaveProperty('doublonsEcartes');
    expect(m).toHaveProperty('reactivations');
  });
});

describe('rapportTaille', () => {
  it('est symétrique et vaut 1 sur deux boîtes identiques', () => {
    expect(rapportTaille(B(0, 0, 100, 50), B(9, 9, 100, 50))).toBeCloseTo(1, 6);
    expect(rapportTaille(B(0, 0, 200, 50), B(0, 0, 100, 50))).toBeCloseTo(2, 6);
    expect(rapportTaille(B(0, 0, 100, 50), B(0, 0, 200, 50))).toBeCloseTo(2, 6);
  });
});

// ─────────────────────────────────────────────────────────
// INVARIANCE DE CADENCE — trajectoire réaliste et bruitée
// ─────────────────────────────────────────────────────────

describe('Suivi — même vidéo, cadences différentes, mêmes identités', () => {
  // Le point de ce bloc : compter les pistes ne suffit pas. Deux exécutions
  // peuvent en trouver cinq chacune tout en attribuant les identifiants à des
  // voitures différentes. On vérifie donc la CORRESPONDANCE voiture → trackId,
  // à chaque instant commun aux deux cadences.
  //
  // Le bruit est indexé sur le NUMÉRO D'IMAGE de la vidéo source (60 img/s),
  // pas sur l'indice d'échantillon : 4 Hz et 10 Hz voient ainsi le même film,
  // simplement à des instants différents. Un bruit tiré par pas rendrait la
  // comparaison vide de sens.
  const FPS = 60, NB = 5, DUREE = 10;
  const bruit = (n, i, sel = 0) => {
    const x = Math.sin(n * 127.1 + i * 311.7 + sel * 74.7) * 43758.5453;
    return x - Math.floor(x);
  };

  /** Voitures qui accélèrent, se resserrent et s'éloignent, caméra qui suit. */
  const verite = (t, i) => {
    const cx = 300 + i * 165 + 300 * t - 9 * t * t - 55 * t;
    const cy = 420 + i * 10 + 26 * t;
    const w = Math.max(70, 175 - 7 * t), h = w * 0.58;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  };

  /** Détections bruitées : gigue de position et de taille, 15 % de ratés,
   *  10 % de doublons décalés — l'ordinaire d'un détecteur sur de la course. */
  function detections(t) {
    const n = Math.round(t * FPS);
    const out = [];
    for (let i = 0; i < NB; i++) {
      if (bruit(n, i, 1) < 0.15) continue;
      const b = verite(t, i);
      const dx = (bruit(n, i, 2) - 0.5) * 14, dy = (bruit(n, i, 3) - 0.5) * 12;
      const dw = (bruit(n, i, 4) - 0.5) * 20;
      out.push({
        box: [b[0] + dx - dw / 2, b[1] + dy - dw / 4, b[2] + dx + dw / 2, b[3] + dy + dw / 4],
        score: 0.45 + bruit(n, i, 5) * 0.5, label: 'car',
      });
      if (bruit(n, i, 6) < 0.10) {
        const [cx, cy] = centre(b);
        const [w, h] = [(b[2] - b[0]) * 0.5, (b[3] - b[1]) * 0.55];
        out.push({ box: [cx - w / 2 + 18, cy - h / 2, cx + w / 2 + 18, cy + h / 2], score: 0.33, label: 'car' });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  const jouer = (dt) => {
    const s = new Suivi({ dt });
    for (let k = 0; k * dt <= DUREE + 1e-9; k++) {
      const t = Number((k * dt).toFixed(3));
      s.pas(t, detections(t));
    }
    return s;
  };

  /** Quelle piste suit la voiture `i` à l'instant `t` ? */
  const carte = (s, t) => {
    const inst = s.journal.find(j => Math.abs(j.t - t) < 1e-6);
    const m = {};
    if (!inst) return m;
    for (let i = 0; i < NB; i++) {
      const vb = verite(t, i);
      let best = null, bi = 0.3;
      for (const tr of inst.tracks) {
        if (!tr.confirmee) continue;
        const r = iou(vb, tr.box);
        if (r > bi) { bi = r; best = tr.id; }
      }
      m[i] = best;
    }
    return m;
  };

  const a = jouer(0.25), b = jouer(0.10);
  const instantsCommuns = Array.from({ length: 19 }, (_, k) => Number((1 + k * 0.5).toFixed(3)));

  it('trouve cinq pistes confirmées aux deux cadences', () => {
    expect(mesurer(a).pistesConfirmeesCreees).toBe(5);
    expect(mesurer(b).pistesConfirmeesCreees).toBe(5);
  });

  it('induit la même STRUCTURE d\'identités aux deux cadences', () => {
    // Comparer les numéros bruts serait faux : ils dépendent de l'ordre de
    // création, donc des premières images échantillonnées, qui diffèrent d'une
    // cadence à l'autre. Ce qui doit coïncider, c'est la CORRESPONDANCE —
    // chaque voiture garde un identifiant unique, et deux voitures n'en
    // partagent jamais un. Le premier jet de ce test comparait les numéros et
    // passait par chance ; il échouait dès qu'on changeait la trajectoire.
    for (const s of [a, b]) {
      const parVoiture = {};
      for (const t of instantsCommuns) {
        const c = carte(s, t);
        for (let i = 0; i < NB; i++) if (c[i]) (parVoiture[i] ||= new Set()).add(c[i]);
      }
      // Une voiture, un identifiant, du début à la fin.
      for (let i = 0; i < NB; i++) expect([...(parVoiture[i] || [])]).toHaveLength(1);
      // Et jamais deux voitures sous le même.
      const ids = Object.values(parVoiture).map(s2 => [...s2][0]);
      expect(new Set(ids).size).toBe(NB);
    }
  });

  it('ne change jamais d\'identifiant en cours de séquence', () => {
    for (const s of [a, b]) {
      const vu = {};
      const changements = [];
      for (const t of instantsCommuns) {
        const c = carte(s, t);
        for (let i = 0; i < NB; i++) {
          if (!c[i]) continue;
          if (vu[i] && vu[i] !== c[i]) changements.push({ t, voiture: i, avant: vu[i], apres: c[i] });
          vu[i] = c[i];
        }
      }
      expect(changements).toEqual([]);
    }
  });

  it('suit chaque voiture à tous les instants communs, malgré les ratés', () => {
    // Un raté de détection ne doit pas faire disparaître la voiture du suivi :
    // c'est toute la raison d'être des états prédit et occlus.
    for (const s of [a, b]) {
      for (const t of instantsCommuns) {
        expect(Object.values(carte(s, t)).filter(Boolean)).toHaveLength(NB);
      }
    }
  });
});

describe('Suivi — un objet intermittent ne doit pas multiplier les identités', () => {
  // Cas soupçonné sur la vidéo réelle : une voiture détectée par intermittence,
  // avec des trous plus longs que la tolérance d'abandon. Sans repêchage, elle
  // renaît sous un nouvel identifiant à chaque retour — et d'autant plus
  // souvent qu'on échantillonne vite.
  const clignotant = (dt) => {
    const s = new Suivi({ dt });
    for (let k = 0; k * dt <= 12 + 1e-9; k++) {
      const t = Number((k * dt).toFixed(3));
      const visible = Math.floor(t / 1.2) % 2 === 0;          // 1,2 s visible, 1,2 s absente
      s.pas(t, visible ? [{ box: B(400 + t * 30, 400, 160, 90), score: 0.8, label: 'car' }] : []);
    }
    return s;
  };

  it('repêche la piste au lieu d\'en créer une nouvelle à chaque retour', () => {
    for (const dt of [0.25, 0.1]) {
      const s = clignotant(dt);
      const m = mesurer(s, { cible: 1 });
      expect(m.reactivations).toBeGreaterThan(0);
      expect(m.pistesConfirmeesCreees).toBe(1);
    }
  });

  it('ne dépend pas de la cadence pour y parvenir', () => {
    expect(mesurer(clignotant(0.25)).pistesConfirmeesCreees)
      .toBe(mesurer(clignotant(0.1)).pistesConfirmeesCreees);
  });
});

describe('mesurer — ventilation des refus d\'association', () => {
  it('classe chaque refus et désigne la cause dominante', () => {
    const s = new Suivi({ dt: 0.25 });
    for (let k = 0; k < 10; k++) {
      const d = [0, 1, 2].map(i => det(B(300 + i * 260 + k * 20, 400, 160, 90)));
      if (k === 4) d.splice(1, 1);                    // un raté
      if (k === 6) d.push(det(B(1500, 900, 120, 70), 0.4));   // un parasite isolé
      s.pas(k * 0.25, d);
    }
    const r = mesurer(s, { cible: 3 }).refus;
    expect(r.total).toBeGreaterThan(0);
    expect(r.dominante).toHaveProperty('raison');
    expect(Object.keys(r.parRaison).every(k => Object.values(REFUS).includes(k))).toBe(true);
    expect(r.parCote).toHaveProperty('piste');
    expect(r.parCote).toHaveProperty('detection');
    expect(r.medianes).toHaveProperty('iou');
  });

  it('distingue une piste déjà attribuée d\'un simple manque de recouvrement', () => {
    expect(REFUS.DEJA_ATTRIBUEE).not.toBe(REFUS.IOU_INSUFFISANT);
    expect(Object.values(REFUS)).toContain(REFUS.COUT_HONGROIS);
  });
});

// ═══════════════════════════════════════════════
// INSTRUMENTATION : ruptures de plan, cohérence spatiale
//
// Ces fonctions ne changent RIEN au suivi : elles mesurent. Les tests
// vérifient donc qu'elles mesurent la bonne chose, et surtout qu'elles ne
// confondent pas un changement de caméra avec une occlusion collective.
// ═══════════════════════════════════════════════

describe('détection des ruptures de plan', () => {
  /** Journal minimal, au format exporté. */
  const inst = (t, ids, opts = {}) => ({
    t,
    detections: { total: ids.length, fortes: ids.length, faibles: 0, fusions: 0, doublons: 0 },
    association: opts.association ?? null,
    counts: { detected: opts.detected ?? ids.length, predicted: opts.predicted ?? 0, occluded: opts.occluded ?? 0, tentative: 0 },
    tracks: ids.map((id, i) => ({ id, box: B(100 + i * 200, 400), state: 'detected', confirmee: true })),
  });

  it('signale l\'instant où toutes les pistes se perdent ET où des identités naissent', () => {
    const journal = [
      inst(0, [1, 2, 3, 4, 5]),
      inst(0.25, [1, 2, 3, 4, 5], { association: { candidates: 5, appariees: 5, sansMesure: 0, creees: 0 } }),
      // le plan change : plus rien ne s'apparie, cinq identités neuves
      inst(0.5, [6, 7, 8, 9, 10], { association: { candidates: 5, appariees: 0, sansMesure: 5, creees: 5 } }),
      inst(0.75, [6, 7, 8, 9, 10], { association: { candidates: 5, appariees: 5, sansMesure: 0, creees: 0 } }),
    ];
    const { cuts } = detecterRuptures(journal);
    expect(cuts.map(c => c.t)).toEqual([0.5]);
  });

  it('ne prend pas une occlusion collective pour un changement de plan', () => {
    // Toutes les pistes perdent leur détection, mais AUCUNE identité ne naît :
    // c'est un passage derrière un panneau, pas un cut.
    const journal = [
      inst(0, [1, 2, 3]),
      inst(0.25, [1, 2, 3], { association: { candidates: 3, appariees: 3, sansMesure: 0, creees: 0 } }),
      inst(0.5, [1, 2, 3], { association: { candidates: 3, appariees: 0, sansMesure: 3, creees: 0 } }),
    ];
    expect(detecterRuptures(journal).cuts).toEqual([]);
  });

  it('ne prend pas une rafale de créations pour un changement de plan', () => {
    // Des identités naissent — mais les pistes existantes s'apparient toutes :
    // c'est du bruit de détection, pas une réinitialisation du référentiel.
    const journal = [
      inst(0, [1, 2, 3]),
      inst(0.25, [1, 2, 3, 4, 5], { association: { candidates: 3, appariees: 3, sansMesure: 0, creees: 2 } }),
    ];
    expect(detecterRuptures(journal).cuts).toEqual([]);
  });

  it('regroupe en une seule coupure les instants consécutifs signalés', () => {
    const rompu = { candidates: 5, appariees: 1, sansMesure: 4, creees: 3 };
    const journal = [
      inst(0, [1, 2, 3, 4, 5]),
      inst(0.1, [1, 2, 3, 4, 5], { association: { candidates: 5, appariees: 5, sansMesure: 0, creees: 0 } }),
      inst(0.2, [6, 7, 8, 4, 5], { association: rompu }),
      inst(0.3, [9, 10, 11, 4, 5], { association: rompu }),
      inst(0.4, [12, 13, 14, 4, 5], { association: rompu }),
    ];
    const { cuts } = detecterRuptures(journal);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].debut).toBe(0.2);
    expect(cuts[0].fin).toBe(0.4);
  });

  it('retombe sur le compte des refus quand le bilan d\'association manque', () => {
    // Les rapports déjà exportés n'ont pas de champ `association` : sans ce
    // repli, la fonction ne pourrait pas être validée sur les mesures réelles
    // déjà faites — et les pistes non confirmées, qui restent `tentative`
    // qu'elles soient appariées ou non, feraient passer la rupture inaperçue.
    const journal = [inst(0, [1, 2, 3, 4, 5]), inst(0.25, [6, 7, 8, 9, 10])];
    const refus = [
      ...[1, 2, 3, 4, 5].map(id => ({ t: 0.25, cote: 'piste', id, raison: REFUS.DISTANCE })),
      ...[0, 1, 2].map(() => ({ t: 0.25, cote: 'detection', id: null, raison: REFUS.DISTANCE })),
    ];
    expect(detecterRuptures(journal, { refus }).cuts.map(c => c.t)).toEqual([0.25]);
    expect(detecterRuptures(journal).cuts).toEqual([]);   // sans les refus, invisible
  });
});

describe('ventilation autour des ruptures', () => {
  const inst = (t, ids, association) => ({
    t,
    detections: { total: ids.length, fortes: ids.length, faibles: 0, fusions: 0, doublons: 0 },
    association,
    counts: { detected: ids.length, predicted: 0, occluded: 0, tentative: 0 },
    tracks: ids.map((id, i) => ({ id, box: B(100 + i * 200, 400), state: 'detected', confirmee: true })),
  });

  it('sépare les créations dues à la coupure de celles qui n\'y sont pour rien', () => {
    const ok = (n) => ({ candidates: n, appariees: n, sansMesure: 0, creees: 0 });
    const journal = [
      inst(0, [1, 2, 3], ok(3)),
      inst(1, [1, 2, 3, 4], { candidates: 3, appariees: 3, sansMesure: 0, creees: 1 }),   // loin du cut
      inst(2, [5, 6, 7, 8], { candidates: 4, appariees: 0, sansMesure: 4, creees: 4 }),   // le cut
      inst(3, [5, 6, 7, 8], ok(4)),
    ];
    const { cuts } = detecterRuptures(journal);
    const v = ventilerAutourDesRuptures(journal, [], cuts);
    expect(v.creations.total).toBe(5);      // la grille de départ ne compte pas
    expect(v.creations.pres).toBe(4);
    expect(v.creations.hors).toBe(1);
  });

  it('isole les refus de COMPÉTITION, seuls justiciables d\'un arbitrage', () => {
    const journal = [inst(0, [1], { candidates: 1, appariees: 1, sansMesure: 0, creees: 0 })];
    const refus = [
      { t: 0, cote: 'detection', raison: REFUS.DEJA_ATTRIBUEE },
      { t: 0, cote: 'piste', raison: REFUS.COUT_HONGROIS },
      { t: 0, cote: 'piste', raison: REFUS.DISTANCE },
      { t: 0, cote: 'piste', raison: REFUS.RATIO_TAILLE },
    ];
    const v = ventilerAutourDesRuptures(journal, refus, []);
    expect(v.competition.total).toBe(2);
    expect(v.competition.part).toBe(0.5);
  });
});

describe('cohérence spatiale du groupe', () => {
  const inst = (t, positions) => ({
    t,
    detections: { total: positions.length, fortes: positions.length, faibles: 0, fusions: 0, doublons: 0 },
    counts: { detected: positions.length, predicted: 0, occluded: 0, tentative: 0 },
    tracks: positions.map(([id, x]) => ({ id, box: B(x, 400), state: 'detected', confirmee: true })),
  });

  it('ne compte aucune inversion quand le peloton garde son ordre', () => {
    const c = coherenceSpatiale([
      inst(0, [[1, 100], [2, 300], [3, 500]]),
      inst(0.25, [[1, 120], [2, 320], [3, 520]]),
    ]);
    expect(c.inversions).toBe(0);
    expect(c.pairesSuivies).toBe(3);
  });

  it('compte l\'inversion d\'un dépassement, sans la traiter comme une faute', () => {
    const c = coherenceSpatiale([
      inst(0, [[1, 100], [2, 300]]),
      inst(0.25, [[1, 340], [2, 300]]),
    ]);
    expect(c.inversions).toBe(1);
    expect(c.tauxInversion).toBe(1);
  });

  it('mesure l\'écart entre voisins en largeurs de boîte', () => {
    // deux boîtes de 160 px de large, centres distants de 160 px → écart 1,0
    const c = coherenceSpatiale([inst(0, [[1, 100], [2, 260]])]);
    expect(c.ecartVoisins.median).toBe(1);
  });

  it('ignore les pistes non confirmées', () => {
    const j = inst(0, [[1, 100], [2, 300]]);
    j.tracks[1].confirmee = false;
    const j2 = inst(0.25, [[1, 100], [2, 300]]);
    j2.tracks[1].confirmee = false;
    expect(coherenceSpatiale([j, j2]).pairesSuivies).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// BORNES DE LA VITESSE DE TAILLE
//
// Les deux premiers tests ne sont pas des scénarios inventés : ils REJOUENT
// les largeurs mesurées de deux pistes du rapport 10 Hz réel, et vérifient
// d'abord que le prédicteur sans bornes reproduit bien l'effondrement observé
// dans ce rapport. Sans cette étape, rien ne prouverait que la correction
// s'attaque à la vraie cause plutôt qu'à une cause supposée.
// ═══════════════════════════════════════════════

describe('vitesse de taille bornée', () => {
  const SANS = { vitesseTailleMax: Infinity, ratioTailleMax: Infinity };

  /** Rejoue une suite de boîtes mesurées, puis extrapole `n` pas. */
  const rejouer = (opts, boites, dt, n) => {
    const p = new Predicteur(boites[0], opts);
    for (let i = 1; i < boites.length; i++) p.corriger(boites[i], dt);
    const largeurs = [];
    for (let i = 0; i < n; i++) { p.avancerSansMesure(dt); largeurs.push(Math.round(p.boite[2] - p.boite[0])); }
    return largeurs;
  };

  // Piste #10 du rapport 10 Hz : la boîte passe de 211 px à 110 px en deux
  // pas — une fusion qui se sépare — puis la détection manque.
  const PISTE_10 = [B(656, 544, 211, 58), B(656, 544, 211, 58), B(656, 544, 211, 58),
    B(521, 542, 129, 60), B(527, 545, 110, 63)];
  // Piste #18 : la voiture sort du cadre par la droite. Le détecteur tronque
  // la boîte au bord de l'image, donc la largeur MESURÉE s'effondre alors que
  // la voiture, elle, ne change pas de taille — la hauteur reste à ~165 px.
  const PISTE_18 = [B(1735, 450, 271, 167), B(1790, 458, 257, 170), B(1826, 473, 183, 175),
    B(1861, 496, 120, 169), B(1865, 523, 110, 160)];

  it('reproduit l\'effondrement observé dans le rapport 10 Hz réel', () => {
    // Le journal du rapport donne, pour la piste #10 : 104 81 63 48 36 25 17 10.
    expect(rejouer(SANS, PISTE_10, 0.1, 8)).toEqual([104, 82, 63, 48, 36, 25, 17, 10]);
    // et pour la piste #18, la largeur atteint le plancher de 1 px.
    expect(rejouer(SANS, PISTE_18, 0.1, 8).slice(-3)).toEqual([1, 1, 1]);
  });

  it('empêche cet effondrement, sur les mêmes mesures réelles', () => {
    for (const piste of [PISTE_10, PISTE_18]) {
      const largeurs = rejouer({}, piste, 0.1, 8);
      const derniereMesure = piste[piste.length - 1][2] - piste[piste.length - 1][0];
      // La boîte prédite reste du gabarit de la voiture, à moins d'un tiers près.
      for (const l of largeurs) expect(l).toBeGreaterThan(derniereMesure * 0.6);
      expect(largeurs[largeurs.length - 1]).toBeLessThan(derniereMesure * 1.5);
    }
  });

  it('rend le repêchage à nouveau possible sur ces mêmes pistes', () => {
    // Le cas concret des ZÉRO réactivations à 10 Hz : `_reactiver()` exige un
    // rapport de taille (en AIRE) ≤ 2,0 contre la boîte prédite. Une boîte
    // effondrée à 1 px de large ne peut plus jamais y satisfaire.
    const apres = (opts, piste, n) => {
      const p = new Predicteur(piste[0], opts);
      for (let i = 1; i < piste.length; i++) p.corriger(piste[i], 0.1);
      for (let i = 0; i < n; i++) p.avancerSansMesure(0.1);
      return p.boite;
    };
    const voiture = B(540, 545, 112, 62);       // la voiture, telle qu'elle réapparaîtrait
    expect(rapportTaille(apres({}, PISTE_10, 10), voiture)).toBeLessThan(DEFAULTS.maxSizeRatio);
    expect(rapportTaille(apres(SANS, PISTE_10, 10), voiture)).toBeGreaterThan(DEFAULTS.maxSizeRatio);
  });

  it('borne la vitesse relativement à la taille COURANTE, ce qui la fait converger', () => {
    // C'est la propriété qui rend la dérive impossible plutôt que plus lente :
    // une boîte qui rétrécit voit son plafond rétrécir avec elle, donc la
    // décroissance devient géométrique et n'atteint jamais le plancher.
    const p = new Predicteur(B(500, 500, 400, 240), {});
    p.corriger(B(500, 500, 120, 72), 0.1);
    const suite = [];
    for (let i = 0; i < 40; i++) { p.avancerSansMesure(0.1); suite.push(p.boite[2] - p.boite[0]); }
    expect(suite[suite.length - 1]).toBeGreaterThan(1);
    // strictement décroissante, jamais un bond
    for (let i = 1; i < suite.length; i++) expect(suite[i]).toBeLessThanOrEqual(suite[i - 1] + 1e-9);
  });

  it('laisse passer une croissance réelle, jusqu\'au p99 mesuré sur la vidéo', () => {
    // 0,9 s⁻¹ : 99ᵉ centile du taux vrai mesuré sur Kerlabo, base d'une
    // seconde, identique à 4 Hz et à 10 Hz. Le plafond à 1,0 ne doit rien
    // refuser en dessous, sinon il ferait décrocher une voiture qui approche.
    let w = 200;
    const p = new Predicteur(B(500, 500, w, w * 0.6), {});
    for (let i = 0; i < 10; i++) { w *= 1 + 0.9 * 0.1; p.corriger(B(500, 500, w, w * 0.6), 0.1); }
    const suivie = p.boite[2] - p.boite[0];
    expect(suivie).toBeGreaterThan(w * 0.85);
    expect(suivie).toBeLessThan(w * 1.15);
    expect(p.vitesseBornee).toBe(0);
  });

  it('écrête le résidu de taille au lieu de l\'ignorer', () => {
    // Ignorer un résidu aberrant laisse intacte une vitesse déjà fausse : la
    // piste continue de dériver sans que rien ne la rappelle. Écrêter garantit
    // que la vitesse va toujours VERS la mesure, sans jamais bondir.
    const vitesse = (mesure) => {
      const p = new Predicteur(B(500, 500, 200, 120), {});
      p.corriger(B(500, 500, mesure, mesure * 0.6), 0.25);
      return p.s.vw;
    };
    // Une mesure au double est traitée exactement comme une mesure à ×1,5 :
    // c'est là que l'écrêtage se voit.
    expect(vitesse(400)).toBeCloseTo(vitesse(300), 6);
    expect(vitesse(400)).toBeGreaterThan(0);          // et pas figée à zéro
    // En dessous de la porte, rien n'est touché.
    expect(vitesse(260)).toBeLessThan(vitesse(300));
  });

  it('écrête symétriquement en RAPPORT, pas en pixels', () => {
    // Un écrêtage symétrique en pixels tolérerait +50 % mais −50 %, soit un
    // rapport de 2 d'un côté et 1,5 de l'autre : un biais à la baisse.
    const p = new Predicteur(B(500, 500, 200, 120), {});
    p.corriger(B(500, 500, 20, 12), 0.25);            // mesure dix fois trop petite
    // la largeur corrigée ne descend pas en dessous de 200 ÷ 1,5 par l'effet
    // de la vitesse : seul le terme de position, non borné ici, la fait bouger
    expect(p.s.vw).toBeGreaterThan(-((1 - 1 / DEFAULTS.ratioTailleMax) * 200) / 0.25);
    expect(p.residusEcretes).toBeGreaterThan(0);
  });

  it('ne change pas les identités quand deux voitures de gabarits différents se croisent', () => {
    // Contrôle de non-régression : la borne rend les prédictions plus justes,
    // jamais plus permissives — elle ne peut donc pas créer d'échange.
    const s = new Suivi({ dt: 0.25 });
    for (let k = 0; k < 12; k++) {
      s.pas(k * 0.25, [
        det(B(300 + k * 60, 500, 220, 130)),          // grosse, vers la droite
        det(B(1000 - k * 60, 520, 120, 70)),          // petite, vers la gauche
      ]);
    }
    const fin = s.journal[s.journal.length - 1].tracks
      .filter(x => x.confirmee).sort((a, b) => a.box[0] - b.box[0]);
    expect(fin).toHaveLength(2);
    expect(fin[0].box[2] - fin[0].box[0]).toBeLessThan(fin[1].box[2] - fin[1].box[0]);
    expect(Math.max(...fin.map(x => x.id))).toBeLessThanOrEqual(2);   // aucune identité neuve
  });

  it('mesure la dérive de taille et l\'usage des deux gardes', () => {
    // À noter : au fil d'une séquence normale, l'écrêtage sert PEU. La porte
    // d'association refuse déjà un rapport d'aire supérieur à 2, donc les
    // résidus qu'elle laisse passer sont rarement au-delà de 1,5 en linéaire.
    // C'est le plafond de vitesse qui fait le travail — l'effondrement observé
    // se construit par petits pas tous licites, jamais par un bond unique.
    const s = new Suivi({ dt: 0.25 });
    let w = 240;
    for (let k = 0; k < 10; k++) {
      w *= 0.8;                                       // sortie de cadre : la boîte est rognée
      s.pas(k * 0.25, [det(B(500 + k * 30, 500, w, 140))]);
    }
    const m = mesurer(s, { cible: 1 });
    expect(m.deriveTaille).not.toBeNull();
    expect(Number.isFinite(m.deriveTaille.max)).toBe(true);
    expect(m.deriveTaille.vitesseBornee).toBeGreaterThan(0);
    expect(m.deriveTaille.residusEcretes).toBeGreaterThanOrEqual(0);
  });

  it('expose les deux bornes dans les réglages, pour qu\'elles figurent au rapport', () => {
    expect(DEFAULTS.vitesseTailleMax).toBe(1.0);
    expect(DEFAULTS.ratioTailleMax).toBe(1.5);
  });
});

// ═══════════════════════════════════════════════
// MÉMOIRE D'APPARENCE
//
// Le suivi ne calcule aucune signature : le banc en injecte une dans la
// détection, la piste la range si l'observation est propre, et RIEN ne la lit.
// Le dernier test de ce bloc est le plus important — il vérifie que le suivi
// se comporte exactement pareil avec et sans signatures.
// ═══════════════════════════════════════════════

describe('mémoire d\'apparence des pistes', () => {
  const SIG = [0.5, 0.25, 0.25];
  const detSig = (box, score = 0.8, sig = SIG) => ({ box, score, label: 'car', sig });
  const roulage = (s, n, opts = {}) => {
    for (let k = 0; k < n; k++) {
      const t = k * 0.25;
      const dets = opts.dets ? opts.dets(k, t) : [detSig(B(300 + k * 40, 500))];
      s.pas(t, dets);
    }
    return s.pistes[0];
  };

  it('range les observations fortes et propres', () => {
    const p = roulage(new Suivi({ dt: 0.25 }), 5);
    expect(p.apparences).toHaveLength(5);
    expect(p.apparences[0].sig).toEqual(SIG);
    expect(p.apparences[0].box).toEqual(B(300, 500).map(Math.round));
  });

  it('ne range RIEN quand la détection ne porte pas de signature', () => {
    const s = new Suivi({ dt: 0.25 });
    for (let k = 0; k < 5; k++) s.pas(k * 0.25, [det(B(300 + k * 40, 500))]);
    expect(s.pistes[0].apparences).toHaveLength(0);
  });

  it('ne range pas une boîte prédite', () => {
    // Un trou de détection : l'instant sans mesure ne doit rien mémoriser.
    const p = roulage(new Suivi({ dt: 0.25 }), 6, {
      dets: (k) => (k === 3 ? [] : [detSig(B(300 + k * 40, 500))]),
    });
    expect(p.apparences).toHaveLength(5);
    expect(p.apparences.every(a => Math.abs(a.t - 0.75) > 1e-9)).toBe(true);
  });

  it('ne range pas un sauvetage par la bande basse', () => {
    // Une détection sous le seuil raccroche la piste, mais elle est trop
    // incertaine pour définir une livrée.
    const p = roulage(new Suivi({ dt: 0.25 }), 6, {
      dets: (k) => [detSig(B(300 + k * 40, 500), k === 3 ? 0.15 : 0.8)],
    });
    expect(p.apparences.every(a => a.score >= 0.3)).toBe(true);
    expect(p.apparences).toHaveLength(5);
  });

  it('ne range pas une boîte qui touche le bord de l\'image', () => {
    // La livrée y est tronquée par le cadre — le défaut qui avait fait
    // s'effondrer les largeurs prédites au point ①.
    const s = new Suivi({ dt: 0.25, largeurImage: 1920, hauteurImage: 1080 });
    for (let k = 0; k < 5; k++) s.pas(k * 0.25, [detSig(B(1830 + k * 20, 500, 200, 120))]);
    expect(s.pistes[0].apparences.length).toBeLessThan(5);
    expect(s.pistes[0].apparences.every(a => a.box[2] < 1918)).toBe(true);
  });

  it('borne l\'anneau, et garde les plus RÉCENTES', () => {
    const s = new Suivi({ dt: 0.25, memoireApparence: 3 });
    const p = roulage(s, 8);
    expect(p.apparences).toHaveLength(3);
    expect(p.apparences[2].t).toBeCloseTo(1.75, 3);
  });

  it('se désactive proprement à zéro', () => {
    expect(roulage(new Suivi({ dt: 0.25, memoireApparence: 0 }), 5).apparences).toHaveLength(0);
  });

  it('trace la qualité de chaque pas dans l\'historique', () => {
    const p = roulage(new Suivi({ dt: 0.25 }), 6, {
      dets: (k) => (k === 3 ? [] : [detSig(B(300 + k * 40, 500))]),
    });
    const sansMesure = p.history.find(h => Math.abs(h.t - 0.75) < 1e-9);
    expect(sansMesure.source).toBe('prediction');
    expect(sansMesure.ambigu).toBe(true);
    expect(p.history[0].source).toBe('creation');
  });

  it('ne change RIEN au comportement du suivi', () => {
    // La garantie qui compte : la mémoire est remplie, jamais lue. Deux
    // séquences identiques, l'une avec signatures et l'autre sans, doivent
    // produire exactement le même journal.
    const scenario = (avecSig) => {
      const s = new Suivi({ dt: 0.25, largeurImage: 1920, hauteurImage: 1080 });
      for (let k = 0; k < 14; k++) {
        const t = k * 0.25;
        const dets = [
          B(300 + k * 60, 500, 220, 130),
          B(1000 - k * 60, 520, 120, 70),
          ...(k % 4 === 0 ? [B(700, 300, 90, 60)] : []),
        ].map(b => (avecSig ? detSig(b, 0.8) : det(b)));
        s.pas(t, dets);
      }
      return JSON.stringify(s.journal.map(j => ({
        t: j.t, counts: j.counts, association: j.association,
        tracks: j.tracks.map(x => ({ id: x.id, box: x.box, state: x.state, confirmee: x.confirmee })),
      })));
    };
    expect(scenario(true)).toBe(scenario(false));
  });
});

// ═══════════════════════════════════════════════
// COUPURE DE PLAN, FILIATION, IDENTITÉS LOGIQUES
//
// Le témoin ① : au cut, tout est suspendu, rien ne traverse, et les identités
// repartent de zéro. C'est volontairement le PIRE cas — il donne la valeur
// contre laquelle une réattribution devra prouver son gain.
// ═══════════════════════════════════════════════

describe('repêchage d\'une piste décrochée mais encore vivante', () => {
  /** Une voiture lancée, un trou de `sauts` pas, puis elle réapparaît décalée. */
  const scenario = (sauts, decalage, options = {}) => {
    reinitialiserIds();
    const s = new Suivi({ dt: 0.1, ...options });
    let x = 300;
    for (let k = 0; k < 8; k++) { s.pas(k * 0.1, [det(B(x, 500))]); x += 40; }
    const idAvant = s.pistes[0].id;
    for (let k = 8; k < 8 + sauts; k++) { s.pas(k * 0.1, []); x += 40; }
    // Elle revient là où la prédiction amortie ne l'attend plus.
    const inst = s.pas((8 + sauts) * 0.1, [det(B(x + decalage, 500))]);
    return { s, idAvant, inst };
  };

  it('reprend l\'identité au lieu d\'en créer une neuve', () => {
    const { s, idAvant, inst } = scenario(4, 90);
    expect(inst.tracks.map(t => t.id)).toContain(idAvant);
    expect(s.pistes.filter(p => p.state !== ETATS.LOST)).toHaveLength(1);
  });

  it('sans la fenêtre de repêchage, la même voiture devient une identité neuve', () => {
    // `dureeAvantRepechage` très grand : le repêchage attend que la piste
    // soit déclarée perdue, comme avant. La piste d'origine survit alors sans
    // mesure, extrapolée dans le vide, pendant qu'une identité de plus naît
    // sur la détection décalée — l'interstice exact que le diagnostic a
    // mesuré, 461 fois sur la séquence de Kerlabo.
    const avec = scenario(4, 90);
    const sans = scenario(4, 90, { dureeAvantRepechage: 99 });
    const servie = (r) => r.inst.tracks.find(t => t.id === r.idAvant)?.boiteAssociee;
    expect(servie(avec)).toBeTruthy();
    expect(servie(sans)).toBeFalsy();
    expect(sans.inst.tracks.length).toBeGreaterThan(avec.inst.tracks.length);
  });

  it('ne repêche PAS une piste qui vient d\'être servie', () => {
    // Deux voitures : celle de gauche est détectée à cet instant, elle ne
    // doit pas en plus absorber la détection de sa voisine.
    reinitialiserIds();
    const s = new Suivi({ dt: 0.1 });
    for (let k = 0; k < 8; k++) s.pas(k * 0.1, [det(B(300 + 40 * k, 500)), det(B(900 + 40 * k, 500))]);
    const avant = s.pistes.map(p => p.id);
    const inst = s.pas(0.8, [det(B(620, 500)), det(B(1220, 500))]);
    // chaque piste garde SA voiture, aucune n'en prend deux
    expect(inst.tracks.filter(t => t.boiteAssociee)).toHaveLength(2);
    expect(inst.tracks.map(t => t.id).sort()).toEqual(avant.sort());
  });

  it('ne repêche jamais à travers une coupure', () => {
    reinitialiserIds();
    const s = new Suivi({ dt: 0.1 });
    let x = 300;
    for (let k = 0; k < 8; k++) { s.pas(k * 0.1, [det(B(x, 500))]); x += 40; }
    const idAvant = s.pistes[0].id;
    s.couper(0.8);
    const inst = s.pas(0.9, [det(B(x + 90, 500))]);
    expect(inst.tracks.map(t => t.id)).not.toContain(idAvant);
  });
});

describe('coupure de plan', () => {
  const roulerAvecCoupure = (opts = {}) => {
    const s = new Suivi({ dt: 0.25, ...opts });
    // trois voitures, plan A : elles vont vers la droite
    for (let k = 0; k < 8; k++) {
      s.pas(k * 0.25, [0, 1, 2].map(i => det(B(300 + i * 200 + k * 40, 500))));
    }
    s.couper(2.0);
    // plan B : mêmes voitures, ailleurs dans l'image et dans l'autre sens
    for (let k = 8; k < 16; k++) {
      s.pas(k * 0.25, [0, 1, 2].map(i => det(B(1500 - i * 200 - (k - 8) * 40, 700))));
    }
    return s;
  };

  it('suspend toutes les pistes vivantes, et le dit', () => {
    const s = new Suivi({ dt: 0.25 });
    for (let k = 0; k < 6; k++) s.pas(k * 0.25, [det(B(300 + k * 40, 500)), det(B(800 + k * 40, 500))]);
    const suspendues = s.couper(1.5);
    expect(suspendues).toHaveLength(2);
    expect(s.suspendues.map(p => p.id)).toEqual(suspendues);
    expect(s.suspendues.every(p => p.raisonSuppression === RAISONS.COUPURE)).toBe(true);
    expect(s.actives).toHaveLength(0);
  });

  it('suspend aussi les pistes DÉJÀ perdues — sinon elles reviennent après la coupure', () => {
    const s = new Suivi({ dt: 0.25 });
    // deux voitures ; la seconde disparaît assez tôt pour être LOST au cut.
    for (let k = 0; k < 6; k++) {
      const dets = [det(B(300 + k * 40, 500))];
      if (k < 2) dets.push(det(B(1200 + k * 40, 500)));
      s.pas(k * 0.25, dets);
    }
    const perdue = s.pistes.find(p => p.state === ETATS.LOST);
    expect(perdue).toBeDefined();

    const suspendues = s.couper(1.5);
    expect(suspendues).toContain(perdue.id);
    expect(s.pistes.every(p => p.suspendue)).toBe(true);

    // le plan suivant repasse là où la perdue avait été vue : sans suspension
    // elle serait réactivée et franchirait la coupure.
    for (let k = 6; k < 12; k++) s.pas(k * 0.25, [det(B(1240, 500))]);
    expect(perdue.suspendue).toBe(true);
    expect(perdue.reactivated).toBe(0);
    expect(s.pistes.filter(p => !p.suspendue).every(p => p.id > Math.max(...suspendues))).toBe(true);
  });

  it('oublie le modèle de caméra du plan précédent', () => {
    const s = new Suivi({ dt: 0.25, cameraCompensation: true });
    for (let k = 0; k < 8; k++) s.pas(k * 0.25, [0, 1, 2, 3].map(i => det(B(300 + i * 200 + k * 60, 500))));
    s.couper(2.0);
    expect(s.modeleCamera).toBeNull();
    expect(s.derniereCamera).toEqual({ dx: 0, dy: 0, n: 0 });
  });

  it('ne réactive ni ne reprend AUCUNE piste à travers la coupure', () => {
    const s = roulerAvecCoupure();
    const avant = s.pistes.filter(p => p.suspendue);
    expect(avant).toHaveLength(3);
    // aucune suspendue n'a été ressuscitée
    expect(avant.every(p => p.reactivated === 0 && p.lastSeen <= 1.75 + 1e-9)).toBe(true);
    // et le plan B a bien créé des identités NEUVES
    const apres = s.pistes.filter(p => !p.suspendue);
    expect(apres.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...apres.map(p => p.id))).toBeGreaterThan(Math.max(...avant.map(p => p.id)));
  });

  it('n\'extrapole plus une piste suspendue', () => {
    const s = roulerAvecCoupure();
    for (const p of s.pistes.filter(x => x.suspendue)) {
      const apresCoupure = p.history.filter(h => h.t >= 2.0);
      expect(apresCoupure).toHaveLength(0);
    }
  });

  it('compte les identités du départ qui atteignent le V1 — zéro sans réattribution', () => {
    const s = roulerAvecCoupure();
    const m = mesurer(s, { cible: 3, tV1: 3.75 });
    expect(m.identites.auDepart).toBe(3);
    expect(m.identites.auV1).toBeGreaterThan(0);
    // Le témoin : la coupure casse toutes les chaînes.
    expect(m.identites.survivantesDepart).toBe(0);
    expect(m.identites.suspenduesTotal).toBe(3);
    expect(m.identites.reattribuees).toBe(0);
    expect(m.identites.coupures).toEqual([{ t: 2, suspendues: 3 }]);
  });

  it('sans coupure, les identités du départ survivent', () => {
    // Contrôle : la mesure ne rend pas zéro par construction.
    const s = new Suivi({ dt: 0.25 });
    for (let k = 0; k < 16; k++) {
      s.pas(k * 0.25, [0, 1, 2].map(i => det(B(300 + i * 200 + k * 40, 500))));
    }
    const m = mesurer(s, { cible: 3, tV1: 3.75 });
    expect(m.identites.auDepart).toBe(3);
    expect(m.identites.survivantesDepart).toBe(3);
    expect(m.identites.coupures).toEqual([]);
  });

  it('ne signale aucune bifurcation tant que rien n\'est réattribué', () => {
    const m = mesurer(roulerAvecCoupure(), { cible: 3, tV1: 3.75 });
    expect(m.identites.instantsBifurques).toBe(0);
  });

  it('publie l\'identité logique de chaque piste dans le journal', () => {
    const s = roulerAvecCoupure();
    const inst = s.journal[s.journal.length - 1];
    expect(inst.tracks.every(t => t.identiteLogique === t.id)).toBe(true);
  });
});
