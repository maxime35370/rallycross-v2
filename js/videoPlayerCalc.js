/* ═══════════════════════════════════════════════
   VIDEOPLAYERCALC.JS — Logique pure du lecteur vidéo

   Aucun accès au DOM, à Firebase, ni au réseau : uniquement des fonctions
   déterministes, testables sans navigateur.

   Deux responsabilités principales :
     • le temps  — formats, pas de navigation, image par image, cadence ;
     • la place  — projection du canvas d'overlay sur l'image réellement
                   affichée (letterbox), pour que les futures bounding boxes
                   tombent au bon endroit quelle que soit la taille du lecteur.
═══════════════════════════════════════════════ */

import { extractYoutubeId, extractYoutubeTimecode, timecodeKey } from './utils.js';

// ─────────────────────────────────────────────────────────
// SOURCES
// ─────────────────────────────────────────────────────────

/**
 * Reconnaît une source vidéo saisie par l'utilisateur.
 *
 * Un fichier local n'est jamais décrit ici : il n'a ni URL ni identifiant
 * stable, il est fourni directement par l'utilisateur via <input type=file>.
 *
 * @param {string} input — URL ou identifiant YouTube
 * @returns {{kind:'youtube', videoId:string, startAt:number|null}|null}
 */
export function parseVideoSource(input) {
  const videoId = extractYoutubeId(input);
  if (!videoId) return null;
  const tc = extractYoutubeTimecode(input);
  return { kind: 'youtube', videoId, startAt: tc?.seconds ?? null };
}

/**
 * Timecode de départ à utiliser à l'ouverture du lecteur, par ordre de
 * priorité décroissante :
 *   1. le timecode propre à CE départ, saisi lors d'une analyse précédente ;
 *   2. le timecode (session × catégorie) du meeting, déjà connu de V2 ;
 *   3. rien.
 *
 * La source est renvoyée pour pouvoir l'afficher : un timecode de meeting
 * pointe sur la PREMIÈRE série d'une manche, pas sur celle qu'on analyse.
 *
 * @param {object} p
 * @param {object|null} [p.analysisVideo] — bloc `video` de l'analyse enregistrée
 * @param {object|null} [p.meetingTimecodes] — `meeting.videoTimecodes`
 * @param {Array|null} [p.meetingVideos] — `meeting.videos` : le timecode ne
 *        porte qu'un identifiant LOCAL au meeting, c'est cette liste qui donne
 *        l'URL, donc l'identifiant YouTube.
 * @param {string} p.sessionType
 * @param {number|null} [p.sessionNum]
 * @param {string} p.category
 * @param {number} [p.startIndex] — 0 = première série de la session
 * @returns {{seconds:number|null, source:'start'|'meeting'|'none',
 *            youtubeId:string|null, approximate:boolean}}
 */
export function resolveStartTime({
  analysisVideo, meetingTimecodes, meetingVideos, sessionType, sessionNum,
  category, startIndex = 0,
}) {
  const own = Number(analysisVideo?.startAt);
  if (Number.isFinite(own) && own >= 0) {
    return {
      seconds: own,
      source: 'start',
      youtubeId: analysisVideo?.youtubeId || null,
      approximate: false,
    };
  }

  const key = timecodeKey(sessionType, sessionNum, category);
  const entry = meetingTimecodes?.[key];
  const seconds = Number(entry?.seconds ?? entry);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return {
      seconds,
      source: 'meeting',
      youtubeId: youtubeIdOfMeetingVideo(meetingVideos, entry?.videoId)
                 || analysisVideo?.youtubeId || null,
      // Le timecode du meeting vise le début de la session : il ne tombe
      // juste que sur la première série.
      approximate: startIndex > 0,
    };
  }

  return {
    seconds: null,
    source: 'none',
    youtubeId: analysisVideo?.youtubeId
      || youtubeIdOfMeetingVideo(meetingVideos, meetingTimecodes?.[key]?.videoId)
      || null,
    approximate: false,
  };
}

/**
 * Identifiant YouTube d'une vidéo de meeting, désignée par son id LOCAL.
 * `videoTimecodes[...].videoId` référence `meeting.videos[].id` — un uid interne,
 * jamais un identifiant YouTube : les confondre chargerait une vidéo au hasard.
 *
 * @param {Array|null} meetingVideos
 * @param {string|null} localVideoId
 * @returns {string|null}
 */
export function youtubeIdOfMeetingVideo(meetingVideos, localVideoId) {
  if (!Array.isArray(meetingVideos) || !localVideoId) return null;
  const v = meetingVideos.find(x => x?.id === localVideoId);
  return v ? extractYoutubeId(v.url) : null;
}

