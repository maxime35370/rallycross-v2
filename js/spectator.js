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
let refreshTimer      = null;
let unsubResults      = null;
let lastResults       = []; // derniers temps saisis (live)

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

// Live listeners — mettent à jour uniquement leur bloc DOM sans toucher au reste
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
    // Alimenter le carrousel avec la dernière MQ
    const session = allSessions.find(s => s.id === sessionId);
    if (session?.type === 'MQ') {
      const label = `Manche qualificative ${session.num}`;
      _carouselData.mqResults = lastResults;
      _carouselData.mqLabel   = label;
    }
    updateTimestamp();
  });
}

async function subscribeInterim() {
  if (unsubInterim) { unsubInterim(); unsubInterim = null; }
  if (!db || !selectedMeetingId || !selectedCategory) return;

  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const q = query(
    collection(db, 'interimStandings'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  );
  unsubInterim = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => d.data())
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    renderInterimLive(rows);
    _carouselData.interimRows = rows; // alimenter le carrousel
    updateTimestamp();
  });
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

    <!-- Sélecteurs -->
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

    <!-- Contenu dynamique -->
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

  // Trouver la session "active" : la dernière qui a des résultats
  const sessionResults = await Promise.all(
    allSessions.map(async s => {
      const res = await fsQuery('results', [['sessionId', '==', s.id]]);
      return { session: s, count: res.length, results: res };
    })
  );

  // Session active = la plus avancée avec des résultats
  const withResults = sessionResults.filter(sr => sr.count > 0);
  const currentSR   = withResults[withResults.length - 1] || null;
  const currentSession = currentSR?.session || null;

  // Prochaine session = la suivante sans résultats
  const nextSession = currentSession
    ? allSessions.find(s => (s.order ?? 0) > (currentSession.order ?? 0) && !sessionResults.find(sr => sr.session.id === s.id && sr.count > 0))
    : allSessions[0] || null;

  // Abonner aux résultats de la session active
  if (currentSession) await subscribeResults(currentSession.id);

  content.innerHTML = `
    <!-- Carrousel uniquement -->
    <div id="spc-carousel-block"></div>

    <!-- Dernière mise à jour -->
    <div class="spc-updated" id="spc-timestamp">En attente de données…</div>
  `;

  // Abonner au classement intermédiaire (live)
  await subscribeInterim();

  // Démarrer le carrousel auto
  startCarousel();
}

