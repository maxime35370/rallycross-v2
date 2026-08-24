/* VÉRITÉ AU CUT — noter une réattribution contre des correspondances annotées.

   Le rapport de suivi parle en identifiants de PISTES ; l'annotation parle en
   BOÎTES relevées sur deux images. Rien ne les relie a priori : ce script fait
   le pont par recouvrement, publie l'IoU de chaque appariement, et refuse
   silencieusement d'aligner ce qui ne se recouvre pas.

     node tools/yolox-poc/verite-cut.mjs <rapport-suivi.json> <verite.json>

   Le fichier de vérité :
     {
       "schema": "rx-verite-cut/1",
       "tAvant": 5.8, "tApres": 5.9,
       "avant": [{ "nom": "A1", "box": [549,523,716,638] }, …],
       "apres": [{ "nom": "B3", "box": [763,415,986,595] }, …],
       "correspondances": { "A1": "B8", "A2": "B7", "A3": "B6", "A4": "B4" }
     }
   Une voiture d'`apres` absente des correspondances est une entrée sans
   antécédent : ne pas la rattacher est la bonne réponse, pas une omission. */

import { readFileSync } from 'node:fs';
import { noter } from './lib/reattribution.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};

const IOU_MIN = 0.5;   // en dessous, on ne prétend pas que c'est la même voiture

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aire = (c) => Math.max(0, c[2] - c[0]) * Math.max(0, c[3] - c[1]);
  const u = aire(a) + aire(b) - inter;
  return u > 0 ? inter / u : 0;
}

/** Instant du journal le plus proche de `t`. */
function instantPres(journal, t) {
  let best = null, d = Infinity;
  for (const inst of journal) {
    const e = Math.abs(inst.t - t);
    if (e < d) { d = e; best = inst; }
  }
  return best ? { instant: best, ecart: d } : null;
}

/**
 * Relie les boîtes annotées aux identifiants de pistes, par recouvrement.
 * Rend aussi les non-appariés : une annotation qu'aucune piste ne recouvre
 * n'est pas un échec de la réattribution, c'est un trou de détection, et
 * les deux ne doivent pas se confondre dans le décompte.
 */
function relier(voitures, tracks, cle = 'box') {
  const liens = new Map(), details = [];
  const pris = new Set();
  for (const v of voitures) {
    let meilleur = null, m = 0;
    for (const tr of tracks) {
      const b = tr[cle] || tr.box;
      if (!b || pris.has(tr.id)) continue;
      const r = iou(v.box, b);
      if (r > m) { m = r; meilleur = tr; }
    }
    if (meilleur && m >= IOU_MIN) {
      liens.set(v.nom, meilleur.id); pris.add(meilleur.id);
      details.push({ nom: v.nom, id: meilleur.id, iou: Number(m.toFixed(3)) });
    } else {
      details.push({ nom: v.nom, id: null, iou: Number(m.toFixed(3)) });
    }
  }
  return { liens, details };
}

// ── entrée ──────────────────────────────────────────────
const [fRapport, fVerite] = process.argv.slice(2);
if (!fRapport || !fVerite) {
  console.error('\n  usage : node tools/yolox-poc/verite-cut.mjs <rapport-suivi.json> <verite.json>\n');
  process.exit(1);
}
const rapport = JSON.parse(readFileSync(fRapport, 'utf8'));
const verite = normaliserVerite(JSON.parse(readFileSync(fVerite, 'utf8')));

/**
 * Accepte aussi un rapport `rx-apparence/1` tel que la page /__apparence
 * l'exporte, annotations comprises.
 *
 * C'est là que l'annotation se fait — relever les boîtes à la main dans un
 * second fichier serait une occasion de plus de se tromper, et deux sources
 * de vérité qui divergent valent moins qu'une seule.
 */
