/* ═══════════════════════════════════════════════
   CHAMPIONSHIP.JS — Classement général saison
   Cumul par meeting : pts intermédiaire + DF + Finale
   Tous les meetings comptent, pas de joker
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings  = [];
let unsubMeetings = null;

let selectedYear     = new Date().getFullYear();
let selectedCategory = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

// ─────────────────────────────────────────────────────────
// FIRESTORE — HELPERS
// ─────────────────────────────────────────────────────────

async function fsQuery(collectionName, filters) {
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  let q = collection(db, collectionName);
  const constraints = filters.map(([field, op, val]) => where(field, op, val));
  const snap = await getDocs(query(q, ...constraints));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────────────────
// CALCUL DES POINTS PAR MEETING
// ─────────────────────────────────────────────────────────

/**
 * Pour un meeting donné, retourne les points de chaque pilote
 * depuis la collection meetingStandings (sauvegardée depuis Classements → Meeting).
 * Fallback : retourne [] si pas encore sauvegardé.
 */
async function getMeetingPoints(meetingId) {
  const rows = await fsQuery('meetingStandings', [
    ['meetingId', '==', meetingId],
    ['category',  '==', selectedCategory],
  ]);

  return rows.map(r => ({
    driverId:  r.driverId,
    carNumber: r.carNumber,
    firstName: r.firstName,
    lastName:  r.lastName,
    interim:   r.interimPts  ?? 0,
    df:        r.dfPts       ?? 0,
    fin:       r.finalePts   ?? 0,
    total:     r.totalPts    ?? 0,
  }));
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT CHAMPIONNAT SAISON
// ─────────────────────────────────────────────────────────

async function calcChampionship() {
  if (!selectedCategory || allMeetings.length === 0) return [];

  // Points cumulés par pilote sur tous les meetings
  const champMap = {}; // driverId → { info, meetingPts: {meetingId: total}, grandTotal }

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

    // En-têtes colonnes meetings
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
                  <td class="center">
                    <span class="chp-pos ${posClass}">${pos}</span>
                  </td>
                  <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
                  ${meetingCells}
                  <td class="center">
                    <strong class="chp-total">${d.grandTotal}</strong>
                  </td>
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
// STYLES
// ─────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('championship-styles')) return;
  const style = document.createElement('style');
  style.id = 'championship-styles';
  style.textContent = `
    .chp-meeting-col {
      min-width: 60px;
      font-size: 0.75rem;
      line-height: 1.3;
    }
    .chp-loc {
      font-size: 0.68rem;
      color: var(--clr-text-3);
      font-weight: 400;
      font-family: var(--font-body);
      letter-spacing: 0;
    }
    .chp-total-col {
      min-width: 70px;
      border-left: 1px solid var(--clr-border);
    }

    .chp-pos {
      font-family: var(--font-display);
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--clr-text-2);
    }
    .chp-pos-1 { color: #ffd700; font-size: 1rem; }
    .chp-pos-2 { color: #c0c0c0; }
    .chp-pos-3 { color: #cd7f32; }

    .chp-pts {
      font-family: var(--font-display);
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--clr-text);
    }
    .chp-absent { color: var(--clr-text-3); font-size: 0.8rem; }

    .chp-total {
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 700;
      color: var(--clr-accent-2);
    }

    /* Top 3 rows */
    tbody tr:has(.chp-pos-1) { background: rgba(255,215,0,0.04); }
    tbody tr:has(.chp-pos-2) { background: rgba(192,192,192,0.04); }
    tbody tr:has(.chp-pos-3) { background: rgba(205,127,50,0.04); }

    .chp-legend {
      display: flex;
      gap: var(--sp-sm);
      font-size: 0.78rem;
      color: var(--clr-text-3);
      padding: var(--sp-sm) 0;
      flex-wrap: wrap;
    }

    .tim-num {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 36px; height: 24px;
      background: var(--clr-bg-3);
      border: 1px solid var(--clr-border-2);
      border-radius: var(--r-sm);
      font-family: var(--font-display);
      font-size: 0.75rem; font-weight: 700;
      color: var(--clr-accent-2);
      padding: 0 4px;
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initChampionship() {
  injectStyles();
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'championship') {
      renderView();
      await loadMeetings();
    }
  });
}