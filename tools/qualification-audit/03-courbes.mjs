import { readFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(new URL('./data/cases.json', import.meta.url)));
const nt = cases.filter(c => !c.trivial && c.p3 != null);
const line = (label, n, q) => `${label.padEnd(14)} n=${String(n).padStart(4)}  qualifiés=${String(q).padStart(4)}  taux=${n ? (100*q/n).toFixed(1).padStart(5) : '  n/a'} %`;

console.log('### A. Taux de qualif par TRANCHE DE POINTS APRÈS Q3 (toutes catégories confondues)');
const b = {};
for (const c of nt) { const k = Math.floor(c.p3 / 5) * 5; (b[k] ||= []).push(c); }
for (const k of Object.keys(b).map(Number).sort((x, y) => x - y)) {
  const g = b[k]; console.log(line(`${k}-${k+4} pts`, g.length, g.filter(c => c.qualified).length));
}
console.log('\n### B. Même chose, mais catégorie par catégorie (Super1600 FFSA, seuil 16)');
const s16 = nt.filter(c => c.cat === 'Super1600');
const b2 = {};
for (const c of s16) { const k = Math.floor(c.p3 / 10) * 10; (b2[k] ||= []).push(c); }
for (const k of Object.keys(b2).map(Number).sort((x, y) => x - y)) {
  const g = b2[k]; console.log(line(`${k}-${k+9} pts`, g.length, g.filter(c => c.qualified).length));
}
console.log('\n### C. Taux par ÉCART DE RANG au seuil après Q3 (rang Q3 − seuil)');
const b3 = {};
for (const c of nt) { if (c.r3 == null || c.threshold == null) continue; const d = c.r3 - c.threshold; (b3[d] ||= []).push(c); }
for (const k of Object.keys(b3).map(Number).sort((x, y) => x - y)) {
  if (k < -12 || k > 12) continue;
  const g = b3[k]; console.log(line(`${k > 0 ? '+' : ''}${k} places`, g.length, g.filter(c => c.qualified).length));
}
console.log('\n### D. Taille des échantillons par catégorie');
const byCat = {};
for (const c of nt) (byCat[c.champ + ' / ' + c.cat] ||= []).push(c);
for (const [k, g] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length))
  console.log(`${k.padEnd(34)} n=${String(g.length).padStart(4)}  meetings=${new Set(g.map(x => x.mid)).size}  seuils=${[...new Set(g.map(x => x.threshold))].join(',')}`);
console.log('\n### E. Répartition des places Q4 des pilotes NON qualifiés vs qualifiés (contrôle de cohérence)');
for (const st of [true, false]) {
  const g = nt.filter(c => c.qualified === st);
  const dnf = g.filter(c => c.q4pos == null || c.q4pts == null).length;
  console.log(`${st ? 'qualifiés  ' : 'non qualif.'} n=${String(g.length).padStart(4)}  place Q4 médiane=${med(g.map(c => c.q4pos).filter(x => x != null))}  sans place Q4=${dnf}`);
}
function med(a) { if (!a.length) return 'n/a'; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
