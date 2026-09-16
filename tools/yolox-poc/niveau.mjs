/* QUEL NIVEAU DE REPRÉSENTATION NOS DONNÉES SUPPORTENT-ELLES ?

     node tools/yolox-poc/niveau.mjs <rapport-suivi.json> [rapport-autopsie.json]

   Quatre niveaux sont envisageables pour tenir un « état monde » du peloton :

     ① configuration 2D normalisée du groupe — ce que fait `similitude-groupe/1` ;
     ② structure 3D sous caméra affine — factorisation de Tomasi-Kanade ;
     ③ homographie vers le plan de la piste ;
     ④ reconstruction 3D perspective complète.

   Chacun n'existe que sous des conditions vérifiables. Ce script les vérifie
   sur la séquence réelle, plutôt que de choisir par affinité.

   Rien n'est décidé ici, rien n'est modifié : c'est une mesure. */

import { readFileSync } from 'node:fs';
import {
  METHODE_STRUCTURE, matriceMesure, valeursSingulieres, spectre,
  comparerModelesGeometriques, rigidite,
} from './lib/structure.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};

const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
/** Point de CONTACT au sol : milieu du bord bas de la boîte. */
const contact = (b) => [(b[0] + b[2]) / 2, b[3]];

const [fSuivi] = process.argv.slice(2);
if (!fSuivi) {
  console.error('\n  usage : node tools/yolox-poc/niveau.mjs <rapport-suivi.json>\n');
  process.exit(1);
}
const suivi = JSON.parse(readFileSync(fSuivi, 'utf8'));
const journal = suivi.journal || [];
const coupures = (suivi.coupures || []).map(c => c.apres);

console.log(`\n${C.bold('NIVEAU DE REPRÉSENTATION IDENTIFIABLE')}  ${C.dim(fSuivi.split('/').pop())}`);
console.log(`  méthode : ${METHODE_STRUCTURE}`);

// ── ① combien de voitures suit-on VRAIMENT en même temps ? ──
//
// Toute la question du niveau se joue là : le comptage des inconnues dépend
// du nombre de points RÉELLEMENT observés simultanément, pas du nombre de
// voitures en piste.
const parInstant = journal.map(j => ({
  t: j.t,
  vues: j.tracks.filter(t => t.boiteAssociee && t.confirmee),
}));
const tailles = parInstant.map(p => p.vues.length);
const histo = {};
for (const n of tailles) histo[n] = (histo[n] || 0) + 1;
console.log(`\n  ${C.bold('Points simultanément observés')} ${C.dim('(pistes confirmées AVEC détection)')}`);
console.log(`    ${Object.entries(histo).sort((a, b) => a[0] - b[0])
  .map(([n, k]) => `${n} pt : ${k} inst.`).join('   ')}`);
