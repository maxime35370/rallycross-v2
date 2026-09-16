/* COMPARER DEUX SUIVIS SUR LE MÊME EXTRAIT — au niveau du JOURNAL.

     node tools/yolox-poc/comparer.mjs <verite-cut.json> <run.json> [run2.json ...]

   `tableau.mjs` compare des rapports produits par NOTRE suivi : il lit
   `mesures`, que seul notre `mesurer()` sait remplir. Pour confronter un
   tracker extérieur, il faut un instrument qui ne suppose rien de plus que ce
   que tout tracker sait produire : une suite d'instants, et à chaque instant
   des boîtes portant un identifiant.

   Tout ce qui suit se calcule donc sur le seul journal, à l'exception des
   inversions d'ordre qui appellent `coherenceSpatiale` — déjà écrite pour un
   journal, et donc commune aux deux côtés. Aucun chiffre n'est recopié d'un
   rapport : c'est le même code qui mesure les deux.

   La mesure qui décide est la dernière : sur les correspondances ANNOTÉES à
   la coupure, combien sont portées par la même identité avant et après ?
   Un tracker qui ignore les coupures y répond zéro par construction, et c'est
   exactement ce qu'on cherche à chiffrer. */

import { readFileSync } from 'node:fs';
import { coherenceSpatiale } from './lib/track.mjs';
import { iou } from './lib/detect.mjs';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
  jaune: (s) => `\x1b[33m${s}\x1b[0m`,
};
const aire = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const med = (a) => { if (!a.length) return NaN; const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
const quantile = (a, q) => { if (!a.length) return NaN; const t = [...a].sort((x, y) => x - y); return t[Math.min(t.length - 1, Math.floor((t.length - 1) * q))]; };

const [fVerite, ...fRuns] = process.argv.slice(2);
if (!fRuns.length) {
  console.error('\n  usage : node tools/yolox-poc/comparer.mjs <verite-cut.json> <run.json> [...]\n');
  process.exit(1);
}
const verite = JSON.parse(readFileSync(fVerite, 'utf8'));

/** L'instant du journal le plus proche de `t`, du côté demandé. */
const instantPres = (journal, t, cote) => journal
  .filter(j => (cote < 0 ? j.t <= t + 1e-9 : j.t >= t - 1e-9))
  .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] ?? null;

/** Quelle piste porte cette boîte annotée, à cet instant ? */
function pisteDe(instant, boite) {
  if (!instant) return null;
  let meilleure = null, meilleurIou = 0.5;          // franc, pas approximatif
  for (const tr of instant.tracks) {
    const b = tr.boiteAssociee || tr.box;
    if (!b) continue;
    const r = iou(b, boite);
    if (r > meilleurIou) { meilleurIou = r; meilleure = tr; }
  }
  return meilleure;
}

/**
 * Les voitures de la grille, de gauche à droite, au premier instant.
 * Une boîte largement contenue dans une autre n'en est pas une : sur cette
 * grille le détecteur pose un liseré sur le pavillon d'une voiture.
 */
function grilleDe(journal) {
  // PAS le premier instant : aucun tracker ne publie d'identité avant d'avoir
  // confirmé, et le nombre de confirmations demandées diffère de l'un à
  // l'autre. On prend, dans la première seconde, l'instant le mieux garni —
  // c'est là que la grille est au complet et encore immobile.
  const tot = journal[0].t;
  const premier = journal
    .filter(j => j.t <= tot + 1.0 + 1e-9)
    .reduce((best, j) => {
      const n = j.tracks.filter(t => t.confirmee && (t.boiteAssociee || t.box)).length;
      const m = best.tracks.filter(t => t.confirmee && (t.boiteAssociee || t.box)).length;
      return n > m ? j : best;
    }, journal[0]);
  const vues = premier.tracks.filter(t => t.confirmee && (t.boiteAssociee || t.box));
  const contenue = (p, g) => {
    const i = Math.max(0, Math.min(p[2], g[2]) - Math.max(p[0], g[0]))
      * Math.max(0, Math.min(p[3], g[3]) - Math.max(p[1], g[1]));
    return aire(p) > 0 && i / aire(p) > 0.5;
  };
  const boite = (t) => t.boiteAssociee || t.box;
  return vues
    .filter(t => !vues.some(u => u !== t && aire(boite(u)) > aire(boite(t)) && contenue(boite(t), boite(u))))
    .sort((a, b) => (boite(a)[0] + boite(a)[2]) - (boite(b)[0] + boite(b)[2]));
}

