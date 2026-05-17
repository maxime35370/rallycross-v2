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

describe('compareInterimTiebreaker · last_manche_time (FFSA)', () => {
  it('retourne 0 si aucun mode tiebreaker (defaut historique)', () => {
    const a = { mqPos: { 1: 4, 2: 3 } };
    const b = { mqPos: { 1: 3, 2: 5 } };
    expect(compareInterimTiebreaker(a, b, {}, [2, 1])).toBe(0);
    expect(compareInterimTiebreaker(a, b, null, [2, 1])).toBe(0);
  });

  it('place de la derniere manche disputee departage', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    // MQ2 (la plus recente) : A = 3e, B = 5e -> A devant
    const a = { mqPos: { 1: 8, 2: 3 } };
    const b = { mqPos: { 1: 2, 2: 5 } };
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
  });

  it('un DNF en derniere manche reste derriere un finisseur de cette manche', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    // MQ2 : A finisseur 5e, B classe DNF (place engaged+1 = 20).
    // Meme si B etait meilleur en MQ1, A passe devant grace a sa MQ2 finie.
    const a = { mqPos: { 1: 8, 2: 5 } };
    const b = { mqPos: { 1: 2, 2: 20 } };
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
    expect(compareInterimTiebreaker(b, a, reg, [2, 1])).toBeGreaterThan(0);
  });

  it('si la derniere manche est ex aequo, on remonte a la precedente', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    // MQ2 : A et B tous deux DNF (place 20) -> on regarde MQ1
    const a = { mqPos: { 1: 4, 2: 20 } };
    const b = { mqPos: { 1: 9, 2: 20 } };
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
  });

  it('un pilote classe passe devant un pilote sans resultat sur la manche', () => {
    const reg = { interimTiebreaker: 'last_manche_time' };
    const a = { mqPos: { 1: 5, 2: 7 } };
    const b = { mqPos: { 1: 3 } }; // pas de resultat MQ2
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
  });
});

