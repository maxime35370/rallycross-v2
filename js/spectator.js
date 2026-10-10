/* ═══════════════════════════════════════════════
   SPECTATOR.JS — Mode spectateur temps réel
   Lecture seule, rafraîchissement auto
   Optimisé mobile/tablette
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { msToDisplay, escHtml, dedupeParticipants } from './utils.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';
import { getCachedResults } from './sessionCache.js';
import { watchSessionResultsRtdb } from './rtdb.js';
import {
  watchPronostics, myVote, castVote, ensureAnon, watchMeetingScores, autoPseudo, getPlayerPseudo, setPlayerPseudo,
  getTwitchProfile, beginTwitchLink, consumeTwitchLinkResult, watchSeasonScores,
  watchSeasonAccuracy, getMyPredictionHistory,
} from '../overlay/_lib/obs-pronostics.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let allMeetings       = [];
let allSessions       = [];
let unsubResults      = null;
let _isFullscreen     = false;

let _interimRefreshTimer = null;

// Classement intermédiaire calculé EN MÉMOIRE (aucune relecture périodique).
// Les résultats des EC/MQ du meeting arrivent par écoute temps réel (1 lecture
// par pilote à l'ouverture, puis 1 par chrono modifié) ; les participants,
// qui bougent rarement, sont relus au plus toutes les PARTICIPANTS_MAX_AGE_MS
// et seulement si l'onglet est visible.
const INTERIM_SESSION_TYPES   = ['EC', 'MQ'];
const PARTICIPANTS_TICK_MS    = 60 * 1000;
const PARTICIPANTS_MAX_AGE_MS = 10 * 60 * 1000;
const INTERIM_DEBOUNCE_MS     = 400;
let _interimResults      = {};   // sessionId → documents results (EC/MQ)
let _interimParts        = {};   // sessionId → participants dédoublonnés (EC/MQ)
let _interimPartsAt      = 0;
let _interimSessionUnsubs = [];
let _interimDebounce     = null;
let _visHandler          = null;
let _currentSessionId    = null;
let _renderToken         = 0;

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

function parseSpectatorParams() {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return {};
  const params = {};
  hash.substring(qIdx + 1).split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k && v) params[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  return params;
}

function applyFullscreen(enable) {
  _isFullscreen = enable;
  const header = document.querySelector('.app-header');
  const menuOverlay = document.getElementById('menu-overlay');
  const menuDrawer = document.getElementById('menu-drawer');
  if (enable) {
    if (header) header.style.display = 'none';
    if (menuOverlay) menuOverlay.style.display = 'none';
    if (menuDrawer) menuDrawer.style.display = 'none';
    document.body.classList.add('spc-fullscreen');
  } else {
    if (header) header.style.display = '';
    if (menuOverlay) menuOverlay.style.display = '';
    if (menuDrawer) menuDrawer.style.display = '';
    document.body.classList.remove('spc-fullscreen');
  }
}

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE
// ─────────────────────────────────────────────────────────

async function fsQuery(col, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const constraints = filters.map(([f, op, v]) => where(f, op, v));
  const snap = await getDocs(query(collection(db, col), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Lecture ponctuelle (non temps réel) des résultats d'une manche : passe
 *  par le cache de manche (js/sessionCache.js) quand il existe — surtout
 *  utile ici pour les ¼/½ finales et la Finale de meetings déjà terminés
 *  (championnat, classement de meetings passés), retombe sur la requête
 *  directe sinon. */
async function getResultsCached(sessionId) {
  const cached = await getCachedResults(db, sessionId);
  if (cached) return cached;
  return fsQuery('results', [['sessionId', '==', sessionId]]);
}

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'meetings'),
    where('year', '==', selectedYear),
    orderBy('date', 'asc')
  );
  const snap = await new Promise(res => {
    const unsub = onSnapshot(q, s => { unsub(); res(s); });
  });
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const champId = getActiveChampionshipId();
  allMeetings = champId ? all.filter(m => m.championshipId === champId || !m.championshipId) : all;
  refreshMeetingSelect();
}

async function loadSessions() {
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; return; }
  allSessions = await fsQuery('sessions', [
    ['meetingId', '==', selectedMeetingId],
    ['category',  '==', selectedCategory],
  ]);
  allSessions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ─────────────────────────────────────────────────────────
// LIVE LISTENERS
// Les callbacks mettent à jour _carouselData UNIQUEMENT
// Le rendu visuel est géré exclusivement par le carrousel
// ─────────────────────────────────────────────────────────

async function subscribeResults(sessionId) {
  if (unsubResults) { unsubResults(); unsubResults = null; }
  if (!db || !sessionId) return;

  unsubResults = await watchSessionResultsRtdb(sessionId, results => {
    const session = allSessions.find(s => s.id === sessionId);

    // Mise à jour des données uniquement — pas de re-render
    if (session?.type === 'MQ') {
      _carouselData.mqResults = results;
      _carouselData.mqLabel   = `Manche qualificative ${session.num}`;
    }
    if (session?.type === 'EC') {
      _carouselData.ecResults = results;
    }
    if (!_carouselData.sessionResults) _carouselData.sessionResults = {};
    _carouselData.sessionResults[sessionId] = results;

    updateTimestamp();
  });
}

/** Recalcule le classement intermédiaire depuis les données déjà en mémoire. */
async function refreshInterimLive() {
  if (!selectedMeetingId || !selectedCategory || !allSessions.length) return;
  try {
    const { buildInterimFromData } = await import('./calc.js');
    const rows = buildInterimFromData(allSessions, _interimResults, _interimParts);
    // Mise à jour des données uniquement — pas de re-render
    _carouselData.interimRows = rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    updateTimestamp();
  } catch {}
}

function scheduleInterimRecompute() {
  if (_interimDebounce) clearTimeout(_interimDebounce);
  _interimDebounce = setTimeout(() => { _interimDebounce = null; refreshInterimLive(); }, INTERIM_DEBOUNCE_MS);
}

/** Participants des EC/MQ du meeting : 1 lecture par document, rafraîchie rarement. */
async function loadInterimParticipants(token = _renderToken) {
  const sessions = allSessions.filter(s => INTERIM_SESSION_TYPES.includes(s.type));
  const entries = await Promise.all(sessions.map(async s => {
    const rows = await fsQuery('sessionParticipants', [['sessionId', '==', s.id]]);
    return [s.id, dedupeParticipants(rows, s.id).participants];
  }));
  if (token !== _renderToken) return;   // un rendu plus récent a pris le relais
  _interimParts = Object.fromEntries(entries);
  _interimPartsAt = Date.now();
}

/** Relit les participants si les derniers datent et que l'onglet est visible. */
async function refreshParticipantsIfStale() {
  if (document.hidden) return;
  if (Date.now() - _interimPartsAt < PARTICIPANTS_MAX_AGE_MS) return;
  const token = _renderToken;
  try {
    await loadInterimParticipants();
    if (token === _renderToken) await refreshInterimLive();
  } catch {}
}

/**
 * Écoute les résultats d'une session EC/MQ. Résout avec le premier instantané
 * (même rôle que l'ancienne lecture unique) ; les suivants mettent à jour le
 * classement intermédiaire sans aucune relecture.
 */
async function watchInterimSession(session, token) {
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  return new Promise(resolve => {
    let first = true;
    const q = query(collection(db, 'results'), where('sessionId', '==', session.id));
    const unsub = onSnapshot(q, snap => {
      if (token !== _renderToken) return;
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _interimResults[session.id] = rows;
      if (first) { first = false; resolve(rows); return; }
      if (session.id === _currentSessionId) {
        // Même mise à jour que subscribeResults pour la session courante
        if (session.type === 'MQ') {
          _carouselData.mqResults = rows;
          _carouselData.mqLabel   = `Manche qualificative ${session.num}`;
        }
        if (session.type === 'EC') _carouselData.ecResults = rows;
        if (!_carouselData.sessionResults) _carouselData.sessionResults = {};
        _carouselData.sessionResults[session.id] = rows;
      }
      scheduleInterimRecompute();
      updateTimestamp();
    }, err => {
      console.warn('[spectator] écoute results', session.id, err);
      if (first) { first = false; resolve([]); }
    });
    // Rendu devenu obsolète pendant l'import du SDK : on ne garde pas l'écoute.
    if (token !== _renderToken) { unsub(); resolve([]); return; }
    _interimSessionUnsubs.push(unsub);
  });
}

function stopInterimWatch() {
  _interimSessionUnsubs.forEach(u => { try { u(); } catch {} });
  _interimSessionUnsubs = [];
  if (_interimDebounce) { clearTimeout(_interimDebounce); _interimDebounce = null; }
  if (_interimRefreshTimer) { clearInterval(_interimRefreshTimer); _interimRefreshTimer = null; }
  if (_visHandler) { document.removeEventListener('visibilitychange', _visHandler); _visHandler = null; }
}