function normaliserVerite(v) {
  if (v.schema !== 'rx-apparence/1') return v;
  const correspondances = {};
  for (const l of v.lignes || []) if (l.verite) correspondances[l.avant] = l.verite;
  return {
    schema: 'rx-verite-cut/1',
    source: `converti depuis rx-apparence/1 (images ${v.avant?.image} → ${v.apres?.image})`,
    tAvant: v.avant?.t, tApres: v.apres?.t,
    avant: (v.avant?.voitures || []).map(x => ({ nom: `A${x.rang}`, box: x.box })),
    apres: (v.apres?.voitures || []).map(x => ({ nom: `B${x.rang}`, box: x.box })),
    correspondances,
  };
}
const journal = rapport.journal || [];
const reattributions = rapport.mesures?.identites?.reattributions || [];

console.log(`\n${C.bold('VÉRITÉ AU CUT')}  ${C.dim(fRapport.split('/').pop())}`);
console.log(`  méthode : ${rapport.methodeReattribution || C.jaune('aucune — réattribution désactivée')}`);
console.log(`  pas     : ${rapport.reglages?.pas} s   coupures appliquées : ${JSON.stringify(rapport.coupures)}`);

const av = instantPres(journal, verite.tAvant);
const ap = instantPres(journal, verite.tApres);
if (!av || !ap) { console.error('  journal vide'); process.exit(1); }
console.log(`  instants : ${av.instant.t} s (écart ${(av.ecart * 1000).toFixed(0)} ms) → `
  + `${ap.instant.t} s (écart ${(ap.ecart * 1000).toFixed(0)} ms)`);

// Côté « avant », la boîte pertinente est celle réellement ASSOCIÉE : une
// boîte prédite décrit l'hypothèse du suivi, pas la voiture annotée.
const A = relier(verite.avant, av.instant.tracks, 'boiteAssociee');
const B = relier(verite.apres, ap.instant.tracks, 'boiteAssociee');

const ligne = (titre, d) => {
  console.log(`\n  ${C.bold(titre)}`);
  for (const x of d) {
    console.log(`    ${x.nom.padEnd(4)} → ${x.id != null ? `piste ${String(x.id).padEnd(4)}` : C.jaune('aucune piste'.padEnd(10))}`
      + `  ${C.dim(`IoU ${x.iou}`)}`);
  }
};
ligne(`plan A · t = ${av.instant.t} s`, A.details);
ligne(`plan B · t = ${ap.instant.t} s`, B.details);

// ── vérité, traduite en identifiants de pistes ──────────
const attendu = new Map();
let sansPiste = 0;
for (const [nomA, nomB] of Object.entries(verite.correspondances || {})) {
  const idA = A.liens.get(nomA), idB = B.liens.get(nomB);
  if (idA == null || idB == null) { sansPiste += 1; continue; }
  attendu.set(idA, idB);
}

console.log(`\n  ${C.bold('correspondances annotées')} : ${Object.keys(verite.correspondances || {}).length}`);
console.log(`  dont exploitables (les deux pistes existent) : ${attendu.size}`
  + (sansPiste ? `   ${C.jaune(`${sansPiste} hors de portée du suivi`)}` : ''));

if (!reattributions.length) {
  console.log(`\n  ${C.jaune('aucune réattribution dans ce rapport')} — c\'est le témoin.`);
  console.log(`  identités du départ au V1 : ${rapport.mesures?.identites?.survivantesDepart}\n`);
  process.exit(0);
}

