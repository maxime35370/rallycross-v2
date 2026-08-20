/* LOT 3 — exemples réels après Q2 : projection, what-if Q3, TARGET Q3,
   risque d'incident, et situation projetée avant Q4.

   Aucune donnée postérieure à Q2 n'entre dans le modèle ; le résultat réel
   n'est révélé qu'à l'affichage. Lecture seule.

   Usage : node tools/qualification-audit/08-exemples-q2.mjs [meeting] [catégorie] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace, raceResultOf } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold, gapToThreshold } from '../../js/projection/qualificationRules.js';
import { buildObservations, filterObservations, buildHistoricalOutlook, formatGap } from '../../js/projection/qualificationHistory.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import { simulateFromCheckpoint } from '../../js/projection/scenarioSimulator.js';
import { computeTargetResult, marginalGains, classifyStrategy } from '../../js/projection/strategyTargetCalculator.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const championshipsById = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const contexts = buildGroups({
  sessions: J('sessions.json'), results: J('results.json'),
  participants: J('sessionParticipants.json'), meetings: J('meetings.json'),
}).map(g => buildMeetingContext(g, championshipsById[g.meeting?.championshipId] || null));
const observations = filterObservations(buildObservations(contexts, { championshipsById, requireComplete: true }));

const ctx = contexts.find(c => c.meeting?.location === (process.argv[2] || 'Kerlabo')
  && c.category === (process.argv[3] || 'D3'));
if (!ctx) { console.error('meeting/catégorie introuvable'); process.exit(1); }

const CP = 2, SEED = 20260101, SIMS = 8000, WHATIF = 1500;
const state = buildStateAfterRace(ctx, CP);
const threshold = resolveQualificationThreshold({
  regulation: ctx.regulation, observedPhaseCounts: ctx.observedPhaseCounts, engagedCount: ctx.engagedCount,
}).threshold;

const modelObs = collectRaceObservations(contexts).filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= CP);
const { models } = buildDriverModels({
  driverIds: state.standings.map(d => d.driverId), observations: modelObs,
  scope: { meetingId: ctx.meetingId, year: ctx.meeting.year, category: ctx.category, circuit: ctx.meeting.location },
});

const finalState = buildStateAfterRace(ctx, ctx.lastCompletedRace);
const finalById = new Map(finalState.standings.map(d => [d.driverId, d]));
const history = observations.filter(o => o.meetingId !== ctx.meetingId);
const pct = v => v == null ? '—' : `${(100 * v).toFixed(1).replace('.', ',')} %`;

console.log('═'.repeat(78));
console.log(`${ctx.meeting.location} — ${ctx.category} — situation APRÈS Q2`);
console.log(`${ctx.engagedCount} engagés · ${threshold} places qualificatives · ${state.count} classés`);
console.log(`${SIMS} tirages pour la projection · ${WHATIF} par scénario · graine ${SEED}`);
console.log('═'.repeat(78));

const at = (gap) => state.standings.find(d => d.position === threshold + gap);
const CASES = [
  { gap: -8, titre: 'PILOTE CONFORTABLE' },
  { gap: 0,  titre: 'PILOTE AUTOUR DE LA BULLE' },
  { gap: 2,  titre: 'PILOTE EN DIFFICULTÉ' },
  { gap: 6,  titre: 'PILOTE TRÈS EN RETRAIT' },
];

for (const c of CASES) {
  const d = at(c.gap);
  if (!d) continue;
  const gap = gapToThreshold(d.position, threshold);

  const run = simulateFromCheckpoint({
    context: ctx, checkpoint: CP, models, threshold, focusDriverId: d.driverId,
    simulations: SIMS, seed: SEED,
    rivalIds: state.standings.filter(x => x.driverId !== d.driverId && Math.abs(x.position - threshold) <= 3).map(x => x.driverId),
  });

  const hist = buildHistoricalOutlook({
    observations: history, checkpoint: CP, finalRace: ctx.plannedRaceCount,
    driver: { points: d.totalPoints, position: d.position, gap },
    filters: { championshipId: ctx.meeting.championshipId, category: ctx.category },
  });

  // What-if Q3 : chaque place, plus les statuts, avec la situation avant Q4.
  const entries = [];
  const nbPlaces = state.count;
  for (const position of Array.from({ length: nbPlaces }, (_, i) => i + 1)) {
    const r = simulateFromCheckpoint({
      context: ctx, checkpoint: CP, models, threshold, focusDriverId: d.driverId,
      forced: { 3: { [d.driverId]: { position } } }, simulations: WHATIF, seed: SEED,
      trackStateAfterRace: 3,
    });
    entries.push({ kind: 'position', position, label: `P${position}`, probability: r.probability, intermediate: r.intermediate });
  }
  for (const status of ['DNF', 'DNS', 'DSQ']) {
    const r = simulateFromCheckpoint({
      context: ctx, checkpoint: CP, models, threshold, focusDriverId: d.driverId,
      forced: { 3: { [d.driverId]: { status } } }, simulations: WHATIF, seed: SEED,
      trackStateAfterRace: 3,
    });
    entries.push({ kind: 'status', status, label: status, probability: r.probability, intermediate: r.intermediate });
  }

  const target = computeTargetResult(entries);
  const gains = marginalGains(entries);
  const klass = classifyStrategy({ probability: run.probability, target });
  const reel3 = raceResultOf(ctx, 3, d.driverId);
  const reel4 = raceResultOf(ctx, 4, d.driverId);
  const fin = finalById.get(d.driverId);

  console.log(`\n${'─'.repeat(78)}`);
  console.log(c.titre);
  console.log('─'.repeat(78));
  console.log(`#${d.carNumber} ${d.firstName} ${d.lastName} — P${d.position} · ${d.totalPoints} pts · ${formatGap(gap)}`);

  console.log('\n  HISTORIQUE OBSERVÉ (après Q2)');
  console.log(`    ${hist.comparable.confidence.showRate ? pct(hist.comparable.rate) : '(n<5)'} sur ${hist.comparable.n} cas · confiance ${hist.comparable.confidence.label}`);

  console.log('\n  SIMULATION MONTE-CARLO — Q3 puis Q4');
  console.log(`    probabilité globale de qualification : ${pct(run.probability)}`);
  console.log(`    classement final médian P${run.medianPosition} · score médian ${run.medianPoints} pts`);
  console.log(`    seuil de qualification médian ${run.medianCut} pts (80 % des cas : ${run.cutRange.low}–${run.cutRange.high})`);

  console.log('\n  SI LE PILOTE TERMINE Q3 À… (probabilité conditionnelle de qualification finale)');
  console.log('    place   P(qualif)   gain/place   → situation avant Q4 : classement · points · écart');
  for (const e of entries.filter(e => e.kind === 'position' && [1, 3, 5, 8, 10, 12, 15, 20].includes(e.position))) {
    const g = gains.find(x => x.from === e.position);
    const i = e.intermediate;
    console.log(`    ${e.label.padEnd(5)} ${pct(e.probability).padStart(9)}  ${(g ? `${g.gainPct >= 0 ? '+' : ''}${g.gainPct.toFixed(1)} pt` : '—').padStart(10)}   → P${String(i.medianPosition).padEnd(3)} · ${String(i.medianPoints).padStart(3)} pts · ${formatGap(i.medianGap)}`);
  }

  console.log('\n  MANCHE NON TERMINÉE EN Q3 (compté à part)');
  for (const e of entries.filter(e => e.kind === 'status')) {
    const i = e.intermediate;
    console.log(`    ${e.label.padEnd(5)} ${pct(e.probability).padStart(9)}                → P${String(i.medianPosition).padEnd(3)} · ${String(i.medianPoints).padStart(3)} pts · ${formatGap(i.medianGap)}`);
  }

  console.log('\n  INTERPRÉTATION STRATÉGIQUE');
  console.log(`    TARGET Q3 : ${target.targetLabel} — probabilité conditionnelle ${pct(target.probabilityAtTarget)}`);
  console.log(`    ${target.statement}`);
  // La cible peut être P1 : il n'y a alors pas de « gain moyen depuis P1 ».
  console.log(`    gain moyen à la cible ${target.averageGainAtTarget != null ? target.averageGainAtTarget.toFixed(2) + ' pt/place' : 'sans objet (cible = P1)'} (seuil ${target.thresholdPct})`);
  console.log(`    classification : ${klass.label} — ${klass.reason}`);
  const dnf = entries.find(e => e.status === 'DNF');
  console.log(`    côte à côte : ${target.targetLabel} → ${pct(target.probabilityAtTarget)} · DNF Q3 → ${pct(dnf.probability)}`);

  console.log('\n  → CE QUI S\'EST RÉELLEMENT PASSÉ');
  console.log(`    Q3 : ${reel3?.status || 'P' + reel3?.position} (${reel3?.points} pts) · Q4 : ${reel4?.status || 'P' + reel4?.position} (${reel4?.points} pts)`);
  console.log(`    classement final P${fin?.position} avec ${fin?.totalPoints} pts → ${fin && fin.position <= threshold ? 'QUALIFIÉ' : 'NON QUALIFIÉ'}`);
}
