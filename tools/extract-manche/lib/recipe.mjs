/* ═══════════════════════════════════════════════
   RECIPE.MJS — Logique pure de l'extraction de manche

   Aucun accès au disque, au réseau ni à un processus : uniquement des
   fonctions déterministes, testables sans yt-dlp, sans FFmpeg et sans YouTube
   (`tests/extractManche.test.js`). Tout ce qui exécute quelque chose vit dans
   `tools.mjs`, tout ce qui décide vit ici.

   La « recette » est le seul artefact durable de la brique d'extraction
   (cf. docs/video-analysis/EXTRACTION-YOUTUBE.md §7.3) : le MP4 est un fichier
   de travail jetable, la recette permet de le régénérer à l'identique.
═══════════════════════════════════════════════ */

import { parsePreciseTime } from '../../../js/videoPlayerCalc.js';

export const SCHEMA = 'rx-extract/1';

/** Marges par défaut, en secondes (EXTRACTION-YOUTUBE.md §2.4).
 *  Le « +6 » couvre le franchissement du premier virage, qui est la donnée
 *  réellement recherchée par l'analyse. */
export const DEFAULT_PAD_BEFORE = 3;
export const DEFAULT_PAD_AFTER  = 6;

// ─────────────────────────────────────────────────────────
// TEMPS
// ─────────────────────────────────────────────────────────

/**
 * Lit un instant saisi par l'utilisateur : « 05:42:26 », « 5:42:26.480 »,
 * « 42:26 » ou un nombre de secondes.
 *
 * Renvoie null plutôt que 0 sur une entrée invalide — une faute de frappe ne
 * doit jamais se transformer silencieusement en « début de la vidéo ».
 *
 * @param {string|number} value
 * @returns {number|null} secondes
 */
