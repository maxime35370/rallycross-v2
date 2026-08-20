/* ═══════════════════════════════════════════════
   MONTECARLOENGINE.TEST.JS — Tirage reproductible et lois.

   Le déterminisme n'est pas un confort de test : une probabilité affichée doit
   pouvoir être rejouée à l'identique pour être vérifiée, et le backtest
   comparerait du bruit s'il changeait d'une exécution à l'autre.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  createRng, deriveSeed, randomNormal, normalCdf, normalQuantile, createTally,
} from '../js/projection/monteCarloEngine.js';

describe('générateur à graine', () => {
  it('la même graine donne exactement la même suite', () => {
    const a = createRng(42), b = createRng(42);
    const sa = Array.from({ length: 50 }, () => a());
    const sb = Array.from({ length: 50 }, () => b());
    expect(sa).toEqual(sb);
  });

  it('deux graines différentes divergent', () => {
    const a = createRng(1), b = createRng(2);
    const sa = Array.from({ length: 20 }, () => a());
    const sb = Array.from({ length: 20 }, () => b());
    expect(sa).not.toEqual(sb);
  });

  it('reste dans [0, 1)', () => {
    const r = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('est raisonnablement uniforme', () => {
    const r = createRng(123);
    const bins = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) bins[Math.floor(r() * 10)]++;
    for (const b of bins) expect(Math.abs(b / n - 0.1)).toBeLessThan(0.01);
  });

  it('n\'utilise jamais Math.random — sinon rien ne serait reproductible', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'js', 'projection');
    for (const f of readdirSync(dir).filter(x => x.endsWith('.js'))) {
      // Les commentaires PARLENT de Math.random pour expliquer pourquoi il est
      // proscrit : on ne scanne donc que le code.
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random\s*\(/);
    }
  });
});

describe('graines dérivées', () => {
  it('un même libellé donne toujours la même graine fille', () => {
    expect(deriveSeed(10, 'P8')).toBe(deriveSeed(10, 'P8'));
  });

  it('des libellés différents donnent des graines différentes', () => {
    expect(deriveSeed(10, 'P8')).not.toBe(deriveSeed(10, 'P7'));
  });

  it('la graine mère change tout', () => {
    expect(deriveSeed(10, 'P8')).not.toBe(deriveSeed(11, 'P8'));
  });
});

describe('loi normale', () => {
  it('les tirages ont bien moyenne 0 et écart-type 1', () => {
    const r = createRng(99);
    let s = 0, s2 = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) { const z = randomNormal(r); s += z; s2 += z * z; }
    expect(Math.abs(s / n)).toBeLessThan(0.01);
    expect(Math.abs(Math.sqrt(s2 / n - (s / n) ** 2) - 1)).toBeLessThan(0.01);
  });

  it('la répartition connaît ses valeurs de référence', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('le quantile est bien l\'inverse de la répartition', () => {
    for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 4);
    }
  });

  it('le quantile est croissant et centré', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.9)).toBeGreaterThan(normalQuantile(0.6));
    expect(normalQuantile(0.1)).toBeLessThan(0);
  });

  it('gère les bornes sans produire NaN', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
  });
});

describe('accumulateur de distribution', () => {
  it('compte, moyenne et médiane', () => {
    const t = createTally();
    [1, 2, 2, 3, 10].forEach(v => t.add(v));
    expect(t.total).toBe(5);
    expect(t.mean).toBeCloseTo(3.6);
    expect(t.quantile(0.5)).toBe(2);
    expect(t.count(2)).toBe(2);
  });

  it('restitue une distribution triée avec ses parts', () => {
    const t = createTally();
    [3, 1, 1].forEach(v => t.add(v));
    expect(t.entries()).toEqual([
      { value: 1, count: 2, share: 2 / 3 },
      { value: 3, count: 1, share: 1 / 3 },
    ]);
  });

  it('sans donnée, ne renvoie pas de valeur inventée', () => {
    const t = createTally();
    expect(t.mean).toBe(null);
    expect(t.quantile(0.5)).toBe(null);
    expect(t.entries()).toEqual([]);
  });

  it('calcule un écart-type cohérent', () => {
    const t = createTally();
    [2, 4, 4, 4, 5, 5, 7, 9].forEach(v => t.add(v));
    expect(t.mean).toBe(5);
    expect(t.sd).toBeCloseTo(2, 6);
  });
});
