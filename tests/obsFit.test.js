import { describe, it, expect } from 'vitest';
import { fitCanvas, BASE_W, BASE_H } from '../overlay/_lib/obs-fit.js';

describe('fitCanvas — toile adaptée à la fenêtre', () => {
  it('1920×1080 : aucun changement (échelle 1, toile 1920×1080)', () => {
    expect(fitCanvas(1920, 1080)).toEqual({ k: 1, w: 1920, h: 1080 });
  });
  it('fenêtre plus large que 16:9 : échelle sur la hauteur, la toile s\'élargit', () => {
    const { k, w, h } = fitCanvas(1909, 904);
    expect(k).toBeCloseTo(904 / 1080, 6);
    expect(h).toBeCloseTo(BASE_H, 6);
    expect(w).toBeGreaterThan(BASE_W);
    expect(w * k).toBeCloseTo(1909, 6);          // remplit toute la largeur
  });
  it('fenêtre plus haute que 16:9 : échelle sur la largeur, la toile s\'allonge', () => {
    const { k, w, h } = fitCanvas(1000, 1000);
    expect(k).toBeCloseTo(1000 / 1920, 6);
    expect(w).toBeCloseTo(BASE_W, 6);
    expect(h).toBeGreaterThan(BASE_H);
    expect(h * k).toBeCloseTo(1000, 6);          // remplit toute la hauteur
  });
  it('la toile n\'est jamais plus petite que la base 1920×1080 (rien n\'est coupé)', () => {
    [[640, 360], [1280, 720], [3840, 1080], [800, 1600], [2560, 1440]].forEach(([iw, ih]) => {
      const { w, h } = fitCanvas(iw, ih);
      expect(w).toBeGreaterThanOrEqual(BASE_W - 1e-6); expect(h).toBeGreaterThanOrEqual(BASE_H - 1e-6);
    });
  });
  it('tailles invalides : repli sur la base', () => {
    expect(fitCanvas(0, 0)).toEqual({ k: 1, w: BASE_W, h: BASE_H });
  });
});
