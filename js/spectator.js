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

  // Pré-charger les résultats de toutes les sessions
  const sessionResultsMap = {};
  for (const s of allSessions) {
    const res = await fsQuery('results', [['sessionId','==',s.id]]);
    sessionResultsMap[s.id] = res;

    // Pré-remplir les données carrousel avec ce qui existe déjà
    if (s.type === 'MQ' && res.length > 0) {
      // Garder la MQ la plus avancée avec des résultats
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

  // Pré-charger le classement intermédiaire depuis Firestore
  try {
    const interimRows = await fsQuery('interimStandings', [
      ['meetingId', '==', selectedMeetingId],
      ['category',  '==', selectedCategory],
    ]);
    _carouselData.interimRows = interimRows.sort((a,b) => (a.position??99)-(b.position??99));
  } catch {}

  // Abonner aux sessions DF/FIN pour les mises à jour live
  await subscribeAdvancedSessions();

  // Charger championnat en arrière-plan pour la slide finale
  loadChampionshipData();

  // Démarrer le carrousel auto
  startCarousel();
}

async function loadChampionshipData() {
  if (!selectedMeetingId || !selectedCategory) return;
  try {
    const rows = await fsQuery('meetingStandings', [
      ['category', '==', selectedCategory],
      ['year',     '==', selectedYear],
    ]);
    // Cumuler par pilote sur tous les meetings
    const map = {};
    rows.forEach(r => {
      if (!map[r.driverId]) map[r.driverId] = {
        driverId: r.driverId, carNumber: r.carNumber,
        lastName: r.lastName, total: 0,
      };
      map[r.driverId].total += r.totalPts ?? 0;
    });
    _carouselData.championshipRows = Object.values(map)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  } catch {}
}

async function subscribeAdvancedSessions() {
  if (!db) return;
  const { collection, query, where, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  // Abonner à toutes les sessions DF et FIN
  const advSessions = allSessions.filter(s => ['DF','FIN'].includes(s.type));
  for (const s of advSessions) {
    const q = query(collection(db,'results'), where('sessionId','==',s.id));
    const unsub = onSnapshot(q, snap => {
      const results = snap.docs.map(d => d.data());
      if (!_carouselData.sessionResults) _carouselData.sessionResults = {};
      _carouselData.sessionResults[s.id] = results;
      // Mettre à jour les données du carrousel selon la session
      const newPhase = detectPhase();
      if (newPhase !== _carouselData.phase) {
        _carouselData.phase = newPhase;
        _carouselSlide = 0; // reset au début quand la phase change
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
let _carouselTimer  = null;
let _carouselSlide  = 0;
let _carouselData   = { mqResults: [], mqLabel: '', interimRows: [] };
let _dfScrollTimer  = null;  // timer scroll auto DF
let _dfScrollPhase  = 0;     // 0=résultats, 1=top16, 2=reste, 3=remontée

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
  renderCarouselSlide();
  _carouselTimer = setInterval(() => {
    const total = getCarouselTotal();
    _carouselSlide = (_carouselSlide + 1) % total;
    stopDfScroll(); // arrêter le scroll DF avant de changer de slide
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

/** Nombre de slides selon la phase actuelle */
function getCarouselTotal() {
  const phase = _carouselData.phase;
  if (phase === 'FIN') return 1;
  if (phase === 'DF1' || phase === 'DF2') return 1; // 1 slide combiné
  return 2; // MQ : résultats + intermédiaire
}

/** Détecte la phase courante depuis les sessions avec résultats */
function detectPhase() {
  const sessions = allSessions;
  // Chercher la session la plus avancée avec des résultats
  const hasResults = (sid) => (_carouselData.sessionResults || {})[sid]?.length > 0;

  const fin  = sessions.find(s => s.type === 'FIN');
  const df2  = sessions.find(s => s.type === 'DF' && s.num === 2);
  const df1  = sessions.find(s => s.type === 'DF' && s.num === 1);

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

  // Indicateurs
  const indicators = `
    <div class="spc-carousel-indicators">
      ${Array.from({length: total}, (_, i) =>
        `<span class="spc-carousel-dot ${i === _carouselSlide ? 'is-active' : ''}"></span>`
      ).join('')}
    </div>`;

  let html = '';

  // ════════════════════════════════
  // PHASE MQ
  // ════════════════════════════════
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
  }

  // ════════════════════════════════
  // PHASE DF1
  // ════════════════════════════════
  else if (phase === 'DF1') {
    html = buildDfCombinedSlide('DF1');
  }

  // ════════════════════════════════
  // PHASE DF2
  // ════════════════════════════════
  else if (phase === 'DF2') {
    html = buildDfCombinedSlide('DF2');
  }

  // ════════════════════════════════
  // PHASE FINALE — 1 slide combiné
  // ════════════════════════════════
  else if (phase === 'FIN') {
    html = buildFinCombinedSlide();
  }

  block.innerHTML = indicators + html;
  startCountdown();

  // Scroll auto pour les slides DF et FIN combinés
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

  // Pour la Finale : scroll libre par blocs de 15s (pas de sticky)
  // Pour les DF   : sticky sur le top 16, puis les 17+ en dessous
  if (isFinale) {
    startFinaleAutoScroll(container);
  } else {
    startDfStickyScroll(container);
  }
}

function startFinaleAutoScroll(container) {
  // Divise le contenu en sections de hauteur écran et scrolle de l'une à l'autre

  function scrollStep() {
    const c = document.querySelector('.spc-df-combined');
    if (!c) return;

    const maxScroll  = c.scrollHeight - c.clientHeight;
    const current    = c.scrollTop;
    const pageHeight = c.clientHeight;

    if (_dfScrollPhase === 0) {
      // Haut — résultats finale
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        if (maxScroll > 10) { _dfScrollPhase = 1; } // y a du contenu en dessous
        else                { _dfScrollPhase = 3; } // rien en dessous, remonter
        scrollStep();
      }, 15000);

    } else if (_dfScrollPhase === 1) {
      // Descendre d'un bloc
      const nextTop = Math.min(current + pageHeight, maxScroll);
      c.scrollTo({ top: nextTop, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        const stillMore = nextTop < maxScroll - 10;
        _dfScrollPhase = stillMore ? 1 : 3; // continuer ou remonter
        scrollStep();
      }, 15000);

    } else if (_dfScrollPhase === 3) {
      // Remontée rapide
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = 0;
        scrollStep();
      }, 4000);
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
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = 1;
        scrollToPhase();
      }, 15000);

    } else if (_dfScrollPhase === 1) {
      const stickyEl = c.querySelector('.spc-df-cumul-sticky');
      if (stickyEl) c.scrollTo({ top: stickyEl.offsetTop, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = hasRest ? 2 : 3;
        scrollToPhase();
      }, 15000);

    } else if (_dfScrollPhase === 2) {
      c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = 3;
        scrollToPhase();
      }, 15000);

    } else if (_dfScrollPhase === 3) {
      c.scrollTo({ top: 0, behavior: 'smooth' });
      _dfScrollTimer = setTimeout(() => {
        _dfScrollPhase = 0;
        scrollToPhase();
      }, 4000);
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
  const dfNum    = phase === 'DF1' ? 1 : 2;
  const dfRes    = sortResults(_carouselData[`df${dfNum}Results`] || []);
  const upTo     = phase; // DF1 ou DF2

  // ── Section résultats DF ────────────────────────────
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

  // ── Section classement cumulatif ────────────────────
  const interim  = _carouselData.interimRows || [];
  const df1Res   = sortResults(_carouselData.df1Results || []);
  const df2Res   = sortResults(_carouselData.df2Results || []);
  const DF_PTS   = [0,10,8,6,5,4,3,2,1];

  const dfPtsMap = {};
  if (phase === 'DF1' || phase === 'DF2') {
    df1Res.forEach((r, i) => {
      if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber] || 0) + (DF_PTS[i+1] || 0);
    });
  }
  if (phase === 'DF2') {
    df2Res.forEach((r, i) => {
      if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber] || 0) + (DF_PTS[i+1] || 0);
    });
  }

  const rows = interim.map(r => ({
    ...r,
    interimPts: r.interimPoints ?? 0,
    dfPts:      dfPtsMap[r.carNumber] || 0,
    grandTotal: (r.interimPoints ?? 0) + (dfPtsMap[r.carNumber] || 0),
  })).sort((a, b) => b.grandTotal - a.grandTotal);

  const top16   = rows.slice(0, 16);
  const rest    = rows.slice(16);
  const title   = phase === 'DF1' ? 'Classement après DF1' : 'Classement après DF1 & DF2';

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

  // Points DF par numéro
  const dfPtsMap = {};
  [...df1Res, ...df2Res].forEach((r, i) => {
    // recalculer proprement par session
  });
  df1Res.forEach((r, i) => { if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[i+1]||0); });
  df2Res.forEach((r, i) => { if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber]||0) + (DF_PTS[i+1]||0); });

  // Points Finale par numéro
  const finPtsMap = {};
  finRes.forEach((r, i) => { if (r.ms) finPtsMap[r.carNumber] = FIN_PTS[i+1]||0; });

  // Classement meeting complet
  const rows = interim.map(r => {
    const interimPts = r.interimPoints ?? 0;
    const dfPts      = dfPtsMap[r.carNumber]  || 0;
    const finPts     = finPtsMap[r.carNumber] || 0;
    return { ...r, interimPts, dfPts, finPts, grandTotal: interimPts + dfPts + finPts };
  }).sort((a, b) => b.grandTotal - a.grandTotal);

  // Section résultats finale
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

  // Section classement meeting — pas de sticky, scroll libre
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

