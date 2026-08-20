/* ═══════════════════════════════════════════════
   QUALIFICATIONHISTORY.TEST.JS — Statistiques historiques de qualification.

   Ces tests protègent trois promesses faites à l'utilisateur :
     1. un taux affiché est toujours accompagné de son effectif et de son
        niveau de confiance — un 80 % sur 5 cas ne doit jamais se présenter
        comme un 80 % sur 100 cas ;
     2. les tranches de points s'adaptent à l'échantillon au lieu d'imposer
        des pas de 5 points ;
     3. les cas triviaux (engagés <= places) n'entrent pas dans les taux.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  wilsonInterval, confidenceFor, rateStats, buildObservations,
  filterObservations, distinctValues, aggregateByGap, formatGap,
  adaptiveBuckets, aggregateByPoints, resultBucketOf, resultDistribution,
  conditionalQualificationByResult, selectComparables, buildHistoricalOutlook,
} from '../js/projection/qualificationHistory.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { MIN_CASES_TO_SHOW_RATE } from '../js/projection/projectionConfig.js';
import { makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';

// ─────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────

const CHAMPS = { champ_test: TEST_REGULATION };

/** Meeting à 6 pilotes, 4 manches, 2 places qualificatives (DF gridSize 2). */
function meetingWithOrders(id, orders, phases = { DF: ['A', 'B'] }, extra = {}) {
  return makeOrderedMeeting({
    id, orders, phases, drivers: ['A', 'B', 'C', 'D', 'E', 'F'],
    category: extra.category, championshipId: extra.championshipId,
    meeting: extra.meeting,
  });
}

function observationsOf(fixtures, options = {}) {
  const merged = mergeFixtures(fixtures);
  const groups = buildGroups({
    sessions: merged.sessions, results: merged.results,
    participants: merged.participants, meetings: merged.meetings,
  });
  const contexts = groups.map(g => buildMeetingContext(g, TEST_REGULATION));
  return buildObservations(contexts, { championshipsById: CHAMPS, ...options });
}

const SAME = ['A', 'B', 'C', 'D', 'E', 'F'];

// ─────────────────────────────────────────────────────────

describe('intervalle de Wilson', () => {
  it('encadre le taux observé', () => {
    const i = wilsonInterval(8, 10);
    expect(i.low).toBeLessThan(0.8);
    expect(i.high).toBeGreaterThan(0.8);
  });

  it('reste borné à [0, 1] même aux extrêmes', () => {
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(10, 10).high).toBe(1);
  });

  it('se resserre quand l\'effectif grandit — c\'est tout l\'enjeu', () => {
    expect(wilsonInterval(8, 10).width).toBeGreaterThan(wilsonInterval(80, 100).width);
    expect(wilsonInterval(800, 1000).width).toBeLessThan(0.05);
  });

  it('sans observation, l\'intervalle couvre tout', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1, width: 1 });
  });
});

describe('niveau de confiance', () => {
  it('effectif important et taux net → confiance élevée', () => {
    const c = confidenceFor(100, 80);
    expect(c.level).toBe('high');
    expect(c.showRate).toBe(true);
  });

  it('effectif faible → confiance faible et message explicite', () => {
    const c = confidenceFor(4, 3);
    expect(c.level).toBe('low');
    expect(c.showRate).toBe(false);
    expect(c.messages.join(' ')).toMatch(/Seulement 4 cas comparables/);
    expect(c.messages.join(' ')).toMatch(/Données insuffisantes/);
  });

  it('un 80 % sur 5 cas et un 80 % sur 100 cas ne se présentent pas pareil', () => {
    const petit = confidenceFor(5, 4);
    const grand = confidenceFor(100, 80);
    expect(petit.level).not.toBe(grand.level);
    expect(petit.interval.width).toBeGreaterThan(grand.interval.width);
  });

  it('effectif suffisant mais dispersion forte → rétrogradation d\'un cran', () => {
    // 30 cas atteignent le seuil « élevée », mais un taux à 50 % laisse un
    // intervalle large : la confiance retombe à « moyenne ».
    const c = confidenceFor(30, 15);
    expect(c.cases).toBe(30);
    expect(c.interval.width).toBeGreaterThan(0.30);
    expect(c.level).toBe('medium');
  });

  it('aucun cas : confiance faible, pas de taux', () => {
    const c = confidenceFor(0, 0);
    expect(c.level).toBe('low');
    expect(c.showRate).toBe(false);
  });

  it('le seuil d\'affichage du taux est celui de la configuration', () => {
    expect(confidenceFor(MIN_CASES_TO_SHOW_RATE, 1).showRate).toBe(true);
    expect(confidenceFor(MIN_CASES_TO_SHOW_RATE - 1, 1).showRate).toBe(false);
  });
});

