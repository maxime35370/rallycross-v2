/* EXACTITUDE DES IMAGES DE CORPUS — vérification bout en bout.

   Fabrique une vidéo dont CHAQUE image porte une couleur unique déduite de son
   numéro, lui donne un sidecar, lance `tools/extract-manche/corpus.mjs`, puis
   relit la couleur de chaque PNG produit pour vérifier qu'il s'agit bien de
   l'image demandée — et pas de sa voisine.

   C'est le seul moyen de prouver « image exacte » : sur une vraie vidéo, deux
   images consécutives se ressemblent trop pour qu'un écart d'une image se voie.

   Prérequis : ffmpeg dans le PATH.
   Usage     : node tools/smoke/corpusFrames.mjs
   Sortie    : code 0 si chaque image produite est exactement celle attendue. */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = join(ROOT, 'tools', 'smoke', 'shots', 'corpus-frames');
const FPS = 60;
const NB = 300;                       // 5 s
const TAILLE = 64;
const PAS = 32;                       // marche de couleur, large pour résister à l'encodage

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

/** Couleur unique d'une image : trois chiffres en base 8, espacés de 32. */
const couleurDe = (k) => [
  (k % 8) * PAS,
  (Math.floor(k / 8) % 8) * PAS,
  (Math.floor(k / 64) % 8) * PAS,
];
/** Opération inverse, tolérante à l'arrondi de l'encodage. */
const indexDe = ([r, g, b]) => {
  const q = (v) => Math.min(7, Math.max(0, Math.round(v / PAS)));
  return q(r) + q(g) * 8 + q(b) * 64;
};

function run(args, input) {
  const r = spawnSync(ffmpeg, args, { input, maxBuffer: 1 << 28 });
  if (r.error) {
    console.error(`\n  ffmpeg introuvable (${ffmpeg}). Installe-le ou renseigne FFMPEG_PATH.\n`);
    process.exit(1);
  }
  return r;
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ── 1 · fabrication de la vidéo témoin ──────────────────
const brut = Buffer.alloc(TAILLE * TAILLE * 3 * NB);
for (let k = 0; k < NB; k++) {
  const [r, g, b] = couleurDe(k);
  for (let p = 0; p < TAILLE * TAILLE; p++) {
    const o = (k * TAILLE * TAILLE + p) * 3;
    brut[o] = r; brut[o + 1] = g; brut[o + 2] = b;
  }
}
const video = join(WORK, 'temoin.mp4');
const enc = run([
  '-y', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${TAILLE}x${TAILLE}`, '-r', String(FPS), '-i', 'pipe:0',
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-g', '10', '-movflags', '+faststart',
  video,
], brut);
if (enc.status !== 0 || !existsSync(video)) {
  console.error('\n  échec de fabrication de la vidéo témoin :\n', String(enc.stderr).slice(-500));
  process.exit(1);
}

// ── 2 · sidecar ─────────────────────────────────────────
const CLIP_START = 20543;
writeFileSync(join(WORK, 'temoin.json'), JSON.stringify({
  schema: 'rx-extract/1',
  fps: FPS, clipStart: CLIP_START, clipDuration: NB / FPS, duration: NB / FPS,
  location: 'Temoin', year: 2026, category: 'D3', sessionType: 'MQ', sessionNum: 3, serie: 4,
  youtubeId: 'temoin', file: 'temoin.mp4',
}, null, 2));

// ── 3 · génération du corpus ────────────────────────────
const DEPART = 0.2, V1 = 2.0;
const gen = spawnSync(process.execPath, [
  join(ROOT, 'tools', 'extract-manche', 'corpus.mjs'), video,
  '--depart', String(DEPART), '--v1', String(V1),
  '--sortie', join(WORK, 'corpus'),
], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
if (gen.status !== 0) {
  console.error('\n  corpus.mjs a échoué :\n', gen.stdout, gen.stderr);
  process.exit(1);
}

// ── 4 · vérification image par image ────────────────────
const manifest = JSON.parse(readFileSync(join(WORK, 'corpus', 'corpus.json'), 'utf8'));
console.log(`\n  ${manifest.frames.length} image(s) produite(s) · ${FPS} img/s · vidéo témoin de ${NB} images\n`);

let echecs = 0;
for (const f of manifest.frames) {
  const png = join(WORK, 'corpus', f.file);
  const dec = run(['-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const px = [dec.stdout[0], dec.stdout[1], dec.stdout[2]];
  const lu = indexDe(px);
  const ok = lu === f.clipFrame;
  if (!ok) echecs++;
  console.log(`  ${ok ? '✓' : '✗'} ${f.zone.padEnd(14)} attendue #${String(f.clipFrame).padStart(4)}`
    + `  obtenue #${String(lu).padStart(4)}  ${ok ? '' : `(écart ${lu - f.clipFrame})`}`);
}

// ── 5 · contrôles du manifeste ──────────────────────────
const controles = [
  ['manifeste rx-corpus/1', manifest.schema === 'rx-corpus/1'],
  ['ancrage absolu conservé', manifest.marks.departAbsolute === CLIP_START + DEPART],
  ['annotations laissées vides', manifest.frames.every(f =>
    f.carsVisible === null && f.carsDetectable === null && f.carsOrderCritical === null)],
  ['zones du profil toutes présentes', manifest.frames.length === manifest.profile.length],
];
console.log('');
for (const [label, ok] of controles) {
  if (!ok) echecs++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

console.log(echecs ? `\n  ✗ ${echecs} contrôle(s) en échec.\n` : '\n  ✓ chaque image produite est exactement celle demandée.\n');
process.exit(echecs ? 1 : 0);
