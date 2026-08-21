/* ═══════════════════════════════════════════════
   VIDEOPLAYER.JS — Lecteur vidéo intégré + canvas d'overlay

   Composant autonome : aucune dépendance à Firebase ni à une vue précise.
   Toute la logique de calcul vit dans videoPlayerCalc.js (pur, testé).

   Deux sources, une seule interface :
     • YouTube      → iframe officielle (IFrame Player API) ;
     • fichier local → <video>, l'octet ne quitte jamais la machine.

   Le canvas d'overlay est superposé à l'image DÈS MAINTENANT, alimenté par
   `renderBoxes()`. V0 ne lui envoie rien : c'est le futur module YOLO qui
   l'utilisera, sans qu'il faille reconstruire le lecteur.
═══════════════════════════════════════════════ */

import {
  computeVideoRect, projectBox, sanitizeBoxes, boxLabelText, BOX_STATUS_COLORS,
  clampTime, stepTime, estimateFps, normalizeFps, frameDuration, DEFAULT_FPS, ratesFor,
} from './videoPlayerCalc.js';

const YT_API_SRC = 'https://www.youtube.com/iframe_api';

// ─────────────────────────────────────────────────────────
// API YOUTUBE — chargée une seule fois, à la demande
// ─────────────────────────────────────────────────────────

let _ytPromise = null;

function loadYoutubeApi() {
  if (_ytPromise) return _ytPromise;
  _ytPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };

    let tag = document.querySelector(`script[src="${YT_API_SRC}"]`);
    if (!tag) {
      tag = document.createElement('script');
      tag.src = YT_API_SRC;
      // Hors ligne (le service worker ne met en cache que les assets locaux),
      // l'API ne se charge pas : on le dit au lieu d'attendre indéfiniment.
      tag.onerror = () => reject(new Error('API YouTube injoignable'));
      document.head.appendChild(tag);
    }
    setTimeout(() => reject(new Error('API YouTube injoignable')), 12000);
  });
  return _ytPromise;
}

// ─────────────────────────────────────────────────────────
// COMPOSANT
// ─────────────────────────────────────────────────────────

/**
 * Crée un lecteur dans un conteneur donné.
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {(t:number)=>void} [opts.onTime]       — position courante, en secondes
 * @param {(info:object)=>void} [opts.onReady]   — source prête
 * @param {(playing:boolean)=>void} [opts.onPlayState]
 * @param {(msg:string)=>void} [opts.onError]
 * @returns {object} API du lecteur
 */
