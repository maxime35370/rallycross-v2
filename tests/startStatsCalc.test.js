import { describe, it, expect } from 'vitest';
import {
  validatedOnly, filterAnalyses, toRows,
  mean, median, wilson, spearman,
  byGridPos, byLane, transitionMatrix, turn1VsFinish, summary,
  formatRate, MIN_N_FOR_RATE,
} from '../js/startStatsCalc.js';

// ─────────────────────────────────────────────────────────
// JEUX DE DONNÉES
// ─────────────────────────────────────────────────────────

/** Fabrique une analyse validée : ordre = positions V1 dans l'ordre des couloirs. */
function makeStart({
  id, sessionType = 'MQ', starters = 5, turn1 = [1, 2, 3, 4, 5], finish = null,
  category = 'Supercar', year = 2026, circuitLabel = 'Kerlabo',
  championshipId = 'ch1', status = 'validated', gridLayoutKey = 'mq:5',
  gridSource = 'mq_couloir',
}) {
  const rows = Array.from({ length: starters }, (_, i) => ({
    driverId: `${id}-d${i + 1}`,
    carNumber: i + 1,
    didNotStart: false,
    gridPos: i + 1,
    gridRow: 1,
    lane: i + 1,
    turn1Pos: turn1[i] ?? null,
    finishPosInStart: finish ? finish[i] : (turn1[i] ?? null),
    finishStatus: null,
    confidence: 'green',
  }));
  return {
    id, status, sessionType, starters, category, year, circuitLabel,
    championshipId, gridLayoutKey, gridSource, gridLanes: 5, rows,
  };
}

// ─────────────────────────────────────────────────────────
// SÉLECTION
// ─────────────────────────────────────────────────────────

describe('validatedOnly — rien de non validé n\'entre dans les stats', () => {
  it('écarte les brouillons', () => {
    const data = [
      makeStart({ id: 'a' }),
      makeStart({ id: 'b', status: 'draft' }),
    ];
    expect(validatedOnly(data).map(a => a.id)).toEqual(['a']);
  });

  it('écarte les documents sans lignes', () => {
    expect(validatedOnly([{ id: 'x', status: 'validated' }])).toEqual([]);
  });

  it('tolère les entrées vides', () => {
    expect(validatedOnly([null, undefined])).toEqual([]);
    expect(validatedOnly()).toEqual([]);
  });
});

