/* ═══════════════════════════════════════════════
   STANDINGS.JS — Calcul des points et classements
   EC, MQ, DF, FIN + classement intermédiaire
   Conforme règlement FFSA 2026
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast, categoryBadge, sessionBadge, statusBadge } from './app.js';
import { msToDisplay, escHtml } from './utils.js';
import { calcInterimStandings, calcEcStandings, calcMqStandings, qfPoints, dfPoints, finPoints } from './calc.js';
import { buildMeetingClassification } from './competition.js';
import { getChampionshipConfig } from './settings.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';

// Baremes de points : desormais dans calc.js avec support reglement dynamique
// dfPoints et finPoints importes depuis calc.js

// Reglement actif (charge au demarrage)
let _activeRegulation = null;

async function loadActiveRegulation() {
  try {
    _activeRegulation = await getChampionshipConfig();
  } catch {
    _activeRegulation = null;
  }
}

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings   = [];
let allSessions   = [];
let unsubMeetings = null;
let unsubSessions = null;

let selectedYear      = new Date().getFullYear();
let selectedMeetingId = '';
let selectedCategory  = '';
let activeTab         = 'interim';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — HELPERS LOCAUX
// ─────────────────────────────────────────────────────────

async function getResults(sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'results'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getParticipants(sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => d.data());
}

async function saveToFirestore(collectionName, docId, data) {
  const { collection, doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await setDoc(doc(collection(db, collectionName), docId), data, { merge: true });
}

async function clearCollection(collectionName, meetingId, category) {
  const { collection, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, collectionName),
    where('meetingId', '==', meetingId),
    where('category',  '==', category)
  ));
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS DF / FINALE (local à standings.js)
// ─────────────────────────────────────────────────────────

async function calcPhaseStandings(session) {
  const results      = await getResults(session.id);
  const participants = await getParticipants(session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const rows = participants.map(p => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    ms:        resultMap[p.driverId]?.ms    ?? null,
    status:    resultMap[p.driverId]?.status ?? null,
  }));

  const finished    = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const dnfWithPos  = rows.filter(r => r.status === 'DNF' && r.manualPosition);
  const dnfNoPos    = rows.filter(r => r.status === 'DNF' && !r.manualPosition);
  const dsqRace     = rows.filter(r => r.status === 'DSQ_RACE');
  const dns         = rows.filter(r => r.status === 'DNS');
  const dsq         = rows.filter(r => r.status === 'DSQ');
  const noResult    = rows.filter(r => !r.ms && !r.status);
  const ptsFn = (p) => {
    if (session.type === 'QF')  return qfPoints(p, _activeRegulation);
    if (session.type === 'DF')  return dfPoints(p, _activeRegulation);
    return finPoints(p, _activeRegulation);
  };

  let pos = 1;
  const result = [];
  finished.forEach(r => result.push({ ...r, position: pos,   points: ptsFn(pos++) }));
  dnfWithPos.forEach(r => {
    const p = r.manualPosition;
    result.push({ ...r, position: p, points: ptsFn(p) });
  });
  dnfNoPos.forEach(r  => result.push({ ...r, position: null, points: 0 }));
  dsqRace.forEach(r   => result.push({ ...r, position: null, points: 1 }));
  dns.forEach(r       => result.push({ ...r, position: null, points: 0 }));
  dsq.forEach(r       => result.push({ ...r, position: null, points: 0 }));
  noResult.forEach(r  => result.push({ ...r, position: null, points: null }));

  return result;
}

// ─────────────────────────────────────────────────────────
// RENDU
// ─────────────────────────────────────────────────────────

function renderView() {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];

  document.getElementById('view-standings').innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🏆 <span>Classements</span></h2>
    </div>

    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="std-year">
        ${years.map(y => `<option value="${y}" ${y===selectedYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="std-meeting" style="flex:1;min-width:180px">
        <option value="">— Meeting —</option>
      </select>
      <select class="toolbar-select" id="std-category">
        <option value="">— Catégorie —</option>
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
      </select>
    </div>

    <div class="std-tabs" id="std-tabs" style="display:none">
      ${(() => {
        const ch = getActiveChampionship();
        const sc = ch?.sessionConfig || {};
        const ecEnabled = sc.EC?.enabled !== false;
        const qfEnabled = sc.QF?.enabled;
        let tabs = '';
        if (ecEnabled) tabs += `<button class="std-tab ${activeTab==='ec'?'is-active':''}" data-tab="ec">Essais</button>`;
        tabs += `<button class="std-tab ${activeTab==='mq'?'is-active':''}" data-tab="mq">Manches</button>`;
        tabs += `<button class="std-tab ${activeTab==='interim'?'is-active':''}" data-tab="interim">Intermédiaire</button>`;
        if (qfEnabled) tabs += `<button class="std-tab ${activeTab==='qf'?'is-active':''}" data-tab="qf">¼ Finales</button>`;
        tabs += `<button class="std-tab ${activeTab==='df'?'is-active':''}" data-tab="df">½ Finales</button>`;
        tabs += `<button class="std-tab ${activeTab==='fin'?'is-active':''}" data-tab="fin">Finale</button>`;
        tabs += `<button class="std-tab ${activeTab==='meeting'?'is-active':''}" data-tab="meeting">🏆 Meeting</button>`;
        return tabs;
      })()}
    </div>

    <div id="std-content">
      <div class="tim-placeholder">
        <div class="placeholder-icon">🏆</div>
        <div class="placeholder-title">Sélectionnez un meeting et une catégorie</div>
      </div>
    </div>
  `;

  bindEvents();
  refreshMeetingSelect();
}

function refreshMeetingSelect() {
  const sel = document.getElementById('std-meeting');
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

async function renderTab() {
  const content = document.getElementById('std-content');
  if (!content) return;

  if (!selectedMeetingId || !selectedCategory) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">🏆</div><div class="placeholder-title">Sélectionnez un meeting et une catégorie</div></div>`;
    return;
  }

  content.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calcul en cours…</div>`;

  try {
    switch (activeTab) {
      case 'ec':      await renderEcTab(content);      break;
      case 'mq':      await renderMqTab(content);      break;
      case 'interim': await renderInterimTab(content); break;
      case 'qf':      await renderQfTab(content);      break;
      case 'df':      await renderDfTab(content);      break;
      case 'fin':     await renderFinTab(content);     break;
      case 'meeting': await renderMeetingTab(content); break;
    }
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

// ← MODIFIÉ : utilise calcEcStandings(db, allSessions) depuis calc.js
async function renderEcTab(content) {
  const standings = await calcEcStandings(db, allSessions, _activeRegulation);
  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Essais chronométrés</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:50px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          <th class="right">Temps</th>
          <th class="center">Bonus</th>
        </tr></thead>
        <tbody>
          ${standings.length === 0
            ? `<tr><td class="table-empty" colspan="5">Aucun résultat saisi</td></tr>`
            : standings.map(r => `
              <tr>
                <td class="center">${r.position ?? '—'}</td>
                <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                <td class="right">
                  ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                </td>
                <td class="center">
                  ${r.bonusPoints > 0 ? `<span class="std-bonus">+${r.bonusPoints}</span>` : '—'}
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>`;
}

// ← MODIFIÉ : utilise calcMqStandings(db, mq) depuis calc.js
async function renderMqTab(content) {
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);
  if (mqSessions.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune manche qualificative</div></div>`;
    return;
  }

  const meeting = allMeetings.find(m => m.id === selectedMeetingId);
  const poleSide = meeting?.poleSide || 'droite';

  let html = '';
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(db, mq, _activeRegulation);
    const rawResults = await getResults(mq.id); // pour récupérer serie/couloir non exposés par calcMqStandings
    const graphHtml  = buildMqSeriesGraph(mq, rawResults, poleSide);

    html += `
      <div class="std-section">
        <div class="std-section-title">Manche qualificative ${mq.num}</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th class="center" style="width:50px">Pos.</th>
              <th>Pilote</th>
              <th class="center">N°</th>
              <th class="right">Temps</th>
              <th class="center">Points</th>
            </tr></thead>
            <tbody>
              ${standings.filter(r => r.points !== null).map(r => `
                <tr>
                  <td class="center">${r.position ?? '—'}</td>
                  <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                  <td class="right">
                    ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                  </td>
                  <td class="center"><strong>${r.points}</strong></td>
                </tr>`).join('')
              }
            </tbody>
          </table>
        </div>
        ${graphHtml}
      </div>`;
  }
  content.innerHTML = html;
}

// ─────────────────────────────────────────────────────────
// GRAPHIQUE SÉRIES / COULOIRS (SVG)
// ─────────────────────────────────────────────────────────

const SERIE_COLORS = [
  '#ff453a', '#30d158', '#0a84ff', '#bf5af2', '#ff9f0a',
  '#64d2ff', '#ffd60a', '#ff2d55', '#5e5ce6', '#98989d',
];

function buildMqSeriesGraph(mq, rawResults, poleSide) {
  // On ne garde que les pilotes ayant terminé (ms != null et status absent),
  // et ayant une série + un couloir renseignés.
  const pts = rawResults
    .filter(r => r.ms != null && !r.status && r.serie && r.couloir)
    .map(r => ({
      driverId: r.driverId,
      firstName: r.firstName,
      lastName:  r.lastName,
      carNumber: r.carNumber,
      ms: r.ms,
      serie: Number(r.serie),
      couloir: Number(r.couloir),
    }));

  if (pts.length === 0) {
    return `
      <div class="std-mq-graph std-mq-graph--empty">
        <div class="std-mq-graph-title">Répartition par couloir / série</div>
        <div class="std-mq-graph-empty">Aucune série / couloir renseigné pour cette manche.</div>
      </div>`;
  }

  // Bornes Y : plus rapide −2,5 s, plus lent +2,5 s (2,5 s de marge de chaque côté)
  const times = pts.map(p => p.ms);
  const fastest = Math.min(...times);
  const slowest = Math.max(...times);
  const yMin = Math.max(0, fastest - 2_500);
  const yMax = slowest + 2_500;
  const ySpan = Math.max(1, yMax - yMin);

  // Bornes X : 1..maxCouloir
  const maxCouloir = Math.max(...pts.map(p => p.couloir), 1);

  // Dimensions SVG — on augmente padR pour laisser la place aux labels à droite
  const W = 760;
  const H = 380;
  const padL = 75, padR = 55, padT = 30, padB = 55;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const reverseX = poleSide === 'droite';
  const xFor = (couloir) => {
    const ratio = maxCouloir === 1 ? 0.5 : (couloir - 1) / (maxCouloir - 1);
    const r = reverseX ? 1 - ratio : ratio;
    return padL + r * innerW;
  };
  // Axe Y : petit ms (temps rapide) → bas du graphique.
  const yForTime = (ms) => padT + (1 - (ms - yMin) / ySpan) * innerH;

  // Graduations Y (pas "joli" entre 1s et 2min, max 6 ticks)
  const niceStep = pickTickStep(ySpan, 6);
  const yTicks = [];
  const firstTick = Math.ceil(yMin / niceStep) * niceStep;
  for (let t = firstTick; t <= yMax; t += niceStep) yTicks.push(t);

  // Pré-calcul des positions de tous les points
  const placed = pts.map(p => ({
    ...p,
    cx: xFor(p.couloir),
    cy: yForTime(p.ms),
    color: SERIE_COLORS[(p.serie - 1) % SERIE_COLORS.length],
  }));

  // ── POINT 1 : ligne horizontale tiretée au meilleur temps de chaque série
  const bestBySerie = new Map();
  placed.forEach(p => {
    const prev = bestBySerie.get(p.serie);
    if (!prev || p.ms < prev.ms) bestBySerie.set(p.serie, p);
  });
  const bestLinesSvg = [...bestBySerie.entries()].map(([s, best]) => {
    const y = yForTime(best.ms).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"
      stroke="${best.color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.4"/>`;
  }).join('');

  // ── POINT 4 : polyline par série, reliant les points dans l'ordre visuel
  //             (gauche → droite) pour montrer l'effet du couloir sur le temps
  const bySerie = new Map();
  placed.forEach(p => {
    if (!bySerie.has(p.serie)) bySerie.set(p.serie, []);
    bySerie.get(p.serie).push(p);
  });
  const connectLinesSvg = [...bySerie.entries()].map(([s, list]) => {
    if (list.length < 2) return '';
    const sorted = [...list].sort((a, b) => a.cx - b.cx);
    const color = SERIE_COLORS[(s - 1) % SERIE_COLORS.length];
    const d = sorted.map(p => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
    return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.55" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');

  // ── Dots
  const dotsSvg = placed.map(p => {
    const tip = `Série ${p.serie} · Couloir ${p.couloir} · #${p.carNumber} ${p.firstName} ${p.lastName} · ${msToDisplay(p.ms)}`;
    return `<circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="6" fill="${p.color}" stroke="#000" stroke-width="0.5"><title>${escHtml(tip)}</title></circle>`;
  }).join('');

  // ── POINT 2 : labels #NNN avec anti-chevauchement
  // Stratégie :
  //  1) par couloir, tri par y croissant
  //  2) alternance côté droit / gauche du point pour réduire la densité
  //  3) chaque "pile" (droite puis gauche) applique un espacement vertical mini
  //  4) si le label a été poussé trop loin de son point, on trace une petite
  //     ligne-guide (leader line)
  const LABEL_H = 14;      // hauteur de la boîte occupée par un label
  const LABEL_DX = 10;     // décalage horizontal par rapport au point
  const LEADER_TOLERANCE = 7;
  const labels = [];
  const leaders = [];

  const byCouloir = new Map();
  placed.forEach((p, i) => {
    if (!byCouloir.has(p.couloir)) byCouloir.set(p.couloir, []);
    byCouloir.get(p.couloir).push(i);
  });

  for (const [, idxs] of byCouloir) {
    const sorted = idxs.map(i => ({ i, p: placed[i] }))
      .sort((a, b) => a.p.cy - b.p.cy);

    // Choisir le côté par défaut en fonction de la position X
    // (droite par défaut, sauf si on est près du bord droit du graphe)
    const preferLeft = sorted.length && sorted[0].p.cx > (padL + innerW * 0.75);
    const right = [];
    const left  = [];
    sorted.forEach((entry, idx) => {
      const defaultRight = preferLeft ? (idx % 2 === 1) : (idx % 2 === 0);
      (defaultRight ? right : left).push(entry);
    });

    const placeStack = (stack, side) => {
      if (stack.length === 0) return;
      const dx = side === 'right' ? LABEL_DX : -LABEL_DX;
      const anchor = side === 'right' ? 'start' : 'end';
      let lastY = -Infinity;
      stack.forEach(entry => {
        const { p, i } = entry;
        const natural = p.cy + 4;
        const yPlaced = Math.max(natural, lastY + LABEL_H);
        lastY = yPlaced;
        const labelX = p.cx + dx;
        labels.push({
          x: labelX.toFixed(1),
          y: yPlaced.toFixed(1),
          anchor,
          text: `#${p.carNumber}`,
          color: p.color,
          pointIdx: i,
        });
        // Leader line si le label a bougé notablement par rapport au point
        if (Math.abs(yPlaced - natural) > LEADER_TOLERANCE) {
          const leaderX2 = p.cx + dx * 0.55;
          leaders.push({
            x1: p.cx.toFixed(1),
            y1: p.cy.toFixed(1),
            x2: leaderX2.toFixed(1),
            y2: (yPlaced - 3).toFixed(1),
            color: p.color,
          });
        }
      });
    };
    placeStack(right, 'right');
    placeStack(left,  'left');
  }

  const leadersSvg = leaders.map(l =>
    `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${l.color}" stroke-width="0.8" opacity="0.5" />`
  ).join('');

  const labelsSvg = labels.map(l =>
    `<text x="${l.x}" y="${l.y}" fill="${l.color}" font-size="10" font-weight="700" text-anchor="${l.anchor}" dominant-baseline="middle" style="paint-order:stroke" stroke="#000" stroke-width="2.2" stroke-linejoin="round" stroke-opacity="0.75">${escHtml(l.text)}</text>`
  ).join('');

  // Lignes de grille + ticks Y
  const gridSvg = yTicks.map(t => {
    const y = yForTime(t).toFixed(1);
    return `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
      <text x="${padL - 8}" y="${y}" fill="#8a8a8a" font-size="10" text-anchor="end" dominant-baseline="middle">${msToDisplay(t)}</text>
    `;
  }).join('');

  // Ticks X (couloirs)
  const xTicksSvg = Array.from({ length: maxCouloir }, (_, i) => i + 1).map(c => {
    const x = xFor(c).toFixed(1);
    return `
      <line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="rgba(255,255,255,0.04)" />
      <text x="${x}" y="${H - padB + 18}" fill="#cfcfcf" font-size="11" text-anchor="middle" font-weight="600">C${c}</text>
    `;
  }).join('');

  // Légende couleurs par série
  const seriesSet = [...new Set(placed.map(p => p.serie))].sort((a, b) => a - b);
  const legendHtml = seriesSet.map(s => {
    const color = SERIE_COLORS[(s - 1) % SERIE_COLORS.length];
    return `<span class="std-graph-legend-item"><span class="std-graph-legend-dot" style="background:${color}"></span>Série ${s}</span>`;
  }).join('');

  const arrowHint = reverseX
    ? `<span class="std-graph-hint">◀ 1er virage à droite — couloir 1 à droite</span>`
    : `<span class="std-graph-hint">1er virage à gauche — couloir 1 à gauche ▶</span>`;

  return `
    <div class="std-mq-graph">
      <div class="std-mq-graph-head">
        <div class="std-mq-graph-title">Répartition par couloir / série — MQ${mq.num}</div>
        ${arrowHint}
      </div>
      <div class="std-mq-graph-legend">${legendHtml}</div>
      <div class="std-mq-graph-svg-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="std-mq-graph-svg" preserveAspectRatio="xMidYMid meet">
          <!-- Axes -->
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#666" stroke-width="1" />
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#666" stroke-width="1" />
          <!-- Grille Y + labels temps -->
          ${gridSvg}
          <!-- Grille X (couloirs) -->
          ${xTicksSvg}
          <!-- Meilleur temps par série (ligne horizontale tiretee) -->
          ${bestLinesSvg}
          <!-- Lignes reliant les pilotes d'une meme serie (ordre visuel des couloirs) -->
          ${connectLinesSvg}
          <!-- Leader lines (lignes-guides vers les labels deplaces) -->
          ${leadersSvg}
          <!-- Points -->
          ${dotsSvg}
          <!-- Labels numero de voiture (anti-chevauchement) -->
          ${labelsSvg}
          <!-- Titres des axes -->
          <text x="${padL - 50}" y="${padT - 12}" fill="#cfcfcf" font-size="11" font-weight="600">Temps</text>
          <text x="${W - padR}" y="${H - 8}" fill="#cfcfcf" font-size="11" text-anchor="end" font-weight="600">Couloir</text>
        </svg>
      </div>
    </div>
  `;
}

function pickTickStep(span, target) {
  // Retourne un pas "joli" en ms (1s, 2s, 5s, 10s, 20s, 30s, 60s…)
  const candidates = [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000, 120_000];
  const rough = span / target;
  for (const c of candidates) if (c >= rough) return c;
  return candidates[candidates.length - 1];
}

// ← MODIFIÉ : calcul direct via calc.js — plus de bouton Sauvegarder,
//   plus de checkInterimFreshness, plus de lecture/écriture interimStandings Firestore
async function renderInterimTab(content) {
  const standings  = await calcInterimStandings(db, allSessions, _activeRegulation);
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);
  const chI = getActiveChampionship();
  const ecEnabled = chI?.sessionConfig?.EC?.enabled !== false;

  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Classement intermédiaire</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:46px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          ${mqSessions.map(mq => `<th class="center">MQ${mq.num}</th>`).join('')}
          ${ecEnabled ? '<th class="center">EC+</th>' : ''}
          <th class="center">Total MQ${ecEnabled ? ' + EC' : ''}</th>
          <th class="center">Pts inter.</th>
        </tr></thead>
        <tbody>
          ${standings.length === 0
            ? `<tr><td class="table-empty" colspan="${(ecEnabled ? 5 : 4) + mqSessions.length}">Pas encore assez de résultats (min. 2 MQ par pilote)</td></tr>`
            : standings.map(r => `
              <tr class="${r.position <= 16 ? '' : 'std-row-reserve'}">
                <td class="center">
                  <span class="${r.position <= 8 ? 'std-pos-top' : ''}">${r.position}</span>
                </td>
                <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                ${mqSessions.map(mq => `
                  <td class="center">${r.mqPoints[mq.num] !== undefined ? r.mqPoints[mq.num] : '—'}</td>
                `).join('')}
                ${ecEnabled ? `<td class="center">
                  ${r.ecBonus > 0 ? `<span class="std-bonus">+${r.ecBonus}</span>` : '—'}
                </td>` : ''}
                <td class="center"><strong>${r.totalPoints}</strong></td>
                <td class="center">
                  ${r.position <= 16
                    ? `<strong class="text-accent">${r.interimPoints}</strong>`
                    : '—'}
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>
    ${standings.length > 0 ? (() => {
      const champ = getActiveChampionship();
      const sc = champ?.sessionConfig || {};
      const hasQF = sc.QF?.enabled;
      const qfCount = sc.QF?.count || 4;
      const qfGrid = sc.QF?.gridSize || 6;
      const dfCount = sc.DF?.count || 2;
      const dfGrid = sc.DF?.gridSize || 8;
      if (hasQF) {
        const totalQF = qfCount * qfGrid;
        return '<div class="std-note">Top ' + totalQF + ' qualifies pour les ' + qfCount + ' quarts de finale</div>';
      }
      const totalDF = dfCount * dfGrid;
      return '<div class="std-note">Top ' + totalDF + ' qualifies pour les demi-finales</div>';
    })() : ''}
  `;
}

// ─────────────────────────────────────────────────────────
// ONGLET 1/4 FINALES
// ─────────────────────────────────────────────────────────

async function renderQfTab(content) {
  const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
  if (qfSessions.length === 0) {
    content.innerHTML = '<div class="std-empty">Pas de quarts de finale pour ce meeting</div>';
    return;
  }

  const fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  let html = '<div class="std-table-title">Quarts de Finale</div>';

  for (const qf of qfSessions) {
    const partSnap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', qf.id)));
    const parts = partSnap.docs.map(d => d.data());
    const resSnap = await fs.getDocs(fs.query(fs.collection(db, 'results'), fs.where('sessionId', '==', qf.id)));
    const resMap = {};
    resSnap.docs.forEach(d => { resMap[d.data().driverId] = d.data(); });

    const rows = parts.map(p => ({
      driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
      ms: resMap[p.driverId]?.ms ?? null, status: resMap[p.driverId]?.status ?? null,
    }));

    const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
    const dnf = rows.filter(r => r.status === 'DNF');
    const dns = rows.filter(r => r.status === 'DNS');
    const dsq = rows.filter(r => r.status === 'DSQ' || r.status === 'DSQ_RACE');
    const noResult = rows.filter(r => !r.ms && !r.status);
    const sorted = [...finished, ...dnf, ...dsq, ...dns, ...noResult];

    const champ = getActiveChampionship();
    const qualPerQF = champ?.sessionConfig?.QF?.qualifiedPerQF || 3;

    html += '<div class="std-sub-header" style="margin-top:var(--sp-md)">' + escHtml(qf.label) + ' (' + parts.length + ' pilotes)</div>';
    html += '<div class="table-wrap" style="margin-bottom:var(--sp-md)"><table><thead><tr>';
    html += '<th>Pos.</th><th>Pilote</th><th class="center">N\u00b0</th><th class="center">Temps</th><th>Statut</th>';
    html += '</tr></thead><tbody>';

    let pos = 1;
    sorted.forEach(r => {
      const hasTime = r.ms != null;
      const position = hasTime ? pos++ : null;
      const isQualified = position !== null && position <= qualPerQF;
      html += '<tr' + (isQualified ? ' style="background:rgba(30,215,96,0.08)"' : '') + '>';
      html += '<td class="center">' + (position || '—') + '</td>';
      html += '<td>' + escHtml(r.firstName) + ' <strong>' + escHtml(r.lastName) + '</strong></td>';
      html += '<td class="center"><span class="tim-num">' + escHtml(r.carNumber) + '</span></td>';
      html += '<td class="center">' + (hasTime ? msToDisplay(r.ms) : '—') + '</td>';
      html += '<td>' + (r.status ? statusBadge(r.status) : '') + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
  }

  content.innerHTML = html;
}

async function renderDfTab(content) {
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  if (dfSessions.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune demi-finale</div></div>`;
    return;
  }
  let html = '';
  for (const df of dfSessions) {
    const standings = await calcPhaseStandings(df);
    html += renderPhaseTable(`Demi-finale ${df.num}`, standings);
  }
  content.innerHTML = html;
}

async function renderFinTab(content) {
  const finSession = allSessions.find(s => s.type === 'FIN');
  if (!finSession) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-title">Aucune finale</div></div>`;
    return;
  }
  const standings = await calcPhaseStandings(finSession);
  content.innerHTML = renderPhaseTable('Finale', standings);
}

function renderPhaseTable(title, standings) {
  return `
    <div class="std-section">
      <div class="std-section-title">${title}</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th class="center" style="width:50px">Pos.</th>
            <th>Pilote</th>
            <th class="center">N°</th>
            <th class="right">Temps</th>
            <th class="center">Points</th>
          </tr></thead>
          <tbody>
            ${standings.length === 0
              ? `<tr><td class="table-empty" colspan="5">Aucun résultat saisi</td></tr>`
              : standings.map(r => `
                <tr>
                  <td class="center">${r.position ? `<span class="${r.position <= 3 ? 'std-pos-top' : ''}">${r.position}</span>` : '—'}</td>
                  <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong></td>
                  <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
                  <td class="right">
                    ${r.ms ? `<span class="tim-time">${msToDisplay(r.ms)}</span>` : statusBadge(r.status) || '—'}
                  </td>
                  <td class="center"><strong>${r.points !== null ? r.points : '—'}</strong></td>
                </tr>`).join('')
            }
          </tbody>
        </table>
      </div>
    </div>`;
}

async function renderMeetingTab(content) {
  const champ = getActiveChampionship();
  const mode = champ?.meetingClassificationMode || 'points';

  if (mode === 'cascade') {
    await renderMeetingCascade(content);
  } else {
    await renderMeetingPoints(content);
  }
}

// ─── Mode POINTS (FFSA) ─────────────────────────────────
async function renderMeetingPoints(content) {
  const finSession = allSessions.find(s => s.type === 'FIN');
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const champ = getActiveChampionship();
  const qfEnabled = champ?.sessionConfig?.QF?.enabled;

  let finStandings = [];
  if (finSession) finStandings = await calcPhaseStandings(finSession);

  const finalistIds = new Set(finStandings.map(r => r.driverId));
  let dfRows = [];
  for (const df of dfSessions) {
    const rows = await calcPhaseStandings(df);
    rows.forEach(r => {
      if (!finalistIds.has(r.driverId)) dfRows.push({ ...r, dfNum: df.num });
    });
  }
  dfRows.sort((a, b) => {
    if ((b.points ?? 0) !== (a.points ?? 0)) return (b.points ?? 0) - (a.points ?? 0);
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  const dfParticipantIds = new Set();
  for (const df of dfSessions) {
    const parts = await getParticipants(df.id);
    parts.forEach(p => dfParticipantIds.add(p.driverId));
  }

  const interimStandings = await calcInterimStandings(db, allSessions, _activeRegulation);
  const interimData = interimStandings
    .filter(r => !dfParticipantIds.has(r.driverId) && !finalistIds.has(r.driverId));

  let globalPos = 1;
  const allRows = [];
  finStandings.filter(r => r.ms || r.status).forEach(r => {
    allRows.push({ ...r, globalPos: globalPos++, phase: 'FIN' });
  });
  dfRows.forEach(r => {
    allRows.push({ ...r, globalPos: globalPos++, phase: `DF${r.dfNum}` });
  });
  interimData.forEach(r => {
    allRows.push({
      driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
      ms: null, status: null, points: null, globalPos: globalPos++, phase: 'Qualifs',
    });
  });

  if (allRows.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de résultats</div></div>`;
    return;
  }

  const intMap = {};
  interimStandings.forEach(r => { intMap[r.driverId] = r.interimPoints ?? 0; });
  const dfPtsMap = {};
  for (const df of dfSessions) {
    const dfStandings = await calcPhaseStandings(df);
    dfStandings.forEach(r => {
      if (r.points != null) dfPtsMap[r.driverId] = (dfPtsMap[r.driverId] ?? 0) + r.points;
    });
  }

  // QF points if enabled
  const qfPtsMap = {};
  if (qfEnabled) {
    const qfSessions = allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num);
    for (const qf of qfSessions) {
      const rows = await calcPhaseStandings(qf);
      rows.forEach(r => {
        if (r.points != null) qfPtsMap[r.driverId] = (qfPtsMap[r.driverId] ?? 0) + r.points;
      });
    }
  }

  const globalMap = {};
  allRows.forEach(r => {
    if (!globalMap[r.driverId]) {
      globalMap[r.driverId] = {
        driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
        interim: intMap[r.driverId] ?? 0, qf: qfPtsMap[r.driverId] ?? 0,
        df: dfPtsMap[r.driverId] ?? 0, fin: r.phase === 'FIN' ? (r.points ?? 0) : 0,
      };
    } else if (r.phase === 'FIN') {
      globalMap[r.driverId].fin = r.points ?? 0;
    }
  });
  interimStandings.forEach(r => {
    if (!globalMap[r.driverId]) {
      globalMap[r.driverId] = {
        driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
        interim: r.interimPoints ?? 0, qf: qfPtsMap[r.driverId] ?? 0, df: dfPtsMap[r.driverId] ?? 0, fin: 0,
      };
    }
  });

  const meetingRows = Object.values(globalMap).map(d => ({
    ...d, total: d.interim + d.qf + d.df + d.fin,
  })).sort((a, b) => b.total - a.total);

  let mPos = 1;
  meetingRows.forEach((d, i) => {
    if (i > 0 && d.total === meetingRows[i - 1].total) d.position = meetingRows[i - 1].position;
    else d.position = mPos;
    mPos = i + 2;
  });

  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Classement complet du meeting</span>
      <button class="btn btn-primary btn-sm" id="std-save-meeting">💾 Sauvegarder</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:46px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          <th class="center">Intermédiaire</th>
          ${qfEnabled ? '<th class="center">¼ Finales</th>' : ''}
          <th class="center">½ Finales</th>
          <th class="center">Finale</th>
          <th class="center chp-total-col">Total</th>
        </tr></thead>
        <tbody>
          ${meetingRows.map(d => `
            <tr>
              <td class="center"><span class="${d.position <= 3 ? 'std-pos-top' : ''}">${d.position}</span></td>
              <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
              <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
              <td class="center">${d.interim > 0 ? d.interim : '<span class="chp-absent">—</span>'}</td>
              ${qfEnabled ? `<td class="center">${d.qf > 0 ? d.qf : '<span class="chp-absent">—</span>'}</td>` : ''}
              <td class="center">${d.df > 0 ? d.df : '<span class="chp-absent">—</span>'}</td>
              <td class="center">${d.fin > 0 ? d.fin : '<span class="chp-absent">—</span>'}</td>
              <td class="center chp-total-col"><strong class="chp-total">${d.total}</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('std-save-meeting')?.addEventListener('click', async () => {
    if (meetingRows.length === 0) { toast('Aucun résultat à sauvegarder', 'warning'); return; }
    const btn = document.getElementById('std-save-meeting');
    btn.disabled = true; btn.textContent = '⏳ Sauvegarde…';
    await saveMeetingStandings(meetingRows);
    btn.disabled = false; btn.textContent = '✅ Sauvegardé';
    setTimeout(() => { if (btn) btn.textContent = '💾 Sauvegarder'; }, 2000);
    toast('Classement du meeting sauvegardé ✓', 'success');
  });
}

// ─── Mode CASCADE (FIA) ─────────────────────────────────
async function renderMeetingCascade(content) {
  const champ = getActiveChampionship();
  const sc = champ?.sessionConfig || {};
  const qfEnabled = sc.QF?.enabled;
  const qualPerDF = sc.DF?.qualifiedPerDF || 3;
  const qualPerQF = sc.QF?.qualifiedPerQF || 3;
  const gridSizeDF = sc.DF?.gridSize || 6;
  const gridSizeQF = sc.QF?.gridSize || 6;

  const fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

  // Fetch all phase results
  const finSession = allSessions.find(s => s.type === 'FIN');
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);
  const qfSessions = qfEnabled ? allSessions.filter(s => s.type === 'QF').sort((a, b) => a.num - b.num) : [];

  // Finale results (sorted by position)
  let finResults = [];
  if (finSession) {
    const rows = await calcPhaseStandings(finSession);
    finResults = rows.filter(r => r.ms || r.status === 'DNF');
  }

  // DF results per DF session (sorted by position)
  const dfResults = [];
  for (const df of dfSessions) {
    const rows = await calcPhaseStandings(df);
    // Include all with result (time or DNF)
    dfResults.push(rows.filter(r => r.ms || r.status === 'DNF'));
  }

  // QF results per QF session (sorted by position)
  const qfResults = [];
  for (const qf of qfSessions) {
    const partSnap = await fs.getDocs(fs.query(fs.collection(db, 'sessionParticipants'), fs.where('sessionId', '==', qf.id)));
    const parts = partSnap.docs.map(d => d.data());
    const resSnap = await fs.getDocs(fs.query(fs.collection(db, 'results'), fs.where('sessionId', '==', qf.id)));
    const resMap = {};
    resSnap.docs.forEach(d => { resMap[d.data().driverId] = d.data(); });
    const rows = parts.map(p => ({
      driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName, lastName: p.lastName,
      ms: resMap[p.driverId]?.ms ?? null, status: resMap[p.driverId]?.status ?? null,
    }));
    const order = r => r.ms ? r.ms : r.status === 'DNF' ? 9e6 : 9e9;
    rows.sort((a, b) => order(a) - order(b));
    qfResults.push(rows.filter(r => r.ms || r.status === 'DNF'));
  }

  // Interim MQ ranking
  const interimRanking = await calcInterimStandings(db, allSessions, _activeRegulation);

  // Detect forfaits: participants in a phase session who have no result
  const forfaits = { fin: [], df: [], qf: [] };

  // DF forfaits: participants without result
  for (let i = 0; i < dfSessions.length; i++) {
    const parts = await getParticipants(dfSessions[i].id);
    const resultIds = new Set(dfResults[i].map(r => r.driverId));
    parts.forEach(p => {
      if (!resultIds.has(p.driverId)) {
        forfaits.df.push({ ...p, dfNum: i + 1 });
      }
    });
  }

  // FIN forfaits: participants without result
  if (finSession) {
    const parts = await getParticipants(finSession.id);
    const resultIds = new Set(finResults.map(r => r.driverId));
    parts.forEach(p => {
      if (!resultIds.has(p.driverId)) {
        // Find their DF position for tiebreaking
        let dfPos = 99, dfMs = Infinity;
        dfResults.forEach(dfRes => {
          const idx = dfRes.findIndex(r => r.driverId === p.driverId);
          if (idx >= 0) { dfPos = idx + 1; dfMs = dfRes[idx].ms ?? Infinity; }
        });
        forfaits.fin.push({ ...p, dfPosition: dfPos, dfMs });
      }
    });
  }

  // QF forfaits: participants without result
  for (let i = 0; i < qfSessions.length; i++) {
    const parts = await getParticipants(qfSessions[i].id);
    const resultIds = new Set(qfResults[i]?.map(r => r.driverId) || []);
    parts.forEach(p => {
      if (!resultIds.has(p.driverId)) {
        forfaits.qf.push({ ...p, qfNum: i + 1 });
      }
    });
  }

  const ranking = buildMeetingClassification(
    finResults, dfResults, qfResults, interimRanking,
    { qualifiedPerDF: qualPerDF, qualifiedPerQF: qualPerQF, gridSizeDF, gridSizeQF },
    forfaits
  );

  if (ranking.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de résultats</div></div>`;
    return;
  }

  // Phase labels
  const phaseLabel = (r) => {
    if (r.phase === 'FIN') return r.forfait ? 'FIN (frf)' : 'Finale';
    if (r.phase === 'DF')  return r.forfait ? 'DF (frf)' : '½ Finale';
    if (r.phase === 'QF')  return r.forfait ? 'QF (frf)' : '¼ Finale';
    return 'Qualifs';
  };
  const phaseClass = (r) => {
    if (r.phase === 'FIN') return 'std-phase-fin';
    if (r.phase === 'DF')  return 'std-phase-df';
    if (r.phase === 'QF')  return 'std-phase-qf';
    return 'std-phase-mq';
  };

  content.innerHTML = `
    <div class="std-header-row">
      <span class="std-table-title">Classement Meeting — Cascade</span>
      <button class="btn btn-primary btn-sm" id="std-save-meeting">💾 Sauvegarder</button>
    </div>
    <div class="std-note">Classement par phase : Finale > ½ Finales${qfEnabled ? ' > ¼ Finales' : ''} > Qualifications</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="center" style="width:46px">Pos.</th>
          <th>Pilote</th>
          <th class="center">N°</th>
          <th class="center">Phase</th>
          <th class="center">Pos. phase</th>
        </tr></thead>
        <tbody>
          ${ranking.map(r => `
            <tr class="${r.forfait ? 'std-row-reserve' : ''}">
              <td class="center">
                <span class="${r.meetingPosition <= 3 ? 'std-pos-top' : ''}">${r.meetingPosition}</span>
              </td>
              <td>${escHtml(r.firstName)} <strong>${escHtml(r.lastName)}</strong>${r.forfait ? ' <span style="font-size:0.7rem;color:var(--clr-danger)">frf</span>' : ''}</td>
              <td class="center"><span class="tim-num">${escHtml(r.carNumber)}</span></td>
              <td class="center"><span class="${phaseClass(r)}">${phaseLabel(r)}</span></td>
              <td class="center">${r.phasePosition || r.dfPosition || r.qfPosition || '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('std-save-meeting')?.addEventListener('click', async () => {
    if (ranking.length === 0) { toast('Aucun résultat à sauvegarder', 'warning'); return; }
    const btn = document.getElementById('std-save-meeting');
    btn.disabled = true; btn.textContent = '⏳ Sauvegarde…';
    const meetingRows = ranking.map(r => ({
      driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
      position: r.meetingPosition, phase: r.phase, total: 0,
    }));
    await saveMeetingStandings(meetingRows);
    btn.disabled = false; btn.textContent = '✅ Sauvegardé';
    setTimeout(() => { if (btn) btn.textContent = '💾 Sauvegarder'; }, 2000);
    toast('Classement du meeting sauvegardé ✓', 'success');
  });
}

async function saveMeetingStandings(rows) {
  const { collection, addDoc, query, where, getDocs, writeBatch } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'meetingStandings'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory)
  ));
  if (!snap.empty) {
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  const col = collection(db, 'meetingStandings');
  for (const d of rows) {
    await addDoc(col, {
      meetingId:  selectedMeetingId,
      category:   selectedCategory,
      year:       selectedYear,
      driverId:   d.driverId,
      carNumber:  d.carNumber,
      firstName:  d.firstName,
      lastName:   d.lastName,
      position:   d.position,
      interimPts: d.interim,
      dfPts:      d.df,
      finalePts:  d.fin,
      totalPts:   d.total,
      updatedAt:  new Date(),
    });
  }
}

// ─────────────────────────────────────────────────────────
// FIRESTORE — MEETINGS & SESSIONS
// ─────────────────────────────────────────────────────────

async function loadMeetings() {
  if (!db) return;
  const { collection, query, where, orderBy, onSnapshot } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  if (unsubMeetings) unsubMeetings();
  const q = query(collection(db, 'meetings'), where('year', '==', selectedYear), orderBy('date', 'asc'));
  unsubMeetings = onSnapshot(q, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const champId = getActiveChampionshipId();
    allMeetings = champId ? all.filter(m => m.championshipId === champId || !m.championshipId) : all;
    refreshMeetingSelect();
  });
}

async function loadSessions() {
  if (!db || !selectedMeetingId || !selectedCategory) { allSessions = []; return; }
  const { collection, query, where, orderBy, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessions'),
    where('meetingId', '==', selectedMeetingId),
    where('category',  '==', selectedCategory),
    orderBy('order', 'asc')
  ));
  allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────────────────
// ÉVÉNEMENTS
// ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('std-year')?.addEventListener('change', e => {
    selectedYear = parseInt(e.target.value);
    selectedMeetingId = '';
    loadMeetings();
  });

  document.getElementById('std-meeting')?.addEventListener('change', async e => {
    selectedMeetingId = e.target.value;
    await loadSessions();
    showTabs();
    renderTab();
  });

  document.getElementById('std-category')?.addEventListener('change', async e => {
    selectedCategory = e.target.value;
    await loadSessions();
    showTabs();
    renderTab();
  });
}

function showTabs() {
  const tabs = document.getElementById('std-tabs');
  if (tabs) tabs.style.display = selectedMeetingId && selectedCategory ? 'flex' : 'none';

  document.querySelectorAll('.std-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.std-tab').forEach(b => b.classList.toggle('is-active', b === btn));
      renderTab();
    });
  });
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initStandings() {
  document.addEventListener('viewchange', async e => {
    if (e.detail.view === 'standings') {
      await loadActiveRegulation();
      renderView();
      await loadMeetings();
      if (selectedMeetingId && selectedCategory) {
        await loadSessions();
        showTabs();
        renderTab();
      }
    }
  });
  document.addEventListener('championshipchange', () => { loadMeetings(); });
}