export function createVideoPlayer(container, opts = {}) {
  const state = {
    kind: null,             // 'youtube' | 'file' | null
    yt: null,               // instance YT.Player
    video: null,            // élément <video>
    objectUrl: null,
    fileName: null,
    duration: 0,
    fps: null,              // annoncée ou mesurée pour un fichier local, inconnue sur YouTube
    fpsSource: null,        // 'declared' | 'measured' | null
    fpsSamples: [],
    lastFrameTime: null,
    rate: 1,
    boxes: [],
    poll: null,
    rvfc: null,
    destroyed: false,
    aspect: 16 / 9,         // ratio par défaut tant que la vidéo n'est pas lue
  };

  container.classList.add('vp');
  container.innerHTML = `
    <div class="vp-stage" tabindex="-1">
      <div class="vp-media"></div>
      <canvas class="vp-overlay" aria-hidden="true"></canvas>
      <div class="vp-empty">
        <div class="vp-empty-icon">🎬</div>
        <div class="vp-empty-txt">Aucune vidéo chargée</div>
      </div>
    </div>`;

  const stage   = container.querySelector('.vp-stage');
  const media   = container.querySelector('.vp-media');
  const canvas  = container.querySelector('.vp-overlay');
  const empty   = container.querySelector('.vp-empty');
  const ctx     = canvas.getContext('2d');

  // ── Alignement du canvas ────────────────────────────────
  // Recalculé à chaque changement de taille, de ratio ou de plein écran :
  // le canvas ne peut donc pas dériver par rapport à l'image.
  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(stage);
  document.addEventListener('fullscreenchange', resizeCanvas);

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    drawBoxes();
  }

  /** Taille intrinsèque de l'image, en respectant le ratio réel quand on le connaît. */
  function intrinsic() {
    if (state.video?.videoWidth) {
      return { w: state.video.videoWidth, h: state.video.videoHeight };
    }
    return { w: 1000, h: Math.round(1000 / state.aspect) };
  }

  /** Rectangle utile de l'image, en pixels CSS du canvas. */
  function videoRect() {
    const { w, h } = intrinsic();
    return computeVideoRect(stage.clientWidth, stage.clientHeight, w, h);
  }

  function drawBoxes() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (!state.boxes.length) return;

    const rect = videoRect();
    if (!rect.width) return;

    ctx.lineWidth = Math.max(1.5, rect.width / 480);
    // Taille conservée dans une variable : relire ctx.font renverrait la
    // graisse (« 600 ») avant la taille, ce qui donnerait un bandeau géant.
    const fontPx = Math.max(11, Math.round(rect.width / 46));
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';

    for (const box of state.boxes) {
      const p = projectBox(box, rect);
      const color = BOX_STATUS_COLORS[box.status] || BOX_STATUS_COLORS.unknown;

      ctx.strokeStyle = color;
      ctx.setLineDash(box.status === 'probable' ? [6, 4] : []);
      ctx.strokeRect(p.x, p.y, p.width, p.height);
      ctx.setLineDash([]);

      const label = boxLabelText(box);
      if (!label) continue;
      const padX = 5, padY = 3;
      const tw = ctx.measureText(label).width;
      const th = fontPx + padY * 2;
      const ly = Math.max(th, p.y);            // ne sort jamais par le haut
      ctx.fillStyle = color;
      ctx.fillRect(p.x, ly - th, tw + padX * 2, th);
      ctx.fillStyle = '#000';
      ctx.fillText(label, p.x + padX, ly - padY);
    }
  }

  // ── Boucle de position ──────────────────────────────────

  function startPolling() {
    stopPolling();
    state.poll = setInterval(() => {
      if (state.destroyed) return;
      const t = getTime();
      if (Number.isFinite(t)) opts.onTime?.(t);
    }, 120);
  }
  function stopPolling() {
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
  }

  // ── Chargement d'une source ─────────────────────────────

  function clearSource() {
    stopPolling();
    if (state.rvfc && state.video?.cancelVideoFrameCallback) {
      try { state.video.cancelVideoFrameCallback(state.rvfc); } catch { /* ignoré */ }
    }
    state.rvfc = null;
    if (state.yt) { try { state.yt.destroy(); } catch { /* ignoré */ } state.yt = null; }
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    state.video = null;
    state.kind = null;
    state.fps = null;
    state.fpsSource = null;
    state.fpsSamples = [];
    state.lastFrameTime = null;
    state.duration = 0;
    media.innerHTML = '';
    empty.style.display = '';
  }

  /**
   * Charge une vidéo YouTube.
   * @param {string} videoId
   * @param {number} [startAt] — secondes
   */
  async function loadYoutube(videoId, startAt = 0) {
    clearSource();
    if (!videoId) return;
    state.kind = 'youtube';
    empty.style.display = 'none';

    const host = document.createElement('div');
    host.className = 'vp-yt';
    media.appendChild(host);

    let YT;
    try {
      YT = await loadYoutubeApi();
    } catch (err) {
      state.kind = null;
      media.innerHTML = `
        <div class="vp-error">
          Impossible de charger le lecteur YouTube (connexion ?).<br>
          <a href="https://youtu.be/${encodeURIComponent(videoId)}?t=${Math.floor(startAt || 0)}s"
             target="_blank" rel="noopener">Ouvrir la vidéo sur YouTube ↗</a>
        </div>`;
      opts.onError?.(err.message);
      return;
    }
    if (state.destroyed) return;

    state.yt = new YT.Player(host, {
      videoId,
      playerVars: {
        start: Math.floor(startAt || 0),
        rel: 0, modestbranding: 1, playsinline: 1, controls: 1,
      },
      events: {
        onReady: () => {
          state.duration = state.yt.getDuration?.() || 0;
          state.rate = state.yt.getPlaybackRate?.() || 1;
          startPolling();
          resizeCanvas();
          opts.onReady?.({ kind: 'youtube', duration: state.duration, fps: null, videoId });
        },
        onStateChange: (e) => opts.onPlayState?.(e.data === YT.PlayerState.PLAYING),
        onError: () => opts.onError?.('Vidéo YouTube indisponible (privée ou supprimée ?)'),
      },
    });
  }

  /**
   * Charge un fichier local. Le fichier reste sur la machine : on n'utilise
   * qu'une URL d'objet en mémoire, jamais de téléversement.
   *
   * `options.fps` permet d'ANNONCER la cadence au lieu de la laisser deviner.
   * C'est ce que fournit le sidecar `rx-extract/1` de tools/extract-manche/,
   * mesuré par ffprobe. Sans elle, la cadence est mesurée via
   * `requestVideoFrameCallback` — que Firefox n'implémente pas, auquel cas le
   * pas retombe silencieusement sur DEFAULT_FPS : deux images d'écart par clic
   * sur une vidéo à 50 img/s.
   *
   * @param {File} file
   * @param {number} [startAt]
   * @param {{fps?:number}} [options]
   */
  function loadFile(file, startAt = 0, options = {}) {
    clearSource();
    if (!file) return;
    state.kind = 'file';
    state.fileName = file.name;
    empty.style.display = 'none';

    // Une cadence annoncée est exacte : elle prime sur toute mesure ultérieure.
    const declaredFps = normalizeFps(options?.fps);
    if (declaredFps) { state.fps = declaredFps; state.fpsSource = 'declared'; }

    const url = URL.createObjectURL(file);
    state.objectUrl = url;

    const video = document.createElement('video');
    video.className = 'vp-video';
    video.src = url;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    media.appendChild(video);
    state.video = video;

    video.addEventListener('loadedmetadata', () => {
      state.duration = video.duration || 0;
      state.aspect = video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight
        : state.aspect;
      if (startAt > 0) video.currentTime = clampTime(startAt, state.duration);
      resizeCanvas();
      opts.onReady?.({
        kind: 'file', duration: state.duration, fps: state.fps,
        fpsSource: state.fpsSource, fileName: file.name,
      });
    });
    video.addEventListener('timeupdate', () => opts.onTime?.(video.currentTime));
    video.addEventListener('seeked',     () => opts.onTime?.(video.currentTime));
    video.addEventListener('play',  () => opts.onPlayState?.(true));
    video.addEventListener('pause', () => opts.onPlayState?.(false));
    video.addEventListener('error', () => {
      opts.onError?.('Format vidéo non lisible par le navigateur');
    });

    // Mesure de la cadence : indispensable pour un vrai « image par image »,
    // mais inutile quand elle a déjà été annoncée.
    if (!declaredFps && typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = (_now, meta) => {
        if (state.destroyed || state.video !== video) return;
        // Hors vitesse normale, `mediaTime` avance de plusieurs images entre
        // deux présentations : une lecture à ×2 ferait mesurer la moitié de la
        // cadence réelle, et l'erreur resterait acquise pour toute la session.
        if (state.lastFrameTime != null && state.rate === 1) {
          const d = meta.mediaTime - state.lastFrameTime;
          if (d > 0) {
            state.fpsSamples.push(d);
            if (state.fpsSamples.length > 40) state.fpsSamples.shift();
            if (state.fpsSamples.length >= 8 && state.fps == null) {
              state.fps = estimateFps(state.fpsSamples);
              if (state.fps) {
                state.fpsSource = 'measured';
                opts.onReady?.({
                  kind: 'file', duration: state.duration, fps: state.fps,
                  fpsSource: 'measured', fileName: file.name,
                });
              }
            }
          }
        }
        state.lastFrameTime = meta.mediaTime;
        state.rvfc = video.requestVideoFrameCallback(onFrame);
      };
      state.rvfc = video.requestVideoFrameCallback(onFrame);
    }
  }

  // ── Commandes ───────────────────────────────────────────

  function getTime() {
    if (state.kind === 'youtube') return state.yt?.getCurrentTime?.() ?? 0;
    if (state.video) return state.video.currentTime || 0;
    return 0;
  }

  function isPlaying() {
    if (state.kind === 'youtube') {
      return state.yt?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
    }
    return !!state.video && !state.video.paused && !state.video.ended;
  }

  function play() {
    if (state.kind === 'youtube') state.yt?.playVideo?.();
    else state.video?.play?.().catch(() => { /* geste utilisateur requis */ });
  }

  function pause() {
    if (state.kind === 'youtube') state.yt?.pauseVideo?.();
    else state.video?.pause?.();
  }

  function togglePlay() { isPlaying() ? pause() : play(); }

  function seek(t) {
    const v = clampTime(t, state.duration || undefined);
    if (state.kind === 'youtube') state.yt?.seekTo?.(v, true);
    else if (state.video) state.video.currentTime = v;
    opts.onTime?.(v);
    return v;
  }

  /**
   * Déplacement relatif. Le mode « frame » n'a de sens que sur un fichier
   * local : YouTube ne donne pas accès aux images, on retombe alors sur le
   * plus petit pas que l'API accepte réellement.
   */
  function step(direction, mode = 'medium') {
    const effective = (mode === 'frame' && state.kind === 'youtube') ? 'small' : mode;
    pause();
    return seek(stepTime(getTime(), {
      direction,
      mode: effective,
      fps: state.fps || DEFAULT_FPS,
      duration: state.duration || undefined,
    }));
  }

  function setRate(r) {
    const allowed = ratesFor(state.kind);
    // YouTube ignore silencieusement une vitesse hors liste : on la recale.
    const rate = allowed.reduce((best, v) =>
      Math.abs(v - r) < Math.abs(best - r) ? v : best, allowed[0]);
    state.rate = rate;
    if (state.kind === 'youtube') state.yt?.setPlaybackRate?.(rate);
    else if (state.video) state.video.playbackRate = rate;
    return rate;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stage.requestFullscreen?.().catch(() => { /* refusé par le navigateur */ });
  }

  /**
   * Point d'entrée du futur module YOLO/tracking.
   *
   * Coordonnées NORMALISÉES (0..1) dans le repère de l'image, pas en pixels :
   * elles restent justes quels que soient la taille du lecteur, le plein écran
   * ou la définition de la vidéo.
   *
   * @param {Array<{driverId?:string, carNumber?:number|string, label?:string,
   *                x:number, y:number, width:number, height:number,
   *                confidence?:number, status?:'confirmed'|'probable'|'unknown'|'lost'}>} boxes
   */
  function renderBoxes(boxes) {
    state.boxes = sanitizeBoxes(boxes);
    drawBoxes();
    return state.boxes.length;
  }

  function destroy() {
    state.destroyed = true;
    clearSource();
    ro.disconnect();
    document.removeEventListener('fullscreenchange', resizeCanvas);
    container.innerHTML = '';
  }

  resizeCanvas();

  return {
    loadYoutube, loadFile, clearSource,
    play, pause, togglePlay, seek, step, setRate, toggleFullscreen,
    getTime, isPlaying, renderBoxes, destroy,
    /** Rectangle utile de l'image — exposé pour vérifier l'alignement. */
    getVideoRect: videoRect,
    get kind()     { return state.kind; },
    get duration() { return state.duration; },
    get fps()      { return state.fps; },
    /** 'declared' (sidecar ffprobe), 'measured' (rVFC) ou null. */
    get fpsSource() { return state.fpsSource; },
    get rate()     { return state.rate; },
    get fileName() { return state.fileName; },
    get frameStep() { return frameDuration(state.fps || DEFAULT_FPS); },
    get element()  { return stage; },
  };
}
