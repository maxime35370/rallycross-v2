/* COMPARER DEUX CAMPAGNES DE SUIVI — avant / après une modification.

   Une seule modification à la fois, mesurée aux DEUX fréquences sur la même
   vidéo. Le script ne juge pas : il aligne les chiffres et marque le sens de
   variation, y compris pour ceux qui doivent rester stables.

     node tools/yolox-poc/comparer.mjs avant-4hz.json avant-10hz.json ^
                                       apres-4hz.json apres-10hz.json

   Les rapports sont appariés par fréquence, pas par ordre : deux fichiers de
   même cadence sont comparés entre eux, dans l'ordre où ils arrivent.

   Ce que le script surveille en plus des métriques demandées :
     · la DÉRIVE de taille, qui est la cible directe du plafonnement ;
     · les ÉCHANGES d'identité, qui sont le prix qu'une correction ne doit pas
       faire payer — une amélioration qui les augmente n'est pas une
       amélioration ;
     · l'ÉCART 4 Hz / 10 Hz, seul signal d'erreur disponible sans annotation. */

import { readFileSync } from 'node:fs';

const fichiers = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (fichiers.length < 2) {
  console.error('usage : node tools/yolox-poc/comparer.mjs <avant…> <apres…>  (rapports rx-tracking/1)');
  process.exit(2);
}

const lire = (f) => {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  if (r.schema !== 'rx-tracking/1') throw new Error(`${f} : ce n'est pas un rapport de suivi`);
  return { f, hz: r.reglages.frequenceHz, r };
};

const mediane = (a) => {
  if (!a.length) return null;
  const t = [...a].sort((x, y) => x - y);
  const i = Math.floor(t.length / 2);
  return t.length % 2 ? t[i] : (t[i - 1] + t[i]) / 2;
};

/** Les chiffres demandés, tirés d'un rapport. */
function extraire({ r }) {
  const m = r.mesures;
  const parRaison = m.refus?.parRaison || {};
  const ratios = (r.refus || []).map(x => x.ratio).filter(v => v != null);
  const sig = (r.signaux || []).reduce((a, s) => { a[s.type] = (a[s.type] || 0) + 1; return a; }, {});
  return {
    'pistes créées': m.pistesCreees,
    'pistes confirmées': m.pistesConfirmeesCreees,
    'jamais confirmées': m.pistesJamaisConfirmees,
    'pistes longues ≥ 70 %': m.pistesLongues,
    'durée médiane (s)': m.dureeMedianePistes,
    'nouvelles pistes / s': m.nouvellesPistesParSeconde,
    suppressions: m.suppressions,
    réactivations: m.reactivations,
    'refus ratio_taille': parRaison.ratio_taille || 0,
    'refus distance': parRaison.distance || 0,
    'refus total': m.refus?.total ?? (r.refus || []).length,
    'ratio de taille au refus — médian': ratios.length ? Number(mediane(ratios).toFixed(2)) : null,
    'ratio de taille au refus — max': ratios.length ? Number(Math.max(...ratios).toFixed(1)) : null,
    'suivies au V1': m.auV1?.suivies ?? null,
    'dérive de taille — médiane': m.deriveTaille?.median ?? null,
    'dérive de taille — max': m.deriveTaille?.max ?? null,
    'vitesse plafonnée': m.deriveTaille?.vitesseBornee ?? null,
    'résidus écrêtés': m.deriveTaille?.residusEcretes ?? null,
    'échanges d\'ordre (signal)': sig.echange || 0,
    'identifiants relayés (signal)': sig.relais || 0,
    'inversions / paires suivies': m.coherenceSpatiale
      ? `${m.coherenceSpatiale.inversions}/${m.coherenceSpatiale.pairesSuivies}` : null,
  };
}

// Sens souhaité : ↓ moins c'est mieux, ↑ plus c'est mieux, = doit rester stable.
const SENS = {
  'pistes créées': '↓', 'pistes confirmées': '↓', 'jamais confirmées': '↓',
  'pistes longues ≥ 70 %': '↑', 'durée médiane (s)': '↑', 'nouvelles pistes / s': '↓',
  suppressions: '↓', réactivations: '↑',
  'refus ratio_taille': '↓', 'refus distance': '↓', 'refus total': '↓',
  'ratio de taille au refus — médian': '↓', 'ratio de taille au refus — max': '↓',
  'suivies au V1': '↑',
  'dérive de taille — médiane': '↓', 'dérive de taille — max': '↓',
  'échanges d\'ordre (signal)': '=', 'identifiants relayés (signal)': '=',
};

