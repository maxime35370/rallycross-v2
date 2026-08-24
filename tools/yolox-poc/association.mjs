/* AUTOPSIE D'UNE ASSOCIATION — pas par pas, porte par porte.

     node tools/yolox-poc/association.mjs <suivi.json> [suivi-témoin.json] [tDébut] [tFin]

   Quand une voiture change d'identité, le journal dit QUE la piste n'a rien
   reçu ; il ne dit pas POURQUOI. Or il y a cinq endroits où une détection
   parfaitement valable peut disparaître avant d'atteindre une piste :

     ① `_reperersFusions` la retire du lot, la jugeant « boîte fusionnée » ;
     ② la porte d'IoU la refuse ;
     ③ le rapport de taille la refuse ;
     ④ l'affectation hongroise la donne à une autre piste ;
     ⑤ elle reste libre et sert à créer une identité neuve.

   Ce script rejoue les trois premiers filtres à partir des boîtes PRÉDITES
   inscrites au journal, puis l'affectation elle-même, et publie la matrice
   complète — parce qu'une paire localement juste peut être sacrifiée pour
   baisser le coût total, et qu'on ne le voit pas en lisant les meilleurs
   candidats piste par piste.

   Le lot de détections est reconstitué par l'UNION des boîtes associées dans
   les rapports fournis : le détecteur est le même, seule l'association
   diffère. Donner un second rapport en témoin est donc le moyen de voir les
   détections que le premier a laissées tomber. Ce que ni l'un ni l'autre n'a
   associé reste invisible — le compte déclaré par le run le dit, et l'écart
   est affiché. Rien n'est modifié : c'est une mesure. */

import { readFileSync } from 'node:fs';
import { aire, centre, taille, rapportTaille, hungarian } from './lib/track.mjs';
import { iou } from './lib/detect.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const b2s = (b) => `[${b.map(v => String(Math.round(v)).padStart(4)).join(',')}]`;

const [fPrincipal, fTemoin, tD, tF] = process.argv.slice(2);
if (!fPrincipal) {
  console.error('\n  usage : node tools/yolox-poc/association.mjs <suivi.json> [témoin.json] [tDébut] [tFin]\n');
  process.exit(1);
}
const lire = (f) => JSON.parse(readFileSync(f, 'utf8'));
const principal = lire(fPrincipal);
const temoin = fTemoin && fTemoin !== '-' ? lire(fTemoin) : null;
const tDebut = Number(tD ?? principal.fenetre?.debut ?? 0);
const tFin = Number(tF ?? principal.fenetre?.fin ?? 1e9);

const o = principal.reglages.tracker;
const INTERDIT = 10;

console.log(`\n${C.bold('AUTOPSIE DE L\'ASSOCIATION')}  ${C.dim(fPrincipal.split('/').pop())}`
  + (temoin ? C.dim(`   témoin : ${fTemoin.split('/').pop()}`) : ''));
console.log(`  portes : iouMatch ${o.iouMatch} · iouMatchLow ${o.iouMatchLow} · iouRecover ${o.iouRecover}`
  + ` · maxSizeRatio ${o.maxSizeRatio} · mergeAreaRatio ${o.mergeAreaRatio}`);

const instantsDe = (rapport) => new Map((rapport.journal || []).map(j => [Number(j.t.toFixed(4)), j]));
const A = instantsDe(principal), B = temoin ? instantsDe(temoin) : new Map();

