import { describe, it, expect } from 'vitest';
import {
  validatedOnly, filterAnalyses, toRows,
  mean, median, wilson, spearman,
  byGridPos, byLane, byGridRow, gridPosEqualsLane, transitionMatrix, allMatrices,
  laneOrientation, orderLanesForDisplay,
  turn1VsFinish, gridVsFinish, gridVsTurn1, summary,
  phaseGroupOf, availableSizes, formatRate, MIN_N_FOR_RATE,
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

  it('« P1 au V1 » : une seule colonne, valable pour toutes les positions', () => {
    expect(stats[0].leadRate.rate).toBe(0.75);     // P1 garde la tête 3 fois sur 4
    expect(stats[1].leadRate.rate).toBe(0.25);     // P2 la prend 1 fois sur 4
    expect(stats[2].leadRate.rate).toBe(0);
  });

  it('décompose maintien, gain et perte de position', () => {
    expect(stats[0].keptRate.rate).toBe(0.75);     // P1 reste P1
    expect(stats[0].lostRate.rate).toBe(0.25);
    expect(stats[0].gainedRate.rate).toBe(0);      // P1 ne peut pas gagner
    expect(stats[1].gainedRate.rate).toBe(0.25);   // P2 passe P1 une fois
    expect(stats[1].keptRate.rate).toBe(0.75);
  });

  it('les trois taux d\'évolution totalisent 100 %', () => {
    for (const st of stats) {
      const total = st.keptRate.rate + st.gainedRate.rate + st.lostRate.rate;
      expect(total).toBeCloseTo(1, 6);
    }
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

describe('gridPosEqualsLane — détection des deux tableaux identiques', () => {
  it('est vrai sur une grille de manche (une seule ligne)', () => {
    const rows = toRows([makeStart({ id: 's1' })]);
    expect(gridPosEqualsLane(rows)).toBe(true);
  });

  it("produit alors exactement les mêmes chiffres des deux côtés", () => {
    const rows = toRows([
      makeStart({ id: 's1', turn1: [1, 2, 3, 4, 5] }),
      makeStart({ id: 's2', turn1: [2, 1, 3, 4, 5] }),
    ]);
    const g = byGridPos(rows).map(({ gridPos, ...rest }) => rest);
    const l = byLane(rows).map(({ lane, ...rest }) => rest);
    expect(g).toEqual(l);
  });

  it('est faux dès qu’une ligne dissocie position de grille et couloir', () => {
    const rows = toRows([makeStart({ id: 's1' })]);
    rows[3].gridPos = 4; rows[3].lane = 1;   // 2e ligne d'une grille 3/2/3
    expect(gridPosEqualsLane(rows)).toBe(false);
  });

  it('est faux sans donnée exploitable', () => {
    expect(gridPosEqualsLane([])).toBe(false);
    expect(gridPosEqualsLane([{ gridPos: null, lane: null }])).toBe(false);
  });
});

describe('laneOrientation — sens de lecture des couloirs', () => {
  it('lit le côté depuis l\'analyse quand elle le porte', () => {
    expect(laneOrientation([{ poleSide: 'droite' }, { poleSide: 'right' }])).toBe('right');
    expect(laneOrientation([{ poleSide: 'gauche' }])).toBe('left');
  });

  it('retombe sur le meeting pour les analyses enregistrées avant ce champ', () => {
    const analyses = [{ meetingId: 'm1' }, { meetingId: 'm1' }];
    expect(laneOrientation(analyses, { m1: 'gauche' })).toBe('left');
  });

  it('préfère le côté porté par l\'analyse à celui du meeting', () => {
    // Le meeting a pu être corrigé après coup : l'analyse fait foi.
    expect(laneOrientation([{ meetingId: 'm1', poleSide: 'droite' }], { m1: 'gauche' })).toBe('right');
  });

  it('refuse un ordre physique quand la sélection mélange les orientations', () => {
    expect(laneOrientation([{ poleSide: 'droite' }, { poleSide: 'gauche' }])).toBe('mixed');
  });

  it('dit ne pas savoir plutôt que de supposer', () => {
    expect(laneOrientation([])).toBe('unknown');
    expect(laneOrientation([{ meetingId: 'm1' }], {})).toBe('unknown');
    expect(laneOrientation([{ meetingId: 'm1' }], { m1: '' })).toBe('unknown');
  });
});

describe('orderLanesForDisplay', () => {
  const stats = [{ lane: 1 }, { lane: 2 }, { lane: 3 }, { lane: 4 }, { lane: 5 }];

  it('inverse quand le couloir 1 est à droite : on lit la piste de gauche à droite', () => {
    expect(orderLanesForDisplay(stats, 'right').map(s => s.lane)).toEqual([5, 4, 3, 2, 1]);
  });

  it('garde l\'ordre naturel quand le couloir 1 est à gauche', () => {
    expect(orderLanesForDisplay(stats, 'left').map(s => s.lane)).toEqual([1, 2, 3, 4, 5]);
  });

  it('n\'invente pas d\'ordre physique sur une sélection mélangée ou inconnue', () => {
    expect(orderLanesForDisplay(stats, 'mixed').map(s => s.lane)).toEqual([1, 2, 3, 4, 5]);
    expect(orderLanesForDisplay(stats, 'unknown').map(s => s.lane)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ne modifie pas le tableau d\'entrée', () => {
    const copy = [...stats];
    orderLanesForDisplay(stats, 'right');
    expect(stats).toEqual(copy);
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
// LES TROIS MATRICES
// ─────────────────────────────────────────────────────────

describe('allMatrices — grille → V1 → arrivée', () => {
  // 3 départs de 3. Au V1 l'ordre change, puis se rétablit à l'arrivée.
  const data = [
    makeStart({ id: 'm1', starters: 3, turn1: [1, 2, 3], finish: [1, 2, 3] }),
    makeStart({ id: 'm2', starters: 3, turn1: [2, 1, 3], finish: [1, 2, 3] }),
    makeStart({ id: 'm3', starters: 3, turn1: [2, 1, 3], finish: [2, 1, 3] }),
  ];
  const rows = toRows(data);
  const m = allMatrices(rows, 3);

  it('produit bien les trois matrices demandées', () => {
    expect(Object.keys(m)).toEqual(['gridToTurn1', 'turn1ToFinish', 'gridToFinish']);
  });

  it('grille → V1 : P1 conserve la tête 1 fois sur 3', () => {
    expect(m.gridToTurn1.cells[0][0]).toMatchObject({ count: 1, n: 3 });
  });

  it('V1 → arrivée : celui qui sort P1 du virage gagne 2 fois sur 3', () => {
    // m1 : P1 au V1 finit P1 ; m2 : le V1-P1 est d2 qui finit P2 ; m3 : le V1-P1 finit P1
    expect(m.turn1ToFinish.cells[0][0].n).toBe(3);
    expect(m.turn1ToFinish.cells[0][0].count).toBe(2);
  });

  it('grille → arrivée : mesure l\'effet global de la position de départ', () => {
    expect(m.gridToFinish.cells[0][0]).toMatchObject({ count: 2, n: 3 });
  });

  it('chaque matrice indique son nombre de paires et de départs', () => {
    expect(m.gridToTurn1.nStarts).toBe(3);
    expect(m.gridToTurn1.nPairs).toBe(9);
    expect(m.gridToTurn1.from).toBe('gridPos');
    expect(m.gridToTurn1.to).toBe('turn1Pos');
  });
});

describe('matrices — un abandon n\'est jamais transformé en position', () => {
  it('exclut la paire dont l\'arrivée est inconnue', () => {
    const a = makeStart({ id: 'x', starters: 3, turn1: [1, 2, 3], finish: [1, 2, 3] });
    a.rows[2].finishPosInStart = null;          // DNF
    a.rows[2].finishStatus = 'DNF';
    const m = allMatrices(toRows([a]), 3);
    expect(m.gridToFinish.nPairs).toBe(2);      // la 3e paire est écartée
    expect(m.gridToTurn1.nPairs).toBe(3);       // mais son V1 reste exploitable
  });

  it('le DNF est compté à part, sans position fictive', () => {
    const a = makeStart({ id: 'x', starters: 3, turn1: [1, 2, 3] });
    a.rows[2].finishPosInStart = null;
    a.rows[2].finishStatus = 'DNF';
    const st = byGridPos(toRows([a]));
    expect(st[2].nDnf).toBe(1);
    expect(st[2].nFinished).toBe(0);
    expect(st[2].finishMean).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// ORDRE INCOMPLET
// ─────────────────────────────────────────────────────────

describe('orderCompleteness — ne jamais déduire les positions non vues', () => {
  const partiel = makeStart({ id: 'p', starters: 5, turn1: [1, 2, 3, null, null] });
  partiel.orderCompleteness = 'leaders_only';
  const complet = makeStart({ id: 'c', starters: 5, turn1: [1, 2, 3, 4, 5] });

  it('les positions certifiées d\'un départ partiel restent utilisables', () => {
    const rows = toRows([partiel]);
    expect(rows.filter(r => r.turn1Pos != null)).toHaveLength(3);
  });

  it('les positions non vues restent nulles, jamais devinées', () => {
    const rows = toRows([partiel]);
    expect(rows[3].turn1Pos).toBeNull();
    expect(rows[4].turn1Pos).toBeNull();
    expect(rows[3].gainToTurn1).toBeNull();
  });

  it('requireComplete écarte entièrement les départs partiels', () => {
    expect(toRows([partiel, complet])).toHaveLength(10);
    expect(toRows([partiel, complet], { requireComplete: true })).toHaveLength(5);
  });

  it('le nombre d\'observations issues de départs partiels est exposé', () => {
    const st = byGridPos(toRows([partiel, complet]));
    expect(st[0].nFromPartial).toBe(1);
    expect(summary([partiel, complet]).nFromPartial).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────
// SÉPARATION DES PHASES
// ─────────────────────────────────────────────────────────

describe('phaseGroupOf — manches et phases finales ne se mélangent pas', () => {
  it('classe les manches à part', () => {
    expect(phaseGroupOf('MQ')).toBe('MQ');
  });
  it('regroupe QF, DF et finale', () => {
    expect(phaseGroupOf('QF')).toBe('FINALS');
    expect(phaseGroupOf('DF')).toBe('FINALS');
    expect(phaseGroupOf('FIN')).toBe('FINALS');
  });
  it('classe le reste à part', () => {
    expect(phaseGroupOf('EC')).toBe('OTHER');
    expect(phaseGroupOf(null)).toBe('OTHER');
  });
});

describe('availableSizes', () => {
  it('liste les tailles de grille, la plus fréquente en tête', () => {
    const data = [
      makeStart({ id: 'a', starters: 5 }),
      makeStart({ id: 'b', starters: 5 }),
      makeStart({ id: 'c', starters: 3, turn1: [1, 2, 3] }),
    ];
    expect(availableSizes(data)).toEqual([
      { starters: 5, count: 2 }, { starters: 3, count: 1 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────
// byGridRow et corrélations
// ─────────────────────────────────────────────────────────

describe('byGridRow — utile en phases finales', () => {
  it('regroupe par ligne de grille', () => {
    const a = makeStart({ id: 'f', sessionType: 'DF', starters: 4, turn1: [1, 2, 3, 4] });
    a.rows[0].gridRow = 1; a.rows[1].gridRow = 1;
    a.rows[2].gridRow = 2; a.rows[3].gridRow = 2;
    const st = byGridRow(toRows([a]));
    expect(st.map(r => r.gridRow)).toEqual([1, 2]);
    expect(st[0].nObservations).toBe(2);
    expect(st[1].turn1Mean).toBe(3.5);
  });
});

describe('corrélations des trois transitions', () => {
  const a = makeStart({ id: 'a', turn1: [1, 2, 3, 4, 5], finish: [1, 2, 3, 4, 5] });
  const rows = toRows([a]);

  it('grille → V1', () => expect(gridVsTurn1(rows).rho).toBeCloseTo(1, 6));
  it('V1 → arrivée', () => expect(turn1VsFinish(rows).rho).toBeCloseTo(1, 6));
  it('grille → arrivée', () => expect(gridVsFinish(rows).rho).toBeCloseTo(1, 6));

  it('summary expose les trois', () => {
    const c = summary([a]).correlations;
    expect(Object.keys(c)).toEqual(['gridToTurn1', 'turn1ToFinish', 'gridToFinish']);
  });
});

describe('gains sur les trois transitions', () => {
  it('P4 → V1 P2 → arrivée P1 donne +2, +1 et +3', () => {
    const a = makeStart({ id: 'a', starters: 4, turn1: [4, 3, 1, 2], finish: [4, 3, 2, 1] });
    // le pilote parti P4 : V1 P2, arrivée P1
    const row = toRows([a]).find(r => r.gridPos === 4);
    expect(row.gainToTurn1).toBe(2);
    expect(row.gainTurn1ToFinish).toBe(1);
    expect(row.gainTotal).toBe(3);
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
