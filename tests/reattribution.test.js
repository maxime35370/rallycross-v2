/* RÉATTRIBUTION APRÈS COUPURE — recoller les identités de part et d'autre.

   Deux familles de contrôles :
     · la mécanique (similitude, réflexion, contrôle de sens, refus) sur des
       cas construits, où la bonne réponse est connue par construction ;
     · le CAS RÉEL de Kerlabo, avec les boîtes détectées aux images 348 et 354
       et les correspondances annotées à la main. C'est le seul juge qui
       compte : un module qui passe les cas construits et rate celui-là ne
       sert à rien. */

import { describe, it, expect } from 'vitest';
import {
  METHODE_REATTRIBUTION, REGLAGES, configuration, similitude, appliquer,
  transformerDirection, hypotheses, apparier, analyser, noter, balayer,
} from '../tools/yolox-poc/lib/reattribution.mjs';
import { Suivi, reinitialiserIds } from '../tools/yolox-poc/lib/track.mjs';

const boite = (cx, cy, l = 100, h = 60) => [cx - l / 2, cy - h / 2, cx + l / 2, cy + h / 2];
const elt = (id, cx, cy, l = 100, h = 60, vx = 0, vy = 0) =>
  ({ id, box: boite(cx, cy, l, h), vitesse: { vx, vy } });

// ═══════════════════════════════════════════════
// LA MÉCANIQUE
// ═══════════════════════════════════════════════

describe('similitude à deux points', () => {
  it('reconstruit exactement une similitude directe connue', () => {
    // z ↦ 2·e^{iπ/2}·z + (10, 5) : rotation d'un quart de tour, échelle 2.
    const f = ([x, y]) => [2 * (-y) + 10, 2 * x + 5];
    const a1 = [3, 7], a2 = [-4, 2];
    const T = similitude(a1, a2, f(a1), f(a2), false);
    expect(T.echelle).toBeCloseTo(2, 9);
    expect(T.angle).toBeCloseTo(Math.PI / 2, 9);
    for (const p of [[0, 0], [11, -3], [5, 5]]) {
      const [x, y] = appliquer(T, p), [fx, fy] = f(p);
      expect(x).toBeCloseTo(fx, 6);
      expect(y).toBeCloseTo(fy, 6);
    }
  });

  it('reconstruit exactement une similitude AVEC réflexion', () => {
    // z ↦ 1,5·z̄ + (2, −1) : miroir sur l'axe des x, puis échelle et décalage.
    const f = ([x, y]) => [1.5 * x + 2, 1.5 * -y - 1];
    const a1 = [3, 7], a2 = [-4, 2];
    const T = similitude(a1, a2, f(a1), f(a2), true);
    expect(T.reflechie).toBe(true);
    expect(T.echelle).toBeCloseTo(1.5, 9);
    for (const p of [[0, 0], [11, -3]]) {
      const [x, y] = appliquer(T, p), [fx, fy] = f(p);
      expect(x).toBeCloseTo(fx, 6);
      expect(y).toBeCloseTo(fy, 6);
    }
  });

  it('refuse deux points confondus au lieu de rendre une transformation folle', () => {
    expect(similitude([5, 5], [5, 5], [0, 0], [9, 9], false)).toBeNull();
  });

  it('transforme une direction sans la translation', () => {
    const T = similitude([0, 0], [1, 0], [100, 100], [102, 100], false);
    const d = transformerDirection(T, [1, 0]);
    expect(d[0]).toBeCloseTo(1, 9);
    expect(d[1]).toBeCloseTo(0, 9);
  });
});

