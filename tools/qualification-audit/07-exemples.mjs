/* Exemples réels : quatre situations types après Q3, avec la projection
   produite AVANT Q4 puis le résultat réellement obtenu.

   Aucune donnée postérieure à Q3 n'entre dans le modèle ; le vrai résultat
   n'est révélé qu'à l'affichage, après coup. Lecture seule.

   Usage : node tools/qualification-audit/07-exemples.mjs [meeting] [catégorie] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace, raceResultOf } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold, gapToThreshold } from '../../js/projection/qualificationRules.js';
import { buildObservations, filterObservations, buildHistoricalOutlook, formatGap } from '../../js/projection/qualificationHistory.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import { simulateFromCheckpoint, whatIfResults } from '../../js/projection/scenarioSimulator.js';
import { computeTargetResult, marginalGains, classifyStrategy } from '../../js/projection/strategyTargetCalculator.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const championshipsById = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const contexts = buildGroups({
  sessions: J('sessions.json'), results: J('results.json'),
  participants: J('sessionParticipants.json'), meetings: J('meetings.json'),
}).map(g => buildMeetingContext(g, championshipsById[g.meeting?.championshipId] || null));

const observations = filterObservations(buildObservations(contexts, { championshipsById, requireComplete: true }));

const wantMeeting = process.argv[2] || 'Kerlabo';
const wantCategory = process.argv[3] || 'D3';
const ctx = contexts.find(c => c.meeting?.location === wantMeeting && c.category === wantCategory);
if (!ctx) { console.error('meeting/catégorie introuvable'); process.exit(1); }

const CHECKPOINT = 3;
const SEED = 20260101;
const state = buildStateAfterRace(ctx, CHECKPOINT);
const threshold = resolveQualificationThreshold({
  regulation: ctx.regulation, observedPhaseCounts: ctx.observedPhaseCounts, engagedCount: ctx.engagedCount,
}).threshold;

// Modèles : rien de postérieur à Q3 pour ce meeting.
const modelObs = collectRaceObservations(contexts).filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= CHECKPOINT);
const { models } = buildDriverModels({
  driverIds: state.standings.map(d => d.driverId), observations: modelObs,
  scope: { meetingId: ctx.meetingId, year: ctx.meeting.year, category: ctx.category, circuit: ctx.meeting.location },
});

// Vérité terrain, révélée seulement à l'affichage.
const finalState = buildStateAfterRace(ctx, ctx.lastCompletedRace);
const finalById = new Map(finalState.standings.map(d => [d.driverId, d]));
const historyWithoutThisMeeting = observations.filter(o => o.meetingId !== ctx.meetingId);

const pct = v => v == null ? '—' : `${(100 * v).toFixed(1).replace('.', ',')} %`;

console.log(`${'═'.repeat(76)}`);
console.log(`${ctx.meeting.location} — ${ctx.category} — situation APRÈS Q3`);
console.log(`${ctx.engagedCount} engagés · ${threshold} places qualificatives · ${state.count} classés`);
console.log(`${'═'.repeat(76)}`);

/** Choisit un pilote représentatif d'un écart au seuil donné. */
const at = (gap) => state.standings.find(d => d.position === threshold + gap);

const CASES = [
  { gap: -6, titre: 'PILOTE DÉJÀ PRESQUE SÉCURISÉ' },
  { gap: 0,  titre: 'PILOTE EXACTEMENT AU SEUIL' },
  { gap: 1,  titre: 'PILOTE JUSTE À L\'EXTÉRIEUR' },
  { gap: 5,  titre: 'PILOTE QUI A BESOIN D\'UN GROS Q4' },
];