function buildCumulativeSlide(upToPhase) {
  const interim  = _carouselData.interimRows || [];
  const df1Res   = sortResults(_carouselData.df1Results || []);
  const df2Res   = sortResults(_carouselData.df2Results || []);
  const finRes   = sortResults(_carouselData.finResults  || []);

  const DF_PTS  = [0,10,8,6,5,4,3,2,1];
  const FIN_PTS = [0,15,12,9,7,6,5,4,3];

  // Points DF par numéro de voiture
  const dfPtsMap = {};
  if (upToPhase === 'DF1' || upToPhase === 'DF2' || upToPhase === 'FIN') {
    df1Res.forEach((r, i) => {
      if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber] || 0) + (DF_PTS[i+1] || 0);
    });
  }
  if (upToPhase === 'DF2' || upToPhase === 'FIN') {
    df2Res.forEach((r, i) => {
      if (r.ms) dfPtsMap[r.carNumber] = (dfPtsMap[r.carNumber] || 0) + (DF_PTS[i+1] || 0);
    });
  }

  // Points Finale
  const finPtsMap = {};
  if (upToPhase === 'FIN') {
    finRes.forEach((r, i) => {
      if (r.ms) finPtsMap[r.carNumber] = FIN_PTS[i+1] || 0;
    });
  }

  // Fusionner avec le classement intermédiaire
  const rows = interim.map(r => {
    const interimPts = r.interimPoints ?? 0;       // 16/15/14... selon position
    const df         = dfPtsMap[r.carNumber]  || 0;
    const fin        = finPtsMap[r.carNumber] || 0;
    const grandTotal = interimPts + df + fin;
    return { ...r, interimPts, dfPts: df, finPts: fin, grandTotal };
  }).sort((a, b) => b.grandTotal - a.grandTotal);

  // Ajouter les pilotes DF non dans l'intermédiaire (remplaçants)
  const interimNums = new Set(interim.map(r => r.carNumber));
  [...df1Res, ...df2Res].forEach((r, i) => {
    if (!interimNums.has(r.carNumber) && r.ms) {
      rows.push({
        carNumber: r.carNumber, lastName: r.lastName || '',
        interimPts: 0, dfPts: dfPtsMap[r.carNumber] || 0, finPts: 0,
        grandTotal: dfPtsMap[r.carNumber] || 0,
      });
    }
  });

  const titles = {
    DF1: 'Classement après DF1',
    DF2: 'Classement après DF1 & DF2',
    FIN: 'Classement du meeting',
  };
  const icons = { DF1: '📊', DF2: '📊', FIN: '🥇' };

  // En-têtes colonnes selon la phase
  const colHeaders = upToPhase === 'FIN'
    ? `<div class="spc-cumul-headers">
        <span class="spc-cumul-hdr">Inter.</span>
        <span class="spc-cumul-hdr">DF</span>
        <span class="spc-cumul-hdr">Fin.</span>
        <span class="spc-cumul-hdr spc-cumul-hdr--total">Total</span>
      </div>`
    : `<div class="spc-cumul-headers">
        <span class="spc-cumul-hdr">Inter.</span>
        <span class="spc-cumul-hdr">DF</span>
        <span class="spc-cumul-hdr spc-cumul-hdr--total">Total</span>
      </div>`;

  return `
    <div class="spc-carousel-slide spc-carousel-slide--cumul">
      <div class="spc-carousel-title">
        <span class="spc-carousel-icon">${icons[upToPhase]}</span>
        ${titles[upToPhase]}
        <span class="spc-carousel-timer" id="spc-ctimer"></span>
      </div>
      ${colHeaders}
      ${rows.length === 0
        ? `<div class="spc-carousel-empty">Données insuffisantes</div>`
        : rows.map((r, i) => `
          <div class="spc-carousel-row ${i === 0 ? 'spc-carousel-row--first' : ''}">
            <span class="spc-carousel-pos">${i + 1}</span>
            <span class="spc-carousel-num">${escHtml(r.carNumber)}</span>
            <span class="spc-carousel-name">${escHtml((r.lastName || '').toUpperCase())}</span>
            <span class="spc-cumul-pts">${r.interimPts || '—'}</span>
            <span class="spc-cumul-pts">${r.dfPts || '—'}</span>
            ${upToPhase === 'FIN' ? `<span class="spc-cumul-pts">${r.finPts || '—'}</span>` : ''}
            <span class="spc-cumul-pts spc-cumul-pts--total">${r.grandTotal}</span>
          </div>`).join('')}
    </div>`;
}