function renderCurrentSession(session, results) {
  const label = session.type === 'MQ' ? `Manche qualificative ${session.num}`
    : session.type === 'DF' ? `Demi-finale ${session.num}`
    : session.type === 'EC' ? 'Essais chronométrés'
    : 'Finale';

  const typeCls = session.type.toLowerCase();

  // Trier les résultats
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

  const participants = await fsQuery('sessionParticipants', [
    ['sessionId', '==', session.id]
  ]);

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
// LIVE LISTENERS — pas de refresh DOM global
// Chaque bloc se met à jour indépendamment via onSnapshot
// ─────────────────────────────────────────────────────────

let unsubInterim   = null;
let unsubNextParts = null;
let _carouselTimer = null;
let _carouselSlide = 0; // 0 = dernière MQ, 1 = classement intermédiaire
let _carouselData  = { mqResults: [], mqLabel: '', interimRows: [] };

function startRefresh() {
  // Activer le dot LIVE
  const dot = document.getElementById('spc-live-dot');
  if (dot) dot.classList.add('spc-live-dot--active');
}

function stopRefresh() {
  if (unsubResults)   { unsubResults();   unsubResults   = null; }
  if (unsubInterim)   { unsubInterim();   unsubInterim   = null; }
  if (unsubNextParts) { unsubNextParts(); unsubNextParts = null; }
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
// STYLES
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// CARROUSEL AUTO
// ─────────────────────────────────────────────────────────

function startCarousel() {
  stopCarousel();
  renderCarouselSlide(); // afficher immédiatement
  _carouselTimer = setInterval(() => {
    _carouselSlide = (_carouselSlide + 1) % 2;
    renderCarouselSlide();
  }, 30000); // 30 secondes par slide
}

function stopCarousel() {
  if (_carouselTimer) { clearInterval(_carouselTimer); _carouselTimer = null; }
}

function renderCarouselSlide() {
  const block = document.getElementById('spc-carousel-block');
  if (!block) return;

  // Indicateur de slide
  const indicators = `
    <div class="spc-carousel-indicators">
      <span class="spc-carousel-dot ${_carouselSlide === 0 ? 'is-active' : ''}"></span>
      <span class="spc-carousel-dot ${_carouselSlide === 1 ? 'is-active' : ''}"></span>
    </div>
  `;

  if (_carouselSlide === 0) {
    // ── Slide 1 : Dernière MQ ─────────────────────────
    const { mqResults, mqLabel } = _carouselData;
    const sorted = [...mqResults].sort((a, b) => {
      const aS = ['DNS','DSQ'].includes(a.status);
      const bS = ['DNS','DSQ'].includes(b.status);
      if (aS && !bS) return 1;
      if (!aS && bS) return -1;
      return (a.ms ?? Infinity) - (b.ms ?? Infinity);
    });

    block.innerHTML = `
      ${indicators}
      <div class="spc-carousel-slide spc-carousel-slide--mq" id="spc-carousel-inner">
        <div class="spc-carousel-title">
          <span class="spc-carousel-icon">🏁</span>
          ${escHtml(mqLabel || 'Manche qualificative')}
          <span class="spc-carousel-timer" id="spc-ctimer"></span>
        </div>
        ${sorted.length === 0 ? `<div class="spc-carousel-empty">En attente des résultats…</div>` :
          sorted.map((r, i) => `
            <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
              <span class="spc-carousel-pos">${r.ms ? i + 1 : '—'}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-carousel-time">
                ${r.ms ? msToDisplay(r.ms)
                  : `<span class="spc-status-badge">${r.status === 'DSQ_RACE' ? 'DSQ EC' : r.status === 'DSQ' ? 'DSQ HC' : r.status || '—'}</span>`}
              </span>
            </div>
          `).join('')}
      </div>
    `;
  } else {
    // ── Slide 2 : Classement intermédiaire ───────────
    const rows = _carouselData.interimRows;

    block.innerHTML = `
      ${indicators}
      <div class="spc-carousel-slide spc-carousel-slide--interim" id="spc-carousel-inner">
        <div class="spc-carousel-title">
          <span class="spc-carousel-icon">🏆</span>
          Classement intermédiaire
          <span class="spc-carousel-timer" id="spc-ctimer"></span>
        </div>
        ${rows.length === 0 ? `<div class="spc-carousel-empty">Classement non encore disponible</div>` :
          rows.map(r => `
            <div class="spc-carousel-row ${r.position === 1 ? 'spc-carousel-row--first' : ''}">
              <span class="spc-carousel-pos">${r.position}</span>
              <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
              <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
              <span class="spc-carousel-time spc-carousel-pts">${r.totalPoints} pts</span>
            </div>
          `).join('')}
      </div>
    `;
  }

  // Countdown timer de 30s
  startCountdown();
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

function injectStyles() {
  if (document.getElementById('spectator-styles')) return;
  const style = document.createElement('style');
  style.id = 'spectator-styles';
  style.textContent = `
    /* Header */
    .spc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--sp-md);
    }
    .spc-title {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      font-family: var(--font-display);
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--clr-text);
    }
    .spc-flag { font-size: 1.3rem; }

    /* Dot LIVE */
    .spc-live-dot {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: 20px;
    }
    .spc-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--clr-text-3);
    }
    .spc-live-dot--active .spc-dot {
      background: var(--clr-success);
      box-shadow: 0 0 6px var(--clr-success);
      animation: spc-pulse 2s infinite;
    }
    @keyframes spc-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }
    .spc-live-label {
      font-family: var(--font-condensed);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--clr-text-3);
    }
    .spc-live-dot--active .spc-live-label { color: var(--clr-success); }

    /* Cards */
    .spc-card {
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
      padding: var(--sp-md);
      margin-bottom: var(--sp-md);
    }
    .spc-card--session { border-top: 3px solid var(--clr-accent); }
    .spc-card-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: var(--font-condensed);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
      padding-bottom: var(--sp-xs);
      border-bottom: 1px solid var(--clr-border);
    }
    .spc-count { font-size: 0.75rem; color: var(--clr-accent-2); }
    .spc-empty { text-align: center; padding: var(--sp-md); color: var(--clr-text-3); font-size: 0.85rem; }

    /* Résultats */
    .spc-result-row {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: 10px var(--sp-xs);
      border-bottom: 1px solid var(--clr-border);
    }
    .spc-result-row:last-child { border-bottom: none; }
    .spc-result-row--first {
      background: rgba(255,85,0,0.06);
      border-radius: var(--r-sm);
    }
    .spc-result-pos {
      min-width: 24px;
      font-family: var(--font-display);
      font-size: 0.9rem;
      font-weight: 700;
      color: var(--clr-text-3);
      text-align: center;
    }
    .spc-result-row--first .spc-result-pos { color: var(--clr-accent); font-size: 1rem; }
    .spc-result-num {
      min-width: 42px;
      text-align: center;
      font-family: var(--font-display);
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--clr-accent-2);
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      padding: 3px 6px;
    }
    .spc-result-name {
      flex: 1;
      font-size: 1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .spc-result-time {
      font-family: var(--font-display);
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--clr-success);
    }
    .spc-pts { color: var(--clr-accent-2) !important; }

    /* Grille prochaine session */
    .spc-grid-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-xs);
      padding-top: var(--sp-xs);
    }
    .spc-grid-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: 20px;
      font-size: 0.85rem;
    }
    .spc-grid-num {
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--clr-accent-2);
      font-size: 0.88rem;
    }
    .spc-grid-name { color: var(--clr-text-2); font-weight: 500; }

    /* Carrousel */
    .spc-carousel-indicators {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-bottom: var(--sp-sm);
    }
    .spc-carousel-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--clr-border-2);
      transition: background var(--tr-fast);
    }
    .spc-carousel-dot.is-active { background: var(--clr-accent); }

    .spc-carousel-slide {
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-lg);
      padding: var(--sp-md);
      margin-bottom: var(--sp-md);
      animation: spc-fadein 0.5s ease;
    }
    @keyframes spc-fadein {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .spc-carousel-slide--mq     { border-top: 3px solid var(--clr-accent); }
    .spc-carousel-slide--interim { border-top: 3px solid #ffd700; }

    .spc-carousel-title {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      font-family: var(--font-condensed);
      font-size: 0.88rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--clr-text-2);
      margin-bottom: var(--sp-md);
      padding-bottom: var(--sp-sm);
      border-bottom: 1px solid var(--clr-border);
    }
    .spc-carousel-icon { font-size: 1rem; }
    .spc-carousel-timer {
      margin-left: auto;
      font-size: 0.72rem;
      color: var(--clr-text-3);
      font-family: var(--font-display);
      font-weight: 400;
    }

    .spc-carousel-row {
      display: flex;
      align-items: center;
      gap: var(--sp-sm);
      padding: 10px var(--sp-xs);
      border-bottom: 1px solid var(--clr-border);
    }
    .spc-carousel-row:last-child { border-bottom: none; }
    .spc-carousel-row--first { background: rgba(255,85,0,0.06); border-radius: var(--r-sm); }

    .spc-carousel-pos {
      min-width: 28px;
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-text-3);
      text-align: center;
    }
    .spc-carousel-row--first .spc-carousel-pos { color: var(--clr-accent); font-size: 1.1rem; }

    .spc-carousel-num {
      min-width: 48px;
      text-align: center;
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-accent-2);
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      padding: 4px 8px;
    }
    .spc-carousel-name {
      flex: 1;
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .spc-carousel-time {
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-success);
    }
    .spc-carousel-pts { color: var(--clr-accent-2) !important; }
    .spc-carousel-empty {
      text-align: center;
      padding: var(--sp-lg);
      color: var(--clr-text-3);
      font-size: 0.9rem;
    }
    .spc-status-badge {
      font-family: var(--font-condensed);
      font-size: 0.75rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 20px;
      background: var(--clr-danger-dim);
      color: var(--clr-danger);
    }

    /* Timestamp */
    .spc-updated {
      text-align: center;
      font-size: 0.72rem;
      color: var(--clr-text-3);
      padding: var(--sp-sm);
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initSpectator() {
  injectStyles();
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'spectator') {
      renderView();
      await loadMeetings();
      startRefresh(); // active le dot LIVE
      if (selectedMeetingId && selectedCategory) {
        await renderContent();
      }
    } else {
      // Arrêter tous les listeners quand on quitte la vue
      stopRefresh();
      stopCarousel();
    }
  });
}