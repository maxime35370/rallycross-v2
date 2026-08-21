#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   EXTRACT.MJS — Extraction locale d'une manche depuis une retransmission

   URL YouTube + début + fin  →  MP4 local + sidecar JSON  →  lecteur V0.

   Architecture « option A » de docs/video-analysis/EXTRACTION-YOUTUBE.md :
   un script local, aucun service, aucune modification de l'application. La
   vidéo ne quitte jamais la machine et n'est JAMAIS téléversée.

   Usage :
     node tools/extract-manche/extract.mjs --url <lien> --start 05:42:26 --fin 05:43:10 \
          --lieu Kerlabo --annee 2026 --categorie D3 --type MQ --num 3 --serie 4

   Sous Windows, `extraire.cmd` fait la même chose sans taper « node ».
   `--aide` détaille toutes les options.

   Usage privé d'analyse : assure-toi d'avoir le droit d'extraire cette vidéo
   (EXTRACTION-YOUTUBE.md §9).
═══════════════════════════════════════════════ */

import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractYoutubeId, timecodeKey } from '../../js/utils.js';
import {
  SCHEMA, DEFAULT_PAD_BEFORE, DEFAULT_PAD_AFTER,
  parseTimeInput, toHms, buildWindow, sectionArg, buildBaseName,
  buildYtDlpArgs, checkProbe, buildSidecar, planCorpusFrames,
} from './lib/recipe.mjs';
import { checkTools, runTool, probeFile, explainFailure } from './lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, 'extraits');

// Couleurs ANSI, désactivées si la sortie n'est pas un terminal (redirection,
// journal CI) : un fichier de log ne doit pas se remplir de séquences d'échappement.
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  bold: paint('1'), red: paint('31'), green: paint('32'),
  yellow: paint('33'), dim: paint('2'),
};

// ─────────────────────────────────────────────────────────
// ARGUMENTS
// ─────────────────────────────────────────────────────────

/** `--cle valeur` et `--cle=valeur`, plus les drapeaux sans valeur. */
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

/** Accepte deux noms pour chaque option : le script est franco-français, mais
 *  une recette JSON produite par l'application utilisera les noms anglais. */
function pick(args, ...names) {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}

const AIDE = `
${C.bold("EXTRACTION D'UNE MANCHE")} — YouTube + 2 timecodes -> MP4 local exploitable par le lecteur V0

${C.bold('Obligatoire')}
  --url <lien>            URL YouTube (https://youtu.be/... ou identifiant)
  --start <timecode>      début de la plage utile        ex. 05:42:26
  --fin <timecode>        fin de la plage utile          ex. 05:43:10

${C.bold("Identité de la manche")} ${C.dim('(nom de fichier et sidecar)')}
  --lieu <texte>          ex. Kerlabo          --annee <n>     ex. 2026
  --categorie <texte>     ex. D3               --type <EC|MQ|QF|DF|FIN>
  --num <n>               n° de manche         --serie <n>     n° de série
  --meeting-id / --session-id / --championship-id   clés Firestore, si connues

${C.bold('Réglages')}
  --pad-avant <s>         marge avant  (défaut ${DEFAULT_PAD_BEFORE})
  --pad-apres <s>         marge après  (défaut ${DEFAULT_PAD_AFTER})
  --v1 <timecode>         abord du 1er virage — repère du futur corpus YOLOX
  --mode <precise|fast>   défaut « precise » : coupe à l'image
  --sortie <dossier>      défaut tools/extract-manche/extraits/
  --nom <base>            force le nom de base du fichier
  --origin <texte>        « manual » (défaut) ou « auto:... » — trace la provenance

${C.bold('Sans rien extraire')}
  --verifier              contrôle seulement yt-dlp / ffmpeg / ffprobe
  --dry-run               affiche la commande yt-dlp exacte, ne lance rien
  --plan-corpus           affiche les images du corpus que produirait --v1
  --recette <fichier>     lit toutes les options dans un JSON
  --aide                  ce message

${C.dim("Usage privé d'analyse : assure-toi d'avoir le droit d'extraire cette vidéo.")}
`;

// ─────────────────────────────────────────────────────────
// CONSTRUCTION DE LA RECETTE
// ─────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n${C.red('X')} ${message}\n`);
  process.exit(1);
}