// ─────────────────────────────────────────────────────────
// TEMPS
// ─────────────────────────────────────────────────────────

/** Cadences courantes, pour recaler une mesure bruitée sur une valeur réelle. */
export const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export const DEFAULT_FPS = 25;

/**
 * Estime la cadence d'une vidéo à partir d'écarts entre images successives
 * (fournis par requestVideoFrameCallback). La médiane résiste aux images
 * doublées ou sautées, contrairement à la moyenne.
 *
 * @param {number[]} deltas — écarts en secondes entre images consécutives
 * @returns {number|null} cadence recalée sur une valeur standard, ou null
 */
export function estimateFps(deltas = []) {
  const usable = deltas.filter(d => Number.isFinite(d) && d > 0.001 && d < 0.5).sort((a, b) => a - b);
  if (usable.length < 3) return null;
  const mid = Math.floor(usable.length / 2);
  const median = usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
  const raw = 1 / median;
  // Recale sur la cadence standard la plus proche si l'écart reste sous 5 %.
  let best = null, bestGap = Infinity;
  for (const f of COMMON_FPS) {
    const gap = Math.abs(f - raw) / f;
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  return bestGap <= 0.05 ? best : Math.round(raw * 1000) / 1000;
}

/** Durée d'une image, en secondes. */
export function frameDuration(fps) {
  const f = Number(fps);
  return Number.isFinite(f) && f > 0 ? 1 / f : 1 / DEFAULT_FPS;
}

export function clampTime(t, duration) {
  const v = Number(t);
  if (!Number.isFinite(v)) return 0;
  const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(v, 0), max);
}

/** Pas de navigation, du plus fin au plus large. */
export const STEP_MODES = {
  frame:  null,   // = 1 / fps, calculé
  small:  0.2,
  medium: 1,
  large:  5,
};

/**
 * Nouvelle position après un déplacement.
 *
 * @param {number} current — position actuelle en secondes
 * @param {{direction:number, mode?:string, fps?:number, duration?:number}} p
 *        direction : +1 (avance) ou -1 (recul)
 * @returns {number} position bornée à [0, duration]
 */
export function stepTime(current, { direction, mode = 'medium', fps = DEFAULT_FPS, duration } = {}) {
  const dir = direction < 0 ? -1 : 1;
  const delta = mode === 'frame' ? frameDuration(fps) : (STEP_MODES[mode] ?? STEP_MODES.medium);
  return clampTime(Number(current || 0) + dir * delta, duration);
}

/**
 * Numéro d'image correspondant à un instant. Toujours arrondi vers le bas :
 * c'est l'image AFFICHÉE à cet instant.
 */
export function frameOf(seconds, fps = DEFAULT_FPS) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return 0;
  return Math.floor(s * (Number(fps) > 0 ? Number(fps) : DEFAULT_FPS) + 1e-6);
}

/**
 * Timecode lisible et précis.
 *   formatPreciseTime(83.456)                    → "1:23.456"
 *   formatPreciseTime(3723.4, {fps:25, frames:true}) → "1:02:03.400 (f93085)"
 *
 * @param {number} seconds
 * @param {{fps?:number, frames?:boolean}} [opts]
 * @returns {string}
 */