function updateTimestamp() {
  const el = document.getElementById('spc-timestamp');
  if (el) el.textContent = `Mis à jour : ${new Date().toLocaleTimeString('fr-FR')}`;
}

// ─────────────────────────────────────────────────────────
// RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-spectator').innerHTML = `
    <div class="spc-header">
      <div class="spc-title">
        <span class="spc-flag">🏁</span>
        <span>Mode Spectateur</span>
      </div>
      <div class="spc-header-badges">
        <span class="spc-twitch-badge" id="spc-twitch-badge" style="display:none" title="Connecté avec Twitch">
          🎮 <span id="spc-twitch-badge-name"></span>
        </span>
        <div class="spc-live-dot" id="spc-live-dot" title="Mise à jour automatique">
          <span class="spc-dot"></span>
          <span class="spc-live-label">LIVE</span>
        </div>
      </div>
    </div>

    <div class="toolbar ${_isFullscreen ? 'spc-toolbar-hidden' : ''}" id="spc-toolbar" style="flex-wrap:wrap;gap:var(--sp-sm);margin-bottom:var(--sp-md)">
      <select class="toolbar-select" id="spc-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="spc-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="spc-category">
        <option value="">— Catégorie —</option>
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" id="spc-fullscreen-btn" title="Plein ecran">⛶</button>
    </div>

    <div class="spc-score-row">
      <div id="spc-myscore" class="spc-myscore" style="display:none"></div>
      <div id="spc-season-twitch" class="spc-myscore" style="display:none"></div>
      <div id="spc-season-ratio" class="spc-myscore" style="display:none"></div>
      <div id="spc-season-bold" class="spc-myscore" style="display:none"></div>
    </div>
    <div id="spc-pseudo" class="spc-pseudo" style="display:none"></div>
    <div id="spc-history-wrap" style="display:none;margin-bottom:var(--sp-md,16px)">
      <button id="spc-history-toggle" class="btn btn-ghost btn-sm">📜 Mes pronostics</button>
      <div id="spc-history-list" class="spc-pseudo" style="display:none;margin-top:8px"></div>
    </div>
    <div id="spc-pronostics" class="spc-pronostics" style="display:none"></div>

    <div id="spc-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">📺</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>
    </div>

    <div id="spc-pronostics-past" class="spc-pronostics" style="display:none;margin-top:var(--sp-lg)"></div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('spc-meeting');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Meeting —</option>`;
  allMeetings.forEach(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR') : '?';
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${d} — ${m.location || '?'}`;
    if (m.id === selectedMeetingId) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function renderContent() {
  const content = document.getElementById('spc-content');
  if (!content || !selectedMeetingId || !selectedCategory) return;

  // Reset complet (écoutes précédentes coupées, appels concurrents invalidés)
  const token = ++_renderToken;
  stopInterimWatch();
  _interimResults = {};
  _interimParts   = {};
  _currentSessionId = null;
  _carouselData = { mqResults: [], mqLabel: '', interimRows: [], ecResults: [], sessionResults: {} };
  _carouselSlide = 0;

  await loadSessions();
  if (token !== _renderToken) return;

  // Une seule lecture par session. Les EC/MQ passent par une écoute temps
  // réel (leur premier instantané remplace la lecture), ce qui permet de
  // tenir le classement intermédiaire à jour sans jamais le relire.
  const [sessionResults] = await Promise.all([
    Promise.all(allSessions.map(async s => {
      const res = INTERIM_SESSION_TYPES.includes(s.type)
        ? await watchInterimSession(s, token)
        : await getResultsCached(s.id);
      return { session: s, count: res.length, results: res };
    })),
    loadInterimParticipants(token),
  ]);
  if (token !== _renderToken) return;

  const withResults    = sessionResults.filter(sr => sr.count > 0);
  const currentSR      = withResults[withResults.length - 1] || null;
  const currentSession = currentSR?.session || null;
  _currentSessionId    = currentSession?.id || null;

  // Pré-charger toutes les données avant d'afficher
  const sessionResultsMap = {};
  for (const { session: s, results: res } of sessionResults) {
    sessionResultsMap[s.id] = res;
    if (s.type === 'EC'  && res.length > 0) _carouselData.ecResults = res;
    if (s.type === 'MQ'  && res.length > 0) { _carouselData.mqResults = res; _carouselData.mqLabel = `Manche qualificative ${s.num}`; }
    if (s.type === 'DF'  && res.length > 0) { _carouselData[`df${s.num}Results`] = res; }
    if (s.type === 'FIN' && res.length > 0) _carouselData.finResults = res;
  }
  _carouselData.sessionResults = sessionResultsMap;
  _carouselData.phase = detectPhase();

  // Classement intermédiaire initial (calculé en mémoire)
  await refreshInterimLive();

  // Afficher la structure HTML
  content.innerHTML = `
    <div id="spc-carousel-block"></div>
    <div class="spc-updated" id="spc-timestamp">En attente de données…</div>
  `;

  // Abonnements live (mettent à jour _carouselData uniquement). Les EC/MQ sont
  // déjà écoutées ci-dessus, y compris quand l'une d'elles est la session courante.
  if (currentSession && !INTERIM_SESSION_TYPES.includes(currentSession.type)) {
    await subscribeResults(currentSession.id);
  }
  await subscribeAdvancedSessions();

  // Les participants bougent rarement : relus au plus toutes les 10 min, et
  // seulement si l'onglet est visible (retour au premier plan = vérification).
  _interimRefreshTimer = setInterval(refreshParticipantsIfStale, PARTICIPANTS_TICK_MS);
  _visHandler = () => { if (!document.hidden) refreshParticipantsIfStale(); };
  document.addEventListener('visibilitychange', _visHandler);

  loadChampionshipData();

  // Démarrer le carrousel — seul maître du rendu
  startCarousel();
}

async function loadChampionshipData() {
  if (!selectedMeetingId || !selectedCategory) return;
  try {
    const { calcInterimStandings } = await import('./calc.js');
    const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
    const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

    const allMeetingsSnap = await fsQuery('meetings', [['year', '==', selectedYear]]);
    const pastMeetings = allMeetingsSnap.filter(m => m.id !== selectedMeetingId);
    const pointsMap = {};

    for (const meeting of pastMeetings) {
      const meetingSessions = await fsQuery('sessions', [
        ['meetingId', '==', meeting.id],
        ['category',  '==', selectedCategory],
      ]);
      if (!meetingSessions.length) continue;

      const interim = await calcInterimStandings(db, meetingSessions);
      interim.forEach(r => {
        if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
        pointsMap[r.driverId].total += r.interimPoints ?? 0;
      });

      for (const df of meetingSessions.filter(s => s.type === 'DF')) {
        const res = await getResultsCached(df.id);
        res.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms).forEach((r, i) => {
          if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
          pointsMap[r.driverId].total += DF_PTS[i + 1] ?? 0;
        });
      }

      const finSession = meetingSessions.find(s => s.type === 'FIN');
      if (finSession) {
        const res = await getResultsCached(finSession.id);
        res.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms).forEach((r, i) => {
          if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
          pointsMap[r.driverId].total += FIN_PTS[i + 1] ?? 0;
        });
      }
    }

    _carouselData.championshipRows = Object.values(pointsMap).sort((a, b) => b.total - a.total).slice(0, 10);
  } catch {}
}

async function subscribeAdvancedSessions() {
  if (!db) return;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  for (const s of allSessions.filter(s => ['DF','FIN'].includes(s.type))) {
    const q = query(collection(db,'results'), where('sessionId','==',s.id));
    onSnapshot(q, snap => {
      const results = snap.docs.map(d => d.data());
      if (!_carouselData.sessionResults) _carouselData.sessionResults = {};
      _carouselData.sessionResults[s.id] = results;
      // Mise à jour phase si nécessaire
      const newPhase = detectPhase();
      if (newPhase !== _carouselData.phase) {
        _carouselData.phase = newPhase;
        _carouselSlide = 0;
        // Changement de phase → re-render complet
        renderCarouselSlide();
      }
      if (s.type === 'DF')  _carouselData[`df${s.num}Results`] = results;
      if (s.type === 'FIN') _carouselData.finResults = results;
      updateTimestamp();
    });
  }
}

// ─────────────────────────────────────────────────────────
// ÉTAT CARROUSEL
// ─────────────────────────────────────────────────────────

let unsubNextParts     = null;
let _carouselTimer     = null;
let _carouselSlide     = 0;
let _carouselData      = { mqResults: [], mqLabel: '', interimRows: [], ecResults: [], sessionResults: {} };
let _dfScrollTimer     = null;
let _dfScrollPhase     = 0;
let _stickyScrollTimer = null;
let _stickyAnimFrameId = null;
let _stickyPauseTimer  = null;

function startRefresh() {
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.add('spc-live-dot--active');
}

