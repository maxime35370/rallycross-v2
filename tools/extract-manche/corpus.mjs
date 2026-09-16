#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   CORPUS.MJS — Images d'un départ pour le banc de détection

   À partir d'un extrait produit par `extract.mjs` et de deux repères relevés
   dans le lecteur — l'instant du départ et celui de l'abord du premier virage —
   produit les images des zones prévues au §13 de
   docs/video-analysis/EXTRACTION-YOUTUBE.md, plus leur manifeste `corpus.json`.

   Usage :
     node tools/extract-manche/corpus.mjs <extrait.mp4> --depart 43.000 --v1 51.000

   Les deux repères se donnent en temps LOCAL de l'extrait, c'est-à-dire tels
   que le lecteur les affiche. La cadence et l'ancrage absolu viennent du
   sidecar `rx-extract/1` posé à côté du fichier : on ne devine rien.

   Ce que l'outil ne fait PAS : annoter. `carsVisible`, `carsDetectable` et
   `carsOrderCritical` sortent vides, à remplir à la main. Un compte d'objets
   produit automatiquement ne saurait pas qu'une voiture a été oubliée.
═══════════════════════════════════════════════ */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';

import {
  parseTimeInput, toHms, planCorpusFrames, DEFAULT_CORPUS_PROFILE, SCHEMA,
} from './lib/recipe.mjs';
import { checkTools, runTool } from './lib/tools.mjs';

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = { bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), dim: paint('2') };

function fail(message) {
  console.error(`\n${C.red('X')} ${message}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────
// ARGUMENTS
// ─────────────────────────────────────────────────────────

const AIDE = `
${C.bold('IMAGES DE CORPUS')} — un extrait + deux repères -> les images des zones du départ

  node tools/extract-manche/corpus.mjs <extrait.mp4> --depart <t> --v1 <t>

${C.bold('Repères')} ${C.dim('(en temps LOCAL de l\'extrait, comme le lecteur les affiche)')}
  --depart <t>       instant du départ            ex. 43.000  ou 0:43.000
  --v1 <t>           abord du premier virage      ex. 51.000

${C.bold('Options')}
  --sortie <dossier>  défaut : <dossier de l'extrait>/corpus/
  --profil <fichier>  profil de zones sur mesure (JSON : [{zone, from, offset}])
  --fps <n>           force la cadence au lieu de lire le sidecar
  --partiel           accepte de produire moins de zones que prévu
  --dry-run           affiche le plan sans produire d'image
  --aide              ce message

${C.dim('FFMPEG_PATH impose le chemin de ffmpeg quand il n\'est pas dans le PATH.')}
`;

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
if (args.aide || args.help || !args._.length) { console.log(AIDE); process.exit(args._.length ? 0 : 1); }

const videoPath = resolve(process.cwd(), args._[0]);
if (!existsSync(videoPath)) fail(`extrait introuvable : ${videoPath}`);

// ─────────────────────────────────────────────────────────
// SIDECAR
// ─────────────────────────────────────────────────────────

const baseName = basename(videoPath, extname(videoPath));
const sidecarPath = join(dirname(videoPath), `${baseName}.json`);
let sidecar = null;
if (existsSync(sidecarPath)) {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    if (raw?.schema === SCHEMA) sidecar = raw;
    else fail(`${basename(sidecarPath)} n'est pas un sidecar ${SCHEMA}.`);
  } catch (err) {
    fail(`sidecar illisible : ${err.message}`);
  }
}

const fps = Number(args.fps) || Number(sidecar?.fps) || null;
if (!fps) {
  fail(`cadence inconnue : ni --fps, ni sidecar « ${basename(sidecarPath)} ».\n`
    + '  -> sans elle, les images ne peuvent pas être calées sur un numéro exact.');
}
const clipStart = Number(sidecar?.clipStart) || 0;
const clipDuration = Number(sidecar?.duration) || Number(sidecar?.clipDuration) || null;

