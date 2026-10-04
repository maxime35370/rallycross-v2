import { describe, it, expect } from 'vitest';
import {
  studioConfig, boardCycle, densityClass, normalizeRows, normalizeBg, BG_THEMES, ROTATE_MIN, ROTATE_MAX,
  autoAssignThemes, themeForCategory, CATEGORY_PALETTE,
} from '../overlay/_lib/obs-studio.js';

describe('studioConfig', () => {
  it('applique les valeurs par défaut', () => {
    expect(studioConfig(null)).toEqual({
      boards: ['manche'], rotate: false, rotateSec: 15, active: 'manche', bottom: 'none', showVideo: true,
    });
  });
  it('garde l\'ordre canonique, sans doublon ni valeur inconnue', () => {
    const c = studioConfig({ boards: ['champ', 'manche', 'xx', 'champ', 'interim'] });
    expect(c.boards).toEqual(['manche', 'interim', 'champ']);
  });
  it('borne la durée de rotation et corrige le classement actif', () => {
    expect(studioConfig({ rotateSec: 1 }).rotateSec).toBe(ROTATE_MIN);
    expect(studioConfig({ rotateSec: 9999 }).rotateSec).toBe(ROTATE_MAX);
    expect(studioConfig({ rotateSec: 'abc' }).rotateSec).toBe(15);
    expect(studioConfig({ boards: ['interim', 'champ'], active: 'meeting' }).active).toBe('interim');
  });
  it('ignore un bandeau inconnu', () => {
    expect(studioConfig({ bottom: 'zzz' }).bottom).toBe('none');
    expect(studioConfig({ bottom: 'predict' }).bottom).toBe('predict');
  });
});

describe('boardCycle', () => {
  const full = { manche: { rows: [1] }, interim: { rows: [] }, champ: { rows: [1, 2] } };
  it('rotation off : uniquement le classement actif', () => {
    expect(boardCycle(studioConfig({ boards: ['manche', 'champ'], active: 'champ' }), full)).toEqual(['champ']);
  });
  it('rotation on : tous les classements remplis, les vides sont sautés', () => {
    const cfg = studioConfig({ boards: ['manche', 'interim', 'champ'], rotate: true });
    expect(boardCycle(cfg, full)).toEqual(['manche', 'champ']);
  });
  it('rotation on, tout est vide : on garde la sélection (pas de cycle vide)', () => {
    const cfg = studioConfig({ boards: ['interim', 'meeting'], rotate: true });
    expect(boardCycle(cfg, {})).toEqual(['interim', 'meeting']);
  });
});

describe('densityClass — classement jamais tronqué', () => {
  it('réduit la taille avec l\'effectif', () => {
    expect([5, 12, 13, 20, 21, 28, 29, 40].map(densityClass)).toEqual(['sd1', 'sd1', 'sd2', 'sd2', 'sd3', 'sd3', 'sd4', 'sd4']);
  });
});

describe('normalizeRows', () => {
  it('ne tronque pas : 25 lignes en entrée = 25 en sortie', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ position: i + 1, carNumber: i, lastName: 'X', totalPoints: 1 }));
    expect(normalizeRows('interim', rows)).toHaveLength(25);
  });
  it('manche : valeur, points et statut (abandon sans position)', () => {
    const [a, b] = normalizeRows('manche', [
      { position: 1, carNumber: 7, lastName: 'Dupont', value: '1:02.345', points: 20 },
      { position: null, carNumber: 9, lastName: 'Martin', value: 'DNF', points: 0, status: 'DNF' },
    ]);
    expect(a).toMatchObject({ pos: 1, p1: true, main: '1:02.345', sub: '20 pt', out: false, num: 7, name: 'Dupont' });
    expect(b).toMatchObject({ pos: null, p1: false, out: true, main: 'DNF' });
  });
  it('championnat : total, points du meeting et évolution', () => {
    const [r] = normalizeRows('champ', [{ position: 2, carNumber: 1, lastName: 'A', grandTotal: 88, meetingPts: 12, delta: 1 }]);
    expect(r).toMatchObject({ pos: 2, main: '88', unit: 'pt', sub: '+12', delta: 1, p1: false });
  });
  it('meeting : lit `total`', () => {
    expect(normalizeRows('meeting', [{ position: 1, total: 41 }])[0].main).toBe('41');
  });
});

describe('thèmes de fond', () => {
  it('retombe sur carbone si inconnu ; chroma est disponible', () => {
    expect(normalizeBg('nope')).toBe('carbon');
    expect(normalizeBg(undefined)).toBe('carbon');
    expect(normalizeBg('chroma')).toBe('chroma');
    expect(BG_THEMES.find(t => t.id === 'chroma').swatch).toBe('#00ff00');
  });
});

describe('couleur par catégorie', () => {
  it('attribue une couleur différente à chaque catégorie tant qu\'il y en a assez', () => {
    const m = autoAssignThemes(['a', 'b', 'c', 'd']);
    expect(Object.keys(m)).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(Object.values(m)).size).toBe(4);
    Object.values(m).forEach(t => expect(CATEGORY_PALETTE).toContain(t));
  });
  it('plus de catégories que de couleurs : on réutilise la palette (2 catégories partagent une couleur)', () => {
    const ids = Array.from({ length: CATEGORY_PALETTE.length + 2 }, (_, i) => 'c' + i);
    const m = autoAssignThemes(ids);
    expect(Object.keys(m)).toHaveLength(ids.length);
    expect(new Set(Object.values(m)).size).toBe(CATEGORY_PALETTE.length);
    expect(m['c' + CATEGORY_PALETTE.length]).toBe(CATEGORY_PALETTE[0]);
  });
  it('conserve les choix déjà faits et donne aux nouvelles catégories les couleurs encore libres', () => {
    const m = autoAssignThemes(['a', 'b', 'c'], { a: 'ember', b: 'ember' });
    expect(m.a).toBe('ember'); expect(m.b).toBe('ember');          // deux catégories peuvent partager
    expect(m.c).not.toBe('ember');                                 // la nouvelle prend une couleur libre
  });
  it('ignore une couleur inconnue ou le chroma stocké pour une catégorie', () => {
    const m = autoAssignThemes(['a', 'b'], { a: 'zzz', b: 'chroma' });
    expect(['zzz', 'chroma']).not.toContain(m.a); expect(m.b).not.toBe('chroma');
  });
  it('stable : relancer ne change rien', () => {
    const m = autoAssignThemes(['a', 'b', 'c']);
    expect(autoAssignThemes(['a', 'b', 'c'], m)).toEqual(m);
  });
  it('themeForCategory : couleur de la catégorie, sinon fond par défaut', () => {
    expect(themeForCategory('sc', { sc: 'nitro' }, 'carbon')).toBe('nitro');
    expect(themeForCategory('x', { sc: 'nitro' }, 'paddock')).toBe('paddock');
    expect(themeForCategory('', { sc: 'nitro' }, undefined)).toBe('carbon');
    expect(themeForCategory('sc', { sc: 'inconnu' }, 'ember')).toBe('ember');
  });
  it('le fond vert chroma par défaut s\'applique à toutes les catégories', () => {
    expect(themeForCategory('sc', { sc: 'nitro' }, 'chroma')).toBe('chroma');
  });
});
