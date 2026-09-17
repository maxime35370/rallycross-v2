/* ═══════════════════════════════════════════════
   CHAMPIONSHIPTITLE.TEST.JS — Les scénarios de titre ne promettent que ce
   qui tient dans le pire des cas.

   Le piège classique : annoncer un champion trop tôt (en oubliant une phase
   du barème, ou en comptant un meeting en cours comme terminé), ou au
   contraire laisser « en course » un pilote qui ne peut plus revenir. Les
   cas ci-dessous fixent l'arithmétique sur le barème FFSA par défaut
   (16 + 10 + 15 = 41 points par meeting) et sur un règlement FIA avec ¼ de
   finale, puis vérifient les seuils exacts : un point de plus ou de moins
   doit faire basculer le verdict.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  maxMeetingPoints, guaranteeTiers, slotPosition, idealScenario, splitMeetings,
  buildTitleScenarios, renderTitleScenarios,
} from '../js/championshipTitle.js';

const FFSA = { interimPointsEnabled: true, sessionConfig: { QF: { enabled: false } } };
const FIA  = {
  interimPointsEnabled: false,
  sessionConfig: { QF: { enabled: true } },
  competitionPhases: ['MQ', 'QF', 'DF', 'FIN'],
  pointsScale: {
    QF:  { formula: null, overrides: { 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1 } },
    DF:  { formula: null, overrides: { 1: 6, 2: 5, 3: 4, 4: 3, 5: 2, 6: 1 } },
    FIN: { formula: null, overrides: { 1: 8, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3 } },
  },
};

const MEETINGS = [
  { id: 'm1', date: '2026-04-12', location: 'Lessay' },
  { id: 'm2', date: '2026-05-03', location: 'Châteauroux' },
  { id: 'm3', date: '2026-06-14', location: 'Faleyras' },
  { id: 'm4', date: '2026-08-30', location: 'Lohéac' },
];

/** Pilote du classement saison tel que produit par calcChampionship(). */
function driver(id, perMeeting, penalty = 0) {
  const meetingPts = {}, meetingDetail = {};
  for (const [mid, det] of Object.entries(perMeeting)) {
    const full = { interim: 0, qf: 0, df: 0, fin: 0, ...det };
    full.total = full.interim + full.qf + full.df + full.fin;
    meetingPts[mid]    = full.total;
    meetingDetail[mid] = full;
  }
  const grandTotal = Object.values(meetingPts).reduce((s, v) => s + v, 0) - penalty;
  return { driverId: id, carNumber: id.length, firstName: 'P', lastName: id.toUpperCase(), meetingPts, meetingDetail, penalty, grandTotal };
}

/** Classement trié et positionné, avec un total saison imposé par pilote. */
function standingsWithTotals(totals, playedMeetings = ['m1', 'm2']) {
  const rows = Object.entries(totals).map(([id, total]) => {
    // Répartit le total sur les meetings joués : seul le total compte ici,
    // mais la finale du dernier meeting doit avoir marqué (meeting terminé).
    const per = {};
    playedMeetings.forEach((mid, i) => {
      per[mid] = i === playedMeetings.length - 1 ? { fin: total } : { fin: 1 };
    });
    const d = driver(id, per);
    d.grandTotal = total;
    return d;
  }).sort((a, b) => b.grandTotal - a.grandTotal);
  let pos = 1;
  rows.forEach((d, i) => {
    d.position = i > 0 && d.grandTotal === rows[i - 1].grandTotal ? rows[i - 1].position : pos;
    pos = i + 2;
  });
  return rows;
}

// ─────────────────────────────────────────────────────────

