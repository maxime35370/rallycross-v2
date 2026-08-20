/* ═══════════════════════════════════════════════
   RACECERTAINTIES.TEST.JS — Le bloc CERTITUDES ne contient que du démontrable.

   La tentation, pendant une manche en cours, est d'écrire « pratiquement
   qualifié » à 98 % de probabilité. C'est exactement ce que ce module refuse :
   une valeur qui dépend d'un tirage n'est pas une certitude, et une borne qui
   n'est pas atteignable n'est pas une borne.

   Les tests vérifient donc deux choses distinctes :
     · que les bornes annoncées sont ATTEIGNABLES (donc exactes, pas prudentes) ;
     · qu'aucun verdict n'est prononcé tant qu'une manche reste à courir.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { buildGroups, buildMeetingContext } from '../js/projection/qualificationState.js';
import {
  raceProgress, describeProgress, positionBounds, pointsBounds,
  mathematicalVerdict, buildRaceCertainties, isSettled,
} from '../js/projection/raceCertainties.js';
import { simulateFromCheckpoint, entrantsOfRace, realResultsOfRace, simulateRaceRows, makeDrawBuffers, drawRace, timeScaleOf } from '../js/projection/scenarioSimulator.js';
import { createRng } from '../js/projection/monteCarloEngine.js';
import { buildDriverModels, collectRaceObservations } from '../js/projection/driverPerformanceModel.js';
import { makeMeeting, mergeFixtures, PENDING, TEST_REGULATION } from './helpers/projectionFixtures.js';

const FIELD = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const rot = n => [...FIELD.slice(n), ...FIELD.slice(0, n)];
const ran = (order) => Object.fromEntries(order.map((d, i) => [d, 60000 + i * 700]));

function ctxOf({ raceNum = 4, done = ['C', 'A', 'F'], statuses = {}, series = null } = {}) {
  const races = {};
  for (let n = 1; n < raceNum; n++) races[n] = ran(rot(n));
  const partielle = {};
  done.forEach((d, i) => {
    partielle[d] = statuses[d]
      ? { status: statuses[d], serie: series?.[d] ?? null }
      : (series ? { ms: 60000 + i * 700, serie: series[d] ?? null } : 60000 + i * 700);
  });
  for (const d of FIELD) if (!(d in partielle)) partielle[d] = PENDING;
  races[raceNum] = partielle;
  for (let n = raceNum + 1; n <= 4; n++) races[n] = Object.fromEntries(FIELD.map(d => [d, PENDING]));
  const m = mergeFixtures([makeMeeting({
    meetingId: 'LIVE', drivers: FIELD, plannedRaces: 4,
    meeting: { date: '2026-08-20', id: 'LIVE' }, races,
  })]);
  return buildGroups(m).map(g => buildMeetingContext(g, TEST_REGULATION))[0];
}

// ─────────────────────────────────────────────────────────

describe('photographie factuelle de la manche', () => {
  it('compte les pilotes passés et restants, sans rien inférer', () => {
    const p = raceProgress(ctxOf(), 4);
    expect(p.ranCount).toBe(3);
    expect(p.pendingCount).toBe(5);
    expect(p.engagedCount).toBe(8);
    expect(p.finishers.map(f => f.driverId)).toEqual(['C', 'A', 'F']);
    expect(p.isInProgress).toBe(true);
    expect(p.isComplete).toBe(false);
  });

  it('sans aucune série renseignée, le compte n\'est pas inventé', () => {
    const partiel = describeProgress(raceProgress(ctxOf(), 4));
    expect(partiel.seriesKnown).toBe(false);
    expect(partiel.membershipFullyKnown).toBe(false);
    expect(partiel.series).toMatch(/ne peut pas être établi/);
    expect(partiel.drivers).toMatch(/3 résultats sur 8/);
  });

  it('les séries des pilotes passés suffisent à compter les séries terminées', () => {
    // Cas réel du direct : les pilotes déjà passés portent leur série, les
    // autres non. Une série pleine et entièrement courue est bien terminée —
    // aucun pilote restant ne peut lui appartenir.
    const REG = { ...TEST_REGULATION, sessionConfig: { ...TEST_REGULATION.sessionConfig, MQ: { count: 4, driversPerSeries: 4 } } };
    const races = { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: {} };
    FIELD.forEach((d, i) => {
      races[4][d] = i < 4 ? { ms: 60000 + i * 700, serie: 1 } : PENDING;
    });
    const m = mergeFixtures([makeMeeting({
      meetingId: 'S2', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'S2' }, races,
    })]);
    const ctx = buildGroups(m).map(g => buildMeetingContext(g, REG))[0];
    const d = describeProgress(raceProgress(ctx, 4));
    expect(d.seriesKnown).toBe(true);
    expect(d.membershipFullyKnown).toBe(false);
    expect(d.series).toBe('1 / 2 séries terminées d\'après les séries renseignées.');
  });

  it('quand les séries sont renseignées, la phrase reste prudente sur sa source', () => {
    const REG = { ...TEST_REGULATION, sessionConfig: { ...TEST_REGULATION.sessionConfig, MQ: { count: 4, driversPerSeries: 4 } } };
    const races = { 1: ran(FIELD), 2: ran(FIELD), 3: ran(FIELD), 4: {} };
    const s = { A: 1, B: 1, C: 1, D: 1, E: 2, F: 2, G: 2, H: 2 };
    FIELD.forEach((d, i) => {
      races[4][d] = i < 4 ? { ms: 60000 + i * 700, serie: s[d] } : { ms: null, status: null, serie: s[d] };
    });
    const m = mergeFixtures([makeMeeting({
      meetingId: 'S', drivers: FIELD, plannedRaces: 4, meeting: { date: '2026-08-20', id: 'S' }, races,
    })]);
    const ctx = buildGroups(m).map(g => buildMeetingContext(g, REG))[0];
    const d = describeProgress(raceProgress(ctx, 4));
    expect(d.seriesKnown).toBe(true);
    expect(d.series).toBe('1 / 2 séries terminées d\'après les séries renseignées.');
  });
});

describe('les bornes de position sont exactes, pas prudentes', () => {
  it('un pilote déjà passé est encadré par « réels devant » et « restants »', () => {
    const b = positionBounds(ctxOf(), 4, 'F');   // 3e des 3 passés, 5 restants
    expect(b.hasRun).toBe(true);
    expect(b.provisionalPosition).toBe(3);
    expect(b.bestPosition).toBe(3);
    expect(b.worstPosition).toBe(8);
    expect(b.exact).toBe(false);
  });

  it('les deux bornes sont réellement atteintes par la simulation', () => {
    // Une borne qu'aucun tirage n'atteint serait une borne trop large, donc une
    // information de moindre qualité que ce que les données permettent.
    const ctx = ctxOf();
    const b = positionBounds(ctx, 4, 'F');
    const ids = entrantsOfRace(ctx, 4, FIELD);
    const race = {
      num: 4, ids, participants: ids.map(id => ({ driverId: id, ...(ctx.driversById[id] || {}) })),
      real: realResultsOfRace(ctx, 4),
    };
    const models = buildDriverModels({
      driverIds: FIELD, observations: collectRaceObservations([ctx]).filter(o => o.raceNum <= 3),
      scope: { meetingId: 'LIVE', year: 2026, category: ctx.category, circuit: 'Circuit de test' },
    }).models;
    const scale = timeScaleOf(ctx, 4);
    const bufs = makeDrawBuffers([race]);
    const rng = createRng(1234);
    const vues = new Set();
    for (let k = 0; k < 4000; k++) {
      drawRace(rng, race, bufs[0]);
      vues.add(simulateRaceRows(race, bufs[0], models, null, scale, TEST_REGULATION).find(r => r.driverId === 'F').position);
    }
    expect(Math.min(...vues)).toBe(b.bestPosition);
    expect(Math.max(...vues)).toBe(b.worstPosition);
  });

  it('un pilote pas encore passé garde tout le plateau devant lui', () => {
    const b = positionBounds(ctxOf(), 4, 'B');
    expect(b.hasRun).toBe(false);
    expect(b.provisionalPosition).toBeNull();
    expect(b.bestPosition).toBe(1);
    expect(b.worstPosition).toBe(8);
  });

  it('un statut déjà enregistré fixe la position définitivement', () => {
    const b = positionBounds(ctxOf({ statuses: { A: 'DNF' } }), 4, 'A');
    expect(b.status).toBe('DNF');
    expect(b.exact).toBe(true);
    expect(b.bestPosition).toBe(b.worstPosition);
    expect(b.bestPosition).toBe(9);   // engagés + 1
  });

  it('manche terminée : la position est exacte, sans encadrement', () => {
    const b = positionBounds(ctxOf({ done: FIELD }), 4, 'F');
    expect(b.hasRun).toBe(true);
    expect(b.pendingCount).toBe(0);
    expect(b.exact).toBe(true);
    expect(b.bestPosition).toBe(b.worstPosition);
    // Manche complète : F est 6e du plateau, et cette place ne bougera plus.
    expect(b.provisionalPosition).toBe(6);
  });

  it('les bornes de points balaient réellement les positions possibles', () => {
    const ctx = ctxOf();
    const p = pointsBounds(positionBounds(ctx, 4, 'F'), TEST_REGULATION);
    // Barème de test : 10 - position, entre P3 et P8.
    expect(p.max).toBe(7);
    expect(p.min).toBe(2);
    expect(p.exact).toBe(false);
  });

  it('pour un pilote restant, la borne basse tient compte de l\'abandon', () => {
    const p = pointsBounds(positionBounds(ctxOf(), 4, 'B'), TEST_REGULATION);
    expect(p.includesIncident).toBe(true);
    expect(p.min).toBe(0);   // DNS/DSQ à 0 point dans le règlement de test
  });
});

describe('aucun verdict tant qu\'une manche reste à courir', () => {
  it('manche 3 en cours et manche 4 à venir : on reste sur une projection', () => {
    const c = buildRaceCertainties({ context: ctxOf({ raceNum: 3 }), driverId: 'C', threshold: 4 });
    expect(c.raceNum).toBe(3);
    expect(c.isLastRace).toBe(false);
    expect(c.stillAProjection).toBe(true);
    expect(c.verdict).toBeNull();
    expect(isSettled(c)).toBe(false);
    expect(c.statements.some(s => s.kind === 'qualification')).toBe(false);
  });

  it('dernière manche en cours : un verdict devient possible', () => {
    const c = buildRaceCertainties({ context: ctxOf({ raceNum: 4 }), driverId: 'C', threshold: 4 });
    expect(c.isLastRace).toBe(true);
    expect(c.stillAProjection).toBe(false);
    expect(c.verdict).not.toBeNull();
    expect(['qualified', 'eliminated', 'undecided']).toContain(c.verdict.state);
  });

  it('un verdict « qualifié » n\'est jamais démenti par la simulation', () => {
    // Le point le plus important du module : si le bloc CERTITUDES dit
    // « qualification acquise », alors AUCUN tirage ne doit produire une
    // non-qualification. Un contre-exemple invaliderait la démonstration.
    const ctx = ctxOf({ raceNum: 4, done: rot(0).slice(0, 6) });
    const models = buildDriverModels({
      driverIds: FIELD, observations: collectRaceObservations([ctx]).filter(o => o.raceNum <= 3),
      scope: { meetingId: 'LIVE', year: 2026, category: ctx.category, circuit: 'Circuit de test' },
    }).models;

    let verifies = 0;
    for (const threshold of [2, 3, 4, 5, 6]) {
      for (const driverId of FIELD) {
        const v = mathematicalVerdict({ context: ctx, checkpoint: 3, driverId, threshold });
        if (!v || v.state === 'undecided') continue;
        const run = simulateFromCheckpoint({
          context: ctx, checkpoint: 3, models, threshold, focusDriverId: driverId,
          simulations: 400, seed: 606,
        });
        verifies++;
        if (v.state === 'qualified') expect(run.probability, `${driverId} seuil ${threshold}`).toBe(1);
        if (v.state === 'eliminated') expect(run.probability, `${driverId} seuil ${threshold}`).toBe(0);
      }
    }
    expect(verifies).toBeGreaterThan(0);
  });

  it('« indécis » n\'est pas un demi-verdict : rien n\'est affirmé', () => {
    const v = mathematicalVerdict({ context: ctxOf(), checkpoint: 3, driverId: 'D', threshold: 4 });
    if (v.state === 'undecided') {
      const c = buildRaceCertainties({ context: ctxOf(), driverId: 'D', threshold: 4 });
      expect(c.statements.some(s => s.kind === 'qualification')).toBe(false);
    }
  });
});

describe('les énoncés produits sont tous démontrables', () => {
  it('un pilote passé voit son résultat annoncé comme acquis', () => {
    const c = buildRaceCertainties({ context: ctxOf(), driverId: 'F', threshold: 4 });
    const texte = c.statements.map(s => s.text).join(' ');
    expect(texte).toMatch(/acquis/);
    expect(texte).toMatch(/P3/);
    expect(texte).toMatch(/P8/);
  });

  it('aucun énoncé ne contient de pourcentage ni de vocabulaire probabiliste', () => {
    // Un « % » dans le bloc CERTITUDES trahirait une valeur issue d'un tirage.
    for (const opts of [{ done: [] }, { done: ['C'] }, { done: ['C', 'A', 'F'] }, { done: FIELD.slice(0, 7) }]) {
      for (const driverId of FIELD) {
        const c = buildRaceCertainties({ context: ctxOf(opts), driverId, threshold: 4 });
        for (const s of c.statements) {
          expect(s.text, s.text).not.toMatch(/%|probab|estim|simulation|probable|chance/i);
        }
      }
    }
  });

  it('le bloc ne dépend d\'aucune graine : deux appels donnent le même texte', () => {
    const a = buildRaceCertainties({ context: ctxOf(), driverId: 'F', threshold: 4 });
    const b = buildRaceCertainties({ context: ctxOf(), driverId: 'F', threshold: 4 });
    expect(JSON.stringify(a.statements)).toBe(JSON.stringify(b.statements));
  });

  it('manche non commencée : aucun énoncé de position n\'est produit', () => {
    const c = buildRaceCertainties({ context: ctxOf({ done: [] }), driverId: 'F', threshold: 4 });
    expect(c.raceNum).toBeNull();
    expect(c.statements).toEqual([]);
  });
});
