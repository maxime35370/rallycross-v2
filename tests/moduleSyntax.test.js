/* ═══════════════════════════════════════════════
   MODULESYNTAX.TEST.JS — Tout module de `js/` doit être analysable.

   Ce projet n'a AUCUNE étape de build : rien ne relit le code entre
   l'écriture et le navigateur. Une erreur de syntaxe ne se manifeste donc
   qu'à l'exécution, sous la forme d'un écran vide — et seulement sur la vue
   concernée, ce qui la rend facile à ne pas voir.

   C'est arrivé pendant le lot A0 : une apostrophe sur-échappée dans un
   littéral de gabarit rendait `accessAdmin.js` inchargeable. Les 869 tests
   passaient, parce qu'aucun ne chargeait ce module. Seule une capture
   d'écran l'a révélé.

   Ce test comble ce trou : il analyse chaque fichier avec l'analyseur
   d'esbuild (déjà présent via Vite), sans rien exécuter — donc sans avoir
   besoin d'un DOM ni de Firebase.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname;

function listJs(dir, acc = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) listJs(rel, acc);
    else if (entry.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

const MODULES = listJs('js');

describe('syntaxe — aucun module ne doit être inchargeable par le navigateur', () => {
  it('trouve bien tous les modules de js/', () => {
    expect(MODULES.length).toBeGreaterThan(30);
    expect(MODULES).toContain('js/app.js');
    expect(MODULES).toContain('js/access/licenseCalc.js');
  });

  it.each(MODULES)('%s s\'analyse sans erreur', async (rel) => {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    // `transform` analyse et rend le code ; il lève sur une syntaxe invalide.
    // Aucun code n'est exécuté : ni DOM, ni réseau, ni Firebase.
    await expect(transform(source, { loader: 'js', format: 'esm' })).resolves.toBeTruthy();
  });
});

describe('service worker — les fichiers déclarés existent vraiment', () => {
  it('chaque entrée de ASSET_PATHS pointe sur un fichier présent', () => {
    // Le pendant de moduleGraph.test.js, qui vérifie l'inverse : celui-ci
    // attrape une entrée mal orthographiée ou un fichier renommé, qui ferait
    // échouer silencieusement la mise en cache (Promise.allSettled avale
    // l'erreur, par conception).
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const bloc = sw.slice(sw.indexOf('ASSET_PATHS'), sw.indexOf('];', sw.indexOf('ASSET_PATHS')))
      // Les commentaires sont retirés AVANT l'extraction : ce fichier est
      // commenté en français, et une apostrophe de « l'application » serait
      // prise pour un délimiteur de chaîne. Première version de ce test :
      // quatre fragments de commentaire remontés comme fichiers manquants.
      .replace(/\/\/.*$/gm, '');
    const declares = [...bloc.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(declares.length).toBeGreaterThan(50);
    const manquants = declares.filter(p => {
      try { statSync(join(ROOT, p)); return false; } catch { return true; }
    });
    expect(manquants).toEqual([]);
  });
});
