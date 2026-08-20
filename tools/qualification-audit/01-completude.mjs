import { readFileSync } from 'node:fs';
const J = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const meetings = J('./data/meetings.json'), sessions = J('./data/sessions.json'),
      results = J('./data/results.json'), parts = J('./data/sessionParticipants.json'),
      champs = J('./data/championships.json');
const champById = Object.fromEntries(champs.map(c => [c.id, c]));
const mById = Object.fromEntries(meetings.map(m => [m.id, m]));

const resBySess = {}; for (const r of results) (resBySess[r.sessionId] ||= []).push(r);
const parBySess = {}; for (const p of parts) (parBySess[p.sessionId] ||= []).push(p);

// group sessions by meeting+category
const groups = {};
for (const s of sessions) {
  const k = s.meetingId + '||' + s.category;
  (groups[k] ||= []).push(s);
}
meetings.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
const order = Object.fromEntries(meetings.map((m,i)=>[m.id,i]));

const rows = [];
for (const [k, ss] of Object.entries(groups)) {
  const [mid, cat] = k.split('||');
  const mt = mById[mid]; if (!mt) { rows.push({mid,cat,orphan:true}); continue; }
  const ch = champById[mt.championshipId];
  const mq = ss.filter(s => s.type === 'MQ').sort((a,b)=>(a.num||0)-(b.num||0));
  const mqInfo = mq.map(s => {
    const rs = resBySess[s.id] || [], ps = parBySess[s.id] || [];
    const timed = rs.filter(r => r.ms != null && !r.status).length;
    const stat  = rs.filter(r => r.status).length;
    const empty = rs.filter(r => r.ms == null && !r.status).length;
    return { num: s.num, P: ps.length, R: rs.length, timed, stat, empty, status: s.status };
  });
  const phase = t => { const s = ss.filter(x=>x.type===t); return s.reduce((n,x)=>n+(parBySess[x.id]||[]).length,0); };
  rows.push({
    date: mt.date, loc: mt.location, cat, champ: ch?.name || '?', mid,
    nbMQ: mt.nbMQ, mqSessions: mq.length, mqInfo,
    ec: (ss.find(s=>s.type==='EC') ? (resBySess[ss.find(s=>s.type==='EC').id]||[]).filter(r=>r.ms!=null).length : null),
    qfP: phase('QF'), dfP: phase('DF'), finP: phase('FIN'),
  });
}
rows.sort((a,b)=> (order[a.mid]-order[b.mid]) || String(a.cat).localeCompare(String(b.cat)));
console.log('date       lieu                 categorie    | MQ1 P/R(timed,st,vide) | MQ2 | MQ3 | MQ4 | EC | QFp DFp FINp');
for (const r of rows) {
  const f = i => { const x = r.mqInfo.find(z=>z.num===i); return x ? `${String(x.P).padStart(2)}/${String(x.R).padStart(2)}(${x.timed},${x.stat},${x.empty})` : '   ABSENT  '; };
  console.log(`${r.date}  ${String(r.loc).padEnd(20)} ${String(r.cat).padEnd(12)} | ${f(1)} | ${f(2)} | ${f(3)} | ${f(4)} | ${String(r.ec).padStart(2)} | ${String(r.qfP).padStart(3)} ${String(r.dfP).padStart(3)} ${String(r.finP).padStart(4)}`);
}
console.log('\nP=participants, R=results docs, timed=chrono valide, st=status(DNF/DNS/DSQ), vide=doc sans chrono ni statut');
