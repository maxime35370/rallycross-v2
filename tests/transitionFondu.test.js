/* ═══════════════════════════════════════════════
   TRANSITIONFONDU.TEST.JS — Étendue d'un fondu enchaîné

   Le piège de cette mesure est le panoramique : entre la première et la
   dernière image d'un panoramique, α progresse aussi de 0 à 1. Plusieurs tests
   portent donc sur ce cas-là — si le module le prenait pour un fondu, il
   déclarerait « sales » des images parfaitement exploitables.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  estimerMelange, contraste, analyserTransition, verifierStabilite,
} from '../tools/yolox-poc/lib/transition.mjs';

const L = 64, H = 48;
const vide = () => new Uint8ClampedArray(L * H * 4);

/** Image RGBA : `f(x, y)` rend [r, g, b]. */
function fabriquer(f) {
  const px = vide();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < L; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * L + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}
/** Mélange linéaire exact — ce qu'est un fondu enchaîné. */
const melanger = (a, b, alpha) => {
  const px = vide();
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(a[i + c] * (1 - alpha) + b[i + c] * alpha);
    px[i + 3] = 255;
  }
  return px;
};

const PLAN_A = fabriquer((x, y) => (y < H / 2 ? [220, 40, 40] : [40, 120, 40]));
const PLAN_B = fabriquer((x, y) => (x < L / 2 ? [40, 60, 220] : [230, 220, 60]));
/** Panoramique : une barre verticale qui se déplace, fond constant. */
const pano = (pos) => fabriquer((x) => (x >= pos && x < pos + 10 ? [240, 240, 240] : [30, 90, 30]));

describe('projection sur le segment entre deux plans', () => {
  it('retrouve le coefficient d\'un mélange exact', () => {
    for (const alpha of [0, 0.25, 0.5, 0.8, 1]) {
      const m = estimerMelange(PLAN_A, PLAN_B, melanger(PLAN_A, PLAN_B, alpha));
      expect(m.alpha).toBeCloseTo(alpha, 2);
      expect(m.residu).toBeLessThan(0.02);
      expect(m.dispersion).toBeLessThan(0.02);
    }
  });

  it('reste exact quand une partie de l\'image bouge au lieu de se mélanger', () => {
    // Le cas réel : la caméra bouge PENDANT le fondu. Une estimation globale
    // aux moindres carrés s'y effondre ; la médiane par canal ignore la
    // minorité de pixels perturbés.
    const melange = melanger(PLAN_A, PLAN_B, 0.4);
    const bruite = new Uint8ClampedArray(melange);
    for (let x = 0; x < Math.floor(L * 0.3); x++) {
      for (let y = 0; y < H; y++) {
        const i = (y * L + x) * 4;
        bruite[i] = 255; bruite[i + 1] = 255; bruite[i + 2] = 255;
      }
    }
    expect(estimerMelange(PLAN_A, PLAN_B, bruite).alpha).toBeCloseTo(0.4, 2);
  });

  it('refuse de conclure quand les deux références sont identiques', () => {
    expect(estimerMelange(PLAN_A, PLAN_A, PLAN_A)).toBeNull();
  });

  it('rend null sur des tailles incompatibles', () => {
    expect(estimerMelange(PLAN_A, new Uint8ClampedArray(8), PLAN_B)).toBeNull();
  });

  it('dit quelle part de l\'image est exploitable', () => {
    expect(estimerMelange(PLAN_A, PLAN_B, PLAN_A).partExploitable).toBeGreaterThan(0.3);
  });

  it('mesure la chute de contraste au milieu d\'un fondu', () => {
    // Signal indépendant de α, et corroborant seulement : il ne vaut que si
    // les deux plans ont un contraste comparable. PLAN_A, dont les deux
    // moitiés ont presque la même LUMINANCE, en est le contre-exemple — d'où
    // deux plans construits exprès pour ce test.
    const sombreClair = fabriquer((x, y) => (y < H / 2 ? [15, 15, 15] : [240, 240, 240]));
    const clairSombre = fabriquer((x) => (x < L / 2 ? [240, 240, 240] : [15, 15, 15]));
    const milieu = contraste(melanger(sombreClair, clairSombre, 0.5));
    expect(milieu).toBeLessThan(Math.min(contraste(sombreClair), contraste(clairSombre)));
  });

  it('ne prétend pas que la chute de contraste soit toujours vraie', () => {
    // PLAN_A est plat en luminance : le mélange ne descend pas sous lui. C'est
    // pourquoi ce signal corrobore mais ne tranche pas.
    expect(contraste(melanger(PLAN_A, PLAN_B, 0.5))).toBeGreaterThan(contraste(PLAN_A));
  });
});

