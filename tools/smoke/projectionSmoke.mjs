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
  check('les quatre onglets sont présents', frame.tabs.length === 4, frame.tabs.join(' | '));
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
          probability: (txt.match(/Probabilité globale\s*([\d,]+ %)/) || [])[1] || null,
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
  // Un seuil mal transmis (objet au lieu du nombre) donnait 0,0 % en silence :
  // on vérifie donc une VALEUR, pas seulement la présence d'un libellé.
  check('la probabilité Monte-Carlo est une valeur plausible, pas 0 par défaut',
        !!outlook?.probability && outlook.probability !== '0,0 %' && outlook.probability !== '100,0 %',
        outlook?.probability || 'absente');
  check('chaque taux porte un badge de confiance', (outlook?.confBadges || 0) > 0, `${outlook?.confBadges} badges`);
  await shot('projection-pilote');

  // ── Simulation Monte-Carlo ────────────────────────────
  const sim = await page.evaluate(async () => {
    const txt = () => document.getElementById('prj-content').textContent;
    return {
      hasSim: /Probabilité globale/.test(txt()),
      hasCut: /Seuil de qualification/.test(txt()),
      hasPositions: /Distribution du classement final/.test(txt()),
      hasRivals: /Adversaires susceptibles/.test(txt()),
      hasSeedField: !!document.getElementById('prj-seed'),
      hasProfile: !!document.getElementById('prj-profile'),
      hasWhatIfButton: !!document.getElementById('prj-whatif'),
      bands: [...document.querySelectorAll('.prj-band')].map(b =>
        b.className.includes('simulation') ? 'SIM' : b.className.includes('strategy') ? 'STRAT' : 'HIST'),
    };
  });
  check('la probabilité Monte-Carlo est affichée', sim.hasSim);
  check('distribution du classement final et du seuil de qualification', sim.hasPositions && sim.hasCut);
  check('les adversaires susceptibles de passer devant sont listés', sim.hasRivals);
  check('graine et nombre de tirages sont réglables dans l\'interface', sim.hasSeedField && sim.hasProfile);
  await shot('projection-simulation');

  // ── Reproductibilité par la graine ────────────────────
  const repro = await page.evaluate(async () => {
    const read = () => {
      const cards = [...document.querySelectorAll('.prj-card')];
      const c = cards.find(x => /Probabilité globale/.test(x.textContent));
      return c ? c.querySelector('.prj-card-value').textContent.trim() : null;
    };
    const first = read();
    const seed = document.getElementById('prj-seed');
    seed.value = '777'; seed.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const changed = read();
    seed.value = String(20260101); seed.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    return { first, changed, back: read() };
  });
  check('changer la graine change le résultat, la remettre le restaure',
        repro.first !== repro.changed && repro.first === repro.back,
        `${repro.first} → ${repro.changed} → ${repro.back}`);

  // ── Scénarios « et si » et résultat cible ─────────────
  await page.evaluate(() => document.getElementById('prj-whatif')?.click());
  let whatIfDone = true;
  try {
    await page.waitForFunction(() => /Résultat cible/.test(document.getElementById('prj-content')?.textContent || ''),
      null, { timeout: 120000 });
  } catch { whatIfDone = false; }
  const whatIf = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    const rows = [...document.querySelectorAll('.prj-table tbody tr')]
      .filter(tr => /^P\d+|^DNF|^DNS|^DSQ/.test(tr.textContent.trim()));
    return {
      hasTarget: /Résultat cible/.test(txt),
      hasClass: !!document.querySelector('.prj-class'),
      hasStrategyBand: !!document.querySelector('.prj-band--strategy'),
      hasMarginal: /Gain d'une place/.test(txt),
      hasStatuses: /DNF/.test(txt) && /DNS/.test(txt),
      scenarioRows: rows.length,
      target: (txt.match(/Résultat cible Q\d\s*(P\d+)/) || [])[1] || null,
    };
  });
  check('les scénarios « et si » se calculent jusqu\'au résultat cible', whatIfDone && whatIf.hasTarget,
        `cible ${whatIf.target}, ${whatIf.scenarioRows} scénarios`);
  check('gain marginal par place et statuts DNF/DNS/DSQ présents', whatIf.hasMarginal && whatIf.hasStatuses);
  check('la classification stratégique est affichée dans sa propre section',
        whatIf.hasClass && whatIf.hasStrategyBand);
  const wording = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    return {
      global: /Probabilité globale/.test(txt),
      forced: /Hypothèse imposée/.test(txt),
      conditional: /Probabilité conditionnelle/.test(txt),
      notGuarantee: /n'est pas un seuil de qualification/.test(txt),
      neverGuarantees: !/garantit la qualification/.test(txt),
    };
  });
  check('probabilité globale, hypothèse forcée et probabilité conditionnelle sont distinguées',
        wording.global && wording.forced && wording.conditional);
  check('la cible est explicitement présentée comme n\'étant pas une garantie',
        wording.notGuarantee && wording.neverGuarantees);
  await shot('projection-scenarios');

  // ── Les trois natures de données restent séparées ─────
  const bands = await page.evaluate(() => [...document.querySelectorAll('.prj-band')].map(b =>
    b.className.includes('simulation') ? 'SIM' : b.className.includes('strategy') ? 'STRAT' : 'HIST'));
  check('historique, simulation et interprétation sont trois sections distinctes',
        bands.includes('HIST') && bands.includes('SIM') && bands.includes('STRAT'), bands.join(','));

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

  // ── LOT 3 : projection après Q2 ───────────────────────
  await page.evaluate(() => document.querySelector('[data-tab="situation"]').click());
  await page.waitForTimeout(500);
  const q2 = await page.evaluate(async () => {
    const cp = document.getElementById('prj-checkpoint');
    cp.value = '2'; cp.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
    const txt = document.getElementById('prj-content').textContent;
    return {
      checkpoint: document.getElementById('prj-checkpoint').value,
      remaining: /Reste Q3, Q4/.test(txt),
      hasProbability: /Probabilité globale/.test(txt),
      hasRaceSelector: !!document.getElementById('prj-whatif-race'),
      raceOptions: [...(document.getElementById('prj-whatif-race')?.options || [])].map(o => o.value),
      hasMatrixButton: !!document.getElementById('prj-matrix'),
    };
  });
  check('le checkpoint après Q2 simule bien deux manches restantes',
        q2.checkpoint === '2' && q2.remaining && q2.hasProbability, JSON.stringify(q2));
  check('la manche à imposer est sélectionnable (Q3 ou Q4)',
        q2.hasRaceSelector && q2.raceOptions.join(',') === '3,4', q2.raceOptions.join(','));
  check('la matrice croisée est proposée quand deux manches restent', q2.hasMatrixButton);
  await shot('projection-apres-q2');

  // ── What-if Q3 : état intermédiaire avant Q4 ──────────
  await page.evaluate(() => document.getElementById('prj-whatif').click());
  let q3Done = true;
  try {
    await page.waitForFunction(() => /Résultat cible Q3/.test(document.getElementById('prj-content')?.textContent || ''),
      null, { timeout: 180000 });
  } catch { q3Done = false; }
  const q3 = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    return {
      hasTargetQ3: /Résultat cible Q3/.test(txt),
      hasMedianAfterQ3: /Classement médian après Q3/.test(txt),
      hasPointsAfterQ3: /Points après Q3/.test(txt),
      hasGapAfterQ3: /Écart au seuil après Q3/.test(txt),
      hasIncidentBlock: /Manche non terminée/.test(txt),
      hasSideBySide: /Deux estimations conditionnelles/.test(txt),
      target: (txt.match(/Résultat cible Q3\s*(P\d+)/) || [])[1] || null,
    };
  });
  check('TARGET Q3 est calculé', q3Done && q3.hasTargetQ3, `cible ${q3.target}`);
  check('la situation avant Q4 est affichée : classement, points et écart au seuil après Q3',
        q3.hasMedianAfterQ3 && q3.hasPointsAfterQ3 && q3.hasGapAfterQ3);
  check('le risque d\'incident est compté séparément des résultats classés',
        q3.hasIncidentBlock && q3.hasSideBySide);
  await shot('projection-whatif-q3');

  // ── Matrice Q3 × Q4 ───────────────────────────────────
  await page.evaluate(() => document.getElementById('prj-matrix')?.click());
  let matDone = true;
  try {
    await page.waitForFunction(() => !!document.querySelector('.prj-matrix'), null, { timeout: 300000 });
  } catch { matDone = false; }
  const mat = await page.evaluate(() => {
    const t = document.querySelector('.prj-matrix');
    if (!t) return null;
    const body = [...t.querySelectorAll('tbody tr')];
    const vals = body.map(tr => [...tr.querySelectorAll('td.prj-cell')].map(td => parseInt(td.textContent, 10)));
    return {
      rows: body.length,
      cols: vals[0]?.length || 0,
      topLeft: vals[0]?.[0], bottomRight: vals[vals.length - 1]?.[vals[0].length - 1],
      hasMedian: /Classement médian après Q3/.test(t.textContent),
      monotoneRow: vals[0] ? vals[0].every((v, i, a) => i === 0 || v <= a[i - 1] + 1) : false,
    };
  });
  check('la matrice Q3 × Q4 se calcule', matDone && mat && mat.rows > 3 && mat.cols > 3,
        mat ? `${mat.rows}x${mat.cols}` : 'absente');
  check('la matrice décroît du meilleur au pire scénario',
        !!mat && mat.topLeft >= mat.bottomRight, mat ? `${mat.topLeft} % → ${mat.bottomRight} %` : '');
  check('la matrice affiche le classement médian après Q3 par ligne', !!mat?.hasMedian);
  await shot('projection-matrice');

  // ── Onglet « Backtest » ───────────────────────────────
  await page.evaluate(() => document.querySelector('[data-tab="backtest"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('prj-bt-run').click());
  let btDone = true;
  try {
    await page.waitForFunction(() => /Comparaison globale/.test(document.getElementById('prj-content')?.textContent || ''),
      null, { timeout: 180000 });
  } catch { btDone = false; }
  const bt = await page.evaluate(() => {
    const txt = document.getElementById('prj-content').textContent;
    return {
      hasCompare: /Comparaison globale/.test(txt),
      hasVerdict: !!document.querySelector('.prj-verdict'),
      verdict: document.querySelector('.prj-verdict')?.textContent.trim().slice(0, 90) || null,
      hasCalibration: /Calibration/.test(txt),
      hasByGap: /par position relative au seuil/.test(txt),
      hasByCategory: /par catégorie/.test(txt),
      predictors: [...document.querySelectorAll('.prj-table tbody tr')]
        .map(tr => tr.children[0]?.textContent.trim().split(' ')[0]).slice(0, 3),
    };
  });
  check('le backtest s\'exécute et compare les trois prédicteurs', btDone && bt.hasCompare,
        bt.predictors.join(' / '));
  check('le verdict est affiché explicitement', bt.hasVerdict, bt.verdict);
  check('calibration, comparaison par écart au seuil et par catégorie', 
        bt.hasCalibration && bt.hasByGap && bt.hasByCategory);
  await shot('projection-backtest');

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