function stopRefresh() {
  if (unsubResults)         { unsubResults();   unsubResults   = null; }
  if (unsubNextParts)       { unsubNextParts(); unsubNextParts = null; }
  stopInterimWatch();
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.remove('spc-live-dot--active');
}

// ─────────────────────────────────────────────────────────
// PRONOSTICS SPECTATEURS (vote depuis le mobile)
//   • Aucun score visible tant que le vote est OUVERT (anti-influence).
//   • Vote facultatif et modifiable jusqu'à la fermeture.
//   • 1 vote / navigateur (session anonyme persistante → recharger ne
//     recrée pas de vote). Les tendances n'apparaissent qu'à la fermeture.
// ─────────────────────────────────────────────────────────
let _pronoUid        = null;
let _pronoDocs       = [];
let _myVotes         = {};
let _pronoErr        = {};   // pid -> message d'erreur du dernier vote (affiché dans la carte)
let _unsubPronostics = null;
let _pronoClickBound = false;
let _scores          = {};     // classement pronostiqueurs du meeting : uid -> points
let _scoresMeetingId = null;
let _unsubScores     = null;
let _pseudos         = {};     // uid -> pseudo perso résolu ('' = aucun / déjà cherché)
let _pseudoEditorDone = false;
let _pseudoEditorShowsConnected = false;   // état Twitch tel qu'affiché lors du dernier build de l'éditeur
let _twitchByUid      = {};    // uid -> profil Twitch ({login,displayName,...}) | null (pas lié, déjà cherché)
let _seasonScores     = {};    // classement saison (Twitch uniquement) : uid -> points
let _seasonChampId    = null;
let _unsubSeason      = null;
let _seasonAccuracy   = {};    // taux de réussite saison (Twitch uniquement) : uid -> { correct, total }
let _accuracyChampId  = null;
let _unsubAccuracy    = null;

const escName = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
/** Pseudo affiché : compte Twitch lié en priorité, sinon pseudo perso, sinon pseudo auto. */
const pseudoFor = uid => _twitchByUid[uid]?.displayName
  || ((typeof _pseudos[uid] === 'string' && _pseudos[uid]) ? _pseudos[uid] : autoPseudo(uid));

/** Re-render commun : les deux classements (meeting + saison) affichent des pseudos, tous deux doivent suivre. */
function rerenderScoreBoards() { renderMyScore(); renderSeasonTwitch(); renderSeasonRatio(); renderSeasonBold(); }

/** Résout les pseudos perso des UID affichés (une fois chacun), puis re-render si trouvé. */
function ensurePseudos(uids) {
  const todo = uids.filter(u => u && !(u in _pseudos));
  if (!todo.length) return;
  todo.forEach(u => { _pseudos[u] = ''; });   // marque « cherché » pour éviter les re-fetch en boucle
  Promise.all(todo.map(async u => { try { const p = await getPlayerPseudo(u); if (p) _pseudos[u] = p; } catch {} }))
    .then(rerenderScoreBoards);
}

/** Résout le statut Twitch (lié ou non) des UID affichés (une fois chacun), puis re-render si trouvé. */
function ensureTwitchProfiles(uids) {
  const todo = uids.filter(u => u && !(u in _twitchByUid));
  if (!todo.length) return;
  todo.forEach(u => { _twitchByUid[u] = null; });   // marque « cherché »
  Promise.all(todo.map(async u => { try { const p = await getTwitchProfile(u); if (p) _twitchByUid[u] = p; } catch {} }))
    .then(() => { rerenderScoreBoards(); refreshIdentityBox(); });
}

/** Petit badge « connecté Twitch » à côté du dot LIVE (voir renderPseudoEditor). */
function showTwitchBadge(displayName) {
  const b = document.getElementById('spc-twitch-badge');
  const n = document.getElementById('spc-twitch-badge-name');
  if (!b || !n) return;
  n.textContent = displayName;
  b.style.display = '';
}
function hideTwitchBadge() {
  const b = document.getElementById('spc-twitch-badge');
  if (b) b.style.display = 'none';
}

/** Éditeur « ton pseudo » (option B) + connexion Twitch — construit une seule fois pour ne pas réinitialiser la saisie. */
async function renderPseudoEditor() {
  const el = document.getElementById('spc-pseudo');
  if (!el || !_pronoUid) return;
  if (!(_pronoUid in _pseudos)) { try { _pseudos[_pronoUid] = (await getPlayerPseudo(_pronoUid)) || ''; } catch { _pseudos[_pronoUid] = ''; } }
  if (!(_pronoUid in _twitchByUid)) { try { _twitchByUid[_pronoUid] = await getTwitchProfile(_pronoUid); } catch { _twitchByUid[_pronoUid] = null; } }
  const twitch = _twitchByUid[_pronoUid];

  if (twitch) {
    // Plus besoin d'un gros bloc une fois connecté : un petit badge à côté du
    // dot LIVE suffit à le rappeler, sans continuer à prendre de la place.
    el.innerHTML = '';
    el.style.display = 'none';
    showTwitchBadge(twitch.displayName);
    _pseudoEditorDone = true;
    _pseudoEditorShowsConnected = true;
    return;
  }

  hideTwitchBadge();
  el.style.display = '';
  const current = pseudoFor(_pronoUid);
  const custom  = (typeof _pseudos[_pronoUid] === 'string' && _pseudos[_pronoUid]) ? _pseudos[_pronoUid] : '';
  const errBanner = _twitchLinkError
    ? `<div class="ps-hint ps-twitch-err">⚠️ ${escName(_twitchLinkError)}</div>` : '';
  _twitchLinkError = null;   // affiché une fois, jusqu'à la prochaine tentative
  el.innerHTML = `<div class="ps-lbl">Ton pseudo au classement</div>`
    + `<div class="ps-row"><input id="spc-pseudo-in" maxlength="20" placeholder="${escName(current)}" value="${escName(custom)}">`
    + `<button id="spc-pseudo-save">OK</button></div>`
    + `<div class="ps-hint">Laisse vide pour garder ton pseudo auto (${escName(autoPseudo(_pronoUid))}).</div>`
    + `<div class="ps-twitch"><button id="spc-twitch-link" class="ps-twitch-btn">🎮 Se connecter avec Twitch</button></div>`
    + `<div class="ps-hint">Optionnel — garde tes points si tu changes d'appareil, et rejoins le classement saison Twitch.</div>`
    + errBanner;
  document.getElementById('spc-pseudo-save').onclick = async () => {
    const v = document.getElementById('spc-pseudo-in').value;
    const btn = document.getElementById('spc-pseudo-save');
    try { _pseudos[_pronoUid] = await setPlayerPseudo(_pronoUid, v); btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'OK'; }, 1200); rerenderScoreBoards(); }
    catch { btn.textContent = '⚠'; setTimeout(() => { btn.textContent = 'OK'; }, 1200); }
  };
  document.getElementById('spc-twitch-link').onclick = async () => {
    const btn = document.getElementById('spc-twitch-link');
    btn.disabled = true; btn.textContent = 'Redirection…';
    try { await beginTwitchLink(window.location.hash); }
    catch { btn.disabled = false; btn.textContent = '⚠️ Indisponible — réessaie plus tard'; }
  };
  _pseudoEditorShowsConnected = false;
  _pseudoEditorDone = true;
}

/** Message affiché à l'utilisateur selon la raison de l'échec (reason après "error:"). */
const TWITCH_ERROR_MSG = {
  state: 'La connexion a expiré ou a été interrompue — réessaie.',
  'no-session': 'Session de pronostics indisponible — recharge la page et réessaie.',
  access_denied: 'Connexion annulée.',
};

/** Résultat du dernier aller-retour Twitch (posé par la page pont) : affiché dans le bloc pseudo au prochain rendu. */
let _twitchLinkError = null;
function twitchLinkResultHint(result) {
  if (!result) return;
  if (result === 'ok') return; // pas de bandeau : renderPseudoEditor affichera l'état "connecté" directement
  const reason = result.replace(/^error:/, '');
  _twitchLinkError = TWITCH_ERROR_MSG[reason] || 'Connexion Twitch impossible pour le moment — réessaie plus tard.';
  console.warn('[twitch] connexion échouée :', result);
}

const PRONO_ICON      = { manche_winner: '🏆', interim_m2: '📊', interim_final: '📊', ec_best: '⏱️', serie_winner: '🏁', df_winner: '🥈', final_winner: '🏆', custom: '🎯' };
const PRONO_STATUS_FR = { open: 'Ouvert', closed: 'Votes clos', revealed: 'Résultat' };

