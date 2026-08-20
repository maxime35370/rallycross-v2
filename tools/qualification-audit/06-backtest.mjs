/* Backtest LOT 2 : la baseline historique du LOT 1 contre le Monte-Carlo.
   N'importe que les modules de l'application. Lecture seule.

   Usage : node tools/qualification-audit/06-backtest.mjs [checkpoint] */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext } from '../../js/projection/qualificationState.js';
import { buildObservations } from '../../js/projection/qualificationHistory.js';
import { runBacktest, LEAKAGE_MODES } from '../../js/projection/qualificationBacktest.js';
import { formatGap } from '../../js/projection/qualificationHistory.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const championshipsById = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const groups = buildGroups({
  sessions: J('sessions.json'), results: J('results.json'),
  participants: J('sessionParticipants.json'), meetings: J('meetings.json'),
});
const contexts = groups.map(g => buildMeetingContext(g, championshipsById[g.meeting?.championshipId] || null));
const observations = buildObservations(contexts, { championshipsById, requireComplete: true });

const checkpoints = process.argv[2] ? [Number(process.argv[2])] : [1, 2, 3];
const pct = v => v == null ? '   n/a' : (100 * v).toFixed(1).padStart(6);
const num = (v, d = 4) => v == null ? 'n/a' : v.toFixed(d);

for (const checkpoint of checkpoints) {
  for (const leakageMode of LEAKAGE_MODES) {
    const t = Date.now();
    const r = runBacktest({ contexts, observations, championshipsById, checkpoint, leakageMode });
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`CHECKPOINT APRÈS Q${checkpoint} — régime « ${leakageMode} » — ${((Date.now() - t) / 1000).toFixed(1)} s`);
    console.log(`${'═'.repeat(78)}`);
    console.log(`${r.groups} meetings×catégorie · ${r.cases} cas pilote · taux de base ${pct(r.baseRate)} %`);
    console.log(`${r.simulations} tirages/meeting · graine ${r.seed} · repli climatologique utilisé ${r.historicalFallbacks} fois`);

    console.log('\n  prédicteur      n     Brier    compétence   justesse@0,5');
    for (const [name, e] of [['climatologie', r.climatology], ['historique', r.historical], ['Monte-Carlo', r.monteCarlo]]) {
      console.log(`  ${name.padEnd(14)}${String(e.n).padStart(4)}   ${num(e.brier).padStart(7)}   `
        + `${(e.skill == null ? '   —  ' : (e.skill >= 0 ? '+' : '') + (100 * e.skill).toFixed(1) + ' %').padStart(9)}   `
        + `${e.accuracy ? pct(e.accuracy.rate) + ' %' : '   n/a'}`);
    }
    console.log(`\n  VERDICT : ${r.verdict.label}`);

    console.log('\n  Calibration (annoncé → observé) :');
    console.log('    tranche        historique              Monte-Carlo');
    for (let i = 0; i < r.historical.calibration.length; i++) {
      const h = r.historical.calibration[i], m = r.monteCarlo.calibration[i];
      if (!h.n && !m.n) continue;
      const cell = (b) => b.n ? `n=${String(b.n).padStart(3)}  annoncé ${pct(b.meanPredicted)} → observé ${pct(b.observedRate)}` : '           —';
      console.log(`    ${h.label.padEnd(12)} ${cell(h).padEnd(23)} ${cell(m)}`);
    }

    console.log('\n  Brier par écart au seuil (plus bas = meilleur) :');
    for (const g of r.byGap) {
      if (g.n < 5) continue;
      const better = g.monteCarlo < g.historical ? 'MC' : g.monteCarlo > g.historical ? 'hist' : '=';
      console.log(`    ${formatGap(g.gap).padEnd(14)} n=${String(g.n).padStart(3)}  observé ${pct(g.observedRate)} %  `
        + `hist ${num(g.historical)}  MC ${num(g.monteCarlo)}   → ${better}`);
    }

    console.log('\n  Brier par catégorie (n >= 30) :');
    for (const c of r.byCategory) {
      if (c.n < 30) continue;
      const better = c.monteCarlo < c.historical ? 'MC' : 'hist';
      console.log(`    ${c.key.padEnd(38)} n=${String(c.n).padStart(3)}  hist ${num(c.historical)}  MC ${num(c.monteCarlo)}  → ${better}`);
    }
  }
}
