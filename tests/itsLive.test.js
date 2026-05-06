import { describe, it, expect } from 'vitest';
import {
  parseTimeFlex,
  parseStatusFlex,
  cleanCategoryName,
  deriveSessionType,
  deriveSessionNum,
} from '../js/providers/itsLive.js';

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

describe('itsLive · cleanCategoryName', () => {
  it('retire le préfixe numérique ITS', () => {
    expect(cleanCategoryName('06 - Supercar')).toBe('Supercar');
    expect(cleanCategoryName('05 - Super 1600')).toBe('Super 1600');
    expect(cleanCategoryName('01 - Division 4')).toBe('Division 4');
    expect(cleanCategoryName('00 - TEST')).toBe('TEST');
  });

  it('laisse intact un nom sans préfixe', () => {
    expect(cleanCategoryName('Supercar')).toBe('Supercar');
    expect(cleanCategoryName('Super 1600')).toBe('Super 1600');
  });

  it('gère les valeurs vides', () => {
    expect(cleanCategoryName('')).toBe('');
    expect(cleanCategoryName(null)).toBe('');
    expect(cleanCategoryName(undefined)).toBe('');
  });
});

describe('itsLive · deriveSessionType', () => {
  it('reconnaît FIN', () => {
    expect(deriveSessionType('Finale')).toBe('FIN');
    expect(deriveSessionType('Finale - Supercar Challenge')).toBe('FIN');
  });

  it('reconnaît DF', () => {
    expect(deriveSessionType('Demi-Finale A')).toBe('DF');
    expect(deriveSessionType('Demi-Finale B')).toBe('DF');
    expect(deriveSessionType('demi finale a')).toBe('DF');
  });

  it('reconnaît MQ', () => {
    expect(deriveSessionType('Manche 1')).toBe('MQ');
    expect(deriveSessionType('Manche 4')).toBe('MQ');
  });

  it('reconnaît EC (essais qualificatifs)', () => {
    expect(deriveSessionType('Essais Qualificatifs')).toBe('EC');
  });

  it('reconnaît EL (essais libres)', () => {
    expect(deriveSessionType('Essais Libres 1')).toBe('EL');
    expect(deriveSessionType('Essais Libres 2')).toBe('EL');
  });

  it('retourne vide pour les inconnus', () => {
    expect(deriveSessionType('TEST')).toBe('');
    expect(deriveSessionType('')).toBe('');
    expect(deriveSessionType(null)).toBe('');
  });
});

describe('itsLive · deriveSessionNum', () => {
  it('extrait le numéro de manche', () => {
    expect(deriveSessionNum('Manche 1', 'MQ')).toBe(1);
    expect(deriveSessionNum('Manche 4', 'MQ')).toBe(4);
  });

  it('mappe Demi-Finale A → 1, B → 2', () => {
    expect(deriveSessionNum('Demi-Finale A', 'DF')).toBe(1);
    expect(deriveSessionNum('Demi-Finale B', 'DF')).toBe(2);
  });

  it('extrait le numéro des essais libres', () => {
    expect(deriveSessionNum('Essais Libres 1', 'EL')).toBe(1);
    expect(deriveSessionNum('Essais Libres 2', 'EL')).toBe(2);
  });

  it('retourne null pour FIN/EC sans numéro', () => {
    expect(deriveSessionNum('Finale', 'FIN')).toBe(null);
    expect(deriveSessionNum('Essais Qualificatifs', 'EC')).toBe(null);
  });
});