async function initPronostics() {
  if (_unsubPronostics) return;                       // déjà abonné
  if (!_pronoClickBound) { document.addEventListener('click', onPronoClick); _pronoClickBound = true; }

  // 0) Retour éventuel de la page pont Twitch (voir netlify/functions/twitch-auth.js) :
  //    la session anonyme a potentiellement basculé sur un uid Twitch stable.
  twitchLinkResultHint(consumeTwitchLinkResult());

  // 1) AFFICHAGE : lecture PUBLIQUE, indépendante de l'auth anonyme. On s'abonne
  //    immédiatement pour que les pronostics apparaissent même si la connexion
  //    anonyme (utile seulement pour VOTER) est lente ou indisponible.
  try {
    _unsubPronostics = await watchPronostics(async list => {
      _pronoDocs = (list || []).filter(p => p.status && p.status !== 'draft');
      await refreshMyVotes();
      renderPronostics();
    }, () => {});
  } catch {}

  // 2) VOTE : session anonyme en tâche de fond (n'empêche jamais l'affichage).
  ensureAnon()
    .then(async uid => {
      _pronoUid = uid;
      await refreshMyVotes();
      renderPronostics();
      renderMyScore();
      refreshIdentityBox();   // indépendant du meeting sélectionné (voir sa doc)
      refreshHistoryToggle();
    })
    .catch(() => { _pronoUid = null; });
}

/** (Ré)abonne au classement des pronostiqueurs de l'épreuve sélectionnée. */
function watchScoresFor(meetingId) {
  if (meetingId === _scoresMeetingId) return;
  if (_unsubScores) { try { _unsubScores(); } catch {} _unsubScores = null; }
  _scoresMeetingId = meetingId || null;
  _scores = {};
  renderMyScore();
  if (!meetingId) return;
  watchMeetingScores(meetingId, map => { _scores = map || {}; renderMyScore(); }, () => {})
    .then(unsub => { if (_scoresMeetingId === meetingId) _unsubScores = unsub; else { try { unsub(); } catch {} } })
    .catch(() => {});
}

// Seuils de mélange demandés : en dessous, classement mixte (Twitch + non
// connectés) ; à partir de WEEKEND_SPLIT_MIN participants ET
// WEEKEND_SPLIT_MIN_TWITCH comptes Twitch parmi eux, classement Twitch
// séparé + meilleur non connecté affiché à côté.
const WEEKEND_TOP_N            = 15;
const WEEKEND_SPLIT_MIN         = 20;
const WEEKEND_SPLIT_MIN_TWITCH  = 10;

const RANK_BADGE = ['🏆', '🥈', '🥉'];

function scoreRowHtml(u, p, i, uid, withMedal) {
  const pos = withMedal ? (RANK_BADGE[i] || (i + 1)) : (i + 1);
  return `<div class="ms-row${u === uid ? ' me' : ''}"><span class="ms-pos">${pos}</span>`
    + `<span class="ms-name">${escName(pseudoFor(u))}${u === uid ? ' <span class="ms-you">(toi)</span>' : ''}</span>`
    + `<span class="ms-v">${p} pt${p > 1 ? 's' : ''}</span></div>`;
}

