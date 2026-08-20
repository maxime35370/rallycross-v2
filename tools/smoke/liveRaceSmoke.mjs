/* ═══════════════════════════════════════════════
   SMOKE — MANCHE EN COURS (mode hybride réel + simulé)

   Même principe que projectionSmoke.mjs, mais les DONNÉES servies sont celles
   d'un meeting réel dont la dernière manche est TRONQUÉE : seules les premières
   séries sont révélées, exactement comme pendant une épreuve.

   Rien n'est écrit sur disque : la troncature est faite à la volée dans le
   serveur de test. On vérifie ensuite que l'interface dit la vérité —
   bandeau « manche en cours », bloc CERTITUDES séparé, refus du what-if pour un
   pilote déjà passé, et absence de verdict tant qu'une manche reste ouverte.

   Usage : node tools/smoke/liveRaceSmoke.mjs [nbSéries]
═══════════════════════════════════════════════ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'tools', 'qualification-audit', 'data');
const PORT = 8794;
const SERIES_REVEALED = Number(process.argv[2] || 4);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

if (!existsSync(join(DATA, 'meetings.json'))) {
  console.error('❌ Instantané absent. Lancez d\'abord fetch.mjs.');
  process.exit(1);
}

const J = n => JSON.parse(readFileSync(join(DATA, n), 'utf8'));

// ── Choix du meeting mis « en direct » ────────────────────────────────────
const meetings = J('meetings.json');
const sessions = J('sessions.json');
const results = J('results.json');

const cible = meetings.find(m => m.location === 'Kerlabo') || meetings[0];
const mqCible = sessions
  .filter(s => s.meetingId === cible.id && s.type === 'MQ' && s.category === 'D3')
  .sort((a, b) => a.num - b.num);
const derniere = mqCible[mqCible.length - 1];
if (!derniere) { console.error('❌ aucune manche exploitable'); process.exit(1); }

const masques = new Set(
  results.filter(r => r.sessionId === derniere.id && !(r.serie != null && r.serie <= SERIES_REVEALED))
    .map(r => r.id));

const resultsTronques = results.filter(r => !masques.has(r.id));
console.log(`Meeting mis en direct : ${cible.location} / D3 — manche ${derniere.num}`);
console.log(`${SERIES_REVEALED} séries révélées · ${masques.size} résultats masqués sur ${results.filter(r => r.sessionId === derniere.id).length}`);

// ── Serveur ───────────────────────────────────────────────────────────────
const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/__data/results.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(resultsTronques));
      return;
    }
    let file = urlPath.startsWith('/__data/')
      ? join(DATA, urlPath.slice('/__data/'.length))
      : join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); res.end('[]'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  });
  s.listen(PORT, () => ok(s));
});

const checks = [];
const check = (label, pass, detail = '') => {
  checks.push(pass);
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 1600 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));


await page.route(/gstatic\.com\/firebasejs\//, async (route) => {
  const url = route.request().url();
  const name = url.includes('firebase-app') ? 'firebase-app.js'
    : url.includes('firebase-firestore') ? 'firebase-firestore.js' : null;
  if (!name) {
    await route.fulfill({ status: 200, contentType: 'text/javascript',
      body: url.includes('firebase-auth')
        ? 'export function getAuth(){return{currentUser:null};}\nexport function onAuthStateChanged(_a,cb){cb(null);return()=>{};}\nexport function signInWithEmailAndPassword(){return Promise.reject(new Error("stub"));}\nexport function signOut(){return Promise.resolve();}\nexport function setPersistence(){return Promise.resolve();}\nexport const browserLocalPersistence={};\n'
        : 'export default {};' });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'text/javascript',
    body: await readFile(join(ROOT, 'tools', 'smoke', 'stub', name), 'utf8') });
});
await page.route(/\/sw\.js$/, async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* no-op */' });
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => { (await import('/js/app.js')).showView('projection'); });
  await page.waitForFunction(() => !!document.querySelector('#prj-content .prj-section'), null, { timeout: 20000 });

  // Sélection du meeting mis en direct.
  const selected = await page.evaluate((key) => {
    const sel = document.getElementById('prj-meeting');
    const opt = [...sel.options].find(o => o.value.includes(key));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return opt.textContent.trim();
  }, `${cible.id}||D3`);
  check('le meeting en cours est sélectionnable', Boolean(selected), selected || '');
  await page.waitForTimeout(800);

  const banner = await page.evaluate(() => {
    const el = document.querySelector('.prj-live');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('le bandeau « manche en cours » est affiché', Boolean(banner), (banner || '').slice(0, 150));
  check('le bandeau compte les résultats réels sur le total engagé',
        /(\d+) résultats sur (\d+)/.test(banner || ''), (banner || '').match(/\d+ résultats sur \d+/)?.[0] || '');
  check('le nombre de séries est annoncé avec sa source',
        /séries terminées d'après les séries renseignées/.test(banner || '')
        || /ne peut pas être établi/.test(banner || ''),
        (banner || '').match(/[^.]*séries[^.]*\./)?.[0] || '');
  check('les pilotes restant à courir sont nommés', /Restent à courir/.test(banner || ''));

  // Deux pilotes exercent deux chemins opposés : celui qui a déjà couru la
  // manche en cours doit se voir refuser le what-if, l'autre doit y avoir droit.
  const dejaCouru = [...new Set(resultsTronques
    .filter(r => r.sessionId === derniere.id && (r.ms != null || r.status))
    .map(r => r.driverId))];
  const restant = [...new Set(results
    .filter(r => r.sessionId === derniere.id).map(r => r.driverId))]
    .filter(id => !dejaCouru.includes(id));

  const choisir = (driverId) => page.evaluate((id) => {
    const sel = document.getElementById('prj-driver');
    const opt = [...sel.options].find(o => o.value === id);
    if (!opt) return null;
    sel.value = opt.value; sel.dispatchEvent(new Event('change'));
    return opt.textContent.trim();
  }, driverId);

  const driver = await choisir(dejaCouru[0]);
  check('un pilote déjà passé est sélectionnable', Boolean(driver), driver || '');
  await page.waitForTimeout(1500);

  const cert = await page.evaluate(() => {
    const band = [...document.querySelectorAll('.prj-band--certainties')][0];
    if (!band) return null;
    const body = band.parentElement.querySelector('.prj-body');
    const cards = [...body.querySelectorAll('.prj-card')].map(c => ({
      label: c.querySelector('.prj-card-label')?.textContent.trim(),
      value: c.querySelector('.prj-card-value')?.textContent.trim(),
    }));
    return {
      titre: band.textContent.trim(),
      cards,
      enonces: [...body.querySelectorAll('.prj-certainties li')].map(li => li.textContent.trim()),
      texte: body.textContent.replace(/\s+/g, ' '),
    };
  });
  check('le bloc CERTITUDES existe et est visuellement distinct', Boolean(cert), cert?.titre || '');
  check('il annonce position provisoire, meilleure et pire position',
        ['Position provisoire', 'Meilleure position possible', 'Pire position théorique']
          .every(l => cert?.cards.some(c => c.label === l)),
        (cert?.cards || []).map(c => `${c.label}=${c.value}`).join(' · '));
  check('aucun énoncé de certitude ne contient de pourcentage',
        (cert?.enonces || []).every(t => !/%|probabilit|estim/i.test(t)),
        `${cert?.enonces.length || 0} énoncé(s)`);
  const provisoire = cert?.cards.find(c => c.label === 'Position provisoire')?.value;
  const best = cert?.cards.find(c => c.label === 'Meilleure position possible')?.value;
  check('pour un pilote déjà passé, la position provisoire EST la meilleure position possible',
        Boolean(provisoire && provisoire === best), `${provisoire} / ${best}`);
  check('le résultat acquis est annoncé comme tel',
        (cert?.enonces || []).some(t => /acquis/.test(t)), (cert?.enonces || [])[0] || '');

  const etatWhatIf = () => page.evaluate(() => {
    const t = document.getElementById('prj-content').textContent.replace(/\s+/g, ' ');
    return {
      refus: /déjà acquis — scénario What-if indisponible pour cette manche/.test(t),
      bouton: !!document.getElementById('prj-whatif'),
    };
  });

  const wAcquis = await etatWhatIf();
  check('le what-if est REFUSÉ pour un pilote déjà passé, avec le message attendu',
        wAcquis.refus && !wAcquis.bouton, JSON.stringify(wAcquis));

  const autre = await choisir(restant[0]);
  await page.waitForTimeout(1500);
  const wRestant = await etatWhatIf();
  check('le what-if reste DISPONIBLE pour un pilote qui n\'a pas encore couru',
        wRestant.bouton && !wRestant.refus, `${autre} → ${JSON.stringify(wRestant)}`);

  // Le classement affiché ne doit compter QUE les manches terminées.
  const coherence = await page.evaluate(() => {
    const sel = document.getElementById('prj-checkpoint');
    return { checkpoint: sel?.value, options: [...(sel?.options || [])].map(o => o.textContent.trim()) };
  });
  check('le checkpoint reste sur la dernière manche TERMINÉE',
        coherence.options.every(o => !o.includes(String(4))) || coherence.checkpoint !== '4',
        JSON.stringify(coherence));

  // Polices Google, QR distant, service worker : ressources externes
  // inaccessibles depuis l'environnement de test, sans rapport avec le module.
  const reelles = errors.filter(e => !/net::|Failed to fetch|Failed to load resource|ERR_|favicon|manifest|qrserver|fonts\.googleapis|sw\.js|ServiceWorker/i.test(e));
  check('aucune erreur JavaScript', reelles.length === 0, reelles.slice(0, 3).join(' | '));
} catch (e) {
  check('parcours complet', false, e.message);
} finally {
  await browser.close();
  server.close();
}

const ok = checks.filter(Boolean).length;
console.log('\n' + '═'.repeat(60));
console.log(`${ok}/${checks.length} vérifications passées`);
process.exit(ok === checks.length ? 0 : 1);