function readRecipeFile(path) {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) fail(`recette introuvable : ${abs}`);
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    fail(`recette illisible (${basename(abs)}) : ${err.message}`);
  }
  return {};
}

/**
 * Assemble la recette à partir des arguments et/ou d'un fichier JSON.
 *
 * Le contrat d'entrée est un OBJET, pas une saisie : que `sourceStart` vienne
 * d'un champ texte ou d'un détecteur automatique ne change rien ici
 * (EXTRACTION-YOUTUBE.md §6.3).
 */
function buildRecipe(args) {
  const file = pick(args, 'recette', 'recipe');
  const fromFile = typeof file === 'string' ? readRecipeFile(file) : {};
  const get = (...names) => {
    const v = pick(args, ...names);
    if (v !== undefined) return v;
    for (const n of names) if (fromFile[n] !== undefined) return fromFile[n];
    return undefined;
  };

  const url = get('url', 'youtubeUrl');
  if (!url || url === true) fail('--url manquante. Exemple : --url https://youtu.be/_SqxZQl5zzQ');

  const youtubeId = extractYoutubeId(String(url));
  if (!youtubeId) fail(`« ${url} » n'est pas une URL YouTube reconnue.`);

  const rawStart = get('start', 'debut', 'sourceStart');
  const rawEnd = get('fin', 'end', 'sourceEnd');
  const sourceStart = parseTimeInput(rawStart);
  const sourceEnd = parseTimeInput(rawEnd);
  if (sourceStart == null) fail(`début illisible : « ${rawStart ?? ''} ». Attendu « 05:42:26 » ou un nombre de secondes.`);
  if (sourceEnd == null) fail(`fin illisible : « ${rawEnd ?? ''} ». Attendu « 05:43:10 » ou un nombre de secondes.`);

  const v1Raw = get('v1', 'v1At', 'turn1At');
  const v1At = v1Raw === undefined || v1Raw === true ? null : parseTimeInput(v1Raw);
  if (v1Raw !== undefined && v1Raw !== true && v1At == null) fail(`--v1 illisible : « ${v1Raw} ».`);

  let win = null;
  try {
    win = buildWindow({
      sourceStart,
      sourceEnd,
      padBefore: get('pad-avant', 'padBefore') ?? DEFAULT_PAD_BEFORE,
      padAfter: get('pad-apres', 'padAfter') ?? DEFAULT_PAD_AFTER,
    });
  } catch (err) {
    fail(err.message);
  }

  const identity = {
    meetingId: get('meeting-id', 'meetingId') || null,
    sessionId: get('session-id', 'sessionId') || null,
    championshipId: get('championship-id', 'championshipId') || null,
    location: get('lieu', 'location') || null,
    year: get('annee', 'year') ?? null,
    category: get('categorie', 'category') || null,
    sessionType: get('type', 'sessionType') || null,
    sessionNum: get('num', 'sessionNum') ?? null,
    serie: get('serie', 'serieNum') ?? null,
  };
  identity.timecodeKey = identity.sessionType && identity.category
    ? timecodeKey(identity.sessionType, identity.sessionNum, identity.category)
    : null;

  const mode = String(get('mode') || 'precise').toLowerCase();
  if (!['precise', 'fast'].includes(mode)) fail(`--mode inconnu : « ${mode} ». Attendu « precise » ou « fast ».`);

  const baseName = String(get('nom', 'name') || '') || buildBaseName(identity) || `extrait_${youtubeId}`;
  const outDir = resolve(process.cwd(), String(get('sortie', 'outDir') || DEFAULT_OUT));

  return {
    url: String(url), youtubeId,
    sourceStart, sourceEnd, v1At,
    ...win,
    mode,
    origin: String(get('origin') || 'manual'),
    identity, baseName, outDir,
  };
}

// ─────────────────────────────────────────────────────────
// AFFICHAGES
// ─────────────────────────────────────────────────────────

