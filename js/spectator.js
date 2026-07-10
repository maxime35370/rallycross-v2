/* ═══════════════════════════════════════════════
   SPECTATOR.JS — Mode spectateur temps réel
   Lecture seule, rafraîchissement auto
   Optimisé mobile/tablette
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { msToDisplay, escHtml } from './utils.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';
import { watchPronostics, myVote, castVote, ensureAnon } from '../overlay/_lib/obs-pronostics.js';

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

  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(collection(db, 'results'), where('sessionId', '==', sessionId));
  unsubResults = onSnapshot(q, snap => {
    const results = snap.docs.map(d => d.data());
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

async function refreshInterimLive() {
  if (!selectedMeetingId || !selectedCategory || !allSessions.length) return;
  try {
    const { calcInterimStandings } = await import('./calc.js');
    const rows = await calcInterimStandings(db, allSessions);
    // Mise à jour des données uniquement — pas de re-render
    _carouselData.interimRows = rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    updateTimestamp();
  } catch {}
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
      <div class="spc-live-dot" id="spc-live-dot" title="Mise à jour automatique">
        <span class="spc-dot"></span>
        <span class="spc-live-label">LIVE</span>
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

    <div id="spc-pronostics" class="spc-pronostics" style="display:none"></div>

    <div id="spc-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">📺</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>
    </div>
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

  // Reset complet
  _carouselData = { mqResults: [], mqLabel: '', interimRows: [], ecResults: [], sessionResults: {} };
  _carouselSlide = 0;

  await loadSessions();

  const sessionResults = await Promise.all(
    allSessions.map(async s => {
      const res = await fsQuery('results', [['sessionId', '==', s.id]]);
      return { session: s, count: res.length, results: res };
    })
  );

  const withResults    = sessionResults.filter(sr => sr.count > 0);
  const currentSR      = withResults[withResults.length - 1] || null;
  const currentSession = currentSR?.session || null;

  // Pré-charger toutes les données avant d'afficher
  const sessionResultsMap = {};
  for (const s of allSessions) {
    const res = await fsQuery('results', [['sessionId','==',s.id]]);
    sessionResultsMap[s.id] = res;
    if (s.type === 'EC'  && res.length > 0) _carouselData.ecResults = res;
    if (s.type === 'MQ'  && res.length > 0) { _carouselData.mqResults = res; _carouselData.mqLabel = `Manche qualificative ${s.num}`; }
    if (s.type === 'DF'  && res.length > 0) { _carouselData[`df${s.num}Results`] = res; }
    if (s.type === 'FIN' && res.length > 0) _carouselData.finResults = res;
  }
  _carouselData.sessionResults = sessionResultsMap;
  _carouselData.phase = detectPhase();

  // Classement intermédiaire initial
  await refreshInterimLive();

  // Afficher la structure HTML
  content.innerHTML = `
    <div id="spc-carousel-block"></div>
    <div class="spc-updated" id="spc-timestamp">En attente de données…</div>
  `;

  // Abonnements live (mettent à jour _carouselData uniquement)
  if (currentSession) await subscribeResults(currentSession.id);
  await subscribeAdvancedSessions();

  // Refresh intermédiaire toutes les 30s (données uniquement)
  if (_interimRefreshTimer) clearInterval(_interimRefreshTimer);
  _interimRefreshTimer = setInterval(refreshInterimLive, 30000);

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
        const res = await fsQuery('results', [['sessionId', '==', df.id]]);
        res.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms).forEach((r, i) => {
          if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
          pointsMap[r.driverId].total += DF_PTS[i + 1] ?? 0;
        });
      }

      const finSession = meetingSessions.find(s => s.type === 'FIN');
      if (finSession) {
        const res = await fsQuery('results', [['sessionId', '==', finSession.id]]);
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
  if (_interimRefreshTimer) { clearInterval(_interimRefreshTimer); _interimRefreshTimer = null; }
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

const PRONO_ICON      = { manche_winner: '🏆', interim_m2: '📊', ec_best: '⏱️', serie_winner: '🏁', final_winner: '🏆', custom: '🎯' };
const PRONO_STATUS_FR = { open: 'Ouvert', closed: 'Votes clos', revealed: 'Résultat' };

async function initPronostics() {
  if (_unsubPronostics) return;                       // déjà abonné
  if (!_pronoClickBound) { document.addEventListener('click', onPronoClick); _pronoClickBound = true; }

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
    .then(async uid => { _pronoUid = uid; await refreshMyVotes(); renderPronostics(); })
    .catch(() => { _pronoUid = null; });
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
      <span class="spc-rn">${escHtml(String(r.o.num ?? ''))}</span><span class="spc-nm">${escHtml((r.o.name || '').toUpperCase())}${tags}</span><span class="spc-pct">${pct}%</span></div>`;
  }).join('');
  let verdict = '';
  if (p.status === 'revealed' && mine) {
    const ok = mine === p.correctDriverId;
    verdict = `<div class="spc-verdict ${ok ? 'ok' : 'ko'}">${ok ? '🎉 Bien vu, tu avais raison !' : '😅 Raté cette fois !'}</div>`;
  }
  return `<div class="spc-pcard ${p.status}">${head}${bars}${verdict}</div>`;
}

function renderPronostics() {
  const box = document.getElementById('spc-pronostics');
  if (!box) return;
  // Pronostics du meeting sélectionné :
  //  • une catégorie est choisie → tous les pronostics de cette catégorie
  //    (votes ouverts ET résultats) — cohérent avec la catégorie affichée ;
  //  • aucune catégorie → seulement les votes OUVERTS en cours (toutes catégories)
  //    pour ne pas empiler tous les résultats passés du meeting.
  let docs = _pronoDocs.filter(p => p.meetingId === selectedMeetingId);
  docs = selectedCategory
    ? docs.filter(p => p.category === selectedCategory)
    : docs.filter(p => p.status === 'open');
  const rank = p => (p.status === 'open' ? 0 : p.status === 'closed' ? 1 : 2);
  const ordered = [...docs].sort((a, b) => rank(a) - rank(b) || (b.createdAt || 0) - (a.createdAt || 0));
  if (!ordered.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  const nOpen = ordered.filter(p => p.status === 'open').length;
  box.style.display = '';
  box.innerHTML = `<div class="spc-prono-sect">🎯 Pronostics${nOpen ? `<span class="spc-prono-count">${nOpen} ouvert${nOpen > 1 ? 's' : ''}</span>` : ''}</div>`
    + ordered.map(pronoCardHtml).join('');
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
  });
  document.getElementById('spc-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    renderPronostics();             // focus catégorie (ou toutes si vide)
    await renderContent();
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