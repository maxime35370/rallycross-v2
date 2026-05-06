import { describe, it, expect } from 'vitest';
import {
  parseTimeFlex,
  parseStatusFlex,
  cleanCategoryName,
  deriveSessionType,
  deriveSessionNum,
  parseRanking,
  computeGrid,
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

describe('itsLive · parseRanking', () => {
  // Réponse API ITS Live réelle (extrait simplifié — Lessay 2026 MQ1 Supercar).
  const fixture = {
    boa: [null, 29295, 13474],
    ranking: [
      {
        data_id: 1731,
        number: '27',
        pos: 1,
        total_lap: 4,
        driver_names: ['DUBOURG Jean Baptiste', '', '', '', '', '', '', '', '', null],
        best_time: 37794,
        best_time_lap: 3,
        lap_time: 43276,
        time_accuracy: 162154,
        status: 0,
      },
      {
        data_id: 1732,
        number: '21',
        pos: 2,
        total_lap: 4,
        driver_names: ['MEUNIER Damien', '', '', '', '', '', '', '', '', null],
        best_time: 38267,
        time_accuracy: 164524,
        status: 0,
      },
      {
        data_id: 1744,
        number: '77',
        pos: 14,
        total_lap: 0,
        driver_names: ['TOHILL Derek', '', '', '', '', '', '', '', '', null],
        best_time: null,
        lap_time: 0,
        time_accuracy: 4248,
        gap_first: '4 Tr.',
        is_last: 1,
        status: 0,
      },
    ],
  };

  it('extrait le temps total de course depuis time_accuracy (pas best_time)', () => {
    const rows = parseRanking(fixture);
    expect(rows[0].carNumber).toBe(27);
    expect(rows[0].time_ms).toBe(162154);  // 2:42.154 — temps total
    expect(rows[0].time_ms).not.toBe(37794); // pas le best_time
    expect(rows[1].time_ms).toBe(164524);
  });

  it('extrait le nombre de tours dans total_lap', () => {
    const rows = parseRanking(fixture);
    expect(rows[0].total_lap).toBe(4);
    expect(rows[1].total_lap).toBe(4);
    expect(rows[2].total_lap).toBe(0);
  });

  it('parse les noms depuis driver_names ("NOM Prenom" → split)', () => {
    const rows = parseRanking(fixture);
    expect(rows[0].lastName).toBe('DUBOURG');
    expect(rows[0].firstName).toBe('Jean Baptiste');
    expect(rows[1].lastName).toBe('MEUNIER');
    expect(rows[1].firstName).toBe('Damien');
  });

  it('renvoie le payload même quand le pilote est DNF (pas de filtrage ici)', () => {
    const rows = parseRanking(fixture);
    expect(rows).toHaveLength(3);
    expect(rows[2].carNumber).toBe(77);
    expect(rows[2].total_lap).toBe(0);
  });

  it('gère un payload vide', () => {
    expect(parseRanking({})).toEqual([]);
    expect(parseRanking({ ranking: [] })).toEqual([]);
    expect(parseRanking(null)).toEqual([]);
  });

  it('priorité firstName/lastName explicites sur driver_names', () => {
    const rows = parseRanking({
      ranking: [{ number: '1', firstName: 'Foo', lastName: 'Bar', driver_names: ['BAZ Qux'] }],
    });
    expect(rows[0].firstName).toBe('Foo');
    expect(rows[0].lastName).toBe('Bar');
  });

  it('expose cat et starting_pos pour la grille', () => {
    const rows = parseRanking({
      ranking: [{ number: '27', cat: 'Série 3', starting_pos: 10 }],
    });
    expect(rows[0].cat).toBe('Série 3');
    expect(rows[0].starting_pos).toBe(10);
  });
});

describe('itsLive · computeGrid', () => {
  // Fixture issue de la vraie réponse Lessay 2026 MQ1 Supercar (extrait)
  const rows = [
    { carNumber: 1,  cat: 'Série 1', starting_pos: 1  }, // Jeanney
    { carNumber: 19, cat: 'Série 1', starting_pos: 2  }, // Lambec
    { carNumber: 11, cat: 'Série 1', starting_pos: 3  }, // Remaud
    { carNumber: 10, cat: 'Série 1', starting_pos: 4  }, // Paillardon
    { carNumber: 4,  cat: 'Série 2', starting_pos: 5  }, // Vincent
    { carNumber: 60, cat: 'Série 2', starting_pos: 6  }, // Knapick
    { carNumber: 14, cat: 'Série 2', starting_pos: 7  }, // Moinel
    { carNumber: 18, cat: 'Série 2', starting_pos: 8  }, // De Ganay
    { carNumber: 43, cat: 'Série 2', starting_pos: 9  }, // Terroitin
    { carNumber: 27, cat: 'Série 3', starting_pos: 10 }, // Dubourg
    { carNumber: 21, cat: 'Série 3', starting_pos: 11 }, // Meunier
    { carNumber: 17, cat: 'Série 3', starting_pos: 12 }, // Clairay
    { carNumber: 12, cat: 'Série 3', starting_pos: 13 }, // Le Manac'h
    { carNumber: 77, cat: 'Série 3', starting_pos: 14 }, // Tohill
  ];

  it('regroupe par série et numérote les couloirs 1..N selon starting_pos', () => {
    const grid = computeGrid(rows);
    expect(grid.get(1)).toEqual({ serie: 1, couloir: 1 });
    expect(grid.get(10)).toEqual({ serie: 1, couloir: 4 });
    expect(grid.get(4)).toEqual({ serie: 2, couloir: 1 });
    expect(grid.get(43)).toEqual({ serie: 2, couloir: 5 });
    expect(grid.get(27)).toEqual({ serie: 3, couloir: 1 });
    expect(grid.get(77)).toEqual({ serie: 3, couloir: 5 });
  });

  it('trie correctement quand starting_pos n\'est pas séquentiel dans cat', () => {
    const grid = computeGrid([
      { carNumber: 99, cat: 'Série 1', starting_pos: 14 },
      { carNumber: 88, cat: 'Série 1', starting_pos: 1  },
    ]);
    expect(grid.get(88)).toEqual({ serie: 1, couloir: 1 });
    expect(grid.get(99)).toEqual({ serie: 1, couloir: 2 });
  });

  it('ignore les lignes sans cat ou starting_pos', () => {
    const grid = computeGrid([
      { carNumber: 1, cat: null, starting_pos: 1 },
      { carNumber: 2, cat: 'Série 1', starting_pos: null },
      { carNumber: 3, cat: 'Série 1', starting_pos: 5 },
    ]);
    expect(grid.has(1)).toBe(false);
    expect(grid.has(2)).toBe(false);
    expect(grid.get(3)).toEqual({ serie: 1, couloir: 1 });
  });

  it('retourne une Map vide si rows est vide ou nul', () => {
    expect(computeGrid([]).size).toBe(0);
    expect(computeGrid(null).size).toBe(0);
    expect(computeGrid(undefined).size).toBe(0);
  });
});
