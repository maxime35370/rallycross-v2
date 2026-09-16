/* CONTRÔLE DE CADENCE DU LECTEUR — dans un vrai navigateur.

   Vérifie sur un fichier réel que le lecteur :
     • annonce la cadence du sidecar « rx-extract/1 » plutôt que de la deviner ;
     • numérote les images sur cette cadence ;
     • avance réellement de 1/fps par clic « image suivante ».

   Deux usages :

     node tools/smoke/videoPlayerFps.mjs <extrait.mp4>
         exécution automatique en Chromium (playwright), sortie en console.
         Le sidecar .json voisin est utilisé s'il existe.

     node tools/smoke/videoPlayerFps.mjs --serve
         sert seulement la page : ouvre l'URL affichée dans TON navigateur et
         sélectionne la vidéo + son .json. C'est le seul moyen de mesurer ce
         que fait vraiment TA machine — la cadence de présentation dépend de
         l'écran et du décodeur, pas du fichier.

   Sortie : code 0 si tous les contrôles passent. */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 8797);
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const args = process.argv.slice(2);
const SERVE_ONLY = args.includes('--serve');
const VIDEO = args.find(a => !a.startsWith('--')) || null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

if (VIDEO && !existsSync(VIDEO)) {
  console.error(`\nFichier introuvable : ${VIDEO}\n`);
  process.exit(1);
}

// Le fichier à tester peut vivre hors du dépôt : on l'expose sous /__media/.
const mediaDir = VIDEO ? dirname(resolve(VIDEO)) : null;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (path === '/' || path === '/__page') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(await readFile(join(ROOT, 'tools', 'smoke', 'videoPlayerFpsPage.html')));
      return;
    }
    const file = path.startsWith('/__media/')
      ? join(mediaDir || '', basename(path))
      : join(ROOT, path);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (process.env.SMOKE_DEBUG) console.error('  404', path, '->', file);
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': String(statSync(file).size),
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end(String(err.message));
  }
});

await new Promise(ok => server.listen(PORT, '127.0.0.1', ok));

if (SERVE_ONLY || !VIDEO) {
  console.log(`\n  Page de contrôle : http://127.0.0.1:${PORT}/__page`);
  console.log('  Ouvre-la dans ton navigateur, puis sélectionne la vidéo ET son .json.');
  console.log('  Ctrl+C pour arrêter.\n');
} else {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('console', m => {
    if (m.type() === 'error' || process.env.SMOKE_DEBUG) console.error(`  [page:${m.type()}]`, m.text());
  });
  page.on('pageerror', e => console.error('  [page:exception]', e.message));

  const url = `http://127.0.0.1:${PORT}/__page?auto=/__media/${encodeURIComponent(basename(VIDEO))}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__result, null, { timeout: 90000 });
  const r = await page.evaluate(() => window.__result);
  await browser.close();
  server.close();

  if (r.erreur) { console.error(`\n  Échec : ${r.erreur}\n`); process.exit(1); }

  const attendu = r.fpsSidecar;
  const check = (label, ok, valeur) =>
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(38)} ${valeur}`);

  console.log(`\n  ${r.fichier}${r.sidecar ? ` + ${r.sidecar}` : ' (sans sidecar)'}  —  ${r.duree?.toFixed(3)} s`);
  console.log(`  navigateur : H.264 « ${r.codecs?.h264} » · VP9 « ${r.codecs?.vp9} » · rVFC ${r.codecs?.rvfc ? 'oui' : 'NON'}\n`);
  if (r.codecs && r.codecs.h264 === 'non' && /\.mp4$/i.test(r.fichier)) {
    console.log('  ! Ce navigateur ne sait pas décoder le H.264 (build Chromium sans codecs');
    console.log('    propriétaires). Utilise --serve et ton propre Chrome pour un test complet.\n');
  }
  console.log(`  Cadence mesurée par le navigateur : ${r.fpsMesure ?? '—'} img/s`);
  console.log(`  Cadence annoncée par le sidecar   : ${attendu ?? '—'} img/s\n`);

  const controles = attendu ? [
    // Sans ce contrôle, tout le reste passerait au vert sur une vidéo que le
    // navigateur n'a jamais décodée : les calculs d'images sont purs.
    ['vidéo réellement décodée', !!r.decodee, r.decodee ? `${r.duree.toFixed(3)} s` : 'NON'],
    ['cadence retenue = celle du sidecar', r.fpsSidecar === attendu, `${attendu} img/s`],
    ['provenance = « declared »', r.fpsSourceAnnonce === 'declared', r.fpsSourceAnnonce],
    ['pas image par image = 1/fps', Math.abs(r.frameStepMs - 1000 / attendu) < 0.001, `${r.frameStepMs?.toFixed(3)} ms`],
    ['pas réellement appliqué', Math.abs(r.pasReelMs - 1000 / attendu) < 1, `${r.pasReelMs?.toFixed(3)} ms`],
    ['image à 43.000 s', r.frames[0] === Math.floor(43 * attendu), r.frames[0]],
    ['image à 51.000 s', r.frames[1] === Math.floor(51 * attendu), r.frames[1]],
  ] : [['sidecar rx-extract/1 lu', false, 'absent']];

  for (const [l, ok, v] of controles) check(l, ok, v);

  const tout = controles.every(([, ok]) => ok);
  if (attendu && r.decodee && r.fpsMesure !== attendu) {
    console.log(`\n  ! La mesure par requestVideoFrameCallback donne ${r.fpsMesure} au lieu de ${attendu} :`);
    console.log('    ce navigateur ne présente pas toutes les images. C\'est exactement');
    console.log('    le cas que le sidecar existe pour corriger.');
  }
  console.log(tout ? '\n  ✓ cadence correcte de bout en bout.\n' : '\n  ✗ contrôle en échec.\n');
  process.exit(tout ? 0 : 1);
}
