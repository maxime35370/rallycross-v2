/* LE REPÈRE DU GROUPE PRÉDIT-IL MIEUX QU'UNE EXTRAPOLATION ?

     node tools/yolox-poc/trou-groupe.mjs <rapport-suivi.json> [...autres]

   Une voiture perd sa détection pendant quelques instants puis la retrouve.
   Trois façons de dire où elle est pendant ce trou :

     ① `groupe`   — on la fait porter par ses voisines : la similitude qui
                    envoie les voisines de t₀ vers t₁, appliquée à sa dernière
                    position vue ;
     ② `prédite`  — la boîte que le suivi propose À CET INSTANT, avant de
                    voir la détection : vitesse amortie puis compensation
                    caméra. C'est elle qui sert à décider de l'appariement ;
     ③ `figée`    — sa dernière position vue, sans rien faire ;
     ④ `groupe+`  — ① auquel on rend sa vitesse PROPRE, celle qui lui reste
                    une fois la vitesse moyenne du groupe retirée. Sans elle
                    ① ne saurait pas qu'une voiture double ses voisines, et
                    le procès serait déloyal.

   On mesure l'erreur au moment où elle REVIENT, seul instant où l'on connaît
   la vérité sans l'annoter. Rien n'est modifié : c'est une mesure. */

import { readFileSync } from 'node:fs';
import { similitudeMoindresCarres, appliquerSim } from './lib/structure.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const med = (a) => { if (!a.length) return NaN; const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };

const fichiers = process.argv.slice(2);
if (!fichiers.length) {
  console.error('\n  usage : node tools/yolox-poc/trou-groupe.mjs <rapport-suivi.json> [...]\n');
  process.exit(1);
}

const global = { groupe: [], groupePlus: [], predite: [], figee: [] };
const toutes = [];
let trousTotal = 0, trousMesurables = 0;

for (const f of fichiers) {
  const suivi = JSON.parse(readFileSync(f, 'utf8'));
  const journal = suivi.journal || [];
  console.log(`\n${C.bold('LE REPÈRE DU GROUPE PENDANT UN TROU')}  ${C.dim(f.split('/').pop())}`);

  // Index : pour chaque piste, la suite de ses instants.
  const ids = [...new Set(journal.flatMap(j => j.tracks.map(t => t.id)))];
  const lignes = [];

  for (const id of ids) {
    const suite = journal
      .map(j => ({ t: j.t, tr: j.tracks.find(t => t.id === id), tous: j.tracks }))
      .filter(e => e.tr);
    for (let i = 0; i < suite.length; i++) {
      if (!suite[i].tr.boiteAssociee) continue;
      // Cherche la prochaine réapparition après au moins un instant à vide.
      let k = i + 1;
      while (k < suite.length && !suite[k].tr.boiteAssociee) k += 1;
      if (k === i + 1 || k >= suite.length) continue;      // pas de trou, ou jamais revenue
      trousTotal += 1;
      const a = suite[i], b = suite[k];

      // Appuis : les AUTRES pistes vues avec détection aux deux bouts.
      const appuis = a.tous.filter(t => t.id !== id && t.boiteAssociee
        && b.tous.some(u => u.id === t.id && u.boiteAssociee));
      if (appuis.length < 2) continue;
      trousMesurables += 1;

      const A = appuis.map(t => centre(t.boiteAssociee));
      const B = appuis.map(t => centre(b.tous.find(u => u.id === t.id).boiteAssociee));
      const sim = similitudeMoindresCarres(A, B);
      const vrai = centre(b.tr.boiteAssociee);
      const depart = centre(a.tr.boiteAssociee);

      // Vitesse PROPRE : ce qui reste de sa vitesse quand on retire celle du
      // groupe. Portée dans le plan d'arrivée, elle est mise à l'échelle de
      // la similitude — le groupe a pu grossir entre les deux instants.
      const vg = appuis.reduce((acc, t) => {
        acc[0] += t.vitesse.vx / appuis.length; acc[1] += t.vitesse.vy / appuis.length; return acc;
      }, [0, 0]);
      const dt = b.t - a.t;
      const e2 = appliquerSim(sim, depart);
      const echelle = Math.hypot(sim.m[0], sim.m[1]);
      const propre = [
        e2[0] + echelle * (a.tr.vitesse.vx - vg[0]) * dt,
        e2[1] + echelle * (a.tr.vitesse.vy - vg[1]) * dt,
      ];

      const e = {
        id, t0: a.t, t1: b.t, duree: +(b.t - a.t).toFixed(2), appuis: appuis.length,
        groupe: dist(e2, vrai),
        groupePlus: dist(propre, vrai),
        // La PRÉDICTION, pas la boîte finale : à `t₁` la piste a déjà encaissé
        // sa détection, comparer `box` reviendrait à comparer la vérité à
        // elle-même.
        predite: dist(centre(b.tr.boiteCompensee || b.tr.boiteAvant || b.tr.box), vrai),
        figee: dist(depart, vrai),
      };
      lignes.push(e); toutes.push(e);
      for (const c of ['groupe', 'groupePlus', 'predite', 'figee']) global[c].push(e[c]);
    }
  }

  if (!lignes.length) { console.log(`  ${C.jaune('aucun trou avec au moins deux appuis')}`); continue; }
  console.log(`  ${C.dim('piste   trou       appuis   groupe    prédite    figée')}`);
  for (const l of lignes.sort((x, y) => y.duree - x.duree).slice(0, 12)) {
    const best = Math.min(l.groupe, l.groupePlus, l.predite, l.figee);
    const m = (v) => (Math.abs(v - best) < 1e-6 ? C.vert : (x) => x)(`${v.toFixed(0).padStart(6)} px`);
    console.log(`  ${String(l.id).padStart(5)}   ${String(l.duree).padStart(4)} s     `
      + `${String(l.appuis).padStart(3)}    ${m(l.groupe)}  ${m(l.groupePlus)}  ${m(l.predite)}  ${m(l.figee)}`);
  }
  const bilanLocal = (c) => `${med(lignes.map(l => l[c])).toFixed(0)} px`;
  console.log(`  ${C.bold('médiane')} ${' '.repeat(17)}`
    + `${bilanLocal('groupe').padStart(9)}  ${bilanLocal('groupePlus').padStart(9)}  ${bilanLocal('predite').padStart(9)}  ${bilanLocal('figee').padStart(9)}`
    + `   ${C.dim(`sur ${lignes.length} trou(s)`)}`);
}

