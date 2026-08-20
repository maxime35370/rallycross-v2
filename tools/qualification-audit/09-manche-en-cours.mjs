/* LOT 4 — PROJECTION PENDANT UNE MANCHE EN COURS.

   Le scénario est reconstitué à partir d'un meeting RÉEL : on masque les
   résultats de la dernière manche, puis on les révèle série par série, dans
   l'ordre où ils sont réellement tombés ce jour-là. Aucun chrono n'est
   inventé — seule change la quantité d'information disponible.

   À chaque étape : résultats réels connus, pilotes restants, position
   provisoire, meilleure et pire position encore possibles, probabilité de
   qualification, et les certitudes mathématiques éventuelles.

   Lecture seule.
   Usage : node tools/qualification-audit/09-manche-en-cours.mjs [meeting] [catégorie] [dossard] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace, raceResultOf } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold, gapToThreshold } from '../../js/projection/qualificationRules.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import { simulateFromCheckpoint, realResultsOfRace, hasRealResult } from '../../js/projection/scenarioSimulator.js';
import { buildRaceCertainties } from '../../js/projection/raceCertainties.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const RAW = {
  sessions: J('sessions.json'), results: J('results.json'),
  participants: J('sessionParticipants.json'), meetings: J('meetings.json'),
};
const championshipsById = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const regOf = g => championshipsById[g.meeting?.championshipId] || null;

/** Contexte complet, toutes données visibles. */
const buildAll = (results) => buildGroups({ ...RAW, results }).map(g => buildMeetingContext(g, regOf(g)));

const LIEU = process.argv[2] || 'Kerlabo';
const CAT = process.argv[3] || 'D3';
const full = buildAll(RAW.results).find(c => c.meeting?.location === LIEU && c.category === CAT);
if (!full) { console.error('meeting/catégorie introuvable'); process.exit(1); }

const LAST = full.lastCompletedRace;
const lastSession = full.races.find(r => r.num === LAST).sessionId;
const lastResults = RAW.results.filter(r => r.sessionId === lastSession);

