/* ═══════════════════════════════════════════════
   STRATEGYMODEL.TEST.JS — Modèle de performance, résultat cible, backtest.

   Trois exigences y sont verrouillées :

     • le modèle ne doit PAS être trop sûr de lui. Avec huit meetings
       d'historique, une distribution étroite produirait des probabilités qui
       ont l'air précises et se trompent. La contraction vers la moyenne du
       plateau est donc testée pour ce qu'elle est : un garde-fou.

     • le résultat cible suit une règle ÉCRITE, pas une impression visuelle.
       La règle est testée sur l'exemple de référence et sur ses bords, et le
       seuil doit rester configurable.

     • le backtest doit pouvoir conclure CONTRE le Monte-Carlo. Le cas où le
       Monte-Carlo dégrade le score est testé explicitement : c'est celui qu'on
       serait tenté de ne pas gérer.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  latentFromPosition, collectRaceObservations, sourceOf, buildDriverModels,
  describeModel, SOURCE_IDS,
} from '../js/projection/driverPerformanceModel.js';
import {
  marginalGains, computeTargetResult, classifyStrategy, CLASSIFICATION_LABELS,
} from '../js/projection/strategyTargetCalculator.js';
import {
  brierScore, skillScore, accuracy, calibrationBins, evaluate, compareVerdict,
} from '../js/projection/qualificationBacktest.js';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import { makeOrderedMeeting, mergeFixtures, TEST_REGULATION } from './helpers/projectionFixtures.js';
import { TARGET } from '../js/projection/projectionConfig.js';

// ─────────────────────────────────────────────────────────
// FORCE LATENTE
// ─────────────────────────────────────────────────────────

describe('conversion place → force latente', () => {
  it('le milieu de plateau vaut zéro', () => {
    expect(latentFromPosition(3, 5)).toBeCloseTo(0, 6);
    expect(latentFromPosition(5, 9)).toBeCloseTo(0, 6);
  });

  it('devant est négatif, derrière est positif', () => {
    expect(latentFromPosition(1, 20)).toBeLessThan(0);
    expect(latentFromPosition(20, 20)).toBeGreaterThan(0);
  });

  it('rend comparables des plateaux de tailles différentes', () => {
    // 5e sur 30 et 2e sur 12 sont à peu près au même niveau relatif ;
    // 5e sur 8 ne l'est pas du tout.
    const petit = latentFromPosition(5, 8);
    const grand = latentFromPosition(5, 30);
    expect(grand).toBeLessThan(petit);
  });

  it('est monotone dans la taille du plateau', () => {
    for (let n = 5; n < 30; n++) {
      expect(latentFromPosition(1, n + 1)).toBeLessThan(latentFromPosition(1, n));
    }
  });

  it('refuse les entrées inexploitables', () => {
    expect(latentFromPosition(null, 10)).toBe(null);
    expect(latentFromPosition(1, 1)).toBe(null);
    expect(latentFromPosition(1, 0)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────
// SOURCES
// ─────────────────────────────────────────────────────────

describe('classement des sources', () => {
  const scope = { meetingId: 'M1', year: 2026, category: 'Cat1', circuit: 'Lieu' };

  it('la source la plus spécifique gagne', () => {
    expect(sourceOf({ meetingId: 'M1', year: 2026, category: 'Cat1', circuit: 'Lieu' }, scope)).toBe('currentMeeting');
    expect(sourceOf({ meetingId: 'M2', year: 2026, category: 'Cat1', circuit: 'X' }, scope)).toBe('currentSeason');
    expect(sourceOf({ meetingId: 'M2', year: 2025, category: 'Cat1', circuit: 'Lieu' }, scope)).toBe('sameCircuit');
    expect(sourceOf({ meetingId: 'M2', year: 2025, category: 'Cat2', circuit: 'X' }, scope)).toBe('overall');
  });

  it('une autre catégorie de la même saison n\'est pas « saison en cours »', () => {
    expect(sourceOf({ meetingId: 'M2', year: 2026, category: 'Cat2', circuit: 'X' }, scope)).toBe('overall');
  });

  it('l\'ordre de priorité est stable', () => {
    expect(SOURCE_IDS).toEqual(['currentMeeting', 'currentSeason', 'sameCircuit', 'overall']);
  });
});

describe('extraction des observations', () => {
  const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];
  const build = (id, date) => makeOrderedMeeting({
    id, drivers: SIX, phases: { DF: ['A', 'B'] },
    orders: { 1: SIX, 2: SIX, 3: SIX, 4: SIX },
    meeting: { date },
  });
  const contextsOf = (fixtures) => {
    const m = mergeFixtures(fixtures);
    return buildGroups({ sessions: m.sessions, results: m.results, participants: m.participants, meetings: m.meetings })
      .map(g => buildMeetingContext(g, TEST_REGULATION));
  };

  it('produit une observation par pilote et par manche courue', () => {
    const obs = collectRaceObservations(contextsOf([build('M1', '2026-05-01')]));
    expect(obs).toHaveLength(24);       // 6 pilotes × 4 manches
    expect(obs.every(o => o.latent != null)).toBe(true);
  });

  it('peut exclure un meeting entier', () => {
    const obs = collectRaceObservations(contextsOf([build('M1', '2026-05-01'), build('M2', '2026-06-01')]),
      { excludeMeetingId: 'M1' });
    expect(new Set(obs.map(o => o.meetingId))).toEqual(new Set(['M2']));
  });

  it('peut ne garder que les manches jusqu\'à un rang donné', () => {
    const obs = collectRaceObservations(contextsOf([build('M1', '2026-05-01')]), { maxRaceNum: 2 });
    expect(Math.max(...obs.map(o => o.raceNum))).toBe(2);
  });

  it('peut ne garder que les meetings antérieurs à une date', () => {
    const obs = collectRaceObservations(contextsOf([build('M1', '2026-05-01'), build('M2', '2026-06-01')]),
      { beforeDate: '2026-06-01' });
    expect(new Set(obs.map(o => o.meetingId))).toEqual(new Set(['M1']));
  });
});

// ─────────────────────────────────────────────────────────
// CONTRACTION
// ─────────────────────────────────────────────────────────

describe('contraction — le modèle ne doit pas être trop sûr de lui', () => {
  const obsFor = (driverId, positions, engaged = 20, meetingId = 'M1') =>
    positions.map((position, i) => ({
      driverId, raceNum: i + 1, meetingId, category: 'Cat1', championshipId: 'C1',
      year: 2026, circuit: 'Lieu', date: '2026-05-01', engagedCount: engaged,
      status: null, position, latent: latentFromPosition(position, engaged),
    }));

  const scope = { meetingId: 'M1', year: 2026, category: 'Cat1', circuit: 'Lieu' };

  it('un pilote peu observé est ramené vers le milieu de plateau', () => {
    const peu = buildDriverModels({ driverIds: ['X'], observations: obsFor('X', [1]), scope }).models.X;
    const beaucoup = buildDriverModels({
      driverIds: ['X'], observations: obsFor('X', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), scope,
    }).models.X;
    // Même performance moyenne, mais l'un est bien plus contracté que l'autre.
    expect(Math.abs(peu.mu)).toBeLessThan(Math.abs(beaucoup.mu));
    expect(peu.shrink).toBeLessThan(beaucoup.shrink);
    expect(peu.weaklyObserved).toBe(true);
    expect(beaucoup.weaklyObserved).toBe(false);
  });

  it('la contraction ne renverse jamais le sens de la performance', () => {
    const rapide = buildDriverModels({ driverIds: ['X'], observations: obsFor('X', [1, 2]), scope }).models.X;
    const lent = buildDriverModels({ driverIds: ['Y'], observations: obsFor('Y', [19, 20]), scope }).models.Y;
    expect(rapide.mu).toBeLessThan(0);
    expect(lent.mu).toBeGreaterThan(0);
    expect(rapide.mu).toBeLessThan(lent.mu);
  });

  it('un pilote peu observé reçoit une distribution PLUS LARGE, pas plus étroite', () => {
    const peu = buildDriverModels({ driverIds: ['X'], observations: obsFor('X', [5]), scope }).models.X;
    const beaucoup = buildDriverModels({
      driverIds: ['X'], observations: obsFor('X', [5, 5, 5, 5, 5, 5, 5, 5]), scope,
    }).models.X;
    expect(peu.sigma).toBeGreaterThan(beaucoup.sigma);
  });

  it('un pilote sans aucune observation reste au milieu, avec une large dispersion', () => {
    const m = buildDriverModels({ driverIds: ['Z'], observations: [], scope }).models.Z;
    expect(m.mu).toBe(0);
    expect(m.sigma).toBeGreaterThan(0.3);
    expect(m.races).toBe(0);
    expect(m.weaklyObserved).toBe(true);
  });

  it('le taux d\'incident est contracté vers le taux de plateau', () => {
    // Le plateau sert de référence : sans autres pilotes, la « moyenne du
    // plateau » serait celle du pilote lui-même et rien ne serait contracté.
    const plateau = ['P', 'Q', 'R', 'S'].flatMap(d => obsFor(d, [5, 5, 5, 5, 5]));
    const avecIncident = [
      ...plateau,
      ...obsFor('X', [5, 5]),
      { driverId: 'X', raceNum: 3, meetingId: 'M1', category: 'Cat1', year: 2026, circuit: 'Lieu',
        date: '2026-05-01', engagedCount: 20, status: 'DNF', position: null, latent: null },
    ];
    const { models, pooled } = buildDriverModels({ driverIds: ['X'], observations: avecIncident, scope });
    // Plateau : 1 incident sur 23 manches. Le pilote : 1 sur 3, soit 33 % brut.
    expect(pooled.incidentRate).toBeLessThan(0.1);
    expect(models.X.incidentRate).toBeLessThan(1 / 3);
    expect(models.X.incidentRate).toBeGreaterThan(pooled.incidentRate);
  });

  it('les sources utilisées sont exposées, pas cachées', () => {
    const m = buildDriverModels({ driverIds: ['X'], observations: obsFor('X', [1, 2, 3]), scope }).models.X;
    expect(m.sources.length).toBeGreaterThan(0);
    expect(m.sources[0]).toHaveProperty('label');
    expect(m.sources[0]).toHaveProperty('races');
    const described = describeModel(m);
    expect(described.some(([k]) => /Manches observées/.test(k))).toBe(true);
    expect(described.some(([k]) => /Contraction/.test(k))).toBe(true);
  });

  it('une source prioritaire mais vide ne prend pas le pas sur une source fournie', () => {
    // Aucune manche dans le meeting en cours, dix dans la saison : le modèle
    // doit s'appuyer sur ce qu'il a.
    const saison = obsFor('X', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 20, 'AUTRE');
    const m = buildDriverModels({ driverIds: ['X'], observations: saison, scope }).models.X;
    expect(m.mu).toBeLessThan(-0.5);
    expect(m.sources.find(s => s.id === 'currentSeason').races).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────
// RÉSULTAT CIBLE
// ─────────────────────────────────────────────────────────

describe('résultat cible — règle documentée', () => {
  /** Construit des entrées « et si » à partir d'un tableau place → probabilité. */
  const entries = (map) => Object.entries(map).map(([position, probability]) => ({
    kind: 'position', position: Number(position), probability, label: `P${position}`,
  }));

  it('reproduit l\'exemple de référence', () => {
    // P1 98 %, P5 97,5 %, P6 97 %, P7 96 %, P8 95 % avec τ = 1 pt/place.
    // G(8) = (98 − 95)/7 = 0,43 < 1 → la cible est bien P8.
    const t = computeTargetResult(entries({ 1: 0.98, 5: 0.975, 6: 0.97, 7: 0.96, 8: 0.95 }));
    expect(t.target).toBe(8);
    expect(t.targetLabel).toBe('P8');
    expect(t.averageGainAtTarget).toBeCloseTo(100 * (0.98 - 0.95) / 7, 6);
  });

  it('s\'arrête dès que le gain moyen atteint le seuil', () => {
    // P15 à 54 % : (100 − 54)/14 = 3,3 pt/place, très au-dessus de τ.
    const t = computeTargetResult(entries({ 1: 1.0, 5: 0.98, 10: 0.88, 15: 0.54 }));
    expect(t.target).toBeLessThan(15);
  });

  it('le seuil est configurable et change le résultat', () => {
    const e = entries({ 1: 0.98, 5: 0.975, 6: 0.97, 7: 0.96, 8: 0.95 });
    const strict = computeTargetResult(e, { thresholdPct: 0.1 });
    const large = computeTargetResult(e, { thresholdPct: 5 });
    expect(strict.target).toBeLessThan(large.target);
    expect(strict.thresholdPct).toBe(0.1);
  });

  it('utilise le seuil de la configuration par défaut', () => {
    const t = computeTargetResult(entries({ 1: 1, 2: 0.999 }));
    expect(t.thresholdPct).toBe(TARGET.diminishingReturnPctPerPosition);
  });

  it('la condition porte sur tout le préfixe : un creux isolé ne suffit pas', () => {
    // La zone P2–P3 coûte cher ; P10 ne peut donc pas être la cible même si
    // la moyenne y redevenait basse.
    const t = computeTargetResult(entries({ 1: 1.0, 2: 0.8, 3: 0.6, 10: 0.59 }));
    expect(t.target).toBe(1);
  });

  it('expose la règle appliquée, en toutes lettres', () => {
    const t = computeTargetResult(entries({ 1: 1, 2: 0.999 }));
    expect(t.rule).toMatch(/plus grande place/);
    expect(t.rule).toMatch(/point de pourcentage par place/);
  });

  it('la formulation reste descriptive', () => {
    const t = computeTargetResult(entries({ 1: 0.98, 5: 0.97, 8: 0.95, 20: 0.10 }));
    expect(t.regime).toBe('normal');
    expect(t.statement).toMatch(/gain estimé/);
    expect(t.statement).not.toMatch(/doit/);
  });

  it('une courbe plate ne dit pas « au-delà de la dernière place »', () => {
    // Toutes les places donnent 100 % : parler d'un « au-delà de P30 » alors
    // que P30 est la dernière place n'aurait aucun sens.
    const t = computeTargetResult(entries({ 1: 1, 10: 1, 20: 1, 30: 1 }));
    expect(t.regime).toBe('flat');
    expect(t.statement).toMatch(/reste stable/);
    expect(t.statement).not.toMatch(/Au-delà/);
  });

  it('une courbe très sensible le dit aussi explicitement', () => {
    const t = computeTargetResult(entries({ 1: 1.0, 2: 0.5, 3: 0.1 }));
    expect(t.regime).toBe('sensitive');
    expect(t.target).toBe(1);
    expect(t.statement).toMatch(/dès la première place/);
  });

  it('sans scénario exploitable, ne fabrique pas de cible', () => {
    const t = computeTargetResult([]);
    expect(t.target).toBe(null);
    expect(t.reason).toBeTruthy();
  });
});

