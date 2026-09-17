/* ═══════════════════════════════════════════════
   CHAMPIONSHIP.JS — Classement général saison
   Cumul par meeting : pts intermédiaire + DF + Finale
   Calcul direct depuis les collections brutes
   Plus besoin de sauvegarder meetingStandings
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { toast } from './app.js';
import { escHtml, dedupeParticipants } from './utils.js';
import { calcInterimStandings, qfPoints, dfPoints, finPoints, calcStatusPoints } from './calc.js';
import { getChampionshipConfig } from './settings.js';
import { getActiveChampionship, getActiveChampionshipId } from './context.js';
import {
  buildWeekendEvolution, buildSeasonEvolution, defaultChartMeetingId, chartGeometry,
  renderWeekendChartSvg, renderWeekendChartTable, PHASE_DEFS,
} from './championshipChart.js';
import { buildTitleScenarios, renderTitleScenarios } from './championshipTitle.js';

let _activeRegulation = null;

// Dernier classement calculé (pour le graphique d'évolution, qui se
// re-dessine sans recalculer quand on change de meeting ou de mode).
let _lastStandings  = [];
let _chartMeetingId = null;
let _chartScope     = 'weekend';  // 'weekend' (un meeting) | 'season' (toute la saison)
let _chartMode      = 'season';   // vue week-end : 'season' (cumul saison) | 'meeting' (week-end seul)

// ─────────────────────────────────────────────────────────
// ÉTAT LOCAL
// ─────────────────────────────────────────────────────────

let allMeetings   = [];
let unsubMeetings = null;

let selectedYear     = new Date().getFullYear();
let selectedCategory = '';

const CATEGORIES = ['Supercar', 'Super1600', 'Division 5', 'Féminines', 'D3', 'D4'];

function getChampCategories() {
  const champ = getActiveChampionship();
  if (champ?.categories?.length) return champ.categories.map(c => c.id || c.name);
  return CATEGORIES;
}

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
  // Idem calc.getParticipants : on ne compte jamais deux fois un pilote.
  const rows = await fsQuery('sessionParticipants', [['sessionId', '==', sessionId]]);
  return dedupeParticipants(rows, sessionId).participants;
}

// ─────────────────────────────────────────────────────────
// PÉNALITÉS « POINTS CHAMPIONNAT » (niveau saison, éditables)
// Un total de points retirés par pilote, appliqué au grand total saison.
// Doc id = `${championshipId}__${driverId}`. Modifiable à tout moment.
// ─────────────────────────────────────────────────────────

async function getChampionshipPenalties(championshipId) {
  if (!championshipId) return {};
  try {
    const rows = await fsQuery('championshipPenalties', [['championshipId', '==', championshipId]]);
    const map = {};
    rows.forEach(r => { map[r.driverId] = Number(r.points) || 0; });
    return map;
  } catch { return {}; }
}

async function saveChampionshipPenalty(championshipId, category, driverId, points) {
  if (!championshipId) { toast('Sélectionne d\'abord un championnat', 'error'); return; }
  const { doc, setDoc } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  await setDoc(
    doc(db, 'championshipPenalties', `${championshipId}__${driverId}`),
    { championshipId, category, driverId, points: Number(points) || 0, updatedAt: Date.now() },
    { merge: true }
  );
}

// ─────────────────────────────────────────────────────────
// CALCUL POINTS D'UNE PHASE (DF ou FIN)
// ─────────────────────────────────────────────────────────

async function calcPhasePoints(session) {
  const results      = await fsGetResults(session.id);
  const participants = await fsGetParticipants(session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  // Avant : tables hardcodees DF_POINTS / FIN_POINTS qui ignoraient le
  // reglement actif. Maintenant : qfPoints/dfPoints/finPoints lisent
  // _activeRegulation.pointsScale.[QF|DF|FIN] (formule + overrides du
  // bareme configure). Coherent avec calc.js et standings.js.
  const ptsFn = session.type === 'DF' ? (p => dfPoints(p, _activeRegulation))
              : session.type === 'QF' ? (p => qfPoints(p, _activeRegulation))
              : (p => finPoints(p, _activeRegulation));

  const rows = participants.map(p => ({
    driverId:       p.driverId,
    ms:             resultMap[p.driverId]?.ms             ?? null,
    status:         resultMap[p.driverId]?.status         ?? null,
    manualPosition: resultMap[p.driverId]?.manualPosition ?? null,
  }));

  const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);

  const out = {};
  let pos = 1;
  finished.forEach(r => { out[r.driverId] = ptsFn(pos++); });

  // DNF avec position assignée → points de la position
  rows.filter(r => r.status === 'DNF' && r.manualPosition)
      .forEach(r => { out[r.driverId] = ptsFn(r.manualPosition); });

  // Pilotes avec statut spécial → calcStatusPoints (respecte
  // regulation.statusRules : DSQ_RACE, DNS, DSQ, DNF-no-pos)
  const totalEngaged = participants.length;
  participants.forEach(p => {
    if (out[p.driverId] !== undefined) return;
    const r = resultMap[p.driverId];
    out[p.driverId] = r?.status
      ? calcStatusPoints(r.status, session.type, totalEngaged, _activeRegulation)
      : 0;
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
      qf:        0,
      df:        0,
      fin:       0,
    };
  });

  const blankRow = (p) => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    interim: 0, qf: 0, df: 0, fin: 0,
  });

  // 3. Points QF (¼ de finale) — championnats de type FIA uniquement.
  //    S'il n'y a pas de session QF, qf reste a 0.
  const qfSessions = sessions.filter(s => s.type === 'QF');
  for (const qf of qfSessions) {
    const ptsMap = await calcPhasePoints(qf);
    const parts  = await fsGetParticipants(qf.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].qf += ptsMap[p.driverId] ?? 0;
    });
  }

  // 4. Points DF
  const dfSessions = sessions.filter(s => s.type === 'DF');
  for (const df of dfSessions) {
    const ptsMap = await calcPhasePoints(df);
    const parts  = await fsGetParticipants(df.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].df += ptsMap[p.driverId] ?? 0;
    });
  }

  // 5. Points Finale
  const finSession = sessions.find(s => s.type === 'FIN');
  if (finSession) {
    const ptsMap = await calcPhasePoints(finSession);
    const parts  = await fsGetParticipants(finSession.id);
    parts.forEach(p => {
      if (!driverMap[p.driverId]) driverMap[p.driverId] = blankRow(p);
      driverMap[p.driverId].fin = ptsMap[p.driverId] ?? 0;
    });
  }

  // 6. Calculer le total et retourner
  return Object.values(driverMap).map(d => ({
    ...d,
    total: d.interim + d.qf + d.df + d.fin,
  })).filter(d => d.interim > 0 || d.qf > 0 || d.df > 0 || d.fin > 0); // exclure pilotes sans aucun point
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
          meetingDetail: {},   // meetingId → { interim, qf, df, fin, total } (graphique)
          grandTotal: 0,
        };
      }
      champMap[d.driverId].meetingPts[meeting.id] = d.total;
      champMap[d.driverId].meetingDetail[meeting.id] = {
        interim: d.interim, qf: d.qf, df: d.df, fin: d.fin, total: d.total,
      };
      champMap[d.driverId].grandTotal += d.total;
    });
  }

  // Pénalités « points championnat » (retirées du total saison, éditables à tout
  // moment via la colonne Pén.). Appliquées AVANT le tri pour que le rang reflète
  // la sanction.
  const penalties = await getChampionshipPenalties(getActiveChampionshipId());
  Object.values(champMap).forEach(d => {
    d.penalty = penalties[d.driverId] || 0;
    d.grandTotal -= d.penalty;
  });

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
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const champId = getActiveChampionshipId();
    allMeetings = champId ? all.filter(m => m.championshipId === champId || !m.championshipId) : all;
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
        ${getChampCategories().map(c => `<option value="${c}" ${c===selectedCategory?'selected':''}>${escHtml(c)}</option>`).join('')}
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

    // Le bareme par meeting inclut les ¼ de finale si le championnat en a.
    const hasQF = getActiveChampionship()?.sessionConfig?.QF?.enabled === true;

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
              <th class="center chp-pen-col" title="Points de pénalité retirés du total saison (éditable)">Pén.</th>
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
                  <td class="center"><input type="number" inputmode="numeric" min="0"
                      class="chp-pen-input${d.penalty ? ' has-pen' : ''}"
                      data-driver="${escHtml(d.driverId)}" value="${d.penalty || ''}"
                      placeholder="0" title="Points de pénalité retirés du total"></td>
                  <td class="center"><strong class="chp-total">${d.grandTotal}</strong></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="chp-legend">
        <span>Points / meeting = intermédiaire${hasQF ? ' + ¼ finale' : ''} + ½ finale + finale</span>
        <span>·</span>
        <span>Pén. = points retirés du total saison (modifiable à tout moment)</span>
        <span>·</span>
        <span>${allMeetings.length} meeting${allMeetings.length > 1 ? 's' : ''} · ${standings.length} pilote${standings.length > 1 ? 's' : ''}</span>
      </div>
      <div id="chp-title-box"></div>
      <div id="chp-evo" class="chp-evo"></div>
    `;

    _lastStandings = standings;
    renderTitle();
    renderEvolution();

    // Saisie inline des pénalités (régie) : enregistre puis recalcule le classement.
    content.querySelectorAll('.chp-pen-input').forEach(inp => {
      inp.addEventListener('change', async () => {
        const driverId = inp.dataset.driver;
        const points   = Math.max(0, parseInt(inp.value, 10) || 0);
        inp.disabled = true;
        try {
          await saveChampionshipPenalty(getActiveChampionshipId(), selectedCategory, driverId, points);
          await renderChampionship();   // recalcule le total + re-trie + repositionne
        } catch (e) {
          console.error(e);
          toast('Échec de l\'enregistrement de la pénalité', 'error');
          inp.disabled = false;
        }
      });
    });

  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div><div class="placeholder-title">Erreur de calcul</div></div>`;
  }
}

// ─────────────────────────────────────────────────────────
// SCÉNARIOS DE TITRE
// Calcul pur (championshipTitle.js) depuis _lastStandings, le barème actif
// et les meetings de la saison : aucune requête Firestore supplémentaire.
// ─────────────────────────────────────────────────────────

function renderTitle() {
  const box = document.getElementById('chp-title-box');
  if (!box) return;
  try {
    const scenarios = buildTitleScenarios({
      standings: _lastStandings, meetings: allMeetings, regulation: _activeRegulation,
    });
    box.innerHTML = renderTitleScenarios(scenarios);
  } catch (e) {
    console.error(e);
    box.innerHTML = '';
  }
}

// ─────────────────────────────────────────────────────────
// GRAPHIQUE — ÉVOLUTION DU TOP 5 SUR UN WEEK-END
// Les données viennent de _lastStandings (déjà calculées) : changer de
// meeting ou de mode ne déclenche aucune requête Firestore.
// ─────────────────────────────────────────────────────────

function renderEvolution() {
  const box = document.getElementById('chp-evo');
  if (!box) return;
  if (!_lastStandings.length || !allMeetings.length) { box.innerHTML = ''; return; }

  if (!_chartMeetingId || !allMeetings.some(m => m.id === _chartMeetingId)) {
    _chartMeetingId = defaultChartMeetingId(_lastStandings, allMeetings);
  }

  const isSeason = _chartScope === 'season';
  const data = isSeason
    ? buildSeasonEvolution({
        standings:  _lastStandings,
        meetings:   allMeetings,
        regulation: _activeRegulation,
      })
    : buildWeekendEvolution({
        standings:  _lastStandings,
        meetings:   allMeetings,
        meetingId:  _chartMeetingId,
        regulation: _activeRegulation,
        mode:       _chartMode,
      });

  const meetingOptions = allMeetings.map(m => {
    const d = m.date ? new Date(m.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '?';
    return `<option value="${escHtml(m.id)}" ${m.id === _chartMeetingId ? 'selected' : ''}>${d} — ${escHtml(m.location || '?')}</option>`;
  }).join('');

  const phasesTxt = data?.phases ? data.phases.map(k => PHASE_DEFS[k].label).join(' → ') : '';
  const hasData   = data && data.series.length > 0 && data.series.some(s => s.present);

  const legend = isSeason
    ? `<span>Une colonne par phase à points de chaque meeting (Int. = classement intermédiaire, ¼ / ½ = quarts / demi-finales, Fin. = finale)</span>
       <span>·</span>
       <span>Départ = 0, pénalités saison déduites · tableau résumé par meeting</span>`
    : `<span>Phases à points (règlement actif) : ${escHtml(phasesTxt)}</span>
       <span>·</span>
       <span>${_chartMode === 'season'
         ? 'Point de départ = total saison avant ce meeting, pénalités saison déduites'
         : 'Point de départ = 0, seuls les points du week-end sont cumulés'}</span>`;

  box.innerHTML = `
    <div class="chp-evo-head">
      <div class="chp-evo-title">📈 Évolution du top 5 ${isSeason ? 'sur la saison' : 'sur le week-end'}</div>
      <div class="chp-evo-controls">
        <div class="chp-evo-toggle" title="Période affichée">
          <button class="chp-evo-toggle-btn ${!isSeason ? 'is-active' : ''}" data-scope="weekend">Week-end</button>
          <button class="chp-evo-toggle-btn ${isSeason  ? 'is-active' : ''}" data-scope="season">Saison</button>
        </div>
        ${isSeason ? '' : `
        <select class="toolbar-select chp-evo-select" id="chp-evo-meeting" title="Meeting à détailler">${meetingOptions}</select>
        <div class="chp-evo-toggle" title="Point de départ des courbes">
          <button class="chp-evo-toggle-btn ${_chartMode === 'season'  ? 'is-active' : ''}" data-mode="season">Cumul saison</button>
          <button class="chp-evo-toggle-btn ${_chartMode === 'meeting' ? 'is-active' : ''}" data-mode="meeting">Week-end seul</button>
        </div>`}
      </div>
    </div>
    ${hasData ? `
      <div class="chp-evo-chart-wrap" id="chp-evo-chart">
        ${renderWeekendChartSvg(data)}
        <div class="chp-evo-tooltip" id="chp-evo-tip" hidden></div>
      </div>
      ${renderWeekendChartTable(data)}
      <div class="chp-legend">${legend}</div>`
    : `<div class="tim-placeholder chp-evo-empty"><div class="placeholder-icon">📈</div><div class="placeholder-title">Pas encore de points ${isSeason ? 'cette saison' : 'sur ce meeting'}</div></div>`}
  `;

  box.querySelector('#chp-evo-meeting')?.addEventListener('change', e => {
    _chartMeetingId = e.target.value;
    renderEvolution();
  });
  box.querySelectorAll('.chp-evo-toggle-btn[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.scope === _chartScope) return;
      _chartScope = btn.dataset.scope;
      renderEvolution();
    });
  });
  box.querySelectorAll('.chp-evo-toggle-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === _chartMode) return;
      _chartMode = btn.dataset.mode;
      renderEvolution();
    });
  });

  if (hasData) bindEvolutionHover(data);
}

/**
 * Couche de survol : un curseur vertical s'aligne sur la phase la plus
 * proche du pointeur et une infobulle liste les 5 pilotes à cette phase
 * (valeur cumulée, puis gain de la phase). Tout est aussi lisible dans
 * le tableau sous le graphique : l'infobulle n'est qu'un raccourci.
 */
