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

let _interimRefreshTimer = null; // refresh périodique classement intermédiaire

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
    renderLiveResults();
    const session = allSessions.find(s => s.id === sessionId);
    if (session?.type === 'MQ') {
      _carouselData.mqResults = lastResults;
      _carouselData.mqLabel   = `Manche qualificative ${session.num}`;
    }
    updateTimestamp();
  });
}

// ← MODIFIÉ : calcul direct depuis calc.js, plus de lecture interimStandings Firestore
async function refreshInterimLive() {
  if (!selectedMeetingId || !selectedCategory || !allSessions.length) return;
  try {
    const { calcInterimStandings } = await import('./calc.js');
    const rows = await calcInterimStandings(db, allSessions);
    const sorted = rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    renderInterimLive(sorted);
    _carouselData.interimRows = sorted;
    updateTimestamp();
  } catch {}
}

function renderInterimLive(rows) {
  const block = document.getElementById('spc-interim-block');
  if (!block) return;
  if (rows.length === 0) { block.innerHTML = ''; return; }

  const top8 = rows.slice(0, 8);
  block.innerHTML = `
    <div class="spc-card">
      <div class="spc-card-title">🏆 Classement intermédiaire</div>
      ${top8.map(r => `
        <div class="spc-result-row ${r.position === 1 ? 'spc-result-row--first' : ''}">
          <span class="spc-result-pos">${r.position}</span>
          <span class="spc-result-num">${escHtml(r.carNumber)}</span>
          <span class="spc-result-name">${escHtml(r.lastName || '')}</span>
          <span class="spc-result-time spc-pts">${r.totalPoints} pts</span>
        </div>
      `).join('')}
      ${rows.length > 8 ? `<div class="spc-empty" style="font-size:0.78rem">+${rows.length - 8} autres pilotes</div>` : ''}
    </div>
  `;
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

  // ← MODIFIÉ : refresh périodique au lieu de subscribeInterim()
  await refreshInterimLive();
  if (_interimRefreshTimer) clearInterval(_interimRefreshTimer);
  _interimRefreshTimer = setInterval(refreshInterimLive, 30000);

  // Pré-charger les résultats de toutes les sessions
  const sessionResultsMap = {};
  for (const s of allSessions) {
    const res = await fsQuery('results', [['sessionId','==',s.id]]);
    sessionResultsMap[s.id] = res;

    if (s.type === 'MQ' && res.length > 0) {
      _carouselData.mqResults = res;
      _carouselData.mqLabel   = `Manche qualificative ${s.num}`;
    }
    if (s.type === 'DF' && res.length > 0) {
      _carouselData[`df${s.num}Results`] = res;
      _carouselData[`df${s.num}Label`]   = `Demi-finale ${s.num}`;
    }
    if (s.type === 'FIN' && res.length > 0) {
      _carouselData.finResults = res;
    }
  }
  _carouselData.sessionResults = sessionResultsMap;
  _carouselData.phase = detectPhase();

  await subscribeAdvancedSessions();

  // ← MODIFIÉ : calcul direct pour le championnat
  loadChampionshipData();

  startCarousel();
}

