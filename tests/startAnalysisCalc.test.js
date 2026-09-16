import { describe, it, expect } from 'vitest';
import {
  startDocId, gridLayoutKey, seriesFingerprint,
  maxPerSeries, resolveGridGeometry, gridCellsInOrder, placeOnGrid, checkGridLayout,
  laneZone, normalizePoleSide, startLabel, enumerateStarts, finishPosInStart, buildStartGrid,
  validateAnalysis, availableTurn1Positions, pointTurn1InOrder, nextFreeTurn1Pos,
  applyV1OrderProposal, acceptV1Proposals, isV1OrderProposal,
  buildStartGridExport, isStartGridExport,
  isNonStarter, countStarters,
  orderGridByInterim, orderFinalGridFromSemis, orderByRaceResult,
} from '../js/startAnalysisCalc.js';
import { computeSeriesSizes } from '../js/calc.js';

// ─────────────────────────────────────────────────────────
// GRILLES DE RÉFÉRENCE
// ─────────────────────────────────────────────────────────

// Grille FFSA par défaut (settings.js) : 8 positions sur 5 couloirs × 3 lignes,
// en quinconce → P4 doit tomber en LIGNE 2, PAS dans le couloir 4.
const GRID_8 = {
  lanes: 5, rows: 3,
  positions: { '0-0': 1, '0-2': 2, '0-4': 3, '1-1': 4, '1-3': 5, '2-0': 6, '2-2': 7, '2-4': 8 },
};

// Grille QF par défaut : 6 positions
const GRID_6 = {
  lanes: 5, rows: 3,
  positions: { '0-0': 1, '0-2': 2, '1-1': 3, '1-3': 4, '2-0': 5, '2-2': 6 },
};

const CHAMP_FFSA = {
  seriesDistributionMode: 'ffsa',
  categories: [{ id: 'Supercar', name: 'Supercar', maxPerSeries: 5 }],
  sessionConfig: { QF: { gridLayout: GRID_6 }, DF: { gridLayout: GRID_8 }, FIN: { gridLayout: GRID_8 } },
};

// Deuxième championnat, géométrie DF DIFFÉRENTE (2 couloirs × 4 lignes)
const GRID_ALT = {
  lanes: 2, rows: 4,
  positions: { '0-0': 1, '0-1': 2, '1-0': 3, '1-1': 4, '2-0': 5, '2-1': 6, '3-0': 7, '3-1': 8 },
};
const CHAMP_ALT = {
  seriesDistributionMode: 'fia_even',
  categories: [{ id: 'Supercar', name: 'Supercar', maxPerSeries: 4 }],
  sessionConfig: { DF: { gridLayout: GRID_ALT } },
};

// ─────────────────────────────────────────────────────────
// startDocId
// ─────────────────────────────────────────────────────────