export function formatPreciseTime(seconds, { fps = DEFAULT_FPS, frames = false } = {}) {
  if (seconds == null || seconds === '') return '—';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const total = Math.floor(s);
  const ms = Math.round((s - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const base = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return frames ? `${base} (f${frameOf(s, fps)})` : base;
}

/**
 * Lit un timecode précis « H:MM:SS.mmm », « M:SS.mmm », « SS.mmm » ou « SS ».
 * Renvoie null si la chaîne n'est pas un timecode valide — jamais 0 par défaut,
 * pour ne pas transformer une faute de frappe en « début de la vidéo ».
 *
 * @param {string} str
 * @returns {number|null} secondes
 */
export function parsePreciseTime(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const m = s.match(/^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, a, b, c, frac] = m;
  // « 1:02:03 » → a=1 b=02 c=03 ; « 2:03 » → a=2 b=undefined c=03
  const h = b != null ? Number(a) : 0;
  const min = b != null ? Number(b) : (a != null ? Number(a) : 0);
  const sec = Number(c);
  if (min > 59 || (b != null && sec > 59)) return null;
  if (b == null && a != null && sec > 59) return null;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

// ─────────────────────────────────────────────────────────
// VITESSES DE LECTURE
// ─────────────────────────────────────────────────────────

/** YouTube n'accepte que ces vitesses : en imposer d'autres est sans effet. */
export const YOUTUBE_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2];

/** Un <video> local accepte n'importe quelle vitesse : on descend plus bas. */
export const LOCAL_RATES = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2];

export function ratesFor(kind) {
  return kind === 'youtube' ? YOUTUBE_RATES : LOCAL_RATES;
}

/**
 * Vitesse voisine dans la liste, sans jamais sortir des bornes.
 * @param {number[]} rates
 * @param {number} current
 * @param {number} direction — +1 plus rapide, -1 plus lent
 */
export function nextRate(rates, current, direction) {
  const list = Array.isArray(rates) && rates.length ? rates : LOCAL_RATES;
  // La vitesse courante peut ne pas figurer dans la liste (source changée) :
  // on repart de la plus proche.
  let idx = 0, gap = Infinity;
  list.forEach((r, i) => { const g = Math.abs(r - current); if (g < gap) { gap = g; idx = i; } });
  const next = idx + (direction < 0 ? -1 : 1);
  return list[Math.min(Math.max(next, 0), list.length - 1)];
}

// ─────────────────────────────────────────────────────────
// GÉOMÉTRIE DE L'OVERLAY
// ─────────────────────────────────────────────────────────

/**
 * Rectangle réellement occupé par l'image à l'intérieur du conteneur, en
 * `object-fit: contain` : c'est la zone utile, hors bandes noires.
 *
 * C'est LA fonction qui garantit l'alignement du canvas : elle ne dépend que
 * de quatre nombres, donc elle se teste sans navigateur et reste juste au
 * redimensionnement, en plein écran et à tout changement de ratio.
 *
 * @param {number} containerW
 * @param {number} containerH
 * @param {number} videoW — largeur intrinsèque de la vidéo
 * @param {number} videoH
 * @returns {{x:number, y:number, width:number, height:number, scale:number}}
 */
export function computeVideoRect(containerW, containerH, videoW, videoH) {
  const cw = Number(containerW), ch = Number(containerH);
  const vw = Number(videoW), vh = Number(videoH);
  if (![cw, ch, vw, vh].every(v => Number.isFinite(v) && v > 0)) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(cw / vw, ch / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { x: (cw - width) / 2, y: (ch - height) / 2, width, height, scale };
}

/**
 * Boîte normalisée (0..1, repère de l'image) → pixels du canvas.
 * @param {{x:number,y:number,width:number,height:number}} box
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
export function projectBox(box, rect) {
  return {
    x: rect.x + box.x * rect.width,
    y: rect.y + box.y * rect.height,
    width: box.width * rect.width,
    height: box.height * rect.height,
  };
}

/** Opération inverse : pixels du canvas → boîte normalisée. */
export function normalizeBox(pixelBox, rect) {
  if (!rect.width || !rect.height) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: (pixelBox.x - rect.x) / rect.width,
    y: (pixelBox.y - rect.y) / rect.height,
    width: pixelBox.width / rect.width,
    height: pixelBox.height / rect.height,
  };
}

/** Statuts d'une boîte et couleur associée — le vocabulaire du futur tracking. */
export const BOX_STATUS_COLORS = {
  confirmed: '#2ecc71',   // identité certaine
  probable:  '#f1c40f',   // proposition à confirmer
  unknown:   '#95a5a6',   // véhicule détecté, non identifié
  lost:      '#e74c3c',   // piste perdue
};

export const BOX_STATUS_ICONS = {
  confirmed: '🟢', probable: '🟡', unknown: '⚪', lost: '🔴',
};

/**
 * Nettoie une liste de boîtes avant dessin : coordonnées normalisées, bornées
 * à l'image, statut connu. Une boîte invalide est écartée plutôt que dessinée
 * n'importe où — c'est la même règle que pour les positions : on n'invente rien.
 *
 * @param {Array<object>} boxes
 * @returns {Array<object>} boîtes utilisables
 */
export function sanitizeBoxes(boxes = []) {
  const out = [];
  for (const b of boxes) {
    if (!b) continue;
    const x = Number(b.x), y = Number(b.y);
    const w = Number(b.width), h = Number(b.height);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (w <= 0 || h <= 0) continue;
    if (x > 1 || y > 1 || x + w < 0 || y + h < 0) continue;   // hors image
    const cx = Math.min(Math.max(x, 0), 1);
    const cy = Math.min(Math.max(y, 0), 1);
    out.push({
      driverId: b.driverId ?? null,
      carNumber: b.carNumber ?? null,
      label: b.label ?? null,
      confidence: Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : null,
      status: BOX_STATUS_COLORS[b.status] ? b.status : 'unknown',
      x: cx,
      y: cy,
      width: Math.min(w, 1 - cx),
      height: Math.min(h, 1 - cy),
    });
  }
  return out;
}

/**
 * Texte affiché au-dessus d'une boîte : « #12 DUPONT 🟢 ».
 * @param {object} box
 * @returns {string}
 */
export function boxLabelText(box) {
  const parts = [];
  if (box.carNumber != null) parts.push(`#${box.carNumber}`);
  if (box.label) parts.push(String(box.label));
  const icon = BOX_STATUS_ICONS[box.status] || BOX_STATUS_ICONS.unknown;
  const conf = box.status === 'probable' && box.confidence != null
    ? ` ${Math.round(box.confidence * 100)}%`
    : '';
  return `${parts.join(' ')}${parts.length ? ' ' : ''}${icon}${conf}`.trim();
}

// ─────────────────────────────────────────────────────────
// CLAVIER
// ─────────────────────────────────────────────────────────

/**
 * Traduit une frappe en action du lecteur. Renvoie null si la touche n'est pas
 * un raccourci ou si l'utilisateur est en train de saisir du texte : on ne
 * détourne jamais une frappe destinée à un champ.
 *
 * @param {{key:string, shiftKey?:boolean, altKey?:boolean, ctrlKey?:boolean,
 *          metaKey?:boolean, target?:object}} e
 * @returns {string|null}
 */
export function keyboardAction(e) {
  if (!e || typeof e.key !== 'string') return null;
  if (e.ctrlKey || e.metaKey) return null;

  const tag = String(e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
    return null;
  }

  const k = e.key;
  if (k === ' ' || k === 'Spacebar') return 'togglePlay';
  if (k === 'ArrowLeft')  return e.altKey ? 'framePrev' : (e.shiftKey ? 'jumpBack'    : 'stepBack');
  if (k === 'ArrowRight') return e.altKey ? 'frameNext' : (e.shiftKey ? 'jumpForward' : 'stepForward');
  if (k === ',') return 'framePrev';
  if (k === '.') return 'frameNext';
  if (k === 'ArrowDown' || k === '-') return 'slower';
  if (k === 'ArrowUp'   || k === '+' || k === '=') return 'faster';

  const lower = k.toLowerCase();
  if (lower === 'v') return 'markTurn1';
  if (lower === 'd') return 'markStart';
  if (lower === 'n') return 'nextStart';
  if (lower === 'p') return 'prevStart';
  if (lower === 'f') return 'fullscreen';
  return null;
}

/** Correspondance action → geste concret, pour l'aide affichée à l'écran. */
export const SHORTCUT_HELP = [
  ['Espace', 'Lecture / pause'],
  ['← →', '± 1 s'],
  ['⇧ ← →', '± 5 s'],
  ['⌥ ← → ou , .', 'Image précédente / suivante'],
  ['↑ ↓', 'Vitesse de lecture'],
  ['V', 'Marquer l\'image du 1er virage'],
  ['D', 'Marquer l\'instant du départ'],
  ['N / P', 'Départ suivant / précédent'],
];

// ─────────────────────────────────────────────────────────
// NAVIGATION ENTRE DÉPARTS
// ─────────────────────────────────────────────────────────

/**
 * Identifiant du départ voisin dans la liste. Ne boucle pas : arrivé au
 * dernier départ, il n'y a pas de suivant — c'est une information utile
 * (la catégorie est terminée), pas une gêne.
 *
 * @param {string[]} ids — dans l'ordre d'affichage
 * @param {string} currentId
 * @param {number} direction — +1 suivant, -1 précédent
 * @returns {string|null}
 */
export function neighbourStartId(ids = [], currentId, direction = 1) {
  const i = ids.indexOf(currentId);
  if (i < 0) return ids.length ? ids[0] : null;
  const j = i + (direction < 0 ? -1 : 1);
  return j >= 0 && j < ids.length ? ids[j] : null;
}

/**
 * Bloc `video` à enregistrer sur l'analyse d'un départ.
 * Un fichier local n'est jamais téléversé : seul son NOM est conservé, pour
 * pouvoir rouvrir le bon fichier plus tard.
 *
 * @param {object} p
 * @returns {object|null} null si rien de significatif à enregistrer
 */
export function buildVideoBlock({ kind, youtubeId, fileName, startAt, turn1At, fps } = {}) {
  const clean = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(Number(v).toFixed(3)) : null);
  const block = {
    kind: kind === 'youtube' || kind === 'file' ? kind : null,
    youtubeId: youtubeId || null,
    fileName: fileName || null,
    startAt: clean(startAt),
    turn1At: clean(turn1At),
    fps: Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : null,
  };
  const meaningful = block.kind || block.youtubeId || block.fileName
    || block.startAt != null || block.turn1At != null;
  return meaningful ? block : null;
}
