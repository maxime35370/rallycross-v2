/* LE RATTRAPAGE EN BLOC ACHÈTE-T-IL DES PAIRES AU PRIX D'UNE ROTATION ?

     node tools/yolox-poc/bloc.mjs <suivi.json> [suivi-témoin.json]

   Quand la caméra fait un mouvement brusque, la prédiction de toutes les
   pistes rate d'un coup. Le suivi tente alors un rattrapage : il cherche le
   déplacement en bloc le plus voté entre boîtes prédites et détections, le
   applique, et garde le décalage s'il produit STRICTEMENT plus d'appariements.

   Ce garde-fou ne suffit pas sur une grille de départ. Les voitures y sont
   régulièrement espacées : décaler tout le monde d'un intervalle apparie
   chaque piste à la voisine de sa voisine, ce qui peut faire une paire de
   plus — et fait tourner le peloton d'un cran. C'est l'aliasing classique
   d'un motif périodique.

   Ce script rejoue le rattrapage à chaque pas, à partir des boîtes prédites
   BRUTES du journal, et compare les deux affectations : combien de paires,
   quel coût total, et surtout lesquelles changent de partenaire. Rien n'est
   modifié : c'est une mesure. */

import { readFileSync } from 'node:fs';
import { estimerDecalageGlobal, hungarian, rapportTaille, rattrapageRecevable } from './lib/track.mjs';
import { iou } from './lib/detect.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};
const INTERDIT = 10;

const [fPrincipal, fTemoin] = process.argv.slice(2);
if (!fPrincipal) {
  console.error('\n  usage : node tools/yolox-poc/bloc.mjs <suivi.json> [témoin.json]\n');
  process.exit(1);
}
const suivi = JSON.parse(readFileSync(fPrincipal, 'utf8'));
const temoin = fTemoin && fTemoin !== '-' ? JSON.parse(readFileSync(fTemoin, 'utf8')) : null;
const o = suivi.reglages.tracker;
const T = temoin ? new Map(temoin.journal.map(j => [Number(j.t.toFixed(4)), j])) : new Map();

function affecter(predites, dets) {
  const cout = predites.map(p => dets.map(d => {
    const r = iou(p, d);
    return (r < o.iouMatch || rapportTaille(p, d) > o.maxSizeRatio) ? INTERDIT : 1 - r;
  }));
  const aff = hungarian(cout);
  const paires = [];
  let total = 0;
  aff.forEach((j, i) => {
    if (j < 0 || j >= dets.length || cout[i][j] >= INTERDIT) return;
    paires.push([i, j]); total += cout[i][j];
  });
  return { paires, total, cout };
}

console.log(`\n${C.bold('RATTRAPAGE D\'UN DÉPLACEMENT EN BLOC')}  ${C.dim(fPrincipal.split('/').pop())}`);
console.log(`  ${C.dim('le décalage est retenu s\'il produit STRICTEMENT plus d\'appariements')}\n`);
console.log(`  ${C.dim('t       décalage        votes | sans : n  coût  | avec : n  coût  | verdict')}`);