describe('gains marginaux place par place', () => {
  it('donne le gain d\'une seule place, de la plus basse vers la meilleure', () => {
    const g = marginalGains([
      { kind: 'position', position: 1, probability: 1.0 },
      { kind: 'position', position: 2, probability: 0.96 },
      { kind: 'position', position: 3, probability: 0.90 },
    ]);
    expect(g[0]).toMatchObject({ from: 3, to: 2 });
    expect(g[0].gainPct).toBeCloseTo(6, 6);
    expect(g[1]).toMatchObject({ from: 2, to: 1 });
    expect(g[1].gainPct).toBeCloseTo(4, 6);
  });

  it('ignore les statuts et les probabilités manquantes', () => {
    const g = marginalGains([
      { kind: 'position', position: 1, probability: 1 },
      { kind: 'position', position: 2, probability: null },
      { kind: 'status', status: 'DNF', probability: 0.2 },
    ]);
    expect(g).toEqual([]);
  });
});

describe('classification stratégique', () => {
  const target = computeTargetResult([
    { kind: 'position', position: 1, probability: 0.99 },
    { kind: 'position', position: 10, probability: 0.98 },
  ]);

  it('VERT : probabilité haute et faible gain à mieux faire', () => {
    const c = classifyStrategy({ probability: 0.95, target });
    expect(c.id).toBe('green');
    expect(c.label).toBe('VERT');
    expect(c.reason).toBeTruthy();
  });

  it('ORANGE : la qualification dépend encore du résultat', () => {
    expect(classifyStrategy({ probability: 0.6, target }).id).toBe('orange');
  });

  it('ROUGE : probabilité basse', () => {
    expect(classifyStrategy({ probability: 0.2, target }).id).toBe('red');
  });

  it('les seuils sont configurables', () => {
    const c = classifyStrategy({ probability: 0.6, target, config: { green: { minProbability: 0.5, maxMarginalGainPct: 99 }, orange: { minProbability: 0.2 } } });
    expect(c.id).toBe('green');
  });

  it('sans probabilité, ne tranche pas', () => {
    expect(classifyStrategy({ probability: null }).id).toBe('orange');
  });

  it('les descriptions ne donnent pas de consigne de course', () => {
    for (const c of Object.values(CLASSIFICATION_LABELS)) {
      expect(c.description).not.toMatch(/doit|lever le pied|il suffit/i);
    }
  });
});