describe('étendue de la transition', () => {
  /** Fenêtre : `avant` images de A, `fondu` images de mélange, `apres` de B. */
  const fenetre = ({ avant = 6, fondu = 8, apres = 6, pas = 1 / 25 } = {}) => {
    const cadres = [];
    let k = 0;
    const pousser = (px) => cadres.push({ t: Number((k * pas).toFixed(4)), image: k++, px });
    for (let i = 0; i < avant; i++) pousser(PLAN_A);
    for (let i = 1; i <= fondu; i++) pousser(melanger(PLAN_A, PLAN_B, i / (fondu + 1)));
    for (let i = 0; i < apres; i++) pousser(PLAN_B);
    return cadres;
  };

  it('donne la dernière image propre avant et la première après', () => {
    const r = analyserTransition(fenetre({ avant: 6, fondu: 8, apres: 6 }));
    expect(r.derniereImagePropreAvant.image).toBe(5);
    expect(r.premiereImagePropreApres.image).toBe(14);
    expect(r.imagesDeTransition).toBe(8);
    expect(r.duree).toBeCloseTo(9 / 25, 4);
  });

  it('rend une transition d\'une image sur une coupure franche', () => {
    const r = analyserTransition(fenetre({ fondu: 0 }));
    expect(r.imagesDeTransition).toBe(0);
    expect(r.duree).toBeCloseTo(1 / 25, 4);
  });

  it('reconnaît le fondu par son faible résidu', () => {
    const r = analyserTransition(fenetre());
    expect(r.residuMedianEntre).toBeLessThan(0.1);
    expect(r.images.every(x => x.dispersion != null)).toBe(true);
    expect(r.monotone).toBe(1);
    expect(r.images.filter(x => x.classe === 'transition')).toHaveLength(8);
  });

  it('ne prend pas un panoramique pour un fondu ÉTENDU', () => {
    // Sur un panoramique, α ne s'attarde pas : il saute d'un bout à l'autre en
    // une image ou deux, parce qu'aucune image intermédiaire n'est un mélange
    // des deux extrêmes. La transition mesurée est donc courte, et presque
    // rien n'est écarté — c'est le garde-fou, et il ne coûte aucun réglage.
    const cadres = [];
    for (let k = 0; k < 20; k++) cadres.push({ t: k / 25, image: k, px: pano(k * 3) });
    const r = analyserTransition(cadres);
    expect(r.imagesDeTransition).toBeLessThanOrEqual(2);
  });

  it('signale une fenêtre trop courte au lieu de deviner', () => {
    // La fenêtre commence à l'intérieur du fondu : rien n'est concluant.
    const cadres = [];
    for (let i = 1; i <= 10; i++) cadres.push({ t: i / 25, image: i, px: melanger(PLAN_A, PLAN_B, i / 11) });
    const r = analyserTransition(cadres);
    expect(r.fenetreSuffisante).toBe(false);
  });

  it('garde les bords de la fenêtre comme références', () => {
    // Le choix des références n'a plus d'importance : c'est la FORME de la
    // montée de α qui donne les bornes, pas son niveau absolu.
    const cadres = [];
    let k = 0;
    const pousser = (px) => cadres.push({ t: k / 25, image: k++, px });
    for (let i = 0; i < 4; i++) pousser(PLAN_A);
    for (let i = 1; i <= 6; i++) pousser(melanger(PLAN_A, PLAN_B, i / 7));
    for (let i = 0; i < 4; i++) pousser(PLAN_B);
    const r = analyserTransition(cadres);
    // Les références sont les BORDS de la fenêtre : la médiane par canal rend
    // le même α quel que soit leur choix, un raffinement itératif ne ferait
    // qu'introduire une occasion de s'accrocher à de mauvaises images.
    expect(r.references.avant).toBe(0);
    expect(r.references.apres).toBe(13);
    expect(r.derniereImagePropreAvant.image).toBe(3);
    expect(r.premiereImagePropreApres.image).toBe(10);
  });

  it('rend null sur une fenêtre trop petite pour signifier quoi que ce soit', () => {
    expect(analyserTransition([])).toBeNull();
    expect(analyserTransition([{ t: 0, image: 0, px: PLAN_A }])).toBeNull();
  });
});