describe('rateStats', () => {
  it('compte les qualifiés au sens de la règle', () => {
    const s = rateStats([
      { final: { qualifiedByRule: true } },
      { final: { qualifiedByRule: true } },
      { final: { qualifiedByRule: false } },
    ]);
    expect(s).toMatchObject({ n: 3, qualified: 2 });
    expect(s.rate).toBeCloseTo(2 / 3);
  });

  it('n\'utilise jamais qualifiedActual', () => {
    const s = rateStats([{ final: { qualifiedByRule: false, qualifiedActual: true } }]);
    expect(s.qualified).toBe(0);
  });

  it('sans cas, pas de taux inventé', () => {
    expect(rateStats([]).rate).toBe(null);
  });
});

describe('construction des observations', () => {
  const orders = { 1: SAME, 2: SAME, 3: SAME, 4: SAME };

  it('produit une ligne par pilote avec ses checkpoints', () => {
    const obs = observationsOf([meetingWithOrders('M1', orders)]);
    expect(obs).toHaveLength(6);
    const a = obs.find(o => o.driverId === 'A');
    expect(Object.keys(a.checkpoints).sort()).toEqual(['1', '2', '3']);
    expect(a.finalRace).toBe(4);
  });

  it('calcule l\'écart au seuil à chaque checkpoint', () => {
    const obs = observationsOf([meetingWithOrders('M1', orders)]);
    const a = obs.find(o => o.driverId === 'A');   // toujours 1er, seuil 2
    const c = obs.find(o => o.driverId === 'C');   // toujours 3e
    expect(a.threshold).toBe(2);
    expect(a.checkpoints[3].gap).toBe(-1);
    expect(c.checkpoints[3].gap).toBe(1);
    expect(a.final.qualifiedByRule).toBe(true);
    expect(c.final.qualifiedByRule).toBe(false);
  });

  it('renseigne qualifiedActual à partir des partants réels', () => {
    const obs = observationsOf([meetingWithOrders('M1', orders, { DF: ['A', 'C'] })]);
    const b = obs.find(o => o.driverId === 'B');
    const c = obs.find(o => o.driverId === 'C');
    // B est qualifié au sens de la règle mais absent : forfait.
    expect(b.final.qualifiedByRule).toBe(true);
    expect(b.final.qualifiedActual).toBe(false);
    // C est présent sans être classé qualifié : suppléant.
    expect(c.final.qualifiedByRule).toBe(false);
    expect(c.final.qualifiedActual).toBe(true);
  });

  it('ignore les meetings incomplets quand on exige la complétude', () => {
    const partiel = meetingWithOrders('M2', { 1: SAME, 2: SAME });
    // 2 manches seulement mais plannedRaces = 2 → complet de son point de vue
    expect(observationsOf([partiel]).length).toBe(6);
    // en revanche un meeting sans aucun résultat ne produit rien
    const vide = makeOrderedMeeting({ id: 'M3', orders: { 1: [] }, drivers: SAME });
    expect(observationsOf([vide]).length).toBe(0);
  });

  it('marque les cas triviaux quand tout le plateau tient dans les places', () => {
    const petit = makeOrderedMeeting({
      id: 'M4', drivers: ['A', 'B'],
      orders: { 1: ['A', 'B'], 2: ['A', 'B'], 3: ['A', 'B'], 4: ['A', 'B'] },
      phases: { DF: ['A', 'B'] },
    });
    const obs = observationsOf([petit]);
    expect(obs.every(o => o.trivial)).toBe(true);
  });

  it('conserve le résultat de chaque manche, statut compris', () => {
    const withDnf = makeOrderedMeeting({
      id: 'M5', drivers: SAME,
      orders: { 1: SAME, 2: SAME, 3: SAME, 4: ['B', 'C', 'D', 'E', 'F', { driver: 'A', status: 'DNF' }] },
      phases: { DF: ['A', 'B'] },
    });
    const a = observationsOf([withDnf]).find(o => o.driverId === 'A');
    expect(a.raceResults[4]).toMatchObject({ status: 'DNF', position: null });
    expect(a.raceResults[1]).toMatchObject({ status: null, position: 1 });
  });
});

