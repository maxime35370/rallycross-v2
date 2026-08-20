/* Valide les modules de projection sur les données réelles extraites par
   fetch.mjs. N'importe QUE les modules de l'application : ce qui est mesuré
   ici est ce que l'interface affichera. Lecture seule. */

import { readFileSync } from 'node:fs';
import { buildGroups, buildMeetingContext, buildStateAfterRace } from '../../js/projection/qualificationState.js';
import {
  buildObservations, filterObservations, aggregateByGap, aggregateByPoints,
  resultDistribution, conditionalQualificationByResult, buildHistoricalOutlook,
  formatGap,
} from '../../js/projection/qualificationHistory.js';
import { buildDataQualityReport } from '../../js/projection/dataQuality.js';
import { DEFAULT_MIN_CLASSIFIED_RACES } from '../../js/calc.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const meetings = J('meetings.json'), sessions = J('sessions.json'),
      results = J('results.json'), participants = J('sessionParticipants.json'),
      champs = J('championships.json');
const championshipsById = Object.fromEntries(champs.map(c => [c.id, c]));

const groups = buildGroups({ sessions, results, participants, meetings });
const contexts = groups.map(g => buildMeetingContext(g, championshipsById[g.meeting?.championshipId] || null));
const report = buildDataQualityReport(contexts, { championshipsById });
const observations = buildObservations(contexts, { championshipsById, requireComplete: true });
const usable = filterObservations(observations);

const pct = (r) => r == null ? '  n/a' : (100 * r).toFixed(1).padStart(5);

console.log('═══ QUALITÉ DES DONNÉES ═══');
const s = report.summary;
console.log(`groupes meeting × catégorie : ${s.totalGroups}`);
console.log(`  complets ${s.completeGroups} · partiels ${s.partialGroups} · vides ${s.emptyGroups}`);
console.log(`  dont triviaux ${s.trivialGroups} · exploitables ${s.exploitableGroups}`);
console.log(`meetings complets ${s.meetings} · saisons ${s.seasons.join(', ')} · championnats ${s.championships.join(' / ')}`);
console.log(`provenance du seuil : ${JSON.stringify(s.thresholdSources)}`);
console.log(`divergences règle / réalité : ${s.divergenceCount}`);
console.log(`blocages règlement : ${report.blockers.length}`);

console.log('\n── Couverture des checkpoints (lignes pilote reconstruites) ──');
console.log(`  règle app (min ${DEFAULT_MIN_CLASSIFIED_RACES} manches) : ${JSON.stringify(s.checkpointCoverage.withDefaultRule)}`);
console.log(`  règle projection (min 1)          : ${JSON.stringify(s.checkpointCoverage.withProjectionRule)}`);

console.log('\n── Divergences détaillées ──');
for (const d of report.divergences) {
  console.log(`  ${String(d.meetingLabel).padEnd(24)} ${String(d.category).padEnd(11)} #${d.carNumber ?? '?'} ${d.lastName ?? '?'} — ${d.description}`);
}

console.log(`\n═══ OBSERVATIONS ═══`);
console.log(`total ${observations.length} · exploitables (hors triviaux) ${usable.length}`);

for (const cp of [1, 2, 3]) {
  const agg = aggregateByGap(usable, cp);
  console.log(`\n── Taux de qualification finale par ÉCART AU SEUIL, checkpoint après Q${cp} (${agg.total} cas) ──`);
  for (const r of agg.rows) {
    if (r.gap < -6 || r.gap > 6) continue;
    const rate = r.confidence.showRate ? `${pct(r.rate)} %` : '  (n<5)';
    console.log(`  ${formatGap(r.gap).padEnd(12)} n=${String(r.n).padStart(4)}  qual=${String(r.qualified).padStart(4)}  ${rate}   confiance ${r.confidence.label}`);
  }
}

console.log('\n═══ AXE POINTS — catégorie fixée (tranches adaptatives) ═══');
for (const [champId, cat] of [['champ_1775737455330', 'Super1600'], ['champ_1775771412329', 'RX1']]) {
  const filters = { championshipId: champId, category: cat };
  const sub = filterObservations(usable, filters);
  const agg = aggregateByPoints(sub, 3, { filters });
  console.log(`\n── ${championshipsById[champId].name} / ${cat} — points après Q3 (${agg.total} cas, comparable=${agg.comparable}) ──`);
  for (const r of agg.rows) {
    const rate = r.confidence.showRate ? `${pct(r.rate)} %` : '  (n<5)';
    console.log(`  ${r.label.padEnd(14)} n=${String(r.n).padStart(3)}  qual=${String(r.qualified).padStart(3)}  ${rate}   confiance ${r.confidence.label}`);
  }
  const sansFiltre = aggregateByPoints(usable, 3, { filters: {} });
  console.log(`  (sans périmètre fixé : comparable=${sansFiltre.comparable} → avertissement affiché)`);
}

console.log('\n═══ CE QU\'ONT FAIT EN Q4 LES PILOTES « AU SEUIL » APRÈS Q3 ═══');
const auSeuil = usable.filter(o => o.checkpoints?.[3]?.gap === 0);
const dist = resultDistribution(auSeuil, 4);
console.log(`n=${auSeuil.length} · place Q4 médiane ${dist.median} · moyenne ${dist.mean?.toFixed(1)} · sans place (DNF/DNS/DSQ) ${dist.withStatus}`);
for (const b of dist.byBucket) console.log(`  ${b.label.padEnd(18)} n=${String(b.n).padStart(3)}  ${pct(b.share)} %`);
console.log('  taux de qualification finale selon le résultat obtenu en Q4 :');
for (const c of conditionalQualificationByResult(auSeuil, 4)) {
  const rate = c.confidence.showRate ? `${pct(c.rate)} %` : '  (n<5)';
  console.log(`    ${c.label.padEnd(18)} n=${String(c.n).padStart(3)}  qual=${String(c.qualified).padStart(3)}  ${rate}   confiance ${c.confidence.label}`);
}

console.log('\n═══ EXEMPLE DE LECTURE EN SITUATION ═══');
// On rejoue un meeting réel comme s'il était en cours après Q3, en n'utilisant
// que les autres meetings comme historique — exactement ce que fera l'UI.
const ctx = contexts.find(c => c.meetingId && c.category === 'Super1600'
  && c.meeting?.location === 'Kerlabo');
if (ctx) {
  const st3 = buildStateAfterRace(ctx, 3);
  const threshold = report.groups.find(g => g.key === ctx.key).threshold;
  const historique = usable.filter(o => o.meetingId !== ctx.meetingId);
  console.log(`${ctx.meeting.location} / ${ctx.category} — après Q3, ${st3.count} pilotes, seuil ${threshold}`);
  for (const pos of [14, 16, 17, 19]) {
    const d = st3.standings.find(x => x.position === pos);
    if (!d) continue;
    const gap = d.position - threshold;
    const out = buildHistoricalOutlook({
      observations: historique, checkpoint: 3, finalRace: 4,
      driver: { points: d.totalPoints, position: d.position, gap },
      filters: { championshipId: ctx.meeting.championshipId, category: ctx.category },
    });
    const c = out.comparable;
    const rate = c.confidence.showRate ? `${pct(c.rate)} %` : '(n<5)';
    console.log(`  P${String(pos).padStart(2)} #${String(d.carNumber).padEnd(3)} ${String(d.lastName).padEnd(14)} ${String(d.totalPoints).padStart(3)} pts  écart ${formatGap(gap).padEnd(11)} → historique ${rate} sur ${c.n} cas (${c.strategy}, confiance ${c.confidence.label})`);
  }
}
