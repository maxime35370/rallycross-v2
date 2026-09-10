/* ═══════════════════════════════════════════════
   CHAMPIONSHIPCHART.TEST.JS — Le graphique « évolution du top 5 sur le
   week-end » doit suivre le règlement, pas une liste de phases codée en dur.

   Deux règlements coexistent en base : FFSA (points dès le classement
   intermédiaire, puis ½ finale et finale) et FIA (aucun point intermédiaire,
   mais des ¼ de finale). Un graphique qui afficherait toujours les quatre
   phases mentirait sur l'un des deux : une colonne « ¼ finale » à 0 pour
   tout le monde en FFSA, ou une colonne « Interm. » vide en FIA.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  weekendPhases, buildWeekendEvolution, defaultChartMeetingId,
  renderWeekendChartSvg, renderWeekendChartTable, chartGeometry,
} from '../js/championshipChart.js';

const FFSA = { interimPointsEnabled: true,  sessionConfig: { QF: { enabled: false } } };
const FIA  = { interimPointsEnabled: false, sessionConfig: { QF: { enabled: true } }, competitionPhases: ['MQ', 'QF', 'DF', 'FIN'] };

const MEETINGS = [
  { id: 'm1', date: '2026-04-12', location: 'Lessay' },
  { id: 'm2', date: '2026-05-03', location: 'Châteauroux' },
  { id: 'm3', date: '2026-06-14', location: 'Faleyras' },
];

/** Pilote du classement saison tel que produit par calcChampionship(). */
function driver(id, num, perMeeting, penalty = 0) {
  const meetingPts = {}, meetingDetail = {};
  for (const [mid, det] of Object.entries(perMeeting)) {
    const full = { interim: 0, qf: 0, df: 0, fin: 0, ...det };
    full.total = full.interim + full.qf + full.df + full.fin;
    meetingPts[mid]    = full.total;
    meetingDetail[mid] = full;
  }
  const grandTotal = Object.values(meetingPts).reduce((s, v) => s + v, 0) - penalty;
  return { driverId: id, carNumber: num, firstName: 'P', lastName: id.toUpperCase(), meetingPts, meetingDetail, penalty, grandTotal };
}

const STANDINGS = [
  driver('a', 1, { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 15, df: 8, fin: 12 } }),
  driver('b', 2, { m1: { interim: 15, df: 8,  fin: 12 }, m2: { interim: 16, df: 10, fin: 15 } }, 5),
  driver('c', 3, { m1: { interim: 14, df: 6,  fin: 9  }, m2: { interim: 14, df: 6,  fin: 9  } }),
  driver('d', 4, { m1: { interim: 16, df: 10, fin: 15 } }),                       // absent du m2
  driver('e', 5, { m1: { interim: 12, df: 4,  fin: 6  }, m2: { interim: 8, df: 2, fin: 3 } }),
  driver('f', 6, { m1: { interim: 11, df: 3,  fin: 5  }, m2: { interim: 7, df: 2, fin: 3 } }),
  driver('g', 7, { m2: { interim: 11, df: 3,  fin: 5  } }),
].sort((x, y) => y.grandTotal - x.grandTotal);

describe('weekendPhases — les phases à points suivent le règlement', () => {
  it('FFSA : intermédiaire → ½ finale → finale, sans ¼', () => {
    expect(weekendPhases(FFSA)).toEqual(['interim', 'df', 'fin']);
  });

  it('FIA : ¼ → ½ → finale, sans points intermédiaires', () => {
    expect(weekendPhases(FIA)).toEqual(['qf', 'df', 'fin']);
  });

  it('sans règlement, le barème FFSA par défaut s\'applique (comme calc.js)', () => {
    expect(weekendPhases(null)).toEqual(['interim', 'df', 'fin']);
  });

  it('une phase où quelqu\'un a marqué est affichée même si la config la désactive', () => {
    expect(weekendPhases(FFSA, [{ qf: 4 }])).toEqual(['interim', 'qf', 'df', 'fin']);
    expect(weekendPhases(FIA,  [{ interim: 3 }])).toEqual(['interim', 'qf', 'df', 'fin']);
  });
});

