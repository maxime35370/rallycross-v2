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
    'startAnalysis.js', 'startStatsCalc.js', 'startStats.js',
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
      // Le panneau vidéo vit HORS de #sanl-work : c'est ce qui empêche le
      // lecteur d'être détruit à chaque saisie de position.
      hasVideoSlot: !!document.getElementById('sanl-video'),
      videoHorsWork: !document.getElementById('sanl-work')?.contains(document.getElementById('sanl-video')),
    };
  });
  check('la vue Analyse des départs s\'affiche et se construit',
        built && sanl.display !== 'none' && /Analyse des d/i.test(sanl.title || '')
        && sanl.hasList && sanl.hasWork && sanl.hasVideoSlot && sanl.videoHorsWork,
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
      styleApplique: cs.cursor === 'pointer' && parseFloat(cs.minWidth) >= 24,
      actifVisible: !!activeBtn && getComputedStyle(activeBtn).backgroundColor !== 'rgba(0, 0, 0, 0)',
    };
    host.remove();
    return out;
  });
  check('boutons V1 : 5 boutons, P3 barré chez les autres, actif chez son pilote',
        btns.nbBoutons === 5 && btns.a === '..x..' && btns.c === '..A..'
        && btns.styleApplique && btns.actifVisible,
        JSON.stringify(btns));

  // ── 13. Les boutons V1 tiennent sur UNE SEULE ligne (5 et 8 partants) ──
  const oneLine = await page.evaluate(async () => {
    const m = await import('/js/startAnalysisCalc.js');
    const measure = (starters) => {
      const rows = Array.from({ length: starters }, (_, i) => ({ driverId: 'd' + i, turn1Pos: null }));
      const host = document.createElement('div');
      host.className = 'sanl-work';
      host.style.width = '700px';                       // largeur réaliste du panneau
      const avail = new Set(m.availableTurn1Positions('d0', rows, starters));
      let h = '<div class="table-wrap"><table class="sanl-table"><thead><tr>'
        + '<th style="width:52px">Grille</th><th style="width:56px">Couloir</th>'
        + '<th class="sanl-col-pilote">Pilote</th><th style="width:52px">N°</th>'
        + `<th class="center sanl-col-v1" style="min-width:${starters * 31 + 14}px">1er virage</th>`
        + '<th style="width:74px">Arrivée</th><th class="center sanl-col-conf">Confiance</th>'
        + '</tr></thead><tbody><tr><td>P1</td><td>1</td><td>Laurent Le Manac\'h</td><td>12</td>'
        + '<td class="center"><div class="sanl-v1-group" data-driver="d0">';
      for (let k = 1; k <= starters; k++) {
        h += `<button type="button" class="sanl-v1-btn" data-pos="${k}" ${!avail.has(k) ? 'disabled' : ''}>P${k}</button>`;
      }
      h += '</div></td><td>P1</td><td><select class="form-select"><option>🟢 Fiable</option></select></td></tr></tbody></table></div>';
      host.innerHTML = h;
      document.body.appendChild(host);
      const group = host.querySelector('.sanl-v1-group');
      const btns = [...group.querySelectorAll('.sanl-v1-btn')];
      const tops = new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)));
      const groupH = group.getBoundingClientRect().height;
      const btnH = btns[0].getBoundingClientRect().height;
      const res = { starters, nbLignes: tops.size, ratioHauteur: +(groupH / btnH).toFixed(2) };
      host.remove();
      return res;
    };
    return [measure(5), measure(8)];
  });
  const allOneLine = oneLine.every(r => r.nbLignes === 1 && r.ratioHauteur < 1.6);
  check('boutons V1 sur une seule ligne (5 et 8 partants)', allOneLine, JSON.stringify(oneLine));

  // ── 14. La vue Statistiques des départs se construit ──
  await page.evaluate(async () => {
    const app = await import('/js/app.js');
    app.showView('startStats');
  });
  let statsBuilt = true;
  try {
    await page.waitForFunction(() => !!document.getElementById('sst-content'), null, { timeout: 8000 });
  } catch { statsBuilt = false; }
  const sst = await page.evaluate(() => ({
    display: document.getElementById('view-startStats')?.style.display,
    hasFilters: !!document.getElementById('sst-filters'),
    hasPhaseToggle: document.querySelectorAll('.sst-phase-btn').length === 2,
    menu: !!document.querySelector('.menu-item[data-view="startStats"]'),
  }));
  check('vue Statistiques des départs : filtres + bascule Manches/Finales',
        statsBuilt && sst.display !== 'none' && sst.hasFilters && sst.hasPhaseToggle && sst.menu,
        JSON.stringify(sst));

  // ── 15. Le calcul statistique tourne dans le navigateur ──
  const stat = await page.evaluate(async () => {
    const m = await import('/js/startStatsCalc.js');
    const mk = (id, turn1) => ({
      id, status: 'validated', sessionType: 'MQ', starters: 3, category: 'Supercar',
      year: 2026, circuitLabel: 'Kerlabo', championshipId: 'c1', gridLayoutKey: 'mq:5',
      gridSource: 'mq_couloir', gridLanes: 5,
      rows: [1, 2, 3].map((_, i) => ({
        driverId: `${id}-${i}`, didNotStart: false, gridPos: i + 1, lane: i + 1, gridRow: 1,
        turn1Pos: turn1[i], finishPosInStart: turn1[i], finishStatus: null,
      })),
    });
    const data = [mk('a', [1, 2, 3]), mk('b', [1, 2, 3]), mk('c', [2, 1, 3])];
    const rows = m.toRows(data);
    const mats = m.allMatrices(rows, 3);
    return {
      nStarts: m.summary(data).nStarts,
      p1KeepsLead: m.byGridPos(rows)[0].leadRate.rate,
      matrices: Object.keys(mats).length,
      cell00: mats.gridToTurn1.cells[0][0],
      smallSample: m.formatRate(m.wilson(2, 3)),
    };
  });
  check('calcul statistique correct dans le navigateur',
        stat.nStarts === 3 && Math.abs(stat.p1KeepsLead - 2 / 3) < 1e-9
        && stat.matrices === 3 && stat.cell00.count === 2 && stat.smallSample === '2/3',
        JSON.stringify(stat));


  // ── 16. Le lecteur vidéo se construit et son canvas recouvre la scène ──
  const vp = await page.evaluate(async () => {
    const { createVideoPlayer } = await import('/js/videoPlayer.js');
    const host = document.createElement('div');
    host.style.width = '640px';
    document.body.appendChild(host);
    const p = createVideoPlayer(host);
    await new Promise(r => requestAnimationFrame(r));
    const stage  = host.querySelector('.vp-stage');
    const canvas = host.querySelector('.vp-overlay');
    const sr = stage.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const out = {
      hasStage: !!stage,
      hasCanvas: !!canvas,
      // le canvas doit recouvrir la scène AU PIXEL près
      aligne: Math.abs(sr.x - cr.x) < 0.5 && Math.abs(sr.y - cr.y) < 0.5
           && Math.abs(sr.width - cr.width) < 0.5 && Math.abs(sr.height - cr.height) < 0.5,
      // et ne jamais intercepter un clic destiné au lecteur
      transparentAuxClics: getComputedStyle(canvas).pointerEvents === 'none',
      ratio: +(sr.width / sr.height).toFixed(3),
    };
    p.destroy();
    host.remove();
    return out;
  });
  check('lecteur vidéo : canvas d\'overlay superposé au pixel près',
        vp.hasStage && vp.hasCanvas && vp.aligne && vp.transparentAuxClics
        && Math.abs(vp.ratio - 16 / 9) < 0.01,
        JSON.stringify(vp));

  // ── 17. Une vraie vidéo locale : lecture, position, image par image ──
  //    La vidéo est fabriquée dans le navigateur (MediaRecorder) : le test
  //    exerce le vrai chemin <video> + objectURL, sans fichier de test binaire.
  const local = await page.evaluate(async () => {
    const FPS = 10;
    const make = () => new Promise((resolve, reject) => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const g = c.getContext('2d');
      const stream = c.captureStream(FPS);
      const chunks = [];
      let rec;
      try { rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
      catch (e) { reject(e); return; }
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => resolve(new File([new Blob(chunks, { type: 'video/webm' })], 'course.webm'));
      rec.start();
      let i = 0;
      const tick = setInterval(() => {
        g.fillStyle = `hsl(${(i * 24) % 360} 80% 50%)`;
        g.fillRect(0, 0, 320, 240);
        if (++i >= 30) { clearInterval(tick); rec.stop(); }
      }, 1000 / FPS);
    });

    const file = await make();
    const { createVideoPlayer } = await import('/js/videoPlayer.js');
    const host = document.createElement('div');
    host.style.width = '640px';
    document.body.appendChild(host);

    let ready = null;
    const p = createVideoPlayer(host, { onReady: (i) => { ready = i; } });
    p.loadFile(file, 0);
    await new Promise((res, rej) => {
      const t0 = Date.now();
      const wait = () => (ready ? res() : Date.now() - t0 > 8000 ? rej(new Error('métadonnées absentes')) : setTimeout(wait, 60));
      wait();
    });

    const video = host.querySelector('video');
    const settle = () => new Promise(res => {
      video.addEventListener('seeked', res, { once: true });
      setTimeout(res, 800);
    });

    p.seek(1);
    await settle();
    const t1 = p.getTime();

    // Image par image : le pas doit valoir 1/fps (cadence par défaut si la
    // mesure n'a pas encore eu lieu), et jamais 0.
    p.step(+1, 'frame');
    await settle();
    const t2 = p.getTime();

    p.step(-1, 'frame');
    await settle();
    const t3 = p.getTime();

    p.setRate(0.25);
    const rate = video.playbackRate;

    const out = {
      kind: p.kind,
      dureeConnue: p.duration > 0.4,
      apresSeek: +t1.toFixed(3),
      pasImage: +(t2 - t1).toFixed(4),
      retourImage: Math.abs(t3 - t1) < 1e-3,
      ralenti: rate,
      objectUrl: (video.src || '').startsWith('blob:'),   // le fichier reste local
      pasDeReseau: !/^https?:/i.test(video.src || ''),
    };
    p.destroy();
    host.remove();
    return out;
  }).catch(err => ({ error: String(err) }));

  check('vidéo locale : lecture, seek précis, image par image, ralenti',
        !local.error && local.kind === 'file' && local.dureeConnue
        && Math.abs(local.apresSeek - 1) < 0.15
        && local.pasImage > 0.005 && local.pasImage < 0.25
        && local.retourImage && local.ralenti === 0.25
        && local.objectUrl && local.pasDeReseau,
        JSON.stringify(local));

  // ── 18. Les bounding boxes tombent DANS l'image, jamais dans les bandes noires ──
  const overlay = await page.evaluate(async () => {
    const { createVideoPlayer } = await import('/js/videoPlayer.js');
    const { computeVideoRect } = await import('/js/videoPlayerCalc.js');
    const host = document.createElement('div');
    host.style.width = '640px';                 // scène 640×360 (16:9)
    document.body.appendChild(host);
    const p = createVideoPlayer(host);
    await new Promise(r => requestAnimationFrame(r));

    // Sans vidéo chargée, la scène est en 16:9 : le rectangle utile la remplit.
    const rect = p.getVideoRect();
    const attendu = computeVideoRect(640, 360, 1000, 562);

    const n = p.renderBoxes([
      { driverId: 'd1', carNumber: 12, label: 'DUPONT', status: 'confirmed',
        x: 0.25, y: 0.25, width: 0.2, height: 0.2 },
      { x: 5, y: 5, width: 0.1, height: 0.1 },                  // hors image → écartée
      { x: 0.1, y: 0.1, width: 0, height: 0.1 },                // dégénérée → écartée
    ]);

    const canvas = host.querySelector('.vp-overlay');
    const g = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const px = (x, y) => g.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;

    // Le bord gauche de la boîte doit être peint, le centre de la boîte non
    // (on dessine un contour, pas un aplat).
    const bord   = px(rect.x + rect.width * 0.25, rect.y + rect.height * 0.35);
    const centre = px(rect.x + rect.width * 0.35, rect.y + rect.height * 0.35);

    const out = {
      boitesRetenues: n,
      rectCorrect: Math.abs(rect.width - attendu.width) < 1 && Math.abs(rect.x - attendu.x) < 1,
      bordPeint: bord[3] > 0,
      centreVide: centre[3] === 0,
    };
    p.destroy();
    host.remove();
    return out;
  });
  check('overlay : boîtes normalisées dessinées au bon endroit, invalides écartées',
        overlay.boitesRetenues === 1 && overlay.rectCorrect
        && overlay.bordPeint && overlay.centreVide,
        JSON.stringify(overlay));

  // ── 19. L'overlay suit le redimensionnement et le changement de ratio ──
  const resize = await page.evaluate(async () => {
    const { createVideoPlayer } = await import('/js/videoPlayer.js');
    const host = document.createElement('div');
    host.style.width = '640px';
    document.body.appendChild(host);
    const p = createVideoPlayer(host);
    await new Promise(r => requestAnimationFrame(r));
    const avant = p.getVideoRect();

    host.style.width = '320px';
    await new Promise(r => setTimeout(r, 120));   // laisse agir le ResizeObserver
    const apres = p.getVideoRect();

    const canvas = host.querySelector('.vp-overlay');
    const stage  = host.querySelector('.vp-stage');
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();

    const out = {
      largeurAvant: Math.round(avant.width),
      largeurApres: Math.round(apres.width),
      moitie: Math.abs(apres.width * 2 - avant.width) < 2,
      canvasToujoursAligne: Math.abs(cr.width - sr.width) < 0.5 && Math.abs(cr.height - sr.height) < 0.5,
    };
    p.destroy();
    host.remove();
    return out;
  });
  check('overlay : reste aligné après redimensionnement',
        resize.moitie && resize.canvasToujoursAligne, JSON.stringify(resize));

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