function bindEvolutionHover(data) {
  const wrap = document.getElementById('chp-evo-chart');
  const svg  = wrap?.querySelector('svg');
  const tip  = document.getElementById('chp-evo-tip');
  const cursor = svg?.querySelector('.chp-evo-cursor');
  if (!wrap || !svg || !tip || !cursor) return;

  const geo = chartGeometry(data);

  const hide = () => { tip.hidden = true; cursor.style.display = 'none'; };

  const show = (evt) => {
    const rect  = svg.getBoundingClientRect();
    if (!rect.width) return;
    // viewBox → pixels : preserveAspectRatio meet, ratio commun aux 2 axes
    const scale = Math.min(rect.width / svg.viewBox.baseVal.width, rect.height / svg.viewBox.baseVal.height);
    const offX  = (rect.width - svg.viewBox.baseVal.width * scale) / 2;
    const vx    = (evt.clientX - rect.left - offX) / scale;

    let idx = 0, best = Infinity;
    geo.xs.forEach((x, i) => { const d = Math.abs(x - vx); if (d < best) { best = d; idx = i; } });

    cursor.setAttribute('x1', geo.xs[idx]);
    cursor.setAttribute('x2', geo.xs[idx]);
    cursor.style.display = '';

    // Contenu construit en textContent (jamais innerHTML sur des noms)
    tip.textContent = '';
    const title = document.createElement('div');
    title.className = 'chp-evo-tip-title';
    title.textContent = data.columns?.[idx]?.title ?? data.labels[idx];
    tip.appendChild(title);

    [...data.series].sort((a, b) => b.values[idx] - a.values[idx]).forEach(s => {
      const row = document.createElement('div');
      row.className = 'chp-evo-tip-row';
      const sw = document.createElement('span');
      sw.className = 'chp-evo-swatch';
      sw.style.background = `var(--chp-s${s.slot})`;
      const val = document.createElement('strong');
      val.textContent = String(s.values[idx]);
      const name = document.createElement('span');
      name.className = 'chp-evo-tip-name';
      name.textContent = (s.carNumber ? `#${s.carNumber} ` : '') + s.lastName;
      row.append(sw, val, name);
      if (idx > 0) {
        const gain = document.createElement('span');
        const g = s.gains[idx - 1];
        gain.className = 'chp-evo-gain' + (g > 0 ? ' is-pos' : '');
        gain.textContent = (g > 0 ? '+' : '') + g;
        row.appendChild(gain);
      }
      tip.appendChild(row);
    });

    tip.hidden = false;
    // Position dans le conteneur (qui peut défiler horizontalement sur
    // téléphone) : à droite du curseur, sauf sur la moitié droite du tracé
    const wrapRect = wrap.getBoundingClientRect();
    const svgLeft  = rect.left - wrapRect.left + wrap.scrollLeft;
    const px       = svgLeft + offX + geo.xs[idx] * scale;
    const onRight  = geo.xs[idx] > (geo.pad.left + geo.pw / 2);
    tip.style.left = `${onRight ? px - 12 - tip.offsetWidth : px + 12}px`;
    tip.style.top  = `${Math.max(0, evt.clientY - rect.top - 10)}px`;
  };

  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
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
      // Charger le reglement DU CHAMPIONNAT SELECTIONNE dans le header,
      // pas celui qui porte le flag isActive en DB. Sinon les calculs
      // (calcInterimStandings → interimPoints) appliquent une autre
      // reglementation que celle visible cote utilisateur → bug observe :
      // les points intermediaires apparaissaient au format FFSA par defaut
      // (17 - position) meme quand interimPointsEnabled etait desactive
      // dans le championnat selectionne. Pattern aligne sur sessions.js
      // / standings.js.
      try {
        const champId = getActiveChampionshipId();
        _activeRegulation = champId
          ? await getChampionshipConfig(champId)
          : await getChampionshipConfig();
      } catch { _activeRegulation = null; }
      renderView();
      await loadMeetings();
    }
  });
  document.addEventListener('championshipchange', async () => {
    // Idem : recharger le reglement quand l'utilisateur change de
    // championnat depuis le header.
    try {
      const champId = getActiveChampionshipId();
      _activeRegulation = champId
        ? await getChampionshipConfig(champId)
        : await getChampionshipConfig();
    } catch { _activeRegulation = null; }
    loadMeetings();
  });
}