describe('corroboration par le contraste', () => {
  it('publie le contraste de chaque image et le creux de la transition', () => {
    const sombreClair = fabriquer((x, y) => (y < H / 2 ? [15, 15, 15] : [240, 240, 240]));
    const clairSombre = fabriquer((x) => (x < L / 2 ? [240, 240, 240] : [15, 15, 15]));
    const cadres = [];
    let k = 0;
    const pousser = (px) => cadres.push({ t: k / 25, image: k++, px });
    for (let i = 0; i < 4; i++) pousser(sombreClair);
    for (let i = 1; i <= 6; i++) pousser(melanger(sombreClair, clairSombre, i / 7));
    for (let i = 0; i < 4; i++) pousser(clairSombre);
    const r = analyserTransition(cadres);
    expect(r.images.every(x => typeof x.contraste === 'number')).toBe(true);
    expect(r.contrasteMin).toBeLessThan(Math.min(...r.contrastePlans));
  });
});

describe('crédibilité du mélange, jugée sur la fenêtre', () => {
  const bandes = (a, b) => {
    const px = vide();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < L; x++) {
        const [r, g, bl] = y < H / 2 ? a : b;
        const i = (y * L + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = bl; px[i + 3] = 255;
      }
    }
    return px;
  };

  it('publie dispersion et résidu au lieu d\'en faire un verdict', () => {
    const A = bandes([220, 40, 40], [40, 120, 40]);
    const B = bandes([40, 60, 220], [230, 220, 60]);
    const cadres = [];
    let k = 0;
    const pousser = (px) => cadres.push({ t: k / 25, image: k++, px });
    for (let i = 0; i < 4; i++) pousser(A);
    for (let i = 1; i <= 8; i++) pousser(melanger(A, B, i / 9));
    for (let i = 0; i < 4; i++) pousser(B);
    const r = analyserTransition(cadres);
    expect(r.dispersionMedianeEntre).not.toBeNull();
    expect(r.residuMedianEntre).not.toBeNull();
    expect(r.nature).toContain('étalée');
  });

  it('ne se prononce pas quand il n\'y a rien entre les deux images propres', () => {
    // Coupure franche : aucune image du milieu, donc aucun mélange à juger.
    const A = bandes([220, 40, 40], [40, 120, 40]);
    const B = bandes([40, 60, 220], [230, 220, 60]);
    const cadres = [];
    for (let k = 0; k < 8; k++) cadres.push({ t: k / 25, image: k, px: k < 4 ? A : B });
    const r = analyserTransition(cadres);
    expect(r.imagesDeTransition).toBe(0);
    expect(r.nature).toBe('coupure franche');
    expect(r.dispersionMedianeEntre).toBeNull();
  });
});

describe('verdict sur la nature de la rupture', () => {
  it('ne dépend que du nombre d\'images intermédiaires', () => {
    // Une version précédente jugeait « vrai mélange ou non » sur la dispersion
    // des α. Mesuré sur une vraie vidéo encodée, le même fondu rendait 0,37 à
    // un essai et 0,62 au suivant, contre 1,0 pour un panoramique : trop mince
    // pour un booléen. Le verdict ne dépend plus que du nombre d'images.
    const rouge = fabriquer(() => [220, 40, 40]), bleu = fabriquer(() => [40, 60, 220]);
    const cadres = [];
    for (let k = 0; k < 10; k++) cadres.push({ t: k / 25, image: k, px: k < 5 ? rouge : bleu });
    const r = analyserTransition(cadres);
    expect(r.nature).toBe('coupure franche');
    expect(Object.keys(r.reglages)).toEqual(['partMontee', 'amplitudeMin', 'fractionMin']);
  });
});

// ═══════════════════════════════════════════════
// INDÉPENDANCE À LA FENÊTRE D'ANALYSE
//
// Le défaut qui a motivé la réécriture : mesurée sur la vidéo réelle, la même
// coupure rendait 5 images à ±0,20 s et 56 à ±0,60 s. Une durée de transition
// est une propriété LOCALE de la coupure ; si elle dépend de la fenêtre, elle
// ne mesure rien.
//
// La cause est reproduite ici : un panoramique déplace TOUS les pixels, donc
// une image encore pure diffère déjà de sa référence, et α n'atteint jamais 0.
// Les synthétiques précédents n'avaient qu'un objet mobile — une minorité de
// pixels, que la médiane absorbait — et ne montraient donc rien.
// ═══════════════════════════════════════════════