describe('maxMeetingPoints — le maximum par meeting suit le barème', () => {
  it('FFSA : intermédiaire 16 + ½ finale 10 + finale 15 = 41', () => {
    const r = maxMeetingPoints(FFSA);
    expect(r.total).toBe(41);
    expect(r.phases.map(p => [p.key, p.max])).toEqual([['interim', 16], ['df', 10], ['fin', 15]]);
  });

  it('FIA : pas de points intermédiaires, mais les ¼ de finale comptent', () => {
    const r = maxMeetingPoints(FIA);
    expect(r.phases.map(p => p.key)).toEqual(['qf', 'df', 'fin']);
    expect(r.total).toBe(6 + 6 + 8);
  });

  it('sans règlement : barème FFSA par défaut', () => {
    expect(maxMeetingPoints(null).total).toBe(41);
  });

  it('phases couplées : intermédiaire et finale ; les ½ finales sont indépendantes (deux courses)', () => {
    const r = maxMeetingPoints(FFSA);
    const by = k => r.phases.find(p => p.key === k);
    expect(by('interim').coupled).toBe(true);
    expect(by('interim').delta).toBe(1);      // 16 − 15
    expect(by('fin').coupled).toBe(true);
    expect(by('fin').delta).toBe(3);          // 15 − 12
    expect(by('df').coupled).toBe(false);     // chacun peut gagner sa ½ finale
    expect(by('df').delta).toBe(0);
    expect(r.guaranteedSwing).toBe(4);        // en gagnant tout, +4 garantis seulement
  });

  it('une seule ½ finale au règlement → phase couplée', () => {
    const r = maxMeetingPoints({ ...FFSA, sessionConfig: { QF: { enabled: false }, DF: { count: 1 } } });
    expect(r.phases.find(p => p.key === 'df').delta).toBe(2);   // 10 − 8
    expect(r.guaranteedSwing).toBe(6);
  });

  it('FIA : ¼ et ½ finales indépendantes, seule la finale est couplée', () => {
    const r = maxMeetingPoints(FIA);
    expect(r.phases.map(p => p.delta)).toEqual([0, 0, 1]);
  });
});

describe('guaranteeTiers — ce que les seuls résultats du leader garantissent', () => {
  const PM = maxMeetingPoints(FFSA);

  it('marge confortable : un simple score suffit, les paliers avec victoire n\'apportent rien', () => {
    // need −38 : marquer 3 suffit (le rival prend 41 au pire). Gagner la
    // finale exigerait déjà 15 points : palier inutile, non retenu.
    expect(guaranteeTiers(-38, PM)).toEqual([{ wins: [], score: 3, winsSuffice: false }]);
  });

  it('need 2 : aucun score seul ne suffit, il faut gagner la finale (rival au mieux 2e)', () => {
    const t = guaranteeTiers(2, PM);
    expect(t).toEqual([
      { wins: ['fin'],            score: 40, winsSuffice: false },   // 2 + (41 − 3)
      { wins: ['fin', 'interim'], score: 39, winsSuffice: false },   // 2 + (41 − 4)
    ]);
  });

  it('need 4 : seul le grand chelem le sacre à lui seul ; need 5 : rien', () => {
    expect(guaranteeTiers(4, PM)).toEqual([{ wins: ['fin', 'interim'], score: 41, winsSuffice: false }]);
    expect(guaranteeTiers(5, PM)).toEqual([]);
  });

  it('need très négatif : gagner la finale suffit sans autre condition', () => {
    // need −26 : score seul = 15 ; gagner la finale : raw −26 + 38 = 12 ≤ 15
    // → « gagner la finale suffit », mais 15 ≥ 15 n\'abaisse pas le seuil : non retenu.
    expect(guaranteeTiers(-26, PM)).toEqual([{ wins: [], score: 15, winsSuffice: false }]);
    // need −27 : score seul = 14 ; la victoire en finale (15) n\'abaisse pas non plus.
    expect(guaranteeTiers(-27, PM)).toEqual([{ wins: [], score: 14, winsSuffice: false }]);
    // need −24 : marquer 17, OU gagner la finale (le rival prend alors 38 au
    // plus : −24 + 38 = 14 ≤ 15, la victoire suffit d\'elle-même).
    expect(guaranteeTiers(-24, PM)).toEqual([
      { wins: [],      score: 17, winsSuffice: false },
      { wins: ['fin'], score: 15, winsSuffice: true },
    ]);
  });
});

