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

import { MODELS, DEFAULT_MODEL } from './lib/detect.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODELE_DIR = join(ROOT, 'tools', 'yolox-poc', 'modele');
const ORT_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const PORT = Number(process.env.YOLOX_PORT || 8798);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const args = process.argv.slice(2);
const CHECK = args.includes('--check') ? args[args.indexOf('--check') + 1] : null;
const SEUIL = args.includes('--seuil') ? args[args.indexOf('--seuil') + 1] : '0.30';
const MODELE = args.includes('--modele') ? args[args.indexOf('--modele') + 1] : DEFAULT_MODEL;
const PRECHARGER = args.includes('--precharger');

if (!MODELS[MODELE]) {
  console.error(`\n  modèle inconnu : « ${MODELE} ». Disponibles : ${Object.keys(MODELS).join(', ')}\n`);
  process.exit(1);
}

/**
 * Télécharge un modèle s'il manque, et le met en cache sur le disque.
 *
 * L'URL vient TOUJOURS du registre, jamais de la requête : le nom de fichier
 * demandé par la page ne sert qu'à choisir une entrée connue.
 */
const enCours = new Map();
async function assurerModele(file) {
  const modele = Object.values(MODELS).find(m => m.file === file);
  if (!modele) return null;
  const chemin = join(MODELE_DIR, modele.file);
  if (existsSync(chemin)) return chemin;
  if (enCours.has(modele.id)) return enCours.get(modele.id);

  const promesse = (async () => {
    console.log(`  téléchargement de ${modele.label} (~${modele.approxMo} Mo)…`);
    await mkdir(MODELE_DIR, { recursive: true });
    const r = await fetch(modele.url);
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${modele.url}`);
    await writeFile(chemin, Buffer.from(await r.arrayBuffer()));
    console.log(`  ${modele.file} enregistré (${(statSync(chemin).size / 1048576).toFixed(1)} Mo)`);
    return chemin;
  })();
  enCours.set(modele.id, promesse);
  return promesse;
}

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
// Les modèles sont récupérés à la demande, à la première requête de la page.
// `--precharger` les prend tous d'avance, pour préparer une machine hors ligne.
try {
  if (PRECHARGER) for (const m of Object.values(MODELS)) await assurerModele(m.file);
  else await assurerModele(MODELS[CHECK ? MODELE : DEFAULT_MODEL].file);
} catch (err) {
  console.error(`\n  échec du téléchargement : ${err.message}`);
  console.error(`  Récupère les .onnx à la main et place-les dans ${MODELE_DIR}\n`);
  process.exit(1);
}

// ── Serveur ─────────────────────────────────────────────
const mediaDir = CHECK ? dirname(resolve(CHECK)) : null;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    let file;
    if (path === '/' || path === '/__page') file = join(ROOT, 'tools', 'yolox-poc', 'page.html');
    else if (path === '/__suivi') file = join(ROOT, 'tools', 'yolox-poc', 'track.html');
    else if (path === '/__plans') file = join(ROOT, 'tools', 'yolox-poc', 'plans.html');
    else if (path.startsWith('/__ort/')) file = join(ORT_DIR, basename(path));
    else if (path.startsWith('/__modele/')) {
      file = await assurerModele(basename(path));
      if (!file) { res.writeHead(404); res.end('modèle inconnu'); return; }
    }
    else if (path.startsWith('/__media/')) file = join(mediaDir || '', basename(path));
    else file = join(ROOT, path);

    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': String(statSync(file).size),
      // Sans en-tête de cache, le navigateur applique sa propre heuristique et
      // peut resservir un module d'une session précédente. Sur un banc de
      // mesure, faire tourner l'ancien code en croyant mesurer le nouveau coûte
      // un aller-retour entier — et il n'y a rien ici qui gagne à être caché.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
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
  console.log(`  Modèles : ${Object.values(MODELS).map(m => `${m.label} (${m.inputSize} px)`).join(' · ')}`);
  console.log(`  Suivi temporel   : http://127.0.0.1:${PORT}/__suivi`);
  console.log(`  Plans (sans modèle) : http://127.0.0.1:${PORT}/__plans`);
  console.log('  Banc : les images du corpus ET son corpus.json. Suivi : l\'extrait .mp4 ET son .json.');
  console.log('  Tout reste local : aucune image n\'est envoyée nulle part.');
  console.log('  Ctrl+C pour arrêter.\n');
} else {
  if (!existsSync(CHECK)) { console.error(`\n  image introuvable : ${CHECK}\n`); process.exit(1); }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('  [page]', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/__page?auto=/__media/${encodeURIComponent(basename(CHECK))}&seuil=${SEUIL}&modele=${MODELE}`);
  await page.waitForFunction(() => window.__pret, null, { timeout: 180000 });
  const err = await page.evaluate(() => window.__erreur);
  const dets = await page.evaluate(() => window.__resultats?.[0]?.detections ?? []);
  await browser.close();
  server.close();
  if (err) { console.error(`\n  échec : ${err}\n`); process.exit(1); }
  console.log(`\n  ${basename(CHECK)} — ${MODELS[MODELE].label} (${MODELS[MODELE].inputSize} px) — seuil ${SEUIL} — ${dets.length} détection(s)\n`);
  for (const d of dets) {
    const alt = d.alsoDetectedAs?.length ? ` (aussi ${d.alsoDetectedAs.join(', ')})` : '';
    console.log(`    ${d.label.padEnd(8)} ${d.score.toFixed(3)}  [${d.box.join(', ')}]${alt}`);
  }
  console.log('');
}