/** Affiche « tes points » + le classement du meeting (mixte, ou Twitch séparé selon les seuils). */
function renderMyScore() {
  const el = document.getElementById('spc-myscore');
  if (!el) return;
  const uid = _pronoUid;
  const entries = Object.entries(_scores || {}).filter(([, p]) => p > 0);
  if (!entries.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  entries.sort((a, b) => b[1] - a[1]);
  // Il faut connaître le statut Twitch de TOUS les participants (pas
  // seulement le top affiché) pour appliquer correctement les seuils.
  ensureTwitchProfiles(entries.map(e => e[0]));

  const mine = uid ? (_scores[uid] || 0) : 0;
  const twitchEntries = entries.filter(([u]) => _twitchByUid[u]);
  const splitTwitch = entries.length >= WEEKEND_SPLIT_MIN && twitchEntries.length >= WEEKEND_SPLIT_MIN_TWITCH;

  let top, sub, shown;
  if (splitTwitch) {
    shown = twitchEntries.slice(0, WEEKEND_TOP_N);
    top = shown.map(([u, p], i) => scoreRowHtml(u, p, i, uid)).join('');
    const bestOther = entries.find(([u]) => !_twitchByUid[u]);
    sub = 'ce meeting · comptes Twitch';
    if (bestOther) {
      const [bu, bp] = bestOther;
      top += `<div class="ms-row${bu === uid ? ' me' : ''}" style="margin-top:6px;opacity:.85">`
        + `<span class="ms-pos">—</span><span class="ms-name">Meilleur non connecté : ${escName(pseudoFor(bu))}${bu === uid ? ' <span class="ms-you">(toi)</span>' : ''}</span>`
        + `<span class="ms-v">${bp} pt${bp > 1 ? 's' : ''}</span></div>`;
    }
  } else {
    shown = entries.slice(0, WEEKEND_TOP_N);
    top = shown.map(([u, p], i) => scoreRowHtml(u, p, i, uid)).join('');
    sub = 'ce meeting';
  }

  let mineLine;
  if (uid && mine > 0) {
    if (splitTwitch) {
      mineLine = _twitchByUid[uid]
        ? `Tes points : <b>${mine}</b> · ${twitchEntries.filter(([, p]) => p > mine).length + 1}ᵉ sur ${twitchEntries.length} (classement Twitch)`
        : `Tes points : <b>${mine}</b> — connecte-toi via Twitch pour apparaître au classement affiché.`;
    } else {
      mineLine = `Tes points : <b>${mine}</b> · ${entries.filter(([, p]) => p > mine).length + 1}ᵉ sur ${entries.length}`;
    }
  } else if (uid) {
    mineLine = `Tes points : <b>0</b> — trouve les gagnants pour marquer !`;
  } else {
    mineLine = `${entries.length} joueur${entries.length > 1 ? 's' : ''} en lice`;
  }

  el.style.display = '';
  el.innerHTML = `<div class="ms-head">🏆 Classement pronostics<span class="ms-sub">${sub}</span></div>`
    + `<div class="ms-mine">${mineLine}</div><div class="ms-top">${top}</div>`;
  ensurePseudos([...shown.map(e => e[0]), uid].filter(Boolean));
}

/** Affiche/masque le bouton "Mes pronostics" selon qu'une session existe ou non. */
function refreshHistoryToggle() {
  const wrap = document.getElementById('spc-history-wrap');
  if (wrap) wrap.style.display = _pronoUid ? '' : 'none';
}

/**
 * Historique personnel : pronostics révélés sur lesquels CE uid a voté (ne
 * remonte pas un éventuel historique antérieur à une connexion Twitch, cf.
 * doc de getMyPredictionHistory). Chargé à la demande (clic), pas en continu.
 */
async function renderMyHistory() {
  const box = document.getElementById('spc-history-list');
  if (!box || !_pronoUid) return;
  box.style.display = '';
  box.innerHTML = `<div class="ps-hint">Chargement…</div>`;
  try {
    const items = await getMyPredictionHistory(_pronoUid, selectedMeetingId);
    if (!items.length) { box.innerHTML = `<div class="ps-hint">Aucun pronostic révélé pour l'instant.</div>`; return; }
    box.innerHTML = items.map(it => {
      const icon = it.correct ? '✅' : '❌';
      const miss = it.correct ? '' : ` <span class="ps-hist-correct">(bon choix : ${escName(it.correctName)})</span>`;
      return `<div class="ps-hist-row"><span class="ps-hist-ic">${icon}</span>`
        + `<div class="ps-hist-txt"><div class="ps-hist-q">${escName(it.question)}</div>`
        + `<div class="ps-hist-pick">Ton choix : ${escName(it.myPickName)}${miss}</div></div></div>`;
    }).join('');
  } catch {
    box.innerHTML = `<div class="ps-hint">Impossible de charger ton historique pour l'instant.</div>`;
  }
}

/**
 * Affiche/actualise le bloc "ton pseudo / connexion Twitch" — INDÉPENDANT du
 * meeting sélectionné et de ses scores (c'est une propriété du compte, pas
 * de l'épreuve affichée). Sans ce découplage, tant qu'aucun meeting n'a de
 * points à afficher, ce bloc — et le seul moyen de se (re)connecter à
 * Twitch — disparaissait complètement.
 */
function refreshIdentityBox() {
  const pe = document.getElementById('spc-pseudo');
  if (!pe) return;
  if (!_pronoUid) { pe.style.display = 'none'; hideTwitchBadge(); return; }
  // Reconstruit aussi si un rendu précédent (fait AVANT que le statut Twitch
  // soit connu, ex. pendant que ensureTwitchProfiles était encore en vol)
  // avait figé l'éditeur sur "pas connecté" — sans ce rattrapage, le vrai
  // statut "connecté" pouvait ne jamais s'afficher, l'éditeur ne se
  // reconstruisant plus jamais une fois _pseudoEditorDone posé.
  const justLearnedConnected = !_pseudoEditorShowsConnected && !!_twitchByUid[_pronoUid];
  if (!_pseudoEditorDone || justLearnedConnected) renderPseudoEditor();
}

/** (Ré)abonne au classement saison (Twitch uniquement) du championnat courant. */
function watchSeasonFor(championshipId) {
  if (championshipId === _seasonChampId) return;
  if (_unsubSeason) { try { _unsubSeason(); } catch {} _unsubSeason = null; }
  _seasonChampId = championshipId || null;
  _seasonScores = {};
  renderSeasonTwitch();
  if (!championshipId) return;
  watchSeasonScores(championshipId, map => { _seasonScores = map || {}; renderSeasonTwitch(); }, () => {})
    .then(unsub => { if (_seasonChampId === championshipId) _unsubSeason = unsub; else { try { unsub(); } catch {} } })
    .catch(() => {});
}

/** Classement saison — comptes Twitch uniquement (jamais de compte anonyme, cf. updateSeasonTwitchScores). */
function renderSeasonTwitch() {
  const el = document.getElementById('spc-season-twitch');
  if (!el) return;
  const uid = _pronoUid;
  const entries = Object.entries(_seasonScores || {}).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  ensureTwitchProfiles(entries.map(e => e[0]));
  const mine = uid ? (_seasonScores[uid] || 0) : 0;
  const top = entries.slice(0, WEEKEND_TOP_N).map(([u, p], i) => scoreRowHtml(u, p, i, uid, true)).join('');
  const mineLine = (uid && mine > 0)
    ? `Tes points saison : <b>${mine}</b> · ${entries.filter(([, p]) => p > mine).length + 1}ᵉ sur ${entries.length}`
    : `${entries.length} compte${entries.length > 1 ? 's' : ''} Twitch classé${entries.length > 1 ? 's' : ''} cette saison`;
  el.style.display = '';
  el.innerHTML = `<div class="ms-head">🎮 Classement saison<span class="ms-sub">comptes Twitch</span></div>`
    + `<div class="ms-mine">${mineLine}</div><div class="ms-top">${top}</div>`;
  ensurePseudos(entries.slice(0, WEEKEND_TOP_N).map(e => e[0]));
}

// En dessous de ce nombre de pronostics faits, un ratio n'a aucun sens
// (un seul pronostic juste = 100%) — voir renderSeasonRatio.
const RATIO_MIN_TOTAL = 10;

/** (Ré)abonne au taux de réussite saison (Twitch uniquement) du championnat courant. */
function watchAccuracyFor(championshipId) {
  if (championshipId === _accuracyChampId) return;
  if (_unsubAccuracy) { try { _unsubAccuracy(); } catch {} _unsubAccuracy = null; }
  _accuracyChampId = championshipId || null;
  _seasonAccuracy = {};
  renderSeasonRatio();
  renderSeasonBold();
  if (!championshipId) return;
  watchSeasonAccuracy(championshipId, map => { _seasonAccuracy = map || {}; renderSeasonRatio(); renderSeasonBold(); }, () => {})
    .then(unsub => { if (_accuracyChampId === championshipId) _unsubAccuracy = unsub; else { try { unsub(); } catch {} } })
    .catch(() => {});
}

/** Classement « meilleur ratio » saison — comptes Twitch uniquement, minimum RATIO_MIN_TOTAL pronostics faits. */
function renderSeasonRatio() {
  const el = document.getElementById('spc-season-ratio');
  if (!el) return;
  const uid = _pronoUid;
  const entries = Object.entries(_seasonAccuracy || {})
    .map(([u, st]) => [u, st.correct || 0, st.total || 0])
    .filter(([, , total]) => total >= RATIO_MIN_TOTAL)
    .map(([u, correct, total]) => [u, correct, total, correct / total])
    // À % de réussite égal, celui qui a le PLUS de pronostics bons passe
    // devant (rester à 90% sur 45 pronostics vaut mieux que sur 10).
    .sort((a, b) => b[3] - a[3] || b[1] - a[1]);
  if (!entries.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  ensureTwitchProfiles(entries.map(e => e[0]));
  const mineIdx = entries.findIndex(([u]) => u === uid);
  const mineEntry = mineIdx >= 0 ? entries[mineIdx] : null;
  const mineLine = mineEntry
    ? `Ton ratio : <b>${Math.round(mineEntry[3] * 100)}%</b> (${mineEntry[1]}/${mineEntry[2]}) · ${mineIdx + 1}ᵉ sur ${entries.length}`
    : `${entries.length} compte${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} (min. ${RATIO_MIN_TOTAL} pronostics faits)`;
  const top = entries.slice(0, WEEKEND_TOP_N).map(([u, correct, total, ratio], i) =>
    `<div class="ms-row${u === uid ? ' me' : ''}"><span class="ms-pos">${RANK_BADGE[i] || (i + 1)}</span>`
    + `<span class="ms-name">${escName(pseudoFor(u))}${u === uid ? ' <span class="ms-you">(toi)</span>' : ''}</span>`
    + `<span class="ms-v">${Math.round(ratio * 100)}%<span style="opacity:.6;font-size:.8em"> (${correct}/${total})</span></span></div>`
  ).join('');
  el.style.display = '';
  el.innerHTML = `<div class="ms-head">🎯 Meilleur ratio<span class="ms-sub">min. ${RATIO_MIN_TOTAL} pronos</span></div>`
    + `<div class="ms-mine">${mineLine}</div><div class="ms-top">${top}</div>`;
  ensurePseudos(entries.slice(0, WEEKEND_TOP_N).map(e => e[0]));
}

// Sous ce nombre de bons pronostics, une moyenne d'audace n'a pas de sens
// (un seul coup risqué réussi = 100% audacieux). Volontairement plus bas
// que RATIO_MIN_TOTAL : ce n'est pas le même dénominateur (bons pronostics
// uniquement, pas tous les pronostics faits).
const BOLD_MIN_CORRECT = 5;

/**
 * Classement « plus audacieux » saison — comptes Twitch uniquement. Mesure,
 * PARMI ses bons pronostics, à quel point le public s'est en moyenne trompé
 * en même temps (cf. boldSum/boldCount, calculés dans updateMeetingScores à
 * partir de tally/totalVotes — le vote de TOUT LE PUBLIC, pas seulement les
 * comptes Twitch). Un score élevé = des bons pronostics que peu de monde
 * partageait, pas juste des favoris évidents.
 */
function renderSeasonBold() {
  const el = document.getElementById('spc-season-bold');
  if (!el) return;
  const uid = _pronoUid;
  const entries = Object.entries(_seasonAccuracy || {})
    .map(([u, st]) => [u, st.boldCount || 0, st.boldSum || 0])
    .filter(([, boldCount]) => boldCount >= BOLD_MIN_CORRECT)
    .map(([u, boldCount, boldSum]) => [u, boldCount, boldSum / boldCount])
    .sort((a, b) => b[2] - a[2] || b[1] - a[1]);
  if (!entries.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  ensureTwitchProfiles(entries.map(e => e[0]));
  const mineIdx = entries.findIndex(([u]) => u === uid);
  const mineEntry = mineIdx >= 0 ? entries[mineIdx] : null;
  const mineLine = mineEntry
    ? `Ton indice d'audace : <b>${Math.round(mineEntry[2] * 100)}%</b> · ${mineIdx + 1}ᵉ sur ${entries.length}`
    : `${entries.length} compte${entries.length > 1 ? 's' : ''} classé${entries.length > 1 ? 's' : ''} (min. ${BOLD_MIN_CORRECT} bons pronostics)`;
  const top = entries.slice(0, WEEKEND_TOP_N).map(([u, boldCount, avgBold], i) =>
    `<div class="ms-row${u === uid ? ' me' : ''}"><span class="ms-pos">${RANK_BADGE[i] || (i + 1)}</span>`
    + `<span class="ms-name">${escName(pseudoFor(u))}${u === uid ? ' <span class="ms-you">(toi)</span>' : ''}</span>`
    + `<span class="ms-v">${Math.round(avgBold * 100)}%<span style="opacity:.6;font-size:.8em"> (${boldCount} bons)</span></span></div>`
  ).join('');
  el.style.display = '';
  el.innerHTML = `<div class="ms-head">🎲 Plus audacieux<span class="ms-sub">min. ${BOLD_MIN_CORRECT} bons pronos</span></div>`
    + `<div class="ms-mine">${mineLine}</div><div class="ms-top">${top}</div>`;
  ensurePseudos(entries.slice(0, WEEKEND_TOP_N).map(e => e[0]));
}

/** Charge le vote déjà émis par ce spectateur pour chaque pronostic ouvert (si session prête). */
async function refreshMyVotes() {
  if (!_pronoUid) return;
  await Promise.all(_pronoDocs
    .filter(p => p.status === 'open' && !(p.id in _myVotes))
    .map(async p => { try { _myVotes[p.id] = await myVote(p.id, _pronoUid); } catch {} }));
}

function stopPronostics() {
  if (_unsubPronostics) { _unsubPronostics(); _unsubPronostics = null; }
}

async function onPronoClick(e) {
  const opt = e.target.closest('.spc-opt'); if (!opt) return;
  const pid = opt.dataset.pid, did = opt.dataset.did; if (!pid || !did) return;
  const p = _pronoDocs.find(x => x.id === pid);
  if (!p || p.status !== 'open') return;              // sécurité : plus de vote une fois fermé
  const prev = _myVotes[pid];
  if (prev === did) return;
  // Sélection optimiste IMMÉDIATE : l'UI répond au 1er tap, même si l'auth
  // anonyme ou l'écriture prennent un instant (ou échouent → on annule ensuite).
  _myVotes[pid] = did; delete _pronoErr[pid]; renderPronostics();
  try {
    if (!_pronoUid) _pronoUid = await ensureAnon();
    await castVote(pid, _pronoUid, did);
  } catch (err) {
    _myVotes[pid] = prev;                             // rollback si refus
    _pronoErr[pid] = voteErrMsg(err);
    console.error('[prono] vote refusé', err?.code, err?.message);
    renderPronostics();
  }
}

/** Message clair selon la cause de l'échec (aide au diagnostic côté spectateur). */
function voteErrMsg(err) {
  const code = err?.code || '';
  if (code === 'permission-denied')
    return 'Vote refusé par le serveur — règles Firestore à republier (permission-denied).';
  if (code.startsWith('auth/'))
    return `Connexion anonyme indisponible (${code}) — active « Anonyme » dans Firebase Auth.`;
  return `Vote impossible (${code || 'erreur'}). Réessaie.`;
}

function pronoCardHtml(p) {
  const icon = PRONO_ICON[p.type] || '🎯';
  const opts = Array.isArray(p.options) ? p.options : [];
  const head = `<div class="spc-pc-h"><span class="spc-pc-ic">${icon}</span><span class="spc-pc-q">${escHtml(p.question || '')}</span></div>
    <div class="spc-pc-meta"><span class="spc-pc-cat">${escHtml(p.category || '')}</span><span class="spc-pbadge ${p.status}">${PRONO_STATUS_FR[p.status] || p.status}</span></div>`;

  // ── Vote ouvert : options seules, aucun score ──
  if (p.status === 'open') {
    const mine = _myVotes[p.id] || '';
    const rows = opts.map(o => `<button class="spc-opt ${o.driverId === mine ? 'sel' : ''}" data-pid="${escHtml(p.id)}" data-did="${escHtml(o.driverId)}">
      <span class="spc-rn">${escHtml(String(o.num ?? ''))}</span><span class="spc-nm">${escHtml((o.name || '').toUpperCase())}</span><span class="spc-rd"></span></button>`).join('');
    const err = _pronoErr[p.id];
    const hint = err
      ? `<div class="spc-pc-hint spc-pc-err">⚠️ ${escHtml(err)}</div>`
      : `<div class="spc-pc-hint">${mine ? "✅ Vote enregistré — modifiable tant que c'est ouvert." : 'Touche un pilote pour voter (facultatif).'}</div>`;
    return `<div class="spc-pcard open">${head}${rows}${hint}</div>`;
  }

  // ── Vote fermé / révélé : tendances ──
  const counts = p.tally || {};
  const total  = p.totalVotes || opts.reduce((s, o) => s + (counts[o.driverId] || 0), 0);
  const mine   = _myVotes[p.id] || '';
  const rows   = opts.map(o => ({ o, c: counts[o.driverId] || 0 })).sort((a, b) => b.c - a.c);
  const bars = rows.map(r => {
    const pct    = total ? Math.round(r.c / total * 100) : 0;
    const isMine = r.o.driverId === mine;
    const isWin  = p.status === 'revealed' && p.correctDriverId === r.o.driverId;
    const tags   = `${isWin ? '<span class="spc-tag ok">✓</span>' : ''}${isMine ? '<span class="spc-tag mine">Toi</span>' : ''}`;
    return `<div class="spc-bar ${isMine ? 'mine' : ''} ${isWin ? 'correct' : ''}"><span class="spc-fill" style="width:${pct}%"></span>
      <span class="spc-rn">${escHtml(String(r.o.num ?? ''))}</span><span class="spc-nm">${escHtml((r.o.name || '').toUpperCase())}${tags}</span><span class="spc-pct">${pct}%<span class="spc-cnt">${r.c} vote${r.c > 1 ? 's' : ''}</span></span></div>`;
  }).join('');
  let verdict = '';
  if (p.status === 'revealed' && mine) {
    const ok = mine === p.correctDriverId;
    verdict = `<div class="spc-verdict ${ok ? 'ok' : 'ko'}">${ok ? '🎉 Bien vu, tu avais raison !' : '😅 Raté cette fois !'}</div>`;
  }
  return `<div class="spc-pcard ${p.status}">${head}${bars}${verdict}</div>`;
}

function renderPronostics() {
  const box     = document.getElementById('spc-pronostics');       // haut : sondages EN COURS
  const pastBox = document.getElementById('spc-pronostics-past');   // bas  : résultats RÉVÉLÉS
  if (!box) return;
  watchScoresFor(selectedMeetingId);   // suit le classement pronostiqueurs de l'épreuve affichée
  const currentChampId = (allMeetings.find(m => m.id === selectedMeetingId) || {}).championshipId || getActiveChampionshipId();
  watchSeasonFor(currentChampId);
  watchAccuracyFor(currentChampId);
  // Cycle de vie côté spectateur (identique avec ou sans catégorie) :
  //  • OUVERT   → visible EN HAUT, on peut voter (appel à voter dès l'arrivée) ;
  //  • VOTES CLOS → MASQUÉ (la session est en cours, résultat pas encore révélé)
  //    → le pronostic « disparaît » pendant la course ;
  //  • RÉSULTAT (révélé par la régie) → visible EN BAS, SOUS les classements, pour
  //    que les gens voient l'issue sans que ça pousse les classements vers le bas.
  // Une catégorie sélectionnée ne fait que restreindre à cette catégorie.
  let docs = _pronoDocs.filter(p =>
    p.meetingId === selectedMeetingId &&
    (p.status === 'open' || p.status === 'revealed'));
  if (selectedCategory) docs = docs.filter(p => p.category === selectedCategory);
  const byRecent = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

  // EN COURS → en haut
  const open = docs.filter(p => p.status === 'open').sort(byRecent);
  if (open.length) {
    box.style.display = '';
    box.innerHTML = `<div class="spc-prono-sect">🎯 Pronostics<span class="spc-prono-count">${open.length} ouvert${open.length > 1 ? 's' : ''}</span></div>`
      + open.map(pronoCardHtml).join('');
  } else {
    box.innerHTML = ''; box.style.display = 'none';
  }

  // RÉVÉLÉS (résultats) → en bas, après les classements
  if (pastBox) {
    const past = docs.filter(p => p.status === 'revealed').sort(byRecent);
    if (past.length) {
      pastBox.style.display = '';
      pastBox.innerHTML = `<div class="spc-prono-sect">🏁 Résultats des pronostics</div>`
        + past.map(pronoCardHtml).join('');
    } else {
      pastBox.innerHTML = ''; pastBox.style.display = 'none';
    }
  }
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('spc-year')?.addEventListener('change', async e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    await loadMeetings();
    renderPronostics();             // re-filtre (meeting réinitialisé)
  });
  document.getElementById('spc-meeting')?.addEventListener('change', async e => {
    selectedMeetingId = e.target.value;
    renderPronostics();             // re-filtre par event sélectionné
    await renderContent();
    // Si "Mes pronostics" est déjà ouvert, le recharger pour le nouveau
    // meeting — sinon il resterait affiché sur l'épreuve précédente.
    const histBox = document.getElementById('spc-history-list');
    if (histBox && histBox.style.display !== 'none') renderMyHistory();
  });
  document.getElementById('spc-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    renderPronostics();             // focus catégorie (ou toutes si vide)
    await renderContent();
  });

  document.getElementById('spc-history-toggle')?.addEventListener('click', () => {
    const box = document.getElementById('spc-history-list');
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    renderMyHistory();
  });

  document.getElementById('spc-fullscreen-btn')?.addEventListener('click', () => {
    applyFullscreen(!_isFullscreen);
    const toolbar = document.getElementById('spc-toolbar');
    if (toolbar) toolbar.classList.toggle('spc-toolbar-hidden', _isFullscreen);
    const header = document.querySelector('.spc-header');
    if (header && _isFullscreen) header.style.padding = 'var(--sp-sm) var(--sp-md)';
    else if (header) header.style.padding = '';
  });
}

// ─────────────────────────────────────────────────────────
// CARROUSEL AUTO — seul maître du rendu visuel
// ─────────────────────────────────────────────────────────

function startCarousel() {
  stopCarousel();
  renderCarouselSlide();
  _carouselTimer = setInterval(() => {
    const total = getCarouselTotal();
    _carouselSlide = (_carouselSlide + 1) % total;
    renderCarouselSlide();
  }, 20000);
}

function stopCarousel() {
  if (_carouselTimer) { clearInterval(_carouselTimer); _carouselTimer = null; }
  stopAllScrolls();
}

function stopAllScrolls() {
  if (_dfScrollTimer)     { clearTimeout(_dfScrollTimer);             _dfScrollTimer     = null; }
  if (_stickyScrollTimer) { clearTimeout(_stickyScrollTimer);         _stickyScrollTimer = null; }
  if (_stickyAnimFrameId) { cancelAnimationFrame(_stickyAnimFrameId); _stickyAnimFrameId = null; }
  if (_stickyPauseTimer)  { clearTimeout(_stickyPauseTimer);          _stickyPauseTimer  = null; }
  _dfScrollPhase = 0;
}

function getCarouselTotal() {
  const phase = _carouselData.phase;
  if (phase === 'FIN' || phase === 'DF1' || phase === 'DF2') return 1;

  const hasEc = (_carouselData.ecResults || []).filter(r => r.ms).length > 0;
  const hasMq = (_carouselData.mqResults || []).length > 0;
  if (!hasMq) return 1;

  const currentMqNum = allSessions
    .filter(s => s.type === 'MQ')
    .filter(s => (_carouselData.sessionResults?.[s.id] || []).length > 0)
    .reduce((max, s) => Math.max(max, s.num ?? 0), 0);

  return currentMqNum <= 1 ? 1 : 2;
}

function detectPhase() {
  const hasResults = (sid) => (_carouselData.sessionResults || {})[sid]?.length > 0;
  const fin  = allSessions.find(s => s.type === 'FIN');
  const df2  = allSessions.find(s => s.type === 'DF' && s.num === 2);
  const df1  = allSessions.find(s => s.type === 'DF' && s.num === 1);
  if (fin  && hasResults(fin.id))  return 'FIN';
  if (df2  && hasResults(df2.id))  return 'DF2';
  if (df1  && hasResults(df1.id))  return 'DF1';
  return 'MQ';
}

function renderCarouselSlide() {
  const block = document.getElementById('spc-carousel-block');
  if (!block) return;

  // Arrêter les scrolls en cours avant de re-rendre
  stopAllScrolls();

  const phase = _carouselData.phase || 'MQ';
  const total = getCarouselTotal();

  const indicators = total > 1 ? `
    <div class="spc-carousel-indicators">
      ${Array.from({length: total}, (_, i) =>
        `<span class="spc-carousel-dot ${i === _carouselSlide ? 'is-active' : ''}"></span>`
      ).join('')}
    </div>` : '';

  let html = '';

  if (phase === 'MQ') {
    const hasMq = (_carouselData.mqResults || []).length > 0;
    const champ0 = getActiveChampionship();
    const ecEnabled = champ0?.sessionConfig?.EC?.enabled !== false;
    const hasEcData = ecEnabled && (_carouselData.ecResults || []).filter(r => r.ms).length > 0;
    if (!hasMq) {
      if (hasEcData) {
        html = buildStickySlide(
          (_carouselData.ecResults || []).filter(r => r.ms).sort((a,b) => a.ms - b.ms),
          '⏱️ Essais chronométrés — Top 10', 'ec', true
        );
      } else {
        html = '<div class="spc-card"><div class="spc-empty">En attente des premiers resultats...</div></div>';
      }
    } else if (_carouselSlide === 0) {
      html = buildStickySlide(
        sortResults(_carouselData.mqResults || []),
        `🏁 ${_carouselData.mqLabel || 'Manche qualificative'}`, 'mq', false
      );
    } else {
      html = buildStickySlide(
        _carouselData.interimRows || [],
        '🏆 Classement intermédiaire', 'interim', false, true
      );
    }
  }
  else if (phase === 'DF1') html = buildDfCombinedSlide('DF1');
  else if (phase === 'DF2') html = buildDfCombinedSlide('DF2');
  else if (phase === 'FIN') html = buildFinCombinedSlide();

  block.innerHTML = indicators + html;
  startCountdown();

  // Démarrer le scroll APRÈS que le DOM soit prêt
  if (phase === 'MQ') {
    setTimeout(() => startStickyScroll(), 150);
  } else if (phase === 'DF1' || phase === 'DF2' || phase === 'FIN') {
    setTimeout(() => startDfAutoScroll(), 150);
  }
}

// ─────────────────────────────────────────────────────────
// SCROLL STICKY TOP 5
// Variables module — annulation fiable via stopAllScrolls()
// ─────────────────────────────────────────────────────────

function startStickyScroll() {
  const scrollable = document.querySelector('.spc-sticky-scroll');
  if (!scrollable) return;

  const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
  if (maxScroll <= 10) return;

  // px à avancer par frame pour parcourir maxScroll en 15s à ~60fps
  const pxPerFrame = maxScroll / (14 * 60);

  function scrollDown() {
    const el = document.querySelector('.spc-sticky-scroll');
    if (!el) return;

    if (el.scrollTop < el.scrollHeight - el.clientHeight - 1) {
      el.scrollTop += pxPerFrame;
      _stickyAnimFrameId = requestAnimationFrame(scrollDown);
    } else {
      // Pause 3s en bas
      _stickyPauseTimer = setTimeout(() => {
        const e2 = document.querySelector('.spc-sticky-scroll');
        if (e2) e2.scrollTop = 0;
        // Pause 3s en haut puis recommence
        _stickyPauseTimer = setTimeout(() => {
          _stickyAnimFrameId = requestAnimationFrame(scrollDown);
        }, 3000);
      }, 3000);
    }
  }

  // Pause initiale de 3s pour lire le top 5
  _stickyScrollTimer = setTimeout(() => {
    _stickyAnimFrameId = requestAnimationFrame(scrollDown);
  }, 3000);
}

// ─────────────────────────────────────────────────────────
// SCROLL DF / FINALE
// ─────────────────────────────────────────────────────────

function startDfAutoScroll() {
  const container = document.querySelector('.spc-df-combined');
  if (!container) return;
  if (_carouselData.phase === 'FIN') startFinaleAutoScroll();
  else startDfStickyScroll();
}

function startFinaleAutoScroll() {
  function scrollStep() {
    const c = document.querySelector('.spc-df-combined');
    if (!c) return;
    const maxScroll  = c.scrollHeight - c.clientHeight;
    const current    = c.scrollTop;
    const pageHeight = c.clientHeight;
    if (_dfScrollPhase === 0) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = maxScroll > 10 ? 1 : 3; scrollStep(); }, 15000);
    } else if (_dfScrollPhase === 1) {
      const nextTop = Math.min(current + pageHeight, maxScroll);
      c.scrollTo({ top: nextTop, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = nextTop < maxScroll - 10 ? 1 : 3; scrollStep(); }, 15000);
    } else if (_dfScrollPhase === 3) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = 0; scrollStep(); }, 4000);
    }
  }
  _dfScrollTimer = setTimeout(scrollStep, 500);
}