describe('filterAnalyses', () => {
  const data = [
    makeStart({ id: 'a', category: 'Supercar', circuitLabel: 'Kerlabo', sessionType: 'MQ' }),
    makeStart({ id: 'b', category: 'D3', circuitLabel: 'Kerlabo', sessionType: 'MQ' }),
    makeStart({ id: 'c', category: 'Supercar', circuitLabel: 'Lohéac', sessionType: 'FIN', starters: 8, turn1: [1,2,3,4,5,6,7,8] }),
    makeStart({ id: 'd', category: 'Supercar', circuitLabel: 'Kerlabo', status: 'draft' }),
  ];

  it('sans critère, ne garde que les validées', () => {
    expect(filterAnalyses(data).map(a => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('filtre par catégorie', () => {
    expect(filterAnalyses(data, { category: 'Supercar' }).map(a => a.id)).toEqual(['a', 'c']);
  });

  it('filtre par circuit', () => {
    expect(filterAnalyses(data, { circuitLabel: 'Lohéac' }).map(a => a.id)).toEqual(['c']);
  });

  it('filtre par type de session', () => {
    expect(filterAnalyses(data, { sessionType: 'FIN' }).map(a => a.id)).toEqual(['c']);
  });

  it('combine plusieurs critères', () => {
    expect(filterAnalyses(data, { category: 'Supercar', circuitLabel: 'Kerlabo' }).map(a => a.id))
      .toEqual(['a']);
  });

  it('filtre par taille de grille', () => {
    expect(filterAnalyses(data, { starters: 8 }).map(a => a.id)).toEqual(['c']);
  });
});

describe('toRows', () => {
  it('exclut les pilotes DNS', () => {
    const a = makeStart({ id: 'a', starters: 3, turn1: [1, 2, 3] });
    a.rows[1].didNotStart = true;
    expect(toRows([a])).toHaveLength(2);
  });

  it('exclut les lignes sans position de grille', () => {
    const a = makeStart({ id: 'a', starters: 3, turn1: [1, 2, 3] });
    a.rows[0].gridPos = null;
    expect(toRows([a])).toHaveLength(2);
  });

  it('reporte le contexte du départ sur chaque ligne', () => {
    const rows = toRows([makeStart({ id: 'a', starters: 2, turn1: [1, 2] })]);
    expect(rows[0]).toMatchObject({ startId: 'a', sessionType: 'MQ', category: 'Supercar', starters: 2 });
  });
});

// ─────────────────────────────────────────────────────────
// OUTILS
// ─────────────────────────────────────────────────────────

describe('mean / median', () => {
  it('calcule la moyenne', () => expect(mean([1, 2, 3, 4])).toBe(2.5));
  it('calcule la médiane sur un effectif pair', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it('calcule la médiane sur un effectif impair', () => expect(median([3, 1, 2])).toBe(2));
  it('ignore les valeurs non numériques', () => expect(mean([1, null, 3, undefined])).toBe(2));
  it('renvoie null sans donnée', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });
  it('la médiane résiste à une valeur extrême, pas la moyenne', () => {
    const v = [1, 1, 1, 1, 20];
    expect(median(v)).toBe(1);
    expect(mean(v)).toBe(4.8);
  });
});

describe('wilson — intervalle de confiance honnête sur petit échantillon', () => {
  it('donne le taux observé', () => {
    expect(wilson(1, 2).rate).toBe(0.5);
  });

  it('produit un intervalle TRÈS large sur 4 observations', () => {
    const w = wilson(3, 4);                       // « 75 % »
    expect(w.rate).toBe(0.75);
    expect(w.high - w.low).toBeGreaterThan(0.5);  // en réalité : on ne sait rien
  });

  it('resserre l\'intervalle quand l\'échantillon grandit', () => {
    const petit = wilson(150, 200);
    const grand = wilson(1500, 2000);             // même taux, 10× plus de données
    expect(grand.high - grand.low).toBeLessThan(petit.high - petit.low);
  });

  it('reste borné entre 0 et 1 aux extrêmes', () => {
    const w0 = wilson(0, 5);
    const w1 = wilson(5, 5);
    expect(w0.low).toBeGreaterThanOrEqual(0);
    expect(w1.high).toBeLessThanOrEqual(1);
  });

  it('renvoie null sans observation', () => {
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('spearman', () => {
  it('vaut 1 pour un ordre identique', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 6);
  });

  it('vaut -1 pour un ordre inversé', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('est proche de 0 sans relation', () => {
    expect(Math.abs(spearman([1, 2, 3, 4, 5, 6], [3, 1, 5, 2, 6, 4]))).toBeLessThan(0.6);
  });

  it('gère les ex aequo', () => {
    expect(spearman([1, 1, 2, 3], [1, 2, 2, 3])).not.toBeNull();
  });

  it('renvoie null avec moins de 3 paires', () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it('renvoie null sans aucune variation', () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// STATISTIQUES MÉTIER
// ─────────────────────────────────────────────────────────

describe('byGridPos', () => {
  // 4 départs de 5 : P1 garde la tête 3 fois sur 4
  const data = [
    makeStart({ id: 's1', turn1: [1, 2, 3, 4, 5] }),
    makeStart({ id: 's2', turn1: [1, 2, 3, 4, 5] }),
    makeStart({ id: 's3', turn1: [1, 2, 3, 4, 5] }),
    makeStart({ id: 's4', turn1: [2, 1, 3, 4, 5] }),   // P2 prend la tête
  ];
  const rows = toRows(data);
  const stats = byGridPos(rows);

  it('produit une ligne par position de grille', () => {
    expect(stats.map(s => s.gridPos)).toEqual([1, 2, 3, 4, 5]);
  });

  it('compte les départs ET les observations', () => {
    expect(stats[0].nStarts).toBe(4);
    expect(stats[0].nObservations).toBe(4);
  });

  it('calcule le taux de conservation de la tête pour P1', () => {
    expect(stats[0].keptLeadRate.rate).toBe(0.75);
    expect(stats[0].keptLeadRate.n).toBe(4);
    expect(stats[0].tookLeadRate).toBeNull();      // sans objet pour P1
  });

  it('calcule le taux de prise de tête pour P2', () => {
    expect(stats[1].tookLeadRate.rate).toBe(0.25);
    expect(stats[1].keptLeadRate).toBeNull();
  });

  it('calcule le gain moyen, positif quand on gagne des places', () => {
    expect(stats[0].gainMean).toBeCloseTo(-0.25, 6);   // P1 perd parfois
    expect(stats[1].gainMean).toBeCloseTo(0.25, 6);    // P2 gagne parfois
  });

  it('ignore les lignes sans position V1 mesurée', () => {
    const a = makeStart({ id: 'x', starters: 3, turn1: [1, 2, null] });
    const s = byGridPos(toRows([a]));
    expect(s[2].nObservations).toBe(1);
    expect(s[2].nMeasured).toBe(0);
    expect(s[2].gainMean).toBeNull();
  });
});

describe('byLane — couloir BRUT, la vue principale', () => {
  const data = [
    makeStart({ id: 's1', turn1: [1, 2, 3, 4, 5] }),
    makeStart({ id: 's2', turn1: [2, 1, 3, 4, 5] }),
  ];
  const stats = byLane(toRows(data));

  it('produit une ligne par couloir', () => {
    expect(stats.map(s => s.lane)).toEqual([1, 2, 3, 4, 5]);
  });

  it('calcule le taux de prise de tête par couloir', () => {
    expect(stats[0].leadRate.rate).toBe(0.5);      // couloir 1 : 1 fois sur 2
    expect(stats[1].leadRate.rate).toBe(0.5);
    expect(stats[2].leadRate.rate).toBe(0);
  });

  it('calcule le gain moyen par couloir', () => {
    expect(stats[0].gainMean).toBeCloseTo(-0.5, 6);
    expect(stats[1].gainMean).toBeCloseTo(0.5, 6);
  });
});

describe('transitionMatrix', () => {
  const data = [
    makeStart({ id: 's1', starters: 3, turn1: [1, 2, 3] }),
    makeStart({ id: 's2', starters: 3, turn1: [1, 2, 3] }),
    makeStart({ id: 's3', starters: 3, turn1: [2, 1, 3] }),
    makeStart({ id: 's4', starters: 5, turn1: [1, 2, 3, 4, 5] }),   // autre taille
  ];
  const m = transitionMatrix(toRows(data), 3);

  it('ne retient que les départs de la taille demandée', () => {
    expect(m.size).toBe(3);
    expect(m.nStarts).toBe(3);                    // le départ à 5 est écarté
  });

  it('produit une matrice carrée', () => {
    expect(m.cells).toHaveLength(3);
    expect(m.cells[0]).toHaveLength(3);
  });

  it('P1 finit P1 dans deux cas sur trois', () => {
    expect(m.cells[0][0]).toMatchObject({ count: 2, n: 3 });
    expect(m.cells[0][0].rate).toBeCloseTo(2 / 3, 6);
  });

  it('chaque ligne totalise 100 %', () => {
    for (const row of m.cells) {
      const total = row.reduce((a, c) => a + (c.rate || 0), 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it('renvoie une matrice vide pour une taille invalide', () => {
    expect(transitionMatrix(toRows(data), 0).cells).toEqual([]);
  });
});

describe('turn1VsFinish', () => {
  it('corrélation parfaite quand l\'ordre ne change plus après le virage 1', () => {
    const a = makeStart({ id: 'a', turn1: [1, 2, 3, 4, 5], finish: [1, 2, 3, 4, 5] });
    const r = turn1VsFinish(toRows([a]));
    expect(r.rho).toBeCloseTo(1, 6);
    expect(r.n).toBe(5);
  });

  it('corrélation négative si tout s\'inverse', () => {
    const a = makeStart({ id: 'a', turn1: [1, 2, 3, 4, 5], finish: [5, 4, 3, 2, 1] });
    expect(turn1VsFinish(toRows([a])).rho).toBeCloseTo(-1, 6);
  });
});

describe('summary', () => {
  const data = [
    makeStart({ id: 's1', starters: 3, turn1: [1, 2, 3] }),
    makeStart({ id: 's2', starters: 5, turn1: [1, 2, 3, 4, 5] }),
    makeStart({ id: 's3', starters: 5, turn1: [1, 2, 3, 4, 5], circuitLabel: 'Lohéac' }),
  ];
  const s = summary(data);

  it('compte les départs et les observations séparément', () => {
    expect(s.nStarts).toBe(3);
    expect(s.nObservations).toBe(13);            // 3 + 5 + 5
  });

  it('recense les circuits et catégories', () => {
    expect(s.nCircuits).toBe(2);
    expect(s.nCategories).toBe(1);
  });

  it('détaille la répartition par taille de grille', () => {
    expect(s.bySize).toEqual([{ starters: 3, count: 1 }, { starters: 5, count: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────
// AFFICHAGE HONNÊTE DES TAUX
// ─────────────────────────────────────────────────────────

describe('formatRate — pas de pourcentage sur un échantillon dérisoire', () => {
  it('affiche l\'effectif brut sous le seuil', () => {
    expect(formatRate(wilson(3, 4))).toBe('3/4');
  });

  it('affiche un pourcentage au-delà du seuil', () => {
    expect(formatRate(wilson(5, 10))).toBe('50 %');
  });

  it('le seuil vaut 10 observations', () => {
    expect(MIN_N_FOR_RATE).toBe(10);
    expect(formatRate(wilson(9, 9))).toBe('9/9');
    expect(formatRate(wilson(10, 10))).toBe('100 %');
  });

  it('gère l\'absence de donnée', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(wilson(0, 0))).toBe('—');
  });
});