describe('idealScenario — les places d\'un meeting se partagent entre prétendants', () => {
  const PM = maxMeetingPoints(FFSA);
  const C = [
    { driverId: 'a', firstName: 'P', lastName: 'A', points: 100 },
    { driverId: 'b', firstName: 'P', lastName: 'B', points: 90 },
    { driverId: 'c', firstName: 'P', lastName: 'C', points: 80 },
    { driverId: 'd', firstName: 'P', lastName: 'D', points: 70 },
  ];

  it('une course : P1, P2, P3… ; deux courses : P1, P1, P2, P2…', () => {
    expect([0, 1, 2, 3].map(k => slotPosition(k, 1))).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2, 3].map(k => slotPosition(k, 2))).toEqual([1, 1, 2, 2]);
    expect([0, 1, 2, 3, 4].map(k => slotPosition(k, 4))).toEqual([1, 1, 1, 1, 2]);
  });

  it('quatre prétendants : un seul vainqueur de finale, deux vainqueurs de ½ finale', () => {
    const sc = idealScenario(0, C, PM, 1);
    const pts = Object.fromEntries(sc.rows.map(r => [r.driverId, r.meetingPts]));
    // a : 16 + 10 + 15 ; b : P2 interm. 15, gagne l'autre ½ 10, P2 finale 12 ;
    // c : 14 + 8 (2e de ½) + 9 ; d : 13 + 8 + 7.
    expect(pts).toEqual({ a: 41, b: 37, c: 31, d: 28 });
    expect(sc.rows.map(r => r.driverId)).toEqual(['a', 'b', 'c', 'd']);
    expect(sc.rows[1].places.map(p => p.pos)).toEqual([2, 1, 2]);
    expect(sc.rows[2].places.map(p => p.pos)).toEqual([3, 2, 3]);
  });

  it('le scénario idéal du 3e : il gagne tout, le leader prend les places suivantes', () => {
    const sc = idealScenario(2, C, PM, 1);
    expect(sc.rows.map(r => r.driverId)).toEqual(['c', 'a', 'b', 'd']);
    // c : 80 + 41 = 121 ; a : 100 + 37 = 137 → toujours 2e après le meeting, à −16.
    expect(sc.next).toEqual({ total: 121, rank: 2, gap: -16, clinched: false });
    // Répété sur 2 meetings : c 162 contre a 174 → pas champion même en gagnant tout.
    expect(sc.season.total).toBe(162);
    expect(sc.season.gap).toBe(-12);
    expect(sc.season.champion).toBe(false);
    expect(sc.season.rank).toBe(2);
  });

  it('le scénario idéal du leader : sacré au prochain meeting s\'il repart avec plus que le reste', () => {
    // a 100 → 141, b 90 → 127 : +14 pour 41 encore en jeu ensuite → pas sacré.
    expect(idealScenario(0, C, PM, 1).next.clinched).toBe(false);
    // Dernier meeting : +14 > 0 → sacré, champion.
    const last = idealScenario(0, C, PM, 0);
    expect(last.next.clinched).toBe(true);
    expect(last.season.champion).toBe(true);
    expect(last.season.gap).toBe(14);
  });

  it('seul prétendant : rang 1 sans écart', () => {
    const sc = idealScenario(0, [C[0]], PM, 2);
    expect(sc.next).toEqual({ total: 141, rank: 1, gap: null, clinched: true });
  });

  it('seul le top 4 d\'une ½ finale marque en finale : au-delà de 8 prétendants, pas de place en finale', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ driverId: 'd' + i, firstName: 'P', lastName: 'D' + i, points: 100 - i }));
    const sc = idealScenario(0, many, PM, 0);
    // 9e pilote (index 8) : 5e de sa ½ finale → non qualifié, finale sans place ni point.
    expect(sc.rows[8].places.map(pl => pl.pos)).toEqual([9, 5, null]);
    expect(sc.rows[8].meetingPts).toBe(8 + 4);
    // 8e pilote (index 7) : 4e de sa ½ → qualifié, 8e de la finale.
    expect(sc.rows[7].places.map(pl => pl.pos)).toEqual([8, 4, 8]);
  });

  it('meeting en cours après les ½ finales : un pilote non qualifié n\'a pas de place en finale', () => {
    const finOnly = PM.phases.filter(ph => ph.key === 'fin');
    const cs = [
      { ...C[0], stepKeys: ['fin'] },
      { ...C[1], stepKeys: [] },        // éliminé en ½ finale
      { ...C[2], stepKeys: ['fin'] },
    ];
    const sc = idealScenario(2, cs, PM, 0, finOnly);
    expect(sc.rows.map(r => [r.driverId, r.places[0].pos, r.meetingPts])).toEqual([['c', 1, 15], ['a', 2, 12], ['b', null, 0]]);
  });

  it('meeting en cours : seules les phases restantes se partagent, puis les meetings complets', () => {
    const dfFin = PM.phases.filter(ph => ph.key !== 'interim');
    const sc = idealScenario(0, C, PM, 1, dfFin);
    // a gagne sa ½ (10) et la finale (15) ; b gagne l'autre ½ (10), 2e de finale (12).
    expect(sc.rows[0].meetingPts).toBe(25);
    expect(sc.rows[1].meetingPts).toBe(22);
    expect(sc.next.total).toBe(125);
    // Puis un meeting complet : a +41, b +37.
    expect(sc.season.total).toBe(166);
    expect(sc.season.gap).toBe(166 - (90 + 22 + 37));
  });
});

