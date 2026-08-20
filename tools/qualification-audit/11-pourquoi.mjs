/* POURQUOI LA PROBABILITÉ A-T-ELLE CHANGÉ ?

   Décompose, série par série, l'évolution de la probabilité de qualification
   d'un pilote pendant une manche en cours.

   L'attribution n'est PAS une corrélation : pour chaque pilote ayant couru, on
   recalcule la probabilité dans un monde où ce seul résultat serait encore
   inconnu, toutes choses égales par ailleurs (mêmes tirages, même graine).
   L'écart mesure donc l'effet propre de ce résultat, dans le modèle.

   Les effets ne s'additionnent pas exactement : deux résultats interagissent.
   Le résidu est affiché tel quel plutôt que réparti arbitrairement.

   Lecture seule.
   Usage : node tools/qualification-audit/11-pourquoi.mjs [lieu] [catégorie] [dossard] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../../js/projection/qualificationState.js';
import { resolveQualificationThreshold } from '../../js/projection/qualificationRules.js';
import { collectRaceObservations, buildDriverModels } from '../../js/projection/driverPerformanceModel.js';
import {
  simulateFromCheckpoint, simulateRaceRows, makeDrawBuffers, drawRace,
  timeScaleOf, entrantsOfRace, realResultsOfRace,
} from '../../js/projection/scenarioSimulator.js';
import { createRng } from '../../js/projection/monteCarloEngine.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const RAW = {
  sessions: J('sessions.json'), participants: J('sessionParticipants.json'), meetings: J('meetings.json'),
};
const ALL_RESULTS = J('results.json');
const champs = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const ctxOf = (results) => buildGroups({ ...RAW, results })
  .map(g => buildMeetingContext(g, champs[g.meeting?.championshipId] || null));

const LIEU = process.argv[2] || 'Kerlabo';
const CAT = process.argv[3] || 'D3';
const SEED = 20260101, SIMS = 20000;

const full = ctxOf(ALL_RESULTS).find(c => c.meeting?.location === LIEU && c.category === CAT);
const LAST = full.lastCompletedRace;
const session = full.races.find(r => r.num === LAST).sessionId;
const lastResults = ALL_RESULTS.filter(r => r.sessionId === session);
const seriesNums = [...new Set(lastResults.map(r => r.serie).filter(s => s != null))].sort((a, b) => a - b);

const threshold = resolveQualificationThreshold({
  regulation: full.regulation, observedPhaseCounts: full.observedPhaseCounts, engagedCount: full.engagedCount,
}).threshold;

const avant = buildStateAfterRace(full, LAST - 1);
const cible = process.argv[4]
  ? avant.standings.find(d => String(d.carNumber) === String(process.argv[4]))
  : avant.standings.find(d => d.position === threshold);

const nom = id => {
  const d = full.driversById[id];
  return `#${String(d?.carNumber ?? '?').padStart(3)} ${(d?.lastName || '').slice(0, 14)}`;
};
const pct = v => v == null ? '—' : `${(100 * v).toFixed(1).replace('.', ',')} %`;
const chrono = ms => ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;

/** Jeu de résultats où seules les séries listées de la dernière manche sont visibles. */
const visible = (series, exclureIds = []) => ALL_RESULTS.filter(r =>
  r.sessionId !== session
  || (series.includes(r.serie) && !exclureIds.includes(r.driverId)));

/** Probabilité de qualification du pilote suivi, dans un état donné. */
function proba(results) {
  const ctx = ctxOf(results).find(c => c.key === full.key);
  const checkpoint = ctx.lastCompletedRace;
  const state = buildStateAfterRace(ctx, checkpoint);
  const { models } = buildDriverModels({
    driverIds: state.standings.map(d => d.driverId),
    observations: collectRaceObservations(ctxOf(results))
      .filter(o => o.meetingId !== ctx.meetingId || o.raceNum <= checkpoint),
    scope: { meetingId: ctx.meetingId, year: ctx.meeting.year, category: ctx.category, circuit: ctx.meeting.location },
  });
  const run = simulateFromCheckpoint({
    context: ctx, checkpoint, models, threshold, focusDriverId: cible.driverId,
    simulations: SIMS, seed: SEED, trackAllDrivers: true,
  });
  return { run, ctx, state, models, p: run.probability };
}

/**
 * Position FINALE médiane, dans la manche en cours, de chaque pilote déjà passé.
 * Une position provisoire n'est pas une position finale : les pilotes restants
 * vont s'intercaler. C'est cette valeur-là qui dit ce que vaut vraiment le
 * chrono d'un pilote, et c'est elle qui pèse sur la projection.
 */