describe('appariement d\'un groupe', () => {
  it('retrouve une configuration transformée exactement, coût nul', () => {
    const A = [elt(1, 100, 500), elt(2, 300, 480), elt(3, 500, 520), elt(4, 700, 470)];
    // même nuage, tourné d'un demi-tour, agrandi, déplacé — et les tailles
    // suivent l'échelle, comme le ferait une vraie caméra.
    const B = A.map((e, i) => elt(10 + i, 2000 - 1.5 * ((e.box[0] + e.box[2]) / 2),
      1500 - 1.5 * ((e.box[1] + e.box[3]) / 2), 150, 90));
    const r = analyser(A, B);
    expect(r.meilleur.cout).toBeCloseTo(0, 6);
    expect(r.appariements).toEqual([
      { avant: 1, apres: 10, cout: 0 }, { avant: 2, apres: 11, cout: 0 },
      { avant: 3, apres: 12, cout: 0 }, { avant: 4, apres: 13, cout: 0 },
    ]);
  });

  it('refuse quand le groupe est trop petit pour porter une configuration', () => {
    const r = analyser([elt(1, 100, 500)], [elt(2, 200, 500), elt(3, 400, 500)]);
    expect(r.decision).toBe('refus');
    expect(r.raison).toBe('groupe_trop_petit');
    expect(r.appariements).toEqual([]);
  });

  it('le sens de marche tranche là où la géométrie seule ne peut pas', () => {
    // Deux voitures : n'importe quel appariement est réalisable exactement par
    // une similitude, les deux coûtent zéro. La géométrie est muette. Le sens
    // de marche, lui, dit lequel des deux est la tête de peloton.
    const A = [elt(1, 100, 500, 100, 60, -200, 0), elt(2, 300, 500, 100, 60, -200, 0)];
    // Les tailles suivent l'échelle du nuage (l'écart passe de 200 à 400 px,
    // donc ×2) : sans quoi le désaccord de taille pénaliserait les deux
    // hypothèses également, et brouillerait la lecture du test.
    const B = [elt(11, 1000, 700, 200, 120, 200, 0), elt(12, 1400, 700, 200, 120, 200, 0)];
    const r = analyser(A, B);
    expect(r.ecarteesParSens).toBeGreaterThan(0);
    // A1 est devant dans le plan A (il va vers la gauche), donc devant dans le
    // plan B (qui va vers la droite) : c'est B12.
    expect(r.appariements).toEqual([
      { avant: 1, apres: 12, cout: 0 }, { avant: 2, apres: 11, cout: 0 },
    ]);
    // toute hypothèse retenue garde le sens du même côté
    for (const h of hypotheses(configuration(A), configuration(B))) {
      if (h.sens != null && h.sens <= 0) continue;
      expect(transformerDirection(h.T, configuration(A).direction)[0]).toBeGreaterThan(0);
    }
  });

  it('refuse une hypothèse sans concurrente mais absurde', () => {
    // Deux pistes d'un côté, deux de l'autre : une similitude à deux points
    // ajuste exactement, et une seule affectation survit au sens de marche.
    // Sans plafond de coût, elle passerait sans le moindre examen — c'est
    // exactement ce qui arrivait sur la coupure Kerlabo de 14,3 s en 4 Hz,
    // avec une échelle de 10,2 et un coût de 2,85.
    const A = [elt(1, 500, 500, 100, 60, -200, 0), elt(2, 520, 505, 100, 60, -200, 0)];
    const B = [elt(11, 300, 900, 400, 240, 200, 0), elt(12, 1600, 300, 60, 36, 200, 0)];
    const r = analyser(A, B);
    expect(r.decision).toBe('refus');
    expect(r.raison).toBe('aucune_hypothese_plausible');
    expect(r.appariements).toEqual([]);
    // le refus reste relisible : on publie ce qu'on a écarté
    expect(r.meilleurRefuse.cout).toBeGreaterThan(REGLAGES.coutMax);
  });

  it('ne tranche pas entre deux hypothèses trop proches, et le dit', () => {
    // Un carré : quatre rotations d'un quart de tour l'envoient sur lui-même.
    // Aucune configuration ne peut lever cette ambiguïté — le bon
    // comportement est de refuser, pas de choisir.
    const A = [[0, 0], [400, 0], [400, 400], [0, 400]].map(([x, y], i) => elt(i + 1, 500 + x, 300 + y));
    const B = A.map((e, i) => elt(10 + i, (e.box[0] + e.box[2]) / 2, (e.box[1] + e.box[3]) / 2));
    const r = analyser(A, B);
    expect(r.decision).toBe('refus');
    expect(r.raison).toBe('hypotheses_trop_proches');
    expect(r.marge).toBe(0);
    expect(r.appariements).toEqual([]);
  });
});

describe('notation contre la vérité', () => {
  it('sépare juste, faux, non décidé et hors vérité', () => {
    const n = noter(
      [{ avant: 1, apres: 108 }, { avant: 2, apres: 104 }, { avant: 9, apres: 106 }],
      { 1: 108, 2: 107, 3: 106 }, [1, 2, 3],
    );
    expect(n).toMatchObject({ justes: 1, fausses: 1, horsVerite: 1, nonDecidees: 1, attendues: 3 });
    expect(n.idsNonDecidees).toEqual([3]);
  });
});

// ═══════════════════════════════════════════════
// LE CAS RÉEL — coupure Kerlabo, images 348 → 354
//
// Boîtes : détections YOLOX-s réelles, relevées sur les deux images propres
// de part et d'autre du fondu (5,800 s et 5,900 s).
// Vérité   : annotée à la main. A1→B8, A2→B7, A3→B6, A4→B4 ; B3 n'a pas
//            d'antécédent — c'est la cinquième voiture, absente du plan A.
// Vitesses : signes mesurés sur le suivi — plan A vers la gauche, plan B vers
//            la droite. Deux caméras fixes, de part et d'autre de la piste.
// ═══════════════════════════════════════════════

