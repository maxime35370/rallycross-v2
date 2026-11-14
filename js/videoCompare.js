/* ═══════════════════════════════════════════════
   VIDEOCOMPARE.JS — Comparateur de deux vidéos côte à côte

   Analyse en parallèle de deux courses (ex. deux séries) :
     • chaque vidéo a son propre instant de départ, réglé séparément ;
     • un seul bouton Lecture/Pause pilote les deux ;
     • « Reculer » / « Avancer » déplacent les DEUX du même delta, chacune
       depuis sa position actuelle (revoir la procédure de départ).

   Réutilise le composant createVideoPlayer (YouTube ou fichier local).
   La logique pure (parse / format / delta) est dans videoCompareCalc.js.
═══════════════════════════════════════════════ */

import { createVideoPlayer } from './videoPlayer.js';
import { parseVideoSource } from './videoPlayerCalc.js';
import { escHtml } from './utils.js';
import {
  parseStartTime, formatStartTime, shiftedTime, DELTAS, RATES, DEFAULT_DELTA,
} from './videoCompareCalc.js';

const SIDES = ['a', 'b'];
const LABELS = { a: 'Vidéo A', b: 'Vidéo B' };

let _initialised = false;
let playing = false;          // intention globale (bouton Lecture/Pause)
const sides = {};             // côté → { player, start, freeze }

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function panelHtml(k) {
  return `
    <section class="vc-panel" data-side="${k}">
      <h3 class="vc-title">${escHtml(LABELS[k])}</h3>
      <div class="vc-host" id="vc-host-${k}"></div>

      <div class="vc-row">
        <input type="text" class="vp-url" id="vc-url-${k}"
               placeholder="Lien YouTube (https://youtu.be/…)" aria-label="Lien ${escHtml(LABELS[k])}">
        <button class="vp-btn vp-btn--primary" id="vc-load-${k}">Charger</button>
        <label class="vp-btn vp-file-label">📁 Fichier
          <input type="file" id="vc-file-${k}" accept="video/*">
        </label>
      </div>

      <div class="vc-row">
        <label class="vc-lbl" for="vc-start-${k}">Départ</label>
        <input type="text" class="vc-time" id="vc-start-${k}" value="0:00" inputmode="decimal"
               aria-label="Instant de départ ${escHtml(LABELS[k])}">
        <button class="vp-btn" id="vc-go-${k}">Aller au départ</button>
        <button class="vp-btn vp-btn--mark" id="vc-mark-${k}" title="Prendre l'instant actuel comme départ">⏱ Départ ici</button>
        <span class="vc-cur vp-time" id="vc-cur-${k}">0:00.0</span>
      </div>

      <div class="vc-row">
        <span class="vc-lbl">Ajuster le départ</span>
        ${[-5, -1, -0.1, 0.1, 1, 5].map(d =>
          `<button class="vp-btn vc-nudge" data-side="${k}" data-d="${d}">${d > 0 ? '+' : '−'}${String(Math.abs(d)).replace('.', ',')}</button>`).join('')}
      </div>
      <div class="vc-err" id="vc-err-${k}"></div>
    </section>`;
}

function renderView(root) {
  root.innerHTML = `
    <div class="vc-page">
      <p class="vc-intro">Deux vidéos côte à côte : réglez le départ de chacune, puis lancez-les ensemble.
        Le recul et l'avance s'appliquent aux deux du même nombre de secondes.</p>
      <div class="vc-players">${SIDES.map(panelHtml).join('')}</div>

      <div class="vc-master">
        <button class="vp-btn vp-btn--primary vc-big" id="vc-play">▶ Lecture</button>
        <button class="vp-btn" id="vc-both-start" title="Replace les deux vidéos sur leur départ">⏮ Les deux au départ</button>
        <span class="vc-sep"></span>
        <button class="vp-btn" id="vc-back">⏪ Reculer</button>
        <select id="vc-delta" class="vc-select" aria-label="Valeur du recul en secondes">
          ${DELTAS.map(d => `<option value="${d}"${d === DEFAULT_DELTA ? ' selected' : ''}>${d} s</option>`).join('')}
        </select>
        <button class="vp-btn" id="vc-fwd">Avancer ⏩</button>
        <span class="vc-sep"></span>
        <label class="vc-lbl" for="vc-rate">Vitesse</label>
        <select id="vc-rate" class="vc-select">
          ${RATES.map(r => `<option value="${r}"${r === 1 ? ' selected' : ''}>${String(r).replace('.', ',')}×</option>`).join('')}
        </select>
      </div>
      <div class="vp-hint"><kbd>Espace</kbd> lecture/pause · <kbd>←</kbd> / <kbd>→</kbd> reculer / avancer du delta choisi</div>
    </div>`;
}

// ─────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const startOf = (k) => parseStartTime($(`vc-start-${k}`)?.value) ?? 0;
const setStart = (k, t) => { $(`vc-start-${k}`).value = formatStartTime(t); };

