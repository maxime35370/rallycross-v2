/* ═══════════════════════════════════════════════
   STATS.JS — Statistiques saison par catégorie
   Agrégation depuis meetingStandings + results
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let selectedYear     = new Date().getFullYear();
let selectedCategory = '';
let allMeetings      = [];
let sortState        = { table: null, key: null, asc: false }; // état tri

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

// ─────────────────────────────────────────────────────────
// FIRESTORE
// ─────────────────────────────────────────────────────────

async function fsQuery(col, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, col),
    ...filters.map(([f, op, v]) => where(f, op, v))
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'meetings'),
    where('year', '==', selectedYear),
    orderBy('date', 'asc')
  ));
  allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  refreshMeetingList();
}

// ─────────────────────────────────────────────────────────
// CALCUL STATISTIQUES
// ─────────────────────────────────────────────────────────

async function calcStats() {
  if (!selectedCategory || allMeetings.length === 0) return null;

  // ── Données brutes ────────────────────────────────────
  const [meetingStandings, interimStandings] = await Promise.all([
    fsQuery('meetingStandings', [
      ['category', '==', selectedCategory],
      ['year',     '==', selectedYear],
    ]),
    fsQuery('interimStandings', [
      ['category', '==', selectedCategory],
      ['year',     '==', selectedYear],
    ]),
  ]);

  // Résultats par session (EC, MQ, DF, FIN) pour tous les meetings
  const allResults = await fsQuery('results', [
    ['category', '==', selectedCategory],
    ['year',     '==', selectedYear],
  ]);

  // Sessions pour avoir les types
  const allSessions = await fsQuery('sessions', [
    ['category', '==', selectedCategory],
    ['year',     '==', selectedYear],
  ]);
  const sessionMap = {}; // sessionId → session
  allSessions.forEach(s => { sessionMap[s.id] = s; });

  // ── Indexer par pilote ────────────────────────────────
  const pilots = {}; // driverId → { info, meetings: {} }

  const ensurePilot = (r) => {
    if (!pilots[r.driverId]) {
      pilots[r.driverId] = {
        driverId:  r.driverId,
        carNumber: r.carNumber,
        firstName: r.firstName,
        lastName:  r.lastName,
        meetings:  {}, // meetingId → { ec, mq[], interim, df[], fin }
      };
    }
    if (!pilots[r.driverId].meetings[r.meetingId]) {
      pilots[r.driverId].meetings[r.meetingId] = {
        ec:     null,
        mq:     [],
        interim: null,
        df:     [],
        fin:    null,
        total:  null,
      };
    }
    return pilots[r.driverId].meetings[r.meetingId];
  };

  // ── EC ────────────────────────────────────────────────
  allResults
    .filter(r => r.sessionType === 'EC')
    .forEach(r => {
      const m = ensurePilot(r);
      m.ec = { ms: r.ms, status: r.status };
    });

  // ── MQ ────────────────────────────────────────────────
  // Calculer les positions MQ (trier par temps dans chaque session)
  const mqBySession = {};
  allResults.filter(r => r.sessionType === 'MQ').forEach(r => {
    if (!mqBySession[r.sessionId]) mqBySession[r.sessionId] = [];
    mqBySession[r.sessionId].push(r);
  });
  Object.entries(mqBySession).forEach(([sid, res]) => {
    const session = sessionMap[sid];
    if (!session) return;
    const sorted = [...res].filter(r => r.ms).sort((a,b) => a.ms - b.ms);
    sorted.forEach((r, i) => {
      const m = ensurePilot(r);
      m.mq.push({ position: i + 1, points: r.ms ? calcMqPoints(i + 1, res.length) : 0, sessionNum: session.num });
    });
    // DNS/DSQ/DNF sans temps
    res.filter(r => !r.ms).forEach(r => {
      const m = ensurePilot(r);
      m.mq.push({ position: null, points: 0, status: r.status, sessionNum: session?.num });
    });
  });

  // ── Intermédiaire ─────────────────────────────────────
  interimStandings.forEach(r => {
    const m = ensurePilot(r);
    m.interim = { position: r.position, interimPoints: r.interimPoints ?? 0 };
  });

  // ── DF ────────────────────────────────────────────────
  const dfBySession = {};
  allResults.filter(r => r.sessionType === 'DF').forEach(r => {
    if (!dfBySession[r.sessionId]) dfBySession[r.sessionId] = [];
    dfBySession[r.sessionId].push(r);
  });
  const DF_PTS = [0,10,8,6,5,4,3,2,1];
  Object.entries(dfBySession).forEach(([sid, res]) => {
    const sorted = [...res].filter(r => r.ms).sort((a,b) => a.ms - b.ms);
    sorted.forEach((r, i) => {
      const m = ensurePilot(r);
      m.df.push({ position: i + 1, points: DF_PTS[i+1] || 0 });
    });
    res.filter(r => r.status === 'DNF' && r.manualPosition).forEach(r => {
      const m = ensurePilot(r);
      m.df.push({ position: r.manualPosition, points: DF_PTS[r.manualPosition] || 0 });
    });
  });

  // ── Finale ────────────────────────────────────────────
  const FIN_PTS = [0,15,12,9,7,6,5,4,3];
  const finBySession = {};
  allResults.filter(r => r.sessionType === 'FIN').forEach(r => {
    if (!finBySession[r.sessionId]) finBySession[r.sessionId] = [];
    finBySession[r.sessionId].push(r);
  });
  Object.entries(finBySession).forEach(([sid, res]) => {
    const sorted = [...res].filter(r => r.ms).sort((a,b) => a.ms - b.ms);
    sorted.forEach((r, i) => {
      const m = ensurePilot(r);
      m.fin = { position: i + 1, points: FIN_PTS[i+1] || 0 };
    });
    res.filter(r => r.status === 'DNF' && r.manualPosition).forEach(r => {
      const m = ensurePilot(r);
      m.fin = { position: r.manualPosition, points: FIN_PTS[r.manualPosition] || 0 };
    });
  });

  // ── Total meeting ─────────────────────────────────────
  meetingStandings.forEach(r => {
    const m = ensurePilot(r);
    m.total = { totalPts: r.totalPts, position: r.position };
  });

  // ── Calcul des stats agrégées par pilote ──────────────
  const nbMeetings = allMeetings.length;

  return Object.values(pilots).map(p => {
    const meetings = Object.values(p.meetings);
    const nbMeetingsParticipated = meetings.length;

    // EC
    const ecBonuses = meetings.map(m => {
      if (!m.ec?.ms) return 0;
      // Le bonus EC est dans interimStandings
      return 0; // on va le lire depuis interimStandings
    });
    const interimData = interimStandings.filter(r => r.driverId === p.driverId);
    const ecBonusTotal = interimData.reduce((s, r) => s + (r.ecBonus ?? 0), 0);
    const ecBonusMoy   = interimData.length > 0 ? +(ecBonusTotal / interimData.length).toFixed(1) : 0;

    // MQ
    const allMqResults = meetings.flatMap(m => m.mq);
    const mqWithPos    = allMqResults.filter(r => r.position !== null);
    const mqPtsMoy     = mqWithPos.length > 0 ? +(mqWithPos.reduce((s,r) => s + r.points, 0) / mqWithPos.length).toFixed(1) : 0;
    const mqPosMoy     = mqWithPos.length > 0 ? +(mqWithPos.reduce((s,r) => s + r.position, 0) / mqWithPos.length).toFixed(1) : 0;

    // Intermédiaire
    const interimMeetings = meetings.filter(m => m.interim);
    const interimPtsTotal = interimMeetings.reduce((s, m) => s + (m.interim.interimPoints ?? 0), 0);
    const interimPosMoy   = interimMeetings.length > 0
      ? +(interimMeetings.reduce((s, m) => s + m.interim.position, 0) / interimMeetings.length).toFixed(1) : null;
    const interimPtsMoy   = interimMeetings.length > 0
      ? +(interimPtsTotal / interimMeetings.length).toFixed(1) : null;

    // DF
    const allDf       = meetings.flatMap(m => m.df);
    const dfWithPos   = allDf.filter(r => r.position !== null);
    const dfPosMoy    = dfWithPos.length > 0 ? +(dfWithPos.reduce((s,r) => s + r.position, 0) / dfWithPos.length).toFixed(1) : null;
    const dfPtsMoy    = dfWithPos.length > 0 ? +(dfWithPos.reduce((s,r) => s + r.points, 0) / dfWithPos.length).toFixed(1) : null;
    const nbDf        = meetings.filter(m => m.df.length > 0).length;

    // Finale
    const finMeetings = meetings.filter(m => m.fin);
    const finPosMoy   = finMeetings.length > 0 ? +(finMeetings.reduce((s, m) => s + m.fin.position, 0) / finMeetings.length).toFixed(1) : null;
    const finPtsMoy   = finMeetings.length > 0 ? +(finMeetings.reduce((s, m) => s + m.fin.points, 0) / finMeetings.length).toFixed(1) : null;

    // Phase finale (DF + Finale) par meeting
    const phaseFinalePts = meetings.map(m => {
      const df  = m.df.reduce((s, r) => s + r.points, 0);
      const fin = m.fin?.points ?? 0;
      return df + fin;
    });
    const phaseFinaleMoy = phaseFinalePts.length > 0
      ? +(phaseFinalePts.reduce((s,v) => s+v, 0) / phaseFinalePts.length).toFixed(1) : null;

    // Total meeting
    const totalMeetings = meetings.filter(m => m.total);
    const totalPtsAll   = totalMeetings.map(m => m.total.totalPts);
    const totalMoy      = totalPtsAll.length > 0 ? +(totalPtsAll.reduce((s,v) => s+v, 0) / totalPtsAll.length).toFixed(1) : null;
    const totalSum      = totalPtsAll.reduce((s,v) => s+v, 0);

    // Taux qualification
    const tauxDf  = nbMeetingsParticipated > 0 ? Math.round(nbDf / nbMeetingsParticipated * 100) : 0;
    const tauxFin = nbMeetingsParticipated > 0 ? Math.round(finMeetings.length / nbMeetingsParticipated * 100) : 0;

    // Progression : points par meeting dans l'ordre
    const progression = allMeetings.map(m => {
      const s = meetingStandings.find(r => r.driverId === p.driverId && r.meetingId === m.id);
      return s?.totalPts ?? null;
    });

    return {
      ...p,
      nbMeetings: nbMeetingsParticipated,
      // EC
      ecBonusTotal, ecBonusMoy,
      // MQ
      nbMq: allMqResults.length,
      mqPtsMoy, mqPosMoy,
      // Intermédiaire
      interimPtsTotal, interimPtsMoy, interimPosMoy,
      // DF
      nbDf, dfPosMoy, dfPtsMoy,
      // Finale
      nbFin: finMeetings.length, finPosMoy, finPtsMoy,
      // Phase finale
      phaseFinaleMoy,
      // Meeting
      totalSum, totalMoy,
      // Taux
      tauxDf, tauxFin,
      // Progression
      progression,
    };
  }).sort((a, b) => b.totalSum - a.totalSum);
}

function calcMqPoints(pos, total) {
  if (pos === 1) return 50;
  if (pos === 2) return 45;
  if (pos === 3) return 42;
  if (pos >= 4)  return Math.max(0, 44 - pos);
  return 0;
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-stats').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📊 <span>Statistiques</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="sta-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="sta-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <!-- Liste meetings -->
    <div id="sta-meetings" class="sta-meetings-list"></div>

    <!-- Tableau stats -->
    <div id="sta-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">📊</div>
        <div class="placeholder-title">Sélectionnez une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
}

function refreshMeetingList() {
  const el = document.getElementById('sta-meetings');
  if (!el || allMeetings.length === 0) return;
  el.innerHTML = `
    <div class="sta-meetings-bar">
      ${allMeetings.map((m, i) => {
        const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'}) : '?';
        return `<span class="sta-meeting-chip">M${i+1} — ${d} ${escHtml(m.location?.split(' ')[0] || '')}`;
      }).join('')}
    </div>`;
}

async function renderStats() {
  const content = document.getElementById('sta-content');
  if (!content) return;

  if (!selectedCategory) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📊</div><div class="placeholder-title">Sélectionnez une catégorie</div></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calcul des statistiques…</div>`;

  try {
    const stats = await calcStats();
    _lastStats = stats || [];
    if (!stats || stats.length === 0) {
      content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de données pour cette catégorie</div></div>`;
      return;
    }

    const meetingHeaders = allMeetings.map((m, i) => {
      const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', {day:'2-digit',month:'2-digit'}) : '?';
      return `<th class="center sta-col-meeting" title="${escHtml(m.location)}">M${i+1}<br><span style="font-size:0.65rem;font-weight:400">${d}</span></th>`;
    }).join('');

    content.innerHTML = `
      <!-- Progression saison -->
      <div class="sta-section">
        <div class="sta-section-title">📈 Points par meeting</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th style="width:46px">Pos.</th>
              <th>Pilote</th>
              <th class="center">N°</th>
              ${meetingHeaders}
              <th class="center sta-col-total" data-sort="totalSum">Total ↕</th>
              <th class="center sta-col-moy" data-sort="totalMoy">Moy/meeting ↕</th>
            </tr></thead>
            <tbody>
              ${stats.map((p, i) => `
                <tr>
                  <td class="center"><span class="${i<3?'std-pos-top':''}">${i+1}</span></td>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  ${p.progression.map(pts => `
                    <td class="center">${pts != null ? `<span class="sta-pts">${pts}</span>` : '<span class="sta-absent">—</span>'}</td>
                  `).join('')}
                  <td class="center"><strong class="sta-total">${p.totalSum}</strong></td>
                  <td class="center"><span class="sta-moy">${p.totalMoy ?? '—'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- EC -->
      <div class="sta-section">
        <div class="sta-section-title">⏱️ Essais chronométrés — bonus top 5</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Pilote</th><th class="center">N°</th>
              <th class="center" data-sort="ecBonusTotal">Pts bonus total ↕</th>
              <th class="center" data-sort="ecBonusMoy">Moy. bonus/meeting ↕</th>
            </tr></thead>
            <tbody>
              ${stats.filter(p => p.ecBonusTotal > 0).map(p => `
                <tr>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  <td class="center"><span class="sta-pts">${p.ecBonusTotal}</span></td>
                  <td class="center"><span class="sta-moy">${p.ecBonusMoy}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- MQ -->
      <div class="sta-section">
        <div class="sta-section-title">🏁 Manches qualificatives</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Pilote</th><th class="center">N°</th>
              <th class="center" data-sort="nbMq">Nb MQ ↕</th>
              <th class="center" data-sort="mqPtsMoy">Moy. pts MQ ↕</th>
              <th class="center" data-sort="mqPosMoy">Moy. place MQ ↕</th>
            </tr></thead>
            <tbody>
              ${stats.map(p => `
                <tr>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  <td class="center">${p.nbMq}</td>
                  <td class="center"><span class="sta-pts">${p.mqPtsMoy}</span></td>
                  <td class="center"><span class="sta-moy">${p.mqPosMoy || '—'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Intermédiaire -->
      <div class="sta-section">
        <div class="sta-section-title">📋 Classement intermédiaire</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Pilote</th><th class="center">N°</th>
              <th class="center" data-sort="nbMeetings">Meetings ↕</th>
              <th class="center" data-sort="interimPtsTotal">Pts inter. total ↕</th>
              <th class="center" data-sort="interimPtsMoy">Moy. pts inter. ↕</th>
              <th class="center" data-sort="interimPosMoy">Moy. place inter. ↕</th>
            </tr></thead>
            <tbody>
              ${stats.map(p => `
                <tr>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  <td class="center">${p.nbMeetings}</td>
                  <td class="center"><span class="sta-pts">${p.interimPtsTotal}</span></td>
                  <td class="center"><span class="sta-moy">${p.interimPtsMoy ?? '—'}</span></td>
                  <td class="center"><span class="sta-moy">${p.interimPosMoy ?? '—'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- DF -->
      <div class="sta-section">
        <div class="sta-section-title">⚡ Demi-finales</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Pilote</th><th class="center">N°</th>
              <th class="center" data-sort="nbDf">Nb DF ↕</th>
              <th class="center" data-sort="tauxDf">Taux qualif. ↕</th>
              <th class="center" data-sort="dfPosMoy">Moy. place ↕</th>
              <th class="center" data-sort="dfPtsMoy">Moy. pts ↕</th>
            </tr></thead>
            <tbody>
              ${stats.map(p => `
                <tr>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  <td class="center">${p.nbDf}</td>
                  <td class="center"><span class="sta-taux ${p.tauxDf >= 75 ? 'sta-taux--high' : p.tauxDf >= 50 ? 'sta-taux--mid' : 'sta-taux--low'}">${p.tauxDf}%</span></td>
                  <td class="center"><span class="sta-moy">${p.dfPosMoy ?? '—'}</span></td>
                  <td class="center"><span class="sta-pts">${p.dfPtsMoy ?? '—'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Finale -->
      <div class="sta-section">
        <div class="sta-section-title">🏆 Finales</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Pilote</th><th class="center">N°</th>
              <th class="center" data-sort="nbFin">Nb finales ↕</th>
              <th class="center" data-sort="tauxFin">Taux qualif. ↕</th>
              <th class="center" data-sort="finPosMoy">Moy. place ↕</th>
              <th class="center" data-sort="finPtsMoy">Moy. pts ↕</th>
              <th class="center" data-sort="phaseFinaleMoy">Moy. pts DF+Fin. ↕</th>
            </tr></thead>
            <tbody>
              ${stats.map(p => `
                <tr>
                  <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
                  <td class="center">${p.nbFin}</td>
                  <td class="center"><span class="sta-taux ${p.tauxFin >= 75 ? 'sta-taux--high' : p.tauxFin >= 50 ? 'sta-taux--mid' : 'sta-taux--low'}">${p.tauxFin}%</span></td>
                  <td class="center"><span class="sta-moy">${p.finPosMoy ?? '—'}</span></td>
                  <td class="center"><span class="sta-pts">${p.finPtsMoy ?? '—'}</span></td>
                  <td class="center"><span class="sta-pts">${p.phaseFinaleMoy ?? '—'}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    bindSortHeaders();
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

// ─────────────────────────────────────────────────────────
// TRI DES COLONNES
// ─────────────────────────────────────────────────────────

let _lastStats = []; // cache pour le tri sans re-fetch

function bindSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.title = 'Cliquer pour trier';
    th.addEventListener('click', () => {
      const table = th.closest('table');
      const key   = th.dataset.sort;
      const tableId = th.closest('.sta-section')?.querySelector('.sta-section-title')?.textContent?.trim() || key;

      if (sortState.table === tableId && sortState.key === key) {
        sortState.asc = !sortState.asc; // inverser
      } else {
        sortState.table = tableId;
        sortState.key   = key;
        sortState.asc   = false; // par défaut décroissant
      }

      // Mettre à jour les indicateurs visuels
      document.querySelectorAll('th[data-sort]').forEach(t => {
        t.classList.remove('sta-sort-asc', 'sta-sort-desc');
      });
      th.classList.add(sortState.asc ? 'sta-sort-asc' : 'sta-sort-desc');

      // Trier et re-rendre le tbody de ce tableau uniquement
      const tbody = table.querySelector('tbody');
      if (!tbody) return;

      const sorted = [..._lastStats].sort((a, b) => {
        const va = a[key] ?? (sortState.asc ? Infinity : -Infinity);
        const vb = b[key] ?? (sortState.asc ? Infinity : -Infinity);
        if (typeof va === 'string') return sortState.asc ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortState.asc ? va - vb : vb - va;
      });

      // Re-rendre les lignes du tableau concerné
      const renderers = {
        'progression': renderProgressionRows,
        'ecBonusTotal': renderEcRows,
        'ecBonusMoy': renderEcRows,
        'nbMq': renderMqRows,
        'mqPtsMoy': renderMqRows,
        'mqPosMoy': renderMqRows,
        'interimPtsTotal': renderInterimRows,
        'interimPtsMoy': renderInterimRows,
        'interimPosMoy': renderInterimRows,
        'nbDf': renderDfRows,
        'tauxDf': renderDfRows,
        'dfPosMoy': renderDfRows,
        'dfPtsMoy': renderDfRows,
        'nbFin': renderFinRows,
        'tauxFin': renderFinRows,
        'finPosMoy': renderFinRows,
        'finPtsMoy': renderFinRows,
        'phaseFinaleMoy': renderFinRows,
        'totalSum': renderProgressionRows,
        'totalMoy': renderProgressionRows,
      };

      const renderer = renderers[key];
      if (renderer) tbody.innerHTML = renderer(sorted);
    });
  });
}

// Fonctions de rendu des lignes par tableau
function renderProgressionRows(stats) {
  return stats.map((p, i) => `
    <tr>
      <td class="center"><span class="${i<3?'std-pos-top':''}">${i+1}</span></td>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      ${p.progression.map(pts => `
        <td class="center">${pts != null ? `<span class="sta-pts">${pts}</span>` : '<span class="sta-absent">—</span>'}</td>
      `).join('')}
      <td class="center"><strong class="sta-total">${p.totalSum}</strong></td>
      <td class="center"><span class="sta-moy">${p.totalMoy ?? '—'}</span></td>
    </tr>`).join('');
}

function renderEcRows(stats) {
  return stats.filter(p => p.ecBonusTotal > 0).map(p => `
    <tr>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      <td class="center"><span class="sta-pts">${p.ecBonusTotal}</span></td>
      <td class="center"><span class="sta-moy">${p.ecBonusMoy}</span></td>
    </tr>`).join('');
}

function renderMqRows(stats) {
  return stats.map(p => `
    <tr>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      <td class="center">${p.nbMq}</td>
      <td class="center"><span class="sta-pts">${p.mqPtsMoy}</span></td>
      <td class="center"><span class="sta-moy">${p.mqPosMoy || '—'}</span></td>
    </tr>`).join('');
}

function renderInterimRows(stats) {
  return stats.map(p => `
    <tr>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      <td class="center">${p.nbMeetings}</td>
      <td class="center"><span class="sta-pts">${p.interimPtsTotal}</span></td>
      <td class="center"><span class="sta-moy">${p.interimPtsMoy ?? '—'}</span></td>
      <td class="center"><span class="sta-moy">${p.interimPosMoy ?? '—'}</span></td>
    </tr>`).join('');
}

function renderDfRows(stats) {
  return stats.map(p => `
    <tr>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      <td class="center">${p.nbDf}</td>
      <td class="center"><span class="sta-taux ${p.tauxDf>=75?'sta-taux--high':p.tauxDf>=50?'sta-taux--mid':'sta-taux--low'}">${p.tauxDf}%</span></td>
      <td class="center"><span class="sta-moy">${p.dfPosMoy ?? '—'}</span></td>
      <td class="center"><span class="sta-pts">${p.dfPtsMoy ?? '—'}</span></td>
    </tr>`).join('');
}

function renderFinRows(stats) {
  return stats.map(p => `
    <tr>
      <td>${escHtml(p.firstName)} <strong>${escHtml(p.lastName)}</strong></td>
      <td class="center"><span class="tim-num">${escHtml(p.carNumber)}</span></td>
      <td class="center">${p.nbFin}</td>
      <td class="center"><span class="sta-taux ${p.tauxFin>=75?'sta-taux--high':p.tauxFin>=50?'sta-taux--mid':'sta-taux--low'}">${p.tauxFin}%</span></td>
      <td class="center"><span class="sta-moy">${p.finPosMoy ?? '—'}</span></td>
      <td class="center"><span class="sta-pts">${p.finPtsMoy ?? '—'}</span></td>
      <td class="center"><span class="sta-pts">${p.phaseFinaleMoy ?? '—'}</span></td>
    </tr>`).join('');
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('sta-year')?.addEventListener('change', async e => {
    selectedYear = parseInt(e.target.value);
    await loadMeetings();
    renderStats();
  });
  document.getElementById('sta-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    renderStats();
  });
}

// ─────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('stats-styles')) return;
  const style = document.createElement('style');
  style.id = 'stats-styles';
  style.textContent = `
    .sta-section { margin-bottom: var(--sp-xl); }
    .sta-section-title {
      font-family: var(--font-condensed);
      font-size: 0.8rem; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--clr-text-3);
      margin-bottom: var(--sp-sm);
      padding-bottom: var(--sp-xs);
      border-bottom: 1px solid var(--clr-border);
    }
    .sta-meetings-list { margin-bottom: var(--sp-md); }
    .sta-meetings-bar {
      display: flex; gap: 4px; flex-wrap: wrap;
      font-size: 0.75rem; color: var(--clr-text-3);
    }
    .sta-meeting-chip {
      background: var(--clr-surface);
      border: 1px solid var(--clr-border);
      border-radius: var(--r-sm);
      padding: 2px 8px;
    }
    .sta-col-meeting { min-width: 52px; font-size: 0.75rem; }
    .sta-col-total { min-width: 60px; border-left: 1px solid var(--clr-border); }
    .sta-col-moy { min-width: 80px; }

    .sta-pts    { font-family: var(--font-display); font-weight: 700; color: var(--clr-accent-2); }
    .sta-total  { font-family: var(--font-display); font-size: 1rem; font-weight: 700; color: var(--clr-accent-2); }
    .sta-moy    { font-family: var(--font-display); font-weight: 600; color: var(--clr-text-2); }
    .sta-absent { color: var(--clr-text-3); }

    .sta-taux {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-family: var(--font-display);
      font-size: 0.82rem;
      font-weight: 700;
    }
    .sta-taux--high { background: rgba(30,215,96,0.15);  color: var(--clr-success); }
    .sta-taux--mid  { background: rgba(255,170,0,0.15);  color: var(--clr-warning); }
    .sta-taux--low  { background: rgba(255,85,0,0.15);   color: var(--clr-danger); }

    /* Tri colonnes */
    th[data-sort] {
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: color var(--tr-fast);
    }
    th[data-sort]:hover { color: var(--clr-accent-2); }
    th[data-sort].sta-sort-asc::after  { content: ' ▲'; color: var(--clr-accent); font-size: 0.65rem; }
    th[data-sort].sta-sort-desc::after { content: ' ▼'; color: var(--clr-accent); font-size: 0.65rem; }

    .tim-num {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 36px; height: 24px;
      background: var(--clr-bg-3); border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm); font-family: var(--font-display);
      font-size: 0.75rem; font-weight: 700; color: var(--clr-accent-2); padding: 0 4px;
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initStats() {
  injectStyles();
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'stats') {
      renderView();
      await loadMeetings();
      if (selectedCategory) renderStats();
    }
  });
}