function printRecipe(r) {
  console.log(`  ${C.bold(r.baseName)}`);
  console.log(`  video    ${r.youtubeId}`);
  console.log(`  plage    ${toHms(r.sourceStart)} -> ${toHms(r.sourceEnd)}  ${C.dim(`(${(r.sourceEnd - r.sourceStart).toFixed(1)} s utiles)`)}`);
  console.log(`  marges   -${r.padBefore} s / +${r.padAfter} s  ->  extrait ${toHms(r.clipStart)} -> ${toHms(r.clipEnd)}  ${C.dim(`(${r.clipDuration.toFixed(1)} s)`)}`);
  if (r.v1At != null) console.log(`  V1       ${toHms(r.v1At)}`);
  console.log(`  mode     ${r.mode === 'precise' ? "précis (coupe à l'image, réencodage de la seule fenêtre)" : 'rapide (copie, coupe sur image-clé)'}`);
}

function printTools(check) {
  for (const [name, t] of Object.entries(check.tools)) {
    console.log(t.path
      ? `  ${C.green('v')} ${name.padEnd(8)} ${t.version || '?'}  ${C.dim(t.path)}`
      : `  ${C.red('X')} ${name.padEnd(8)} introuvable`);
  }
  for (const w of check.warnings) console.log(`  ${C.yellow('!')} ${w}`);
}

// ─────────────────────────────────────────────────────────
// PROGRAMME
// ─────────────────────────────────────────────────────────

const args = parseArgv(process.argv.slice(2));

if (args.aide || args.help || args.h || process.argv.length <= 2) {
  console.log(AIDE);
  process.exit(0);
}

// `--dry-run` et `--plan-corpus` n'exécutent rien : ils restent utiles même
// sur une machine où yt-dlp n'est pas encore installé, typiquement pour
// préparer la commande avant de l'emporter sur le PC de course.
const SIMULE = Boolean(args['dry-run'] || args.dryRun || args['plan-corpus'] || args.planCorpus);

console.log(`\n${C.bold('-- Outils')}`);
const check = checkTools();
printTools(check);
if (!check.ok && !SIMULE) {
  console.error(`\n${C.red('X')} ${check.errors.join('\n\n  ')}\n`);
  process.exit(1);
}
if (args.verifier || args.check) {
  console.log(check.ok ? `\n${C.green('v')} outillage complet.\n` : `\n${C.red('X')} ${check.errors.join('\n\n  ')}\n`);
  process.exit(check.ok ? 0 : 1);
}

const recipe = buildRecipe(args);

console.log(`\n${C.bold('-- Recette')}`);
printRecipe(recipe);

const outputTemplate = join(recipe.outDir, `${recipe.baseName}.%(ext)s`);
const ytArgs = buildYtDlpArgs({
  url: recipe.url,
  window: { clipStart: recipe.clipStart, clipEnd: recipe.clipEnd },
  outputTemplate,
  mode: recipe.mode,
});