// ─────────────────────────────────────────────────────────
// REPÈRES
// ─────────────────────────────────────────────────────────

const departLocal = parseTimeInput(args.depart ?? args.start);
const v1Local = parseTimeInput(args.v1);
if (departLocal == null) fail('--depart manquant ou illisible (ex. --depart 43.000).');
if (v1Local == null) fail('--v1 manquant ou illisible (ex. --v1 51.000).');
if (v1Local <= departLocal) fail(`--v1 (${toHms(v1Local)}) doit être après --depart (${toHms(departLocal)}).`);

let profile = DEFAULT_CORPUS_PROFILE;
if (typeof args.profil === 'string') {
  try {
    profile = JSON.parse(readFileSync(resolve(process.cwd(), args.profil), 'utf8'));
    if (!Array.isArray(profile) || !profile.length) throw new Error('tableau de zones attendu');
  } catch (err) {
    fail(`profil illisible : ${err.message}`);
  }
}

const plan = planCorpusFrames({
  baseName,
  startAt: clipStart + departLocal,
  v1At: clipStart + v1Local,
  clipStart, clipDuration, fps, profile,
});

// ─────────────────────────────────────────────────────────
// AFFICHAGE ET GARDE-FOU
// ─────────────────────────────────────────────────────────

console.log(`\n${C.bold('-- Extrait')}`);
console.log(`  ${baseName}  ${C.dim(`${fps} img/s · ${clipDuration ?? '?'} s · t=0 vaut ${toHms(clipStart)}`)}`);
console.log(`  départ local ${toHms(departLocal)}  ->  V1 local ${toHms(v1Local)}  ${C.dim(`(${(v1Local - departLocal).toFixed(1)} s)`)}`);
if (!sidecar) console.log(`  ${C.yellow('!')} aucun sidecar : cadence prise sur --fps, ancrage absolu supposé nul.`);

console.log(`\n${C.bold('-- Images prévues')}`);
for (const f of plan) {
  console.log(`  ${f.zone.padEnd(14)} local ${(f.absoluteTime - clipStart).toFixed(3).padStart(8)} s  `
    + `image ${String(f.clipFrame).padStart(6)}  ${C.dim(f.file)}`);
}