function startDfStickyScroll() {
  const rest    = document.querySelector('.spc-df-rest');
  const hasRest = rest && rest.children.length > 0;
  function scrollToPhase() {
    const c = document.querySelector('.spc-df-combined');
    if (!c) return;
    if (_dfScrollPhase === 0) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = 1; scrollToPhase(); }, 15000);
    } else if (_dfScrollPhase === 1) {
      const stickyEl = c.querySelector('.spc-df-cumul-sticky');
      if (stickyEl) c.scrollTo({ top: stickyEl.offsetTop, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = hasRest ? 2 : 3; scrollToPhase(); }, 15000);
    } else if (_dfScrollPhase === 2) {
      c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = 3; scrollToPhase(); }, 15000);
    } else if (_dfScrollPhase === 3) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = 0; scrollToPhase(); }, 4000);
    }
  }
  _dfScrollTimer = setTimeout(scrollToPhase, 500);
}

// ─────────────────────────────────────────────────────────
// BUILDERS DE SLIDES
// ─────────────────────────────────────────────────────────

function sortResults(results) {
  return [...results].sort((a, b) => {
    const aS = ['DNS','DSQ'].includes(a.status);
    const bS = ['DNS','DSQ'].includes(b.status);
    if (aS && !bS) return 1;
    if (!aS && bS) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });
}