function positionsFinalesMedianes(etat) {
  const { ctx, models } = etat;
  const real = realResultsOfRace(ctx, LAST);
  if (!real) return new Map();
  const ids = entrantsOfRace(ctx, LAST, []);
  const race = {
    num: LAST, ids,
    participants: ids.map(id => ({ driverId: id, ...(ctx.driversById[id] || {}) })),
    real,
  };
  const scale = timeScaleOf(ctx, LAST, { models });
  const bufs = makeDrawBuffers([race]);
  const rng = createRng(SEED);
  const acc = new Map(Object.keys(real).map(id => [id, []]));
  for (let k = 0; k < 400; k++) {
    drawRace(rng, race, bufs[0]);
    const rows = simulateRaceRows(race, bufs[0], models, null, scale, ctx.regulation);
    for (const id of acc.keys()) {
      const row = rows.find(r => r.driverId === id);
      if (row) acc.get(id).push({ position: row.position, points: row.points });
    }
  }
  const out = new Map();
  for (const [id, list] of acc) {
    const pos = list.map(x => x.position).sort((a, b) => a - b);
    const pts = list.map(x => x.points).sort((a, b) => a - b);
    out.set(id, { position: pos[Math.floor(pos.length / 2)], points: pts[Math.floor(pts.length / 2)] });
  }
  return out;
}

console.log('═'.repeat(96));
console.log(`POURQUOI LA PROBABILITÉ CHANGE — ${full.meeting.location} / ${full.category}, manche ${LAST}`);
console.log(`pilote suivi : ${nom(cible.driverId)} — P${cible.position} · ${cible.totalPoints} pts avant Q${LAST}`);
console.log(`${full.engagedCount} engagés · ${threshold} places · ${SIMS} tirages · graine ${SEED}`);
console.log('═'.repeat(96));

let precedent = null;
for (let k = 0; k <= seriesNums.length; k++) {
  const series = seriesNums.slice(0, k);
  const etat = proba(visible(series));
  const label = k === 0 ? `avant Q${LAST}` : `après la série ${seriesNums[k - 1]}`;

  console.log(`\n${'─'.repeat(96)}`);
  console.log(`${label.toUpperCase()}  —  probabilité ${pct(etat.p)}` +
    (precedent ? `   (variation ${((etat.p - precedent.p) * 100 >= 0 ? '+' : '')}${((etat.p - precedent.p) * 100).toFixed(1).replace('.', ',')} points)` : ''));
  console.log('─'.repeat(96));

  if (k > 0) {
    const serie = seriesNums[k - 1];
    const coureurs = lastResults.filter(r => r.serie === serie);
    const etatAvant = precedent;

    const medianes = positionsFinalesMedianes(etat);
    console.log(`\n  PILOTES DE LA SÉRIE ${serie} — ce qu'ils ont réellement fait`);
    console.log(`  pilote               avant Q${LAST}      chrono Q${LAST}    Q${LAST} provisoire   Q${LAST} finale projetée   total projeté`);
    for (const r of coureurs) {
      const av = etatAvant.state.byDriverId[r.driverId];
      const ap = etat.ctx.races.find(x => x.num === LAST).rows.find(x => x.driverId === r.driverId);
      const med = medianes.get(r.driverId);
      const total = (av?.totalPoints ?? 0) + (med?.points ?? ap?.points ?? 0);
      const concurrent = (av?.totalPoints ?? 0) < (cible.totalPoints ?? 0) ? 'derrière' : 'devant';
      console.log(`  ${nom(r.driverId).padEnd(19)} P${String(av?.position ?? '—').padStart(2)} ${String(av?.totalPoints ?? '—').padStart(3)} pts` +
        `   ${chrono(ap?.ms).padStart(9)}    ${(ap?.status || 'P' + ap?.position).padStart(6)}` +
        `        ${(med ? 'P' + med.position + '  ' + med.points + ' pts' : '—').padStart(12)}` +
        `       ${String(total).padStart(4)} pts  (${concurrent})`);
    }

    // ── Attribution contre-factuelle ─────────────────────────────────────
    console.log(`\n  EFFET PROPRE DE CHAQUE RÉSULTAT (probabilité recalculée sans ce seul résultat)`);
    const effets = [];
    for (const r of coureurs) {
      const sans = proba(visible(series, [r.driverId]));
      effets.push({ driverId: r.driverId, delta: etat.p - sans.p, sans: sans.p });
    }
    effets.sort((a, b) => a.delta - b.delta);
    for (const e of effets) {
      const signe = e.delta >= 0 ? '+' : '';
      const sens = Math.abs(e.delta) < 0.005 ? 'effet négligeable'
        : e.delta < 0 ? 'DÉFAVORABLE au pilote suivi' : 'favorable au pilote suivi';
      console.log(`  ${nom(e.driverId).padEnd(19)} ${signe}${(100 * e.delta).toFixed(1).padStart(6)} pt   (sans ce résultat : ${pct(e.sans)})   ${sens}`);
    }
    const somme = effets.reduce((s, e) => s + e.delta, 0);
    const total = etat.p - etatAvant.p;
    console.log(`\n  somme des effets propres : ${(100 * somme).toFixed(1)} pt · variation observée : ${(100 * total).toFixed(1)} pt` +
      ` · interaction non attribuable : ${(100 * (total - somme)).toFixed(1)} pt`);
  }

  precedent = etat;
}

console.log(`\n${'═'.repeat(96)}`);