const manquantes = profile.filter(z => !plan.some(p => p.zone === z.zone));
if (manquantes.length) {
  // Produire 5 images sur 6 sans le dire, ce serait exactement le trou
  // silencieux qu'on cherche à éliminer partout ailleurs.
  const detail = manquantes.map((z) => {
    const ancre = z.from === 'v1' ? v1Local : departLocal;
    const t = ancre + Number(z.offset || 0);
    return `${z.zone} (local ${t.toFixed(3)} s)`;
  }).join(', ');
  console.log(`\n  ${C.yellow('!')} ${manquantes.length} zone(s) hors de l'extrait : ${detail}`);
  console.log(`  ${C.dim(`l'extrait couvre 0 -> ${clipDuration ?? '?'} s`)}`);
  if (!args.partiel) {
    fail('corpus incomplet.\n'
      + "  -> ré-extrais une fenêtre mieux centrée sur le départ (extract.mjs),\n"
      + '  -> ou accepte explicitement le corpus partiel avec --partiel.');
  }
  console.log(`  ${C.yellow('!')} --partiel : on continue avec ${plan.length} image(s).`);
}
if (!plan.length) fail('aucune image à produire.');

if (args['dry-run']) { console.log(`\n${C.dim('(--dry-run : aucune image produite)')}\n`); process.exit(0); }

// ─────────────────────────────────────────────────────────
// EXTRACTION DES IMAGES
// ─────────────────────────────────────────────────────────

const check = checkTools();
if (!check.tools.ffmpeg?.path) fail('ffmpeg est introuvable dans le PATH.');

const outDir = resolve(process.cwd(), String(args.sortie || join(dirname(videoPath), 'corpus')));
mkdirSync(outDir, { recursive: true });

console.log(`\n${C.bold('-- Production')} ${C.dim(outDir)}`);
const produites = [];
for (const f of plan) {
  const dest = join(outDir, f.file);
  // ffmpeg jette les images dont le PTS est STRICTEMENT INFÉRIEUR à `-ss`, et
  // garde la première dont le PTS lui est supérieur ou égal. Viser le milieu de
  // l'image (k + 0.5) sautait donc systématiquement à l'image k+1 — mesuré sur
  // une vidéo témoin dont chaque image porte une couleur unique
  // (tools/smoke/corpusFrames.mjs). On vise une demi-image AVANT : l'image k-1
  // est écartée, l'image k est la première conservée, avec une marge de sécurité
  // d'une demi-image de chaque côté contre les arrondis.
  const seek = Math.max(0, (f.clipFrame - 0.5) / fps);
  const res = runTool(check.tools.ffmpeg.path, [
    '-y', '-loglevel', 'error',
    '-ss', seek.toFixed(6),
    '-i', videoPath,
    '-frames:v', '1',
    // Aucun redimensionnement : le pré-traitement appartient au détecteur.
    '-f', 'image2', '-c:v', 'png',
    dest,
  ]);
  if (res.code !== 0 || !existsSync(dest)) {
    fail(`échec sur ${f.zone} :\n${(res.stderr || '').trim().split(/\r?\n/).slice(-4).join('\n')}`);
  }
  const octets = statSync(dest).size;
  produites.push({ ...f, sizeBytes: octets });
  console.log(`  ${C.green('v')} ${f.zone.padEnd(14)} ${(octets / 1048576).toFixed(2)} Mo  ${C.dim(f.file)}`);
}

// ─────────────────────────────────────────────────────────
// MANIFESTE
// ─────────────────────────────────────────────────────────

const manifest = {
  schema: 'rx-corpus/1',
  extract: {
    file: basename(videoPath),
    sidecar: sidecar ? basename(sidecarPath) : null,
    fps,
    clipStart,
    clipDuration,
    youtubeId: sidecar?.youtubeId ?? null,
    sessionId: sidecar?.sessionId ?? null,
    meetingId: sidecar?.meetingId ?? null,
    location: sidecar?.location ?? null,
    year: sidecar?.year ?? null,
    category: sidecar?.category ?? null,
    sessionType: sidecar?.sessionType ?? null,
    sessionNum: sidecar?.sessionNum ?? null,
    serie: sidecar?.serie ?? null,
  },
  marks: {
    departLocal, v1Local,
    departAbsolute: clipStart + departLocal,
    v1Absolute: clipStart + v1Local,
    origin: 'manual',
  },
  profile,
  frames: produites.map(f => ({
    file: f.file,
    zone: f.zone,
    clipFrame: f.clipFrame,
    clipTime: f.clipTime,
    absoluteTime: f.absoluteTime,
    sizeBytes: f.sizeBytes,
    // ── À REMPLIR À LA MAIN ──
    // carsVisible      : voitures visibles, même partiellement.
    // carsDetectable   : voitures dont plus de la moitié de la carrosserie est
    //                    visible — c'est la base du rappel.
    // carsOrderCritical: voitures dont l'absence fausserait l'ordre au V1.
    //                    Compteur SÉPARÉ : un bon rappel peut masquer une
    //                    erreur silencieuse sur l'ordre.
    carsVisible: null,
    carsDetectable: null,
    carsOrderCritical: null,
  })),
  createdAt: new Date().toISOString(),
};

const manifestPath = join(outDir, 'corpus.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\n${C.green('v')} ${produites.length} image(s) + ${C.bold('corpus.json')}`);
console.log(`  ${outDir}`);
console.log(`\n  ${C.dim('carsVisible / carsDetectable / carsOrderCritical sont vides : à annoter à la main.')}`);
console.log(`  ${C.dim('Ces images restent locales — le dépôt est public et les ignore.')}\n`);
