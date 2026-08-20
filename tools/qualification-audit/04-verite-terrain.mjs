import { readFileSync } from 'node:fs';
const J = p => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const cases = J('./data/cases.json'), sessions = J('./data/sessions.json'), parts = J('./data/sessionParticipants.json');
const parBySess = {}; for (const p of parts) (parBySess[p.sessionId] ||= []).push(p);
const byGroup = {};
for (const c of cases) (byGroup[c.mid + '||' + c.cat] ||= []).push(c);
const sessByGroup = {};
for (const s of sessions) (sessByGroup[s.meetingId + '||' + s.category] ||= []).push(s);

let tot = 0, mism = 0, groupsWithMism = 0;
for (const [k, g] of Object.entries(byGroup)) {
  const ss = sessByGroup[k] || [];
  const pick = t => ss.filter(x => x.type === t).flatMap(x => (parBySess[x.id] || []).map(p => p.driverId));
  const actual = new Set(pick('QF').length ? pick('QF') : (pick('DF').length ? pick('DF') : pick('FIN')));
  if (!actual.size) continue;
  const derived = new Set(g.filter(c => c.qualified).map(c => c.driverId));
  const only1 = [...derived].filter(d => !actual.has(d));
  const only2 = [...actual].filter(d => !derived.has(d));
  tot += actual.size;
  mism += only1.length + only2.length;
  if (only1.length || only2.length) {
    groupsWithMism++;
    console.log(`${k.split('||')[1].padEnd(11)} ${g[0].loc.padEnd(24)} seuil=${g[0].threshold} | classés-qualifiés absents de la phase suivante: ${only1.length} | présents mais non classés-qualifiés: ${only2.length}`);
  }
}
console.log(`\ngroupes avec écart : ${groupsWithMism}/${Object.keys(byGroup).length} — écarts pilotes : ${mism} sur ${tot} places de phase suivante`);
