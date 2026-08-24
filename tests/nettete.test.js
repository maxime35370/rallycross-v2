/* NETTETÉ ET MOUVEMENT — deux mesures qui doivent rester indépendantes.

   Les cas sont construits pour que la bonne réponse soit connue d'avance :
   un damier est net par construction, sa version moyennée est floue, et deux
   images identiques n'ont aucun mouvement. */

import { describe, it, expect } from 'vitest';
import { nettete, mouvement, distancesAuBord, METHODE_NETTETE } from '../tools/yolox-poc/lib/nettete.mjs';

const L = 40, H = 40;

/** Image RGBA remplie par une fonction (x, y) → niveau de gris. */
const image = (f) => {
  const px = new Uint8ClampedArray(L * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < L; x++) {
      const v = f(x, y), i = (y * L + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
  }
  return px;
};

const damier = image((x, y) => ((x + y) % 2 ? 220 : 30));
// Le même damier « fondu » : la moyenne locale efface les contours.
const flou = image(() => 125);
const degrade = image((x) => 30 + x * 4);

describe('netteté', () => {
  it('sépare franchement une zone nette d\'une zone floue', () => {
    const n = nettete(damier, L, H, [0, 0, L, H]);
    const f = nettete(flou, L, H, [0, 0, L, H]);
    expect(n.variance).toBeGreaterThan(1000);
    expect(f.variance).toBeLessThan(1);
    expect(n.variance).toBeGreaterThan(f.variance * 1000);
  });

  it('reste comparable entre une zone sombre et une zone claire', () => {
    // Deux damiers de même structure mais de contrastes très différents :
    // la variance BRUTE les sépare, la RELATIVE les rapproche. C'est tout
    // l'intérêt de publier les deux.
    const fort = image((x, y) => ((x + y) % 2 ? 250 : 0));
    const faible = image((x, y) => ((x + y) % 2 ? 130 : 120));
    const a = nettete(fort, L, H, [0, 0, L, H]);
    const b = nettete(faible, L, H, [0, 0, L, H]);
    expect(a.variance / b.variance).toBeGreaterThan(100);
    expect(a.relative).toBeCloseTo(b.relative, 1);
  });

  it('ne voit pas de contour dans un dégradé régulier', () => {
    // Un dégradé a du contraste mais aucune structure : le laplacien y est
    // nul. C'est ce qui distingue « contrasté » de « net ».
    const d = nettete(degrade, L, H, [0, 0, L, H]);
    expect(d.variance).toBeLessThan(1);
  });

  it('refuse une zone trop petite plutôt que de rendre un chiffre creux', () => {
    expect(nettete(damier, L, H, [0, 0, 2, 2])).toBeNull();
  });
});

describe('mouvement', () => {
  it('est nul entre deux images identiques', () => {
    expect(mouvement(damier, damier, L, H, [0, 0, L, H]).moyenne).toBe(0);
  });

  it('mesure l\'écart moyen en niveaux de gris', () => {
    const a = image(() => 100), b = image(() => 130);
    expect(mouvement(a, b, L, H, [0, 0, L, H]).moyenne).toBeCloseTo(30, 5);
  });

  it('est indépendant de la netteté : une zone floue peut bouger beaucoup', () => {
    const flouA = image(() => 60), flouB = image(() => 200);
    expect(nettete(flouA, L, H, [0, 0, L, H]).variance).toBeLessThan(1);
    expect(mouvement(flouA, flouB, L, H, [0, 0, L, H]).moyenne).toBeGreaterThan(100);
  });
});

describe('distance au bord', () => {
  it('rend les quatre côtés et le minimum', () => {
    const d = distancesAuBord([10, 20, 1900, 1000], 1920, 1080);
    expect(d).toMatchObject({ gauche: 10, haut: 20, droite: 20, bas: 80, min: 10 });
  });

  it('vaut zéro quand la boîte touche le cadre', () => {
    expect(distancesAuBord([0, 100, 800, 900], 1920, 1080).min).toBe(0);
  });
});

describe('méthode', () => {
  it('est identifiée dans le module', () => {
    expect(METHODE_NETTETE).toBe('laplacien+diff/1');
  });
});