// ─────────────────────────────────────────────────────────
// MESURES DE BACKTEST
// ─────────────────────────────────────────────────────────

describe('mesures de backtest', () => {
  it('le Brier score récompense la justesse ET la prudence', () => {
    const parfait = [{ probability: 1, outcome: true }, { probability: 0, outcome: false }];
    const prudent = [{ probability: 0.5, outcome: true }, { probability: 0.5, outcome: false }];
    const faux = [{ probability: 0, outcome: true }, { probability: 1, outcome: false }];
    expect(brierScore(parfait)).toBe(0);
    expect(brierScore(prudent)).toBeCloseTo(0.25, 6);
    expect(brierScore(faux)).toBe(1);
  });

  it('ignore les prédictions absentes plutôt que de les compter comme nulles', () => {
    expect(brierScore([{ probability: null, outcome: true }, { probability: 1, outcome: true }])).toBe(0);
    expect(brierScore([])).toBe(null);
  });

  it('le score de compétence situe par rapport au prédicteur trivial', () => {
    expect(skillScore(0.05, 0.2)).toBeCloseTo(0.75, 6);
    expect(skillScore(0.2, 0.2)).toBe(0);
    expect(skillScore(0.4, 0.2)).toBeCloseTo(-1, 6);   // pire que trivial
    expect(skillScore(null, 0.2)).toBe(null);
  });

  it('la justesse dépend d\'un seuil de décision configurable', () => {
    const p = [{ probability: 0.6, outcome: true }, { probability: 0.6, outcome: false }];
    expect(accuracy(p, 0.5).rate).toBe(0.5);
    expect(accuracy(p, 0.7).rate).toBe(0.5);
    expect(accuracy(p, 0.5).decisionThreshold).toBe(0.5);
  });

  it('la calibration compare l\'annoncé au réalisé, tranche par tranche', () => {
    const preds = [
      ...Array.from({ length: 8 }, () => ({ probability: 0.75, outcome: true })),
      ...Array.from({ length: 2 }, () => ({ probability: 0.75, outcome: false })),
    ];
    const bins = calibrationBins(preds);
    const b = bins.find(x => x.n > 0);
    expect(b.label).toBe('70–80 %');
    expect(b.meanPredicted).toBeCloseTo(0.75, 6);
    expect(b.observedRate).toBeCloseTo(0.8, 6);
    expect(b.gap).toBeCloseTo(0.05, 6);
  });

  it('evaluate rassemble toutes les mesures et la couverture', () => {
    const e = evaluate([{ probability: 0.9, outcome: true }, { probability: null, outcome: false }], 0.25, 0.5);
    expect(e.n).toBe(1);
    expect(e.coverage).toBe(0.5);
    expect(e.brier).toBeCloseTo(0.01, 6);
    expect(e.skill).toBeGreaterThan(0);
    expect(e.calibration).toHaveLength(10);
  });
});

describe('verdict — il doit pouvoir être défavorable au Monte-Carlo', () => {
  it('annonce clairement une dégradation', () => {
    const v = compareVerdict(0.05, 0.09);
    expect(v.winner).toBe('historical');
    expect(v.label).toMatch(/DÉGRADE/);
    expect(v.label).toMatch(/historique reste l'estimateur principal/);
  });

  it('annonce une amélioration réelle', () => {
    const v = compareVerdict(0.09, 0.05);
    expect(v.winner).toBe('monteCarlo');
    expect(v.label).toMatch(/améliore/);
  });

  it('refuse de désigner un vainqueur sur un écart négligeable', () => {
    const v = compareVerdict(0.0500, 0.0502);
    expect(v.winner).toBe('tie');
    expect(v.label).toMatch(/non significatif/);
    expect(v.label).toMatch(/scénarios/);
  });

  it('le seuil d\'indécision est réglable', () => {
    expect(compareVerdict(0.05, 0.04, 0.05).winner).toBe('tie');
    expect(compareVerdict(0.05, 0.04, 0.001).winner).toBe('monteCarlo');
  });

  it('ne conclut pas quand un prédicteur manque', () => {
    expect(compareVerdict(null, 0.05).winner).toBe('unknown');
  });
});
