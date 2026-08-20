/* ÉTAT RÉEL DES INSCRIPTIONS — doublons, cohérence engagements / sessions.

   Deux collections décrivent « qui court » :
     · engagements          — un pilote inscrit à un MEETING dans une catégorie ;
     · sessionParticipants  — un pilote au départ d'une SESSION précise.

   La seconde devrait dériver de la première. Ce script vérifie les deux, et
   surtout ce qui les sépare : un écart signale soit un doublon, soit une
   inscription oubliée, soit un forfait non répercuté.

   Lecture seule — aucune écriture, aucune suppression.
   Usage : node tools/qualification-audit/17-engagements.mjs */

import { readFileSync } from 'node:fs';

const J = p => JSON.parse(readFileSync(new URL(`./data/${p}`, import.meta.url)));
const meetings = J('meetings.json'), sessions = J('sessions.json');
const participants = J('sessionParticipants.json'), engagements = J('engagements.json');
const results = J('results.json'), drivers = J('drivers.json');

const mById = Object.fromEntries(meetings.map(m => [m.id, m]));
const dById = Object.fromEntries(drivers.map(d => [d.id, d]));
const nom = id => {
  const d = dById[id];
  return d ? `#${String(d.carNumber ?? '?').padStart(3)} ${d.firstName || ''} ${d.lastName || ''}`.trim() : `(pilote ${id})`;
};
const label = s => {
  const m = mById[s.meetingId];
  return `${m?.date || '?'} ${m?.location || s.meetingId} / ${s.category} / ${s.type}${s.num ?? ''}`;
};
const deterministe = (p) => p.id === `${p.sessionId}_${p.driverId}`;

const parSession = {};
participants.forEach(p => { (parSession[p.sessionId] ||= []).push(p); });
const resSession = {};
results.forEach(r => { (resSession[r.sessionId] ||= []).push(r); });

console.log('═'.repeat(92));
console.log('1. INSCRIPTIONS EN DOUBLE — même pilote, même session');
console.log('═'.repeat(92));

const doublons = [];
for (const s of sessions) {
  const list = parSession[s.id] || [];
  const par = {};
  list.forEach(p => { (par[p.driverId] ||= []).push(p); });
  const enDouble = Object.entries(par).filter(([, v]) => v.length > 1);
  if (enDouble.length) doublons.push({ session: s, enDouble, total: list.length, uniques: Object.keys(par).length });
}

if (!doublons.length) console.log('  aucune inscription en double.');
for (const d of doublons) {
  const res = (resSession[d.session.id] || []).length;
  console.log(`\n  ${label(d.session)}`);
  console.log(`    ${d.total} inscriptions pour ${d.uniques} pilotes → ${d.total - d.uniques} en trop` +
    ` · ${res} résultat${res > 1 ? 's' : ''} saisi${res > 1 ? 's' : ''}`);
  for (const [driverId, docs] of d.enDouble) {
    const det = docs.filter(deterministe).length;
    const dates = docs.map(x => (typeof x.createdAt === 'string' ? x.createdAt.slice(0, 19) : '?')).join(' · ');
    console.log(`      ${nom(driverId).padEnd(28)} ${docs.length} documents` +
      ` (${det} déterministe${det > 1 ? 's' : ''}, ${docs.length - det} aléatoire${docs.length - det > 1 ? 's' : ''}) · créés ${dates}`);
  }
}

console.log(`\n${'═'.repeat(92)}`);
console.log('2. DES DOUBLONS SONT-ILS ENCORE CRÉÉS AUJOURD\'HUI ?');
console.log('═'.repeat(92));
const dateDe = p => (typeof p.createdAt === 'string' ? p.createdAt : null);
const legacy = participants.filter(p => !deterministe(p));
const plusRecentLegacy = legacy.reduce((max, p) => {
  const d = dateDe(p);
  return d && (!max || d > max) ? d : max;
}, null);
const plusRecentDoublon = doublons.flatMap(d => d.enDouble.flatMap(([, v]) => v))
  .reduce((max, p) => { const d = dateDe(p); return d && (!max || d > max) ? d : max; }, null);
console.log(`  inscriptions à identifiant aléatoire : ${legacy.length} / ${participants.length}`);
console.log(`  la plus récente date du            : ${plusRecentLegacy || 'inconnue'}`);
console.log(`  document en double le plus récent   : ${plusRecentDoublon || 'aucun'}`);
console.log(`  → la protection sera efficace si aucun document POSTÉRIEUR au déploiement n'apparaît.`);

console.log(`\n${'═'.repeat(92)}`);
console.log('3. COHÉRENCE ENGAGEMENTS ↔ INSCRIPTIONS AUX MANCHES');
console.log('═'.repeat(92));

