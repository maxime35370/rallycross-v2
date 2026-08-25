/* TABLEAU DE COMPARAISON DE RUNS — une colonne par run, une ligne par mesure.

     node tools/yolox-poc/tableau.mjs <run.json[:verite.json]> [...]

   Chaque correctif se juge sur les mêmes chiffres, dans le même ordre, sans
   qu'on ait à les recopier à la main d'un rapport à l'autre — c'est le seul
   moyen de voir une contrepartie qu'on n'avait pas cherchée.

   Les verdicts de coupure viennent de `verite-cut.mjs` et le compte de
   rotations de `bloc.mjs` : ces deux-là sont appelés, pas réimplémentés, pour
   qu'une correction de leur logique se propage ici. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`,
  vert: (s) => `\x1b[32m${s}\x1b[0m`, rouge: (s) => `\x1b[31m${s}\x1b[0m`,
};
const sansCouleur = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('\n  usage : node tools/yolox-poc/tableau.mjs <run.json[:verite.json]> [...]\n');
  process.exit(1);
}

const colonnes = args.map((a) => {
  const [fRun, fVerite] = a.split(':');
  const r = JSON.parse(readFileSync(fRun, 'utf8'));
  const m = r.mesures, id = m.identites;

  // Verdict de coupure — délégué à l'outil qui fait autorité.
  let cut = '—';
  if (fVerite) {
    try {
      const sortie = sansCouleur(execFileSync(process.execPath,
        ['tools/yolox-poc/verite-cut.mjs', fRun, fVerite], { encoding: 'utf8' }));
      const ligne = sortie.split('\n').find(l => /justes? \d+ ·/.test(l));
      const j = ligne?.match(/justes? (\d+)/);
      const f = ligne?.match(/(\d+) FAUSSES?|fausses? (\d+)/i);
      const n = ligne?.match(/non décidées? (\d+)|(\d+) non décidées?/);
      cut = j ? `${j[1]} / ${f ? (f[1] ?? f[2]) : 0} / ${n ? (n[1] ?? n[2]) : 0}` : '?';
    } catch { cut = 'échec'; }
  }

  // Rotations d'identités — idem.
  // Décalages en bloc RÉELLEMENT appliqués : lus dans l'écart entre prédiction
  // brute et prédiction compensée, identique pour toutes les pistes d'un pas.
  const med = (a) => { const t = [...a].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
  let decalages = 0;
  for (const j of r.journal || []) {
    const dx = [], dy = [];
    for (const tr of j.tracks) {
      if (tr.boiteAvant && tr.boiteCompensee) {
        dx.push(tr.boiteCompensee[0] - tr.boiteAvant[0]); dy.push(tr.boiteCompensee[1] - tr.boiteAvant[1]);
      }
    }
    if (dx.length && (Math.abs(med(dx)) >= 40 || Math.abs(med(dy)) >= 40)) decalages += 1;
  }
  const rotations = String(decalages);

  const reac = id.reactivationsRefusees;
  return {
    nom: fRun.split('/').pop().replace(/\.json$/, ''),
    lignes: {
      'identités du départ au V1': `${id.survivantesDepart}  [${id.idsSurvivantes.join(',')}]`,
      'portée des identités du départ': id.porteeDepart.map(p => `${p.identite}→${p.jusqua}`).join(' '),
      'cut : justes / fausses / non décidées': cut,
      'réattributions posées': String(id.reattribuees ?? '—'),
      'décalages en bloc > 40 px appliqués': rotations,
      'réactivations': String(m.reactivations),
      'réactivations refusées (instants)': String(reac?.instants ?? '—'),
      'pistes créées': String(m.pistesCreees),
      'pistes confirmées': String(m.pistesConfirmeesCreees),
      'durée médiane des pistes': `${m.dureeMedianePistes} s`,
      'dérive de taille  méd / p90 / max': `${m.deriveTaille.median} / ${m.deriveTaille.p90} / ${m.deriveTaille.max}`,
      'inversions d\'ordre': `${m.coherenceSpatiale.inversions} / ${m.coherenceSpatiale.pairesSuivies}`
        + `  (${(m.coherenceSpatiale.tauxInversion * 100).toFixed(1)} %)`,
      'suivies au V1 (dont détectées)': `${m.auV1.suivies} (${m.auV1.detectees})`,
      'doublons écartés': String(m.doublonsEcartes),
    },
  };
});

const libelles = Object.keys(colonnes[0].lignes);
const largeurLibelle = Math.max(...libelles.map(l => l.length));
const largeurs = colonnes.map(c => Math.max(c.nom.length, ...libelles.map(l => c.lignes[l].length)));

console.log(`\n${C.bold('COMPARAISON DE RUNS')}\n`);
console.log(`  ${' '.repeat(largeurLibelle)}  ${colonnes.map((c, i) => C.bold(c.nom.padEnd(largeurs[i]))).join('  ')}`);
console.log(`  ${'─'.repeat(largeurLibelle)}  ${largeurs.map(w => '─'.repeat(w)).join('  ')}`);
for (const l of libelles) {
  const valeurs = colonnes.map((c, i) => {
    const v = c.lignes[l];
    const ref = colonnes[0].lignes[l];
    const teinte = colonnes.length > 1 && i > 0 && v !== ref ? C.vert : (x) => x;
    return teinte(v.padEnd(largeurs[i]));
  });
  console.log(`  ${l.padEnd(largeurLibelle)}  ${valeurs.join('  ')}`);
}
console.log(`\n  ${C.dim('en couleur : ce qui a changé par rapport à la première colonne')}\n`);
