/* ═══════════════════════════════════════════════
   STANDINGS.JS — Calcul des points et classements
   EC, MQ, DF, FIN + classement intermédiaire
   Conforme règlement FFSA 2026
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast, categoryBadge, sessionBadge, statusBadge } from './app.js';
import { msToDisplay, escHtml } from './utils.js';
import { calcInterimStandings, calcEcStandings, calcMqStandings, dfPoints, finPoints } from './calc.js';
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
  const ptsFn       = (p) => session.type === 'DF' ? dfPoints(p, _activeRegulation) : finPoints(p, _activeRegulation);

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
      <button class="std-tab ${activeTab==='ec'?'is-active':''}"      data-tab="ec">Essais</button>
      <button class="std-tab ${activeTab==='mq'?'is-active':''}"      data-tab="mq">Manches</button>
      <button class="std-tab ${activeTab==='interim'?'is-active':''}" data-tab="interim">Intermédiaire</button>
      <button class="std-tab ${activeTab==='df'?'is-active':''}"      data-tab="df">½ Finales</button>
      <button class="std-tab ${activeTab==='fin'?'is-active':''}"     data-tab="fin">Finale</button>
      <button class="std-tab ${activeTab==='meeting'?'is-active':''}" data-tab="meeting">🏆 Meeting</button>
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

  let html = '';
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(db, mq, _activeRegulation);
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
      </div>`;
  }
  content.innerHTML = html;
}

// ← MODIFIÉ : calcul direct via calc.js — plus de bouton Sauvegarder,
//   plus de checkInterimFreshness, plus de lecture/écriture interimStandings Firestore
async function renderInterimTab(content) {
  const standings  = await calcInterimStandings(db, allSessions, _activeRegulation);
  const mqSessions = allSessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);

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
          <th class="center">EC+</th>
          <th class="center">Total MQ + EC</th>
          <th class="center">Pts inter.</th>
        </tr></thead>
        <tbody>
          ${standings.length === 0
            ? `<tr><td class="table-empty" colspan="${5 + mqSessions.length}">Pas encore assez de résultats (min. 2 MQ par pilote)</td></tr>`
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
                <td class="center">
                  ${r.ecBonus > 0 ? `<span class="std-bonus">+${r.ecBonus}</span>` : '—'}
                </td>
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

// ← MODIFIÉ : toutes les lectures Firestore interimStandings remplacées
//   par calcInterimStandings(db, allSessions) depuis calc.js
async function renderMeetingTab(content) {
  const finSession = allSessions.find(s => s.type === 'FIN');
  const dfSessions = allSessions.filter(s => s.type === 'DF').sort((a, b) => a.num - b.num);

  // 1. Résultats Finale
  let finStandings = [];
  if (finSession) {
    finStandings = await calcPhaseStandings(finSession);
  }

  // 2. Résultats DF (pour pilotes non en finale)
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

  // 3. IDs participants DF
  const dfParticipantIds = new Set();
  for (const df of dfSessions) {
    const parts = await getParticipants(df.id);
    parts.forEach(p => dfParticipantIds.add(p.driverId));
  }

  // ← MODIFIÉ : calcul direct, plus de lecture Firestore interimStandings
  const interimStandings = await calcInterimStandings(db, allSessions, _activeRegulation);
  const interimData = interimStandings
    .filter(r => !dfParticipantIds.has(r.driverId) && !finalistIds.has(r.driverId));

  // Construire le classement complet
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
      driverId:  r.driverId,
      carNumber: r.carNumber,
      firstName: r.firstName,
      lastName:  r.lastName,
      ms: null, status: null, points: null,
      globalPos: globalPos++,
      phase: 'Qualifs',
    });
  });

  if (allRows.length === 0) {
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⏳</div><div class="placeholder-title">Pas encore de résultats de finale</div></div>`;
    return;
  }

  // ← MODIFIÉ : intMap construit depuis le calcul en mémoire
  const intMap = {};
  interimStandings.forEach(r => { intMap[r.driverId] = r.interimPoints ?? 0; });

  // Points DF par pilote
  const dfPtsMap = {};
  for (const df of dfSessions) {
    const dfStandings = await calcPhaseStandings(df);
    dfStandings.forEach(r => {
      if (r.points != null) dfPtsMap[r.driverId] = (dfPtsMap[r.driverId] ?? 0) + r.points;
    });
  }

  // Construire globalMap
  const globalMap = {};
  allRows.forEach(r => {
    if (!globalMap[r.driverId]) {
      globalMap[r.driverId] = {
        driverId:  r.driverId,
        carNumber: r.carNumber,
        firstName: r.firstName,
        lastName:  r.lastName,
        interim:   intMap[r.driverId]   ?? 0,
        df:        dfPtsMap[r.driverId] ?? 0,
        fin:       r.phase === 'FIN' ? (r.points ?? 0) : 0,
      };
    } else if (r.phase === 'FIN') {
      globalMap[r.driverId].fin = r.points ?? 0;
    }
  });

  // ← MODIFIÉ : pilotes avec interimPoints mais absents de allRows
  //   lus depuis le calcul en mémoire (plus de lecture Firestore)
  interimStandings.forEach(r => {
    if (!globalMap[r.driverId]) {
      globalMap[r.driverId] = {
        driverId:  r.driverId,
        carNumber: r.carNumber,
        firstName: r.firstName,
        lastName:  r.lastName,
        interim:   r.interimPoints ?? 0,
        df:        dfPtsMap[r.driverId] ?? 0,
        fin:       0,
      };
    }
  });

  // Calculer total et trier
  const meetingRows = Object.values(globalMap).map(d => ({
    ...d,
    total: d.interim + d.df + d.fin,
  })).sort((a, b) => b.total - a.total);

  let mPos = 1;
  meetingRows.forEach((d, i) => {
    if (i > 0 && d.total === meetingRows[i - 1].total) {
      d.position = meetingRows[i - 1].position;
    } else {
      d.position = mPos;
    }
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
          <th class="center">½ Finales</th>
          <th class="center">Finale</th>
          <th class="center chp-total-col">Total</th>
        </tr></thead>
        <tbody>
          ${meetingRows.map(d => `
            <tr>
              <td class="center">
                <span class="${d.position <= 3 ? 'std-pos-top' : ''}">${d.position}</span>
              </td>
              <td>${escHtml(d.firstName)} <strong>${escHtml(d.lastName)}</strong></td>
              <td class="center"><span class="tim-num">${escHtml(d.carNumber)}</span></td>
              <td class="center">${d.interim > 0 ? d.interim : '<span class="chp-absent">—</span>'}</td>
              <td class="center">${d.df > 0     ? d.df      : '<span class="chp-absent">—</span>'}</td>
              <td class="center">${d.fin > 0    ? d.fin     : '<span class="chp-absent">—</span>'}</td>
              <td class="center chp-total-col">
                <strong class="chp-total">${d.total}</strong>
              </td>
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