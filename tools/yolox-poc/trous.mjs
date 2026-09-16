/* AUTOPSIE DES TROUS DE DÉTECTION — pourquoi une chaîne d'identité casse.

   Croise un rapport de suivi (`rx-tracking/1`) avec une autopsie image par
   image (`rx-autopsie/1`) faite au seuil bas, et classe chaque trou.

     node tools/yolox-poc/trous.mjs <rapport-suivi.json> <rapport-autopsie.json>

   Le suivi seul ne peut pas répondre : quand une piste n'a pas de détection,
   il ne sait pas si la voiture a disparu de l'image ou si le modèle l'a
   ratée. L'autopsie, elle, montre TOUT ce que le modèle propose, y compris ce
   que le banc rejetterait — c'est la seule façon de séparer les deux.

   Six causes, qui n'appellent pas la même réponse :
     ① sortie du cadre        — rien à corriger, la voiture n'est plus là ;
     ② ratée par le modèle    — visible mais absente de la sortie du modèle ;
     ③ rejetée à l'association— détection FORTE présente, non retenue ;
     ④ trop faible            — détection présente mais sous le seuil du banc ;
     ⑤ fusionnée              — une seule boîte pour deux voitures ;
     ⑥ piste expirée trop tôt — la détection revient après la mort. */

import { readFileSync } from 'node:fs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`, bleu: (s) => `\x1b[36m${s}\x1b[0m`,
};

const IOU_RECOUVRE = 0.30;   // en dessous, on ne prétend pas que c'est la même voiture
const BORD_TRONQUE = 4;      // px : la boîte touche le cadre

