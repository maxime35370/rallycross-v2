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