export function parseTimeInput(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = String(value).trim();
  // Un nombre nu (« 20546 », « 20546.48 ») n'est pas un timecode « M:SS » :
  // parsePreciseTime le lirait comme des secondes, ce qui est bien ce qu'on veut,
  // mais il refuse au-delà de 59. On le traite donc à part.
  if (/^\d+(?:[.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  return parsePreciseTime(s);
}

/**
 * Timecode « H:MM:SS.mmm » accepté tel quel par `--download-sections` de
 * yt-dlp (vérifié sur son parseur : `parse_duration('5:42:23.480') → 20543.48`).
 */
export function toHms(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(s);
  const ms = Math.round((s - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Fenêtre réellement extraite, marges comprises.
 *
 * Les marges sont des champs explicites et le restent jusque dans le sidecar :
 * sans cela, on ne saurait plus trois mois après si `05:42:23` est le départ
 * ou le départ moins trois secondes (EXTRACTION-YOUTUBE.md §2.4).
 *
 * @returns {{clipStart:number, clipEnd:number, clipDuration:number,
 *            padBefore:number, padAfter:number}}
 */
export function buildWindow({ sourceStart, sourceEnd, padBefore = DEFAULT_PAD_BEFORE, padAfter = DEFAULT_PAD_AFTER }) {
  // `Number(null)` vaut 0 : sans ce garde-fou, une borne absente deviendrait
  // silencieusement « début de la vidéo ».
  const num = v => (v == null || v === '' ? NaN : Number(v));
  const start = num(sourceStart);
  const end = num(sourceEnd);
  if (!Number.isFinite(start) || start < 0) throw new Error('début invalide');
  if (!Number.isFinite(end) || end < 0) throw new Error('fin invalide');
  if (end <= start) throw new Error(`la fin (${toHms(end)}) doit être après le début (${toHms(start)})`);

  const pb = Math.max(0, Number(padBefore) || 0);
  const pa = Math.max(0, Number(padAfter) || 0);
  // Une marge amont plus grande que le début de la vidéo est tronquée, et la
  // marge effectivement appliquée est renvoyée : le sidecar doit décrire ce qui
  // s'est passé, pas ce qui avait été demandé.
  const clipStart = Math.max(0, start - pb);
  const clipEnd = end + pa;
  return {
    clipStart,
    clipEnd,
    clipDuration: Number((clipEnd - clipStart).toFixed(3)),
    padBefore: Number((start - clipStart).toFixed(3)),
    padAfter: Number(pa.toFixed(3)),
  };
}

/** Argument `--download-sections` correspondant à une fenêtre. */
export function sectionArg({ clipStart, clipEnd }) {
  return `*${toHms(clipStart)}-${toHms(clipEnd)}`;
}

// ─────────────────────────────────────────────────────────
// NOMMAGE
// ─────────────────────────────────────────────────────────

/** Même normalisation que `timecodeKey()` dans js/utils.js : accents retirés,
 *  tout ce qui n'est pas alphanumérique remplacé par « _ ». */
export function slug(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Libellé humain d'une session. Le dépôt stocke `type ∈ EC|MQ|QF|DF|FIN`
 * (cf. collection `sessions`) mais l'usage courant sur le terrain parle de
 * « Q3 » pour la troisième manche qualificative : le nom de fichier suit
 * l'usage, le sidecar conserve les valeurs brutes.
 */
export function sessionLabel(sessionType, sessionNum) {
  const t = String(sessionType || '').toUpperCase();
  const n = Number.isFinite(Number(sessionNum)) && Number(sessionNum) > 0 ? Number(sessionNum) : null;
  if (t === 'MQ') return n ? `Q${n}` : 'Q';
  if (t === 'FIN') return 'FIN';
  return n ? `${t}${n}` : (t || 'SESSION');
}

/**
 * Nom de base d'un extrait : `Kerlabo_2026_D3_Q3_S4`.
 * Lisible par un humain, mais JAMAIS la source de vérité — un nom se renomme,
 * se tronque et ne peut pas porter `meetingId` (EXTRACTION-YOUTUBE.md §7.1).
 */
export function buildBaseName({ location, year, category, sessionType, sessionNum, serie }) {
  const parts = [
    slug(location) || 'Meeting',
    Number.isFinite(Number(year)) ? String(Number(year)) : null,
    slug(category) || null,
    slug(sessionLabel(sessionType, sessionNum)),
    Number.isFinite(Number(serie)) && Number(serie) > 0 ? `S${Number(serie)}` : null,
  ].filter(Boolean);
  return parts.join('_');
}

// ─────────────────────────────────────────────────────────
// LIGNE DE COMMANDE yt-dlp
// ─────────────────────────────────────────────────────────

/** Options ffmpeg de sortie du mode précis. Injectées via `--downloader-args
 *  ffmpeg_o:` — elles ne sont réellement effectives que parce que
 *  `--force-keyframes-at-cuts` supprime le `-c copy` que yt-dlp ajouterait
 *  sinon AVANT elles (EXTRACTION-YOUTUBE.md §1.3). */
export const FFMPEG_OUT_ARGS = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-g', '10',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
].join(' ');

/** Sélecteur de format. En mode précis on réencode de toute façon : inutile
 *  d'exiger de l'avc1 en entrée, ce qui ferait échouer une vidéo servie
 *  uniquement en VP9/AV1. En mode rapide au contraire, la copie impose l'avc1. */
export function formatSelector(mode) {
  return mode === 'fast'
    ? 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4]'
    : 'bv*[height<=1080]+ba/b';
}

/**
 * Arguments exacts passés à yt-dlp. Fonction pure : c'est elle qu'on teste,
 * et c'est elle que `--dry-run` affiche.
 *
 * @param {object} p
 * @param {string} p.url
 * @param {{clipStart:number, clipEnd:number}} p.window
 * @param {string} p.outputTemplate — chemin complet, extension en `%(ext)s`
 * @param {'precise'|'fast'} [p.mode]
 * @returns {string[]}
 */
export function buildYtDlpArgs({ url, window: win, outputTemplate, mode = 'precise' }) {
  if (!url) throw new Error('URL manquante');
  const args = [
    url,
    '--no-playlist',            // une URL peut porter « &list=… » : on ne veut qu'elle
    '--no-progress',
    '--no-warnings',
    '-f', formatSelector(mode),
    '--download-sections', sectionArg(win),
  ];
  if (mode === 'precise') {
    args.push('--force-keyframes-at-cuts');
    args.push('--downloader-args', `ffmpeg_o:${FFMPEG_OUT_ARGS}`);
  }
  args.push('--merge-output-format', 'mp4');
  args.push('-o', outputTemplate);
  return args;
}

// ─────────────────────────────────────────────────────────
// CONTRÔLE DU FICHIER PRODUIT
// ─────────────────────────────────────────────────────────

/** « 50/1 » → 50 ; « 30000/1001 » → 29.97. Arrondi à 3 décimales, comme
 *  `estimateFps()` qui recale sur des valeurs standard : les deux sources de
 *  cadence doivent donner le même nombre, sinon l'affichage sautera. */
export function parseRational(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m = s.match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] == null ? 1 : Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const v = num / den;
  return Number.isFinite(v) && v > 0 ? Number(v.toFixed(3)) : null;
}

/**
 * Vérifie la sortie de ffprobe contre le profil exigé par `videoPlayer.js`
 * (EXTRACTION-YOUTUBE.md §5.2). Fonction pure : testée sur des JSON figés,
 * sans avoir besoin de FFmpeg.
 *
 * Distingue volontairement deux niveaux :
 *   • `errors`   — le fichier ne sera pas exploitable par le lecteur ;
 *   • `warnings` — exploitable, mais à surveiller (cadence variable, durée).
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], summary:object}}
 */
export function checkProbe(probe, { expectedDuration } = {}) {
  const errors = [];
  const warnings = [];
  const stream = (probe?.streams || []).find(s => s.codec_type === 'video') || (probe?.streams || [])[0] || {};
  const format = probe?.format || {};

  const fps = parseRational(stream.r_frame_rate);
  const avgFps = parseRational(stream.avg_frame_rate);
  const startTime = Number(format.start_time ?? stream.start_time ?? 0);
  const duration = Number(format.duration ?? stream.duration ?? 0);
  const frames = Number(stream.nb_read_packets ?? stream.nb_frames ?? 0) || null;

  if (!stream.codec_name) {
    errors.push('aucun flux vidéo trouvé dans le fichier produit');
  } else if (stream.codec_name !== 'h264') {
    errors.push(`codec vidéo « ${stream.codec_name} » au lieu de h264 : <video> risque de ne pas le lire`);
  }
  if (stream.pix_fmt && stream.pix_fmt !== 'yuv420p') {
    // Un flux 10 bits (yuv420p10le, issu de VP9 profil 2) donne un <video> noir.
    errors.push(`format de pixels « ${stream.pix_fmt} » au lieu de yuv420p : image probablement noire dans le navigateur`);
  }
  if (!Number.isFinite(fps) || !fps) {
    errors.push('cadence illisible : le pas image par image serait faux');
  }
  if (Math.abs(startTime) > 0.001) {
    errors.push(`start_time = ${startTime} au lieu de 0 : les numéros d'image seraient décalés`);
  }
  if (fps && avgFps && Math.abs(fps - avgFps) / fps > 0.01) {
    warnings.push(`cadence variable (r_frame_rate ${fps} ≠ avg_frame_rate ${avgFps}) : le pas image par image peut dériver`);
  }
  if (expectedDuration && duration && Math.abs(duration - expectedDuration) > 0.5) {
    warnings.push(`durée ${duration.toFixed(2)} s au lieu de ${expectedDuration.toFixed(2)} s attendues`);
  }
  if (!duration) {
    errors.push('durée nulle ou illisible : le fichier est probablement tronqué');
  }
  // Une coupe en copie (`-c copy`) conserve les images situées entre l'image-clé
  // précédente et l'instant demandé : elles sont écrites avec des timestamps
  // NÉGATIFS et un drapeau « discard », et c'est l'edit list du MP4 qui les
  // masque. Mesuré : 2750 paquets pour 53 s à 50 img/s, soit 100 images de
  // pré-roll. Un lecteur qui ignore l'edit list les affiche, et toute la
  // chronologie glisse alors de 2 s sans que rien ne le signale.
  if (frames && fps && duration) {
    const expectedFrames = Math.round(duration * fps);
    if (frames - expectedFrames > 1) {
      warnings.push(`${frames - expectedFrames} images de pré-roll (timestamps négatifs) : la position dépend de la prise en charge des edit lists par le lecteur. Le mode « precise » n'en produit aucune.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      codec: stream.codec_name || null,
      profile: stream.profile || null,
      pixFmt: stream.pix_fmt || null,
      width: Number(stream.width) || null,
      height: Number(stream.height) || null,
      fps,
      avgFps,
      startTime: Number.isFinite(startTime) ? startTime : null,
      duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      frames,
      sizeBytes: Number(format.size) || null,
    },
  };
}

// ─────────────────────────────────────────────────────────
// SIDECAR
// ─────────────────────────────────────────────────────────

/**
 * Sidecar `rx-extract/1` (EXTRACTION-YOUTUBE.md §7.2).
 *
 * Il porte trois choses distinctes, à ne pas confondre :
 *   1. l'IDENTITÉ de la manche (clés Firestore réelles) ;
 *   2. la RECETTE (URL + bornes + marges) — régénère le fichier à l'identique ;
 *   3. le CONSTAT (ce que ffprobe a mesuré sur le fichier produit).
 */
export function buildSidecar({ identity = {}, recipe = {}, probe = {}, tool = {}, createdAt }) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    schema: SCHEMA,

    // 1 · identité
    meetingId: identity.meetingId || null,
    sessionId: identity.sessionId || null,
    championshipId: identity.championshipId || null,
    location: identity.location || null,
    year: num(identity.year),
    category: identity.category || null,
    sessionType: identity.sessionType || null,
    sessionNum: num(identity.sessionNum),
    serie: num(identity.serie),
    timecodeKey: identity.timecodeKey || null,

    // 2 · recette
    youtubeId: recipe.youtubeId || null,
    url: recipe.url || null,
    sourceStart: num(recipe.sourceStart),
    sourceEnd: num(recipe.sourceEnd),
    padBefore: num(recipe.padBefore),
    padAfter: num(recipe.padAfter),
    clipStart: num(recipe.clipStart),
    clipDuration: num(recipe.clipDuration),
    // Instant d'abord du premier virage. Correspond à `video.turn1At` côté
    // application, et sert de second repère au corpus YOLOX (§13.2).
    v1At: num(recipe.v1At),
    origin: recipe.origin || 'manual',
    mode: recipe.mode || 'precise',

    // 3 · constat
    file: probe.file || null,
    fps: num(probe.fps),
    width: num(probe.width),
    height: num(probe.height),
    codec: probe.codec || null,
    startTime: num(probe.startTime),
    duration: num(probe.duration),
    frames: num(probe.frames),
    sizeBytes: num(probe.sizeBytes),

    tool: tool.label || null,
    command: Array.isArray(tool.command) ? tool.command : null,
    createdAt: createdAt || new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────
// CORPUS YOLOX — planification seulement (§13)
// ─────────────────────────────────────────────────────────

/**
 * Profil de capture par défaut (EXTRACTION-YOUTUBE.md §13.2).
 *
 * `from` désigne le repère (`start` = départ, `v1` = abord du premier virage),
 * `offset` le décalage en secondes. C'est une DONNÉE, pas du code : les
 * distances départ → V1 diffèrent d'un circuit à l'autre.
 */
export const DEFAULT_CORPUS_PROFILE = [
  { zone: 'depart',       from: 'start', offset: 0.0 },
  { zone: 'acceleration', from: 'start', offset: 1.5 },
  { zone: 'approche_v1',  from: 'v1',    offset: -1.5 },
  { zone: 'entree_v1',    from: 'v1',    offset: 0.0 },
  { zone: 'milieu_v1',    from: 'v1',    offset: 1.0 },
  { zone: 'sortie_v1',    from: 'v1',    offset: 2.5 },
];

/**
 * Plan des images du corpus. NE CAPTURE RIEN : renvoie seulement quels
 * instants seraient extraits, pour que l'étape suivante n'ait plus qu'à les
 * découper. Chaque instant est calé sur un NUMÉRO D'IMAGE (§13.3) : même
 * commande → même image, condition pour comparer YOLOX-tiny et YOLOX-s
 * « sur exactement les mêmes images ».
 *
 * @returns {Array<{zone:string, absoluteTime:number, clipTime:number,
 *                  clipFrame:number, file:string}>}
 */
export function planCorpusFrames({ baseName, startAt, v1At, clipStart, clipDuration, fps, profile = DEFAULT_CORPUS_PROFILE }) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) throw new Error('cadence inconnue : impossible de caler les images du corpus');
  const anchors = { start: Number(startAt), v1: Number(v1At) };
  const out = [];

  for (const step of profile) {
    const anchor = anchors[step.from];
    if (!Number.isFinite(anchor)) continue;          // repère absent → zone ignorée
    const absolute = anchor + Number(step.offset || 0);
    const clipTime = absolute - Number(clipStart);
    // Hors de l'extrait : mieux vaut sauter la zone que produire une image noire.
    if (clipTime < 0 || (Number.isFinite(clipDuration) && clipTime > clipDuration)) continue;
    const clipFrame = Math.round(clipTime * f);
    const exactTime = Number((clipFrame / f).toFixed(3));
    out.push({
      zone: step.zone,
      absoluteTime: Number((Number(clipStart) + exactTime).toFixed(3)),
      clipTime: exactTime,
      clipFrame,
      file: frameFileName(baseName, step.zone, Number(clipStart) + exactTime, clipFrame),
    });
  }
  return out;
}

/** `Kerlabo_2026_D3_Q3_S4__entree_v1__t20551.480__f1027.png` (§13.3). */
export function frameFileName(baseName, zone, absoluteTime, clipFrame) {
  return `${baseName}__${slug(zone)}__t${Number(absoluteTime).toFixed(3)}__f${clipFrame}.png`;
}