if (args['dry-run'] || args.dryRun) {
  console.log(`\n${C.bold('-- Commande (non exécutée)')}`);
  // Une seule ligne, sans caractère de continuation : copiable telle quelle
  // dans PowerShell comme dans un shell POSIX.
  const quoted = ytArgs.map(a => (/[\s*"&|<>^]/.test(a) ? `"${a}"` : a)).join(' ');
  console.log(`  yt-dlp ${quoted}\n`);
  process.exit(0);
}

if (args['plan-corpus'] || args.planCorpus) {
  // Planification seulement : aucune image n'est produite (EXTRACTION-YOUTUBE.md §13).
  const fps = Number(pick(args, 'fps')) || 50;
  const plan = planCorpusFrames({
    baseName: recipe.baseName, startAt: recipe.sourceStart, v1At: recipe.v1At,
    clipStart: recipe.clipStart, clipDuration: recipe.clipDuration, fps,
  });
  console.log(`\n${C.bold('-- Corpus prévu')} ${C.dim(`(${fps} img/s, aucune image produite)`)}`);
  if (!plan.length) console.log(`  ${C.yellow('!')} aucune zone : précise --v1 pour les zones du premier virage.`);
  for (const f of plan) {
    console.log(`  ${f.zone.padEnd(14)} ${toHms(f.absoluteTime)}  image ${String(f.clipFrame).padStart(5)}  ${C.dim(f.file)}`);
  }
  console.log('');
  process.exit(0);
}

mkdirSync(recipe.outDir, { recursive: true });
const outFile = join(recipe.outDir, `${recipe.baseName}.mp4`);
if (existsSync(outFile)) {
  // Écraser silencieusement un extrait déjà annoté serait la pire des surprises.
  fail(`« ${outFile} » existe déjà.\n  -> supprime-le, ou donne un autre nom avec --nom`);
}

console.log(`\n${C.bold('-- Extraction')} ${C.dim(sectionArg(recipe))}`);
console.log(C.dim('  (seule la plage demandée est téléchargée : yt-dlp passe par ffmpeg, qui seek en HTTP Range)'));

const started = Date.now();
const run = runTool(check.tools['yt-dlp'].path, ytArgs, { inherit: true });
const elapsed = (Date.now() - started) / 1000;

if (run.code !== 0) {
  const explained = explainFailure(run.stderr);
  console.error(`\n${C.red('X')} yt-dlp a échoué (code ${run.code}) après ${elapsed.toFixed(1)} s.`);
  if (explained) console.error(`\n  ${explained}`);
  else console.error(`\n${C.dim((run.stderr || '').trim().split(/\r?\n/).slice(-12).join('\n'))}`);
  console.error('');
  process.exit(1);
}
if (!existsSync(outFile)) {
  fail(`yt-dlp s'est terminé sans erreur mais « ${basename(outFile)} » est absent.\n  -> relance avec --dry-run et exécute la commande à la main pour voir sa sortie complète.`);
}

console.log(`\n${C.bold('-- Contrôle du fichier produit')}`);
const probe = probeFile(check.tools.ffprobe.path, outFile);
const verdict = checkProbe(probe, { expectedDuration: recipe.clipDuration });
const s = verdict.summary;

console.log(`  ${s.width}x${s.height} · ${s.codec}${s.profile ? ` (${s.profile})` : ''} · ${s.pixFmt} · ${C.bold(`${s.fps} img/s`)} · ${s.duration} s · ${s.frames ?? '?'} images`);
console.log(`  start_time ${s.startTime} · ${(statSync(outFile).size / 1048576).toFixed(1)} Mo · ${elapsed.toFixed(1)} s`);
for (const w of verdict.warnings) console.log(`  ${C.yellow('!')} ${w}`);
for (const e of verdict.errors) console.log(`  ${C.red('X')} ${e}`);

const sidecarFile = join(recipe.outDir, `${recipe.baseName}.json`);
writeFileSync(sidecarFile, `${JSON.stringify(buildSidecar({
  identity: recipe.identity,
  recipe: {
    youtubeId: recipe.youtubeId, url: recipe.url,
    sourceStart: recipe.sourceStart, sourceEnd: recipe.sourceEnd,
    padBefore: recipe.padBefore, padAfter: recipe.padAfter,
    clipStart: recipe.clipStart, clipDuration: recipe.clipDuration,
    v1At: recipe.v1At, origin: recipe.origin, mode: recipe.mode,
  },
  probe: { ...s, file: basename(outFile) },
  tool: {
    label: `yt-dlp ${check.tools['yt-dlp'].version} + ffmpeg ${check.tools.ffmpeg.version}`,
    command: [basename(check.tools['yt-dlp'].path), ...ytArgs],
  },
}), null, 2)}\n`, 'utf8');

if (!verdict.ok) {
  console.error(`\n${C.red('X')} le fichier ne respecte pas le profil attendu par le lecteur (EXTRACTION-YOUTUBE.md §5.2).`);
  console.error(`  Il est conservé pour inspection : ${outFile}\n`);
  process.exit(2);
}

console.log(`\n${C.green('v')} ${C.bold(basename(outFile))}`);
console.log(`  ${outFile}`);
console.log(`  ${C.dim(`sidecar ${basename(sidecarFile)} · schéma ${SCHEMA}`)}`);
console.log(`\n  Suite : Rallycross V2 -> Analyse des départs -> ${C.bold('Fichier local')} -> ce fichier.`);
console.log(`  ${C.dim(`t = 0 de l'extrait vaut ${toHms(recipe.clipStart)} de la retransmission (instant_youtube = ${recipe.clipStart} + t_local)`)}\n`);
