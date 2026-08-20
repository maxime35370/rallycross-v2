/* ═══════════════════════════════════════════════
   MODULEGRAPH.TEST.JS — Garde-fou contre les
   régressions d'import entre modules.

   Motivation : l'application n'a AUCUNE étape de build. Une erreur d'import
   (fichier renommé, export manquant, cycle) ne se voit donc qu'à l'exécution,
   dans le navigateur, et souvent seulement quand l'utilisateur ouvre la vue
   concernée. Ce test vérifie statiquement, sur TOUT le dépôt :

     • chaque import local pointe vers un fichier qui existe ;
     • chaque import nommé correspond bien à un export du module cible ;
     • aucun cycle d'import ;
     • les modules « purs » (calc, utils, startAnalysisCalc) ne dépendent
       ni de Firebase ni du DOM — sinon ils cesseraient d'être testables.

   Écrit après le déplacement de computeSeriesSizes() de timing.js vers calc.js,
   précisément pour que ce genre de refactorisation soit couvert à l'avenir.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Liste récursive des fichiers .js d'un dossier. */
function listJs(dir) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) out.push(...listJs(rel));
    else if (entry.endsWith('.js')) out.push(rel);
  }
  return out;
}

const FILES = [...listJs('js'), ...listJs('overlay/_lib')];

/** Imports STATIQUES locaux : import ... from './x.js' */
function staticImports(src) {
  const out = [];
  const re = /import\s+([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push({ clause: m[1], spec: m[2] });
  return out;
}

/** Imports DYNAMIQUES locaux : await import('./x.js') */
function dynamicImports(src) {
  const out = [];
  const re = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/** Noms importés dans une clause `{ a, b as c }` (ignore default et namespace). */
function namedBindings(clause) {
  const braces = clause.match(/\{([^}]*)\}/);
  if (!braces) return [];
  return braces[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(/\s+as\s+/)[0].trim())
    .filter(s => s && s !== 'default');
}

/** Noms exportés par un module (export function/const/let/class + export { … }). */
function exportedNames(src) {
  const names = new Set();
  const re1 = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = re1.exec(src))) names.add(m[1]);
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

const SRC = Object.fromEntries(FILES.map(f => [f, readFileSync(join(ROOT, f), 'utf8')]));

// ─────────────────────────────────────────────────────────

describe('graphe de modules — fichiers cibles', () => {
  it('trouve les modules de l\'application', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES).toContain(join('js', 'timing.js'));
    expect(FILES).toContain(join('js', 'calc.js'));
    expect(FILES).toContain(join('js', 'startAnalysisCalc.js'));
  });

  it('tous les imports locaux pointent vers un fichier existant', () => {
    const missing = [];
    for (const f of FILES) {
      const from = dirname(join(ROOT, f));
      const specs = [...staticImports(SRC[f]).map(i => i.spec), ...dynamicImports(SRC[f])];
      for (const spec of specs) {
        if (!existsSync(resolve(from, spec))) missing.push(`${f} → ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('tous les imports nommés correspondent à un export réel', () => {
    const broken = [];
    for (const f of FILES) {
      const from = dirname(join(ROOT, f));
      for (const { clause, spec } of staticImports(SRC[f])) {
        const target = relative(ROOT, resolve(from, spec));
        if (!SRC[target]) continue;                 // couvert par le test précédent
        const exported = exportedNames(SRC[target]);
        for (const name of namedBindings(clause)) {
          if (!exported.has(name)) broken.push(`${f} importe { ${name} } absent de ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('aucun cycle d\'import statique', () => {
    const graph = {};
    for (const f of FILES) {
      const from = dirname(join(ROOT, f));
      graph[f] = staticImports(SRC[f])
        .map(i => relative(ROOT, resolve(from, i.spec)))
        .filter(t => SRC[t]);
    }
    const cycles = [];
    const state = {};                                // 0 = neuf, 1 = en cours, 2 = fini
    const walk = (node, path) => {
      if (state[node] === 1) { cycles.push([...path, node].join(' → ')); return; }
      if (state[node] === 2) return;
      state[node] = 1;
      for (const next of graph[node] || []) walk(next, [...path, node]);
      state[node] = 2;
    };
    for (const f of FILES) walk(f, []);
    expect(cycles).toEqual([]);
  });
});

describe('modules purs — restent testables hors navigateur', () => {
  const PURE = [
    join('js', 'calc.js'), join('js', 'utils.js'),
    join('js', 'startAnalysisCalc.js'), join('js', 'startStatsCalc.js'),
    join('js', 'videoPlayerCalc.js'),
    // Module « projection de qualification » : tout le dossier est pur sauf
    // qualificationData.js, seul autorisé à parler à Firestore.
    join('js', 'projection', 'projectionConfig.js'),
    join('js', 'projection', 'qualificationRules.js'),
    join('js', 'projection', 'qualificationState.js'),
    join('js', 'projection', 'qualificationHistory.js'),
    join('js', 'projection', 'dataQuality.js'),
    join('js', 'projection', 'monteCarloEngine.js'),
    join('js', 'projection', 'driverPerformanceModel.js'),
    join('js', 'projection', 'scenarioSimulator.js'),
    join('js', 'projection', 'strategyTargetCalculator.js'),
    join('js', 'projection', 'qualificationBacktest.js'),
    join('js', 'projection', 'raceCertainties.js'),
  ];

  it('n\'importent ni Firebase ni un module de vue', () => {
    const bad = [];
    for (const f of PURE) {
      for (const { spec } of staticImports(SRC[f])) {
        if (/firebase|app\.js|context\.js|auth\.js/.test(spec)) bad.push(`${f} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('ne touchent pas au DOM', () => {
    const bad = [];
    for (const f of PURE) {
      if (/\b(document|window)\./.test(SRC[f])) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

describe('non-régression : computeSeriesSizes déplacé vers calc.js', () => {
  const calc = SRC[join('js', 'calc.js')];
  const timing = SRC[join('js', 'timing.js')];

  it('calc.js exporte computeSeriesSizes', () => {
    expect(exportedNames(calc).has('computeSeriesSizes')).toBe(true);
  });

  it('timing.js l\'importe depuis calc.js et n\'en garde pas de copie', () => {
    const imported = staticImports(timing)
      .filter(i => i.spec.includes('calc.js'))
      .flatMap(i => namedBindings(i.clause));
    expect(imported).toContain('computeSeriesSizes');
    expect(/function\s+computeSeriesSizes/.test(timing)).toBe(false);
  });

  it('timing.js l\'utilise toujours pour la structure des séries', () => {
    expect(timing).toMatch(/getSeriesStructure/);
    expect((timing.match(/computeSeriesSizes\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('service worker — les nouveaux modules doivent être déclarés', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const declared = new Set((sw.match(/'([^']+\.(?:js|css|html|json))'/g) || [])
    .map(s => s.slice(1, -1)));

  it('tout module js/ chargé par l\'application figure dans ASSET_PATHS', () => {
    // Les modules purs importés par d'autres sont chargés en cascade : on
    // vérifie ceux que app.js charge explicitement, plus les nouveaux.
    const missing = [];
    for (const f of listJs('js')) {
      const spec = f.split(/[\\/]/).join('/');
      if (!declared.has(spec)) missing.push(spec);
    }
    // Ce test documente l'écart plutôt que de l'imposer : il échoue seulement
    // si un module ajouté n'a pas été déclaré, ce qui provoquerait des
    // incohérences de cache après déploiement.
    expect(missing).toEqual([]);
  });
});
