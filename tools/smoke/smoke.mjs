/* ═══════════════════════════════════════════════
   SMOKE TEST NAVIGATEUR — RX Chrono

   Charge l'application dans un vrai Chromium et vérifie qu'aucun module ne
   casse à l'exécution. Complète les tests Vitest : ceux-ci valident la logique
   pure, celui-ci valide que le GRAPHE DE MODULES s'évalue réellement dans un
   navigateur — ce qu'aucun test Node ne garantit pour une application sans
   étape de build.

   Écrit après le déplacement de computeSeriesSizes() de timing.js vers calc.js.

   ⚠️ Limite assumée : les SDK Firebase sont chargés depuis gstatic.com. Si le
   réseau ne les atteint pas, la connexion Firestore échoue et les vues sans
   données ne peuvent pas être exercées. Le test le détecte et le signale au
   lieu de faire semblant de réussir.

   Usage :  node tools/smoke/smoke.mjs
═══════════════════════════════════════════════ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8791;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file) || !file.startsWith(ROOT)) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    });
    server.listen(PORT, () => ok(server));
  });
}

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const errors = [];
const offline = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => offline.push(`${r.url().slice(0, 70)} — ${r.failure()?.errorText}`));

try {
  // ── 1. Chargement de l'application ────────────────────
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);   // laisse loadApp() dérouler ses imports

  const externalBlocked = offline.some(u => /gstatic|googleapis|fonts/.test(u));
  if (externalBlocked) {
    console.log(`\nℹ️  Réseau externe indisponible (${offline.length} requête(s) bloquée(s)) :`);
    console.log('   les SDK Firebase ne se chargent pas — les vues avec données ne sont pas exerçables ici.\n');
  }

  check('index.html se charge', true);

  // ── 2. Aucune erreur d'IMPORT / MODULE ────────────────
  // C'est le cœur du test : une régression d'import produit une erreur de ce
  // type. On ignore explicitement les échecs réseau vers les CDN externes.
  const moduleErrors = errors.filter(e =>
    /import|module|is not defined|is not a function|SyntaxError|Cannot find|does not provide/i.test(e)
    && !/gstatic|googleapis|Failed to fetch|ERR_|net::/i.test(e)
  );
  check('aucune erreur d\'import / module', moduleErrors.length === 0,
        moduleErrors.slice(0, 3).join(' | '));

  // ── 3. Les modules locaux s'évaluent dans le navigateur ──
  const MODULES = [
    'calc.js', 'utils.js', 'startAnalysisCalc.js', 'timing.js', 'sessions.js',
    'standings.js', 'championship.js', 'stats.js', 'meetings.js', 'drivers.js',
    'engagements.js', 'competition.js', 'importTimes.js', 'videoTimecodes.js',
    'spectator.js', 'settings.js', 'persons.js', 'personProfile.js', 'driverProfile.js',
    'startAnalysis.js',
  ];
  const loaded = await page.evaluate(async (mods) => {
    const out = {};
    for (const m of mods) {
      try { await import(`/js/${m}`); out[m] = 'ok'; }
      catch (e) { out[m] = String(e.message || e).slice(0, 120); }
    }
    return out;
  }, MODULES);
  const failed = Object.entries(loaded).filter(([, v]) => v !== 'ok');
  check(`les ${MODULES.length} modules locaux s'évaluent`, failed.length === 0,
        failed.map(([k, v]) => `${k}: ${v}`).join(' | '));

  // ── 4. computeSeriesSizes accessible depuis calc.js EN NAVIGATEUR ──
  // Vérifie le déplacement depuis timing.js dans les conditions réelles
  // (résolution de module ESM par le navigateur, pas par Node/Vitest).
  const series = await page.evaluate(async () => {
    const calc = await import('/js/calc.js');
    if (typeof calc.computeSeriesSizes !== 'function') return { error: 'export absent' };
    return {
      ffsa26: calc.computeSeriesSizes(26, 5, 'ffsa'),
      fia26: calc.computeSeriesSizes(26, 5, 'fia_even'),
      ffsa30: calc.computeSeriesSizes(30, 5, 'ffsa'),
      ffsa15: calc.computeSeriesSizes(15, 5, 'ffsa'),
    };
  });
  check('calc.computeSeriesSizes exporté et correct dans le navigateur',
        JSON.stringify(series.ffsa26) === JSON.stringify([3, 3, 5, 5, 5, 5])
        && JSON.stringify(series.fia26) === JSON.stringify([4, 4, 4, 4, 5, 5])
        && JSON.stringify(series.ffsa30) === JSON.stringify([5, 5, 5, 5, 5, 5])
        && JSON.stringify(series.ffsa15) === JSON.stringify([5, 5, 5]),
        JSON.stringify(series));

  // ── 5. timing.js expose toujours initTiming ───────────
  const timingApi = await page.evaluate(async () => {
    const t = await import('/js/timing.js');
    return { initTiming: typeof t.initTiming };
  });
  check('timing.js exporte initTiming()', timingApi.initTiming === 'function', JSON.stringify(timingApi));

  // ── 6. Le routeur affiche bien la vue Chronométrage ───
  const nav = await page.evaluate(async () => {
    const app = await import('/js/app.js');
    app.showView('timing');
    const el = document.getElementById('view-timing');
    return { display: el?.style.display, title: document.getElementById('header-view-title')?.textContent };
  });
  check('la vue Chronométrage s\'affiche', nav.display !== 'none' && /Chrono/i.test(nav.title || ''),
        JSON.stringify(nav));

  // ── 7. Les autres vues restent atteignables (non-régression du routeur) ──
  const views = ['meetings', 'sessions', 'standings', 'championship', 'stats', 'spectator', 'drivers'];
  const routed = await page.evaluate(async (vs) => {
    const app = await import('/js/app.js');
    const bad = [];
    for (const v of vs) {
      app.showView(v);
      const el = document.getElementById(`view-${v}`);
      if (!el || el.style.display === 'none') bad.push(v);
    }
    return bad;
  }, views);
  check('toutes les vues existantes restent atteignables', routed.length === 0, routed.join(', '));

  // ── 8. startAnalysisCalc utilisable côté navigateur ───
  const sac = await page.evaluate(async () => {
    const m = await import('/js/startAnalysisCalc.js');
    const GRID_8 = { lanes: 5, rows: 3,
      positions: { '0-0': 1, '0-2': 2, '0-4': 3, '1-1': 4, '1-3': 5, '2-0': 6, '2-2': 7, '2-4': 8 } };
    return { p4: m.placeOnGrid(4, GRID_8), id: m.startDocId('abc', 3), zone: m.laneZone(3, 5) };
  });
  check('startAnalysisCalc : P4 en ligne 2 (et non couloir 4)',
        sac.p4?.gridRow === 2 && sac.p4?.lane === 2 && sac.id === 'abc_s3' && sac.zone === 'middle',
        JSON.stringify(sac));

  // ── 9. La nouvelle vue Analyse des départs s'affiche ──
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    app.showView('startAnalysis');
  });
  // Le rendu est asynchrone (chargement des meetings) : on attend qu'il aboutisse.
  let built = true;
  try {
    await page.waitForFunction(() => !!document.getElementById('sanl-list'), null, { timeout: 8000 });
  } catch { built = false; }
  const sanl = await page.evaluate(() => {
    const el = document.getElementById('view-startAnalysis');
    return {
      display: el?.style.display,
      title: document.getElementById('header-view-title')?.textContent,
      hasList: !!document.getElementById('sanl-list'),
      hasWork: !!document.getElementById('sanl-work'),
    };
  });
  check('la vue Analyse des départs s\'affiche et se construit',
        built && sanl.display !== 'none' && /Analyse des d/i.test(sanl.title || '')
        && sanl.hasList && sanl.hasWork,
        JSON.stringify(sanl));

  // ── 10. Le menu et la tuile d'accueil pointent vers la vue ──
  const entry = await page.evaluate(() => ({
    menu: !!document.querySelector('.menu-item[data-view="startAnalysis"]'),
    card: !!document.querySelector('.home-card[data-view="startAnalysis"]'),
  }));
  check('entrée de menu + tuile d\'accueil présentes', entry.menu && entry.card, JSON.stringify(entry));

  // ── 11. Sélecteur V1 : une position prise disparaît des autres listes ──
  const v1 = await page.evaluate(async () => {
    const m = await import('/js/startAnalysisCalc.js');
    const rows = [
      { driverId: 'a', turn1Pos: null }, { driverId: 'b', turn1Pos: null },
      { driverId: 'c', turn1Pos: null }, { driverId: 'd', turn1Pos: null },
      { driverId: 'e', turn1Pos: null },
    ];
    const before = m.availableTurn1Positions('a', rows, 5);
    rows[2].turn1Pos = 3;                      // c prend P3
    return {
      before,
      afterOther: m.availableTurn1Positions('a', rows, 5),   // P3 doit disparaître
      afterSelf: m.availableTurn1Positions('c', rows, 5),    // c garde son P3
    };
  });
  check('sélecteur V1 : P3 pris par un autre disparaît, le pilote garde le sien',
        v1.before.length === 5 && !v1.afterOther.includes(3) && v1.afterSelf.includes(3),
        JSON.stringify(v1));

  // ── 12. Rendu réel des boutons V1 (DOM + CSS), avec un départ simulé ──
  const btns = await page.evaluate(async () => {
    const m = await import('/js/startAnalysisCalc.js');
    const starters = 5;
    const rows = ['a','b','c','d','e'].map(id => ({ driverId: id, turn1Pos: null }));
    rows[2].turn1Pos = 3;                       // le pilote c prend P3

    // Reproduit le rendu de la vue pour vérifier le DOM et le style appliqué
    const host = document.createElement('div');
    host.className = 'sanl-work';
    host.innerHTML = rows.map(r => {
      const avail = new Set(m.availableTurn1Positions(r.driverId, rows, starters));
      let h = `<div class="sanl-v1-group" data-driver="${r.driverId}">`;
      for (let k = 1; k <= starters; k++) {
        const active = r.turn1Pos === k;
        h += `<button type="button" class="sanl-v1-btn${active ? ' is-active' : ''}"
              data-driver="${r.driverId}" data-pos="${k}" ${!avail.has(k) ? 'disabled' : ''}>P${k}</button>`;
      }
      return h + '</div>';
    }).join('');
    document.body.appendChild(host);

    const groupOf = id => host.querySelector(`.sanl-v1-group[data-driver="${id}"]`);
    const stateOf = id => [...groupOf(id).querySelectorAll('.sanl-v1-btn')]
      .map(b => b.disabled ? 'x' : (b.classList.contains('is-active') ? 'A' : '.')).join('');

    const one = groupOf('a').querySelector('.sanl-v1-btn');
    const cs = getComputedStyle(one);
    const activeBtn = groupOf('c').querySelector('.sanl-v1-btn.is-active');
    const out = {
      a: stateOf('a'), c: stateOf('c'),
      nbBoutons: groupOf('a').querySelectorAll('.sanl-v1-btn').length,
      styleApplique: cs.cursor === 'pointer' && parseFloat(cs.minWidth) >= 30,
      actifVisible: !!activeBtn && getComputedStyle(activeBtn).backgroundColor !== 'rgba(0, 0, 0, 0)',
    };
    host.remove();
    return out;
  });
  check('boutons V1 : 5 boutons, P3 barré chez les autres, actif chez son pilote',
        btns.nbBoutons === 5 && btns.a === '..x..' && btns.c === '..A..'
        && btns.styleApplique && btns.actifVisible,
        JSON.stringify(btns));

} finally {
  await browser.close();
  server.close();
}

const failedCount = results.filter(r => !r.pass).length;
console.log(`\n${'═'.repeat(60)}`);
console.log(`${results.length - failedCount}/${results.length} vérifications passées`);
if (failedCount) {
  console.log('\nErreurs console collectées :');
  for (const e of errors.slice(0, 10)) console.log('  ·', e.slice(0, 160));
}
process.exit(failedCount ? 1 : 0);
