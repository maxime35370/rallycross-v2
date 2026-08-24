/* QUELLE VITESSE TENIR PENDANT UN TROU — mesuré, pas supposé.

     node tools/yolox-poc/vitesse-trou.mjs <rapport-suivi.json> <rapport-autopsie.json>

   Le suivi amortit la vitesse dès qu'une piste n'a plus de mesure. C'est un
   garde-fou nécessaire — sans lui, une piste perdue file indéfiniment. Mais
   sur une voiture rapide il fait décrocher la prédiction : mesuré sur
   Kerlabo, 409 px/s tombent à 83 px/s en 0,8 s alors que la voiture, elle,
   continue.

   Pour savoir quelle politique tenir, il faut une VÉRITÉ de trajectoire
   pendant le trou. On la reconstruit dans l'autopsie, à 60 images par
   seconde : en partant de la dernière boîte réellement associée, on chaîne
   d'image en image la détection la plus proche de taille comparable. À cette
   cadence une voiture à 400 px/s ne bouge que de 7 px entre deux images —
   l'enchaînement est donc peu ambigu, bien plus que l'appariement à 10 Hz
   qu'on cherche justement à réparer.

   On rejoue ensuite plusieurs politiques d'extrapolation contre cette
   trajectoire, et on compare l'erreur en pixels et l'IoU obtenue. Rien n'est
   décidé ici : c'est une mesure. */

import { readFileSync } from 'node:fs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};

const aire = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = aire(a) + aire(b) - i;
  return u > 0 ? i / u : 0;
}

const [fSuivi, fAutopsie] = process.argv.slice(2);
if (!fSuivi || !fAutopsie) {
  console.error('\n  usage : node tools/yolox-poc/vitesse-trou.mjs <suivi.json> <autopsie.json>\n');
  process.exit(1);
}
const suivi = JSON.parse(readFileSync(fSuivi, 'utf8'));
const autopsie = JSON.parse(readFileSync(fAutopsie, 'utf8'));
const journal = suivi.journal || [];
const tauA = suivi.reglages?.tracker?.tauAmortissement ?? 0.5;
const pas = suivi.reglages?.pas ?? 0.1;
const images = autopsie.images;

/**
 * Trajectoire de référence : on part d'une boîte connue à l'instant `t0` et
 * on chaîne, image par image, la détection la plus proche dont la taille
 * reste comparable.
 *
 * Le chaînage s'arrête dès qu'aucune candidate n'est assez proche — mieux
 * vaut une trajectoire courte et sûre qu'une longue qui saute sur la voisine.
 */
function chainer(boite0, t0, tFin) {
  const suite = [];
  let boite = boite0.slice();
  for (const im of images) {
    if (im.t <= t0 + 1e-9 || im.t > tFin + 1e-9) continue;
    const [cx, cy] = centre(boite);
    const diag = Math.hypot(boite[2] - boite[0], boite[3] - boite[1]);
    let best = null, dmin = Infinity;
    for (const d of im.detections) {
      const [dx, dy] = centre(d.box);
      const dist = Math.hypot(dx - cx, dy - cy);
      // À 60 img/s, une voiture à 500 px/s parcourt 8 px : une candidate à
      // plus d'un tiers de diagonale n'est pas la même voiture.
      if (dist > 0.35 * diag) continue;
      if (aire(d.box) < 0.5 * aire(boite) || aire(d.box) > 2 * aire(boite)) continue;
      if (dist < dmin) { dmin = dist; best = d; }
    }
    if (!best) break;
    boite = best.box.slice();
    suite.push({ t: im.t, box: boite, score: best.score });
  }
  return suite;
}

