/* NON-RÉGRESSION DU CŒUR DE L'APPLICATION.

   Le module de projection a fait extraire des fonctions pures de calc.js
   (buildEcStandings, buildMqStandings, buildInterimStandings). Ces fonctions
   servent aussi les vues Classements, Championnat et Chronométrage : une
   différence de comportement, même minime, y serait immédiatement visible.

   La preuve retenue est un recalcul intégral : sur TOUTES les sessions réelles,
   l'ancien code et le nouveau doivent produire des lignes rigoureusement
   identiques — position, points, chrono, statut, totaux, départages.

   Nécessite js/__baseCalc.js et js/__baseUtils.js, extraits de la révision de
   référence par tools/qualification-audit/16-non-regression.sh.

   Lecture seule. */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import * as neuf from '../../js/calc.js';

const baseUrl = new URL('../../js/__baseCalc.js', import.meta.url);
if (!existsSync(baseUrl)) {
  console.error('❌ js/__baseCalc.js absent. Extraire la révision de référence d\'abord.');
  process.exit(2);
}
const ancien = await import(baseUrl.href);

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const sessions = J('sessions.json');
const results = J('results.json');
const participants = J('sessionParticipants.json');
const champs = Object.fromEntries(J('championships.json').map(c => [c.id, c]));
const meetings = Object.fromEntries(J('meetings.json').map(m => [m.id, m]));

const resBy = {}, parBy = {};
results.forEach(r => { (resBy[r.sessionId] ||= []).push(r); });
participants.forEach(p => { (parBy[p.sessionId] ||= []).push(p); });

// L'ancien code lit Firestore ; on lui sert les mêmes documents, sans réseau.
globalThis.__RESULTS__ = resBy;
globalThis.__PARTICIPANTS__ = parBy;
const DB = { __fake: true };

let cmpMq = 0, diffMq = 0, cmpEc = 0, diffEc = 0, cmpInterim = 0, diffInterim = 0, lignes = 0;
const exemples = [];

for (const s of sessions) {
  const reg = champs[meetings[s.meetingId]?.championshipId] || null;
  const res = resBy[s.id] || [];
  const par = parBy[s.id] || [];
  if (!par.length) continue;

  if (s.type === 'MQ') {
    const a = await ancien.calcMqStandings(DB, s, reg);
    const b = neuf.buildMqStandings(par, res, reg);
    cmpMq++; lignes += b.length;
    if (JSON.stringify(a) !== JSON.stringify(b)) { diffMq++; if (exemples.length < 3) exemples.push(`MQ ${s.id}`); }
  }
  if (s.type === 'EC') {
    const a = await ancien.calcEcStandings(DB, [s], reg);
    const b = neuf.buildEcStandings(par, res, reg);
    cmpEc++; lignes += b.length;
    if (JSON.stringify(a) !== JSON.stringify(b)) { diffEc++; if (exemples.length < 3) exemples.push(`EC ${s.id}`); }
  }
}

// Classements intermédiaires : c'est là que se joue le paramètre
// minClassifiedRaces, dont le défaut ne doit PAS avoir changé.
const groupes = {};
for (const s of sessions) {
  if (!s.meetingId || !s.category) continue;
  (groupes[`${s.meetingId}||${s.category}`] ||= []).push(s);
}
for (const [key, sess] of Object.entries(groupes)) {
  const reg = champs[meetings[sess[0].meetingId]?.championshipId] || null;
  const mq = sess.filter(s => s.type === 'MQ' && s.num != null).sort((x, y) => x.num - y.num);
  if (!mq.length) continue;

  const rowsB = mq.map(s => ({ num: s.num, rows: neuf.buildMqStandings(parBy[s.id] || [], resBy[s.id] || [], reg) }));
  const ec = sess.find(s => s.type === 'EC');
  const bonusB = {};
  if (ec) {
    neuf.buildEcStandings(parBy[ec.id] || [], resBy[ec.id] || [], reg).forEach(r => { bonusB[r.driverId] = r.bonusPoints ?? 0; });
  }

  // Appel SANS options : c'est exactement ce que font Classements et Championnat.
  const a = await ancien.calcInterimStandings(DB, sess, reg);
  const b = neuf.buildInterimStandings(rowsB, bonusB, reg);
  cmpInterim++; lignes += b.length;
  if (JSON.stringify(a) !== JSON.stringify(b)) { diffInterim++; if (exemples.length < 6) exemples.push(`interim ${key}`); }
}

// Barèmes et statuts : mêmes valeurs pour toutes les positions et tous les plateaux.
let cmpPts = 0, diffPts = 0;
for (const reg of [null, ...Object.values(champs)]) {
  for (let p = 1; p <= 45; p++) {
    for (const f of ['mqPoints', 'ecBonusPoints', 'interimPoints', 'qfPoints', 'dfPoints', 'finPoints']) {
      cmpPts++;
      if (ancien[f](p, reg) !== neuf[f](p, reg)) { diffPts++; }
    }
  }
  for (const st of ['DNF', 'DNS', 'DSQ', 'DSQ_RACE']) {
    for (const n of [4, 8, 12, 16, 20, 24, 28, 30, 34, 40]) {
      for (const type of ['MQ', 'QF', 'DF', 'FIN']) {
        cmpPts++;
        if (ancien.calcStatusPoints(st, type, n, reg) !== neuf.calcStatusPoints(st, type, n, reg)) diffPts++;
      }
    }
  }
}

// computeSeriesSizes : utilisé par la grille de départ du Chronométrage.
let cmpSeries = 0, diffSeries = 0;
for (let n = 0; n <= 60; n++) {
  for (const max of [3, 4, 5, 6]) {
    for (const mode of ['ffsa', 'fia_even', undefined]) {
      cmpSeries++;
      if (JSON.stringify(ancien.computeSeriesSizes(n, max, mode)) !== JSON.stringify(neuf.computeSeriesSizes(n, max, mode))) diffSeries++;
    }
  }
}

const total = diffMq + diffEc + diffInterim + diffPts + diffSeries;
console.log('═'.repeat(84));
console.log('NON-RÉGRESSION — Classements · Championnat · Chronométrage');
console.log('═'.repeat(84));
console.log(`  classements de manche      : ${cmpMq} sessions · ${diffMq} différence(s)`);
console.log(`  classements essais         : ${cmpEc} sessions · ${diffEc} différence(s)`);
console.log(`  classements intermédiaires : ${cmpInterim} groupes  · ${diffInterim} différence(s)`);
console.log(`  barèmes et statuts         : ${cmpPts} valeurs  · ${diffPts} différence(s)`);
console.log(`  tailles de séries          : ${cmpSeries} cas      · ${diffSeries} différence(s)`);
console.log(`  lignes pilote comparées    : ${lignes}`);
if (exemples.length) console.log(`  exemples divergents : ${exemples.join(', ')}`);
console.log(total === 0
  ? '\n  ✅ comportement rigoureusement identique à la révision de référence.'
  : `\n  ❌ ${total} divergence(s).`);

// Les copies de référence sont des artefacts de contrôle : on ne les laisse pas
// traîner dans l'arborescence, où elles finiraient par être versionnées.
for (const f of ['../../js/__baseCalc.js', '../../js/__baseUtils.js']) {
  try { unlinkSync(new URL(f, import.meta.url)); } catch { /* déjà absent */ }
}
process.exit(total ? 1 : 0);
