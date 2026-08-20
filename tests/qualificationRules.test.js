/* ═══════════════════════════════════════════════
   QUALIFICATIONRULES.TEST.JS — Règles de qualification.

   Ce que ces tests protègent, et pourquoi :
     • le seuil de qualification n'est stocké NULLE PART ; il est déduit. Une
       erreur ici décale silencieusement toutes les probabilités du module ;
     • la distinction qualifiedByRule / qualifiedActual doit rester étanche :
       confondre les deux reviendrait à demander au modèle de prédire un
       forfait, et polluerait la calibration ;
     • un règlement non supporté doit BLOQUER la projection, jamais produire
       une probabilité approximative.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  checkRegulationSupport, thresholdFromRegulation, resolveQualificationThreshold,
  isQualifiedByRule, isTrivialQualification, gapToThreshold,
  compareQualificationLabels, describeDivergence, PHASE_ORDER,
} from '../js/projection/qualificationRules.js';
import { MESSAGES } from '../js/projection/projectionConfig.js';

const FFSA = {
  sessionConfig: {
    QF:  { enabled: false, count: 4, gridSize: 6 },
    DF:  { count: 2, gridSize: 8 },
    FIN: { gridSize: 8 },
  },
};
const EURO = {
  sessionConfig: {
    QF:  { enabled: true, count: 4, gridSize: 6 },
    DF:  { count: 2, gridSize: 6 },
    FIN: { gridSize: 6 },
  },
};

describe('support du règlement', () => {
  it('accepte un règlement sans règle exotique', () => {
    expect(checkRegulationSupport(FFSA).supported).toBe(true);
    expect(checkRegulationSupport(FFSA).message).toBe(null);
  });

  it('accepte worstResultDrop = 0 (valeur des championnats réels)', () => {
    expect(checkRegulationSupport({ ...FFSA, worstResultDrop: 0 }).supported).toBe(true);
  });

  it('BLOQUE worstResultDrop > 0 plutôt que de produire un chiffre faux', () => {
    const r = checkRegulationSupport({ ...FFSA, worstResultDrop: 1 });
    expect(r.supported).toBe(false);
    expect(r.message).toBe(MESSAGES.unsupportedRegulation);
    expect(r.reasons[0]).toMatch(/worstResultDrop/);
  });

  it('tolère un règlement absent', () => {
    expect(checkRegulationSupport(null).supported).toBe(true);
  });
});

describe('seuil issu du règlement', () => {
  it('FFSA sans quarts : 2 demi-finales × 8 = 16', () => {
    expect(thresholdFromRegulation(FFSA)).toEqual({ threshold: 16, phase: 'DF' });
  });

  it('Euro RX avec quarts : 4 × 6 = 24', () => {
    expect(thresholdFromRegulation(EURO)).toEqual({ threshold: 24, phase: 'QF' });
  });

  it('retombe sur la finale si ni quarts ni demies', () => {
    expect(thresholdFromRegulation({ sessionConfig: { FIN: { gridSize: 6 } } }))
      .toEqual({ threshold: 6, phase: 'FIN' });
  });

  it('renvoie null si le règlement ne dit rien', () => {
    expect(thresholdFromRegulation({}).threshold).toBe(null);
  });
});

describe('seuil effectif — l\'observation prime sur le règlement', () => {
  it('utilise les partants des quarts quand ils existent', () => {
    const r = resolveQualificationThreshold({
      regulation: EURO, observedPhaseCounts: { QF: 24, DF: 12, FIN: 6 }, engagedCount: 30,
    });
    expect(r).toMatchObject({ threshold: 24, source: 'observed', phase: 'QF' });
  });

  it('cas réel Euro RX RX3/RX5 : quarts vides, passage MQ→DF direct → seuil 12', () => {
    const r = resolveQualificationThreshold({
      regulation: EURO, observedPhaseCounts: { QF: 0, DF: 12, FIN: 6 }, engagedCount: 15,
    });
    expect(r).toMatchObject({ threshold: 12, source: 'observed', phase: 'DF' });
    expect(r.label).toMatch(/demi-finales/);
  });

  it('cas réel Euro RX RX4 : ni quarts ni demies, finale directe → seuil 6', () => {
    const r = resolveQualificationThreshold({
      regulation: EURO, observedPhaseCounts: { QF: 0, DF: 0, FIN: 6 }, engagedCount: 7,
    });
    expect(r).toMatchObject({ threshold: 6, source: 'observed', phase: 'FIN' });
  });

  it('meeting en cours (aucune phase finale peuplée) : retombe sur le règlement', () => {
    const r = resolveQualificationThreshold({
      regulation: FFSA, observedPhaseCounts: { QF: 0, DF: 0, FIN: 0 }, engagedCount: 23,
    });
    expect(r).toMatchObject({ threshold: 16, source: 'regulation', phase: 'DF' });
  });

  it('sans règlement exploitable : tous les engagés', () => {
    const r = resolveQualificationThreshold({ regulation: {}, observedPhaseCounts: {}, engagedCount: 9 });
    expect(r).toMatchObject({ threshold: 9, source: 'engaged' });
  });

  it('sans rien du tout : seuil inconnu, pas de valeur inventée', () => {
    expect(resolveQualificationThreshold({}).threshold).toBe(null);
  });

  it('respecte l\'ordre des phases QF → DF → FIN', () => {
    expect(PHASE_ORDER).toEqual(['QF', 'DF', 'FIN']);
  });
});

describe('qualification et écart au seuil', () => {
  it('qualifie jusqu\'au seuil inclus', () => {
    expect(isQualifiedByRule(16, 16)).toBe(true);
    expect(isQualifiedByRule(17, 16)).toBe(false);
    expect(isQualifiedByRule(1, 16)).toBe(true);
  });

  it('un pilote sans position n\'est pas qualifié', () => {
    expect(isQualifiedByRule(null, 16)).toBe(false);
    expect(isQualifiedByRule(3, null)).toBe(false);
  });

  it('l\'écart au seuil est négatif dans la zone qualificative', () => {
    expect(gapToThreshold(14, 16)).toBe(-2);
    expect(gapToThreshold(16, 16)).toBe(0);
    expect(gapToThreshold(17, 16)).toBe(1);
    expect(gapToThreshold(null, 16)).toBe(null);
  });
});

describe('cas triviaux', () => {
  it('7 engagés pour 16 places : qualification mécanique', () => {
    expect(isTrivialQualification(7, 16)).toBe(true);
  });

  it('exactement autant d\'engagés que de places : trivial aussi', () => {
    expect(isTrivialQualification(16, 16)).toBe(true);
  });

  it('23 engagés pour 16 places : pas trivial', () => {
    expect(isTrivialQualification(23, 16)).toBe(false);
  });

  it('sans seuil ni engagés : pas de conclusion', () => {
    expect(isTrivialQualification(0, 16)).toBe(false);
    expect(isTrivialQualification(10, null)).toBe(false);
  });
});

describe('qualifiedByRule vs qualifiedActual', () => {
  const standings = [
    { driverId: 'A', carNumber: 1, firstName: 'A', lastName: 'A', position: 1, totalPoints: 100 },
    { driverId: 'B', carNumber: 2, firstName: 'B', lastName: 'B', position: 2, totalPoints: 90 },
    { driverId: 'C', carNumber: 3, firstName: 'C', lastName: 'C', position: 3, totalPoints: 80 },
  ];

  it('sans données réelles, qualifiedActual reste null (pas false)', () => {
    const r = compareQualificationLabels({ standings, threshold: 2 });
    expect(r.hasActual).toBe(false);
    expect(r.byDriverId.A.qualifiedByRule).toBe(true);
    expect(r.byDriverId.A.qualifiedActual).toBe(null);
    expect(r.byDriverId.C.qualifiedByRule).toBe(false);
    expect(r.divergences).toEqual([]);
  });

  it('concordance parfaite : aucune divergence', () => {
    const r = compareQualificationLabels({ standings, threshold: 2, actualDriverIds: ['A', 'B'] });
    expect(r.divergences).toEqual([]);
    expect(r.byDriverId.B).toEqual({ qualifiedByRule: true, qualifiedActual: true });
  });

  it('forfait : classé qualifié mais absent de la phase suivante', () => {
    const r = compareQualificationLabels({ standings, threshold: 2, actualDriverIds: ['A', 'C'] });
    const kinds = r.divergences.map(d => d.kind).sort();
    expect(kinds).toEqual(['absent_de_la_phase_suivante', 'present_sans_etre_classe_qualifie']);
    const forfait = r.divergences.find(d => d.driverId === 'B');
    expect(forfait.qualifiedByRule).toBe(true);
    expect(forfait.qualifiedActual).toBe(false);
    expect(describeDivergence(forfait.kind)).toMatch(/forfait/i);
  });

  it('pilote présent en phase suivante mais absent du classement intermédiaire', () => {
    const r = compareQualificationLabels({ standings, threshold: 2, actualDriverIds: ['A', 'B', 'Z'] });
    const d = r.divergences.find(x => x.driverId === 'Z');
    expect(d.kind).toBe('present_sans_classement_intermediaire');
    expect(describeDivergence(d.kind)).toMatch(/manches classées/i);
  });

  it('un label ne contamine jamais l\'autre', () => {
    const r = compareQualificationLabels({ standings, threshold: 2, actualDriverIds: ['C'] });
    // A et B restent qualifiés AU SENS DE LA RÈGLE malgré leur absence réelle.
    expect(r.byDriverId.A.qualifiedByRule).toBe(true);
    expect(r.byDriverId.A.qualifiedActual).toBe(false);
    expect(r.byDriverId.C.qualifiedByRule).toBe(false);
    expect(r.byDriverId.C.qualifiedActual).toBe(true);
  });
});
