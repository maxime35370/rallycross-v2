import { describe, it, expect } from 'vitest';
import { mqPoints, ecBonusPoints, interimPoints } from '../js/calc.js';

// ─────────────────────────────────────────────────────────
// mqPoints
// ─────────────────────────────────────────────────────────

describe('mqPoints', () => {
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
// ecBonusPoints
// ─────────────────────────────────────────────────────────

describe('ecBonusPoints', () => {
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
// interimPoints
// ─────────────────────────────────────────────────────────

describe('interimPoints', () => {
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