function setError(k, msg) { const el = $(`vc-err-${k}`); if (el) el.textContent = msg || ''; }

function setPlaying(v) {
  playing = v;
  const b = $('vc-play');
  if (b) b.textContent = playing ? '⏸ Pause' : '▶ Lecture';
}

/** Déplace une vidéo ; si la lecture globale est à l'arrêt, elle reste en pause
 *  (un seekTo YouTube sur une vidéo « cued » relancerait sinon la lecture). */
function seekSide(k, t) {
  const p = sides[k]?.player;
  if (!p) return;
  p.seek(t);
  if (!playing) setTimeout(() => { if (!playing) p.pause(); }, 120);
}

function playAll() { SIDES.forEach(k => sides[k]?.player?.play()); setPlaying(true); }
function pauseAll() { SIDES.forEach(k => sides[k]?.player?.pause()); setPlaying(false); }
function togglePlay() { playing ? pauseAll() : playAll(); }

function shiftAll(sign) {
  const d = Number($('vc-delta').value) * sign;
  SIDES.forEach(k => {
    const p = sides[k]?.player;
    if (p) seekSide(k, shiftedTime(p.getTime(), d));
  });
}

function loadYoutube(k) {
  setError(k, '');
  const parsed = parseVideoSource($(`vc-url-${k}`).value);
  if (!parsed) { setError(k, 'Lien YouTube non reconnu.'); return; }
  if (parsed.startAt) setStart(k, parsed.startAt);
  const s = sides[k];
  s.freeze = true;                  // affiche l'image du départ puis met en pause
  setPlaying(false);
  s.player.loadYoutube(parsed.videoId, startOf(k));
}

function loadFile(k, file) {
  if (!file) return;
  setError(k, '');
  const s = sides[k];
  s.freeze = false;
  setPlaying(false);
  s.player.loadFile(file, startOf(k));
}

function bindPanel(k) {
  const s = sides[k];
  $(`vc-load-${k}`).addEventListener('click', () => loadYoutube(k));
  $(`vc-url-${k}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadYoutube(k); });
  $(`vc-file-${k}`).addEventListener('change', (e) => loadFile(k, e.target.files?.[0]));
  $(`vc-go-${k}`).addEventListener('click', () => seekSide(k, startOf(k)));
  $(`vc-mark-${k}`).addEventListener('click', () => setStart(k, s.player.getTime()));
  $(`vc-start-${k}`).addEventListener('change', () => {
    const t = parseStartTime($(`vc-start-${k}`).value);
    if (t == null) { setError(k, 'Instant illisible (ex. 1:23:45 ou 83,5).'); return; }
    setError(k, '');
    setStart(k, t);
    seekSide(k, t);
  });
  document.querySelectorAll(`.vc-nudge[data-side="${k}"]`).forEach(b =>
    b.addEventListener('click', () => {
      const t = shiftedTime(startOf(k), Number(b.dataset.d));
      setStart(k, t);
      seekSide(k, t);
    }));
}

function buildPlayers() {
  SIDES.forEach(k => {
    const s = sides[k] = { player: null, freeze: false };
    s.player = createVideoPlayer($(`vc-host-${k}`), {
      onReady: (info) => {
        if (info.kind === 'youtube' && s.freeze) s.player.play();   // pour dessiner l'image du départ
      },
      onPlayState: (isPlaying) => {
        if (isPlaying && s.freeze) {           // image du départ affichée : on fige
          s.freeze = false;
          s.player.pause();
          s.player.seek(startOf(k));
        }
      },
      onError: (msg) => setError(k, msg || ''),
    });
    bindPanel(k);
  });

  $('vc-play').addEventListener('click', togglePlay);
  $('vc-back').addEventListener('click', () => shiftAll(-1));
  $('vc-fwd').addEventListener('click', () => shiftAll(1));
  $('vc-both-start').addEventListener('click', () => SIDES.forEach(k => seekSide(k, startOf(k))));
  $('vc-rate').addEventListener('change', (e) =>
    SIDES.forEach(k => sides[k].player?.setRate(Number(e.target.value))));

  setInterval(() => {
    if (!$('vc-cur-a')) return;
    SIDES.forEach(k => { $(`vc-cur-${k}`).textContent = formatStartTime(sides[k].player.getTime()); });
  }, 100);
}

function onKey(e) {
  const view = $('view-videoCompare');
  if (!view || view.style.display === 'none') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); shiftAll(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); shiftAll(1); }
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initVideoCompare() {
  document.addEventListener('viewchange', (e) => {
    if (e.detail?.view !== 'videoCompare') {
      if (_initialised && playing) pauseAll();
      return;
    }
    if (_initialised) return;
    const root = $('view-videoCompare');
    if (!root) return;
    _initialised = true;
    renderView(root);
    buildPlayers();
  });
  document.addEventListener('keydown', onKey);
}