function statusLabel(r) {
  if (!r.status) return '';
  const lbl = r.status === 'DSQ_RACE' ? 'DSQ EC' : r.status === 'DSQ' ? 'DSQ HC' : r.status;
  return `<span class="spc-status-badge">${lbl}</span>`;
}

function buildStickySlide(rows, title, type, showBonus = false, isInterim = false) {
  const top5 = rows.slice(0, 5);
  const rest = rows.slice(5);

  const renderRow = (r, i, isTop = false) => {
    const pos     = isInterim ? r.position : (r.ms ? i + 1 : '—');
    const timeVal = isInterim
      ? `<span class="spc-carousel-pts">${r.totalPoints} pts</span>`
      : r.ms
        ? `<span class="spc-carousel-time">${msToDisplay(r.ms)}</span>`
        : statusLabel(r);
    const bonus = showBonus && i < 5
      ? `<span class="spc-ec-bonus">+${5 - i} pts</span>`
      : '';
    return `
      <div class="spc-carousel-row ${i === 0 && isTop ? 'spc-carousel-row--first' : ''}">
        <span class="spc-carousel-pos">${pos}</span>
        <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
        <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
        ${timeVal}${bonus}
      </div>`;
  };

  return `
    <div class="spc-carousel-slide spc-carousel-slide--${type}">
      <div class="spc-carousel-title">
        ${escHtml(title)}
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${showBonus ? `<div class="spc-ec-note">★ Top 5 : bonus points (+5/+4/+3/+2/+1) ajoutés au classement intermédiaire</div>` : ''}
      ${rows.length === 0
        ? `<div class="spc-carousel-empty">En attente des résultats…</div>`
        : `<div class="spc-sticky-top5">
            ${top5.map((r, i) => renderRow(r, i, true)).join('')}
           </div>
           ${rest.length > 0
             ? `<div class="spc-sticky-scroll">${rest.map((r, i) => renderRow(r, i + 5, false)).join('')}</div>`
             : ''}`}
    </div>`;
}