const KERLABO_A = [
  { id: 1, box: [549, 523, 716, 638], vitesse: { vx: -250, vy: 0 } },
  { id: 2, box: [730, 508, 922, 609], vitesse: { vx: -230, vy: 0 } },
  { id: 3, box: [848, 493, 991, 582], vitesse: { vx: -200, vy: 0 } },
  { id: 4, box: [1085, 550, 1231, 644], vitesse: { vx: -300, vy: 0 } },
];
const KERLABO_B = [
  { id: 103, box: [763, 415, 986, 595], vitesse: { vx: 160, vy: 0 } },
  { id: 104, box: [933, 399, 1097, 549], vitesse: { vx: 150, vy: 0 } },
  { id: 106, box: [1120, 416, 1341, 584], vitesse: { vx: 170, vy: 0 } },
  { id: 107, box: [1342, 408, 1572, 584], vitesse: { vx: 190, vy: 0 } },
  { id: 108, box: [1688, 407, 1917, 580], vitesse: { vx: 130, vy: 0 } },
];
const KERLABO_VERITE = { 1: 108, 2: 107, 3: 106, 4: 104 };

describe('coupure Kerlabo — le cas réel', () => {
  it('ne produit AUCUN appariement faux', () => {
    const r = analyser(KERLABO_A, KERLABO_B);
    const n = noter(r.appariements, KERLABO_VERITE, [1, 2, 3, 4]);
    expect(n.fausses).toBe(0);
  });

  it('recolle trois voitures sur quatre et laisse la quatrième non décidée', () => {
    const r = analyser(KERLABO_A, KERLABO_B);
    const n = noter(r.appariements, KERLABO_VERITE, [1, 2, 3, 4]);
    expect(n.justes).toBe(3);
    expect(n.nonDecidees).toBe(1);
    // La non décidée est celle qui dispute la cinquième voiture, B103, entrée
    // dans le plan B sans antécédent.
    expect(n.idsNonDecidees).toEqual([4]);
  });

  it('le contrôle de sens écarte la moitié des hypothèses', () => {
    const r = analyser(KERLABO_A, KERLABO_B);
    expect(r.ecarteesParSens).toBe(r.hypothesesEvaluees / 2);
  });

  it('sans le désaccord de taille, la bonne réponse n\'est que troisième', () => {
    const A = configuration(KERLABO_A), B = configuration(KERLABO_B);
    const cle = ['0>4', '1>3', '2>2', '3>1'].sort().join(',');
    const rang = (poidsTaille) => {
      const vues = new Map();
      for (const h of hypotheses(A, B, { poidsTaille })) {
        if ((h.sens == null || h.sens > 0) && !vues.has(h.cle)) vues.set(h.cle, h);
      }
      return [...vues.values()].sort((x, y) => x.cout - y.cout).findIndex(h => h.cle === cle) + 1;
    };
    // Les centres seuls ne suffisent pas : le nuage est presque aligné, et la
    // bonne réponse n'arrive que troisième.
    expect(rang(0)).toBe(3);
    // Le désaccord de taille la remonte, et la met première à partir de 0,75.
    expect(rang(0.5)).toBe(2);
    expect(rang(1)).toBe(1);
    expect(rang(2)).toBe(1);
    expect(rang(5)).toBe(1);
  });

  it('publie de quoi juger : marge, modèle, second, et le choix sans contrôle', () => {
    const r = analyser(KERLABO_A, KERLABO_B);
    expect(r.methode).toBe(METHODE_REATTRIBUTION);
    expect(r.meilleur.paires.map(p => `${p.a}>${p.b}`)).toEqual(['1>108', '2>107', '3>106', '4>104']);
    expect(r.second.paires.map(p => `${p.a}>${p.b}`)).toEqual(['1>108', '2>107', '3>106', '4>103']);
    expect(r.marge).toBeGreaterThan(0);
    expect(r.margeRelative).toBeGreaterThan(0.1);
    expect(r.groupes.avant.direction[0]).toBeLessThan(0);
    expect(r.groupes.apres.direction[0]).toBeGreaterThan(0);
  });

  it('le balayage montre où bascule la décision, sans la figer', () => {
    const A = configuration(KERLABO_A), B = configuration(KERLABO_B);
    const lignes = balayer(A, B);
    const justes = (l) => noter(l.appariements.map(a => ({ ...a })), KERLABO_VERITE, [1, 2, 3, 4]);
    // Sans terme de taille et sans exigence de marge, on apparie les quatre —
    // dont une fausse. C'est exactement ce qu'on refuse.
    const sansTaille = lignes.find(l => l.poidsTaille === 0 && l.margeMin === 0 && l.margeApparenceMin === 0.05);
    expect(justes(sansTaille).fausses).toBe(1);
    // Avec le terme de taille et aucune exigence de marge, les quatre sont
    // justes : le meilleur appariement EST la vérité.
    const avecTaille = lignes.find(l => l.poidsTaille === 1 && l.margeMin === 0 && l.margeApparenceMin === 0.05);
    expect(justes(avecTaille)).toMatchObject({ justes: 4, fausses: 0, nonDecidees: 0 });
    // Et dès qu'on exige une marge, même minime, plus AUCUN appariement faux
    // sur toute la plage de poids essayée. C'est la propriété qui compte :
    // le réglage change ce qu'on ose décider, jamais ce qu'on décide à tort.
    for (const l of lignes.filter(x => x.poidsTaille >= 0.5 && x.margeMin >= 0.02)) {
      expect(justes(l).fausses).toBe(0);
    }
    // Le réglage retenu est le côté prudent : sur ce cut il coûte une bonne
    // réponse (3 au lieu de 4) et n'évite aucune erreur. Un seul cut ne
    // suffit pas à décider de descendre — la table est là pour ça.
    const retenu = lignes.find(l => l.poidsTaille === REGLAGES.poidsTaille
      && l.margeMin === REGLAGES.margeMin && l.margeApparenceMin === REGLAGES.margeApparenceMin);
    expect(justes(retenu)).toMatchObject({ justes: 3, fausses: 0, nonDecidees: 1 });
  });
});

