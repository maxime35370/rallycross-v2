/* CALAGE D'IMAGE DANS LE NAVIGATEUR — vérification empirique.

   Le suivi temporel échantillonne la vidéo en posant `video.currentTime`. Reste
   à savoir QUELLE image le navigateur affiche alors — question qui n'a rien
   d'évident, et dont la réponse est l'INVERSE de celle de ffmpeg :

     ffmpeg  `-ss t`         → première image dont le PTS est ≥ t
     <video> `currentTime=t` → image dont l'INTERVALLE contient t

   Mesuré sur ce Chromium : viser la frontière exacte (`k/fps`) tombe juste
   aussi. On garde malgré tout le milieu de l'image (`k/fps + 0.5/fps`), qui ne
   dépend d'aucun arrondi du démultiplexeur — et ce contrôle le vérifie à
   chaque exécution, y compris le jour où un navigateur en décidera autrement.

   Méthode : une vidéo dont chaque image porte une couleur unique déduite de son
   numéro — deux images de course se ressemblent trop pour qu'un écart d'une
   image se voie.

   Prérequis : ffmpeg dans le PATH (ou FFMPEG_PATH), Chromium de Playwright.
   Usage     : node tools/smoke/videoSeek.mjs */

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, existsSync, statSync, createReadStream, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = join(ROOT, 'tools', 'smoke', 'shots', 'video-seek');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const FPS = 60, NB = 900, TAILLE = 64, PAS = 16, NIVEAUX = 16, PORT = 8801;

// 16 niveaux par canal : 4096 images codables, largement au-delà des 900.
const couleurDe = (k) => [(k % NIVEAUX) * PAS,
  (Math.floor(k / NIVEAUX) % NIVEAUX) * PAS,
  (Math.floor(k / (NIVEAUX * NIVEAUX)) % NIVEAUX) * PAS];

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const film = join(WORK, 'temoin60.webm');

// ── vidéo témoin, en VP9 : le Chromium de Playwright n'a pas les codecs
//    propriétaires, il ne saurait pas décoder du H.264.
const brut = Buffer.alloc(TAILLE * TAILLE * 3 * NB);
for (let k = 0; k < NB; k++) {
  const [r, g, b] = couleurDe(k);
  for (let p = 0; p < TAILLE * TAILLE; p++) {
    const o = (k * TAILLE * TAILLE + p) * 3;
    brut[o] = r; brut[o + 1] = g; brut[o + 2] = b;
  }
}
const enc = spawnSync(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${TAILLE}x${TAILLE}`, '-r', String(FPS), '-i', 'pipe:0',
  '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p', film,
], { input: brut, maxBuffer: 1 << 28 });
if (enc.error || enc.status !== 0 || !existsSync(film)) {
  console.error(`\n  ffmpeg indisponible ou en échec (${ffmpeg}).\n${String(enc.stderr || enc.error).slice(-400)}\n`);
  process.exit(1);
}

// ── serveur minimal ─────────────────────────────────────
const srv = createServer((req, res) => {
  if (req.url.startsWith('/v')) {
    // Les requêtes par plage sont INDISPENSABLES : sans elles, Chromium
    // considère le média non déplaçable, ignore `currentTime` et rend
    // invariablement la première image. Constaté : les six relevés donnaient 0.
    const taille = statSync(film).size;
    const plage = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const debut = plage && plage[1] ? Number(plage[1]) : 0;
    const fin = plage && plage[2] ? Number(plage[2]) : taille - 1;
    res.writeHead(plage ? 206 : 200, {
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fin - debut + 1),
      ...(plage ? { 'Content-Range': `bytes ${debut}-${fin}/${taille}` } : {}),
    });
    createReadStream(film, { start: debut, end: fin }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset=utf-8><video id=v src=/v preload=auto muted></video>');
});
await new Promise(ok => srv.listen(PORT, '127.0.0.1', ok));

const { chromium } = await import('playwright');
const navigateur = await chromium.launch({ executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined });
const page = await navigateur.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

const releves = await page.evaluate(async ({ fps, pas, niveaux }) => {
  const v = document.getElementById('v');
  if (v.readyState < 1) {
    await new Promise((ok, ko) => {
      v.addEventListener('loadedmetadata', ok, { once: true });
      setTimeout(() => ko(new Error('métadonnées jamais chargées')), 15000);
    });
  }
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const q = (x) => Math.min(niveaux - 1, Math.max(0, Math.round(x / pas)));
  const lire = async (t) => {
    await new Promise((ok, ko) => {
      const f = () => { v.removeEventListener('seeked', f); ok(); };
      v.addEventListener('seeked', f);
      v.currentTime = t;
      setTimeout(() => ko(new Error('seek timeout')), 8000);
    });
    ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(1, 1, 1, 1).data;
    return q(d[0]) + q(d[1]) * niveaux + q(d[2]) * niveaux * niveaux;
  };
  const out = [];
  for (const t of [0.5, 3.0, 4.25, 7.75, 11.0, 13.5]) {
    out.push({ t, attendue: Math.round(t * fps), milieu: await lire(t + 0.5 / fps), frontiere: await lire(t) });
  }
  return out;
}, { fps: FPS, pas: PAS, niveaux: NIVEAUX });

await navigateur.close();
srv.close();

let echecs = 0;
console.log(`\n  vidéo témoin ${NB} images à ${FPS} img/s\n`);
console.log('     t     attendue   t + 0.5/fps   t exact');
for (const r of releves) {
  const ok = r.milieu === r.attendue;
  if (!ok) echecs++;
  console.log(`  ${String(r.t).padStart(6)}  ${String(r.attendue).padStart(8)}   ${String(r.milieu).padStart(11)} ${ok ? '✓' : '✗'}`
    + `   ${String(r.frontiere).padStart(7)} ${r.frontiere === r.attendue ? '✓' : '✗'}`);
}
console.log(echecs
  ? `\n  ✗ ${echecs} écart(s) : la règle de calage est fausse.\n`
  : '\n  ✓ « t + 0.5/fps » donne toujours l\'image attendue.\n');
process.exit(echecs ? 1 : 0);
