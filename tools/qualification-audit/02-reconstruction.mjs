import { readFileSync } from 'node:fs';
import { mqPoints, ecBonusPoints, calcStatusPoints, compareInterimTiebreaker } from '../../js/calc.js';

const J = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const meetings = J('./data/meetings.json'), sessions = J('./data/sessions.json'),
      results = J('./data/results.json'), parts = J('./data/sessionParticipants.json'),
      champs = J('./data/championships.json');
const champById = Object.fromEntries(champs.map(c => [c.id, c]));
const mById = Object.fromEntries(meetings.map(m => [m.id, m]));
const resBySess = {}; for (const r of results) (resBySess[r.sessionId] ||= []).push(r);
const parBySess = {}; for (const p of parts) (parBySess[p.sessionId] ||= []).push(p);

/** Réplique exacte de calcMqStandings() (calc.js) sur données locales. */
function mqStandings(session, reg) {
  const rs = resBySess[session.id] || [], ps = parBySess[session.id] || [];
  const rmap = {}; rs.forEach(r => { rmap[r.driverId] = r; });
  const rows = ps.map(p => ({ driverId: p.driverId, carNumber: p.carNumber,
    ms: rmap[p.driverId]?.ms ?? null, status: rmap[p.driverId]?.status ?? null }));
  const n = rows.length;
  const fin = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const out = [];
  let pos = 1;
  fin.forEach(r => out.push({ ...r, position: pos++, points: mqPoints(pos - 1, reg) }));
  rows.filter(r => r.status === 'DNF').forEach(r => out.push({ ...r, position: n + 1, points: calcStatusPoints('DNF', 'MQ', n, reg) }));
  rows.filter(r => r.status === 'DSQ_RACE').forEach(r => out.push({ ...r, position: n + 3, points: calcStatusPoints('DSQ_RACE', 'MQ', n, reg) }));
  rows.filter(r => r.status === 'DNS').forEach(r => out.push({ ...r, position: null, points: calcStatusPoints('DNS', 'MQ', n, reg) }));
  rows.filter(r => r.status === 'DSQ').forEach(r => out.push({ ...r, position: null, points: calcStatusPoints('DSQ', 'MQ', n, reg) }));
  rows.filter(r => !r.ms && !r.status).forEach(r => out.push({ ...r, position: null, points: null }));
  return out;
}

/** Réplique de calcInterimStandings() mais bornée à `upTo` manches, minMq paramétrable. */
function interimUpTo(ss, reg, upTo, minMq) {
  const mqs = ss.filter(s => s.type === 'MQ' && (s.num || 0) <= upTo).sort((a, b) => a.num - b.num);
  if (!mqs.length) return [];
  const ecS = ss.find(s => s.type === 'EC');
  const ecBonus = {};
  if (ecS) {
    const rs = resBySess[ecS.id] || [], ps = parBySess[ecS.id] || [];
    const rmap = {}; rs.forEach(r => { rmap[r.driverId] = r; });
    const rows = ps.map(p => ({ driverId: p.driverId, ms: rmap[p.driverId]?.ms ?? null, status: rmap[p.driverId]?.status ?? null }));
    rows.sort((a, b) => { const ao = !a.ms && a.status, bo = !b.ms && b.status;
      if (ao && !bo) return 1; if (!ao && bo) return -1; return (a.ms ?? Infinity) - (b.ms ?? Infinity); });
    let p = 1; rows.forEach(r => { if (r.ms != null) ecBonus[r.driverId] = ecBonusPoints(p++, reg); });
  }
  const dm = {};
  for (const mq of mqs) for (const r of mqStandings(mq, reg)) {
    const d = (dm[r.driverId] ||= { driverId: r.driverId, carNumber: r.carNumber, mqPoints: {}, mqPos: {}, mqMs: {}, mqCount: 0 });
    if (r.points != null) {
      d.mqPoints[mq.num] = r.points ?? 0; d.mqPos[mq.num] = r.position;
      if (r.ms != null && !r.status) d.mqMs[mq.num] = r.ms;
      if (r.status !== 'DNS' && r.status !== 'DSQ') d.mqCount++;
    }
  }
  const el = Object.values(dm).filter(d => d.mqCount >= minMq);
  el.forEach(d => { d.totalMqPoints = Object.values(d.mqPoints).reduce((s, p) => s + p, 0);
    d.ecBonus = ecBonus[d.driverId] ?? 0; d.totalPoints = d.totalMqPoints + d.ecBonus; });
  const desc = mqs.map(s => s.num).sort((a, b) => b - a);
  el.sort((a, b) => (b.totalPoints - a.totalPoints) || compareInterimTiebreaker(a, b, reg, desc));
  el.forEach((d, i) => { d.position = i + 1; });
  return el;
}