// ═══════════════════════════════════════════════
// INTÉGRATION AU SUIVI
// ═══════════════════════════════════════════════

describe('le suivi pose la filiation', () => {
  const rouler = (options = {}) => {
    reinitialiserIds();
    const s = new Suivi({ dt: 0.1, moteurReattribution: analyser, ...options });
    const det = (b, score = 0.9) => ({ box: b, score, label: 'car' });
    // plan A : quatre voitures vers la gauche
    for (let k = 0; k < 12; k++) {
      s.pas(k * 0.1, KERLABO_A.map(e => det([
        e.box[0] - 25 * k, e.box[1], e.box[2] - 25 * k, e.box[3],
      ])));
    }
    s.couper(1.2);
    // plan B : cinq voitures vers la droite
    for (let k = 12; k < 30; k++) {
      s.pas(k * 0.1, KERLABO_B.map(e => det([
        e.box[0] + 16 * (k - 12), e.box[1], e.box[2] + 16 * (k - 12), e.box[3],
      ])));
    }
    return s;
  };

  it('rattache les pistes du plan neuf aux identités logiques du plan précédent', () => {
    const s = rouler();
    const r = s.coupures[0].reattribution;
    expect(r).toBeTruthy();
    expect(r.posees.length).toBe(3);
    for (const p of r.posees) {
      const pb = s.pistes.find(x => x.id === p.apres);
      expect(pb.ancetre).toBe(p.avant);
      expect(pb.identiteLogique).toBe(s.pistes.find(x => x.id === p.avant).identiteLogique);
    }
  });

  it('attend que le plan neuf ait une vitesse avant de décider', () => {
    const s = rouler();
    // rien n'est décidé à l'instant même de la coupure
    expect(s.coupures[0].reattribution.t).toBeGreaterThanOrEqual(1.2 + s.opt.dureeConfirmation - 1e-9);
  });

  it('ne crée aucune bifurcation : une identité logique, une piste vivante', () => {
    const s = rouler();
    for (const inst of s.journal) {
      const vues = new Map();
      for (const t of inst.tracks) vues.set(t.identiteLogique, (vues.get(t.identiteLogique) || 0) + 1);
      expect([...vues.values()].every(n => n === 1)).toBe(true);
    }
  });

  it('sans moteur injecté, le suivi ne réattribue rien — le témoin ① est intact', () => {
    reinitialiserIds();
    const s = new Suivi({ dt: 0.1 });
    const det = (b) => ({ box: b, score: 0.9, label: 'car' });
    for (let k = 0; k < 12; k++) s.pas(k * 0.1, KERLABO_A.map(e => det(e.box)));
    s.couper(1.2);
    for (let k = 12; k < 24; k++) s.pas(k * 0.1, KERLABO_B.map(e => det(e.box)));
    expect(s.coupures[0].reattribution).toBeNull();
    expect(s.pistes.every(p => p.ancetre == null)).toBe(true);
  });
});