for (const c of CASES) {
  const d = at(c.gap);
  if (!d) continue;
  const gap = gapToThreshold(d.position, threshold);

  const run = simulateFromCheckpoint({
    context: ctx, checkpoint: CHECKPOINT, models, threshold,
    focusDriverId: d.driverId, simulations: 10000, seed: SEED,
    rivalIds: state.standings.filter(x => x.driverId !== d.driverId && Math.abs(x.position - threshold) <= 4).map(x => x.driverId),
  });

  const hist = buildHistoricalOutlook({
    observations: historyWithoutThisMeeting, checkpoint: CHECKPOINT, finalRace: ctx.plannedRaceCount,
    driver: { points: d.totalPoints, position: d.position, gap },
    filters: { championshipId: ctx.meeting.championshipId, category: ctx.category },
  });

  const w = whatIfResults({
    context: ctx, checkpoint: CHECKPOINT, models, threshold, focusDriverId: d.driverId,
    raceNum: ctx.plannedRaceCount, simulations: 2000, seed: SEED,
  });
  const target = computeTargetResult(w.entries);
  const gains = marginalGains(w.entries);
  const klass = classifyStrategy({ probability: run.probability, target });

  const reel = raceResultOf(ctx, ctx.plannedRaceCount, d.driverId);
  const fin = finalById.get(d.driverId);
  const qualifie = fin && fin.position <= threshold;

  console.log(`\n${'─'.repeat(76)}`);
  console.log(`${c.titre}`);
  console.log(`${'─'.repeat(76)}`);
  console.log(`#${d.carNumber} ${d.firstName} ${d.lastName} — P${d.position} · ${d.totalPoints} pts · ${formatGap(gap)}`);
  console.log(`\n  HISTORIQUE OBSERVÉ`);
  console.log(`    ${hist.comparable.confidence.showRate ? pct(hist.comparable.rate) : '(n<5)'} sur ${hist.comparable.n} cas comparables · confiance ${hist.comparable.confidence.label}`);
  console.log(`    périmètre : ${hist.comparable.label}`);
  console.log(`\n  SIMULATION MONTE-CARLO (${run.simulations} tirages, graine ${run.seed})`);
  console.log(`    probabilité de qualification : ${pct(run.probability)}  (${run.qualifiedCount}/${run.countedCount})`);
  console.log(`    classement final médian P${run.medianPosition} · score médian ${run.medianPoints} pts`);
  console.log(`    seuil de qualification médian ${run.medianCut} pts (80 % des cas entre ${run.cutRange.low} et ${run.cutRange.high})`);
  const modele = models[d.driverId];
  console.log(`    modèle pilote : force ${modele.mu >= 0 ? '+' : ''}${modele.mu.toFixed(2)} · dispersion ${modele.sigma.toFixed(2)} · incident ${(100 * modele.incidentRate).toFixed(1)} % · ${modele.races} manches observées`);

  console.log(`\n  SI LE PILOTE TERMINE Q4 À…`);
  const show = w.entries.filter(e => e.kind === 'position' && [1, 3, 5, 8, 10, 12, 15, 20].includes(e.position));
  for (const e of show) {
    const g = gains.find(x => x.from === e.position);
    console.log(`    ${e.label.padEnd(4)} → ${pct(e.probability).padStart(7)}` + (g ? `   (gagner une place : ${g.gainPct >= 0 ? '+' : ''}${g.gainPct.toFixed(1)} pt)` : ''));
  }
  for (const e of w.entries.filter(e => e.kind === 'status')) {
    console.log(`    ${e.label.padEnd(4)} → ${pct(e.probability).padStart(7)}`);
  }

  console.log(`\n  INTERPRÉTATION STRATÉGIQUE`);
  console.log(`    résultat cible : ${target.targetLabel} · ${target.statement}`);
  console.log(`    gain moyen à la cible : ${target.averageGainAtTarget?.toFixed(2)} pt/place (seuil ${target.thresholdPct} pt/place)`);
  console.log(`    classification : ${klass.label} — ${klass.reason}`);
  if (run.rivals.length) {
    const top = run.rivals.slice(0, 3).map(r => `#${r.carNumber} ${r.lastName} ${pct(r.probabilityAhead)}`).join(' · ');
    console.log(`    adversaires les plus menaçants : ${top}`);
  }

  console.log(`\n  → CE QUI S'EST RÉELLEMENT PASSÉ EN Q4`);
  console.log(`    ${reel?.status ? reel.status : `P${reel?.position}`} · ${reel?.points} pts marqués`);
  console.log(`    classement final P${fin?.position} avec ${fin?.totalPoints} pts → ${qualifie ? 'QUALIFIÉ' : 'NON QUALIFIÉ'}`);
}
