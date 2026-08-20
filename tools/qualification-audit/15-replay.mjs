/* REPLAY DE VALIDATION — plusieurs meetings réels, rejoués série par série.

   Vérifie sur l'ensemble des meetings terminés que la chaîne complète tient :
   états de manche, mode hybride, certitudes, objectif stratégique. Aucune
   valeur n'est attendue en particulier — ce sont des INVARIANTS qui sont
   contrôlés, ceux qui ne doivent jamais être violés quelles que soient les
   données.

   Lecture seule. Usage : node tools/qualification-audit/15-replay.mjs [maxMeetings] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold } from '../../js/projection/qualificationRules.js';
import { buildObservations } from '../../js/projection/qualificationHistory.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import { simulateFromCheckpoint, realResultsOfRace, forcedConflicts } from '../../js/projection/scenarioSimulator.js';
import { buildRaceCertainties } from '../../js/projection/raceCertainties.js';
import { seriesPlan, buildLiveObjective, mathematicalChronoTarget, provisionalOrder } from '../../js/projection/liveStrategy.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const RAW = { sessions: J('sessions.json'), participants: J('sessionParticipants.json'), meetings: J('meetings.json') };
const ALL = J('results.json');
const champsById = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const ctxOf = (results) => buildGroups({ ...RAW, results })
  .map(g => buildMeetingContext(g, champsById[g.meeting?.championshipId] || null));

const MAX = Number(process.argv[2] || 12);
const SEED = 20260101;
const complets = ctxOf(ALL).filter(c => c.isComplete && c.lastCompletedRace >= 3);

const echecs = [];
const fail = (quoi, ou, detail) => echecs.push(`${ou} — ${quoi}${detail ? ` (${detail})` : ''}`);
let nMeetings = 0, nEtapes = 0, nObjectifs = 0, nCertitudes = 0, nAcquis = 0;

// Base historique de référence, calculée une fois sur les meetings complets.
const baselineComplets = JSON.stringify(
  buildObservations(complets, { championshipsById: champsById, requireComplete: true })
    .map(o => `${o.meetingId}|${o.category}|${o.driverId}|${o.qualified}`).sort());

for (const complet of complets.slice(0, MAX)) {
  const nom = `${complet.meeting?.location}/${complet.category}`;
  const LAST = complet.lastCompletedRace;
  const session = complet.races.find(r => r.num === LAST).sessionId;
  const series = [...new Set(ALL.filter(r => r.sessionId === session).map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b);
  if (series.length < 3) continue;
  nMeetings++;

  const threshold = resolveQualificationThreshold({
    regulation: complet.regulation, observedPhaseCounts: complet.observedPhaseCounts, engagedCount: complet.engagedCount,
  }).threshold;
  if (threshold == null) continue;

  const reellesFinales = new Map(complet.races.find(r => r.num === LAST).rows.map(r => [r.driverId, r]));

  for (let k = 1; k < series.length; k++) {
    const visibles = new Set(series.slice(0, k));
    const results = ALL.filter(r => r.sessionId !== session || visibles.has(r.serie));
    const tous = ctxOf(results);
    const ctx = tous.find(c => c.key === complet.key);
    nEtapes++;
    const ou = `${nom} · ${k}/${series.length} séries`;

    // ── INVARIANT 1 : un meeting en cours n'entre pas dans l'historique ────
    if (ctx.isComplete) fail('meeting en cours considéré comme terminé', ou);
    if (ctx.lastCompletedRace !== LAST - 1) fail('checkpoint incorrect', ou, `attendu Q${LAST - 1}, obtenu Q${ctx.lastCompletedRace}`);
    if (ctx.raceInProgress !== LAST) fail('manche en cours non détectée', ou);
    const obs = buildObservations([ctx], { championshipsById: champsById, requireComplete: true });
    if (obs.length) fail('le meeting en cours produit des observations historiques', ou, `${obs.length}`);

    // ── INVARIANT 2 : la baseline historique ne bouge pas ─────────────────
    const autres = complets.filter(c => c.key !== complet.key);
    const baseline = JSON.stringify(
      buildObservations([...autres, ctx], { championshipsById: champsById, requireComplete: true })
        .map(o => `${o.meetingId}|${o.category}|${o.driverId}|${o.qualified}`).sort());
    const attendu = JSON.stringify(
      buildObservations(autres, { championshipsById: champsById, requireComplete: true })
        .map(o => `${o.meetingId}|${o.category}|${o.driverId}|${o.qualified}`).sort());
    if (baseline !== attendu) fail('la baseline historique change avec le meeting en cours', ou);

    // ── INVARIANT 3 : aucun point de la manche EN COURS dans le classement ─
    // On ne compare pas `mqCount` : il n'est pas incrémenté pour un DNS ou un
    // DSQ, si bien que deux pilotes peuvent légitimement en avoir des valeurs
    // différentes après le même nombre de manches. L'invariant réel est plus
    // direct — la manche en cours ne doit avoir distribué de points à personne.
    const state = buildStateAfterRace(ctx, ctx.lastCompletedRace);
    for (const d of state.standings) {
      if (d.mqPoints && d.mqPoints[LAST] !== undefined) {
        fail('points de la manche en cours comptés dans le classement', ou, `${d.driverId}`);
      }
    }

    const race = ctx.races.find(r => r.num === LAST);
    const reels = realResultsOfRace(ctx, LAST) || {};
    const restants = race.pendingDriverIds;

    // ── INVARIANT 4 : les séries couvrent tout le plateau, sans doublon ───
    const plan = seriesPlan(ctx, LAST);
    const places = plan.series.flatMap(s => s.members);
    if (new Set(places).size !== places.length) fail('un pilote figure dans deux séries', ou);
    const tailles = plan.series.map(s => s.members.length);
    if (tailles.some((t, i) => t > plan.sizes[i])) fail('série plus grande que prévu', ou, tailles.join('/'));

    const { models } = buildDriverModels({
      driverIds: state.standings.map(d => d.driverId),
      observations: collectRaceObservations(tous).filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= ctx.lastCompletedRace),
      scope: { meetingId: ctx.meetingId, year: ctx.meeting?.year, category: ctx.category, circuit: ctx.meeting?.location },
    });

    // Deux pilotes suivis : un déjà passé, un encore à courir.
    const passe = state.standings.find(d => reels[d.driverId]);
    const aVenir = state.standings.filter(d => restants.includes(d.driverId))
      .sort((a, b) => Math.abs(a.position - threshold) - Math.abs(b.position - threshold))[0];

    for (const d of [passe, aVenir].filter(Boolean)) {
      const run = simulateFromCheckpoint({
        context: ctx, checkpoint: ctx.lastCompletedRace, models, threshold,
        focusDriverId: d.driverId, simulations: 1500, seed: SEED, trackRaceOutcome: LAST,
        rivalIds: state.standings.filter(x => x.driverId !== d.driverId && Math.abs(x.position - threshold) <= 5).map(x => x.driverId),
      });
      if (run.probability == null || run.probability < 0 || run.probability > 1) fail('probabilité hors bornes', ou, String(run.probability));

      // ── INVARIANT 5 : bornes de position exactes ──────────────────────
      const cert = buildRaceCertainties({ context: ctx, driverId: d.driverId, threshold, checkpoint: ctx.lastCompletedRace });
      nCertitudes += cert.statements.length;
      const b = cert.bounds;
      if (b && b.hasRun && !b.status) {
        const reelFinal = reellesFinales.get(d.driverId);
        if (reelFinal?.position != null) {
          if (reelFinal.position < b.bestPosition) fail('position finale RÉELLE meilleure que la borne annoncée', ou, `${reelFinal.position} < ${b.bestPosition}`);
          if (reelFinal.position > b.worstPosition) fail('position finale RÉELLE pire que la borne annoncée', ou, `${reelFinal.position} > ${b.worstPosition}`);
        }
        const dist = run.raceOutcome?.positionDistribution || [];
        for (const e of dist) {
          if (e.value < b.bestPosition || e.value > b.worstPosition) fail('simulation hors des bornes annoncées', ou, `P${e.value} ∉ [${b.bestPosition},${b.worstPosition}]`);
        }
      }
      // ── INVARIANT 6 : aucun énoncé de certitude n'est probabiliste ────
      for (const st of cert.statements) {
        if (/%|probab|estim|simulation/i.test(st.text)) fail('énoncé probabiliste dans le bloc CERTITUDES', ou, st.text);
      }
      // ── INVARIANT 7 : un verdict mathématique n'est jamais démenti ────
      if (cert.verdict?.state === 'qualified' && run.probability !== 1) fail('verdict « qualifié » démenti par la simulation', ou, `${run.probability}`);
      if (cert.verdict?.state === 'eliminated' && run.probability !== 0) fail('verdict « éliminé » démenti par la simulation', ou, `${run.probability}`);

      // ── INVARIANT 8 : what-if refusé pour un pilote déjà passé ────────
      if (reels[d.driverId] && !forcedConflicts(ctx, { [LAST]: { [d.driverId]: { position: 1 } } }).length) {
        fail('scénario accepté sur un résultat déjà acquis', ou);
      }

      // ── INVARIANT 9 : objectif cohérent ───────────────────────────────
      const obj = buildLiveObjective({
        context: ctx, checkpoint: ctx.lastCompletedRace, models, threshold,
        driverId: d.driverId, baseRun: run, seed: SEED, simulations: 500,
      });
      nObjectifs++;
      if (!obj) { fail('aucun objectif produit', ou); continue; }
      if (reels[d.driverId] && obj.mode !== 'afterRun') fail('objectif proposé à un pilote déjà passé', ou, obj.mode);
      if (!reels[d.driverId] && obj.mode === 'afterRun') fail('lecture inversée pour un pilote pas encore passé', ou);
      if (obj.mode === 'target') {
        if (obj.probabilityAtTarget == null) fail('cible sans probabilité', ou);
        // Une cible plus exigeante ne peut pas être moins favorable.
        const tri = [...obj.ladder].sort((a, b) => a.provisionalTarget - b.provisionalTarget)
          .filter(e => e.probability != null);
        for (let i = 1; i < tri.length; i++) {
          if (tri[i].probability > tri[i - 1].probability + 0.08) {
            fail('échelle de cibles non monotone', ou, `P${tri[i - 1].provisionalTarget}=${tri[i - 1].probability} < P${tri[i].provisionalTarget}=${tri[i].probability}`);
          }
        }
        // La cible ne peut être « exacte » que si plus personne d'autre ne roule.
        if (obj.exact && obj.pendingOthers > 0) fail('cible annoncée exacte alors que des pilotes doivent rouler', ou);
      }
      if (obj.mode === 'settled') nAcquis++;

      // ── INVARIANT 10 : la cible mathématique tient vraiment ───────────
      if (!reels[d.driverId]) {
        const m = mathematicalChronoTarget({ context: ctx, raceNum: LAST, driverId: d.driverId, threshold, checkpoint: ctx.lastCompletedRace });
        if (m && !m.impossible && !m.unconditional && m.beat != null) {
          const verif = simulateFromCheckpoint({
            context: ctx, checkpoint: ctx.lastCompletedRace, models, threshold,
            focusDriverId: d.driverId, forced: { [LAST]: { [d.driverId]: { ms: m.beat - 1 } } },
            simulations: 600, seed: SEED + 7,
          });
          if (verif.probability !== 1) fail('cible mathématique démentie par la simulation', ou, `${verif.probability}`);
        }
        if (m?.unconditional) {
          const pire = provisionalOrder(ctx, LAST);
          const lent = pire.length ? pire[pire.length - 1].ms + 5000 : null;
          if (lent != null) {
            const verif = simulateFromCheckpoint({
              context: ctx, checkpoint: ctx.lastCompletedRace, models, threshold,
              focusDriverId: d.driverId, forced: { [LAST]: { [d.driverId]: { ms: lent } } },
              simulations: 600, seed: SEED + 7,
            });
            if (verif.probability !== 1) fail('« acquis quel que soit le résultat » démenti', ou, `${verif.probability}`);
          }
        }
      }
    }
  }
}

console.log('═'.repeat(88));
console.log('REPLAY DE VALIDATION');
console.log('═'.repeat(88));
console.log(`  meetings rejoués          : ${nMeetings}`);
console.log(`  étapes de manche testées  : ${nEtapes}`);
console.log(`  objectifs calculés        : ${nObjectifs} (dont ${nAcquis} « qualification acquise »)`);
console.log(`  énoncés de certitude      : ${nCertitudes}`);
console.log(`  baseline historique       : ${baselineComplets.length} caractères, stable`);
console.log(`\n  invariants violés : ${echecs.length}`);
for (const e of echecs.slice(0, 25)) console.log(`    ❌ ${e}`);
if (echecs.length > 25) console.log(`    … et ${echecs.length - 25} autres`);
console.log(echecs.length === 0 ? '\n  ✅ tous les invariants tiennent sur l\'ensemble des meetings rejoués.' : '\n  ❌ replay en échec.');
process.exit(echecs.length ? 1 : 0);
