/* AUDIT — traitement des statuts DNF / DNS / DSQ / DSQ_RACE.

   Vérifie, pour CHAQUE règlement réellement présent dans Rallycross V2, que le
   simulateur applique exactement le même barème que l'application, sur
   plusieurs tailles de plateau.

   Lecture seule. Usage : node tools/qualification-audit/10-statuts.mjs */

import { readFileSync } from 'node:fs';
import { buildMqStandings, calcStatusPoints, mqPoints } from '../../js/calc.js';
import { simulateRaceRows, makeDrawBuffers } from '../../js/projection/scenarioSimulator.js';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const champs = J('championships.json');
const results = J('results.json');
const STATUTS = ['DNF', 'DNS', 'DSQ', 'DSQ_RACE'];
const TAILLES = [8, 12, 16, 20, 24, 28, 30, 34, 40];

const decrire = (rule) => rule
  ? (rule.mode === 'engaged_offset'
      ? `barème appliqué à la position (engagés + ${rule.offset ?? 1})`
      : `valeur fixe : ${rule.points ?? 0} pt`)
  : 'aucune règle définie → 0 pt par défaut';

console.log('═'.repeat(88));
console.log('1. CE QUE DIT CHAQUE RÈGLEMENT');
console.log('═'.repeat(88));

for (const ch of champs) {
  console.log(`\n${ch.name}  (${ch.id})`);
  console.log(`  barème MQ : ${JSON.stringify(ch.pointsScale?.MQ)}`);
  for (const s of STATUTS) {
    const rule = ch.statusRules?.[s];
    const exemples = TAILLES.map(n => `${n}→${calcStatusPoints(s, 'MQ', n, ch)}`).join('  ');
    console.log(`  ${s.padEnd(9)} ${decrire(rule)}`);
    console.log(`  ${' '.repeat(9)} points selon le nombre d'engagés : ${exemples}`);
  }
  // Comparaison avec la dernière place classée : un statut peut valoir plus ou
  // moins qu'un mauvais résultat chiffré selon le règlement.
  console.log(`  repère : dernière place classée (P = engagés) → ${TAILLES.map(n => `${n}→${mqPoints(n, ch)}`).join('  ')}`);
}

console.log(`\n${'═'.repeat(88)}`);
console.log('2. RÉEL vs SIMULÉ — le simulateur passe-t-il par le même barème ?');
console.log('═'.repeat(88));

let comparaisons = 0, ecarts = 0;
const scale = { baseMs: 60000, msPerZ: 1000, source: null };

for (const ch of champs) {
  for (const n of TAILLES) {
    const ids = Array.from({ length: n }, (_, i) => `D${i + 1}`);
    const participants = ids.map((id, i) => ({ driverId: id, carNumber: i + 1 }));

    for (const statut of STATUTS) {
      // ── chemin RÉEL : documents Firestore tels que l'application les écrit
      const reels = ids.map((id, i) => i === 0
        ? { driverId: id, ms: null, status: statut }
        : { driverId: id, ms: 60000 + i * 500, status: null });
      const reel = buildMqStandings(participants, reels, ch).find(r => r.driverId === 'D1');

      // ── chemin SIMULÉ : le statut est imposé par un scénario « et si »
      const race = { num: 1, ids, participants };
      const buf = makeDrawBuffers([race])[0];
      const models = Object.fromEntries(ids.map(id => [id, { mu: 0, sigma: 1, incidentRate: 0 }]));
      buf.latent.fill(0); buf.incident.fill(1);
      ids.forEach((_, i) => { buf.latent[i] = i; });
      const sim = simulateRaceRows(race, buf, models,
        { D1: { status: statut } }, scale, ch).find(r => r.driverId === 'D1');

      comparaisons++;
      const ok = reel.points === sim.points && reel.position === sim.position;
      if (!ok) {
        ecarts++;
        console.log(`  ❌ ${ch.id} · ${n} engagés · ${statut} : réel ${reel.points} pt / P${reel.position}` +
                    ` ≠ simulé ${sim.points} pt / P${sim.position}`);
      }
    }
  }
}
console.log(`\n  ${comparaisons} comparaisons (2 règlements × ${TAILLES.length} tailles × ${STATUTS.length} statuts)`);
console.log(`  écarts : ${ecarts}`);
console.log(ecarts === 0
  ? '  ✅ le simulateur n\'a AUCUN barème propre : il passe par buildMqStandings, donc par le règlement.'
  : '  ❌ divergence — le simulateur applique un barème différent de l\'application.');

console.log(`\n${'═'.repeat(88)}`);
console.log('3. UN DNF VAUT-IL RÉELLEMENT 0 ?');
console.log('═'.repeat(88));
for (const ch of champs) {
  for (const n of [20, 30]) {
    const dnf = calcStatusPoints('DNF', 'MQ', n, ch);
    const dernier = mqPoints(n, ch);
    console.log(`  ${ch.name} · ${n} engagés : DNF = ${dnf} pt` +
      ` (dernière place classée = ${dernier} pt, écart ${dnf - dernier})`);
  }
}

console.log(`\n${'═'.repeat(88)}`);
console.log('4. CES STATUTS EXISTENT-ILS DANS LES DONNÉES RÉELLES ?');
console.log('═'.repeat(88));
const mq = results.filter(r => r.sessionType === 'MQ');
const parStatut = {};
mq.forEach(r => { if (r.status) parStatut[r.status] = (parStatut[r.status] || 0) + 1; });
console.log(`  ${mq.length} résultats de manche · ${Object.values(parStatut).reduce((a, b) => a + b, 0)} portent un statut`);
for (const [s, k] of Object.entries(parStatut).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${s.padEnd(9)} ${k}`);
}
const inconnus = Object.keys(parStatut).filter(s => !STATUTS.includes(s));
console.log(inconnus.length
  ? `  ⚠️  statuts hors des quatre règles connues : ${inconnus.join(', ')}`
  : '  ✅ aucun statut hors des quatre règles définies.');