describe('splitMeetings — restants, en cours, terminés', () => {
  it('sépare selon les points déjà attribués', () => {
    const standings = [
      driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 14 } }),
      driver('b', { m1: { interim: 15, df: 8,  fin: 12 } }),
    ];
    const r = splitMeetings(standings, MEETINGS);
    expect(r.played.map(m => m.id)).toEqual(['m1']);
    expect(r.inProgress.map(m => m.id)).toEqual(['m2']);
    expect(r.inProgress[0].scoredPhases).toEqual(['interim']);
    expect(r.remaining.map(m => m.id)).toEqual(['m3', 'm4']);
  });
});

describe('buildTitleScenarios — seuils exacts (FFSA, 41 pts par meeting)', () => {
  it('2 meetings restants : 82 points en jeu', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 50 }), meetings: MEETINGS, regulation: FFSA });
    expect(s.remaining.map(m => m.id)).toEqual(['m3', 'm4']);
    expect(s.pointsLeft).toBe(82);
    expect(s.gap).toBe(50);
    expect(s.status).toBe('open');
  });

  it('avance de 83 pour 82 en jeu : champion ; 82 : peut seulement être égalé ; 81 : ouvert', () => {
    const at = gap => buildTitleScenarios({ standings: standingsWithTotals({ a: 100 + gap, b: 100 }), meetings: MEETINGS, regulation: FFSA }).status;
    expect(at(83)).toBe('clinched');
    expect(at(82)).toBe('clinched_tie');
    expect(at(81)).toBe('open');
  });

  it('un poursuivant est éliminé dès que son maximum est sous le total du leader', () => {
    // 82 en jeu : c (17) plafonne à 99 < 100 → éliminé ; d (18) peut égaler ; e (19) peut dépasser.
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 90, c: 17, d: 18, e: 19 }), meetings: MEETINGS, regulation: FFSA });
    const by = id => s.drivers.find(d => d.driverId === id);
    expect(by('c').state).toBe('eliminated');
    expect(by('c').maxReachable).toBe(99);
    expect(by('d').state).toBe('tie_only');
    expect(by('e').state).toBe('contender');
    expect(by('e').toOvertake).toBe(82);
    expect(s.eliminated.map(d => d.driverId)).toEqual(['c']);
    expect(s.contenders.map(d => d.driverId)).toEqual(['b', 'e', 'd']);
  });

  it('prochain meeting : écart requis, points à reprendre à chaque poursuivant', () => {
    // 2 restants : après m3 il restera 41 → il faut 42 d'avance. Avance 30 → reprendre 12 à b.
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 70, c: 60 }), meetings: MEETINGS, regulation: FFSA });
    expect(s.next.meeting.id).toBe('m3');
    expect(s.next.leftAfter).toBe(41);
    expect(s.next.requiredGapAfter).toBe(42);
    expect(s.next.need).toBe(12);
    expect(s.next.gainVsSecond).toBe(12);
    expect(s.next.possible).toBe(true);
    // 12 > 4 garantis en gagnant tout : aucun résultat du leader ne suffit seul.
    expect(s.next.tiers).toEqual([]);
    // Si le leader marque 41, b doit marquer au plus 29.
    expect(s.next.rivalMaxIfLeaderMax).toBe(29);
    // Face à c (retard 40) : reprendre 2.
    expect(s.drivers.find(d => d.driverId === 'c').leaderNeedNext).toBe(2);
    expect(s.drivers.find(d => d.driverId === 'b').leaderNeedNext).toBe(12);
    expect(s.earliest.index).toBe(1);
  });

  it('marge cessible : avance 80 pour 82 en jeu → peut céder 38, sacré en marquant 3', () => {
    // Après m3 il faut 42 d'avance : need = 42 − 80 = −38.
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 180, b: 100 }), meetings: MEETINGS, regulation: FFSA });
    expect(s.next.need).toBe(-38);
    expect(s.next.gainVsSecond).toBe(0);
    expect(s.next.concedable).toBe(38);
    expect(s.next.tiers).toEqual([{ wins: [], score: 3, winsSuffice: false }]);
    expect(s.drivers[1].leaderNeedNext).toBe(-38);
  });

  it('les ½ finales ne créent aucune garantie : deux pilotes peuvent gagner chacun la leur', () => {
    // need 2 : gagner sa ½ finale n'apparaît dans aucun palier.
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 140, b: 100 }), meetings: MEETINGS, regulation: FFSA });
    expect(s.next.need).toBe(2);
    expect(s.next.tiers.every(t => !t.wins.includes('df'))).toBe(true);
    expect(s.next.tiers[0]).toEqual({ wins: ['fin'], score: 40, winsSuffice: false });
  });

  it('titre impossible au prochain meeting quand l\'écart à créer dépasse un meeting', () => {
    // 4 restants (aucun meeting joué → tout est restant) : 164 en jeu, avance 0.
    const standings = [
      { driverId: 'a', firstName: 'P', lastName: 'A', grandTotal: 0, position: 1, meetingPts: {}, meetingDetail: {} },
      { driverId: 'b', firstName: 'P', lastName: 'B', grandTotal: 0, position: 1, meetingPts: {}, meetingDetail: {} },
    ];
    const s = buildTitleScenarios({ standings, meetings: MEETINGS, regulation: FFSA });
    expect(s.pointsLeft).toBe(164);
    expect(s.next.requiredGapAfter).toBe(124);
    expect(s.next.possible).toBe(false);
    // Après k meetings, avance max k×41 doit dépasser (4−k)×41 → k = 3.
    expect(s.earliest.index).toBe(3);
    expect(s.earliest.meeting.id).toBe('m3');
  });

  it('saison terminée : plus rien en jeu, pas de prochain meeting', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 90 }, ['m1', 'm2', 'm3', 'm4']), meetings: MEETINGS, regulation: FFSA });
    expect(s.status).toBe('season_over');
    expect(s.pointsLeft).toBe(0);
    expect(s.next).toBeNull();
    expect(s.drivers[1].state).toBe('eliminated');
  });

  it('chaque pilote encore concerné reçoit son scénario idéal, pas les éliminés', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 90, c: 17, e: 19 }), meetings: MEETINGS, regulation: FFSA });
    const by = id => s.drivers.find(d => d.driverId === id);
    expect(by('a').ideal.next.total).toBe(141);
    expect(by('b').ideal.rows.map(r => r.driverId)).toEqual(['b', 'a', 'e']);   // c éliminé : hors partage
    expect(by('b').ideal.next.total).toBe(131);
    expect(by('b').ideal.next.gap).toBe(131 - 137);
    expect(by('c').ideal).toBeUndefined();
    // e (19) : même en gagnant tout deux fois (101), a (100 + 2×37) est loin devant.
    expect(by('e').ideal.season.champion).toBe(false);
  });

  it('un meeting en cours n\'est pas compté comme restant', () => {
    const standings = [
      driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 16 } }),
      driver('b', { m1: { interim: 15, df: 8,  fin: 12 }, m2: { interim: 15 } }),
    ].map((d, i) => ({ ...d, position: i + 1 }));
    const s = buildTitleScenarios({ standings, meetings: MEETINGS, regulation: FFSA });
    expect(s.inProgress.map(m => m.id)).toEqual(['m2']);
    expect(s.remaining.map(m => m.id)).toEqual(['m3', 'm4']);
    // 2 meetings complets (82) + ½ finale et finale du meeting en cours (25).
    expect(s.pointsLeft).toBe(107);
    expect(s.current.id).toBe('m2');
    expect(s.currentPhases.map(ph => ph.key)).toEqual(['df', 'fin']);
    expect(s.currentLeft).toBe(25);
    // Le prochain pas est la fin de ce meeting, pas m3.
    expect(s.next.inProgress).toBe(true);
    expect(s.next.meeting.id).toBe('m2');
    expect(s.next.stake).toBe(25);
    expect(s.next.leftAfter).toBe(82);
    expect(s.drivers[0].ideal.next.total).toBe(41 + 16 + 25);
  });

  it('après les manches et l\'intermédiaire du dernier meeting, un champion peut déjà être déclaré', () => {
    // Deux meetings au calendrier, le second en cours : intermédiaire marqué,
    // ½ finale et finale à venir (25 pts). a : 41 + 16 = 57.
    const two = MEETINGS.slice(0, 2);
    const at = bM1 => buildTitleScenarios({
      standings: [
        driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 16 } }),
        driver('b', { m1: { interim: bM1 }, m2: { interim: 15 } }),
      ].map((d, i) => ({ ...d, position: i + 1 })),
      meetings: two, regulation: FFSA,
    });
    // b = 15 + 15 = 30 → 27 d'avance pour 25 en jeu : champion avant même la ½ finale.
    expect(at(15).pointsLeft).toBe(25);
    expect(at(15).status).toBe('clinched');
    // b = 32 → 25 d'avance : ne peut plus être dépassé, seulement égalé.
    expect(at(17).status).toBe('clinched_tie');
    // b = 33 → 24 d'avance : titre ouvert, il se joue sur ½ finale + finale.
    const open = at(18);
    expect(open.status).toBe('open');
    expect(open.next.inProgress).toBe(true);
    expect(open.next.requiredGapAfter).toBe(1);
    expect(open.next.need).toBe(1 - 24);
    // Sacré en marquant 2 pts sur les 25 restants (b en prend 25 au pire).
    expect(open.next.tiers).toEqual([{ wins: [], score: 2, winsSuffice: false }]);
    expect(open.earliest).toEqual({ index: 1, of: 1, meeting: open.current, inProgress: true });
    const html = renderTitleScenarios(open);
    expect(html).toContain('Meeting en cours');
    expect(html).toContain('½ finale + finale');
    expect(html).toContain('25 pts');
  });

  it('après les ½ finales : un 2e non qualifié pour la finale ne peut plus marquer, le leader est sacré', () => {
    // Dernier meeting, ½ finales courues. a : 41 + 16 + 10 = 67 ; b : 30 + 15 + 4 (5e de ½) = 49.
    // Sans qualification, b pourrait encore prendre 15 en finale → 64 < 67 de toute
    // façon ; on serre : b à 55 avant la finale → 70 > 67 s'il marquait, mais il ne
    // peut plus.
    const two = MEETINGS.slice(0, 2);
    const mk = (bDf) => buildTitleScenarios({
      standings: [
        driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 16, df: 10 } }),
        driver('b', { m1: { interim: 15, df: 8,  fin: 12 }, m2: { interim: 15, df: bDf } }),
      ].map((d, i) => ({ ...d, position: i + 1 })),
      meetings: two, regulation: FFSA,
    });
    // b 5e de sa ½ (4 pts) : 54 pts, ne peut plus marquer → a (67) champion avant la finale.
    const out = mk(4);
    expect(out.currentPhases.map(ph => ph.key)).toEqual(['fin']);
    expect(out.drivers[1].stepKeys).toEqual([]);
    expect(out.drivers[1].maxReachable).toBe(54);
    expect(out.status).toBe('clinched');
    // b 4e de sa ½ (5 pts) : 55 pts, qualifié → peut encore atteindre 70 : titre ouvert.
    const inn = mk(5);
    expect(inn.drivers[1].stepKeys).toEqual(['fin']);
    expect(inn.drivers[1].maxReachable).toBe(70);
    expect(inn.status).toBe('open');
    expect(inn.next.leaderStake).toBe(15);
    expect(inn.next.rivalStake).toBe(15);
  });

  it('après les ½ finales : le leader non qualifié ne peut plus marquer, seul le 2e décide', () => {
    // a 5e de sa ½ (4 pts) : 41 + 16 + 4 = 61 ; b qualifié : 30 + 15 + 10 = 55 → b peut atteindre 70.
    const s = buildTitleScenarios({
      standings: [
        driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 16, df: 4 } }),
        driver('b', { m1: { interim: 15, df: 3,  fin: 12 }, m2: { interim: 15, df: 10 } }),
      ].map((d, i) => ({ ...d, position: i + 1 })),
      meetings: MEETINGS.slice(0, 2), regulation: FFSA,
    });
    expect(s.status).toBe('open');
    expect(s.next.leaderStake).toBe(0);
    expect(s.next.rivalStake).toBe(15);
    expect(s.next.need).toBe(1 - 6);
    expect(s.next.tiers).toEqual([]);             // le leader ne peut rien garantir
    expect(s.next.rivalMaxIfLeaderMax).toBe(5);   // b doit marquer au plus 5 (P6 ou moins)
    const html = renderTitleScenarios(s);
    expect(html).toContain('Le leader ne peut plus marquer sur ce meeting');
    // Scénario idéal de b : il gagne la finale, a n'y a pas de place.
    expect(s.drivers[1].ideal.rows.map(r => [r.driverId, r.places[0].pos])).toEqual([['b', 1], ['a', null]]);
    expect(s.drivers[1].ideal.season.champion).toBe(true);
  });

  it('meeting en cours sans rien de marqué en finale : le titre ne peut pas être annoncé sur les seuls points intermédiaires', () => {
    // Même avance de 27 mais un meeting complet reste après : 27 < 25 + 41.
    const s = buildTitleScenarios({
      standings: [
        driver('a', { m1: { interim: 16, df: 10, fin: 15 }, m2: { interim: 16 } }),
        driver('b', { m1: { interim: 15 }, m2: { interim: 15 } }),
      ].map((d, i) => ({ ...d, position: i + 1 })),
      meetings: MEETINGS.slice(0, 3), regulation: FFSA,
    });
    expect(s.pointsLeft).toBe(66);
    expect(s.status).toBe('open');
  });

  it('classement vide → null ; règlement avec décompte → signalé', () => {
    expect(buildTitleScenarios({ standings: [], meetings: MEETINGS })).toBeNull();
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 10 }), meetings: MEETINGS, regulation: { ...FFSA, worstResultDrop: 1 } });
    expect(s.ignoresDrop).toBe(true);
    expect(s.status).toBe('clinched');   // seul pilote classé
  });
});