const med = (a) => { const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
console.log(`    médiane ${med(tailles)} points  ·  maximum ${Math.max(...tailles)}`);

// ── ce que le comptage des inconnues autorise ──
console.log(`\n  ${C.bold('Ce que le comptage des inconnues autorise')}`);
for (const N of [...new Set([med(tailles), Math.max(...tailles)])].sort((a, b) => a - b)) {
  // Projectif : 2NM ≥ 11M + 3N − 15
  const projectifPossible = (M) => 2 * N * M >= 11 * M + 3 * N - 15;
  // Affine (Tomasi-Kanade) : N ≥ 4 et M ≥ 3
  const affinePossible = N >= 4;
  // Homographie : 4 correspondances, une 5ᵉ pour vérifier
  const homographieVerifiable = N >= 5;
  console.log(`    avec ${N} points : `
    + `④ perspective ${projectifPossible(1000) ? C.vert('possible') : C.rouge('IMPOSSIBLE, quel que soit le nombre d\'images')}`);
  console.log(`      ${' '.repeat(String(N).length)}          `
    + `② affine ${affinePossible ? C.vert('possible dès 3 vues') : C.rouge('impossible, il faut 4 points')}`
    + `   ③ homographie ${homographieVerifiable ? C.vert('vérifiable') : C.jaune('ajustable mais INVÉRIFIABLE')}`);
}

// ── ② le groupe est-il rigide ? ──
//
// C'est l'hypothèse dont dépendent ② et ④. Un peloton où l'on se double n'est
// pas un solide, et aucune factorisation ne le décrira.
console.log(`\n  ${C.bold('Rigidité du groupe')} ${C.dim('— variation des rapports de distance, échelle retirée')}`);
const fenetres = [];
for (let i = 0; i + 5 <= parInstant.length; i++) {
  const bloc = parInstant.slice(i, i + 5);
  if (bloc.some(b => b.t >= (coupures[0] ?? Infinity) - 1e-9) && bloc.some(b => b.t < (coupures[0] ?? Infinity))) continue;
  // Uniquement les identités présentes sur TOUTE la fenêtre.
  const communs = bloc[0].vues.map(v => v.id).filter(id => bloc.every(b => b.vues.some(v => v.id === id)));
  if (communs.length < 4) continue;
  const vues = bloc.map(b => communs.map(id => centre(b.vues.find(v => v.id === id).boiteAssociee)));
  fenetres.push({ t: bloc[0].t, n: communs.length, vues });
}
if (!fenetres.length) console.log(`    ${C.jaune('aucune fenêtre de 5 instants avec 4 points communs')}`);
else {
  const rs = fenetres.map(f => rigidite(f.vues)).filter(Boolean);
  console.log(`    ${fenetres.length} fenêtre(s) de 5 instants, ${med(fenetres.map(f => f.n))} points en commun (médiane)`);
  console.log(`    coefficient de variation médian : ${C.bold(med(rs.map(r => r.cvMedian)).toFixed(4))}`
    + `   maximum : ${med(rs.map(r => r.cvMax)).toFixed(4)}`);
  console.log(`    ${C.dim('0 = solide parfait. Au-delà de 0,05 la figure se déforme franchement.')}`);
}

// ── ③ le rang de la matrice de mesure ──
console.log(`\n  ${C.bold('Rang de la structure')} ${C.dim('— valeurs singulières de la matrice de mesure')}`);
console.log(`  ${C.dim('t         n   σ₁      σ₂      σ₃      σ₄      σ₃/σ₁    σ₄/σ₁   lecture')}`);
const lectures = { plan: 0, volume: 0, nonRigide: 0 };
for (const f of fenetres) {
  if (f.n < 5) continue;
  const m = matriceMesure(f.vues);
  const s = spectre(valeursSingulieres(m.W));
  // Trois régimes, lus au décrochage et non à l'énergie.
  let lecture, couleur;
  if (s.quatreSurUn > 0.05) { lecture = 'non rigide'; couleur = C.rouge; lectures.nonRigide += 1; }
  else if (s.troisSurUn > 0.05) { lecture = 'volume (rang 3)'; couleur = C.vert; lectures.volume += 1; }
  else { lecture = 'plan (rang 2)'; couleur = C.jaune; lectures.plan += 1; }
  if (fenetres.indexOf(f) % 6) continue;                 // une fenêtre sur six à l'écran
  console.log(`  ${String(f.t).padEnd(9)} ${f.n}   ${s.sv.slice(0, 4).map(v => String(v).padStart(7)).join(' ')}`
    + `  ${String(s.troisSurUn).padStart(7)}  ${String(s.quatreSurUn).padStart(6)}   ${couleur(lecture)}`);
}
const totalLect = lectures.plan + lectures.volume + lectures.nonRigide;
if (totalLect) {
  console.log(`\n    sur ${totalLect} fenêtre(s) à 5 points : `
    + `${C.jaune(`${lectures.plan} plan`)} · ${C.vert(`${lectures.volume} volume`)} · ${C.rouge(`${lectures.nonRigide} non rigide`)}`);
}

// ── ④ similitude contre homographie, en validation croisée ──
console.log(`\n  ${C.bold('Similitude contre homographie')} ${C.dim('— résidu sur le point LAISSÉ DE CÔTÉ, en rayons du groupe')}`);
const gains = [];
for (let i = 0; i + 1 < parInstant.length; i++) {
  const a = parInstant[i], b = parInstant[i + 1];
  const communs = a.vues.map(v => v.id).filter(id => b.vues.some(v => v.id === id));
  if (communs.length < 5) continue;
  const A = communs.map(id => centre(a.vues.find(v => v.id === id).boiteAssociee));
  const B = communs.map(id => centre(b.vues.find(v => v.id === id).boiteAssociee));
  const r = comparerModelesGeometriques(A, B);
  if (r?.gainHomographie != null) gains.push({ t: a.t, ...r });
}
if (!gains.length) console.log(`    ${C.jaune('aucun couple d\'instants avec 5 points communs')}`);
else {
  const gs = gains.map(g => g.gainHomographie);
  const sim = med(gains.map(g => g.similitude.medianeHorsAjustement));
  const hom = med(gains.map(g => g.homographie.medianeHorsAjustement));
  console.log(`    ${gains.length} couple(s) d'instants consécutifs à 5 points communs`);
  console.log(`    similitude  : résidu médian ${C.bold(sim.toFixed(4))} rayon`);
  console.log(`    homographie : résidu médian ${C.bold(hom.toFixed(4))} rayon`);
  const g = med(gs);
  console.log(`    gain de l'homographie : ${g > 0 ? C.vert(`+${g.toFixed(4)}`) : C.rouge(g.toFixed(4))}`
    + `   ${C.dim(g > 0 ? '(elle explique mieux)' : '(elle SUR-AJUSTE : huit paramètres pour cinq points)')}`);
  console.log(`    elle gagne dans ${gs.filter(x => x > 0).length}/${gs.length} cas`);
}

// ── le point de contact au sol change-t-il la lecture ? ──
//
// Un centre de boîte n'est pas un point du plan de la piste : il flotte à
// mi-hauteur de la voiture. Le milieu du bord BAS, lui, approche le contact
// des roues au sol — c'est lui qui devrait obéir à une homographie si la
// piste est plane.
console.log(`\n  ${C.bold('Et si l\'on prend le point de contact au sol')} ${C.dim('(milieu du bord bas)')}`);
const gainsSol = [];
for (let i = 0; i + 1 < parInstant.length; i++) {
  const a = parInstant[i], b = parInstant[i + 1];
  const communs = a.vues.map(v => v.id).filter(id => b.vues.some(v => v.id === id));
  if (communs.length < 5) continue;
  const A = communs.map(id => contact(a.vues.find(v => v.id === id).boiteAssociee));
  const B = communs.map(id => contact(b.vues.find(v => v.id === id).boiteAssociee));
  const r = comparerModelesGeometriques(A, B);
  if (r?.gainHomographie != null) gainsSol.push(r.gainHomographie);
}
if (gainsSol.length) {
  const g = med(gainsSol);
  console.log(`    gain de l'homographie sur les points de contact : `
    + `${g > 0 ? C.vert(`+${g.toFixed(4)}`) : C.rouge(g.toFixed(4))}`
    + `   (${gainsSol.filter(x => x > 0).length}/${gainsSol.length} cas)`);
} else console.log(`    ${C.jaune('pas assez de points communs')}`);

console.log('');