let retenus = 0, rotations = 0, gains = 0;
const details = [];
for (const j of suivi.journal) {
  const t = Number(j.t.toFixed(4));
  const candidates = j.tracks.filter(p => !p.suspendue && p.boiteAvant);
  const lot = new Map();
  for (const tr of j.tracks) if (tr.boiteAssociee && (tr.score ?? 0) >= o.highScore) lot.set(tr.boiteAssociee.join(','), tr.boiteAssociee);
  const jt = T.get(t);
  if (jt) for (const tr of jt.tracks) if (tr.boiteAssociee && (tr.score ?? 0) >= o.highScore) lot.set(tr.boiteAssociee.join(','), tr.boiteAssociee);
  const dets = [...lot.values()];
  if (candidates.length < 3 || dets.length < 3) continue;

  const P = candidates.map(p => p.boiteAvant);
  const d = estimerDecalageGlobal(P, dets);
  if (!d || Math.hypot(d.dx, d.dy) <= 1) continue;

  const sans = affecter(P, dets);
  const decalees = P.map(b => [b[0] + d.dx, b[1] + d.dy, b[2] + d.dx, b[3] + d.dy]);
  const avec = affecter(decalees, dets);
  // La décision vient de la bibliothèque : un outil qui recopierait la règle
  // mentirait dès qu'on la corrige.
  const verdict = rattrapageRecevable(sans, avec);
  if (!verdict.recevable) continue;
  retenus += 1;

  // Une piste CHANGE de partenaire : c'est la signature d'une rotation.
  const avantMap = new Map(sans.paires);
  const changees = avec.paires.filter(([i, k]) => avantMap.has(i) && avantMap.get(i) !== k);
  const rotation = changees.length > 0;
  if (rotation) rotations += 1; else gains += 1;

  const ligne = `  ${String(t).padEnd(7)} ${`${d.dx > 0 ? '+' : ''}${d.dx.toFixed(0)},${d.dy > 0 ? '+' : ''}${d.dy.toFixed(0)}`.padEnd(14)} `
    + `${String(d.votes).padStart(4)}  | ${String(sans.paires.length).padStart(6)} ${sans.total.toFixed(3).padStart(6)} `
    + `| ${String(avec.paires.length).padStart(6)} ${avec.total.toFixed(3).padStart(6)} | `
    + (rotation
      ? C.rouge(`ROTATION — ${changees.length} piste(s) changent de partenaire`)
      : C.vert('gain net, personne ne change de partenaire'))
    + (avec.total > sans.total ? C.jaune(`  coût ×${(avec.total / Math.max(1e-9, sans.total)).toFixed(1)}`) : '');
  console.log(ligne);
  if (rotation) {
    details.push({ t, d, candidates, dets, sans, avec, changees });
    for (const [i, k] of changees) {
      console.log(`      ${C.dim(`piste ${candidates[i].id} : D${avantMap.get(i)} `
        + `(coût ${sans.cout[i][avantMap.get(i)].toFixed(3)}) → D${k} (coût ${avec.cout[i][k].toFixed(3)})`)}`);
    }
    const perdues = sans.paires.filter(([i]) => !avec.paires.some(([i2]) => i2 === i));
    for (const [i, k] of perdues) {
      console.log(`      ${C.rouge(`piste ${candidates[i].id} : D${k} (coût ${sans.cout[i][k].toFixed(3)}) → plus rien`)}`);
    }
  }
}

// ── ce que le run a RÉELLEMENT appliqué ──
//
// Le rejeu ci-dessus reconstitue le lot de détections ; il approxime. Le
// décalage effectivement appliqué, lui, se lit sans ambiguïté dans l'écart
// entre prédiction brute et prédiction compensée, identique pour toutes les
// pistes d'un même pas. Les rapports récents portent en plus le verdict du
// suivi lui-même.
const mediane = (a) => { const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
const appliques = [];
for (const j of suivi.journal) {
  const dx = [], dy = [];
  for (const tr of j.tracks) {
    if (tr.boiteAvant && tr.boiteCompensee) {
      dx.push(tr.boiteCompensee[0] - tr.boiteAvant[0]);
      dy.push(tr.boiteCompensee[1] - tr.boiteAvant[1]);
    }
  }
  if (!dx.length) continue;
  const mx = mediane(dx), my = mediane(dy);
  if (Math.abs(mx) < 40 && Math.abs(my) < 40) continue;
  appliques.push({ t: j.t, mx, my, verdict: j.rattrapage ?? null });
}
console.log(`\n  ${C.bold('Décalages réellement appliqués')} ${C.dim('— lus dans l\'écart prédiction brute → compensée, > 40 px')}`);
if (!appliques.length) console.log(`    ${C.dim('aucun')}`);
for (const a of appliques) {
  console.log(`    ${String(a.t).padEnd(6)} ${`${a.mx > 0 ? '+' : ''}${a.mx.toFixed(0)},${a.my > 0 ? '+' : ''}${a.my.toFixed(0)}`.padEnd(12)}`
    + (a.verdict
      ? C.dim(`  ${a.verdict.pairesAvant}→${a.verdict.pairesApres} paires · `
        + `coût moyen ${a.verdict.coutMoyenAvant} → ${a.verdict.coutMoyenApres} · `
        + (a.verdict.recevable ? 'retenu' : `refusé (${a.verdict.raison})`))
      : C.dim('  (rapport sans le champ `rattrapage` : verdict non inscrit)')));
}

console.log(`\n  ${C.bold('Bilan du rejeu')}  ${retenus} décalage(s) recevable(s) : `
  + `${C.vert(`${gains} gain(s) net(s)`)} · ${C.rouge(`${rotations} rotation(s)`)}`);
console.log(`  ${C.dim('Une rotation ajoute une paire mais réattribue les autres : le compte monte, les identités tournent.')}\n`);