// ← MODIFIÉ : calcul direct depuis collections brutes, plus de meetingStandings
async function loadChampionshipData() {
  if (!selectedMeetingId || !selectedCategory) return;
  try {
    const { calcInterimStandings } = await import('./calc.js');
    const DF_PTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
    const FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

    // Tous les meetings de la saison
    const allMeetingsSnap = await fsQuery('meetings', [['year', '==', selectedYear]]);
    const pastMeetings = allMeetingsSnap.filter(m => m.id !== selectedMeetingId);

    const pointsMap = {}; // driverId → { carNumber, lastName, total }

    for (const meeting of pastMeetings) {
      const meetingSessions = await fsQuery('sessions', [
        ['meetingId', '==', meeting.id],
        ['category',  '==', selectedCategory],
      ]);
      if (!meetingSessions.length) continue;

      // Points intermédiaires
      const interim = await calcInterimStandings(db, meetingSessions);
      interim.forEach(r => {
        if (!pointsMap[r.driverId]) pointsMap[r.driverId] = {
          driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0,
        };
        pointsMap[r.driverId].total += r.interimPoints ?? 0;
      });

      // Points DF
      const dfSessions = meetingSessions.filter(s => s.type === 'DF');
      for (const df of dfSessions) {
        const res = await fsQuery('results', [['sessionId', '==', df.id]]);
        res.filter(r => r.ms && !r.status)
           .sort((a, b) => a.ms - b.ms)
           .forEach((r, i) => {
             if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
             pointsMap[r.driverId].total += DF_PTS[i + 1] ?? 0;
           });
      }

      // Points Finale
      const finSession = meetingSessions.find(s => s.type === 'FIN');
      if (finSession) {
        const res = await fsQuery('results', [['sessionId', '==', finSession.id]]);
        res.filter(r => r.ms && !r.status)
           .sort((a, b) => a.ms - b.ms)
           .forEach((r, i) => {
             if (!pointsMap[r.driverId]) pointsMap[r.driverId] = { driverId: r.driverId, carNumber: r.carNumber, lastName: r.lastName, total: 0 };
             pointsMap[r.driverId].total += FIN_PTS[i + 1] ?? 0;
           });
      }
    }

    _carouselData.championshipRows = Object.values(pointsMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  } catch {}
}

async function subscribeAdvancedSessions() {
  if (!db) return;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const advSessions = allSessions.filter(s => ['DF','FIN'].includes(s.type));
  for (const s of advSessions) {
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
        _carouselData[`df${s.num}Label`]   = `Demi-finale ${s.num}`;
      } else if (s.type === 'FIN') {
        _carouselData.finResults = results;
      }
      updateTimestamp();
    });
  }
}

