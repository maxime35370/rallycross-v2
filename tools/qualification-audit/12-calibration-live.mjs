/* CALIBRATION DU MODE HYBRIDE — les pilotes déjà passés sont-ils classés à leur
   juste place ?

   Protocole : sur chaque meeting TERMINÉ, on masque toutes les séries de la
   dernière manche sauf les premières, on simule la fin de manche, et on compare
   la position finale RÉELLE de chaque pilote déjà passé à la distribution de ses
   positions simulées.

   Deux mesures :
     · BIAIS — écart moyen entre position réelle et position simulée médiane.
       Un biais négatif signifie que le moteur classe les pilotes déjà passés
       trop bien, donc qu'il sous-estime les pilotes restants.
     · COUVERTURE — part des cas où la position réelle tombe dans l'intervalle
       simulé à 80 %. Une couverture correcte vaut ≈ 80 %.

   Les deux méthodes d'échelle de temps sont comparées, parce que c'est
   exactement là que se jouait le défaut.

   Lecture seule. Usage : node tools/qualification-audit/12-calibration-live.mjs [séries] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext } from '../../js/projection/qualificationState.js';
import { collectRaceObservations, buildDriverModels, latentFromPosition } from '../../js/projection/driverPerformanceModel.js';
import {
  simulateRaceRows, makeDrawBuffers, drawRace, timeScaleOf,
  entrantsOfRace, realResultsOfRace,
} from '../../js/projection/scenarioSimulator.js';
import { createRng } from '../../js/projection/monteCarloEngine.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const RAW = { sessions: J('sessions.json'), participants: J('sessionParticipants.json'), meetings: J('meetings.json') };
const ALL = J('results.json');
const champs = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const ctxOf = (results) => buildGroups({ ...RAW, results })
  .map(g => buildMeetingContext(g, champs[g.meeting?.championshipId] || null));

const SERIES_REVELEES = Number(process.argv[2] || 1);
const TIRAGES = 400;
const contextsComplets = ctxOf(ALL);

/**
 * Ancienne méthode : deux points seulement (premier et dernier finisseur), et
 * rang rapporté au nombre d'ENGAGÉS au lieu du nombre de finisseurs observés.
 * Reproduite ici pour que la comparaison soit vérifiable, pas déclarative.
 */
function echelleAncienne(context, upToRace) {
  const races = (context?.races || []).filter(r => r.hasResults && r.num <= upToRace).sort((a, b) => b.num - a.num);
  for (const race of races) {
    const f = race.rows.filter(r => r.ms != null && !r.status && r.position != null).sort((a, b) => a.position - b.position);
    if (f.length < 2) continue;
    const first = f[0], last = f[f.length - 1];
    const dz = (latentFromPosition(last.position, race.engagedCount) ?? 0) - (latentFromPosition(first.position, race.engagedCount) ?? 0);
    const dms = last.ms - first.ms;
    if (dz > 1e-6 && dms > 0) return { baseMs: first.ms, msPerZ: dms / dz, source: race.num };
  }
  return { baseMs: 60000, msPerZ: 1000, source: null };
}

const mesures = { ancienne: [], nouvelle: [] };

for (const complet of contextsComplets) {
  if (!complet.isComplete || complet.lastCompletedRace < 2) continue;
  const LAST = complet.lastCompletedRace;
  const session = complet.races.find(r => r.num === LAST).sessionId;
  const lastResults = ALL.filter(r => r.sessionId === session);
  const series = [...new Set(lastResults.map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b);
  if (series.length <= SERIES_REVELEES) continue;

  // Positions finales RÉELLES, référence de vérité.
  const reelles = new Map(complet.races.find(r => r.num === LAST).rows
    .filter(r => r.position != null && !r.status).map(r => [r.driverId, r.position]));

  const visibles = new Set(series.slice(0, SERIES_REVELEES));
  const tronque = ALL.filter(r => r.sessionId !== session || visibles.has(r.serie));
  const ctx = ctxOf(tronque).find(c => c.key === complet.key);
  const cp = ctx.lastCompletedRace;
  if (cp !== LAST - 1) continue;

  const ids = entrantsOfRace(ctx, LAST, []);
  const { models } = buildDriverModels({
    driverIds: ids,
    observations: collectRaceObservations(ctxOf(tronque))
      .filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= cp),
    scope: { meetingId: ctx.meetingId, year: ctx.meeting?.year, category: ctx.category, circuit: ctx.meeting?.location },
  });

  const race = {
    num: LAST, ids,
    participants: ids.map(id => ({ driverId: id, ...(ctx.driversById[id] || {}) })),
    real: realResultsOfRace(ctx, LAST),
  };
  if (!race.real) continue;
  const dejaPasses = Object.keys(race.real).filter(id => race.real[id].ms != null);

  for (const [nom, scale] of [
    ['ancienne', echelleAncienne(ctx, LAST)],
    ['nouvelle', timeScaleOf(ctx, LAST, { models })],
  ]) {
    const bufs = makeDrawBuffers([race]);
    const rng = createRng(777);
    const positions = new Map(dejaPasses.map(id => [id, []]));
    for (let k = 0; k < TIRAGES; k++) {
      drawRace(rng, race, bufs[0]);
      const rows = simulateRaceRows(race, bufs[0], models, null, scale, ctx.regulation);
      for (const id of dejaPasses) {
        const row = rows.find(r => r.driverId === id);
        if (row?.position != null) positions.get(id).push(row.position);
      }
    }
    for (const id of dejaPasses) {
      const reel = reelles.get(id);
      const list = positions.get(id).sort((a, b) => a - b);
      if (reel == null || !list.length) continue;
      const q = (t) => list[Math.min(list.length - 1, Math.floor(t * list.length))];
      mesures[nom].push({ reel, mediane: q(0.5), bas: q(0.1), haut: q(0.9) });
    }
  }
}

const moy = a => a.reduce((s, x) => s + x, 0) / a.length;
console.log('═'.repeat(92));
console.log(`CALIBRATION DU MODE HYBRIDE — ${SERIES_REVELEES} série(s) révélée(s) · ${TIRAGES} tirages`);
console.log(`${mesures.nouvelle.length} pilotes déjà passés, sur les meetings terminés`);
console.log('═'.repeat(92));
console.log('\n  méthode d\'échelle      biais moyen   biais médian   couverture 80 %   |biais| moyen');
for (const nom of ['ancienne', 'nouvelle']) {
  const m = mesures[nom];
  if (!m.length) continue;
  const ecarts = m.map(x => x.mediane - x.reel);
  const couv = m.filter(x => x.reel >= x.bas && x.reel <= x.haut).length / m.length;
  const tri = [...ecarts].sort((a, b) => a - b);
  console.log(`  ${nom.padEnd(22)} ${moy(ecarts).toFixed(2).padStart(9)}    ${String(tri[Math.floor(tri.length / 2)]).padStart(9)}     ` +
    `${(100 * couv).toFixed(1).padStart(9)} %     ${moy(ecarts.map(Math.abs)).toFixed(2).padStart(8)}`);
}
console.log('\n  Un biais NÉGATIF signifie que le moteur classe les pilotes déjà passés MIEUX');
console.log('  que la réalité — donc qu\'il simule les pilotes restants trop lentement.');
console.log('  Couverture attendue pour un intervalle à 80 % : environ 80 %.');