function buildChampionshipSlide() {
  // Lire depuis _carouselData.championshipRows (chargé async)
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

    /* Slide DF combiné */
    .spc-df-combined {
      overflow-y: auto;
      max-height: calc(100vh - 200px);
      scroll-behavior: smooth;
      scrollbar-width: none;       /* Firefox */
      -ms-overflow-style: none;    /* IE/Edge */
    }
    .spc-df-combined::-webkit-scrollbar { display: none; } /* Chrome/Safari */
    .spc-df-results-section {
      margin-bottom: var(--sp-md);
      padding-bottom: var(--sp-md);
      border-bottom: 2px solid var(--clr-border);
    }
    .spc-df-section-title {
      font-family: var(--font-condensed);
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
    }
    /* Top 16 sticky quand il atteint le haut */
    .spc-df-cumul-sticky {
      position: sticky;
      top: 0;
      background: var(--clr-surface);
      z-index: 10;
      padding-top: var(--sp-sm);
      border-bottom: 2px solid var(--clr-accent);
    }
    .spc-df-rest {
      padding-top: var(--sp-xs);
      opacity: 0.7;
    }
    .spc-df-meeting-section {
      margin-top: var(--sp-md);
      padding-top: var(--sp-md);
      border-top: 2px solid var(--clr-border);
    }

    /* Colonnes cumulatives */
    .spc-cumul-headers {
      display: flex;
      justify-content: flex-end;
      gap: var(--sp-sm);
      padding: 0 var(--sp-xs) var(--sp-xs);
      font-family: var(--font-condensed);
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--clr-text-3);
      border-bottom: 1px solid var(--clr-border);
      margin-bottom: 4px;
    }
    .spc-cumul-hdr { min-width: 46px; text-align: right; }
    .spc-cumul-hdr--total { color: var(--clr-accent-2); min-width: 52px; }

    .spc-cumul-pts {
      min-width: 46px;
      text-align: right;
      font-family: var(--font-display);
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--clr-text-2);
      flex-shrink: 0;
    }
    .spc-cumul-pts--total {
      min-width: 52px;
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-accent-2);
    }
    .spc-carousel-empty {
      text-align: center;
      padding: var(--sp-lg);
      color: var(--clr-text-3);
      font-size: 0.9rem;
    }
    .spc-carousel-slide--df    { border-top: 3px solid var(--clr-info); }
    .spc-carousel-slide--fin   { border-top: 3px solid #ffd700; }
    .spc-carousel-slide--cumul { border-top: 3px solid var(--clr-success); }
    .spc-carousel-slide--champ { border-top: 3px solid var(--clr-accent); }

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