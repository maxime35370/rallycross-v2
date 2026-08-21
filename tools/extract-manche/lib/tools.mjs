/* ═══════════════════════════════════════════════
   TOOLS.MJS — Détection et exécution de yt-dlp / FFmpeg / ffprobe

   Tout ce qui lance un processus est ici ; toute la logique de décision est
   dans `recipe.mjs`, qui reste testable sans ces outils.

   Objectif de ce module : qu'un échec produise une phrase compréhensible et
   une action à faire, jamais une trace Python de 40 lignes.
═══════════════════════════════════════════════ */

import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** Commandes d'installation, affichées à l'utilisateur quand un outil manque. */
export const INSTALL_HINTS = {
  'yt-dlp': IS_WIN ? 'winget install yt-dlp.yt-dlp' : 'pipx install yt-dlp',
  ffmpeg:   IS_WIN ? 'winget install Gyan.FFmpeg'   : 'apt install ffmpeg',
  ffprobe:  IS_WIN ? 'winget install Gyan.FFmpeg'   : 'apt install ffmpeg',
};

// ─────────────────────────────────────────────────────────
// RÉSOLUTION DES EXÉCUTABLES
// ─────────────────────────────────────────────────────────

/**
 * Chemin absolu d'un exécutable, ou null.
 *
 * On résout nous-mêmes plutôt que de laisser `spawn` chercher dans le PATH :
 * sous Windows, Node refuse depuis la 18.20 de lancer un `.cmd`/`.bat` sans
 * shell, et `where` peut renvoyer plusieurs candidats. On privilégie donc
 * explicitement le `.exe`.
 */
export function resolveExe(name) {
  // Chemin imposé explicitement : FFMPEG_PATH, FFPROBE_PATH, YT_DLP_PATH.
  // Utile quand l'outil est installé hors du PATH — cas courant sous Windows.
  const forced = process.env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`];
  if (forced) return forced;

  const probe = IS_WIN
    ? spawnSync('where', [name], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return null;
  const candidates = probe.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.find(c => /\.exe$/i.test(c)) || candidates[0];
}

function quoteForCmd(arg) {
  // Guillemets doublés : convention de cmd.exe pour un « " » littéral.
  return `"${String(arg).replace(/"/g, '""')}"`;
}

/**
 * Exécute un outil et renvoie son code de sortie et ses flux.
 *
 * `shell` n'est utilisé que pour le cas très particulier d'un lanceur
 * `.cmd`/`.bat` sous Windows — jamais pour construire une commande à partir de
 * la saisie utilisateur.
 *
 * @param {string} exe — chemin absolu résolu par `resolveExe()`
 * @param {string[]} args
 * @param {{inherit?:boolean}} [opts] — `inherit` laisse yt-dlp écrire directement
 *        sur la console (utile pour suivre un téléchargement)
 */
export function runTool(exe, args, { inherit = false } = {}) {
  const common = {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  };
  const isBatch = IS_WIN && /\.(cmd|bat)$/i.test(exe);
  const res = isBatch
    ? spawnSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', [exe, ...args].map(quoteForCmd).join(' ')],
        { ...common, windowsVerbatimArguments: true })
    : spawnSync(exe, args, common);

  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
  };
}

// ─────────────────────────────────────────────────────────
// VERSIONS
// ─────────────────────────────────────────────────────────

