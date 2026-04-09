/* ═══════════════════════════════════════════════
   CHAMPIONSHIP.JS — Classement général saison
   Cumul par meeting : pts intermédiaire + DF + Finale
   Calcul direct depuis les collections brutes
   Plus besoin de sauvegarder meetingStandings
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';
import { calcInterimStandings } from './calc.js';
import { getChampionshipConfig } from './settings.js';

let _activeRegulation = null;

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings   = [];
let unsubMeetings = null;

let selectedYear     = new Date().getFullYear();
let selectedCategory = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

// ─────────────────────────────────────────────────────────
// BARÈMES
// ─────────────────────────────────────────────────────────

const DF_POINTS  = [0, 10, 8, 6, 5, 4, 3, 2, 1];
const FIN_POINTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];

// ─────────────────────────────────────────────────────────
// FIRESTORE — HELPERS
// ─────────────────────────────────────────────────────────

async function fsQuery(collectionName, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const constraints = filters.map(([field, op, val]) => where(field, op, val));
  const snap = await getDocs(query(collection(db, collectionName), ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fsGetResults(sessionId) {
  return fsQuery('results', [['sessionId', '==', sessionId]]);
}

async function fsGetParticipants(sessionId) {
  return fsQuery('sessionParticipants', [['sessionId', '==', sessionId]]);
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS D'UNE PHASE (DF ou FIN)
// ─────────────────────────────────────────────────────────

async function calcPhasePoints(session) {
  const results      = await fsGetResults(session.id);
  const participants = await fsGetParticipants(session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const ptsFn = session.type === 'DF' ? (p => DF_POINTS[p] ?? 0) : (p => FIN_POINTS[p] ?? 0);

  const finished = participants
    .map(p => ({ driverId: p.driverId, ms: resultMap[p.driverId]?.ms ?? null, status: resultMap[p.driverId]?.status ?? null }))
    .filter(r => r.ms && !r.status)
    .sort((a, b) => a.ms - b.ms);

  const out = {};
  let pos = 1;
  finished.forEach(r => { out[r.driverId] = ptsFn(pos++); });

  // Pilotes avec statut spécial → 0 pts (1 pt DSQ_RACE)
  participants.forEach(p => {
    if (out[p.driverId] !== undefined) return;
    const r = resultMap[p.driverId];
    out[p.driverId] = r?.status === 'DSQ_RACE' ? 1 : 0;
  });

  return out; // { driverId → points }
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS PAR MEETING — DIRECT DEPUIS COLLECTIONS BRUTES
// Plus besoin de sauvegarder meetingStandings
// ─────────────────────────────────────────────────────────

async function getMeetingPoints(meetingId) {
  // 1. Sessions du meeting pour cette catégorie
  const sessions = await fsQuery('sessions', [
    ['meetingId', '==', meetingId],
    ['category',  '==', selectedCategory],
  ]);
  if (!sessions.length) return [];

  // 2. Classement intermédiaire (via calc.js — calcul direct)
  const interimRows = await calcInterimStandings(db, sessions, _activeRegulation);

  // Map driverId → données pilote + points intermédiaires
  const driverMap = {};
  interimRows.forEach(r => {
    driverMap[r.driverId] = {
      driverId:  r.driverId,
      carNumber: r.carNumber,
      firstName: r.firstName,
      lastName:  r.lastName,
      interim:   r.interimPoints ?? 0,
      df:        0,
      fin:       0,
    };
  });

  // 3. Points DF
  const dfSessions = sessions.filter(s => s.type === 'DF');
  for (const df of dfSessions) {
    const ptsMap = await calcPhasePoints(df);
    const parts  = await fsGetParticipants(df.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) {
        driverMap[p.driverId] = {
          driverId:  p.driverId,
          carNumber: p.carNumber,
          firstName: p.firstName,
          lastName:  p.lastName,
          interim: 0, df: 0, fin: 0,
        };
      }
      driverMap[p.driverId].df += ptsMap[p.driverId] ?? 0;
    });
  }

  // 4. Points Finale
  const finSession = sessions.find(s => s.type === 'FIN');
  if (finSession) {
    const ptsMap = await calcPhasePoints(finSession);
    const parts  = await fsGetParticipants(finSession.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) {
        driverMap[p.driverId] = {
          driverId:  p.driverId,
          carNumber: p.carNumber,
          firstName: p.firstName,
          lastName:  p.lastName,
          interim: 0, df: 0, fin: 0,
        };
      }
      driverMap[p.driverId].fin = ptsMap[p.driverId] ?? 0;
    });
  }

  // 5. Calculer le total et retourner
  return Object.values(driverMap).map(d => ({
    ...d,
    total: d.interim + d.df + d.fin,
  })).filter(d => d.interim > 0 || d.df > 0 || d.fin > 0); // exclure pilotes sans aucun point
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT CHAMPIONNAT SAISON
// ─────────────────────────────────────────────────────────

async function calcChampionship() {
  if (!selectedCategory || allMeetings.length === 0) return [];

  const champMap = {};

  for (const meeting of allMeetings) {
    const pts = await getMeetingPoints(meeting.id);
    pts.forEach(d => {
      if (!champMap[d.driverId]) {
        champMap[d.driverId] = {
          driverId:   d.driverId,
          carNumber:  d.carNumber,
          firstName:  d.firstName,
          lastName:   d.lastName,
          meetingPts: {},
          grandTotal: 0,
        };
      }
      champMap[d.driverId].meetingPts[meeting.id] = d.total;
      champMap[d.driverId].grandTotal += d.total;
    });
  }

  // Trier par total décroissant
  const standings = Object.values(champMap).sort((a, b) => b.grandTotal - a.grandTotal);

  // Attribuer les positions
  let pos = 1;
  standings.forEach((d, i) => {
    if (i > 0 && d.grandTotal === standings[i-1].grandTotal) {
      d.position = standings[i-1].position;
    } else {
      d.position = pos;
    }
    pos = i + 2;
  });

  return standings;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — MEETINGS
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubMeetings) unsubMeetings();
  const q = query(
    collection(db, 'meetings'),
    where('year', '==', selectedYear),
    orderBy('date', 'asc')
  );
  unsubMeetings = onSnapshot(q, snap => {
    allMeetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (selectedCategory) renderChampionship();
  });
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-championship').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🥇 <span>Championnat</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="chp-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="chp-category">
        <option value="">— Catégorie —</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <div id="chp-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">🥇</div>
        <div class="placeholder-title">Sélectionnez une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
  if (selectedCategory) renderChampionship();
}

async function renderChampionship() {
  const content = document.getElementById('chp-content');
  if (!content) return;

  if (!selectedCategory) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🥇</div><div class="placeholder-title">Sélectionnez une catégorie</div></div>`;
    return;
  }

  if (allMeetings.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📅</div><div class="placeholder-title">Aucun meeting pour ${selectedYear}</div></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calcul du championnat…</div>`;

  try {
    const standings = await calcChampionship();

    if (standings.length === 0) {
      content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de données pour cette catégorie</div></div>`;
      return;
    }

    const meetingHeaders = allMeetings.map(m => {
      const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' }) : '?';
      return `<th class="center chp-meeting-col" title="${escHtml(m.location)}">${d}<br><span class="chp-loc">${escHtml(m.location?.split(' ')[0] || '?')}</span></th>`;
    }).join('');

    content.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="center" style="width:46px">Pos.</th>
              <th>Pilote</th>
              <th class="center" style="width:50px">N°</th>
              ${meetingHeaders}
              <th class="center chp-total-col">Total</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map(d => {
              const pos = d.position;
              const posClass = pos === 1 ? 'chp-pos-1' : pos === 2 ? 'chp-pos-2' : pos === 3 ? 'chp-pos-3' : '';
              const meetingCells = allMeetings.map(m => {
                const pts = d.meetingPts[m.id];
                return `<td class="center">${pts != null ? `<span class="chp-pts">${pts}</span>` : '<span class="chp-absent">—</span>'}</td>`;
              }).join('');

              return `
                <tr>
                  <td class="center"><span class="chp-pos ${posClass}">${pos}</span></td>
                  <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
                  ${meetingCells}
                  <td class="center"><strong class="chp-total">${d.grandTotal}</strong></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="chp-legend">
        <span>Points / meeting = intermédiaire + ½ finale + finale</span>
        <span>·</span>
        <span>${allMeetings.length} meeting${allMeetings.length > 1 ? 's' : ''} · ${standings.length} pilote${standings.length > 1 ? 's' : ''}</span>
      </div>
    `;

  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('chp-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    loadMeetings();
  });

  document.getElementById('chp-category')?.addEventListener('change', e => {
    selectedCategory = e.target.value;
    renderChampionship();
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initChampionship() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'championship') {
      try { _activeRegulation = await getChampionshipConfig(); } catch { _activeRegulation = null; }
      renderView();
      await loadMeetings();
    }
  });
}