/* ═══════════════════════════════════════════════
   TRACKERCORE.TEST.JS — Suivi temporel, logique pure

   Les scénarios sont synthétiques et volontairement extrêmes : c'est le seul
   moyen de vérifier un tracker sans vérité terrain annotée. Chacun reproduit
   une situation observée sur le corpus Kerlabo — détection manquée, boîte
   fusionnée sur deux voitures, panoramique de caméra, voitures qui se frôlent.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  ETATS, DEFAULTS, Suivi, Predicteur, hungarian, decalageCamera,
  estimerDecalageGlobal, rapportTaille, mesurer, signauxSuspects, concorder,
} from '../tools/yolox-poc/lib/track.mjs';

/** Boîte carrée centrée, pour écrire des scénarios lisibles. */
const B = (cx, cy, w = 100, h = 60) => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
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

describe('Suivi — une boîte engloutit deux voitures', () => {
  // Cas observé sur `milieu_v1` : deux pistes bien établies, puis une seule
  // détection large qui les recouvre toutes les deux, puis re-séparation.
  const seq = [];
  for (let k = 0; k < 5; k++) seq.push([det(B(300 + k * 10, 400)), det(B(420 + k * 10, 400))]);
  for (let k = 5; k < 8; k++) seq.push([det(B(400 + k * 10, 400, 230, 70), 0.62)]);
  for (let k = 8; k < 13; k++) seq.push([det(B(300 + k * 10, 400)), det(B(420 + k * 10, 400))]);

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
    expect(DEFAULTS.maxOccludedAge).toBeGreaterThan(DEFAULTS.maxAge);
  });
});

describe('rapportTaille', () => {
  it('est symétrique et vaut 1 sur deux boîtes identiques', () => {
    expect(rapportTaille(B(0, 0, 100, 50), B(9, 9, 100, 50))).toBeCloseTo(1, 6);
    expect(rapportTaille(B(0, 0, 200, 50), B(0, 0, 100, 50))).toBeCloseTo(2, 6);
    expect(rapportTaille(B(0, 0, 100, 50), B(0, 0, 200, 50))).toBeCloseTo(2, 6);
  });
});