/** « 2026.08.19 » → Date, ou null. */
export function ytDlpReleaseDate(version) {
  const m = String(version || '').match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Âge en jours d'une version de yt-dlp, ou null si illisible. */
export function ytDlpAgeDays(version, now = new Date()) {
  const d = ytDlpReleaseDate(version);
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

/**
 * Vérifie la présence et la version des trois outils.
 *
 * @returns {{ok:boolean, tools:object, errors:string[], warnings:string[]}}
 */
export function checkTools({ now = new Date(), staleAfterDays = 30 } = {}) {
  const errors = [];
  const warnings = [];
  const tools = {};

  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    const exe = resolveExe(name);
    if (!exe) {
      tools[name] = { path: null, version: null };
      errors.push(`${name} est introuvable dans le PATH. Installe-le puis rouvre le terminal :\n      ${INSTALL_HINTS[name]}`);
      continue;
    }
    const res = runTool(exe, ['-version']);
    // yt-dlp n'accepte que « --version » ; ffmpeg/ffprobe acceptent « -version ».
    const out = res.code === 0 ? res.stdout : runTool(exe, ['--version']).stdout;
    const version = name === 'yt-dlp'
      ? (out.trim().split(/\r?\n/)[0] || null)
      : ((out.match(/version\s+(\S+)/) || [])[1] || null);
    tools[name] = { path: exe, version };
  }

  const age = ytDlpAgeDays(tools['yt-dlp']?.version, now);
  if (age != null && age > staleAfterDays) {
    // Le risque n° 1 de la brique (EXTRACTION-YOUTUBE.md §10) : yt-dlp cesse de
    // fonctionner quand YouTube change son extracteur.
    warnings.push(`yt-dlp date de ${age} jours (${tools['yt-dlp'].version}). Avant un week-end de course : yt-dlp -U`);
  }

  return { ok: errors.length === 0, tools, errors, warnings };
}

// ─────────────────────────────────────────────────────────
// ffprobe
// ─────────────────────────────────────────────────────────

/** Sonde un fichier local et renvoie le JSON de ffprobe. */
export function probeFile(ffprobeExe, file) {
  const res = runTool(ffprobeExe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=codec_name,codec_type,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,start_time,nb_read_packets',
    '-show_entries', 'format=duration,start_time,size',
    '-of', 'json',
    file,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffprobe n'a pas pu lire « ${file} » :\n${(res.stderr || '').trim().split(/\r?\n/).slice(-5).join('\n')}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`sortie ffprobe illisible pour « ${file} »`);
  }
}

// ─────────────────────────────────────────────────────────
// DIAGNOSTIC D'ÉCHEC
// ─────────────────────────────────────────────────────────

/**
 * Traduit la sortie d'erreur de yt-dlp en une phrase actionnable.
 * Renvoie null si le motif n'est pas reconnu — l'appelant affiche alors la
 * fin brute de stderr, ce qui vaut mieux qu'un diagnostic inventé.
 */
export function explainFailure(stderr = '') {
  const s = String(stderr);
  const rules = [
    [/ffmpeg (?:is )?not (?:found|installed)|ffmpeg could not be found|You have requested merging/i,
      'FFmpeg est introuvable pour yt-dlp. --download-sections en dépend entièrement.\n  → ' + INSTALL_HINTS.ffmpeg],
    [/Sign in to confirm|not a bot|confirm your age/i,
      'YouTube demande une confirmation humaine pour cette lecture.\n  → réessaie plus tard, ou utilise --cookies-from-browser UNIQUEMENT pour du contenu auquel tu as normalement accès.'],
    [/Private video|members-only|This video is unavailable|Video unavailable/i,
      "La vidéo n'est pas accessible publiquement (privée, supprimée, réservée ou géo-bloquée).\n  → aucun contournement : vérifie l'URL, ou demande l'accès au titulaire des droits."],
    [/Requested format is not available/i,
      "Aucun format ne correspond au sélecteur demandé.\n  → relance avec --mode precise (il n'exige pas d'avc1), ou inspecte : yt-dlp -F <url>"],
    [/No supported JavaScript runtime|js.?runtime/i,
      "yt-dlp n'a pas de moteur JavaScript : la liste de formats sera tronquée et le débit bridé.\n  → si yt-dlp a été installé par pip : python -m pip install --upgrade yt-dlp-ejs"],
    [/nsig extraction failed|Some formats may be missing|player.*decrypt|Unable to download (?:API page|webpage)|HTTP Error 40[039]/i,
      "YouTube a probablement changé son extracteur, ou l'accès réseau est filtré.\n  → yt-dlp -U (ou winget upgrade yt-dlp.yt-dlp), puis relance."],
    [/Unable to connect to proxy|getaddrinfo|Network is unreachable|Temporary failure in name resolution|timed out/i,
      "Le réseau n'a pas pu joindre YouTube (proxy, pare-feu ou coupure).\n  → vérifie la connexion, puis relance."],
    [/No space left on device|espace insuffisant/i,
      "Plus d'espace disque disponible pour écrire l'extrait."],
  ];
  for (const [re, message] of rules) if (re.test(s)) return message;
  return null;
}