describe('renderTitleScenarios — le HTML dit la même chose que le calcul', () => {
  it('titre ouvert : verdict, prochain meeting, tableau sans les éliminés', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 100, b: 70, c: 60, d: 5 }), meetings: MEETINGS, regulation: FFSA });
    const html = renderTitleScenarios(s);
    expect(html).toContain('Titre ouvert');
    expect(html).toContain('82 pts');
    expect(html).toContain('42 pts');           // écart requis après m3
    expect(html).toContain('12 pts');           // à reprendre à b
    expect(html).toContain('4 pts garantis');   // en gagnant tout, rival au mieux 2e
    expect(html).toContain('29 pts');           // b doit marquer au plus 29 si a marque 41
    expect(html).toContain('Faleyras');
    expect(html).toContain('<strong>C</strong>');
    expect(html).not.toContain('<strong>D</strong>');
    expect(html).toContain('1 pilote mathématiquement éliminé');
    expect(html).toContain('Idéal · prochain meeting');
    expect(html).toContain('insuffisant');        // c ne peut pas être champion même en gagnant tout
    expect(html).toContain('½ finale P1');        // détail des places dans l'infobulle
  });

  it('marge cessible affichée en négatif dans la colonne « À reprendre »', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 180, b: 100 }), meetings: MEETINGS, regulation: FFSA });
    const html = renderTitleScenarios(s);
    expect(html).toContain('peut même céder');
    expect(html).toContain('−38');
    expect(html).toContain('en marquant au moins <strong>3 pts</strong>');
  });

  it('champion mathématique', () => {
    const s = buildTitleScenarios({ standings: standingsWithTotals({ a: 200, b: 100 }), meetings: MEETINGS, regulation: FFSA });
    const html = renderTitleScenarios(s);
    expect(html).toContain('mathématiquement champion');
    expect(html).not.toContain('Prochain meeting');
  });

  it('échappe les noms', () => {
    const rows = standingsWithTotals({ a: 100, b: 50 });
    rows[0].lastName = '<b>X</b>';
    const html = renderTitleScenarios(buildTitleScenarios({ standings: rows, meetings: MEETINGS, regulation: FFSA }));
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });

  it('null → chaîne vide', () => {
    expect(renderTitleScenarios(null)).toBe('');
  });
});