function renderCurrentSession(session, results) {
  const label = session.type === 'MQ' ? `Manche qualificative ${session.num}`
    : session.type === 'DF' ? `Demi-finale ${session.num}`
    : session.type === 'EC' ? 'Essais chronométrés'
    : 'Finale';
  const typeCls = session.type.toLowerCase();

  const sorted = [...results].sort((a, b) => {
    const aSpecial = ['DNS','DSQ'].includes(a.status);
    const bSpecial = ['DNS','DSQ'].includes(b.status);
    if (aSpecial && !bSpecial) return 1;
    if (!aSpecial && bSpecial) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  return `
    <div class="spc-card spc-card--session">
      <div class="spc-card-title">
        <span class="badge badge-${typeCls}">${label}</span>
        <span class="spc-count">${results.length} résultat${results.length > 1 ? 's' : ''}</span>
      </div>
      <div class="spc-results" id="spc-live-results">
        ${sorted.length === 0
          ? `<div class="spc-empty">En attente des résultats…</div>`
          : sorted.map((r, i) => `
            <div class="spc-result-row ${i === 0 ? 'spc-result-row--first' : ''}">
              <span class="spc-result-pos">${r.ms ? i + 1 : '—'}</span>
              <span class="spc-result-num">${escHtml(r.carNumber)}</span>
              <span class="spc-result-name">${escHtml(r.lastName || '')}</span>
              <span class="spc-result-time">
                ${r.ms ? msToDisplay(r.ms)
                  : `<span class="badge badge-${r.status === 'DNF' ? 'dnf' : 'dns'}">${r.status}</span>`}
              </span>
            </div>
          `).join('')}
      </div>
    </div>
  `;
}

function renderLiveResults() {
  const container = document.getElementById('spc-live-results');
  if (!container) return;

  const sorted = [...lastResults].sort((a, b) => {
    const aSpecial = ['DNS','DSQ'].includes(a.status);
    const bSpecial = ['DNS','DSQ'].includes(b.status);
    if (aSpecial && !bSpecial) return 1;
    if (!aSpecial && bSpecial) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  if (sorted.length === 0) {
    container.innerHTML = `<div class="spc-empty">En attente des résultats…</div>`;
    return;
  }

  container.innerHTML = sorted.map((r, i) => `
    <div class="spc-result-row ${i === 0 ? 'spc-result-row--first' : ''}">
      <span class="spc-result-pos">${r.ms ? i + 1 : '—'}</span>
      <span class="spc-result-num">${escHtml(r.carNumber)}</span>
      <span class="spc-result-name">${escHtml(r.lastName || '')}</span>
      <span class="spc-result-time">
        ${r.ms ? msToDisplay(r.ms)
          : `<span class="badge badge-${r.status === 'DNF' ? 'dnf' : 'dns'}">${r.status}</span>`}
      </span>
    </div>
  `).join('');
}

async function renderNextGrid(session) {
  const label = session.type === 'MQ' ? `Manche qualificative ${session.num}`
    : session.type === 'DF' ? `Demi-finale ${session.num}`
    : session.type === 'EC' ? 'Essais chronométrés'
    : 'Finale';

  const participants = await fsQuery('sessionParticipants', [['sessionId', '==', session.id]]);
  if (participants.length === 0) return '';

  return `
    <div class="spc-card">
      <div class="spc-card-title">📋 Prochaine session — ${escHtml(label)}</div>
      <div class="spc-grid-list">
        ${participants.sort((a,b) => a.carNumber - b.carNumber).map(p => `
          <div class="spc-grid-pill">
            <span class="spc-grid-num">${escHtml(p.carNumber)}</span>
            <span class="spc-grid-name">${escHtml(p.lastName || '')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// GESTION DES LISTENERS
// ─────────────────────────────────────────────────────────

let unsubNextParts = null;
let _carouselTimer  = null;
let _carouselSlide  = 0;
let _carouselData   = { mqResults: [], mqLabel: '', interimRows: [] };
let _dfScrollTimer  = null;
let _dfScrollPhase  = 0;

function startRefresh() {
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.add('spc-live-dot--active');
}

function stopRefresh() {
  if (unsubResults)        { unsubResults();   unsubResults   = null; }
  if (unsubNextParts)      { unsubNextParts(); unsubNextParts = null; }
  if (_interimRefreshTimer){ clearInterval(_interimRefreshTimer); _interimRefreshTimer = null; }
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
    stopDfScroll();
    renderCarouselSlide();
  }, 30000);
}

function stopCarousel() {
  if (_carouselTimer) { clearInterval(_carouselTimer); _carouselTimer = null; }
  stopDfScroll();
}

function stopDfScroll() {
  if (_dfScrollTimer) { clearTimeout(_dfScrollTimer); _dfScrollTimer = null; }
  _dfScrollPhase = 0;
}

function getCarouselTotal() {
  const phase = _carouselData.phase;
  if (phase === 'FIN') return 1;
  if (phase === 'DF1' || phase === 'DF2') return 1;
  return 2;
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

  const phase = _carouselData.phase || 'MQ';
  const total = getCarouselTotal();

  const indicators = `
    <div class="spc-carousel-indicators">
      ${Array.from({length: total}, (_, i) =>
        `<span class="spc-carousel-dot ${i === _carouselSlide ? 'is-active' : ''}"></span>`
      ).join('')}
    </div>`;

  let html = '';

  if (phase === 'MQ') {
    if (_carouselSlide === 0) {
      html = buildResultsSlide(
        _carouselData.mqResults || [],
        _carouselData.mqLabel || 'Manche qualificative',
        '🏁', 'mq'
      );
    } else {
      html = buildInterimSlide(_carouselData.interimRows || []);
    }
  } else if (phase === 'DF1') {
    html = buildDfCombinedSlide('DF1');
  } else if (phase === 'DF2') {
    html = buildDfCombinedSlide('DF2');
  } else if (phase === 'FIN') {
    html = buildFinCombinedSlide();
  }

  block.innerHTML = indicators + html;
  startCountdown();

  if ((phase === 'DF1' || phase === 'DF2' || phase === 'FIN') && _carouselSlide === 0) {
    stopDfScroll();
    _dfScrollPhase = 0;
    startDfAutoScroll();
  } else {
    stopDfScroll();
  }
}

function startDfAutoScroll() {
  const container = document.querySelector('.spc-df-combined');
  if (!container) return;
  const isFinale = _carouselData.phase === 'FIN';
  if (isFinale) startFinaleAutoScroll(container);
  else          startDfStickyScroll(container);
}

function startFinaleAutoScroll(container) {
  function scrollStep() {
    const c = document.querySelector('.spc-df-combined');
    if (!c) return;
    const maxScroll  = c.scrollHeight - c.clientHeight;
    const current    = c.scrollTop;
    const pageHeight = c.clientHeight;

    if (_dfScrollPhase === 0) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = maxScroll > 10 ? 1 : 3;
        scrollStep();
      }, 15000);
    } else if (_dfScrollPhase === 1) {
      const nextTop = Math.min(current + pageHeight, maxScroll);
      c.scrollTo({ top: nextTop, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = nextTop < maxScroll - 10 ? 1 : 3;
        scrollStep();
      }, 15000);
    } else if (_dfScrollPhase === 3) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => { _dfScrollPhase = 0; scrollStep(); }, 4000);
    }
  }
  _dfScrollTimer = setTimeout(scrollStep, 500);
}