// Ordre de passage réel : par série, puis par couloir quand il est renseigné.
const series = [...new Set(lastResults.map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b);
if (!series.length) { console.error(`séries non renseignées sur la manche ${LAST} : impossible de rejouer le direct`); process.exit(1); }

const SEED = 20260101, SIMS = 6000;
const pct = v => v == null ? '—' : `${(100 * v).toFixed(1).replace('.', ',')} %`;
const nom = d => `#${d?.carNumber} ${d?.firstName || ''} ${d?.lastName || ''}`.trim();

// Pilote suivi : celui qui est le plus près du seuil avant la dernière manche,
// c'est-à-dire celui pour qui l'information a le plus de valeur.
const thresholdInfo = resolveQualificationThreshold({
  regulation: full.regulation, observedPhaseCounts: full.observedPhaseCounts, engagedCount: full.engagedCount,
});
const threshold = thresholdInfo.threshold;
const avant = buildStateAfterRace(full, LAST - 1);
const cible = process.argv[4]
  ? avant.standings.find(d => String(d.carNumber) === String(process.argv[4]))
  : avant.standings.find(d => d.position === threshold) || avant.standings[0];

console.log('═'.repeat(84));
console.log(`${full.meeting.location} — ${full.category} — manche ${LAST} rejouée EN DIRECT`);
console.log(`${full.engagedCount} engagés · ${threshold} places qualificatives · ${series.length} séries en manche ${LAST}`);
console.log(`pilote suivi : ${nom(cible)} — P${cible.position} · ${cible.totalPoints} pts avant la manche ${LAST}`);
console.log(`${SIMS} tirages · graine ${SEED} · aucune donnée postérieure au checkpoint n'entre dans le modèle`);
console.log('═'.repeat(84));

/** Étapes : rien, puis chaque série cumulée, puis la manche complète. */
const etapes = [
  { label: `avant la manche ${LAST}`, series: [] },
  ...series.map((s, i) => ({ label: `après la série ${s}`, series: series.slice(0, i + 1) })),
];
etapes[etapes.length - 1].label = `manche ${LAST} terminée`;
if (series.length > 2) etapes[etapes.length - 2].label = `avant la dernière série`;

for (const etape of etapes) {
  // Masquage : on ne conserve de la dernière manche que les séries révélées.
  const visibles = new Set(etape.series);
  const results = RAW.results.filter(r =>
    r.sessionId !== lastSession || visibles.has(r.serie));
  const ctx = buildAll(results).find(c => c.key === full.key);

  const checkpoint = ctx.lastCompletedRace;
  const state = buildStateAfterRace(ctx, checkpoint);
  const reels = realResultsOfRace(ctx, LAST) || {};
  const race = ctx.races.find(r => r.num === LAST);

  const models = buildDriverModels({
    driverIds: state.standings.map(d => d.driverId),
    observations: collectRaceObservations(buildAll(results))
      .filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= checkpoint),
    scope: { meetingId: ctx.meetingId, year: ctx.meeting.year, category: ctx.category, circuit: ctx.meeting.location },
  }).models;

  const run = simulateFromCheckpoint({
    context: ctx, checkpoint, models, threshold, focusDriverId: cible.driverId,
    simulations: SIMS, seed: SEED,
  });
  const cert = buildRaceCertainties({ context: ctx, driverId: cible.driverId, threshold, checkpoint });
  const row = state.byDriverId[cible.driverId];

  console.log(`\n${'─'.repeat(84)}`);
  console.log(`ÉTAPE — ${etape.label.toUpperCase()}`);
  console.log('─'.repeat(84));
  console.log(`  état du meeting : dernière manche terminée = Q${checkpoint || '—'} · manche en cours = ${ctx.raceInProgress ? 'Q' + ctx.raceInProgress : 'aucune'}`);
  console.log(`  résultats réels connus en manche ${LAST} : ${race.ranCount} / ${race.engagedCount}`);
  if (cert.description) console.log(`  ${cert.description.series}`);

  if (race.pendingDriverIds.length) {
    const restants = race.pendingDriverIds.slice(0, 8).map(id => nom(ctx.driversById[id]));
    console.log(`  pilotes restant à courir (${race.pendingDriverIds.length}) : ${restants.join(' · ')}${race.pendingDriverIds.length > 8 ? ' …' : ''}`);
  }

  console.log(`\n  CLASSEMENT AU CHECKPOINT (manches terminées uniquement)`);
  console.log(`    ${nom(cible)} — P${row?.position ?? '—'} · ${row?.totalPoints ?? '—'} pts · ${row ? gapToThreshold(row.position, threshold) >= 0 ? '+' : '' : ''}${row ? gapToThreshold(row.position, threshold) : '—'} par rapport au seuil`);

  const b = cert.bounds;
  if (b) {
    console.log(`\n  CERTITUDES — manche ${LAST}`);
    console.log(`    position provisoire      : ${b.hasRun ? (b.status || 'P' + b.provisionalPosition) : 'pas encore passé'}`);
    console.log(`    meilleure position possible : P${b.bestPosition}`);
    console.log(`    pire position théorique     : P${b.worstPosition}`);
    if (cert.points) {
      console.log(`    points de la manche         : ${cert.points.min === cert.points.max ? cert.points.min : `${cert.points.min} à ${cert.points.max}`}`);
    }
    for (const s of cert.statements) console.log(`    ✓ ${s.text}`);
    if (!cert.statements.length) console.log('    (aucun énoncé démontrable à ce stade)');
    if (cert.stillAProjection) console.log('    → une manche reste à disputer : on reste sur SIMULATION / PROBABILITÉ.');
  } else {
    console.log(`\n  CERTITUDES — aucune manche en cours : rien à borner.`);
  }

  console.log(`\n  SIMULATION`);
  if (run.deterministic) {
    console.log(`    plus rien à simuler : ${run.probability === 1 ? 'QUALIFIÉ' : 'NON QUALIFIÉ'} (fait établi, 0 tirage)`);
  } else {
    console.log(`    probabilité de qualification : ${pct(run.probability)} (${run.qualifiedCount}/${run.countedCount} tirages)`);
    console.log(`    classement final médian P${run.medianPosition} · score médian ${run.medianPoints} pts`);
    console.log(`    manches simulées : ${run.remainingRaces.map(n => 'Q' + n).join(', ')} — dont ${race.ranCount} résultat(s) réel(s) repris tels quels`);
    console.log(`    scénario what-if sur la manche ${LAST} : ${hasRealResult(ctx, LAST, cible.driverId) ? 'INDISPONIBLE (résultat déjà acquis)' : 'disponible'}`);
  }
}

const reel = raceResultOf(full, LAST, cible.driverId);
const fin = buildStateAfterRace(full, LAST).byDriverId[cible.driverId];
console.log(`\n${'═'.repeat(84)}`);
console.log(`CE QUI S'EST RÉELLEMENT PASSÉ`);
console.log(`  manche ${LAST} : ${reel?.status || 'P' + reel?.position} (${reel?.points} pts)`);
console.log(`  classement final P${fin?.position} avec ${fin?.totalPoints} pts → ${fin && fin.position <= threshold ? 'QUALIFIÉ' : 'NON QUALIFIÉ'}`);
console.log('═'.repeat(84));