/** Position d'une boîte extrapolée selon une politique donnée. */
function extrapoler({ box, vx, vy, vw, vh }, duree, politique) {
  let [x1, y1, x2, y2] = box;
  let cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, w = x2 - x1, h = y2 - y1;
  let ux = vx, uy = vy, uw = vw, uh = vh;
  const dt = 1 / 60;
  for (let s = dt; s <= duree + 1e-9; s += dt) {
    cx += ux * dt; cy += uy * dt; w = Math.max(1, w + uw * dt); h = Math.max(1, h + uh * dt);
    // L'amortissement ne commence qu'après `tenue` secondes sans mesure.
    if (s > politique.tenue) {
      const k = Math.exp(-dt / politique.tau);
      ux *= k; uy *= k; uw *= k; uh *= k;
    }
  }
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

const POLITIQUES = [
  { nom: 'amortie (actuelle)', tenue: 0, tau: tauA },
  { nom: 'tenue 0,3 s', tenue: 0.3, tau: tauA },
  { nom: 'jamais amortie', tenue: Infinity, tau: tauA },
  // ... et l'inverse : amortir PLUS vite. Dans l'approche d'un virage les
  // voitures freinent — mesuré : de +590 à −740 px/s en 2,7 s — et une
  // prédiction qui tient sa vitesse dépasse largement la voiture.
  { nom: 'amortie 2× plus vite', tenue: 0, tau: tauA / 2 },
  { nom: 'amortie 5× plus vite', tenue: 0, tau: tauA / 5 },
  { nom: 'boîte figée', tenue: 0, tau: 1e-6 },
];

console.log(`\n${C.bold('QUELLE VITESSE TENIR PENDANT UN TROU')}  ${C.dim(fSuivi.split('/').pop())}`);
console.log(`  amortissement actuel : tau = ${tauA} s  ·  pas du suivi : ${pas} s`);
console.log(`  trajectoire de référence : chaînée dans l'autopsie à 60 img/s\n`);

const bilan = new Map(POLITIQUES.map(p => [p.nom, { erreurs: [], ious: [], raccroches: 0, total: 0 }]));

const instants = journal.filter(j => j.t >= autopsie.fenetre.tDebut - 1e-9 && j.t <= autopsie.fenetre.tFin + 1e-9);
const ids = [...new Set(instants.flatMap(j => j.tracks.map(t => t.id)))];

for (const id of ids) {
  const vus = instants.filter(j => j.tracks.some(t => t.id === id));
  if (vus.length < 2) continue;
  // Dernier instant où la piste a VRAIMENT vu quelque chose.
  let depart = null;
  for (const j of vus) {
    const tr = j.tracks.find(t => t.id === id);
    if (tr.boiteAssociee) depart = { t: j.t, tr };
  }
  if (!depart) continue;
  const suite = vus.filter(j => j.t > depart.t);
  if (!suite.length) continue;

  const ref = chainer(depart.tr.boiteAssociee, depart.t, suite[suite.length - 1].t);
  if (ref.length < 3) continue;                    // trajectoire trop courte pour juger

  const etat = {
    box: depart.tr.boiteAssociee,
    vx: depart.tr.vitesse.vx, vy: depart.tr.vitesse.vy,
    vw: depart.tr.vitesse.vw, vh: depart.tr.vitesse.vh,
  };
  const v0 = Math.hypot(etat.vx, etat.vy);
  console.log(`  ${C.bold(`piste ${id}`)} ${C.dim(`— trou à partir de ${depart.t} s, `
    + `vitesse ${v0.toFixed(0)} px/s, trajectoire suivie sur ${ref.length} images `
    + `(${((ref[ref.length - 1].t - depart.t) * 1000).toFixed(0)} ms)`)}`);

  for (const pol of POLITIQUES) {
    const lignes = [];
    for (const j of suite) {
      const vrai = ref.reduce((b, r) => Math.abs(r.t - j.t) < Math.abs(b.t - j.t) ? r : b, ref[0]);
      if (Math.abs(vrai.t - j.t) > 1 / 60 + 1e-6) continue;
      const pred = extrapoler(etat, j.t - depart.t, pol);
      const [px, py] = centre(pred), [rx, ry] = centre(vrai.box);
      const err = Math.hypot(px - rx, py - ry);
      const k = iou(pred, vrai.box);
      lignes.push({ t: j.t, err, iou: k });
      const b = bilan.get(pol.nom);
      b.erreurs.push(err); b.ious.push(k); b.total += 1;
      if (k >= 0.2) b.raccroches += 1;             // porte d'association du banc
    }
    if (!lignes.length) continue;
    const errMoy = lignes.reduce((a, l) => a + l.err, 0) / lignes.length;
    const iouMoy = lignes.reduce((a, l) => a + l.iou, 0) / lignes.length;
    const ok = lignes.filter(l => l.iou >= 0.2).length;
    const marque = ok === lignes.length ? C.vert('✔') : ok ? C.jaune('~') : C.rouge('✘');
    console.log(`    ${marque} ${pol.nom.padEnd(20)} erreur moyenne ${errMoy.toFixed(0).padStart(4)} px`
      + `   IoU moyenne ${iouMoy.toFixed(2)}   raccroche ${ok}/${lignes.length}`
      + C.dim(`   [${lignes.map(l => l.iou.toFixed(2)).join(' ')}]`));
  }
  console.log('');
}

console.log(`  ${C.bold('Bilan sur tous les trous mesurables')}`);
console.log(`  ${C.dim('politique               erreur médiane   IoU médiane   raccroche')}`);
const median = (a) => { if (!a.length) return NaN; const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
for (const pol of POLITIQUES) {
  const b = bilan.get(pol.nom);
  if (!b.total) continue;
  console.log(`  ${pol.nom.padEnd(22)} ${median(b.erreurs).toFixed(0).padStart(8)} px`
    + `   ${median(b.ious).toFixed(2).padStart(10)}`
    + `   ${String(b.raccroches).padStart(5)}/${b.total}  ${(b.raccroches / b.total * 100).toFixed(0)} %`);
}
console.log('');