describe('compareInterimTiebreaker · best_positions_then_time (FIA / Euro RX)', () => {
  const reg = { interimTiebreaker: 'best_positions_then_time' };

  it('exemple utilisateur : A=[1,7,8] vs B=[1,6,9] → B gagne sur la 2e meilleure', () => {
    // Trie ascendant : A=[1,7,8], B=[1,6,9]
    // Pos1 : 1=1 (tie). Pos2 : A=7 vs B=6 → B gagne
    const a = { mqPos: { 1: 1, 2: 7, 3: 8 } };
    const b = { mqPos: { 1: 6, 2: 1, 3: 9 } };
    expect(compareInterimTiebreaker(a, b, reg, [3, 2, 1])).toBeGreaterThan(0);
    expect(compareInterimTiebreaker(b, a, reg, [3, 2, 1])).toBeLessThan(0);
  });

  it('cas reel Baumanis vs Trepak : positions identiques → chrono dernier MQ', () => {
    // Cas reel observe : Baumanis 6e (73 pts) vs Trepak 7e (73 pts).
    // Baumanis : MQ1 9e (35 pts) / 3:23.180, MQ2 6e (38 pts) / 3:22.988
    // Trepak   : MQ1 6e (38 pts) / 3:20.591, MQ2 9e (35 pts) / 3:24.425
    // Trie : Baumanis [6, 9], Trepak [6, 9] → identiques → fallback chrono.
    // Best absolu : Trepak (3:20.591) MAIS Trepak est 7e (derriere) !
    // Best MQ2 (la plus recente) : Baumanis 3:22.988 < Trepak 3:24.425
    //   → Baumanis devant Trepak : MATCH avec le classement officiel.
    const baumanis = {
      mqPos: { 1: 9, 2: 6 },
      mqMs:  { 1: 203180, 2: 202988 },
    };
    const trepak = {
      mqPos: { 1: 6, 2: 9 },
      mqMs:  { 1: 200591, 2: 204425 },
    };
    expect(compareInterimTiebreaker(baumanis, trepak, reg, [2, 1])).toBeLessThan(0);
    expect(compareInterimTiebreaker(trepak, baumanis, reg, [2, 1])).toBeGreaterThan(0);
  });

  it('A=[1,2,3] vs B=[1,2,4] → A gagne sur la 3e position', () => {
    const a = { mqPos: { 1: 1, 2: 2, 3: 3 } };
    const b = { mqPos: { 1: 1, 2: 2, 3: 4 } };
    expect(compareInterimTiebreaker(a, b, reg, [3, 2, 1])).toBeLessThan(0);
  });

  it('positions toutes egales → fallback sur chrono de la derniere manche', () => {
    // Cas reel observe : Jansson 9e vs Baciuska 10e (69 pts chacun).
    // Tous deux ont [8, 11] (l'un 11e en MQ1 8e en MQ2, l'autre 8e en MQ1
    // 11e en MQ2). Le classement officiel place Jansson devant Baciuska.
    // Verification : MQ2 (la plus recente) chrono Jansson = 3:24.071,
    // Baciuska = 3:26.117 → Jansson gagne (chrono dernier MQ).
    const jansson  = {
      mqPos: { 1: 11, 2: 8 },
      mqMs:  { 1: 203564, 2: 204071 }, // 3:23.564 / 3:24.071
    };
    const baciuska = {
      mqPos: { 1: 8, 2: 11 },
      mqMs:  { 1: 202451, 2: 206117 }, // 3:22.451 / 3:26.117
    };
    // Positions triees identiques [8, 11] vs [8, 11] → fallback chrono
    // Best absolute serait Baciuska (3:22.451) mais la regle FIA dit
    // "chrono dernier MQ" → MQ2 : Jansson 204071 < Baciuska 206117
    // → Jansson devant Baciuska
    expect(compareInterimTiebreaker(jansson, baciuska, reg, [2, 1])).toBeLessThan(0);
    expect(compareInterimTiebreaker(baciuska, jansson, reg, [2, 1])).toBeGreaterThan(0);
  });

  it('fallback chrono : si la derniere manche manque, on remonte', () => {
    const a = { mqPos: { 1: 1, 2: 2 }, mqMs: { 1: 50000 } };
    const b = { mqPos: { 1: 1, 2: 2 }, mqMs: { 1: 51000, 2: 49000 } };
    // Positions tied [1,2] vs [1,2]. MQ2 : A absent → MQ1 : A=50000 < B=51000 → A gagne
    expect(compareInterimTiebreaker(a, b, reg, [2, 1])).toBeLessThan(0);
  });

  it('un pilote a moins de positions (DNF) → l\'autre gagne sur la position manquante', () => {
    const a = { mqPos: { 1: 1, 2: 2, 3: 3 } };
    const b = { mqPos: { 1: 1, 2: 2 } }; // pas de pos en MQ3 (DNF par exemple)
    // Trie : A=[1,2,3], B=[1,2]
    // Pos1=1=1, Pos2=2=2, Pos3 : A=3 vs B=Infinity → A gagne
    expect(compareInterimTiebreaker(a, b, reg, [3, 2, 1])).toBeLessThan(0);
  });

  it('alias best_overall_time → meme comportement que best_positions_then_time', () => {
    const aliasReg = { interimTiebreaker: 'best_overall_time' };
    const a = { mqPos: { 1: 1, 2: 7, 3: 8 } };
    const b = { mqPos: { 1: 6, 2: 1, 3: 9 } };
    expect(compareInterimTiebreaker(a, b, aliasReg, [3, 2, 1])).toBeGreaterThan(0);
  });

  it('aucune position et aucun chrono → 0 (vraiment ex aequo)', () => {
    const a = { mqPos: {}, mqMs: {} };
    const b = { mqPos: {}, mqMs: {} };
    expect(compareInterimTiebreaker(a, b, reg, [1])).toBe(0);
  });

  it('ignore les positions null/undefined dans la collecte', () => {
    const a = { mqPos: { 1: 1, 2: null, 3: 5 } };
    const b = { mqPos: { 1: 2, 2: 3, 3: null } };
    // A filtre/trie : [1, 5] ; B filtre/trie : [2, 3]
    // Pos1 : 1 vs 2 → A gagne
    expect(compareInterimTiebreaker(a, b, reg, [3, 2, 1])).toBeLessThan(0);
  });

  it('gere les entrees malformees (null, undefined)', () => {
    expect(compareInterimTiebreaker(null, null, reg, [1])).toBe(0);
    expect(compareInterimTiebreaker({}, {}, reg, [1])).toBe(0);
  });
});