describe('filtres', () => {
  const build = () => observationsOf([
    meetingWithOrders('M1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }, { DF: ['A', 'B'] }, { category: 'Cat1' }),
    makeOrderedMeeting({
      id: 'M2', drivers: ['A', 'B'], category: 'Cat2',
      orders: { 1: ['A', 'B'], 2: ['A', 'B'], 3: ['A', 'B'], 4: ['A', 'B'] },
      phases: { DF: ['A', 'B'] },
    }),
  ]);

  it('exclut les cas triviaux par défaut', () => {
    const all = build();
    expect(all.some(o => o.trivial)).toBe(true);
    expect(filterObservations(all).every(o => !o.trivial)).toBe(true);
  });

  it('peut les réintégrer explicitement pour l\'écran qualité des données', () => {
    const all = build();
    expect(filterObservations(all, { includeTrivial: true }).length).toBe(all.length);
  });

  it('filtre par catégorie', () => {
    const r = filterObservations(build(), { category: 'Cat1', includeTrivial: true });
    expect(new Set(r.map(o => o.category))).toEqual(new Set(['Cat1']));
  });

  it('filtre sur la présence d\'un checkpoint', () => {
    const r = filterObservations(build(), { checkpoint: 3 });
    expect(r.every(o => o.checkpoints[3])).toBe(true);
  });

  it('distinctValues alimente les sélecteurs', () => {
    expect(distinctValues(build(), 'category')).toEqual(['Cat1', 'Cat2']);
  });
});

describe('axe principal — écart de rang au seuil', () => {
  it('agrège par écart et fournit effectif + confiance', () => {
    const obs = observationsOf([
      meetingWithOrders('M1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }),
      meetingWithOrders('M2', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }),
    ]);
    const agg = aggregateByGap(filterObservations(obs), 3);
    const auSeuil = agg.rows.find(r => r.gap === 0);
    expect(auSeuil.n).toBe(2);                     // le 2e de chaque meeting
    expect(auSeuil.qualified).toBe(2);
    expect(auSeuil.confidence.showRate).toBe(false); // 2 cas : pas de taux affiché
    expect(agg.rows.map(r => r.gap)).toEqual([...agg.rows].map(r => r.gap).sort((a, b) => a - b));
  });

  it('libelle l\'écart de façon lisible', () => {
    expect(formatGap(0)).toBe('au seuil');
    expect(formatGap(-1)).toBe('-1 place');
    expect(formatGap(-2)).toBe('-2 places');
    expect(formatGap(1)).toBe('+1 place');
    expect(formatGap(3)).toBe('+3 places');
  });

  it('borne les écarts extrêmes sans les perdre', () => {
    const obs = observationsOf([meetingWithOrders('M1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME })]);
    const agg = aggregateByGap(filterObservations(obs), 3, { gapRange: { min: -1, max: 1 } });
    expect(Math.min(...agg.rows.map(r => r.gap))).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...agg.rows.map(r => r.gap))).toBeLessThanOrEqual(1);
    expect(agg.total).toBe(6);
    expect(agg.rows.some(r => r.clamped)).toBe(true);
  });

  it('annonce qu\'une tranche de bord agrège les écarts au-delà', () => {
    const obs = observationsOf([meetingWithOrders('M1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME })]);
    const agg = aggregateByGap(filterObservations(obs), 3, { gapRange: { min: -1, max: 1 } });
    // Le plateau va de -1 à +4 : seule la borne HAUTE agrège réellement
    // (+1 à +4). La borne basse ne regroupe rien et garde son libellé exact.
    const bas = agg.rows.find(r => r.gap === -1);
    const haut = agg.rows.find(r => r.gap === 1);
    expect(bas.clamped).toBe(false);
    expect(bas.label).toBe('-1 place');
    expect(haut.clamped).toBe(true);
    expect(haut.label).toBe('+1 place ou plus');
    // Une tranche non bornée garde son libellé exact.
    const exact = aggregateByGap(filterObservations(obs), 3).rows.find(r => r.gap === 0);
    expect(exact.label).toBe('au seuil');
    expect(exact.clamped).toBe(false);
  });
});

describe('tranches adaptatives', () => {
  it('fusionne les bacs tant que l\'effectif cible n\'est pas atteint', () => {
    // 3 valeurs seulement : tout doit tenir dans une seule tranche élargie.
    const b = adaptiveBuckets([100, 106, 112], { targetCases: 20, minWidth: 5, maxWidth: 40 });
    expect(b).toHaveLength(1);
    expect(b[0].count).toBe(3);
    expect(b[0].width).toBeGreaterThan(5);
  });

  it('garde des tranches fines quand l\'échantillon est dense', () => {
    const values = [];
    for (let i = 0; i < 100; i++) values.push(100 + (i % 5));      // tous dans 100-104
    for (let i = 0; i < 100; i++) values.push(105 + (i % 5));      // tous dans 105-109
    const b = adaptiveBuckets(values, { targetCases: 20, minWidth: 5, maxWidth: 40 });
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ min: 100, max: 105, count: 100 });
    expect(b[1]).toMatchObject({ min: 105, max: 110, count: 100 });
  });

  it('ne dépasse jamais la largeur maximale configurée', () => {
    const b = adaptiveBuckets([0, 200], { targetCases: 50, minWidth: 5, maxWidth: 20 });
    expect(b.every(x => x.width <= 20)).toBe(true);
  });

  it('rattache une tranche finale trop maigre à la précédente', () => {
    const values = [];
    for (let i = 0; i < 30; i++) values.push(100 + (i % 5));
    values.push(107);   // unique valeur isolée
    const b = adaptiveBuckets(values, { targetCases: 20, minWidth: 5, maxWidth: 40 });
    expect(b).toHaveLength(1);
    expect(b[0].count).toBe(31);
  });

  it('gère les entrées vides ou invalides', () => {
    expect(adaptiveBuckets([])).toEqual([]);
    expect(adaptiveBuckets([NaN, Infinity, null])).toEqual([]);
  });
});

describe('axe secondaire — points absolus', () => {
  const obs = () => observationsOf([
    meetingWithOrders('M1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }, { DF: ['A', 'B'] }, { category: 'Cat1' }),
  ]);

  it('refuse de se présenter comme comparable sans périmètre fixé', () => {
    const agg = aggregateByPoints(filterObservations(obs()), 3, { filters: {} });
    expect(agg.comparable).toBe(false);
    expect(agg.missingFilters).toEqual(['championshipId', 'category']);
    expect(agg.warning).toMatch(/barème/);
  });

  it('devient comparable une fois championnat et catégorie fixés', () => {
    const filters = { championshipId: 'champ_test', category: 'Cat1' };
    const agg = aggregateByPoints(filterObservations(obs(), filters), 3, { filters });
    expect(agg.comparable).toBe(true);
    expect(agg.warning).toBe(null);
    expect(agg.total).toBe(6);
    expect(agg.rows.reduce((n, r) => n + r.n, 0)).toBe(6);
  });

  it('chaque tranche porte son effectif et sa confiance', () => {
    const filters = { championshipId: 'champ_test', category: 'Cat1' };
    const agg = aggregateByPoints(filterObservations(obs(), filters), 3, { filters });
    for (const row of agg.rows) {
      expect(row).toHaveProperty('n');
      expect(row).toHaveProperty('confidence.level');
      expect(row.label).toMatch(/pts$/);
    }
  });
});

describe('résultats d\'une manche', () => {
  it('classe par statut avant de classer par position', () => {
    expect(resultBucketOf({ status: 'DNF', position: null }).id).toBe('out');
    expect(resultBucketOf({ status: 'DNS', position: null }).id).toBe('out');
    expect(resultBucketOf({ status: null, position: 2 }).id).toBe('p1_3');
    expect(resultBucketOf({ status: null, position: 9 }).id).toBe('p8_12');
    expect(resultBucketOf({ status: null, position: 30 }).id).toBe('p13');
    expect(resultBucketOf(null)).toBe(null);
  });

  it('un DNF ne doit jamais être compté comme un mauvais résultat chiffré', () => {
    // buildMqStandings place les DNF en engagés + 1 : sans la primauté du
    // statut, ils tomberaient dans « P13 et au-delà ».
    const dist = resultDistribution([
      { raceResults: { 4: { status: 'DNF', position: null } } },
      { raceResults: { 4: { status: null, position: 20 } } },
    ], 4);
    expect(dist.byBucket.find(b => b.id === 'out').n).toBe(1);
    expect(dist.byBucket.find(b => b.id === 'p13').n).toBe(1);
    expect(dist.withStatus).toBe(1);
  });

  it('donne médiane et moyenne des places, hors statuts', () => {
    const dist = resultDistribution([
      { raceResults: { 4: { status: null, position: 2 } } },
      { raceResults: { 4: { status: null, position: 4 } } },
      { raceResults: { 4: { status: null, position: 6 } } },
      { raceResults: { 4: { status: 'DNF', position: null } } },
    ], 4);
    expect(dist.total).toBe(4);
    expect(dist.classified).toBe(3);
    expect(dist.median).toBe(4);
    expect(dist.mean).toBeCloseTo(4);
  });

  it('taux de qualification conditionnel au résultat obtenu', () => {
    const cases = [
      { raceResults: { 4: { position: 1 } }, final: { qualifiedByRule: true } },
      { raceResults: { 4: { position: 2 } }, final: { qualifiedByRule: true } },
      { raceResults: { 4: { position: 15 } }, final: { qualifiedByRule: false } },
      { raceResults: { 4: { status: 'DNF' } }, final: { qualifiedByRule: false } },
    ];
    const cond = conditionalQualificationByResult(cases, 4);
    expect(cond.find(c => c.id === 'p1_3')).toMatchObject({ n: 2, qualified: 2, rate: 1 });
    expect(cond.find(c => c.id === 'p13')).toMatchObject({ n: 1, qualified: 0, rate: 0 });
    expect(cond.find(c => c.id === 'out')).toMatchObject({ n: 1, qualified: 0 });
    expect(cond.find(c => c.id === 'p4_7')).toMatchObject({ n: 0, rate: null });
  });
});

describe('sélection des cas comparables', () => {
  const obs = [
    { championshipId: 'C1', category: 'Cat1', checkpoints: { 3: { gap: 0 } }, final: { qualifiedByRule: true } },
    { championshipId: 'C1', category: 'Cat1', checkpoints: { 3: { gap: 0 } }, final: { qualifiedByRule: false } },
    { championshipId: 'C1', category: 'Cat2', checkpoints: { 3: { gap: 0 } }, final: { qualifiedByRule: true } },
    { championshipId: 'C2', category: 'Cat3', checkpoints: { 3: { gap: 0 } }, final: { qualifiedByRule: true } },
    { championshipId: 'C2', category: 'Cat3', checkpoints: { 3: { gap: 1 } }, final: { qualifiedByRule: false } },
  ];

  it('élargit le périmètre jusqu\'à atteindre un effectif exploitable', () => {
    const r = selectComparables(obs, { checkpoint: 3, gap: 0, championshipId: 'C1', category: 'Cat1' }, { minCases: 4 });
    expect(r.cases.length).toBeGreaterThanOrEqual(4);
    expect(r.widened).toBe(true);
    expect(r.strategy).not.toBe('exact');
  });

  it('reste au périmètre exact si l\'effectif suffit', () => {
    const r = selectComparables(obs, { checkpoint: 3, gap: 0, championshipId: 'C1', category: 'Cat1' }, { minCases: 2 });
    expect(r.strategy).toBe('exact');
    expect(r.widened).toBe(false);
    expect(r.cases).toHaveLength(2);
  });

  it('annonce toujours sur quoi le taux a été calculé', () => {
    const r = selectComparables(obs, { checkpoint: 3, gap: 0, championshipId: 'C1', category: 'Cat1' }, { minCases: 2 });
    expect(r.label).toMatch(/même championnat/);
    expect(r.tried.length).toBeGreaterThan(0);
    expect(r.tried[0]).toMatchObject({ id: 'exact' });
  });

  it('renvoie le périmètre le plus large quand rien ne suffit, sans le masquer', () => {
    const r = selectComparables(obs, { checkpoint: 3, gap: 0, championshipId: 'C1', category: 'Cat1' }, { minCases: 99 });
    expect(r.widened).toBe(true);
    expect(r.cases.length).toBe(5);   // tolérance ±1 place
  });

  it('sans écart connu, aucun cas comparable', () => {
    expect(selectComparables(obs, { checkpoint: 3, gap: null }).cases).toEqual([]);
  });
});

describe('lecture stratégique historique', () => {
  const build = () => {
    const fixtures = [];
    for (let i = 1; i <= 6; i++) {
      fixtures.push(meetingWithOrders(`M${i}`, { 1: SAME, 2: SAME, 3: SAME, 4: SAME }, { DF: ['A', 'B'] }, { category: 'Cat1' }));
    }
    return filterObservations(observationsOf(fixtures));
  };

  it('rapproche la situation courante de cas mesurés', () => {
    const out = buildHistoricalOutlook({
      observations: build(), checkpoint: 3, finalRace: 4,
      driver: { points: 24, position: 2, gap: 0 },
      filters: { championshipId: 'champ_test', category: 'Cat1' },
    });
    expect(out.comparable.n).toBe(6);
    expect(out.comparable.qualified).toBe(6);
    expect(out.comparable.rate).toBe(1);
    expect(out.comparable.strategy).toBe('exact');
  });

  it('décrit ce qu\'ont fait les cas comparables sur les manches restantes', () => {
    const out = buildHistoricalOutlook({
      observations: build(), checkpoint: 3, finalRace: 4,
      driver: { points: 24, position: 2, gap: 0 },
      filters: { championshipId: 'champ_test', category: 'Cat1' },
    });
    expect(out.remaining).toHaveLength(1);
    expect(out.remaining[0].raceNum).toBe(4);
    expect(out.remaining[0].distribution.total).toBe(6);
    expect(out.remaining[0].conditional.some(c => c.n > 0)).toBe(true);
  });

  it('couvre plusieurs manches restantes depuis un checkpoint précoce', () => {
    const out = buildHistoricalOutlook({
      observations: build(), checkpoint: 1, finalRace: 4,
      driver: { points: 9, position: 1, gap: -1 },
      filters: { championshipId: 'champ_test', category: 'Cat1' },
    });
    expect(out.remaining.map(r => r.raceNum)).toEqual([2, 3, 4]);
  });

  it('annonce l\'élargissement du périmètre quand il a lieu', () => {
    const out = buildHistoricalOutlook({
      observations: build(), checkpoint: 3, finalRace: 4,
      driver: { points: 24, position: 2, gap: 0 },
      filters: { championshipId: 'AUTRE', category: 'AUTRE' },
    });
    expect(out.comparable.widened).toBe(true);
    expect(out.messages.join(' ')).toMatch(/Périmètre élargi/);
  });

  it('signale explicitement un échantillon insuffisant', () => {
    // Deux meetings seulement, et la situation la plus extrême du plateau
    // (dernier, +4 places du seuil) : même après élargissement à ±1 place,
    // l'effectif reste sous le minimum d'affichage.
    const petit = filterObservations(observationsOf([
      meetingWithOrders('S1', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }, { DF: ['A', 'B'] }, { category: 'Cat1' }),
      meetingWithOrders('S2', { 1: SAME, 2: SAME, 3: SAME, 4: SAME }, { DF: ['A', 'B'] }, { category: 'Cat1' }),
    ]));
    const out = buildHistoricalOutlook({
      observations: petit, checkpoint: 3, finalRace: 4,
      driver: { points: 12, position: 6, gap: 4 },
      filters: { championshipId: 'champ_test', category: 'Cat1' },
    });
    expect(out.comparable.n).toBeLessThan(5);
    expect(out.comparable.confidence.showRate).toBe(false);
    expect(out.messages.join(' ')).toMatch(/Données insuffisantes/);
    expect(out.messages.join(' ')).toMatch(/Seulement \d+ cas comparable/);
  });
});
