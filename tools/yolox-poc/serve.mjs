/* BANC DE DÉTECTION YOLOX-tiny — serveur local du POC.

   Sert la page d'analyse, ONNX Runtime Web et le modèle. Rien ne sort de la
   machine : les images sont ouvertes par le navigateur depuis le disque, et
   l'inférence tourne en WebAssembly dans l'onglet.

     node tools/yolox-poc/serve.mjs
         sert la page ; ouvre l'URL affichée, sélectionne les 6 PNG du corpus
         et son corpus.json.

     node tools/yolox-poc/serve.mjs --check <image.jpg>
         contrôle automatique en Chromium (playwright) : lance la détection sur
         une image et affiche les boîtes obtenues. Sert à vérifier le portage.

   Le modèle YOLOX-tiny (Apache 2.0) est téléchargé une fois dans
   tools/yolox-poc/modele/ — dossier ignoré par git, comme tous les .onnx. */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODELE_DIR = join(ROOT, 'tools', 'yolox-poc', 'modele');
const MODELE = join(MODELE_DIR, 'yolox_tiny.onnx');
const MODELE_URL = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx';
const ORT_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const PORT = Number(process.env.YOLOX_PORT || 8798);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const args = process.argv.slice(2);
const CHECK = args.includes('--check') ? args[args.indexOf('--check') + 1] : null;
const SEUIL = args.includes('--seuil') ? args[args.indexOf('--seuil') + 1] : '0.30';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.mjs.map': 'application/json',
};

// ── Modèle ──────────────────────────────────────────────
if (!existsSync(ORT_DIR)) {
  console.error('\n  onnxruntime-web est absent. Lance d\'abord :  npm install\n');
  process.exit(1);
}
if (!existsSync(MODELE)) {
  console.log('\n  Téléchargement de YOLOX-tiny (Apache 2.0, ~20 Mo)…');
  await mkdir(MODELE_DIR, { recursive: true });
  const r = await fetch(MODELE_URL);
  if (!r.ok) {
    console.error(`  échec : HTTP ${r.status}. Télécharge le fichier à la main depuis\n  ${MODELE_URL}\n  et place-le dans ${MODELE_DIR}\n`);
    process.exit(1);
  }
  await writeFile(MODELE, Buffer.from(await r.arrayBuffer()));
  console.log(`  modèle enregistré (${(statSync(MODELE).size / 1048576).toFixed(1)} Mo)`);
}

// ── Serveur ─────────────────────────────────────────────
const mediaDir = CHECK ? dirname(resolve(CHECK)) : null;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    let file;
    if (path === '/' || path === '/__page') file = join(ROOT, 'tools', 'yolox-poc', 'page.html');
    else if (path.startsWith('/__ort/')) file = join(ORT_DIR, basename(path));
    else if (path.startsWith('/__modele/')) file = join(MODELE_DIR, basename(path));
    else if (path.startsWith('/__media/')) file = join(mediaDir || '', basename(path));
    else file = join(ROOT, path);

    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': String(statSync(file).size),
      // Isolation d'origine : autorise le WebAssembly multi-thread.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end(String(err.message));
  }
});
await new Promise(ok => server.listen(PORT, '127.0.0.1', ok));

if (!CHECK) {
  console.log(`\n  Banc de détection : http://127.0.0.1:${PORT}/__page`);
  console.log('  Ouvre-le, puis sélectionne les images du corpus ET son corpus.json.');
  console.log('  Tout reste local : aucune image n\'est envoyée nulle part.');
  console.log('  Ctrl+C pour arrêter.\n');
} else {
  if (!existsSync(CHECK)) { console.error(`\n  image introuvable : ${CHECK}\n`); process.exit(1); }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('  [page]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__page?auto=/__media/${encodeURIComponent(basename(CHECK))}&seuil=${SEUIL}`);
  await page.waitForFunction(() => window.__pret, null, { timeout: 180000 });
  const err = await page.evaluate(() => window.__erreur);
  const dets = await page.evaluate(() => window.__resultats?.[0]?.detections ?? []);
  await browser.close();
  server.close();
  if (err) { console.error(`\n  échec : ${err}\n`); process.exit(1); }
  console.log(`\n  ${basename(CHECK)} — seuil ${SEUIL} — ${dets.length} détection(s)\n`);
  for (const d of dets) {
    const alt = d.alsoDetectedAs?.length ? ` (aussi ${d.alsoDetectedAs.join(', ')})` : '';
    console.log(`    ${d.label.padEnd(8)} ${d.score.toFixed(3)}  [${d.box.join(', ')}]${alt}`);
  }
  console.log('');
}