const rapports = fichiers.map(lire);
const parHz = new Map();
for (const x of rapports) {
  if (!parHz.has(x.hz)) parHz.set(x.hz, []);
  parHz.get(x.hz).push(x);
}

const V = '\x1b[32m', R = '\x1b[31m', G = '\x1b[90m', N = '\x1b[0m', B = '\x1b[1m';
const num = (v) => (v == null ? '—' : String(v));

for (const [hz, liste] of [...parHz.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`\n${B}══ ${hz} Hz ══${N}`);
  const cols = liste.map(extraire);
  const noms = liste.map(x => x.f.split(/[\\/]/).pop());
  console.log(`${G}${'métrique'.padEnd(34)}${noms.map(n => n.slice(-26).padStart(28)).join('')}${N}`);
  for (const cle of Object.keys(cols[0])) {
    const cells = cols.map((c, i) => {
      const v = c[cle];
      if (i === 0 || cols.length < 2) return num(v).padStart(28);
      const ref = cols[0][cle];
      if (typeof v !== 'number' || typeof ref !== 'number' || ref === v) return num(v).padStart(28);
      const mieux = SENS[cle] === '↓' ? v < ref : SENS[cle] === '↑' ? v > ref : null;
      const delta = `${v > ref ? '+' : ''}${Number((v - ref).toFixed(2))}`;
      const couleur = mieux === null ? G : mieux ? V : R;
      return `${couleur}${`${num(v)} (${delta})`.padStart(28)}${N}`;
    });
    console.log(`${(SENS[cle] ? SENS[cle] + ' ' : '  ') + cle.padEnd(32)}${cells.join('')}`);
  }
}

// Écart entre fréquences — pour chaque campagne, prise dans le même rang.
const cadences = [...parHz.keys()].sort((a, b) => a - b);
if (cadences.length >= 2) {
  const rangs = Math.min(...cadences.map(h => parHz.get(h).length));
  console.log(`\n${B}══ écart ${cadences.join(' Hz / ')} Hz ══${N}`);
  console.log(`${G}${'métrique'.padEnd(34)}${Array.from({ length: rangs }, (_, i) => `campagne ${i + 1}`.padStart(28)).join('')}${N}`);
  const cles = ['pistes confirmées', 'durée médiane (s)', 'refus ratio_taille', 'réactivations',
    'dérive de taille — max', 'suivies au V1'];
  const ecartDe = (cle, rang) => {
    const vals = cadences.map(h => extraire(parHz.get(h)[rang])[cle]);
    if (vals.some(v => typeof v !== 'number')) return null;
    return { vals, ecart: Math.max(...vals) - Math.min(...vals) };
  };
  for (const cle of cles) {
    const reference = ecartDe(cle, 0);
    const cells = [];
    for (let i = 0; i < rangs; i++) {
      const e = ecartDe(cle, i);
      if (!e) { cells.push('—'.padStart(28)); continue; }
      const base = Math.max(...e.vals.map(Math.abs)) || 1;
      const texte = `${e.vals.join(' vs ')}  (${(100 * e.ecart / base).toFixed(0)} %)`;
      // Vert si l'écart entre cadences a diminué, rouge s'il a grandi, neutre
      // s'il n'a pas bougé — un écart identique n'est ni un gain ni une perte.
      const couleur = i === 0 || !reference || e.ecart === reference.ecart ? ''
        : (e.ecart < reference.ecart ? V : R);
      cells.push(`${couleur}${texte.padStart(28)}${N}`);
    }
    console.log(`  ${cle.padEnd(32)}${cells.join('')}`);
  }
  console.log(`\n${G}  L'écart entre cadences est le seul signal d'erreur disponible sans annotation :`);
  console.log(`  si la même séquence ne donne pas les mêmes trajectoires à ${cadences.join(' et ')} Hz,`);
  console.log(`  au moins l'une des deux se trompe. La concordance ne prouve rien, la discordance prouve l'erreur.${N}`);
}
