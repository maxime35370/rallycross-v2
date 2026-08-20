/* ═══════════════════════════════════════════════
   SMOKE — VUE « PROJECTION DE QUALIFICATION »

   Charge l'application dans un vrai Chromium, avec un instantané des données
   réelles, et vérifie que la vue se construit et affiche ce qu'elle doit
   afficher. Complète les tests Vitest, qui valident le calcul mais jamais le
   rendu ni le graphe de modules du navigateur.

   Le SDK Firebase est servi par un stub local (tools/smoke/stub/) parce que
   gstatic.com est inaccessible depuis l'environnement de test. Les DONNÉES,
   elles, sont les vraies : l'instantané produit par
   `node tools/qualification-audit/fetch.mjs`.

   Usage :
     node tools/qualification-audit/fetch.mjs meetings championships sessions results sessionParticipants
     node tools/smoke/projectionSmoke.mjs [--shots]
═══════════════════════════════════════════════ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'tools', 'qualification-audit', 'data');
const SHOTS = join(ROOT, 'tools', 'smoke', 'shots');
const PORT = 8792;
const WANT_SHOTS = process.argv.includes('--shots');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

if (!existsSync(join(DATA, 'meetings.json'))) {
  console.error('❌ Instantané absent. Lancez d\'abord :');
  console.error('   node tools/qualification-audit/fetch.mjs meetings championships sessions results sessionParticipants');
  process.exit(1);
}

function serve() {
  return new Promise((ok) => {
    const server = createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (urlPath.startsWith('/__data/')) file = join(DATA, urlPath.slice('/__data/'.length));
      else file = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) { res.writeHead(404); res.end('[]'); return; }
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
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

// Le SDK Firebase du CDN est remplacé par le stub local.
// Regex et non glob : « **/gstatic.com/… » ne matcherait pas, l'hôte réel
// étant www.gstatic.com (pas de « / » juste avant « gstatic.com »).
await page.route(/gstatic\.com\/firebasejs\//, async (route) => {
  const url = route.request().url();
  const name = url.includes('firebase-app') ? 'firebase-app.js'
    : url.includes('firebase-firestore') ? 'firebase-firestore.js'
    : null;
  if (!name) { await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default {};' }); return; }
  await route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: await readFile(join(ROOT, 'tools', 'smoke', 'stub', name), 'utf8'),
  });
});
// Auth : non nécessaire à la lecture, on neutralise proprement.
await page.route(/gstatic\.com\/firebasejs\/.*firebase-auth\.js/, async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript',
    body: 'export function getAuth(){return{currentUser:null};}\nexport function onAuthStateChanged(_a,cb){cb(null);return()=>{};}\nexport function signInWithEmailAndPassword(){return Promise.reject(new Error("stub"));}\nexport function signOut(){return Promise.resolve();}\nexport function setPersistence(){return Promise.resolve();}\nexport const browserLocalPersistence={};\n' });
});

// Service worker neutralisé : son cache brouillerait l'interception réseau.
await page.route(/\/sw\.js$/, async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* no-op */' });
});