const engParMeetingCat = {};
for (const e of engagements) {
  const k = `${e.meetingId}||${e.category}`;
  (engParMeetingCat[k] ||= new Set()).add(e.driverId);
}
// Doublons dans engagements eux-mêmes
const engCle = {};
engagements.forEach(e => { const k = `${e.meetingId}|${e.category}|${e.driverId}`; (engCle[k] ||= []).push(e); });
const engDbl = Object.entries(engCle).filter(([, v]) => v.length > 1);
console.log(`  engagements : ${engagements.length} documents · ${engDbl.length} pilote(s) engagé(s) deux fois au même meeting`);
for (const [k, v] of engDbl.slice(0, 10)) {
  const [meetingId, cat, driverId] = k.split('|');
  console.log(`    ${mById[meetingId]?.location} / ${cat} — ${nom(driverId)} : ${v.length} documents`);
}

// Deux écarts sur trois sont NORMAUX et ne doivent pas être signalés comme des
// anomalies : une session pas encore peuplée, et un forfait — un pilote engagé
// au meeting qui ne prend pas le départ d'une manche. Un outil qui crie au loup
// sur ces deux cas-là finit par ne plus être lu.
//
// Le seul écart réellement suspect est l'inverse : un pilote INSCRIT à une
// manche sans être engagé au meeting. Il ne peut venir que d'une saisie
// erronée, et il gonfle le nombre d'engagés — donc les points d'abandon.
console.log('\n  a) pilotes inscrits à une manche SANS engagement au meeting (anormal) :');
let anormaux = 0;
for (const s of sessions.filter(x => x.type === 'MQ')) {
  const engages = engParMeetingCat[`${s.meetingId}||${s.category}`];
  if (!engages) continue;
  const inscrits = new Set((parSession[s.id] || []).map(p => p.driverId));
  const enTrop = [...inscrits].filter(id => !engages.has(id));
  if (!enTrop.length) continue;
  anormaux++;
  console.log(`    ${label(s)} : ${enTrop.map(nom).join(' · ')}`);
}
if (!anormaux) console.log('    aucun — toute inscription correspond à un engagement.');

console.log('\n  b) sessions sans aucun inscrit (à peupler, pas une anomalie) :');
const vides = sessions.filter(s => s.type === 'MQ' && !(parSession[s.id] || []).length);
const parGroupe = {};
vides.forEach(s => { (parGroupe[`${s.meetingId}||${s.category}`] ||= []).push(s.num); });
if (!Object.keys(parGroupe).length) console.log('    aucune.');
for (const [k, nums] of Object.entries(parGroupe)) {
  const [meetingId, cat] = k.split('||');
  console.log(`    ${mById[meetingId]?.date} ${mById[meetingId]?.location} / ${cat} — manches ${nums.sort((a, b) => a - b).join(', ')}`);
}

console.log('\n  c) forfaits : engagés au meeting, absents d\'une manche peuplée (normal) :');
let forfaits = 0;
for (const s of sessions.filter(x => x.type === 'MQ')) {
  const engages = engParMeetingCat[`${s.meetingId}||${s.category}`];
  const inscrits = new Set((parSession[s.id] || []).map(p => p.driverId));
  if (!engages || !inscrits.size) continue;
  const manquants = [...engages].filter(id => !inscrits.has(id));
  if (manquants.length) forfaits += manquants.length;
}
console.log(`    ${forfaits} cas sur l'ensemble des manches — attendu, un engagement n'oblige pas à prendre le départ.`);

console.log(`\n${'═'.repeat(92)}`);
console.log('4. EFFECTIFS PAR MANCHE — une manche isolée trahit un problème');
console.log('═'.repeat(92));
const groupes = {};
for (const s of sessions.filter(x => x.type === 'MQ')) {
  (groupes[`${s.meetingId}||${s.category}`] ||= []).push(s);
}
for (const [k, list] of Object.entries(groupes)) {
  const tri = list.sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  const eff = tri.map(s => new Set((parSession[s.id] || []).map(p => p.driverId)).size);
  const brut = tri.map(s => (parSession[s.id] || []).length);
  if (brut.every(n => n === brut[0])) continue;
  const [meetingId, cat] = k.split('||');
  console.log(`  ${mById[meetingId]?.date} ${mById[meetingId]?.location} / ${cat}`);
  console.log(`    documents  : ${brut.join(' / ')}`);
  console.log(`    pilotes    : ${eff.join(' / ')}${eff.every(n => n === eff[0]) ? '   ← les pilotes réels sont cohérents' : '   ← effectifs réellement différents'}`);
}
