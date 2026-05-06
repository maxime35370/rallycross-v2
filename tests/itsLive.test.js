import { describe, it, expect } from 'vitest';
import { parseTimeFlex, parseStatusFlex } from '../js/providers/itsLive.js';

describe('itsLive · parseTimeFlex', () => {
  it('retourne null pour une valeur vide ou nulle', () => {
    expect(parseTimeFlex(null)).toBe(null);
    expect(parseTimeFlex(undefined)).toBe(null);
    expect(parseTimeFlex('')).toBe(null);
    expect(parseTimeFlex('   ')).toBe(null);
  });

  it('garde un nombre tel quel (arrondi)', () => {
    expect(parseTimeFlex(83456)).toBe(83456);
    expect(parseTimeFlex(83456.7)).toBe(83457);
  });

  it('rejette les nombres invalides', () => {
    expect(parseTimeFlex(0)).toBe(null);
    expect(parseTimeFlex(-100)).toBe(null);
    expect(parseTimeFlex(NaN)).toBe(null);
    expect(parseTimeFlex(Infinity)).toBe(null);
  });

  it('parse le format m:ss.mmm', () => {
    expect(parseTimeFlex('1:23.456')).toBe(83456);
    expect(parseTimeFlex('2:05.001')).toBe(125001);
    expect(parseTimeFlex('0:45.123')).toBe(45123);
  });

  it('parse avec virgule', () => {
    expect(parseTimeFlex('1:23,456')).toBe(83456);
    expect(parseTimeFlex('45,123')).toBe(45123);
  });

  it('parse le format ss.mmm', () => {
    expect(parseTimeFlex('45.123')).toBe(45123);
    expect(parseTimeFlex('59.999')).toBe(59999);
  });

  it('complète les millisecondes courtes', () => {
    expect(parseTimeFlex('1:23.4')).toBe(83400);
    expect(parseTimeFlex('1:23.45')).toBe(83450);
    expect(parseTimeFlex('45.4')).toBe(45400);
  });

  it('parse le format ISO 8601', () => {
    expect(parseTimeFlex('PT1M23.456S')).toBe(83456);
    expect(parseTimeFlex('PT45.123S')).toBe(45123);
    expect(parseTimeFlex('PT2M5.001S')).toBe(125001);
  });

  it('parse une chaîne d\'entiers comme ms', () => {
    expect(parseTimeFlex('83456')).toBe(83456);
  });

  it('rejette un format inconnu', () => {
    expect(parseTimeFlex('abc')).toBe(null);
    expect(parseTimeFlex('1:2:3.4')).toBe(null);
  });
});

describe('itsLive · parseStatusFlex', () => {
  it('retourne null pour une valeur vide', () => {
    expect(parseStatusFlex(null)).toBe(null);
    expect(parseStatusFlex('')).toBe(null);
  });

  it('reconnaît DNS', () => {
    expect(parseStatusFlex('DNS')).toBe('DNS');
    expect(parseStatusFlex('dns')).toBe('DNS');
    expect(parseStatusFlex('NOT_STARTED')).toBe('DNS');
    expect(parseStatusFlex('NOTSTART')).toBe('DNS');
  });

  it('reconnaît DNF', () => {
    expect(parseStatusFlex('DNF')).toBe('DNF');
    expect(parseStatusFlex('RETIRED')).toBe('DNF');
    expect(parseStatusFlex('OUT')).toBe('DNF');
    expect(parseStatusFlex('ABD')).toBe('DNF');
  });

  it('reconnaît DSQ', () => {
    expect(parseStatusFlex('DSQ')).toBe('DSQ');
    expect(parseStatusFlex('DISQUALIFIED')).toBe('DSQ');
    expect(parseStatusFlex('disqualified')).toBe('DSQ');
  });

  it('retourne null pour un statut inconnu (ex : OK, FINISHED)', () => {
    expect(parseStatusFlex('OK')).toBe(null);
    expect(parseStatusFlex('FINISHED')).toBe(null);
  });
});