function startDfStickyScroll(container) {
  const rest    = container.querySelector('.spc-df-rest');
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

function buildResultsSlide(results, title, icon, type) {
  const sorted = sortResults(results);
  return `
    <div class="spc-carousel-slide spc-carousel-slide--${type}">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">${icon}</span>
        ${escHtml(title)}
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${sorted.length === 0
        ? `<div class="spc-carousel-empty">En attente des résultats…</div>`
        : sorted.map((r, i) => `
          <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
            <span class="spc-carousel-pos">${r.ms ? i + 1 : '—'}</span>
            <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
            <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
            <span class="spc-carousel-time">
              ${r.ms ? msToDisplay(r.ms) : statusLabel(r)}
            </span>
          </div>`).join('')}
    </div>`;
}

function buildInterimSlide(rows) {
  return `
    <div class="spc-carousel-slide spc-carousel-slide--interim">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏆</span>
        Classement intermédiaire
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${rows.length === 0
        ? `<div class="spc-carousel-empty">Classement non encore disponible</div>`
        : rows.map(r => `
          <div class="spc-carousel-row ${r.position === 1 ? 'spc-carousel-row--first' : ''}">
            <span class="spc-carousel-pos">${r.position}</span>
            <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
            <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
            <span class="spc-carousel-time spc-carousel-pts">${r.totalPoints} pts</span>
          </div>`).join('')}
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

  const rows = interim.map(r => ({
    ...r,
    interimPts: r.interimPoints ?? 0,
    dfPts:      dfPtsMap[r.carNumber] || 0,
    grandTotal: (r.interimPoints ?? 0) + (dfPtsMap[r.carNumber] || 0),
  })).sort((a, b) => b.grandTotal - a.grandTotal);

  const top16 = rows.slice(0, 16);
  const rest  = rows.slice(16);
  const title = phase === 'DF1' ? 'Classement après DF1' : 'Classement après DF1 & DF2';

  const cumulSection = `
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
  `;

  return `
    <div class="spc-carousel-slide spc-carousel-slide--df spc-df-combined">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏁</span>
        Demi-finale ${dfNum}
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${dfSection}
      ${cumulSection}
    </div>`;
}

function buildFinCombinedSlide() {
  const finRes  = sortResults(_carouselData.finResults  || []);
  const interim = _carouselData.interimRows || [];
  const df1Res  = sortResults(_carouselData.df1Results  || []);
  const df2Res  = sortResults(_carouselData.df2Results  || []);

  const DF_PTS  = [0,10,8,6,5,4,3,2,1];
  const FIN_PTS = [0,15,12,9,7,6,5,4,3];

  const dfPtsMap  = {};
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

  const finSection = `
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
    </div>`;

  const meetingSection = rows.length === 0 ? '' : `
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
    </div>`;

  return `
    <div class="spc-carousel-slide spc-carousel-slide--fin spc-df-combined">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏆</span>
        Finale
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${finSection}
      ${meetingSection}
    </div>`;
}

function buildChampionshipSlide() {
  const rows = _carouselData.championshipRows || [];
  return `
    <div class="spc-carousel-slide spc-carousel-slide--champ">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">🏅</span>
        Championnat saison
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${rows.length === 0
        ? `<div class="spc-carousel-empty">Chargement du championnat…</div>`
        : rows.map((r, i) => `
          <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
            <span class="spc-carousel-pos">${i + 1}</span>
            <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
            <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
            <span class="spc-carousel-time spc-carousel-pts">${r.total} pts</span>
          </div>`).join('')}
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