describe('indépendance à la largeur de la fenêtre', () => {
  const LP = 120, HP = 68, FPS = 60;
  const texture = (dx, teintes) => {
    const px = new Uint8ClampedArray(LP * HP * 4);
    for (let y = 0; y < HP; y++) {
      for (let x = 0; x < LP; x++) {
        const u = x + dx, i = (y * LP + x) * 4;
        px[i] = teintes[0] + 90 * Math.sin(u / 9);
        px[i + 1] = teintes[1] + 80 * Math.sin(u / 13 + y / 17);
        px[i + 2] = teintes[2] + 50 * Math.sin(u / 7 + y / 23);
        px[i + 3] = 255;
      }
    }
    return px;
  };
  const melangePx = (a, b, alpha) => {
    const px = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(a[i + c] * (1 - alpha) + b[i + c] * alpha);
      px[i + 3] = 255;
    }
    return px;
  };
  const T0 = 1.0, DUREE = 0.10;              // fondu de 6 images à 60 img/s
  const cadreA = (t) => {
    const alpha = Math.max(0, Math.min(1, (t - T0) / DUREE));
    const a = texture(210 * t, [120, 90, 60]);     // les deux plans PANORAMIQUENT
    const b = texture(150 * t, [40, 150, 200]);
    return alpha <= 0 ? a : alpha >= 1 ? b : melangePx(a, b, alpha);
  };
  const serie = (demi) => {
    const cadres = [];
    for (let k = Math.round((T0 - demi) * FPS); k <= Math.round((T0 + DUREE + demi) * FPS); k++) {
      cadres.push({ t: Number((k / FPS).toFixed(4)), image: k, px: cadreA(k / FPS) });
    }
    return cadres;
  };

  it('rend la même étendue à ±0,30, ±0,40 et ±0,60 s', () => {
    const r = [0.3, 0.4, 0.6].map(d => analyserTransition(serie(d)));
    for (const x of r) {
      expect(x.fenetreSuffisante).toBe(true);
      // vérité : 6 images. La version à seuil rendait 38, 50 et 74.
      expect(x.imagesDeTransition).toBeLessThanOrEqual(8);
    }
    const avant = r.map(x => x.derniereImagePropreAvant.t);
    const apres = r.map(x => x.premiereImagePropreApres.t);
    // moins de trois images d'écart d'une fenêtre à l'autre
    expect(Math.max(...avant) - Math.min(...avant)).toBeLessThanOrEqual(3 / FPS + 1e-6);
    expect(Math.max(...apres) - Math.min(...apres)).toBeLessThanOrEqual(3 / FPS + 1e-6);
  });

  it('encadre le vrai fondu au lieu de le rogner ou de le noyer', () => {
    const r = analyserTransition(serie(0.4));
    expect(r.derniereImagePropreAvant.t).toBeLessThanOrEqual(T0 + 2 / FPS);
    expect(r.premiereImagePropreApres.t).toBeGreaterThanOrEqual(T0 + DUREE - 3 / FPS);
    expect(r.premiereImagePropreApres.t).toBeLessThanOrEqual(T0 + DUREE + 4 / FPS);
  });

  it('mesure la stabilité au lieu de la supposer', () => {
    const st = verifierStabilite({ 0.3: serie(0.3), 0.4: serie(0.4), 0.6: serie(0.6) });
    expect(st.retenus).toBe(3);
    expect(st.dispersionAvant).toBeLessThanOrEqual(3 / FPS + 1e-6);
    expect(st.avantRetenu).not.toBeNull();
    expect(st.apresRetenu).toBeGreaterThan(st.avantRetenu);
  });

  it('écarte des retenus une fenêtre qui n\'enjambe pas deux paliers', () => {
    // Fenêtre entièrement dans le plan A : aucune montée, rien à conclure.
    const cadres = [];
    for (let k = 0; k < 40; k++) cadres.push({ t: k / FPS, image: k, px: texture(210 * k / FPS, [120, 90, 60]) });
    const st = verifierStabilite({ 0.3: cadres });
    expect(st.retenus).toBe(0);
    expect(st.avantRetenu).toBeNull();
  });
});
