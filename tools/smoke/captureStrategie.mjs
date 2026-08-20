/* CAPTURE DE L'ÉCRAN « STRATÉGIE LIVE » — meeting réel, manche en cours.

   Sert de contrôle visuel avant livraison : le rendu d'un écran ne se vérifie
   pas dans un test unitaire. Les données sont réelles ; seule la dernière
   manche est tronquée à la volée pour reproduire une situation de direct.

   Usage : node tools/smoke/captureStrategie.mjs [séries] [dossard]
   Sortie : tools/smoke/shots/ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'tools', 'qualification-audit', 'data');
const SHOTS = join(ROOT, 'tools', 'smoke', 'shots');
const PORT = 8796;
const SERIES = Number(process.argv[2] || 4);
const DOSSARD = process.argv[3] || null;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const J = n => JSON.parse(readFileSync(join(DATA, n), 'utf8'));
const meetings = J('meetings.json'), sessions = J('sessions.json'), results = J('results.json');

const cible = meetings.find(m => m.location === 'Kerlabo') || meetings[0];
const derniere = sessions
  .filter(s => s.meetingId === cible.id && s.type === 'MQ' && s.category === 'D3')
  .sort((a, b) => a.num - b.num).pop();
const masques = new Set(results
  .filter(r => r.sessionId === derniere.id && !(r.serie != null && r.serie <= SERIES))
  .map(r => r.id));
const tronques = results.filter(r => !masques.has(r.id));

console.log(`${cible.location} / D3 — manche ${derniere.num}, ${SERIES} séries révélées (${masques.size} résultats masqués)`);

const server = await new Promise((ok) => {
  const s = createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/__data/results.json') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(tronques)); return;
    }
    let f = p.startsWith('/__data/') ? join(DATA, p.slice(8)) : join(ROOT, p === '/' ? 'index.html' : p);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404); res.end('[]'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  });
  s.listen(PORT, () => ok(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1500 }, deviceScaleFactor: 2 });

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
await page.route(/\/sw\.js$/, async (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* no-op */' }));

mkdirSync(SHOTS, { recursive: true });

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: join(SHOTS, 'accueil-tuile.png') });

await page.evaluate(async () => { (await import('/js/app.js')).showView('projection'); });
await page.waitForFunction(() => !!document.querySelector('.prj-tab'), null, { timeout: 20000 });
await page.waitForTimeout(1200);

await page.evaluate((key) => {
  const sel = document.getElementById('prj-meeting');
  const opt = [...sel.options].find(o => o.value.includes(key));
  if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
}, `${cible.id}||D3`);
await page.waitForTimeout(800);

/** Pilote suivi : celui demandé, sinon le plus proche de la bulle encore à courir. */
const choisi = await page.evaluate(({ dossard }) => {
  const sel = document.getElementById('prj-driver');
  const opts = [...sel.options].filter(o => o.value);
  let cible = null;
  if (dossard) cible = opts.find(o => o.textContent.includes(`#${dossard}`));
  if (!cible) {
    let best = null;
    for (const o of opts) {
      const m = /P(\d+)/.exec(o.textContent);
      if (!m) continue;
      const d = Math.abs(Number(m[1]) - 16);
      if (!best || d < best.d) best = { d, o };
    }
    cible = best?.o;
  }
  if (!cible) return null;
  sel.value = cible.value; sel.dispatchEvent(new Event('change'));
  return cible.textContent.trim();
}, { dossard: DOSSARD });
console.log(`pilote suivi : ${choisi}`);

await page.waitForFunction(() => !!document.querySelector('.prj-objective'), null, { timeout: 90000 });
await page.waitForTimeout(600);

await page.screenshot({ path: join(SHOTS, 'strategie-live.png'), fullPage: true });
// Haut de page : ce que le team voit sans faire défiler.
await page.screenshot({ path: join(SHOTS, 'strategie-haut.png'), clip: { x: 0, y: 0, width: 1000, height: 900 } });
const bloc = await page.$('#prj-strategy-body');
if (bloc) await bloc.screenshot({ path: join(SHOTS, 'strategie-bloc.png') });

const resume = await page.evaluate(() => {
  const t = (s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || null;
  return {
    titre: t('.prj-strategy-title'), sous: t('.prj-strategy-sub'),
    situation: t('.prj-situation'), objectif: t('.prj-objective-goal'),
    chrono: t('.prj-objective-chrono'), proba: t('.prj-objective-prob'),
    comparaison: t('.prj-objective-compare'), risque: t('.prj-objective-risk'),
    avertissement: t('.prj-warning'), certain: t('.prj-strategy-certain'),
  };
});
console.log(JSON.stringify(resume, null, 2));

await browser.close();
server.close();
console.log(`\ncaptures écrites dans ${SHOTS}`);