// ── Groupes complets ────────────────────────────────────
const groups = {};
for (const s of sessions) (groups[s.meetingId + '||' + s.category] ||= []).push(s);

let complete = 0, obs = { 1: 0, 2: 0, 3: 0, 4: 0 }, emptyAfterQ1 = 0;
const cases = [];
for (const [k, ss] of Object.entries(groups)) {
  const [mid, cat] = k.split('||');
  const mt = mById[mid]; if (!mt) continue;
  const reg = champById[mt.championshipId];
  const mqs = ss.filter(s => s.type === 'MQ');
  // "complet" = 4 MQ avec au moins un résultat exploitable chacune
  const ok = [1,2,3,4].every(n => { const s = mqs.find(x => x.num === n);
    return s && (resBySess[s.id] || []).some(r => r.ms != null || r.status); });
  if (!ok) continue;
  complete++;

  const st = {};
  for (const n of [1,2,3,4]) st[n] = interimUpTo(ss, reg, n, 2);
  const st1min1 = interimUpTo(ss, reg, 1, 1);
  if (st[1].length === 0) emptyAfterQ1++;
  for (const n of [1,2,3,4]) obs[n] += st[n].length;

  // seuil de qualification réel = nb de participants de la phase suivante réellement utilisée
  const nextP = (t) => { const s = ss.filter(x => x.type === t); return s.reduce((a, x) => a + (parBySess[x.id] || []).length, 0); };
  const qf = nextP('QF'), df = nextP('DF'), fin = nextP('FIN');
  const threshold = qf || df || fin || null;
  const nEngaged = st[4].length;
  const final = st[4];
  const rank4 = Object.fromEntries(final.map(d => [d.driverId, d.position]));
  const pts = n => Object.fromEntries(st[n].map(d => [d.driverId, d.totalPoints]));
  const p1 = pts(1), p2 = pts(2), p3 = pts(3), p4 = pts(4);
  const r1 = Object.fromEntries(st[1].map(d => [d.driverId, d.position]));
  const r3 = Object.fromEntries(st[3].map(d => [d.driverId, d.position]));
  for (const d of final) {
    cases.push({ mid, cat, champ: reg?.name, loc: mt.location, date: mt.date,
      driverId: d.driverId, nEngaged, threshold,
      trivial: threshold != null && nEngaged <= threshold,
      p1: p1[d.driverId] ?? null, p2: p2[d.driverId] ?? null, p3: p3[d.driverId] ?? null, p4: p4[d.driverId],
      r1: r1[d.driverId] ?? null, r3: r3[d.driverId] ?? null, r4: rank4[d.driverId],
      q4pos: d.mqPos[4] ?? null, q4pts: d.mqPoints[4] ?? null,
      qualified: threshold != null ? (rank4[d.driverId] <= threshold) : null });
  }
  if (complete <= 2) console.log(`  [${mt.location}/${cat}] minMq=2 après Q1 → ${st[1].length} pilotes ; minMq=1 → ${st1min1.length} ; après Q2 → ${st[2].length} ; Q3 → ${st[3].length} ; Q4 → ${st[4].length} ; seuil=${threshold}`);
}
console.log(`\nmeeting×catégorie complets (Q1..Q4) : ${complete}`);
console.log(`classements après Q1 VIDES à cause de la règle mqCount>=2 : ${emptyAfterQ1}/${complete}`);
console.log(`lignes pilote reconstruites : Q1=${obs[1]}  Q2=${obs[2]}  Q3=${obs[3]}  Q4=${obs[4]}`);
const nonTriv = cases.filter(c => !c.trivial);
console.log(`cas pilote total = ${cases.length} ; dont NON triviaux (engagés > seuil) = ${nonTriv.length} ; triviaux (tout le monde qualifié d'office) = ${cases.length - nonTriv.length}`);
console.log(`qualifiés parmi non-triviaux : ${nonTriv.filter(c => c.qualified).length}`);
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./data/cases.json', import.meta.url), JSON.stringify(cases));