describe('buildWeekendEvolution — courbes du top 5', () => {
  it('meeting inconnu → null', () => {
    expect(buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'zz' })).toBeNull();
  });

  it('mode saison : le départ est le total AVANT le meeting, pénalités déduites', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm2', regulation: FFSA });
    expect(data.labels).toEqual(['Avant', 'Interm.', '½ finale', 'Finale']);
    const b = data.series.find(s => s.driverId === 'b');
    expect(b.start).toBe(35 - 5);                  // 15+8+12 au m1, −5 de pénalité
    expect(b.values).toEqual([30, 46, 56, 71]);
    expect(b.gains).toEqual([16, 10, 15]);
    // Le point d'arrivée du dernier meeting = total du tableau
    expect(b.end).toBe(b.values.at(-1));
    expect(b.end).toBe(STANDINGS.find(d => d.driverId === 'b').grandTotal);
  });

  it('mode saison : un absent reste dans le top 5 avec une courbe plate', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm2', regulation: FFSA });
    const d = data.series.find(s => s.driverId === 'd');
    expect(d).toBeDefined();
    expect(d.present).toBe(false);
    expect(d.values).toEqual([41, 41, 41, 41]);
  });

  it('mode week-end : départ à 0 et seuls les présents comptent', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm2', regulation: FFSA, mode: 'meeting' });
    expect(data.labels[0]).toBe('Départ');
    expect(data.series.every(s => s.start === 0 && s.present)).toBe(true);
    expect(data.series.map(s => s.driverId)).toEqual(['b', 'a', 'c', 'g', 'e']);
    expect(data.series[0].values).toEqual([0, 16, 26, 41]);
  });

  it('top 5 = les 5 meilleurs à l\'arrivée, avec un slot de couleur stable', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm2', regulation: FFSA });
    expect(data.series).toHaveLength(5);
    const ends = data.series.map(s => s.end);
    expect([...ends].sort((x, y) => y - x)).toEqual(ends);
    expect(data.series.map(s => s.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it('premier meeting : chacun part de 0, moins sa pénalité saison (le total du tableau reste la référence)', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm1', regulation: FFSA });
    data.series.forEach(s => expect(s.start).toBe(s.driverId === 'b' ? -5 : 0));
    expect(data.minY).toBe(-5);
  });

  it('FIA : la colonne ¼ finale apparaît, l\'intermédiaire non', () => {
    const fia = [
      driver('x', 1, { m1: { qf: 8, df: 10, fin: 15 } }),
      driver('y', 2, { m1: { qf: 6, df: 8,  fin: 12 } }),
    ];
    const data = buildWeekendEvolution({ standings: fia, meetings: MEETINGS, meetingId: 'm1', regulation: FIA });
    expect(data.labels).toEqual(['Avant', '¼ finale', '½ finale', 'Finale']);
    expect(data.series[0].values).toEqual([0, 8, 18, 33]);
  });

  it('meeting sans aucun point → aucune série présente', () => {
    const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm3', regulation: FFSA, mode: 'meeting' });
    expect(data.series).toEqual([]);
  });
});

describe('defaultChartMeetingId', () => {
  it('propose le meeting le plus récent où des points ont été marqués', () => {
    expect(defaultChartMeetingId(STANDINGS, MEETINGS)).toBe('m2');
  });
  it('sans aucun point, retombe sur le dernier meeting', () => {
    expect(defaultChartMeetingId([], MEETINGS)).toBe('m3');
    expect(defaultChartMeetingId([], [])).toBeNull();
  });
});

describe('rendu — SVG et tableau', () => {
  const data = buildWeekendEvolution({ standings: STANDINGS, meetings: MEETINGS, meetingId: 'm2', regulation: FFSA });

  it('une courbe par pilote, un point par étape', () => {
    const svg = renderWeekendChartSvg(data);
    expect(svg.match(/<polyline/g)).toHaveLength(5);
    expect(svg.match(/<circle/g)).toHaveLength(5 * 4);
    expect(svg).toContain('Interm.');
  });

  it('les libellés de fin de courbe ne se chevauchent pas', () => {
    const svg = renderWeekendChartSvg(data);
    const ys = [...svg.matchAll(/class="chp-evo-endlabel" dominant-baseline="middle"/g)].length;
    expect(ys).toBe(5);
    const yVals = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" class="chp-evo-endlabel"/g)]
      .map(m => parseFloat(m[1])).sort((a, b) => a - b);
    for (let i = 1; i < yVals.length; i++) expect(yVals[i] - yVals[i - 1]).toBeGreaterThanOrEqual(12 - 1e-6);
  });

  it('la vue table reprend chaque valeur cumulée et chaque gain', () => {
    const html = renderWeekendChartTable(data);
    expect(html.match(/<tr>/g).length).toBe(1 + 5);
    expect(html).toContain('>71<');
    expect(html).toContain('+15');
    expect(html).toContain('absent');
  });

  it('la géométrie tient dans le tracé', () => {
    const g = chartGeometry(data);
    expect(g.xs).toHaveLength(4);
    expect(g.toY(g.yMax)).toBeCloseTo(g.pad.top);
    expect(g.toY(g.yMin)).toBeCloseTo(250 - g.pad.bottom);
  });
});
