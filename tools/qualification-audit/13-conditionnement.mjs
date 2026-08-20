/* LE CONDITIONNEMENT EST-IL CORRECT ?

   Une probabilité qui bouge beaucoup n'est pas suspecte en soi : c'est le
   propre d'une information qui arrive. Ce qui serait suspect, c'est qu'elle
   dérive systématiquement dans un sens — signe que conditionner sur un résultat
   réel n'équivaut pas à conditionner sur le même résultat tiré.

   Test appliqué : la loi des espérances itérées. Si le moteur conditionne
   correctement, alors

       moyenne des probabilités APRÈS la série 1  =  probabilité AVANT

   à l'erreur de tirage près, la moyenne étant prise sur la distribution des
   résultats possibles de cette série — celle que le moteur produit lui-même.

   Un moteur qui, par exemple, avantagerait les pilotes déjà passés ferait
   chuter cette moyenne bien en dessous de la probabilité initiale.

   Lecture seule. Usage : node tools/qualification-audit/13-conditionnement.mjs [lieu] [catégorie] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold } from '../../js/projection/qualificationRules.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import {
  simulateFromCheckpoint, simulateRaceRows, makeDrawBuffers, drawRace,
  timeScaleOf, entrantsOfRace,
} from '../../js/projection/scenarioSimulator.js';
import { createRng } from '../../js/projection/monteCarloEngine.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const champs = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const ALL = J('results.json');
const RAW = { sessions: J('sessions.json'), participants: J('sessionParticipants.json'), meetings: J('meetings.json') };
const ctxAll = (results) => buildGroups({ ...RAW, results })
  .map(g => buildMeetingContext(g, champs[g.meeting?.championshipId] || null));

const LIEU = process.argv[2] || 'Kerlabo';
const CAT = process.argv[3] || 'D3';
const full = ctxAll(ALL).find(c => c.meeting?.location === LIEU && c.category === CAT);
const LAST = full.lastCompletedRace;
const session = full.races.find(r => r.num === LAST).sessionId;
const serie1 = [...new Set(ALL.filter(r => r.sessionId === session).map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b)[0];
const membres = ALL.filter(r => r.sessionId === session && r.serie === serie1).map(r => r.driverId);

const threshold = resolveQualificationThreshold({
  regulation: full.regulation, observedPhaseCounts: full.observedPhaseCounts, engagedCount: full.engagedCount,
}).threshold;
const avant = buildStateAfterRace(full, LAST - 1);
const cible = avant.standings.find(d => d.position === threshold);

// Jeu de documents réduit à ce meeting : buildGroups est alors instantané, ce
// qui rend l'expérience abordable.
const idsSessions = new Set(RAW.sessions.filter(s => s.meetingId === full.meetingId && s.category === full.category).map(s => s.id));
const LOCAL = {
  sessions: RAW.sessions.filter(s => idsSessions.has(s.id)),
  participants: RAW.participants.filter(p => idsSessions.has(p.sessionId)),
  meetings: RAW.meetings.filter(m => m.id === full.meetingId),
};
const sansQ4 = ALL.filter(r => idsSessions.has(r.sessionId) && r.sessionId !== session);
const ctxLocal = (results) => buildGroups({ ...LOCAL, results })
  .map(g => buildMeetingContext(g, full.regulation))[0];

const CP = LAST - 1;
const base = ctxLocal(sansQ4);
const observations = collectRaceObservations(ctxAll(ALL))
  .filter(o => o.meetingId !== full.meetingId || o.raceNum <= CP);
const { models } = buildDriverModels({
  driverIds: buildStateAfterRace(base, CP).standings.map(d => d.driverId),
  observations,
  scope: { meetingId: full.meetingId, year: full.meeting.year, category: full.category, circuit: full.meeting.location },
});

const SEED = 20260101, N_APRES = 4000, M = 60;
const pct = v => `${(100 * v).toFixed(1).replace('.', ',')} %`;

const p0 = simulateFromCheckpoint({
  context: base, checkpoint: CP, models, threshold,
  focusDriverId: cible.driverId, simulations: 40000, seed: SEED,
}).probability;

console.log('═'.repeat(88));
console.log(`CONDITIONNEMENT — ${full.meeting.location} / ${full.category}, manche ${LAST}`);
console.log(`pilote suivi ${cible.firstName} ${cible.lastName} · seuil P${threshold} · série ${serie1} = ${membres.length} pilotes`);
console.log('═'.repeat(88));
console.log(`\nprobabilité AVANT la manche ${LAST} : ${pct(p0)}  (40 000 tirages)`);
console.log(`\n${M} déroulements possibles de la série ${serie1} sont tirés par le moteur lui-même,`);
console.log(`puis injectés comme s'ils étaient réels. Probabilité recalculée à chaque fois.\n`);

// Tirage de M résultats possibles pour la série 1.
const ids = entrantsOfRace(base, LAST, buildStateAfterRace(base, CP).standings.map(d => d.driverId));
const race = {
  num: LAST, ids,
  participants: ids.map(id => ({ driverId: id, ...(base.driversById[id] || {}) })),
  real: null,
};
const scale = timeScaleOf(base, CP, { models });
const bufs = makeDrawBuffers([race]);
const rng = createRng(987654);

const apres = [];
for (let m = 0; m < M; m++) {
  drawRace(rng, race, bufs[0]);
  const rows = simulateRaceRows(race, bufs[0], models, null, scale, base.regulation);

  // Les résultats des seuls membres de la série 1 deviennent « réels ».
  const injectes = membres.map(id => {
    const row = rows.find(r => r.driverId === id);
    return {
      id: `${session}_${id}`, sessionId: session, meetingId: full.meetingId,
      category: full.category, year: full.meeting.year, sessionType: 'MQ',
      driverId: id, ms: row?.status ? null : Math.round(row.ms),
      status: row?.status || null, serie: serie1,
    };
  });
  const ctx = ctxLocal([...sansQ4, ...injectes]);
  const p = simulateFromCheckpoint({
    context: ctx, checkpoint: ctx.lastCompletedRace, models, threshold,
    // Graine propre à chaque scénario : sans cela, les 60 recalculs
    // partageraient le même bruit de tirage et l'erreur type serait sous-estimée.
    focusDriverId: cible.driverId, simulations: N_APRES, seed: SEED + 1000 * m,
  }).probability;
  apres.push(p);
}

const moy = apres.reduce((a, b) => a + b, 0) / apres.length;
const tri = [...apres].sort((a, b) => a - b);
const et = Math.sqrt(apres.reduce((s, p) => s + (p - moy) ** 2, 0) / (apres.length - 1));
const erreurType = et / Math.sqrt(apres.length);
const ecart = moy - p0;

console.log(`  moyenne des probabilités conditionnelles : ${pct(moy)}`);
console.log(`  probabilité avant la manche              : ${pct(p0)}`);
console.log(`  écart                                    : ${(100 * ecart >= 0 ? '+' : '')}${(100 * ecart).toFixed(2)} point`);
console.log(`  erreur type de la moyenne                : ±${(100 * erreurType).toFixed(2)} point`);
console.log(`  écart en erreurs types                   : ${(ecart / erreurType).toFixed(2)}`);
console.log(`\n  dispersion des probabilités conditionnelles :`);
console.log(`    minimum ${pct(tri[0])} · 1er décile ${pct(tri[Math.floor(0.1 * M)])} · médiane ${pct(tri[Math.floor(0.5 * M)])}` +
  ` · 9e décile ${pct(tri[Math.floor(0.9 * M)])} · maximum ${pct(tri[M - 1])}`);

const ok = Math.abs(ecart / erreurType) < 3;
console.log(`\n  ${ok ? '✅' : '❌'} ${ok
  ? 'la moyenne conditionnelle retombe sur la probabilité initiale : le conditionnement ne dérive pas.'
  : 'la moyenne conditionnelle s\'écarte significativement : conditionnement suspect.'}`);
console.log(`\n  Lecture : une seule série peut déplacer la probabilité de ${pct(tri[0])} à ${pct(tri[M - 1])}.`);
console.log('  Une variation forte n\'est donc pas anormale — c\'est la moyenne qui doit être stable.');
