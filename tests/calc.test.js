import { describe, it, expect } from 'vitest';
import {
  mqPoints, ecBonusPoints, interimPoints, dfPoints, finPoints,
  calcPointsFromScale, calcStatusPoints, compareInterimTiebreaker,
} from '../js/calc.js';

// ─────────────────────────────────────────────────────────
// mqPoints (defaut FFSA 2026)
// ─────────────────────────────────────────────────────────

describe('mqPoints (default)', () => {
  it('returns 50 for position 1', () => {
    expect(mqPoints(1)).toBe(50);
  });

  it('returns 45 for position 2', () => {
    expect(mqPoints(2)).toBe(45);
  });

  it('returns 42 for position 3', () => {
    expect(mqPoints(3)).toBe(42);
  });

  it('returns 44 - position for positions >= 4', () => {
    expect(mqPoints(4)).toBe(40);
    expect(mqPoints(5)).toBe(39);
    expect(mqPoints(10)).toBe(34);
    expect(mqPoints(20)).toBe(24);
  });

  it('returns 0 when position makes formula negative', () => {
    expect(mqPoints(44)).toBe(0);
    expect(mqPoints(45)).toBe(0);
    expect(mqPoints(100)).toBe(0);
  });

  it('returns 0 for position <= 0', () => {
    expect(mqPoints(0)).toBe(0);
    expect(mqPoints(-1)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// ecBonusPoints (defaut FFSA 2026)
// ─────────────────────────────────────────────────────────

describe('ecBonusPoints (default)', () => {
  it('returns 5 for position 1', () => {
    expect(ecBonusPoints(1)).toBe(5);
  });

  it('returns 4 for position 2', () => {
    expect(ecBonusPoints(2)).toBe(4);
  });

  it('returns 1 for position 5', () => {
    expect(ecBonusPoints(5)).toBe(1);
  });

  it('returns 0 for position > 5', () => {
    expect(ecBonusPoints(6)).toBe(0);
    expect(ecBonusPoints(10)).toBe(0);
    expect(ecBonusPoints(100)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// interimPoints (defaut FFSA 2026)
// ─────────────────────────────────────────────────────────

describe('interimPoints (default)', () => {
  it('returns 16 for position 1', () => {
    expect(interimPoints(1)).toBe(16);
  });

  it('returns 15 for position 2', () => {
    expect(interimPoints(2)).toBe(15);
  });

  it('returns 1 for position 16', () => {
    expect(interimPoints(16)).toBe(1);
  });

  it('returns 0 for position 17', () => {
    expect(interimPoints(17)).toBe(0);
  });

  it('returns 0 for positions > 17', () => {
    expect(interimPoints(18)).toBe(0);
    expect(interimPoints(50)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// dfPoints / finPoints (defaut FFSA 2026)
// ─────────────────────────────────────────────────────────

describe('dfPoints (default)', () => {
  it('returns correct DF points', () => {
    expect(dfPoints(1)).toBe(10);
    expect(dfPoints(2)).toBe(8);
    expect(dfPoints(8)).toBe(1);
    expect(dfPoints(9)).toBe(0);
  });
});

describe('finPoints (default)', () => {
  it('returns correct FIN points', () => {
    expect(finPoints(1)).toBe(15);
    expect(finPoints(2)).toBe(12);
    expect(finPoints(8)).toBe(3);
    expect(finPoints(9)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// calcPointsFromScale (generique)
// ─────────────────────────────────────────────────────────

describe('calcPointsFromScale', () => {
  it('uses overrides when available', () => {
    const scale = { formula: '100 - position', overrides: { 1: 50, 2: 45 } };
    expect(calcPointsFromScale(1, scale)).toBe(50);
    expect(calcPointsFromScale(2, scale)).toBe(45);
  });

  it('falls back to formula when no override', () => {
    const scale = { formula: '100 - position', overrides: { 1: 50 } };
    expect(calcPointsFromScale(3, scale)).toBe(97);
    expect(calcPointsFromScale(10, scale)).toBe(90);
  });

  it('returns 0 for invalid position', () => {
    const scale = { formula: '10 - position', overrides: {} };
    expect(calcPointsFromScale(0, scale)).toBe(0);
    expect(calcPointsFromScale(-1, scale)).toBe(0);
  });

  it('returns 0 for null scale', () => {
    expect(calcPointsFromScale(1, null)).toBe(0);
  });

  it('clamps negative formula results to 0', () => {
    const scale = { formula: '5 - position', overrides: {} };
    expect(calcPointsFromScale(10, scale)).toBe(0);
  });

  it('handles override-only scales', () => {
    const scale = { formula: null, overrides: { 1: 25, 2: 18, 3: 15 } };
    expect(calcPointsFromScale(1, scale)).toBe(25);
    expect(calcPointsFromScale(3, scale)).toBe(15);
    expect(calcPointsFromScale(4, scale)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// calcStatusPoints
// ─────────────────────────────────────────────────────────

describe('calcStatusPoints', () => {
  it('returns 0 for DNS with default rules', () => {
    expect(calcStatusPoints('DNS', 'MQ', 20)).toBe(0);
  });

  it('returns 0 for DSQ with default rules', () => {
    expect(calcStatusPoints('DSQ', 'MQ', 20)).toBe(0);
  });

  it('calculates DNF with engaged_offset (default)', () => {
    // DNF default: engaged_offset=1 → points at position (totalEngaged + 1)
    // MQ formula: 44 - position → 44 - 21 = 23
    expect(calcStatusPoints('DNF', 'MQ', 20)).toBe(23);
  });

  it('uses custom regulation status rules', () => {
    const regulation = {
      pointsScale: {
        MQ: { formula: '50 - position', overrides: {} },
      },
      statusRules: {
        DNF: { mode: 'fixed', points: 5 },
        DNS: { mode: 'fixed', points: 0 },
      },
    };
    expect(calcStatusPoints('DNF', 'MQ', 20, regulation)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────
// Reglement custom (override du defaut)
// ─────────────────────────────────────────────────────────

describe('custom regulation', () => {
  const customReg = {
    pointsScale: {
      MQ: { formula: '30 - position', overrides: { 1: 60, 2: 50, 3: 45 } },
      DF: { formula: null, overrides: { 1: 20, 2: 15, 3: 10 } },
      FIN: { formula: null, overrides: { 1: 30, 2: 25 } },
    },
    statusRules: {
      DNF: { mode: 'fixed', points: 2 },
      DNS: { mode: 'fixed', points: 0 },
      DSQ_RACE: { mode: 'fixed', points: 1 },
      DSQ: { mode: 'fixed', points: 0 },
    },
  };

  it('mqPoints uses custom regulation', () => {
    expect(mqPoints(1, customReg)).toBe(60);
    expect(mqPoints(2, customReg)).toBe(50);
    expect(mqPoints(4, customReg)).toBe(26);  // 30 - 4
  });

  it('dfPoints uses custom regulation', () => {
    expect(dfPoints(1, customReg)).toBe(20);
    expect(dfPoints(3, customReg)).toBe(10);
    expect(dfPoints(4, customReg)).toBe(0);
  });

  it('finPoints uses custom regulation', () => {
    expect(finPoints(1, customReg)).toBe(30);
    expect(finPoints(2, customReg)).toBe(25);
    expect(finPoints(3, customReg)).toBe(0);
  });

  it('calcStatusPoints uses custom regulation', () => {
    expect(calcStatusPoints('DNF', 'MQ', 20, customReg)).toBe(2);
    expect(calcStatusPoints('DSQ_RACE', 'MQ', 20, customReg)).toBe(1);
  });
});

describe('compareInterimTiebreaker', () => {
  // Pilote A : MQ1 = 50000ms, MQ2 = 48000ms (best = MQ2)
  // Pilote B : MQ1 = 49000ms, MQ2 = 49500ms (best = MQ1)
  const pilotA = { mqMs: { 1: 50000, 2: 48000 } };
  const pilotB = { mqMs: { 1: 49000, 2: 49500 } };

  it('retourne 0 si aucun mode tiebreaker (defaut FFSA historique)', () => {
    expect(compareInterimTiebreaker(pilotA, pilotB, {}, [2, 1])).toBe(0);
    expect(compareInterimTiebreaker(pilotA, pilotB, null, [2, 1])).toBe(0);
  });

  it('mode best_overall_time : meilleur chrono absolu gagne', () => {
    const reg = { interimTiebreaker: 'best_overall_time' };
    // A best = 48000, B best = 49000 -> A gagne (devant)
    expect(compareInterimTiebreaker(pilotA, pilotB, reg, [2, 1])).toBeLessThan(0);
    expect(compareInterimTiebreaker(pilotB, pilotA, reg, [2, 1])).toBeGreaterThan(0);
  });

  it('mode last_manche_time : chrono de la derniere manche dispute compte', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    // MQ2 (la plus recente) : A = 48000, B = 49500 -> A gagne
    expect(compareInterimTiebreaker(pilotA, pilotB, reg, [2, 1])).toBeLessThan(0);
  });

  it('last_manche_time : si la derniere manche manque pour un, on remonte', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    const a = { mqMs: { 1: 50000 } };           // pas de MQ2
    const b = { mqMs: { 1: 51000, 2: 48000 } };
    // MQ2 : A absent → on regarde MQ1 : A=50000, B=51000 → A gagne
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
  });

  it('best_overall_time : pilote sans aucun chrono = Infinity (loose)', () => {
    const reg = { interimTiebreaker: 'best_overall_time' };
    const a = { mqMs: {} };
    const b = { mqMs: { 1: 50000 } };
    // a n'a pas de chrono → Infinity → b gagne (devant)
    expect(compareInterimTiebreaker(a, b, reg, [1])).toBeGreaterThan(0);
  });

  it('renvoie 0 si les deux n\'ont aucun chrono', () => {
    const reg = { interimTiebreaker: 'best_overall_time' };
    const a = { mqMs: {} };
    const b = { mqMs: {} };
    expect(compareInterimTiebreaker(a, b, reg, [1])).toBe(0);
  });

  it('gere les entrees malformees (null, undefined)', () => {
    const reg = { interimTiebreaker: 'best_overall_time' };
    expect(compareInterimTiebreaker(null, null, reg, [1])).toBe(0);
    expect(compareInterimTiebreaker({}, {}, reg, [1])).toBe(0);
  });
});