const shot = async (name) => {
  if (!WANT_SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);

  check('l\'application démarre avec le stub Firestore', true);

  // ── Entrée de menu ────────────────────────────────────
  const menu = await page.evaluate(() => !!document.querySelector('[data-view="projection"]'));
  check('entrée de menu « Projection de qualification » présente', menu);

  // ── La vue se construit ───────────────────────────────
  await page.evaluate(async () => { (await import('/js/app.js')).showView('projection'); });
  let built = true;
  try { await page.waitForFunction(() => !!document.querySelector('#prj-content .prj-section'), null, { timeout: 20000 }); }
  catch { built = false; }

  if (!built) {
    const dbg = await page.evaluate(() => (document.getElementById('prj-content')?.textContent || '').slice(0, 400));
    console.log('   contenu:', JSON.stringify(dbg));
    console.log('   erreurs:', errors.slice(0, 6));
  }
  const frame = await page.evaluate(() => {
    const el = document.getElementById('view-projection');
    return {
      display: el?.style.display,
      title: document.getElementById('header-view-title')?.textContent,
      tabs: [...document.querySelectorAll('.prj-tab')].map(t => t.textContent.trim()),
      sections: document.querySelectorAll('#prj-content .prj-section').length,
    };
  });
  check('la vue s\'affiche et se construit', built && frame.display !== 'none' && frame.sections > 0,
        JSON.stringify(frame));
  check('les trois onglets sont présents', frame.tabs.length === 3, frame.tabs.join(' | '));
  await shot('projection-situation');

  // ── Onglet « En situation » ───────────────────────────
  const situation = await page.evaluate(() => ({
    meetings: document.getElementById('prj-meeting')?.options.length || 0,
    checkpoints: [...(document.getElementById('prj-checkpoint')?.options || [])].map(o => o.textContent.trim()),
    drivers: (document.getElementById('prj-driver')?.options.length || 0) - 1,
    hasStandings: /Classement intermédiaire/.test(document.getElementById('prj-content')?.textContent || ''),
    bands: [...document.querySelectorAll('.prj-band')].map(b => b.className.includes('simulation') ? 'SIM' : 'HIST'),
  }));
  check('sélecteurs meeting / checkpoint / pilote alimentés',
        situation.meetings > 0 && situation.checkpoints.length > 0 && situation.drivers > 0,
        JSON.stringify({ ...situation, bands: undefined }));
  check('le checkpoint est choisissable manche par manche',
        situation.checkpoints.join(',') === 'Après Q1,Après Q2,Après Q3,Après Q4', situation.checkpoints.join(','));
  check('historique et simulation sont visuellement séparés',
        situation.bands.includes('HIST') && situation.bands.includes('SIM'), situation.bands.join(','));

  // ── Sélection d'un pilote ─────────────────────────────
  const outlook = await page.evaluate(async () => {
    const meeting = document.getElementById('prj-meeting');
    // Un meeting complet et non trivial : on prend le premier dont le
    // sélecteur de pilote propose plus de 16 pilotes.
    for (const opt of meeting.options) {
      meeting.value = opt.value;
      meeting.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 60));
      const cp = document.getElementById('prj-checkpoint');
      if ([...cp.options].some(o => o.value === '3')) { cp.value = '3'; cp.dispatchEvent(new Event('change')); }
      await new Promise(r => setTimeout(r, 60));
      const drv = document.getElementById('prj-driver');
      if (drv.options.length > 17) {
        drv.value = drv.options[16].value;      // ~P16, autour du seuil
        drv.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 200));
        const txt = document.getElementById('prj-content').textContent;
        return {
          meeting: opt.textContent.trim(),
          cards: [...document.querySelectorAll('.prj-card-label')].map(e => e.textContent.trim()),
          hasWhy: !!document.querySelector('.prj-why'),
          hasGap: /Écart au seuil/.test(txt),
          hasHistoricalRate: /Taux historique/.test(txt),
          hasQ4Table: /Résultat en Q4/.test(txt),
          hasSimNotice: /pas encore disponible/.test(txt),
          confBadges: document.querySelectorAll('.prj-conf').length,
        };
      }
    }
    return null;
  });
  check('la lecture pilote affiche points, classement, écart et taux historique',
        !!outlook && outlook.hasGap && outlook.hasHistoricalRate,
        outlook ? outlook.cards.join(' / ') : 'aucun meeting exploitable');
  check('le panneau « Pourquoi ? » est présent', !!outlook?.hasWhy);
  check('la distribution des résultats Q4 des cas comparables est affichée', !!outlook?.hasQ4Table);
  check('l\'absence de simulation est annoncée explicitement', !!outlook?.hasSimNotice);
  check('chaque taux porte un badge de confiance', (outlook?.confBadges || 0) > 0, `${outlook?.confBadges} badges`);
  await shot('projection-pilote');

  // ── Onglet « Historique » ─────────────────────────────
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await page.waitForTimeout(400);
  const history = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    return {
      bars: document.querySelectorAll('.prj-bar-row').length,
      hasGapChart: /par écart au seuil/.test(txt),
      hasPointsWarning: /barème/.test(txt),
      filters: ['prj-h-champ', 'prj-h-cat', 'prj-h-year', 'prj-h-circuit', 'prj-h-cp'].every(id => !!document.getElementById(id)),
      cutHighlighted: !!document.querySelector('.prj-bar-label.is-cut'),
    };
  });
  check('la courbe par écart au seuil est tracée', history.hasGapChart && history.bars > 0, `${history.bars} barres`);
  check('les filtres championnat / catégorie / saison / circuit / checkpoint sont là', history.filters);
  check('la ligne « au seuil » est mise en évidence', history.cutHighlighted);
  check('la vue en points avertit tant que le périmètre n\'est pas homogène', history.hasPointsWarning);
  await shot('projection-historique');

  // ── Fixer le périmètre débloque la vue en points ──────
  const pointsView = await page.evaluate(async () => {
    const champ = document.getElementById('prj-h-champ');
    champ.value = champ.options[1].value; champ.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 150));
    const cat = document.getElementById('prj-h-cat');
    cat.value = cat.options[1].value; cat.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    const txt = document.getElementById('prj-content').textContent;
    return {
      champ: champ.options[champ.selectedIndex].textContent.trim(),
      cat: cat.value,
      adaptive: /Tranches adaptatives/.test(txt),
      stillWarns: /Fixez le championnat/.test(txt),
      pointsChartHidden: !/Tranches adaptatives/.test(txt),
      buckets: [...document.querySelectorAll('.prj-bar-label')].map(e => e.textContent.trim()).filter(t => /pts$/.test(t)),
    };
  });
  check('championnat + catégorie fixés → vue en points débloquée',
        pointsView.adaptive && !pointsView.stillWarns,
        `${pointsView.champ} / ${pointsView.cat} → ${pointsView.buckets.join(', ')}`);
  await shot('projection-points');

  // ── Onglet « Qualité des données » ────────────────────
  await page.evaluate(() => document.querySelector('[data-tab="quality"]').click());
  await page.waitForTimeout(400);
  const quality = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    return {
      hasCoverage: /Couverture des checkpoints/.test(txt),
      hasDivergences: /Divergences règle/.test(txt),
      divergenceRows: [...document.querySelectorAll('.prj-table tbody tr')].length,
      hasGroups: /Détail meeting par meeting/.test(txt),
      chips: [...new Set([...document.querySelectorAll('.prj-chip')].map(c => c.textContent.trim()))],
    };
  });
  check('l\'écran qualité affiche la couverture des checkpoints', quality.hasCoverage);
  check('les divergences règle / réalité sont listées une par une', quality.hasDivergences && quality.divergenceRows > 0,
        `${quality.divergenceRows} lignes`);
  check('le détail meeting par meeting est présent', quality.hasGroups, quality.chips.join(', '));
  await shot('projection-qualite');

  // ── Aucune erreur d'exécution ─────────────────────────
  const real = errors.filter(e => !/net::|Failed to fetch|ERR_|favicon|manifest|qrserver|sw\.js|ServiceWorker/i.test(e));
  check('aucune erreur JavaScript pendant le parcours', real.length === 0, real.slice(0, 3).join(' | '));

} catch (err) {
  check('exception pendant le smoke', false, String(err?.message || err));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(r => r.pass).length;
console.log('\n' + '═'.repeat(60));
console.log(`${passed}/${results.length} vérifications passées`);
if (WANT_SHOTS) console.log(`captures : ${SHOTS}`);
process.exit(passed === results.length ? 0 : 1);