function buildDfCombinedSlide(phase) {
  const dfNum  = phase === 'DF1' ? 1 : 2;
  const dfRes  = sortResults(_carouselData[`df${dfNum}Results`] || []);
  const DF_PTS = [0,10,8,6,5,4,3,2,1];

  const interim  = _carouselData.interimRows || [];
  const df1Res   = sortResults(_carouselData.df1Results || []);
  const df2Res   = sortResults(_carouselData.df2Results || []);
  const dfPtsMap = {};
  const addDfPts = (res) => res.forEach((r, i) => {
    if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[i+1]||0);
    else if (r.status === 'DNF' && r.manualPosition)
      dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[r.manualPosition]||0);
  });
  addDfPts(df1Res);
  if (phase === 'DF2') addDfPts(df2Res);

  const rows  = interim.map(r => ({
    ...r,
    interimPts: r.interimPoints ?? 0,
    dfPts:      dfPtsMap[r.carNumber] || 0,
    grandTotal: (r.interimPoints ?? 0) + (dfPtsMap[r.carNumber] || 0),
  })).sort((a, b) => b.grandTotal - a.grandTotal);

  const top16 = rows.slice(0, 16);
  const rest  = rows.slice(16);
  const title = phase === 'DF1' ? 'Classement après DF1' : 'Classement après DF1 & DF2';

  return `
    <div class="spc-carousel-slide spc-carousel-slide--df spc-df-combined">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏁</span>
        Demi-finale ${dfNum}
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      <div class="spc-df-results-section">
        <div class="spc-df-section-title">🏁 Demi-finale ${dfNum}</div>
        ${dfRes.length === 0
          ? `<div class="spc-carousel-empty">En attente des résultats…</div>`
          : dfRes.map((r, i) => `
            <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
              <span class="spc-carousel-pos">${r.ms ? i + 1 : '—'}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-carousel-time">${r.ms ? msToDisplay(r.ms) : statusLabel(r)}</span>
            </div>`).join('')}
      </div>
      <div class="spc-df-cumul-sticky">
        <div class="spc-df-section-title">📊 ${title}</div>
        <div class="spc-cumul-headers">
          <span class="spc-cumul-hdr">Inter.</span>
          <span class="spc-cumul-hdr">DF</span>
          <span class="spc-cumul-hdr spc-cumul-hdr--total">Total</span>
        </div>
        ${top16.map((r, i) => `
          <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
            <span class="spc-carousel-pos">${i + 1}</span>
            <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
            <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
            <span class="spc-cumul-pts">${r.interimPts || '—'}</span>
            <span class="spc-cumul-pts">${r.dfPts || '—'}</span>
            <span class="spc-cumul-pts spc-cumul-pts--total">${r.grandTotal}</span>
          </div>`).join('')}
      </div>
      ${rest.length > 0 ? `
        <div class="spc-df-rest">
          ${rest.map((r, i) => `
            <div class="spc-carousel-row">
              <span class="spc-carousel-pos">${17 + i}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-cumul-pts">${r.interimPts || '—'}</span>
              <span class="spc-cumul-pts">${r.dfPts || '—'}</span>
              <span class="spc-cumul-pts spc-cumul-pts--total">${r.grandTotal}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}

function buildFinCombinedSlide() {
  const finRes  = sortResults(_carouselData.finResults  || []);
  const interim = _carouselData.interimRows || [];
  const df1Res  = sortResults(_carouselData.df1Results  || []);
  const df2Res  = sortResults(_carouselData.df2Results  || []);
  const DF_PTS  = [0,10,8,6,5,4,3,2,1];
  const FIN_PTS = [0,15,12,9,7,6,5,4,3];

  const dfPtsMap = {};
  df1Res.forEach((r, i) => { if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[i+1]||0); });
  df2Res.forEach((r, i) => { if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[i+1]||0); });

  const finPtsMap = {};
  finRes.forEach((r, i) => {
    if (r.ms) finPtsMap[r.carNumber] = FIN_PTS[i+1] || 0;
    else if (r.status === 'DNF' && r.manualPosition) finPtsMap[r.carNumber] = FIN_PTS[r.manualPosition] || 0;
  });

  const rows = interim.map(r => {
    const interimPts = r.interimPoints ?? 0;
    const dfPts      = dfPtsMap[r.carNumber]  || 0;
    const finPts     = finPtsMap[r.carNumber] || 0;
    return { ...r, interimPts, dfPts, finPts, grandTotal: interimPts + dfPts + finPts };
  }).sort((a, b) => b.grandTotal - a.grandTotal);

  return `
    <div class="spc-carousel-slide spc-carousel-slide--fin spc-df-combined">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏆</span>
        Finale
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      <div class="spc-df-results-section">
        <div class="spc-df-section-title">🏆 Finale</div>
        ${finRes.length === 0
          ? `<div class="spc-carousel-empty">En attente des résultats…</div>`
          : finRes.map((r, i) => `
            <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
              <span class="spc-carousel-pos">${r.ms ? i + 1 : '—'}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-carousel-time">${r.ms ? msToDisplay(r.ms) : statusLabel(r)}</span>
            </div>`).join('')}
      </div>
      ${rows.length === 0 ? '' : `
        <div class="spc-df-meeting-section">
          <div class="spc-df-section-title">🥇 Classement du meeting</div>
          <div class="spc-cumul-headers">
            <span class="spc-cumul-hdr">Inter.</span>
            <span class="spc-cumul-hdr">DF</span>
            <span class="spc-cumul-hdr">Fin.</span>
            <span class="spc-cumul-hdr spc-cumul-hdr--total">Total</span>
          </div>
          ${rows.map((r, i) => `
            <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
              <span class="spc-carousel-pos">${i + 1}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-cumul-pts">${r.interimPts || '—'}</span>
              <span class="spc-cumul-pts">${r.dfPts      || '—'}</span>
              <span class="spc-cumul-pts">${r.finPts     || '—'}</span>
              <span class="spc-cumul-pts spc-cumul-pts--total">${r.grandTotal}</span>
            </div>`).join('')}
        </div>`}
    </div>`;
}

function startCountdown() {
  let remaining = 20;
  const update = () => {
    const el = document.getElementById('spc-ctimer');
    if (el) el.textContent = `${remaining}s`;
    remaining--;
  };
  update();
  const t = setInterval(() => {
    if (remaining < 0) { clearInterval(t); return; }
    update();
  }, 1000);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initSpectator() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'spectator') {
      // Parse URL params for deep-linking
      const params = parseSpectatorParams();
      if (params.meeting) selectedMeetingId = params.meeting;
      if (params.category) selectedCategory = params.category;
      if (params.fullscreen === '1') applyFullscreen(true);

      renderView();
      initPronostics();               // pronostics (indépendant du meeting/catégorie sélectionnés)
      await loadMeetings();

      // Auto-detect year from meeting if deep-linked
      if (selectedMeetingId && allMeetings.length > 0) {
        const m = allMeetings.find(x => x.id === selectedMeetingId);
        if (m?.year && m.year !== selectedYear) {
          selectedYear = m.year;
          await loadMeetings();
        }
        refreshMeetingSelect();
        // Sync dropdown
        const meetSel = document.getElementById('spc-meeting');
        if (meetSel) meetSel.value = selectedMeetingId;
        const catSel = document.getElementById('spc-category');
        if (catSel) catSel.value = selectedCategory;
      }

      startRefresh();
      if (selectedMeetingId && selectedCategory) await renderContent();
    } else {
      stopRefresh();
      stopCarousel();
      stopPronostics();
      if (_isFullscreen) applyFullscreen(false);
    }
  });
}