function mesurerJournal(rapport, nom) {
  const journal = rapport.journal;
  const grille = grilleDe(journal);
  const identsGrille = grille.map(t => t.id);        // l'identité au départ EST la piste de départ

  // Portée : le dernier instant où l'identité du départ est encore portée.
  const finale = new Map();
  for (const j of journal) for (const tr of j.tracks) finale.set(tr.id, tr.identiteLogique ?? tr.id);
  const portee = new Map(identsGrille.map(i => [i, journal[0].t]));
  const vie = new Map();                       // id -> [premier, dernier]
  const boitesPar = new Map();                 // id -> boîtes publiées
  for (const j of journal) {
    for (const tr of j.tracks) {
      if (!tr.confirmee) continue;
      const logique = finale.get(tr.id) ?? tr.identiteLogique ?? tr.id;
      if (portee.has(logique)) portee.set(logique, j.t);
      const v = vie.get(tr.id);
      if (v) v[1] = j.t; else vie.set(tr.id, [j.t, j.t]);
      if (!boitesPar.has(tr.id)) boitesPar.set(tr.id, []);
      boitesPar.get(tr.id).push(tr.box || tr.boiteAssociee);
    }
  }
  const tFin = journal[journal.length - 1].t;
  const auBout = identsGrille.filter(i => portee.get(i) >= tFin - 1e-9);

  // Dérive de taille : amplitude de la boîte PUBLIÉE sur la vie d'une piste.
  const amplitudes = [];
  for (const bs of boitesPar.values()) {
    const L = bs.map(b => b[2] - b[0]).filter(v => v > 0);
    const H = bs.map(b => b[3] - b[1]).filter(v => v > 0);
    if (L.length < 2) continue;
    amplitudes.push(Math.max(Math.max(...L) / Math.min(...L), Math.max(...H) / Math.min(...H)));
  }

  // Combien de pistes le suivi PUBLIE-t-il à chaque instant ? Sans cette
  // ligne, deux colonnes trompent : un tracker qui ne publie que les pistes
  // fraîchement appariées ne peut pas dériver en taille, et compare moins de
  // paires d'ordre. Il gagne alors sur la dérive et sur les inversions en
  // suivant MOINS de voitures.
  const parInstant = journal.map(j => j.tracks.filter(t => t.confirmee).length);

  const coh = coherenceSpatiale(journal);

  // Identité logique DÉFINITIVE de chaque piste : la dernière inscrite au
  // journal, une fois toutes les réattributions posées.
  const filiation = new Map();
  for (const j of journal) for (const tr of j.tracks) filiation.set(tr.id, tr.identiteLogique ?? tr.id);

  // ── la traversée de coupure, sur les correspondances ANNOTÉES ──
  const tA = verite.tAvant ?? verite.avant?.t, tB = verite.tApres ?? verite.apres?.t;
  const boitesA = verite.avant?.voitures ?? verite.avant ?? [];
  const boitesB = verite.apres?.voitures ?? verite.apres ?? [];
  const nomDe = (v, i) => v.nom ?? `${i}`;
  const corr = verite.correspondances
    ?? Object.fromEntries((verite.lignes || []).filter(l => l.verite).map(l => [l.avant, l.verite]));
  const avant = instantPres(journal, tA, -1), apres = instantPres(journal, tB, +1);
  const traversee = [];
  for (const [nA, nB] of Object.entries(corr || {})) {
    const bA = boitesA.find((v, i) => (v.nom ?? `A${v.rang}`) === nA || nomDe(v, i) === nA);
    const bB = boitesB.find((v, i) => (v.nom ?? `B${v.rang}`) === nB || nomDe(v, i) === nB);
    if (!bA || !bB) continue;
    const pA = pisteDe(avant, bA.box), pB = pisteDe(apres, bB.box);
    if (!pA || !pB) { traversee.push({ nA, nB, etat: 'hors portée' }); continue; }
    // La filiation se lit à la FIN, pas à l'instant d'après : chez nous la
    // réattribution n'intervient qu'un délai plus tard et réécrit alors
    // l'identité logique. La lire trop tôt ferait passer pour rompue une
    // continuité que le suivi rétablit.
    const lA = filiation.get(pA.id) ?? pA.id, lB = filiation.get(pB.id) ?? pB.id;
    traversee.push({ nA, nB, idA: pA.id, idB: pB.id, etat: lA === lB ? 'tenue' : 'rompue' });
  }

  return {
    nom,
    // `modele` est tantôt une chaîne, tantôt l'objet qui décrit le réseau :
    // on n'en garde qu'un libellé court, sans supposer la forme.
    modele: typeof rapport.modele === 'string' ? rapport.modele
      : (rapport.modele?.id ?? rapport.modele?.label ?? rapport.reglages?.tracker?.provenance ?? 'suivi maison'),
    lignes: {
      'voitures sur la grille': String(identsGrille.length),
      'identités du départ tenues au bout': `${auBout.length} / ${identsGrille.length}`,
      'portée des identités du départ': identsGrille
        .map((i, k) => `${k + 1}→${portee.get(i).toFixed(1)}`).join(' '),
      'traversée de la coupure (annotée)':
        `${traversee.filter(x => x.etat === 'tenue').length} / ${traversee.length} tenues`,
      'pistes publiées / instant  méd / max': `${med(parInstant)} / ${Math.max(...parInstant)}`,
      'instants avec ≥ 4 pistes': `${parInstant.filter(n => n >= 4).length} / ${parInstant.length}`,
      'identités créées': String(vie.size),
      'durée médiane des pistes': `${med([...vie.values()].map(v => v[1] - v[0])).toFixed(2)} s`,
      'dérive de taille  méd / p90 / max': amplitudes.length
        ? `${med(amplitudes).toFixed(2)} / ${quantile(amplitudes, 0.9).toFixed(2)} / ${Math.max(...amplitudes).toFixed(2)}`
        : '—',
      'inversions d\'ordre': `${coh.inversions} / ${coh.pairesSuivies} (${(coh.tauxInversion * 100).toFixed(1)} %)`,
    },
    traversee,
  };
}

