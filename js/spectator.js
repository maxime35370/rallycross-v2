/* ═══════════════════════════════════════════════
   SPECTATOR.JS — Mode spectateur temps réel
   Lecture seule, rafraîchissement auto
   Optimisé mobile/tablette
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { msToDisplay, escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let allMeetings       = [];
let allSessions       = [];
let unsubResults      = null;
let lastResults       = [];

let _interimRefreshTimer = null;

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

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
  allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
// ─────────────────────────────────────────────────────────

async function subscribeResults(sessionId) {
  if (unsubResults) { unsubResults(); unsubResults = null; }
  if (!db || !sessionId) return;

  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(collection(db, 'results'), where('sessionId', '==', sessionId));
  unsubResults = onSnapshot(q, snap => {
    lastResults = snap.docs.map(d => d.data());
    const session = allSessions.find(s => s.id === sessionId);

    if (session?.type === 'MQ') {
      _carouselData.mqResults = lastResults;
      _carouselData.mqLabel   = `Manche qualificative ${session.num}`;
    }
    if (session?.type === 'EC') {
      _carouselData.ecResults = lastResults;
    }

    // Refresh immédiat si on est sur la slide des résultats (slide 0)
    if (_carouselSlide === 0) {
      renderCarouselSlide();
    }

    updateTimestamp();
  });
}

async function refreshInterimLive() {
  if (!selectedMeetingId || !selectedCategory || !allSessions.length) return;
  try {
    const { calcInterimStandings } = await import('./calc.js');
    const rows = await calcInterimStandings(db, allSessions);
    const sorted = rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    _carouselData.interimRows = sorted;
    // Refresh immédiat si on est sur la slide intermédiaire
    if (_carouselSlide === 1) {
      renderCarouselSlide();
    }
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

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm);margin-bottom:var(--sp-md)">
      <select class="toolbar-select" id="spc-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="spc-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="spc-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

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

  // Reset complet des données
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

  if (currentSession) await subscribeResults(currentSession.id);

  content.innerHTML = `
    <div id="spc-carousel-block"></div>
    <div class="spc-updated" id="spc-timestamp">En attente de données…</div>
  `;

  await refreshInterimLive();
  if (_interimRefreshTimer) clearInterval(_interimRefreshTimer);
  _interimRefreshTimer = setInterval(refreshInterimLive, 30000);

  const sessionResultsMap = {};
  for (const s of allSessions) {
    const res = await fsQuery('results', [['sessionId','==',s.id]]);
    sessionResultsMap[s.id] = res;
    if (s.type === 'EC' && res.length > 0) _carouselData.ecResults = res;
    if (s.type === 'MQ' && res.length > 0) {
      _carouselData.mqResults = res;
      _carouselData.mqLabel   = `Manche qualificative ${s.num}`;
    }
    if (s.type === 'DF' && res.length > 0) {
      _carouselData[`df${s.num}Results`] = res;
      _carouselData[`df${s.num}Label`]   = `Demi-finale ${s.num}`;
    }
    if (s.type === 'FIN' && res.length > 0) _carouselData.finResults = res;
  }
  _carouselData.sessionResults = sessionResultsMap;
  _carouselData.phase = detectPhase();

  await subscribeAdvancedSessions();
  loadChampionshipData();
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
      const newPhase = detectPhase();
      if (newPhase !== _carouselData.phase) {
        _carouselData.phase = newPhase;
        _carouselSlide = 0;
      }
      if (s.type === 'DF') {
        _carouselData[`df${s.num}Results`] = results;
      } else if (s.type === 'FIN') {
        _carouselData.finResults = results;
      }
      if (_carouselSlide === 0) renderCarouselSlide();
      updateTimestamp();
    });
  }
}

// ─────────────────────────────────────────────────────────
// GESTION DES LISTENERS / ÉTAT CARROUSEL
// ─────────────────────────────────────────────────────────

let unsubNextParts    = null;
let _carouselTimer    = null;
let _carouselSlide    = 0;
let _carouselData     = { mqResults: [], mqLabel: '', interimRows: [], ecResults: [], sessionResults: {} };
let _dfScrollTimer    = null;
let _dfScrollPhase    = 0;
let _stickyScrollTimer = null; // scroll sticky pour EC/MQ/interim

function startRefresh() {
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.add('spc-live-dot--active');
}

function stopRefresh() {
  if (unsubResults)          { unsubResults();   unsubResults   = null; }
  if (unsubNextParts)        { unsubNextParts(); unsubNextParts = null; }
  if (_interimRefreshTimer)  { clearInterval(_interimRefreshTimer); _interimRefreshTimer = null; }
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.remove('spc-live-dot--active');
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('spc-year')?.addEventListener('change', async e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    await loadMeetings();
  });
  document.getElementById('spc-meeting')?.addEventListener('change', async e => {
    selectedMeetingId = e.target.value;
    await renderContent();
  });
  document.getElementById('spc-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    await renderContent();
  });
}

// ─────────────────────────────────────────────────────────
// CARROUSEL AUTO
// ─────────────────────────────────────────────────────────

function startCarousel() {
  stopCarousel();
  renderCarouselSlide();
  _carouselTimer = setInterval(() => {
    const total = getCarouselTotal();
    _carouselSlide = (_carouselSlide + 1) % total;
    stopAllScrolls();
    renderCarouselSlide();
  }, 30000);
}

function stopCarousel() {
  if (_carouselTimer) { clearInterval(_carouselTimer); _carouselTimer = null; }
  stopAllScrolls();
}

function stopAllScrolls() {
  if (_dfScrollTimer)     { clearTimeout(_dfScrollTimer);     _dfScrollTimer    = null; }
  if (_stickyScrollTimer) { clearTimeout(_stickyScrollTimer); _stickyScrollTimer = null; }
  // Annuler l'animation frame si en cours
  const scrollable = document.querySelector('.spc-sticky-scroll');
  if (scrollable?._stopScroll) scrollable._stopScroll();
  _dfScrollPhase = 0;
}

// Nombre de slides selon la phase et les données disponibles
function getCarouselTotal() {
  const phase = _carouselData.phase;
  if (phase === 'FIN') return 1;
  if (phase === 'DF1' || phase === 'DF2') return 1;

  const hasEc = (_carouselData.ecResults || []).filter(r => r.ms).length > 0;
  const hasMq = (_carouselData.mqResults || []).length > 0;

  if (!hasMq) return hasEc ? 1 : 1; // EC seul → 1 slide

  // Détecter le numéro de la MQ la plus avancée avec des résultats
  const currentMqNum = allSessions
    .filter(s => s.type === 'MQ')
    .filter(s => (_carouselData.sessionResults?.[s.id] || []).length > 0)
    .reduce((max, s) => Math.max(max, s.num ?? 0), 0);

  if (currentMqNum <= 1) return 1; // MQ1 → seulement résultats
  return 2;                         // MQ2+ → résultats + intermédiaire
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

  // ── Phase MQ / EC ──────────────────────────────────────
  if (phase === 'MQ') {
    const hasMq = (_carouselData.mqResults || []).length > 0;

    if (!hasMq) {
      // Seulement EC
      html = buildStickySlide(
        (_carouselData.ecResults || []).filter(r => r.ms).sort((a,b) => a.ms - b.ms),
        '⏱️ Essais chronométrés — Top 10',
        'ec',
        true // afficher bonus EC
      );
    } else if (_carouselSlide === 0) {
      // Résultats MQ
      const sorted = sortResults(_carouselData.mqResults || []);
      html = buildStickySlide(sorted, `🏁 ${_carouselData.mqLabel || 'Manche qualificative'}`, 'mq', false);
    } else {
      // Classement intermédiaire
      html = buildStickySlide(
        _carouselData.interimRows || [],
        '🏆 Classement intermédiaire',
        'interim',
        false,
        true // mode intermédiaire (afficher points)
      );
    }
  }

  // ── Phase DF ───────────────────────────────────────────
  else if (phase === 'DF1') html = buildDfCombinedSlide('DF1');
  else if (phase === 'DF2') html = buildDfCombinedSlide('DF2');

  // ── Phase Finale ───────────────────────────────────────
  else if (phase === 'FIN') html = buildFinCombinedSlide();

  block.innerHTML = indicators + html;
  startCountdown();

  // Démarrer le bon scroll selon la phase
  if (phase === 'MQ') {
    startStickyScroll();
  } else if ((phase === 'DF1' || phase === 'DF2' || phase === 'FIN') && _carouselSlide === 0) {
    startDfAutoScroll();
  }
}

// ─────────────────────────────────────────────────────────
// SCROLL STICKY TOP 5 (EC, MQ, Intermédiaire)
// Top 5 fixe, les suivants défilent en 15s, pause 5s en bas
// ─────────────────────────────────────────────────────────

function startStickyScroll() {
  const scrollable = document.querySelector('.spc-sticky-scroll');
  if (!scrollable) return;

  const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
  if (maxScroll <= 10) return;

  // Vitesse : parcourir maxScroll en 15 secondes
  // = maxScroll px / (15 * 60 frames) ≈ px par frame
  const pxPerFrame = maxScroll / (15 * 60);
  let animFrameId  = null;
  let pauseTimer   = null;
  let scrolling    = true; // true = descente, false = pause/remontée

  function scrollDown() {
    const el = document.querySelector('.spc-sticky-scroll');
    if (!el) return;

    const current = el.scrollTop;
    const max     = el.scrollHeight - el.clientHeight;

    if (current < max - 1) {
      el.scrollTop += pxPerFrame;
      animFrameId = requestAnimationFrame(scrollDown);
    } else {
      // Arrivé en bas — pause 5s puis remontée instantanée
      pauseTimer = setTimeout(() => {
        const e2 = document.querySelector('.spc-sticky-scroll');
        if (e2) e2.scrollTop = 0;
        pauseTimer = setTimeout(() => {
          animFrameId = requestAnimationFrame(scrollDown);
        }, 3000); // 3s en haut
      }, 3000); // 3s en bas
    }
  }

  // Démarrer après 3s en haut (temps de lecture du top 5)
  _stickyScrollTimer = setTimeout(() => {
    animFrameId = requestAnimationFrame(scrollDown);
  }, 3000);

  // Stocker les refs pour pouvoir tout annuler
  scrollable._stopScroll = () => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (pauseTimer)  clearTimeout(pauseTimer);
  };
}

// ─────────────────────────────────────────────────────────
// SCROLL DF / FINALE (comportement existant)
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

/**
 * Slide générique avec top 5 sticky + scroll des suivants
 * @param {Array}   rows       - tableau de résultats triés
 * @param {string}  title      - titre de la slide
 * @param {string}  type       - classe CSS (ec, mq, interim)
 * @param {boolean} showBonus  - afficher les bonus EC (+5/+4...)
 * @param {boolean} isInterim  - mode intermédiaire (afficher pts)
 */
