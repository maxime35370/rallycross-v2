/* OBJECTIF STRATÉGIQUE EN DIRECT — sur un meeting réel rejoué série par série.

   Vérifie que l'objectif est bien calculé au niveau SÉRIE + CLASSEMENT GLOBAL,
   et pas « pilote seul contre un chrono de référence ».

   Lecture seule. Usage : node tools/qualification-audit/14-objectif.mjs [lieu] [cat] [séries] [dossard] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold } from '../../js/projection/qualificationRules.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import { simulateFromCheckpoint } from '../../js/projection/scenarioSimulator.js';
import {
  seriesPlan, provisionalOrder, chronoForProvisionalPosition,
  mathematicalChronoTarget, directRivals, buildLiveObjective, pickScenarios,
} from '../../js/projection/liveStrategy.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const RAW = { sessions: J('sessions.json'), participants: J('sessionParticipants.json'), meetings: J('meetings.json') };
const ALL = J('results.json');
const champs = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const ctxOf = (results) => buildGroups({ ...RAW, results })
  .map(g => buildMeetingContext(g, champs[g.meeting?.championshipId] || null));

const LIEU = process.argv[2] || 'Kerlabo';
const CAT = process.argv[3] || 'D3';
const NB_SERIES = Number(process.argv[4] || 4);
const SEED = 20260101;

const full = ctxOf(ALL).find(c => c.meeting?.location === LIEU && c.category === CAT);
const LAST = full.lastCompletedRace;
const session = full.races.find(r => r.num === LAST).sessionId;
const series = [...new Set(ALL.filter(r => r.sessionId === session).map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b);
const visibles = new Set(series.slice(0, NB_SERIES));
const ctx = ctxOf(ALL.filter(r => r.sessionId !== session || visibles.has(r.serie))).find(c => c.key === full.key);

const CP = ctx.lastCompletedRace;
const state = buildStateAfterRace(ctx, CP);
const threshold = resolveQualificationThreshold({
  regulation: ctx.regulation, observedPhaseCounts: ctx.observedPhaseCounts, engagedCount: ctx.engagedCount,
}).threshold;
const { models } = buildDriverModels({
  driverIds: state.standings.map(d => d.driverId),
  observations: collectRaceObservations(ctxOf(ALL.filter(r => r.sessionId !== session || visibles.has(r.serie))))
    .filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= CP),
  scope: { meetingId: ctx.meetingId, year: ctx.meeting.year, category: ctx.category, circuit: ctx.meeting.location },
});

const race = ctx.races.find(r => r.num === LAST);
const focus = process.argv[5]
  ? state.standings.find(d => String(d.carNumber) === String(process.argv[5]))
  : state.standings.filter(d => race.pendingDriverIds.includes(d.driverId))
      .sort((a, b) => Math.abs(a.position - threshold) - Math.abs(b.position - threshold))[0];

const ms = v => v == null ? '—' : `${Math.floor(v / 60000)}:${String(Math.floor(v % 60000 / 1000)).padStart(2, '0')}.${String(Math.round(v % 1000)).padStart(3, '0')}`;
const pct = v => v == null ? '—' : `${(100 * v).toFixed(0)} %`;
const nom = id => { const d = ctx.driversById[id]; return `#${d?.carNumber} ${d?.lastName || ''}`; };

console.log('═'.repeat(92));
console.log(`OBJECTIF STRATÉGIQUE — ${ctx.meeting.location} / ${ctx.category} · manche ${LAST} · ${NB_SERIES} séries courues`);
console.log(`${race.ranCount}/${race.engagedCount} résultats réels · ${threshold} places qualificatives`);
console.log(`pilote : ${nom(focus.driverId)} — P${focus.position} · ${focus.totalPoints} pts`);
console.log('═'.repeat(92));

const plan = seriesPlan(ctx, LAST);
console.log('\n── COMPOSITION DES SÉRIES ──');
for (const s of plan.series) {
  const etat = s.complete ? 'terminée' : s.inProgress ? 'en cours' : 'à venir';
  console.log(`  série ${s.num} (${s.expectedSize} pilotes, ${etat}${s.inferred ? ', DÉDUITE' : ''}) : ${s.members.map(nom).join(' · ')}`);
}
const maSerie = plan.of(focus.driverId);
console.log(`\n  ${nom(focus.driverId)} est en série ${maSerie?.num}${maSerie?.inferred ? ' (déduite)' : ' (certaine)'}`);
console.log(`  coéquipiers de série encore à courir : ${maSerie.pendingMembers.filter(i => i !== focus.driverId).map(nom).join(' · ') || 'aucun'}`);

console.log('\n── CLASSEMENT PROVISOIRE DE LA MANCHE ──');
provisionalOrder(ctx, LAST).slice(0, 8).forEach(x =>
  console.log(`  P${String(x.provisionalPosition).padStart(2)}  ${nom(x.driverId).padEnd(20)} ${ms(x.ms)}`));

console.log('\n── TRADUCTION NAÏVE (ce qu\'il ne faut PAS afficher tel quel) ──');
for (const p of [3, 4, 5]) {
  const t = chronoForProvisionalPosition(ctx, LAST, p, { excludeDriverId: focus.driverId });
  if (t?.beat) console.log(`  « être P${p} provisoire » → battre ${ms(t.beat)} (${nom(t.beatDriverId)}) · exact : ${t.certain ? 'oui' : `NON, ${t.pendingOthers} pilotes doivent encore rouler`}`);
}

const baseRun = simulateFromCheckpoint({
  context: ctx, checkpoint: CP, models, threshold, focusDriverId: focus.driverId,
  simulations: 8000, seed: SEED, trackRaceOutcome: LAST,
  rivalIds: state.standings.filter(d => d.driverId !== focus.driverId && Math.abs(d.position - threshold) <= 6).map(d => d.driverId),
});
console.log(`\n  probabilité de qualification sans contrainte : ${pct(baseRun.probability)}`);

const maths = mathematicalChronoTarget({ context: ctx, raceNum: LAST, driverId: focus.driverId, threshold, checkpoint: CP });
console.log('\n── OBJECTIF MATHÉMATIQUE ──');
if (maths?.impossible) console.log('  aucun chrono ne garantit la qualification à ce stade.');
else if (maths?.unconditional) console.log('  qualification acquise quel que soit le résultat de cette manche.');
else console.log(`  battre ${ms(maths.beat)} (${nom(maths.beatDriverId)}) → Top ${threshold} ACQUIS` +
  `\n    au plus ${maths.maxRealAhead} pilote(s) réel(s) devant · pire position finale P${maths.worstPosition} · total minimum ${maths.minTotal} pts`);

const t0 = Date.now();
const obj = buildLiveObjective({
  context: ctx, checkpoint: CP, models, threshold, driverId: focus.driverId,
  baseRun, seed: SEED,
});
console.log(`\n── OBJECTIF PROBABILISTE (mode : ${obj.mode}) ──   [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
console.log('  cible provisoire   chrono à battre   P(qualif)   place médiane dans la manche');
for (const e of obj.ladder || []) {
  console.log(`  P${String(e.provisionalTarget).padEnd(3)}              ${ms(e.ms + 1).padStart(10)}      ${pct(e.probability).padStart(5)}       P${e.medianRacePosition}`);
}
if (obj.target) {
  console.log(`\n  CIBLE RETENUE : être P${obj.target.provisionalTarget} au provisoire ou mieux → ${pct(obj.target.probability)}`);
  console.log(`  chrono à battre : ${ms(obj.target.ms + 1)} · exact : ${obj.exact ? 'OUI' : 'NON (d\'autres doivent rouler)'}`);
  if (obj.seriesThreat.length) {
    console.log('\n  MENACE DES COÉQUIPIERS DE SÉRIE sur cette cible :');
    obj.seriesThreat.forEach(m => console.log(`    ${nom(m.driverId).padEnd(20)} bat ce chrono dans ${pct(m.probabilityBeatsTarget)} des simulations`));
  }
}

const t1 = Date.now();
const rivaux = directRivals({ context: ctx, checkpoint: CP, models, threshold, driverId: focus.driverId, baseRun, seed: SEED });
console.log(`\n── CONCURRENTS DIRECTS (impact mesuré, seuil ${(100 * rivaux.minImpact).toFixed(0)} pt) ──   [${((Date.now() - t1) / 1000).toFixed(1)} s]`);
console.log('  pilote                P inter  impact   si au mieux / si abandon   Q' + LAST);
for (const r of rivaux.all) {
  const p = rivaux.positions[r.driverId];
  console.log(`  ${nom(r.driverId).padEnd(20)} P${String(p ?? '—').padStart(2)}    ` +
    (r.settled ? '  acquis                              déjà couru'
      : `${(100 * r.impact).toFixed(1).padStart(5)} pt   ${pct(r.probabilityIfRivalBest).padStart(5)} / ${pct(r.probabilityIfRivalOut).padStart(5)}          à venir`));
}
console.log(`  → retenus comme concurrents directs : ${rivaux.direct.length}`);

console.log('\n── SCÉNARIOS PROPOSÉS AU TEAM ──');
for (const s of pickScenarios({ objective: obj, rivals: rivaux })) {
  console.log(`  ${s.label} → ${pct(s.probability)}`);
}