for (const r of reattributions) {
  console.log(`\n  ${C.bold(`réattribution à t = ${r.t} s`)}  (coupure ${r.tCoupure} s)`);
  console.log(`    décision  : ${r.decision}${r.raison ? ` (${r.raison})` : ''}`);
  console.log(`    modèle    : ${r.modele}   angle ${r.meilleur?.angleDeg}°   échelle ${r.meilleur?.echelle}`);
  console.log(`    marge     : ${r.marge?.toFixed(4)}   relative ${(r.margeRelative * 100).toFixed(1)} %`);
  console.log(`    hypothèses: ${r.hypothesesEvaluees}, dont ${r.ecarteesParSens} écartées par le sens de marche`);
  if (r.apparence) {
    const dispo = r.apparence.meilleur != null && r.apparence.second != null;
    console.log(`    apparence : ${dispo
      ? `meilleur ${r.apparence.meilleur.toFixed(4)} · second ${r.apparence.second.toFixed(4)}`
        + `   écart ${(r.apparence.ecartRelatif * 100).toFixed(1)} %  → ${r.apparence.tranche ? C.vert('elle tranche') : 'elle ne tranche pas'}`
      : C.jaune('indisponible — au moins une piste sans signature mémorisée')}`);
  }

  const n = noter(r.appariements, attendu, [...attendu.keys()]);
  console.log(`\n    ${C.bold('verdict')}`);
  for (const d of n.detail) {
    const marque = d.verdict === 'juste' ? C.vert('✔ juste')
      : d.verdict === 'faux' ? C.rouge('✘ FAUX')
        : C.dim('· hors vérité');
    console.log(`      piste ${String(d.avant).padEnd(4)} → ${String(d.apres).padEnd(4)} ${marque}`
      + (d.attendu != null && d.verdict === 'faux' ? C.dim(`  (attendu ${d.attendu})`) : ''));
  }
  for (const id of n.idsNonDecidees) console.log(`      piste ${String(id).padEnd(4)} → ${C.jaune('non décidée')}`);
  console.log(`\n      justes ${C.vert(String(n.justes))} · fausses ${n.fausses ? C.rouge(String(n.fausses)) : '0'}`
    + ` · non décidées ${C.jaune(String(n.nonDecidees))} · hors vérité ${n.horsVerite}`
    + `   ${C.dim(`sur ${n.attendues} attendues`)}`);
}

// ── le balayage, NOTÉ ───────────────────────────────────
//
// Le balayage seul dit ce que chaque réglage déciderait ; il ne dit pas si
// ces décisions sont justes. Croisé avec la vérité, il devient la seule base
// honnête pour choisir un seuil — et la seule façon de voir qu'un réglage
// plus permissif n'ajoute que des erreurs.
for (const r of reattributions) {
  const bal = r.balayage || [];
  if (!bal.length) continue;
  console.log(`\n  ${C.bold('balayage noté')}  ${C.dim(`(coupure ${r.tCoupure} s)`)}`);
  const poids = [...new Set(bal.map(l => l.poidsTaille))].sort((a, b) => a - b);
  for (const w of poids) {
    console.log(`    ${C.dim(`poids de taille ${w}`)}`);
    for (const l of bal.filter(x => x.poidsTaille === w && x.margeApparenceMin === 0.05)) {
      const n = noter(l.appariements, attendu, [...attendu.keys()]);
      const verdict = `${n.justes} juste${n.justes > 1 ? 's' : ''}`
        + ` · ${n.fausses ? C.rouge(`${n.fausses} FAUSSE${n.fausses > 1 ? 'S' : ''}`) : '0 fausse'}`
        + ` · ${C.jaune(`${n.nonDecidees} non décidée${n.nonDecidees > 1 ? 's' : ''}`)}`;
      console.log(`      margeMin ${String(l.margeMin).padEnd(5)} → ${l.decision.padEnd(10)} ${verdict}`
        + (l.appariements.length ? C.dim(`   [${l.appariements.map(a => `${a.avant}>${a.apres}`).join(' ')}]`) : ''));
    }
  }
}

const id = rapport.mesures?.identites;
console.log(`\n  ${C.bold('identités du DÉPART au V1')} : ${id?.survivantesDepart} ${C.dim(`(${JSON.stringify(id?.idsSurvivantes)})`)}`);
console.log(`  identités logiques au V1 : ${id?.auV1} ${C.dim(JSON.stringify(id?.idsV1))}`);
console.log(`  instants bifurqués : ${id?.instantsBifurques}${id?.instantsBifurques ? C.rouge('  ← une identité vivante deux fois') : ''}\n`);