const colonnes = fRuns.map(f => mesurerJournal(JSON.parse(readFileSync(f, 'utf8')), f.split('/').pop().replace(/\.json$/, '')));

console.log(`\n${C.bold('COMPARAISON AU NIVEAU DU JOURNAL')}  ${C.dim('— même code de mesure des deux côtés')}`);
console.log(`  ${C.dim(`vérité : ${fVerite.split('/').pop()}`)}\n`);
const libelles = Object.keys(colonnes[0].lignes);
const wl = Math.max(...libelles.map(l => l.length));
const ws = colonnes.map(c => Math.max(c.nom.length, ...libelles.map(l => c.lignes[l].length)));
console.log(`  ${' '.repeat(wl)}  ${colonnes.map((c, i) => C.bold(c.nom.padEnd(ws[i]))).join('  ')}`);
console.log(`  ${' '.repeat(wl)}  ${colonnes.map((c, i) => C.dim(c.modele.slice(0, ws[i]).padEnd(ws[i]))).join('  ')}`);
console.log(`  ${'─'.repeat(wl)}  ${ws.map(w => '─'.repeat(w)).join('  ')}`);
for (const l of libelles) {
  console.log(`  ${l.padEnd(wl)}  ${colonnes.map((c, i) => c.lignes[l].padEnd(ws[i])).join('  ')}`);
}

console.log(`\n  ${C.bold('Détail de la traversée')}`);
for (const c of colonnes) {
  console.log(`    ${C.bold(c.nom)}`);
  for (const x of c.traversee) {
    const m = x.etat === 'tenue' ? C.vert('✔ tenue') : x.etat === 'rompue' ? C.rouge('✘ rompue') : C.jaune('— hors portée');
    console.log(`      ${x.nA} → ${x.nB}  ${m}`
      + (x.idA != null ? C.dim(`   piste ${x.idA} avant · piste ${x.idB} après`) : ''));
  }
}
console.log('');