function buildStickySlide(rows, title, type, showBonus = false, isInterim = false) {
  const top5  = rows.slice(0, 5);
  const rest  = rows.slice(5);

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
        <span class="spc-carousel-name">${escHtml((r.lastName || r.lastName || '').toUpperCase())}</span>
        ${timeVal}
        ${bonus}
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
        : `
          <!-- Top 5 sticky -->
          <div class="spc-sticky-top5">
            ${top5.map((r, i) => renderRow(r, i, true)).join('')}
          </div>
          <!-- Suite scrollable -->
          ${rest.length > 0 ? `
            <div class="spc-sticky-scroll">
              ${rest.map((r, i) => renderRow(r, i + 5, false)).join('')}
            </div>
          ` : ''}
        `}
    </div>`;
}

function buildDfCombinedSlide(phase) {
  const dfNum  = phase === 'DF1' ? 1 : 2;
  const dfRes  = sortResults(_carouselData[`df${dfNum}Results`] || []);
  const DF_PTS = [0,10,8,6,5,4,3,2,1];

  const dfSection = `
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
    </div>`;

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
      ${dfSection}
      <div class="spc-df-cumul-sticky" id="spc-df-sticky">
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
  let remaining = 30;
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
      renderView();
      await loadMeetings();
      startRefresh();
      if (selectedMeetingId && selectedCategory) await renderContent();
    } else {
      stopRefresh();
      stopCarousel();
    }
  });
}