for (const [t, j] of A) {
  if (t < tDebut - 1e-9 || t > tFin + 1e-9) continue;

  // ── le lot de détections, reconstitué ──
  const lot = [];
  const ajouter = (box, score, origine) => {
    if (!box) return;
    const cle = box.join(',');
    const deja = lot.find(d => d.box.join(',') === cle);
    if (deja) { if (!deja.origine.includes(origine)) deja.origine += `+${origine}`; return; }
    lot.push({ box, score, origine });
  };
  for (const tr of j.tracks) ajouter(tr.boiteAssociee, tr.score, 'run');
  const jt = B.get(t);
  if (jt) for (const tr of jt.tracks) ajouter(tr.boiteAssociee, tr.score, 'témoin');
  lot.sort((x, y) => x.box[0] - y.box[0]);
  const fortes = lot.filter(d => (d.score ?? 0) >= o.highScore);
  const faibles = lot.filter(d => (d.score ?? 0) < o.highScore && (d.score ?? 0) >= o.lowScore);

  const declare = j.detections || {};
  const manquantes = (declare.fortes ?? 0) - fortes.length;

  console.log(`\n${C.bold(`── t = ${t} s`)} ${C.dim(`— le run déclare ${declare.total} détection(s) : `
    + `${declare.fortes} forte(s), ${declare.faibles} faible(s), ${declare.fusions} écartée(s) comme fusion`)}`);
  console.log(`   ${C.dim(`reconstituées : ${fortes.length} forte(s), ${faibles.length} faible(s)`)}`
    + (manquantes > 0 ? `  ${C.jaune(`${manquantes} forte(s) invisible(s) — associée(s) par aucun des deux runs`)}` : ''));

  const candidates = j.tracks.filter(p => !p.suspendue);
  if (!candidates.length || !fortes.length) { console.log(`   ${C.dim('rien à apparier')}`); continue; }

  // ── ① le filtre « boîte fusionnée », rejoué ──
  //
  // Il passe AVANT tout le reste : une détection qu'il retire n'atteint jamais
  // la matrice, et le journal la fait alors apparaître comme inexistante.
  const retirees = new Set();
  for (const [i, d] of fortes.entries()) {
    const touchees = candidates.filter(p => p.confirmee
      && iou(p.boiteCompensee || p.box, d.box) > o.iouRecover);
    if (touchees.length < 2) continue;
    const aires = touchees.map(p => aire(p.boiteCompensee || p.box)).sort((a, b) => a - b);
    const mediane = aires[Math.floor(aires.length / 2)];
    const ratio = mediane ? aire(d.box) / mediane : 0;
    const fusion = mediane && ratio >= o.mergeAreaRatio;
    if (fusion) retirees.add(i);
    const meilleure = touchees.reduce((m, p) =>
      iou(p.boiteCompensee || p.box, d.box) > iou(m.boiteCompensee || m.box, d.box) ? p : m, touchees[0]);
    console.log(`   ${fusion ? C.rouge('FUSION') : C.dim('      ')} ${b2s(d.box)} aire ${String(aire(d.box)).padStart(6)}`
      + `  touche ${touchees.length} piste(s) ${touchees.map(p => p.id).join(',')}`
      + `  aires ${aires.join('·')}  médiane ${mediane}  rapport ${ratio.toFixed(3)}`
      + (fusion ? C.rouge(`  ≥ ${o.mergeAreaRatio} → RETIRÉE du lot`)
        : C.dim(`  < ${o.mergeAreaRatio} → conservée`))
      + C.dim(`   [meilleure : piste ${meilleure.id}, IoU ${iou(meilleure.boiteCompensee || meilleure.box, d.box).toFixed(3)}]`));
  }
  const utilisables = fortes.filter((_, i) => !retirees.has(i));

  // ── ② ③ la matrice, terme par terme ──
  const matrice = candidates.map(p => utilisables.map(d => {
    const bp = p.boiteCompensee || p.box;
    const r = iou(bp, d.box);
    const rt = rapportTaille(bp, d.box);
    const [ax, ay] = centre(bp), [bx, by] = centre(d.box);
    const [w, h] = taille(bp);
    const dist = Math.hypot(ax - bx, ay - by);
    const distN = dist / Math.max(1, Math.max(w, h));
    let motif = null;
    if (r < o.iouMatch) motif = 'iou';
    else if (rt > o.maxSizeRatio) motif = 'taille';
    return { r, rt, dist, distN, cout: motif ? INTERDIT : 1 - r, motif };
  }));

  console.log(`\n   ${C.bold('Matrice de coût')} ${C.dim(`— ${candidates.length} piste(s) × ${utilisables.length} détection(s) retenue(s) · coût = 1 − IoU`)}`);
  const enTete = utilisables.map((d, k) => `D${k}`.padStart(9)).join('');
  console.log(`   ${C.dim('piste'.padEnd(8) + enTete)}`);
  for (const [k, d] of utilisables.entries()) {
    console.log(`   ${C.dim(`D${k} = ${b2s(d.box)} score ${(d.score ?? 0).toFixed(2)} (${d.origine})`)}`);
  }
  matrice.forEach((ligne, i) => {
    const p = candidates[i];
    const cases = ligne.map(c => c.motif
      ? C.dim(`  ✕${c.motif === 'iou' ? 'iou' : 'tai'} `.padStart(9))
      : (c.cout < 0.5 ? C.vert : (s) => s)(c.cout.toFixed(3).padStart(9))).join('');
    console.log(`   ${String(`${p.id}${p.confirmee ? '' : '*'}`).padEnd(8)}${cases}`);
  });

  // ── ④ l'affectation ──
  const aff = hungarian(matrice.map(l => l.map(c => c.cout)));
  const choisies = [];
  aff.forEach((jj, i) => {
    if (jj < 0 || jj >= utilisables.length || matrice[i][jj].cout >= INTERDIT) return;
    choisies.push([candidates[i], jj, matrice[i][jj]]);
  });
  console.log(`\n   ${C.bold('Affectation retenue par le hongrois')}`);
  for (const [p, jj, c] of choisies) {
    console.log(`     piste ${String(p.id).padStart(3)} → D${jj}   IoU ${c.r.toFixed(3)}`
      + `   centres ${c.dist.toFixed(0).padStart(4)} px (${c.distN.toFixed(2)} diag)`
      + `   rapport de taille ${c.rt.toFixed(2)}   coût ${c.cout.toFixed(3)}`);
    // Ce que cette piste a perdu en acceptant ce choix.
    const mieux = matrice[candidates.indexOf(p)]
      .map((x, k) => ({ k, ...x })).filter(x => x.cout < c.cout);
    if (mieux.length) {
      console.log(`       ${C.jaune('sacrifiée')} : elle préférait ${mieux.map(x => `D${x.k} (coût ${x.cout.toFixed(3)})`).join(', ')}`
        + C.dim(' — l\'affectation globale en a décidé autrement'));
    }
  }
  const servies = new Set(choisies.map(([, jj]) => jj));
  for (const [k] of utilisables.entries()) {
    if (servies.has(k)) continue;
    console.log(`     ${C.jaune(`D${k} libre`)} — aucune piste ne la reçoit`);
  }

  // ── ⑤ et si le filtre de fusion n'avait rien retiré ? ──
  //
  // La question de fond : la bonne paire est-elle SACRIFIÉE par l'affectation
  // globale, ou n'a-t-elle jamais été soumise ? On rejoue donc l'affectation
  // sur le lot COMPLET. Si la paire apparaît ici et pas plus haut, ce n'est
  // pas le hongrois qu'il faut corriger, c'est la porte en amont.
  if (retirees.size) {
    const m2 = candidates.map(p => fortes.map(d => {
      const bp = p.boiteCompensee || p.box;
      const r = iou(bp, d.box);
      const rt = rapportTaille(bp, d.box);
      const interdit = r < o.iouMatch || rt > o.maxSizeRatio;
      return { r, rt, cout: interdit ? INTERDIT : 1 - r };
    }));
    const a2 = hungarian(m2.map(l => l.map(c => c.cout)));
    console.log(`\n   ${C.bold('Contrefactuel')} ${C.dim('— la même affectation, sans retirer les « fusions »')}`);
    a2.forEach((jj, i) => {
      if (jj < 0 || jj >= fortes.length || m2[i][jj].cout >= INTERDIT) return;
      const neuf = !choisies.some(([p, k]) => p === candidates[i]
        && utilisables[k] && utilisables[k].box.join(',') === fortes[jj].box.join(','));
      console.log(`     piste ${String(candidates[i].id).padStart(3)} → ${b2s(fortes[jj].box)}`
        + `   IoU ${m2[i][jj].r.toFixed(3)}   coût ${m2[i][jj].cout.toFixed(3)}`
        + (neuf ? C.vert('   ← paire que le filtre a empêchée') : ''));
    });
  }

  // ── ce que le run a RÉELLEMENT fait, et le témoin ──
  console.log(`\n   ${C.bold('Ce que le run a fait')}`);
  for (const p of candidates) {
    const vu = p.boiteAssociee;
    const jumeau = jt?.tracks.find(x => (x.boiteCompensee || x.box).join(',') === (p.boiteCompensee || p.box).join(','));
    const cote = jumeau
      ? (jumeau.boiteAssociee ? C.vert(`témoin : piste ${jumeau.id} reçoit ${b2s(jumeau.boiteAssociee)}`)
        : C.dim(`témoin : piste ${jumeau.id} sans mesure`))
      : '';
    console.log(`     piste ${String(p.id).padStart(3)} ${p.confirmee ? ' ' : '*'} ${String(p.state).padEnd(9)}`
      + ` ${vu ? C.vert(`reçoit ${b2s(vu)}`) : C.rouge('sans mesure   '.padEnd(14))}   ${cote}`);
  }
  const refus = (principal.refus || []).filter(r => Math.abs(r.t - t) < 1e-6);
  if (refus.length) {
    console.log(`   ${C.dim('refus inscrits par le run :')}`);
    for (const r of refus) {
      console.log(`     ${C.dim(`${r.cote} ${r.id ?? ''} → cible ${r.cible} · IoU ${r.iou} · ratio ${r.ratio} · dist ${r.distance} · ${r.raison}`)}`);
    }
  }
}
console.log('');