const aire = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = aire(a) + aire(b) - i;
  return u > 0 ? i / u : 0;
}
/** Part de `petite` contenue dans `grande` — c'est ce qui trahit une fusion. */
function contenu(petite, grande) {
  const x1 = Math.max(petite[0], grande[0]), y1 = Math.max(petite[1], grande[1]);
  const x2 = Math.min(petite[2], grande[2]), y2 = Math.min(petite[3], grande[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return aire(petite) > 0 ? i / aire(petite) : 0;
}

const [fSuivi, fAutopsie] = process.argv.slice(2);
if (!fSuivi || !fAutopsie) {
  console.error('\n  usage : node tools/yolox-poc/trous.mjs <rapport-suivi.json> <rapport-autopsie.json>\n');
  process.exit(1);
}
const suivi = JSON.parse(readFileSync(fSuivi, 'utf8'));
const autopsie = JSON.parse(readFileSync(fAutopsie, 'utf8'));
const journal = suivi.journal || [];
const seuilBanc = suivi.reglages?.seuilConfiance ?? 0.30;
const { largeur, hauteur } = autopsie.dimensions;

/** L'image d'autopsie la plus proche d'un instant du suivi. */
const parT = new Map(autopsie.images.map(im => [Number(im.t.toFixed(4)), im]));
function imageA(t) {
  let best = null, d = Infinity;
  for (const im of autopsie.images) {
    const e = Math.abs(im.t - t);
    if (e < d) { d = e; best = im; }
  }
  return d <= 1 / 60 + 1e-6 ? best : null;
}

console.log(`\n${C.bold('AUTOPSIE DES TROUS')}  ${C.dim(fSuivi.split('/').pop())}`);
console.log(`  suivi     : pas ${suivi.reglages?.pas} s, seuil du banc ${seuilBanc}`);
console.log(`  autopsie  : ${autopsie.images.length} images à ${autopsie.reglages.seuil} de seuil, `
  + `${autopsie.fenetre.tDebut.toFixed(3)} → ${autopsie.fenetre.tFin.toFixed(3)} s`);
console.log(`  méthode   : ${autopsie.methodeNettete}`);

// ── ce que le modèle voit, image par image ──────────────
console.log(`\n  ${C.bold('Ce que le modèle propose, à seuil bas')}`);
console.log(`  ${C.dim('img    t        fortes  faibles  netteté img  mouvement')}`);
for (const im of autopsie.images) {
  if (im.image % 3) continue;                       // une image sur trois, pour tenir à l'écran
  const fortes = im.detections.filter(d => d.score >= seuilBanc).length;
  const faibles = im.detections.length - fortes;
  const barre = '█'.repeat(fortes) + C.dim('░'.repeat(faibles));
  console.log(`  ${String(im.image).padEnd(6)} ${im.t.toFixed(4)}  ${String(fortes).padStart(3)}`
    + `     ${String(faibles).padStart(3)}     ${String(im.netteteImage?.variance ?? '').padStart(8)}`
    + `     ${String(im.mouvementImage?.moyenne ?? '').padStart(6)}  ${barre}`);
}

// ── les trous, piste par piste ──────────────────────────
const instants = journal.filter(j => j.t >= autopsie.fenetre.tDebut - 1e-9 && j.t <= autopsie.fenetre.tFin + 1e-9);
const ids = [...new Set(instants.flatMap(j => j.tracks.map(t => t.id)))];

const compte = new Map();
const noter = (cat) => compte.set(cat, (compte.get(cat) || 0) + 1);

console.log(`\n  ${C.bold('Chaque piste, chaque instant sans détection')}`);
for (const id of ids) {
  const vus = instants.filter(j => j.tracks.some(t => t.id === id));
  if (!vus.length) continue;
  const dernier = vus[vus.length - 1];
  const piste = dernier.tracks.find(t => t.id === id);
  const trous = vus.filter(j => !j.tracks.find(t => t.id === id)?.boiteAssociee);
  const avecDet = vus.filter(j => j.tracks.find(t => t.id === id)?.boiteAssociee);
  if (!trous.length) continue;

  console.log(`\n  ${C.bold(`piste ${id}`)} ${C.dim(`(identité ${piste.identiteLogique}, `
    + `${avecDet.length} instant(s) avec détection, ${trous.length} sans, `
    + `vue de ${vus[0].t} à ${dernier.t} s)`)}`);

  for (const inst of trous) {
    const tr = inst.tracks.find(t => t.id === id);
    const boite = tr.box;                            // position prédite
    const im = imageA(inst.t);
    const bordMin = Math.min(boite[0], boite[1], largeur - boite[2], hauteur - boite[3]);
    const horsCadre = boite[2] <= 0 || boite[0] >= largeur || boite[3] <= 0 || boite[1] >= hauteur;

    // La meilleure détection de l'autopsie qui recouvre la position prédite.
    let meilleure = null, m = 0;
    for (const d of im?.detections || []) {
      const r = iou(boite, d.box);
      if (r > m) { m = r; meilleure = d; }
    }
    // ... et la plus PROCHE, quelle que soit son IoU. Sans elle, on ne peut
    // pas distinguer « la voiture n'est plus là » de « la prédiction a
    // dérivé loin d'elle » : les deux donnent une IoU nulle.
    const cxb = (boite[0] + boite[2]) / 2, cyb = (boite[1] + boite[3]) / 2;
    let proche = null, dmin = Infinity;
    for (const d of im?.detections || []) {
      const dx = (d.box[0] + d.box[2]) / 2 - cxb, dy = (d.box[1] + d.box[3]) / 2 - cyb;
      const dist = Math.hypot(dx, dy);
      if (dist < dmin) { dmin = dist; proche = d; }
    }
    // Une détection proche ET de taille comparable, c'est probablement la
    // voiture — la prédiction s'en est écartée.
    const diagonale = Math.hypot(boite[2] - boite[0], boite[3] - boite[1]);
    const plausible = proche && dmin < 1.5 * diagonale
      && aire(proche.box) > 0.4 * aire(boite) && aire(proche.box) < 2.5 * aire(boite);
    // Une boîte bien plus grande qui CONTIENT la position prédite trahit une
    // fusion : le modèle a vu deux voitures comme une seule.
    let fusion = null;
    for (const d of im?.detections || []) {
      if (aire(d.box) > 1.6 * aire(boite) && contenu(boite, d.box) > 0.7) { fusion = d; break; }
    }

    let cat, detail;
    // « Hors cadre » ne veut pas dire « entièrement sortie » : dès qu'une
    // fraction notable de la boîte dépasse, la voiture est tronquée et le
    // modèle n'a plus grand-chose à saisir. La distance au bord devient
    // NÉGATIVE dans ce cas — c'est ce que le premier jet ne regardait pas.
    const partDehors = 1 - aire([
      Math.max(0, boite[0]), Math.max(0, boite[1]),
      Math.min(largeur, boite[2]), Math.min(hauteur, boite[3]),
    ]) / Math.max(1, aire(boite));

    if (horsCadre || partDehors > 0.25) {
      cat = '① sortie du cadre';
      detail = horsCadre ? 'la position prédite est entièrement hors image'
        : `${Math.round(partDehors * 100)} % de la boîte dépasse le cadre (bord ${Math.round(bordMin)} px)`;
    }
    else if (fusion && (!meilleure || m < IOU_RECOUVRE)) {
      cat = '⑤ fusionnée';
      detail = `absorbée par une boîte ${Math.round(aire(fusion.box) / aire(boite) * 10) / 10}× plus grande, score ${fusion.score}`;
    } else if (!meilleure || m < IOU_RECOUVRE) {
      // Deux situations que l'IoU seule confond, et que la détection la plus
      // proche sépare.
      if (plausible) {
        cat = proche.score >= seuilBanc ? '③ rejetée à l\'association' : '④ trop faible';
        detail = `détection plausible à ${Math.round(dmin)} px du centre prédit `
          + `(score ${proche.score}, ${proche.largeur}×${proche.hauteur}, IoU ${m.toFixed(2)}) `
          + `— la prédiction a dérivé, la voiture est là`;
      } else {
        cat = '② absente de la sortie du modèle';
        detail = `rien de plausible autour (plus proche à ${Number.isFinite(dmin) ? Math.round(dmin) : '∞'} px`
          + `${proche ? `, score ${proche.score}, ${proche.largeur}×${proche.hauteur}` : ''})`
          + (bordMin < BORD_TRONQUE ? `, boîte au bord (${Math.round(bordMin)} px)` : '');
      }
    } else if (meilleure.score >= seuilBanc) {
      cat = '③ rejetée à l\'association';
      const refus = (suivi.refus || []).filter(r => Math.abs(r.t - inst.t) < 1e-6 && r.id === id);
      detail = `détection FORTE présente (score ${meilleure.score}, IoU ${m.toFixed(2)})`
        + (refus.length ? ` — refus : ${[...new Set(refus.map(r => r.raison))].join(', ')}` : '');
    } else {
      cat = '④ trop faible';
      detail = `score ${meilleure.score} < ${seuilBanc} (IoU ${m.toFixed(2)}, ${meilleure.largeur}×${meilleure.hauteur}`
        + `, netteté ${meilleure.nettete?.variance ?? '?'}, bord ${meilleure.bord.min})`;
    }
    noter(cat);
    const couleur = cat.startsWith('①') ? C.dim : cat.startsWith('③') ? C.rouge : cat.startsWith('②') ? C.jaune : C.bleu;
    console.log(`    t=${String(inst.t).padEnd(5)} [${tr.state}] ${couleur(cat.padEnd(26))} ${C.dim(detail)}`);
  }

  // Mort et suite : la voiture revient-elle sous une autre piste ?
  const apres = journal.filter(j => j.t > dernier.t);
  let reprise = null;
  for (const j of apres) {
    for (const t of j.tracks) {
      if (t.id === id || !t.boiteAssociee) continue;
      if (j.t - dernier.t > 1.5) continue;
      if (iou(piste.box, t.boiteAssociee) >= IOU_RECOUVRE && t.id > id) {
        reprise = { t: j.t, id: t.id, iou: iou(piste.box, t.boiteAssociee) };
        break;
      }
    }
    if (reprise) break;
  }
  const fin = journal.find(j => j.t > dernier.t);
  if (fin && !fin.tracks.some(t => t.id === id)) {
    console.log(`    ${C.bold('mort')} après ${dernier.t} s`
      + (reprise
        ? C.rouge(`  →  ⑥ la même voiture repart sous la piste ${reprise.id} à ${reprise.t} s `
          + `(IoU ${reprise.iou.toFixed(2)}, ${((reprise.t - dernier.t) * 1000).toFixed(0)} ms plus tard)`)
        : C.dim('  →  aucune piste ne la reprend dans la seconde et demie qui suit')));
    if (reprise) noter('⑥ piste expirée trop tôt');
  }
}

console.log(`\n  ${C.bold('Bilan des causes')}`);
const total = [...compte.values()].reduce((a, b) => a + b, 0) || 1;
for (const [cat, n] of [...compte.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${cat.padEnd(26)} ${String(n).padStart(4)}   ${(n / total * 100).toFixed(1)} %`);
}
console.log('');