function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }

console.log(`\n${C.bold('BILAN')}  ${C.dim(`${trousMesurables} trou(s) mesurable(s) sur ${trousTotal} — les autres n'ont pas deux appuis communs`)}`);
for (const c of ['groupe', 'groupePlus', 'predite', 'figee']) {
  const v = global[c];
  if (!v.length) continue;
  const gagne = v.filter((_, i) => Math.min(global.groupe[i], global.groupePlus[i], global.predite[i], global.figee[i]) === v[i]).length;
  console.log(`  ${c.padEnd(9)} erreur médiane ${C.bold(med(v).toFixed(0).padStart(4))} px`
    + `   moyenne ${(v.reduce((a, x) => a + x, 0) / v.length).toFixed(0).padStart(4)} px`
    + `   meilleure dans ${gagne}/${v.length}`);
}

// ── là où le groupe pourrait avoir raison : les trous LONGS, les appuis NOMBREUX ──
//
// Une extrapolation reste juste tant qu'elle est courte ; c'est en s'allongeant
// qu'elle décroche. Et une similitude calée sur deux appuis n'est pas la même
// mesure qu'une similitude calée sur quatre.
console.log(`  ${C.bold('Découpage')} ${C.dim('— erreur médiane, en pixels')}`);
console.log(`  ${C.dim('tranche                    n    groupe   groupe+   prédite     figée')}`);
for (const [nom, garde] of [
  ['trou ≤ 0,3 s', (l) => l.duree <= 0.31],
  ['trou 0,4 – 0,5 s', (l) => l.duree > 0.31 && l.duree <= 0.51],
  ['trou ≥ 0,6 s', (l) => l.duree > 0.51],
  ['2 appuis', (l) => l.appuis === 2],
  ['3 appuis', (l) => l.appuis === 3],
  ['≥ 4 appuis', (l) => l.appuis >= 4],
]) {
  const sel = toutes.filter(garde);
  if (!sel.length) continue;
  const v = (c) => med(sel.map(l => l[c])).toFixed(0).padStart(6);
  console.log(`  ${nom.padEnd(24)} ${String(sel.length).padStart(3)}   ${v('groupe')} px ${v('groupePlus')} px ${v('predite')} px ${v('figee')} px`);
}
console.log('');
