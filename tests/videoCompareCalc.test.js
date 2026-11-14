import { describe, it, expect } from 'vitest';
import { parseStartTime, formatStartTime, shiftedTime } from '../js/videoCompareCalc.js';

describe('parseStartTime', () => {
  it('lit les secondes, avec virgule ou point', () => {
    expect(parseStartTime('83')).toBe(83);
    expect(parseStartTime('83,5')).toBe(83.5);
    expect(parseStartTime('83.5')).toBe(83.5);
  });
  it('lit m:ss et h:mm:ss', () => {
    expect(parseStartTime('1:23')).toBe(83);
    expect(parseStartTime('1:23:45')).toBe(5025);
    expect(parseStartTime('1:23:45.5')).toBe(5025.5);
  });
  it('lit le format 1h2m3s', () => {
    expect(parseStartTime('1h2m3s')).toBe(3723);
    expect(parseStartTime('18m38s')).toBe(1118);
  });
  it('rejette ce qui est illisible', () => {
    expect(parseStartTime('')).toBeNull();
    expect(parseStartTime(null)).toBeNull();
    expect(parseStartTime('abc')).toBeNull();
    expect(parseStartTime('1:75')).toBeNull();
    expect(parseStartTime('1:2:3:4')).toBeNull();
  });
});

describe('formatStartTime', () => {
  it('formate avec dixième seulement si nécessaire', () => {
    expect(formatStartTime(0)).toBe('0:00');
    expect(formatStartTime(83)).toBe('1:23');
    expect(formatStartTime(83.5)).toBe('1:23.5');
    expect(formatStartTime(5025)).toBe('1:23:45');
  });
  it('reste cohérent avec parseStartTime', () => {
    for (const t of [0, 7.3, 83, 599.9, 3723.4]) {
      expect(parseStartTime(formatStartTime(t))).toBeCloseTo(t, 1);
    }
  });
});

describe('shiftedTime', () => {
  it('recule et avance du même delta', () => {
    expect(shiftedTime(100, -5)).toBe(95);
    expect(shiftedTime(100, 5)).toBe(105);
  });
  it('ne descend jamais sous zéro', () => {
    expect(shiftedTime(3, -5)).toBe(0);
    expect(shiftedTime(undefined, 2)).toBe(2);
  });
  it('arrondit au dixième', () => {
    expect(shiftedTime(1.0, 0.1)).toBe(1.1);
    expect(shiftedTime(0.3, 0.1)).toBe(0.4);
  });
});