describe('startDocId', () => {
  it('construit un id déterministe par départ physique', () => {
    expect(startDocId('aBc123', 3)).toBe('aBc123_s3');
    expect(startDocId('xYz789', 1)).toBe('xYz789_s1');
  });

  it('est stable (idempotent) pour les mêmes entrées', () => {
    expect(startDocId('s1', 2)).toBe(startDocId('s1', 2));
  });

  it('rejette un startIndex invalide', () => {
    expect(() => startDocId('s1', 0)).toThrow();
    expect(() => startDocId('s1', -1)).toThrow();
    expect(() => startDocId('s1', 1.5)).toThrow();
    expect(() => startDocId('', 1)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────
// gridLayoutKey
// ─────────────────────────────────────────────────────────

describe('gridLayoutKey', () => {
  it('donne la même empreinte quel que soit l\'ordre des clés', () => {
    const a = { lanes: 5, rows: 3, positions: { '0-0': 1, '0-2': 2 } };
    const b = { lanes: 5, rows: 3, positions: { '0-2': 2, '0-0': 1 } };
    expect(gridLayoutKey(a)).toBe(gridLayoutKey(b));
  });

  it('distingue deux géométries différentes', () => {
    expect(gridLayoutKey(GRID_8)).not.toBe(gridLayoutKey(GRID_ALT));
    expect(gridLayoutKey(GRID_8)).not.toBe(gridLayoutKey(GRID_6));
  });

  it('renvoie "none" sans géométrie', () => {
    expect(gridLayoutKey(null)).toBe('none');
    expect(gridLayoutKey({ lanes: 5, rows: 3 })).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────
// seriesFingerprint
// ─────────────────────────────────────────────────────────

describe('seriesFingerprint', () => {
  it('ne dépend pas de l\'ordre des pilotes', () => {
    expect(seriesFingerprint(['a', 'b', 'c'])).toBe(seriesFingerprint(['c', 'a', 'b']));
  });

  it('change si la composition change', () => {
    expect(seriesFingerprint(['a', 'b', 'c'])).not.toBe(seriesFingerprint(['a', 'b', 'd']));
    expect(seriesFingerprint(['a', 'b', 'c'])).not.toBe(seriesFingerprint(['a', 'b']));
  });

  it('encode le nombre de pilotes', () => {
    expect(seriesFingerprint(['a', 'b', 'c']).startsWith('3:')).toBe(true);
  });

  it('gère la liste vide', () => {
    expect(seriesFingerprint([])).toBe('empty');
    expect(seriesFingerprint(null)).toBe('empty');
  });
});

// ─────────────────────────────────────────────────────────
// computeSeriesSizes (déplacé dans calc.js — non-régression)
// ─────────────────────────────────────────────────────────

describe('computeSeriesSizes', () => {
  it('reproduit l\'exemple documenté FFSA : 26 pilotes, max 5', () => {
    expect(computeSeriesSizes(26, 5, 'ffsa')).toEqual([3, 3, 5, 5, 5, 5]);
  });

  it('reproduit l\'exemple documenté FIA : 26 pilotes, max 5', () => {
    expect(computeSeriesSizes(26, 5, 'fia_even')).toEqual([4, 4, 4, 4, 5, 5]);
  });

  it('bascule sur une distribution uniforme quand n est petit (fia_even)', () => {
    expect(computeSeriesSizes(11, 5, 'fia_even')).toEqual([3, 4, 4]);
  });

  it('conserve la somme = nombre de pilotes', () => {
    for (const n of [1, 5, 6, 12, 15, 22, 30, 35]) {
      for (const mode of ['ffsa', 'fia_even']) {
        const sizes = computeSeriesSizes(n, 5, mode);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      }
    }
  });

  it('renvoie une seule série si n <= max', () => {
    expect(computeSeriesSizes(4, 5, 'ffsa')).toEqual([4]);
    expect(computeSeriesSizes(5, 5, 'ffsa')).toEqual([5]);
  });

  it('renvoie un tableau vide pour n <= 0', () => {
    expect(computeSeriesSizes(0, 5, 'ffsa')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// resolveGridGeometry — le RÈGLEMENT est la source de vérité
// ─────────────────────────────────────────────────────────

describe('resolveGridGeometry', () => {
  it('MQ : gridLanes = maxPerSeries de la catégorie, 1 seule ligne', () => {
    const g = resolveGridGeometry(CHAMP_FFSA, 'MQ', 'Supercar');
    expect(g.gridLanes).toBe(5);
    expect(g.gridRowsTotal).toBe(1);
    expect(g.source).toBe('mq_max_per_series');
  });

  it('MQ : maxPerSeries propre à la catégorie', () => {
    expect(resolveGridGeometry(CHAMP_ALT, 'MQ', 'Supercar').gridLanes).toBe(4);
  });

  it('MQ : 5 couloirs par défaut si la catégorie ne précise rien', () => {
    expect(resolveGridGeometry({}, 'MQ', 'Inconnue').gridLanes).toBe(5);
  });

  it('DF : lit gridLayout du règlement', () => {
    const g = resolveGridGeometry(CHAMP_FFSA, 'DF', 'Supercar');
    expect(g.gridLanes).toBe(5);
    expect(g.gridRowsTotal).toBe(3);
    expect(g.source).toBe('grid_layout');
  });

  it('DEUX CHAMPIONNATS aux gridLayout différents → deux géométries différentes', () => {
    const a = resolveGridGeometry(CHAMP_FFSA, 'DF', 'Supercar');
    const b = resolveGridGeometry(CHAMP_ALT, 'DF', 'Supercar');
    expect(a.gridLanes).toBe(5);
    expect(b.gridLanes).toBe(2);
    expect(a.gridRowsTotal).toBe(3);
    expect(b.gridRowsTotal).toBe(4);
    expect(a.gridLayoutKey).not.toBe(b.gridLayoutKey);
  });

  it('n\'invente rien si le règlement ne définit pas de gridLayout', () => {
    const g = resolveGridGeometry({ sessionConfig: {} }, 'DF', 'Supercar');
    expect(g.source).toBe('missing');
    expect(g.gridLanes).toBe(0);
    expect(g.gridLayout).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// placeOnGrid — position sportive → position physique
// ─────────────────────────────────────────────────────────

describe('placeOnGrid (quinconce FFSA 8 positions)', () => {
  it('P1 est en ligne 1, couloir 1', () => {
    expect(placeOnGrid(1, GRID_8)).toMatchObject({ gridRow: 1, lane: 1 });
  });

  it('⚠️ P4 est en LIGNE 2 et NON dans le couloir 4', () => {
    const p4 = placeOnGrid(4, GRID_8);
    expect(p4.gridRow).toBe(2);
    expect(p4.lane).toBe(2);
    expect(p4.lane).not.toBe(4);
  });

  it('P5 est en ligne 2, couloir 4', () => {
    expect(placeOnGrid(5, GRID_8)).toMatchObject({ gridRow: 2, lane: 4 });
  });

  it('P6/P7/P8 sont en ligne 3', () => {
    expect(placeOnGrid(6, GRID_8)).toMatchObject({ gridRow: 3, lane: 1 });
    expect(placeOnGrid(7, GRID_8)).toMatchObject({ gridRow: 3, lane: 3 });
    expect(placeOnGrid(8, GRID_8)).toMatchObject({ gridRow: 3, lane: 5 });
  });

  it('renvoie null au-delà de la capacité de la grille', () => {
    expect(placeOnGrid(9, GRID_8)).toBeNull();
    expect(placeOnGrid(0, GRID_8)).toBeNull();
  });

  it('géométrie alternative 2 couloirs × 4 lignes : P4 est en ligne 2 couloir 2', () => {
    expect(placeOnGrid(4, GRID_ALT)).toMatchObject({ gridRow: 2, lane: 2 });
  });

  it('numéros NON CONTIGUS : le n-ième qualifié prend la n-ième cellule', () => {
    // Positions {1,2,3,5,8} : le 4e qualifié occupe la cellule n°5
    const sparse = { lanes: 3, rows: 3, positions: { '0-0': 1, '0-1': 2, '0-2': 3, '1-1': 5, '2-2': 8 } };
    expect(placeOnGrid(4, sparse)).toMatchObject({ gridRow: 2, lane: 2, layoutPosNum: 5 });
    expect(placeOnGrid(5, sparse)).toMatchObject({ gridRow: 3, lane: 3, layoutPosNum: 8 });
  });

  it('reproduit bien l\'ordre par numéro et non l\'ordre d\'insertion des clés', () => {
    const shuffled = { lanes: 5, rows: 3, positions: { '2-4': 8, '0-0': 1, '1-3': 5, '0-2': 2 } };
    expect(placeOnGrid(1, shuffled)).toMatchObject({ gridRow: 1, lane: 1 });
    expect(placeOnGrid(2, shuffled)).toMatchObject({ gridRow: 1, lane: 3 });
    expect(placeOnGrid(3, shuffled)).toMatchObject({ gridRow: 2, lane: 4 });
    expect(placeOnGrid(4, shuffled)).toMatchObject({ gridRow: 3, lane: 5 });
  });
});

describe('gridCellsInOrder', () => {
  it('trie par numéro de position croissant', () => {
    expect(gridCellsInOrder(GRID_8).map(c => c.posNum)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('renvoie un tableau vide sans géométrie', () => {
    expect(gridCellsInOrder(null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// checkGridLayout — cas limites de l'éditeur libre
// ─────────────────────────────────────────────────────────

describe('checkGridLayout', () => {
  it('ne signale rien sur une grille saine', () => {
    expect(checkGridLayout(GRID_8, 8)).toEqual([]);
  });

  it('détecte les doublons de numéros', () => {
    const dup = { lanes: 3, rows: 2, positions: { '0-0': 1, '0-1': 1, '0-2': 2 } };
    expect(checkGridLayout(dup).join(' ')).toMatch(/doublon/i);
  });

  it('signale les numéros non contigus', () => {
    const sparse = { lanes: 3, rows: 3, positions: { '0-0': 1, '0-1': 2, '1-1': 5 } };
    expect(checkGridLayout(sparse).join(' ')).toMatch(/non contigus/i);
  });

  it('signale les partants surnuméraires', () => {
    expect(checkGridLayout(GRID_8, 10).join(' ')).toMatch(/surnuméraires/i);
  });

  it('signale l\'absence de géométrie', () => {
    expect(checkGridLayout(null).join(' ')).toMatch(/aucune géométrie/i);
  });

  it('signale une cellule hors dimensions déclarées', () => {
    const oob = { lanes: 2, rows: 1, positions: { '0-0': 1, '0-3': 2 } };
    expect(checkGridLayout(oob).join(' ')).toMatch(/dimensions/i);
  });
});

// ─────────────────────────────────────────────────────────
// laneZone
// ─────────────────────────────────────────────────────────

describe('laneZone (aide d\'affichage — couloir 1 toujours à l\'intérieur)', () => {
  // Convention vérifiée dans standings.js : « 1er virage à droite → couloir 1 à
  // droite ». Le couloir 1 est donc toujours du côté intérieur, quel que soit le
  // circuit : aucune orientation n'est nécessaire.
  it('5 couloirs → 2 intérieur / 1 milieu / 2 extérieur', () => {
    expect([1, 2, 3, 4, 5].map(l => laneZone(l, 5)))
      .toEqual(['inside', 'inside', 'middle', 'outside', 'outside']);
  });

  it('3 couloirs → un par zone', () => {
    expect([1, 2, 3].map(l => laneZone(l, 3))).toEqual(['inside', 'middle', 'outside']);
  });

  it('le couloir 3 reste au MILIEU même dans une série de 3 voitures', () => {
    // Dénominateur = gridLanes du règlement (5), pas le nb de partants (§4.10 A)
    expect(laneZone(3, 5)).toBe('middle');
  });

  it('une série incomplète ne produit aucune observation extérieure', () => {
    const zones = [1, 2, 3].map(l => laneZone(l, 5));
    expect(zones).toEqual(['inside', 'inside', 'middle']);
    expect(zones).not.toContain('outside');
  });

  it('un seul couloir → milieu (aucun choix latéral)', () => {
    expect(laneZone(1, 1)).toBe('middle');
  });

  it('renvoie null pour des entrées hors bornes', () => {
    expect(laneZone(0, 5)).toBeNull();
    expect(laneZone(6, 5)).toBeNull();
    expect(laneZone(1, 0)).toBeNull();
    expect(laneZone(null, 5)).toBeNull();
  });
});

describe('normalizePoleSide', () => {
  it('traduit le champ existant meeting.poleSide', () => {
    expect(normalizePoleSide('gauche')).toBe('left');
    expect(normalizePoleSide('droite')).toBe('right');
  });
  it('retombe sur "right" comme le défaut de meetings.js', () => {
    expect(normalizePoleSide(undefined)).toBe('right');
    expect(normalizePoleSide('')).toBe('right');
  });
});

// ─────────────────────────────────────────────────────────
// startLabel
// ─────────────────────────────────────────────────────────

describe('startLabel', () => {
  it('nomme une série de MQ', () => {
    expect(startLabel({ type: 'MQ', num: 1 }, 3, true)).toBe('MQ1 · Série 3');
  });
  it('nomme une grille unique', () => {
    expect(startLabel({ type: 'DF', num: 2 }, 1, false)).toBe('DF2');
    expect(startLabel({ type: 'FIN', num: null }, 1, false)).toBe('FIN');
  });
});

// ─────────────────────────────────────────────────────────
// enumerateStarts — LE point central : 1 série = 1 départ
// ─────────────────────────────────────────────────────────

const mqResult = (driverId, serie, couloir, ms = null, status = null) =>
  ({ driverId, serie, couloir, ms, status, carNumber: Number(driverId.replace('d', '')) });

describe('enumerateStarts — MQ', () => {
  const session = { id: 'sess-mq1', type: 'MQ', num: 1 };

  it('une MQ de 2 séries produit DEUX départs distincts', () => {
    const results = [
      mqResult('d1', 1, 1), mqResult('d2', 1, 2), mqResult('d3', 1, 3),
      mqResult('d4', 2, 1), mqResult('d5', 2, 2), mqResult('d6', 2, 3),
    ];
    const participants = results.map(r => ({ driverId: r.driverId, carNumber: r.carNumber }));
    const { starts } = enumerateStarts({ session, results, participants, championship: CHAMP_FFSA, category: 'Supercar' });
    expect(starts).toHaveLength(2);
    expect(starts.map(s => s.startIndex)).toEqual([1, 2]);
    expect(starts[0].driverIds).toEqual(['d1', 'd2', 'd3']);
    expect(starts[1].driverIds).toEqual(['d4', 'd5', 'd6']);
    expect(starts[0].startLabel).toBe('MQ1 · Série 1');
  });

  it('6 séries pour 30 pilotes → 6 départs (et non 1)', () => {
    const results = [];
    for (let s = 1; s <= 6; s++) {
      for (let c = 1; c <= 5; c++) results.push(mqResult(`d${(s - 1) * 5 + c}`, s, c));
    }
    const participants = results.map(r => ({ driverId: r.driverId, carNumber: r.carNumber }));
    const { starts } = enumerateStarts({ session, results, participants, championship: CHAMP_FFSA, category: 'Supercar' });
    expect(starts).toHaveLength(6);
    expect(starts.every(s => s.starters === 5)).toBe(true);
    expect(starts.every(s => s.gridSource === 'mq_couloir')).toBe(true);
  });

  it('les ids de document sont distincts par série', () => {
    const results = [mqResult('d1', 1, 1), mqResult('d2', 2, 1)];
    const participants = results.map(r => ({ driverId: r.driverId }));
    const { starts } = enumerateStarts({ session, results, participants, championship: CHAMP_FFSA, category: 'Supercar' });
    const ids = starts.map(s => startDocId(s.sessionId, s.startIndex));
    expect(ids).toEqual(['sess-mq1_s1', 'sess-mq1_s2']);
    expect(new Set(ids).size).toBe(2);
  });

  it('CAS DÉGRADÉ : aucune série renseignée → aucun départ et un avertissement clair', () => {
    const results = [
      { driverId: 'd1', serie: null, couloir: null },
      { driverId: 'd2', serie: null, couloir: null },
    ];
    const { starts, warnings } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts).toEqual([]);
    expect(warnings.join(' ')).toMatch(/aucune série renseignée/i);
  });

  it('série partiellement renseignée : les pilotes sans série sont signalés', () => {
    const results = [mqResult('d1', 1, 1), mqResult('d2', 1, 2), { driverId: 'd3', serie: null }];
    const { starts, warnings } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts).toHaveLength(1);
    expect(starts[0].driverIds).toEqual(['d1', 'd2']);
    expect(warnings.join(' ')).toMatch(/sans série renseignée/i);
  });

  it('signale un couloir en doublon dans une série', () => {
    const results = [mqResult('d1', 1, 1), mqResult('d2', 1, 1)];
    const { starts } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].warnings.join(' ')).toMatch(/doublon/i);
  });

  it('signale un couloir manquant', () => {
    const results = [mqResult('d1', 1, 1), mqResult('d2', 1, null)];
    const { starts } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].warnings.join(' ')).toMatch(/couloir manquant/i);
  });

  it('signale un effectif de série incohérent avec le règlement', () => {
    // 26 participants → tailles attendues [3,3,5,5,5,5] ; on ne fournit que 2 pilotes en série 3
    const results = [mqResult('d1', 3, 1), mqResult('d2', 3, 2)];
    const participants = Array.from({ length: 26 }, (_, i) => ({ driverId: `p${i}` }));
    const { starts } = enumerateStarts({
      session, results, participants, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].warnings.join(' ')).toMatch(/attendu/i);
  });
});

describe('enumerateStarts — QF / DF / FIN', () => {
  it('une DF produit UN seul départ', () => {
    const participants = Array.from({ length: 8 }, (_, i) => ({ driverId: `d${i + 1}`, carNumber: i + 1 }));
    const { starts } = enumerateStarts({
      session: { id: 'sess-df1', type: 'DF', num: 1 },
      results: [], participants, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts).toHaveLength(1);
    expect(starts[0].startIndex).toBe(1);
    expect(starts[0].startLabel).toBe('DF1');
    expect(starts[0].gridSource).toBe('grid_layout');
    expect(starts[0].starters).toBe(8);
  });

  it('utilise le gridLayout DU CHAMPIONNAT DU MEETING', () => {
    const participants = Array.from({ length: 8 }, (_, i) => ({ driverId: `d${i + 1}` }));
    const a = enumerateStarts({ session: { id: 's', type: 'DF', num: 1 }, results: [], participants, championship: CHAMP_FFSA, category: 'Supercar' });
    const b = enumerateStarts({ session: { id: 's', type: 'DF', num: 1 }, results: [], participants, championship: CHAMP_ALT, category: 'Supercar' });
    expect(a.starts[0].gridLanes).toBe(5);
    expect(b.starts[0].gridLanes).toBe(2);
  });

  it('gridLayout absent → gridSource "manual", rien d\'inventé', () => {
    const participants = [{ driverId: 'd1' }];
    const { starts } = enumerateStarts({
      session: { id: 's', type: 'FIN' }, results: [], participants,
      championship: { sessionConfig: {} }, category: 'Supercar',
    });
    expect(starts[0].gridSource).toBe('manual');
    expect(starts[0].warnings.join(' ')).toMatch(/aucune géométrie/i);
  });

  it('aucun participant → aucun départ', () => {
    const { starts, warnings } = enumerateStarts({
      session: { id: 's', type: 'FIN' }, results: [], participants: [],
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts).toEqual([]);
    expect(warnings.join(' ')).toMatch(/aucun participant/i);
  });

  it('EC ne comporte aucun départ en grille', () => {
    const { starts, warnings } = enumerateStarts({
      session: { id: 's', type: 'EC' }, results: [], participants: [{ driverId: 'd1' }],
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts).toEqual([]);
    expect(warnings.join(' ')).toMatch(/essais chronométrés/i);
  });
});

// ─────────────────────────────────────────────────────────
// finishPosInStart — rang DANS le départ, pas dans la manche
// ─────────────────────────────────────────────────────────

describe('finishPosInStart', () => {
  it('classe par temps croissant au sein du départ', () => {
    const m = finishPosInStart([
      { driverId: 'a', ms: 125000 },
      { driverId: 'b', ms: 123000 },
      { driverId: 'c', ms: 124000 },
    ]);
    expect(m.get('b')).toBe(1);
    expect(m.get('c')).toBe(2);
    expect(m.get('a')).toBe(3);
  });

  it('donne un rang 1..5 même si les temps sont ceux d\'une manche de 30 pilotes', () => {
    // Les 5 pilotes d'une série sont 12e à 16e de la manche : le rang DANS le départ reste 1..5
    const m = finishPosInStart([
      { driverId: 'a', ms: 140000 }, { driverId: 'b', ms: 141000 },
      { driverId: 'c', ms: 142000 }, { driverId: 'd', ms: 143000 },
      { driverId: 'e', ms: 144000 },
    ]);
    expect([...m.values()].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('respecte manualPosition pour un DNF classé', () => {
    const m = finishPosInStart([
      { driverId: 'a', ms: 120000 },
      { driverId: 'b', status: 'DNF', manualPosition: 2 },
    ]);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
  });

  it('laisse non classés les DNF sans position, DNS, DSQ et sans résultat', () => {
    const m = finishPosInStart([
      { driverId: 'a', ms: 120000 },
      { driverId: 'b', status: 'DNF' },
      { driverId: 'c', status: 'DNS' },
      { driverId: 'd', status: 'DSQ' },
      { driverId: 'e', status: 'DSQ_RACE' },
      { driverId: 'f' },
    ]);
    expect(m.get('a')).toBe(1);
    for (const id of ['b', 'c', 'd', 'e', 'f']) expect(m.get(id)).toBeNull();
  });

  it('ignore un temps nul ou négatif', () => {
    const m = finishPosInStart([{ driverId: 'a', ms: 0 }, { driverId: 'b', ms: 100 }]);
    expect(m.get('b')).toBe(1);
    expect(m.get('a')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// buildStartGrid
// ─────────────────────────────────────────────────────────

describe('buildStartGrid — MQ', () => {
  const session = { id: 'sess-mq1', type: 'MQ', num: 1 };

  it('gridPos ≡ couloir, une seule ligne, trié par couloir', () => {
    const results = [
      mqResult('d3', 1, 3, 122000), mqResult('d1', 1, 1, 121000), mqResult('d2', 1, 2, 123000),
    ];
    const participants = results.map(r => ({ driverId: r.driverId, carNumber: r.carNumber }));
    const { starts } = enumerateStarts({ session, results, participants, championship: CHAMP_FFSA, category: 'Supercar' });
    const { rows } = buildStartGrid({ start: starts[0], results, participants });

    expect(rows.map(r => r.gridPos)).toEqual([1, 2, 3]);
    expect(rows.map(r => r.lane)).toEqual([1, 2, 3]);
    expect(rows.every(r => r.gridRow === 1)).toBe(true);
    // laneZone n'est PAS stocké : seul le couloir brut l'est (« pas de regroupement »)
    expect(rows.every(r => !('laneZone' in r))).toBe(true);
  });

  it('remplit finishPosInStart depuis les temps du départ', () => {
    const results = [
      mqResult('d1', 1, 1, 125000), mqResult('d2', 1, 2, 121000), mqResult('d3', 1, 3, 123000),
    ];
    const participants = results.map(r => ({ driverId: r.driverId }));
    const { starts } = enumerateStarts({ session, results, participants, championship: CHAMP_FFSA, category: 'Supercar' });
    const { rows } = buildStartGrid({ start: starts[0], results, participants });
    const byId = Object.fromEntries(rows.map(r => [r.driverId, r.finishPosInStart]));
    expect(byId).toEqual({ d1: 3, d2: 1, d3: 2 });
  });

  it('turn1Pos est toujours null à la construction — jamais deviné', () => {
    const results = [mqResult('d1', 1, 1, 120000)];
    const { starts } = enumerateStarts({ session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar' });
    const { rows } = buildStartGrid({ start: starts[0], results, participants: results });
    expect(rows[0].turn1Pos).toBeNull();
    expect(rows[0].autoTurn1Pos).toBeNull();
  });

});

describe('buildStartGrid — DF (quinconce)', () => {
  const participants = Array.from({ length: 8 }, (_, i) => ({ driverId: `d${i + 1}`, carNumber: i + 1 }));
  const ranked = participants.map(p => p.driverId);   // d1 = meilleur qualifié

  it('P4 est en ligne 2 couloir 2 — pas dans le couloir 4', () => {
    const { starts } = enumerateStarts({
      session: { id: 'sess-df1', type: 'DF', num: 1 },
      results: [], participants, championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { rows } = buildStartGrid({ start: starts[0], results: [], participants, rankedDriverIds: ranked });
    const p4 = rows.find(r => r.gridPos === 4);
    expect(p4.gridRow).toBe(2);
    expect(p4.lane).toBe(2);
  });

  it('respecte l\'ordre de la cascade de qualification', () => {
    const { starts } = enumerateStarts({
      session: { id: 's', type: 'DF', num: 1 }, results: [], participants,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    const reversed = [...ranked].reverse();           // d8 devient meilleur qualifié
    const { rows } = buildStartGrid({ start: starts[0], results: [], participants, rankedDriverIds: reversed });
    expect(rows.find(r => r.gridPos === 1).driverId).toBe('d8');
  });

  it('avertit si l\'ordre de qualification est inconnu', () => {
    const { starts } = enumerateStarts({
      session: { id: 's', type: 'DF', num: 1 }, results: [], participants,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { warnings } = buildStartGrid({ start: starts[0], results: [], participants, rankedDriverIds: null });
    expect(warnings.join(' ')).toMatch(/ordre de qualification inconnu/i);
  });

  it('partants surnuméraires : pas de position physique, mais pas d\'erreur', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ driverId: `d${i + 1}` }));
    const { starts } = enumerateStarts({
      session: { id: 's', type: 'DF', num: 1 }, results: [], participants: many,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { rows, warnings } = buildStartGrid({
      start: starts[0], results: [], participants: many,
      rankedDriverIds: many.map(p => p.driverId),
    });
    expect(rows).toHaveLength(10);
    expect(rows[8].lane).toBeNull();
    expect(rows[9].gridRow).toBeNull();
    expect(warnings.join(' ')).toMatch(/surnuméraires/i);
  });

  it('géométrie alternative : mêmes pilotes, placement physique différent', () => {
    const mk = (champ) => {
      const { starts } = enumerateStarts({
        session: { id: 's', type: 'DF', num: 1 }, results: [], participants,
        championship: champ, category: 'Supercar',
      });
      return buildStartGrid({ start: starts[0], results: [], participants, rankedDriverIds: ranked }).rows;
    };
    const a = mk(CHAMP_FFSA).find(r => r.gridPos === 3);
    const b = mk(CHAMP_ALT).find(r => r.gridPos === 3);
    expect(a).toMatchObject({ gridRow: 1, lane: 5 });
    expect(b).toMatchObject({ gridRow: 2, lane: 1 });
  });
});

// ─────────────────────────────────────────────────────────
// DNS — Did Not Start : absent de la ligne de départ
// ─────────────────────────────────────────────────────────

describe('isNonStarter / countStarters', () => {
  it('seul DNS signifie « pas sur la grille »', () => {
    expect(isNonStarter('DNS')).toBe(true);
    expect(isNonStarter('dns')).toBe(true);
  });

  it('DNF, DSQ et DSQ_RACE ont bien pris le départ', () => {
    for (const st of ['DNF', 'DSQ', 'DSQ_RACE', null, undefined, '']) {
      expect(isNonStarter(st)).toBe(false);
    }
  });

  it('countStarters exclut les DNS', () => {
    expect(countStarters([
      { driverId: 'a' }, { driverId: 'b', didNotStart: true }, { driverId: 'c' },
    ])).toBe(2);
  });
});

describe('enumerateStarts — un DNS ne compte pas parmi les partants', () => {
  const session = { id: 'sess-mq4', type: 'MQ', num: 4 };

  it('cas réel : 4 engagés dont 1 DNS → 3 partants', () => {
    const results = [
      mqResult('d1', 2, 1, 121000),
      mqResult('d2', 2, 2, null, 'DNS'),      // Fabien Pailler : pas au départ
      mqResult('d3', 2, 3, null, 'DNF'),
      mqResult('d4', 2, 4, 120000),
    ];
    const { starts } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].starters).toBe(3);
    expect(starts[0].driverIds).toHaveLength(4);      // la ligne reste visible
    expect(starts[0].dnsDriverIds).toEqual(['d2']);
    // Un DNS est une information, pas un avertissement : il ne doit pas
    // déclencher de signal d'alerte qui découragerait la validation.
    expect(starts[0].notes.join(' ')).toMatch(/DNS/);
    expect(starts[0].warnings.join(' ')).not.toMatch(/DNS/);
  });

  it('un DNF compte bien parmi les partants', () => {
    const results = [mqResult('d1', 1, 1, 120000), mqResult('d2', 1, 2, null, 'DNF')];
    const { starts } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].starters).toBe(2);
  });

  it('les couloirs des autres ne sont PAS renumérotés', () => {
    // Couloir 2 absent → le pilote du couloir 3 garde le couloir 3
    const results = [
      mqResult('d1', 1, 1, 121000),
      mqResult('d2', 1, 2, null, 'DNS'),
      mqResult('d3', 1, 3, 120000),
      mqResult('d4', 1, 4, 122000),
    ];
    const { starts } = enumerateStarts({
      session, results, participants: results, championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { rows } = buildStartGrid({ start: starts[0], results, participants: results });
    expect(rows.map(r => r.lane)).toEqual([1, 2, 3, 4]);
    expect(rows.find(r => r.driverId === 'd3').lane).toBe(3);
    expect(rows.find(r => r.driverId === 'd2').didNotStart).toBe(true);
    expect(rows.find(r => r.driverId === 'd1').didNotStart).toBe(false);
  });

  it('finales : un DNS est retiré des partants', () => {
    const participants = Array.from({ length: 8 }, (_, i) => ({ driverId: `d${i + 1}` }));
    const results = [{ driverId: 'd3', status: 'DNS' }];
    const { starts } = enumerateStarts({
      session: { id: 's', type: 'DF', num: 1 }, results, participants,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    expect(starts[0].starters).toBe(7);
    expect(starts[0].dnsDriverIds).toEqual(['d3']);
  });
});

// ─────────────────────────────────────────────────────────
// availableTurn1Positions — empêcher le doublon à la saisie
// ─────────────────────────────────────────────────────────

describe('availableTurn1Positions', () => {
  const rows = () => ([
    { driverId: 'a', turn1Pos: null },
    { driverId: 'b', turn1Pos: null },
    { driverId: 'c', turn1Pos: null },
    { driverId: 'd', turn1Pos: null },
    { driverId: 'e', turn1Pos: null },
  ]);

  it('propose toutes les positions quand rien n\'est saisi', () => {
    expect(availableTurn1Positions('a', rows(), 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('retire une position déjà prise par un autre pilote', () => {
    const r = rows();
    r[2].turn1Pos = 3;                       // c est P3
    expect(availableTurn1Positions('a', r, 5)).toEqual([1, 2, 4, 5]);
  });

  it('retire toutes les positions déjà attribuées', () => {
    const r = rows();
    r[0].turn1Pos = 1; r[1].turn1Pos = 2; r[2].turn1Pos = 5;
    expect(availableTurn1Positions('d', r, 5)).toEqual([3, 4]);
  });

  it('conserve TOUJOURS la position courante du pilote lui-même', () => {
    const r = rows();
    r[2].turn1Pos = 3;
    expect(availableTurn1Positions('c', r, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ne vide pas le sélecteur si un doublon existe déjà (brouillon ancien)', () => {
    const r = rows();
    r[0].turn1Pos = 3;
    r[1].turn1Pos = 3;                       // doublon hérité
    // chacun garde sa valeur visible, le doublon reste signalé par validateAnalysis
    expect(availableTurn1Positions('a', r, 5)).toContain(3);
    expect(availableTurn1Positions('b', r, 5)).toContain(3);
  });

  it('le dernier pilote n\'a plus qu\'un seul choix', () => {
    const r = rows();
    r[0].turn1Pos = 1; r[1].turn1Pos = 2; r[2].turn1Pos = 3; r[3].turn1Pos = 5;
    expect(availableTurn1Positions('e', r, 5)).toEqual([4]);
  });

  it('borne la liste au nombre de partants', () => {
    const r = [{ driverId: 'a', turn1Pos: null }, { driverId: 'b', turn1Pos: null }];
    expect(availableTurn1Positions('a', r, 2)).toEqual([1, 2]);
  });

  it('un pilote DNS ne se voit proposer AUCUNE position', () => {
    const r = rows();
    r[1].didNotStart = true;
    expect(availableTurn1Positions('b', r, 4)).toEqual([]);
  });

  it('les autres sont bornés au nombre de PARTANTS, pas de lignes', () => {
    // 4 engagés dont 1 DNS → 3 partants → P1..P3 seulement
    const r = rows().slice(0, 4);
    r[1].didNotStart = true;
    expect(availableTurn1Positions('a', r, 3)).toEqual([1, 2, 3]);
  });

  it('gère les entrées vides sans planter', () => {
    expect(availableTurn1Positions('a', [], 0)).toEqual([]);
    expect(availableTurn1Positions('a', undefined, 3)).toEqual([1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────
// ORDRE DE GRILLE DES PHASES FINALES
// ─────────────────────────────────────────────────────────

describe('orderByRaceResult', () => {
  it('classe par temps croissant', () => {
    expect(orderByRaceResult([
      { driverId: 'a', ms: 130000 }, { driverId: 'b', ms: 128000 }, { driverId: 'c', ms: 129000 },
    ])).toEqual(['b', 'c', 'a']);
  });

  it('place DNF puis DSQ_RACE puis le reste derrière les finisseurs', () => {
    expect(orderByRaceResult([
      { driverId: 'dsq', status: 'DSQ_RACE' },
      { driverId: 'rien' },
      { driverId: 'fini', ms: 130000 },
      { driverId: 'dnf', status: 'DNF' },
    ])).toEqual(['fini', 'dnf', 'dsq', 'rien']);
  });
});

describe('orderGridByInterim — le classement intermédiaire fait la grille', () => {
  // Règle : le leader du classement est en pole de SA demi-finale, le 2e en
  // pole de l'AUTRE. Le 3e rejoint le 1er, le 4e rejoint le 2e, etc.
  const interim = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13', 'i14', 'i15', 'i16'];
  const DF1 = ['i1', 'i3', 'i5', 'i7', 'i9', 'i11', 'i13', 'i15'];
  const DF2 = ['i2', 'i4', 'i6', 'i8', 'i10', 'i12', 'i14', 'i16'];

  it('DF1 : le leader du classement est en pole', () => {
    expect(orderGridByInterim(DF1, interim)[0]).toBe('i1');
  });

  it('DF2 : le 2e du classement est en pole de son autre demi-finale', () => {
    expect(orderGridByInterim(DF2, interim)[0]).toBe('i2');
  });

  it('DF1 est ordonnée 1er, 3e, 5e… du classement', () => {
    expect(orderGridByInterim(DF1, interim)).toEqual(DF1);
  });

  it('trie même si les participants arrivent en désordre', () => {
    const mele = ['i7', 'i1', 'i5', 'i3'];
    expect(orderGridByInterim(mele, interim)).toEqual(['i1', 'i3', 'i5', 'i7']);
  });

  it('un pilote absent du classement passe en fin de grille', () => {
    expect(orderGridByInterim(['inconnu', 'i3', 'i1'], interim)).toEqual(['i1', 'i3', 'inconnu']);
  });

  it('sans classement disponible, l\'ordre d\'origine est conservé', () => {
    expect(orderGridByInterim(['b', 'a', 'c'], [])).toEqual(['b', 'a', 'c']);
  });
});

describe('chaîne complète — grille de DF placée physiquement', () => {
  const interim = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13', 'i14', 'i15', 'i16'];
  const DF1 = ['i1', 'i3', 'i5', 'i7', 'i9', 'i11', 'i13', 'i15'];

  it('le leader du classement se retrouve ligne 1 couloir 1 (pole)', () => {
    const participants = DF1.map(id => ({ driverId: id }));
    const { starts } = enumerateStarts({
      session: { id: 'df1', type: 'DF', num: 1 }, results: [], participants,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { rows } = buildStartGrid({
      start: starts[0], results: [], participants,
      rankedDriverIds: orderGridByInterim(DF1, interim),
    });
    const pole = rows.find(r => r.gridPos === 1);
    expect(pole.driverId).toBe('i1');
    expect(pole.gridRow).toBe(1);
    expect(pole.lane).toBe(1);
  });

  it('grille 3/2/3 : les 8 pilotes du classement dans l\'ordre attendu', () => {
    const participants = DF1.map(id => ({ driverId: id }));
    const { starts } = enumerateStarts({
      session: { id: 'df1', type: 'DF', num: 1 }, results: [], participants,
      championship: CHAMP_FFSA, category: 'Supercar',
    });
    const { rows } = buildStartGrid({
      start: starts[0], results: [], participants,
      rankedDriverIds: orderGridByInterim(DF1, interim),
    });
    expect(rows.map(r => `${r.driverId}:L${r.gridRow}C${r.lane}`)).toEqual([
      'i1:L1C1', 'i3:L1C3', 'i5:L1C5',      // ligne 1
      'i7:L2C2', 'i9:L2C4',                  // ligne 2
      'i11:L3C1', 'i13:L3C3', 'i15:L3C5',    // ligne 3
    ]);
  });
});

describe('orderFinalGridFromSemis — la finale se compose par paires', () => {
  const df1 = ['a1', 'a2', 'a3', 'a4'];       // ordre d'arrivée DF1
  const df2 = ['b1', 'b2', 'b3', 'b4'];       // ordre d'arrivée DF2

  it('vainqueur DF1 en pole, vainqueur DF2 juste derrière', () => {
    const finalists = ['a1', 'a2', 'b1', 'b2'];
    expect(orderFinalGridFromSemis(finalists, [df1, df2])).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('alterne les demi-finales sur toute la grille', () => {
    const finalists = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4'];
    expect(orderFinalGridFromSemis(finalists, [df1, df2]))
      .toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4']);
  });

  it('ignore les non-qualifiés restés en demi-finale', () => {
    const finalists = ['a1', 'b1'];            // seuls les vainqueurs sont en finale
    expect(orderFinalGridFromSemis(finalists, [df1, df2])).toEqual(['a1', 'b1']);
  });

  it('sans demi-finales, retombe sur le classement intermédiaire', () => {
    const interim = ['x1', 'x2', 'x3'];
    expect(orderFinalGridFromSemis(['x3', 'x1', 'x2'], [], interim)).toEqual(['x1', 'x2', 'x3']);
  });

  it('un finaliste hors demi-finale est ajouté après les paires', () => {
    const interim = ['a1', 'b1', 'invite'];
    expect(orderFinalGridFromSemis(['a1', 'b1', 'invite'], [df1, df2], interim))
      .toEqual(['a1', 'b1', 'invite']);
  });
});

// ─────────────────────────────────────────────────────────
// validateAnalysis — aucune donnée douteuse dans les stats
// ─────────────────────────────────────────────────────────

const okAnalysis = () => ({
  orderCompleteness: 'complete',
  rows: [
    { driverId: 'a', turn1Pos: 1, confidence: 'green', lane: 1 },
    { driverId: 'b', turn1Pos: 2, confidence: 'green', lane: 2 },
    { driverId: 'c', turn1Pos: 3, confidence: 'green', lane: 3 },
  ],
});

describe('validateAnalysis', () => {
  it('accepte une analyse complète et cohérente', () => {
    const v = validateAnalysis(okAnalysis());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('refuse un ordre "partial"', () => {
    const a = okAnalysis();
    a.orderCompleteness = 'partial';
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/ordre incomplet/i);
  });

  it('accepte "leaders_only" avec des positions manquantes, en avertissant', () => {
    const a = okAnalysis();
    a.orderCompleteness = 'leaders_only';
    a.rows.push({ driverId: 'd', turn1Pos: null, confidence: 'green', lane: 4 });
    const v = validateAnalysis(a);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/sans position au 1er virage/i);
  });

  it('refuse une ligne 🔴 non traitée', () => {
    const a = okAnalysis();
    a.rows[1].confidence = 'red';
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/incertaine/i);
  });

  it('refuse des positions V1 en doublon', () => {
    const a = okAnalysis();
    a.rows[1].turn1Pos = 1;
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/doublon/i);
  });

  it('refuse une position hors bornes', () => {
    const a = okAnalysis();
    a.rows[2].turn1Pos = 9;
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/hors bornes/i);
  });

  it('refuse une analyse sans aucune position V1', () => {
    const a = okAnalysis();
    a.rows.forEach(r => { r.turn1Pos = null; });
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/aucune position/i);
  });

  it('rien de saisi : PAS d\'avertissement « sans position » en doublon', () => {
    // L'erreur ci-dessus dit déjà que rien n'est saisi ; répéter en orange
    // serait redondant, et parler d'abandon serait faux.
    const a = okAnalysis();
    a.rows.forEach(r => { r.turn1Pos = null; });
    const v = validateAnalysis(a);
    expect(v.warnings.join(' ')).not.toMatch(/sans position/i);
  });

  it('saisie partielle : avertit sans présumer d\'un abandon', () => {
    const a = okAnalysis();
    a.rows[2].turn1Pos = null;              // 2 saisis sur 3
    const v = validateAnalysis(a);
    const w = v.warnings.join(' ');
    expect(w).toMatch(/1 pilote\(s\) sans position au 1er virage/i);
    expect(w).toMatch(/non visible/i);       // la raison n'est pas présumée
    expect(w).not.toMatch(/^.*abandon avant le virage 1/);
  });

  it('refuse une position V1 attribuée à un pilote DNS', () => {
    const a = okAnalysis();
    a.rows.push({ driverId: 'd', turn1Pos: 4, confidence: 'green', lane: 4, didNotStart: true });
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/DNS/);
  });

  it('borne les positions au nombre de PARTANTS (DNS exclus)', () => {
    const a = okAnalysis();                              // 3 lignes, positions 1..3
    a.rows.push({ driverId: 'd', turn1Pos: null, confidence: 'green', lane: 4, didNotStart: true });
    a.rows[2].turn1Pos = 4;                              // hors bornes : 3 partants seulement
    const v = validateAnalysis(a);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/hors bornes \(1\.\.3\)/);
  });

  it('un DNS ne compte pas comme « position manquante »', () => {
    const a = okAnalysis();
    a.rows.push({ driverId: 'd', turn1Pos: null, confidence: 'green', lane: 4, didNotStart: true });
    const v = validateAnalysis(a);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).not.toMatch(/sans position au 1er virage/i);
    // et aucun avertissement pour le DNS lui-même : c'est normal, pas un souci
    expect(v.warnings.join(' ')).not.toMatch(/DNS/);
  });

  it('une série avec un DNS reste validable, SANS aucun avertissement', () => {
    // Cas réel : 4 engagés dont 1 DNS, les 3 partants renseignés.
    const a = {
      orderCompleteness: 'complete',
      rows: [
        { driverId: 'a', turn1Pos: 2, confidence: 'green', lane: 1 },
        { driverId: 'b', turn1Pos: null, confidence: 'green', lane: 2, didNotStart: true },
        { driverId: 'c', turn1Pos: 3, confidence: 'green', lane: 3 },
        { driverId: 'd', turn1Pos: 1, confidence: 'green', lane: 4 },
      ],
    };
    const v = validateAnalysis(a);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);       // aucun signal d'alerte parasite
  });

  it('refuse un départ vide', () => {
    expect(validateAnalysis({ rows: [] }).ok).toBe(false);
  });

  it('avertit sur les lignes 🟡 sans bloquer', () => {
    const a = okAnalysis();
    a.rows[0].confidence = 'yellow';
    const v = validateAnalysis(a);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/vérifier/i);
  });

  it('avertit si un couloir est absent', () => {
    const a = okAnalysis();
    a.rows[0].lane = null;
    expect(validateAnalysis(a).warnings.join(' ')).toMatch(/couloir/i);
  });
});

// ─────────────────────────────────────────────────────────
// POINTAGE DANS L'ORDRE
// ─────────────────────────────────────────────────────────

describe('pointTurn1InOrder', () => {
  const grille = (etats = {}) => ['a', 'b', 'c', 'd', 'e'].map(id => ({
    driverId: id, turn1Pos: etats[id] ?? null, didNotStart: false, corrected: false,
  }));
  const pos = (rows) => Object.fromEntries(rows.map(r => [r.driverId, r.turn1Pos]));

  it('attribue P1 au premier pilote désigné', () => {
    const r = pointTurn1InOrder('c', grille(), 5);
    expect(pos(r)).toEqual({ a: null, b: null, c: 1, d: null, e: null });
  });

  it('attribue les positions dans l\'ordre des clics', () => {
    let r = grille();
    for (const id of ['c', 'a', 'e']) r = pointTurn1InOrder(id, r, 5);
    expect(pos(r)).toEqual({ a: 2, b: null, c: 1, d: null, e: 3 });
  });

  it('retire le pilote recliqué ET resserre ceux qui suivaient', () => {
    // Sans le resserrement, retirer P1 laisserait P2 et P3 en place : un trou
    // que l'opérateur devrait reboucher position par position.
    let r = grille();
    for (const id of ['c', 'a', 'e']) r = pointTurn1InOrder(id, r, 5);
    r = pointTurn1InOrder('c', r, 5);
    expect(pos(r)).toEqual({ a: 1, b: null, c: null, d: null, e: 2 });
  });

  it('ne laisse pas de trou quand on retire une position intermédiaire', () => {
    let r = grille();
    for (const id of ['a', 'b', 'c', 'd']) r = pointTurn1InOrder(id, r, 5);
    r = pointTurn1InOrder('b', r, 5);
    expect(pos(r)).toEqual({ a: 1, b: null, c: 2, d: 3, e: null });
  });

  it('ne classe jamais un pilote non partant', () => {
    const rows = grille().map(r => (r.driverId === 'b' ? { ...r, didNotStart: true } : r));
    expect(pos(pointTurn1InOrder('b', rows, 5))).toEqual({ a: null, b: null, c: null, d: null, e: null });
  });

  it('ne dépasse pas le nombre de partants', () => {
    let r = grille();
    for (const id of ['a', 'b', 'c']) r = pointTurn1InOrder(id, r, 3);
    const avant = pos(r);
    expect(pos(pointTurn1InOrder('d', r, 3))).toEqual(avant);   // plus une seule place
  });

  it('est PURE : la liste d\'entrée n\'est pas modifiée', () => {
    const rows = grille();
    pointTurn1InOrder('a', rows, 5);
    expect(rows.every(r => r.turn1Pos === null)).toBe(true);
  });

  it('marque comme corrigée la seule ligne désignée', () => {
    const r = pointTurn1InOrder('d', grille(), 5);
    expect(r.filter(x => x.corrected).map(x => x.driverId)).toEqual(['d']);
  });

  it('reste sans effet sur un pilote inconnu ou un effectif nul', () => {
    expect(pos(pointTurn1InOrder('zz', grille(), 5))).toEqual(pos(grille()));
    expect(pos(pointTurn1InOrder('a', grille(), 0))).toEqual(pos(grille()));
  });
});

describe('nextFreeTurn1Pos', () => {
  const r = (...positions) => positions.map((p, i) => ({ driverId: 'd' + i, turn1Pos: p }));

  it('rend P1 sur une grille vierge', () => {
    expect(nextFreeTurn1Pos(r(null, null, null), 3)).toBe(1);
  });

  it('rend la plus petite position LIBRE, pas la suivante du maximum', () => {
    // Un retrait peut laisser un trou si l'opérateur a saisi en mode manuel :
    // c'est ce trou qu'il faut combler d'abord.
    expect(nextFreeTurn1Pos(r(1, 3, null), 5)).toBe(2);
  });

  it('rend null quand toutes les places sont prises', () => {
    expect(nextFreeTurn1Pos(r(1, 2, 3), 3)).toBe(null);
  });

  it('ignore les positions vides ou aberrantes', () => {
    expect(nextFreeTurn1Pos(r(null, '', 0, -2, 1), 4)).toBe(2);
  });

  it('rend null si le nombre de partants est absurde', () => {
    expect(nextFreeTurn1Pos(r(null), 0)).toBe(null);
    expect(nextFreeTurn1Pos(r(null), -1)).toBe(null);
  });

  it('annonce bien ce que pointTurn1InOrder attribuera', () => {
    // L'écran affiche « → Pn » avec cette fonction ; si les deux divergeaient,
    // le bouton mentirait sur ce qu'il va faire.
    const rows = [
      { driverId: 'a', turn1Pos: 1, didNotStart: false },
      { driverId: 'b', turn1Pos: null, didNotStart: false },
      { driverId: 'c', turn1Pos: 3, didNotStart: false },
    ];
    const annonce = nextFreeTurn1Pos(rows, 5);
    const apres = pointTurn1InOrder('b', rows, 5);
    expect(apres.find(x => x.driverId === 'b').turn1Pos).toBe(annonce);
  });
});

// ─────────────────────────────────────────────────────────
// PROPOSITION AUTOMATIQUE DU V1
// ─────────────────────────────────────────────────────────

describe('applyV1OrderProposal', () => {
  const grille = () => [
    { driverId: 'a', carNumber: 12, turn1Pos: null, didNotStart: false },
    { driverId: 'b', carNumber: 7,  turn1Pos: null, didNotStart: false },
    { driverId: 'c', carNumber: 3,  turn1Pos: null, didNotStart: false },
  ];
  const prop = (positions) => ({ schema: 'rx-v1-order/1', positions });
  const autos = (rows) => Object.fromEntries(rows.map(r => [r.carNumber, r.autoTurn1Pos]));

  it('remplit autoTurn1Pos et ne touche JAMAIS turn1Pos', () => {
    const r = applyV1OrderProposal({
      rows: grille(), starters: 3,
      proposal: prop([{ carNumber: 12, turn1Pos: 2 }, { carNumber: 7, turn1Pos: 1 }]),
    });
    expect(autos(r.rows)).toEqual({ 12: 2, 7: 1, 3: null });
    expect(r.rows.every(x => x.turn1Pos === null)).toBe(true);
    expect(r.applied).toBe(2);
  });

  it('accepte « non décidé » sans le compter comme un rejet', () => {
    const r = applyV1OrderProposal({
      rows: grille(), starters: 3,
      proposal: prop([{ carNumber: 12, turn1Pos: 1 }, { carNumber: 7, turn1Pos: null }]),
    });
    expect(r.applied).toBe(1);
    expect(r.rejected).toEqual([]);
  });

  it('n\'attribue à PERSONNE une position revendiquée deux fois', () => {
    // Trancher au hasard ferait entrer une erreur silencieuse — exactement ce
    // qu'on refuse : mieux vaut deux cases vides qu'une case fausse.
    const r = applyV1OrderProposal({
      rows: grille(), starters: 3,
      proposal: prop([{ carNumber: 12, turn1Pos: 1 }, { carNumber: 7, turn1Pos: 1 }]),
    });
    expect(autos(r.rows)).toEqual({ 12: null, 7: null, 3: null });
    expect(r.applied).toBe(0);
    expect(r.rejected).toHaveLength(2);
  });

  it('écarte une voiture absente du départ, une position hors effectif, un DNS', () => {
    const rows = grille().map(r => (r.carNumber === 3 ? { ...r, didNotStart: true } : r));
    const r = applyV1OrderProposal({
      rows, starters: 2,
      proposal: prop([
        { carNumber: 99, turn1Pos: 1 },
        { carNumber: 12, turn1Pos: 5 },
        { carNumber: 3,  turn1Pos: 2 },
        { carNumber: 7,  turn1Pos: 1 },
      ]),
    });
    expect(autos(r.rows)).toEqual({ 12: null, 7: 1, 3: null });
    expect(r.rejected.map(x => x.carNumber).sort((a, b) => a - b)).toEqual([3, 12, 99]);
  });

  it('refuse un document au mauvais schéma', () => {
    const r = applyV1OrderProposal({ rows: grille(), proposal: { positions: [] } });
    expect(r.applied).toBe(0);
    expect(r.rejected[0].raison).toMatch(/format/);
  });

  it('ne devine pas quand deux pilotes portent le même numéro', () => {
    const rows = [...grille(), { driverId: 'd', carNumber: 12, turn1Pos: null, didNotStart: false }];
    const r = applyV1OrderProposal({ rows, starters: 4, proposal: prop([{ carNumber: 12, turn1Pos: 1 }]) });
    expect(r.applied).toBe(0);
    expect(r.rejected[0].raison).toMatch(/double/);
  });
});

describe('acceptV1Proposals', () => {
  const avec = (specs) => specs.map((s, i) => ({
    driverId: 'd' + i, carNumber: 10 + i, turn1Pos: null, autoTurn1Pos: null, didNotStart: false, ...s,
  }));

  it('reprend les propositions à son compte', () => {
    const r = acceptV1Proposals(avec([{ autoTurn1Pos: 2 }, { autoTurn1Pos: 1 }]));
    expect(r.rows.map(x => x.turn1Pos)).toEqual([2, 1]);
    expect(r.accepted).toBe(2);
  });

  it('ne remplace JAMAIS une position saisie à la main', () => {
    const r = acceptV1Proposals(avec([{ turn1Pos: 1, autoTurn1Pos: 3 }, { autoTurn1Pos: 2 }]));
    expect(r.rows.map(x => x.turn1Pos)).toEqual([1, 2]);
    expect(r.accepted).toBe(1);
  });

  it('laisse de côté une proposition qui heurte une saisie manuelle', () => {
    // La machine propose P1 pour le second, mais un humain a déjà mis P1
    // ailleurs : on ne bouscule pas, on signale en ne faisant rien.
    const r = acceptV1Proposals(avec([{ turn1Pos: 1 }, { autoTurn1Pos: 1 }]));
    expect(r.rows.map(x => x.turn1Pos)).toEqual([1, null]);
    expect(r.accepted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('ne classe jamais un non-partant', () => {
    const r = acceptV1Proposals(avec([{ autoTurn1Pos: 1, didNotStart: true }]));
    expect(r.rows[0].turn1Pos).toBe(null);
    expect(r.accepted).toBe(0);
  });

  it('est pure', () => {
    const rows = avec([{ autoTurn1Pos: 1 }]);
    acceptV1Proposals(rows);
    expect(rows[0].turn1Pos).toBe(null);
  });
});

describe('buildStartGridExport', () => {
  const rows = [
    { carNumber: 3,  firstName: 'Ana', lastName: 'Roux', lane: 2, gridPos: 2, didNotStart: false },
    { carNumber: 12, firstName: 'Bo',  lastName: 'Silva', lane: 1, gridPos: 1, didNotStart: false },
    { carNumber: 7,  firstName: 'Cy',  lastName: 'Nauy', lane: 3, gridPos: 3, didNotStart: true },
  ];

  it('rend la grille triée par couloir, non-partants exclus', () => {
    const d = buildStartGridExport({ start: { startLabel: 'MQ3 S4' }, rows, poleSide: 'droite' });
    expect(d.drivers.map(x => x.carNumber)).toEqual([12, 3]);
    expect(d.starters).toBe(2);
  });

  it('porte les NOMS, pas seulement les numéros', () => {
    // C'est tout l'objet de l'export : on reconnaît une déco, pas un numéro.
    const d = buildStartGridExport({ rows, poleSide: 'gauche' });
    expect(d.drivers[0]).toMatchObject({ carNumber: 12, firstName: 'Bo', lastName: 'Silva', lane: 1 });
  });

  it('normalise le côté de la pole', () => {
    expect(buildStartGridExport({ rows, poleSide: 'gauche' }).poleSide).toBe('left');
    expect(buildStartGridExport({ rows, poleSide: 'droite' }).poleSide).toBe('right');
  });

  it('n\'emporte ni résultat ni statut', () => {
    const d = buildStartGridExport({ rows, poleSide: 'droite' });
    const champs = Object.keys(d.drivers[0]).sort();
    expect(champs).toEqual(['carNumber', 'firstName', 'gridPos', 'lane', 'lastName']);
  });

  it('se reconnaît lui-même, et rejette autre chose', () => {
    expect(isStartGridExport(buildStartGridExport({ rows }))).toBe(true);
    expect(isStartGridExport({ schema: 'rx-v1-order/1', positions: [] })).toBe(false);
    expect(isStartGridExport(null)).toBe(false);
  });
});
