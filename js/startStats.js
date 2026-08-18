/* ═══════════════════════════════════════════════
   STARTSTATS.JS — Vue « Statistiques des départs »

   Module dédié, volontairement séparé de stats.js : celui-ci est orienté
   PILOTE × MEETING, celui-là est orienté POSITION, transversal aux saisons.
   Les mélanger aurait fait grossir stats.js sans bénéfice.

   Tout le calcul vit dans startStatsCalc.js (pur, testé). Ce module ne fait
   que charger les données et produire du HTML.

   Règle absolue : seules les analyses validées sont lues.
═══════════════════════════════════════════════ */

import { db } from './firebase.js';
import { escHtml } from './utils.js';
import { getActiveChampionshipId, getAllChampionships } from './context.js';
import {
  filterAnalyses, toRows, byGridPos, byLane, byGridRow,
  allMatrices, summary, availableSizes, phaseGroupOf,
  formatRate, MIN_N_FOR_RATE,
} from './startStatsCalc.js';

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let allAnalyses = [];
let loaded = false;
let _initialised = false;

const filters = {
  year: new Date().getFullYear(),
  championshipId: '',
  circuitLabel: '',
  category: '',
  phase: 'MQ',            // 'MQ' | 'FINALS' — jamais mélangés par défaut
  sessionType: '',        // affine à l'intérieur de la phase
  size: null,             // taille de grille pour les matrices
  requireComplete: false,
};

// ─────────────────────────────────────────────────────────
// CHARGEMENT
// ─────────────────────────────────────────────────────────

async function loadAnalyses() {
  if (!db) { allAnalyses = []; return; }
  const { collection, query, where, getDocs } = await import(FS);
  // Requête sur un seul champ (convention maison : pas d'index composite),
  // le reste est filtré côté client.
  const snap = await getDocs(query(
    collection(db, 'startAnalyses'),
    where('status', '==', 'validated'),
  ));
  allAnalyses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  loaded = true;
}

// ─────────────────────────────────────────────────────────
// SÉLECTION COURANTE
// ─────────────────────────────────────────────────────────

/** Analyses correspondant aux filtres, phase comprise. */
function selected() {
  const base = filterAnalyses(allAnalyses, {
    championshipId: filters.championshipId,
    year: filters.year,
    circuitLabel: filters.circuitLabel,
    category: filters.category,
    sessionType: filters.sessionType,
  });
  return base.filter(a => phaseGroupOf(a.sessionType) === filters.phase);
}

function distinct(getter) {
  return [...new Set(allAnalyses.map(getter).filter(Boolean))].sort();
}

// ─────────────────────────────────────────────────────────
// RENDU — cadre
// ─────────────────────────────────────────────────────────

function renderView() {
  const el = document.getElementById('view-startStats');
  if (!el) return;

  const years = distinct(a => a.year);
  const champs = getAllChampionships();

  el.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📈 <span>Statistiques des départs</span></h2>
    </div>

    <div class="toolbar sst-filters" id="sst-filters">
      <select class="toolbar-select" id="sst-champ">
        <option value="">Tous championnats</option>
        ${champs.map(c => `<option value="${escHtml(c.id)}" ${c.id === filters.championshipId ? 'selected' : ''}>${escHtml(c.name || c.id)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="sst-year">
        <option value="">Toutes saisons</option>
        ${years.map(y => `<option value="${y}" ${Number(y) === Number(filters.year) ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="sst-circuit">
        <option value="">Tous circuits</option>
        ${distinct(a => a.circuitLabel).map(c => `<option value="${escHtml(c)}" ${c === filters.circuitLabel ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="sst-category">
        <option value="">Toutes catégories</option>
        ${distinct(a => a.category).map(c => `<option value="${escHtml(c)}" ${c === filters.category ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>

      <div class="sst-phase-toggle" title="Manches et phases finales ne sont pas comparables : une série est sur une seule ligne, une grille de finale sur plusieurs.">
        <button class="sst-phase-btn ${filters.phase === 'MQ' ? 'is-active' : ''}" data-phase="MQ">Manches</button>
        <button class="sst-phase-btn ${filters.phase === 'FINALS' ? 'is-active' : ''}" data-phase="FINALS">Phases finales</button>
      </div>

      <select class="toolbar-select" id="sst-session">
        <option value="">Toutes</option>
        ${(filters.phase === 'MQ' ? ['MQ'] : ['QF', 'DF', 'FIN'])
          .map(t => `<option value="${t}" ${t === filters.sessionType ? 'selected' : ''}>${t}</option>`).join('')}
      </select>

      <label class="sst-check" title="N'utiliser que les départs où toutes les voitures étaient visibles">
        <input type="checkbox" id="sst-complete" ${filters.requireComplete ? 'checked' : ''}>
        Départs complets uniquement
      </label>
    </div>

    <div id="sst-content"></div>
  `;
  bindFilters();
  renderContent();
}

function bindFilters() {
  const on = (id, key, cast = v => v) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      filters[key] = cast(e.target.value);
      filters.size = null;
      renderView();
    });
  };
  on('sst-champ', 'championshipId');
  on('sst-year', 'year', v => (v ? Number(v) : ''));
  on('sst-circuit', 'circuitLabel');
  on('sst-category', 'category');
  on('sst-session', 'sessionType');

  document.getElementById('sst-complete')?.addEventListener('change', (e) => {
    filters.requireComplete = e.target.checked;
    renderContent();
  });

  document.querySelectorAll('.sst-phase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filters.phase = btn.dataset.phase;
      filters.sessionType = '';
      filters.size = null;
      renderView();
    });
  });
}

// ─────────────────────────────────────────────────────────
// RENDU — contenu
// ─────────────────────────────────────────────────────────

function renderContent() {
  const el = document.getElementById('sst-content');
  if (!el) return;

  if (!loaded) { el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Chargement…</div>`; return; }

  const analyses = selected();
  if (analyses.length === 0) {
    el.innerHTML = `
      <div class="tim-placeholder">
        <div class="placeholder-icon">📈</div>
        <div class="placeholder-title">Aucune analyse validée pour cette sélection</div>
        <div class="placeholder-desc">
          Les statistiques ne lisent que les analyses <strong>validées</strong>.<br>
          Rendez-vous dans 🎥 Analyse des départs pour en saisir.
        </div>
      </div>`;
    return;
  }

  const rows = toRows(analyses, { requireComplete: filters.requireComplete });
  const s = summary(analyses);
  const sizes = availableSizes(analyses);
  const size = filters.size || sizes[0]?.starters || 0;

  el.innerHTML = [
    renderSummary(s, sizes),
    renderGridPosTable(byGridPos(rows)),
    renderLaneTable(byLane(rows)),
    filters.phase === 'FINALS' ? renderGridRowTable(byGridRow(rows)) : '',
    renderMatrices(rows, size, sizes),
    renderGainChart(byGridPos(rows)),
  ].join('');

  document.querySelectorAll('.sst-size-btn').forEach(btn => {
    btn.addEventListener('click', () => { filters.size = Number(btn.dataset.size); renderContent(); });
  });
}

// ── Synthèse ──────────────────────────────────────────────

function fmtNum(v, digits = 2) {
  return Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(digits) : '—';
}
function fmtPos(v) { return Number.isFinite(v) ? v.toFixed(2) : '—'; }
function fmtRho(c) {
  if (!c || c.rho == null) return '—';
  return `${c.rho.toFixed(2)} <span class="sst-n">n=${c.n}</span>`;
}

function renderSummary(s, sizes) {
  const partialNote = s.nFromPartial > 0
    ? `<div class="sst-note">ℹ️ ${s.nFromPartial} observation(s) proviennent de départs où toutes les voitures
       n'étaient pas visibles. Ces positions sont certifiées, mais l'échantillon peut être biaisé —
       utilisez « Départs complets uniquement » pour les écarter.</div>`
    : '';

  return `
    <div class="sst-section">
      <div class="sst-cards">
        <div class="sst-card"><div class="sst-card-val">${s.nStarts}</div><div class="sst-card-lab">départs analysés</div></div>
        <div class="sst-card"><div class="sst-card-val">${s.nObservations}</div><div class="sst-card-lab">observations pilote</div></div>
        <div class="sst-card"><div class="sst-card-val">${s.nMeasured}</div><div class="sst-card-lab">positions V1 mesurées</div></div>
        <div class="sst-card"><div class="sst-card-val">${s.nCircuits}</div><div class="sst-card-lab">circuit(s)</div></div>
        <div class="sst-card"><div class="sst-card-val">${sizes.map(z => z.starters).join(' / ') || '—'}</div><div class="sst-card-lab">tailles de grille</div></div>
      </div>
      ${partialNote}
      <div class="sst-corr">
        <span>Corrélations de rang (Spearman) :</span>
        <span>grille → V1 <strong>${fmtRho(s.correlations.gridToTurn1)}</strong></span>
        <span>V1 → arrivée <strong>${fmtRho(s.correlations.turn1ToFinish)}</strong></span>
        <span>grille → arrivée <strong>${fmtRho(s.correlations.gridToFinish)}</strong></span>
      </div>
    </div>`;
}

// ── Tableaux ──────────────────────────────────────────────

const NCELL = (st) => `<span class="sst-n">${st.nMeasured}/${st.nObservations} · ${st.nStarts} dép.</span>`;

function renderPositionRows(stats, key, label) {
  return stats.map(st => `
    <tr>
      <td class="center"><strong>${label}${st[key]}</strong></td>
      <td class="center">${NCELL(st)}</td>
      <td class="center">${fmtPos(st.turn1Mean)}</td>
      <td class="center ${st.gainMean > 0 ? 'sst-pos' : st.gainMean < 0 ? 'sst-neg' : ''}">${fmtNum(st.gainMean)}</td>
      <td class="center">${fmtNum(st.gainMedian, 1)}</td>
      <td class="center">${formatRate(st.leadRate)}</td>
      <td class="center">${formatRate(st.keptRate)}</td>
      <td class="center">${formatRate(st.gainedRate)}</td>
      <td class="center">${formatRate(st.lostRate)}</td>
      <td class="center">${fmtPos(st.finishMean)}</td>
      <td class="center">${formatRate(st.winRate)}</td>
      <td class="center ${st.gainTotalMean > 0 ? 'sst-pos' : st.gainTotalMean < 0 ? 'sst-neg' : ''}">${fmtNum(st.gainTotalMean)}</td>
    </tr>`).join('');
}

function positionTableHead(first) {
  return `
    <thead>
      <tr>
        <th class="center">${first}</th>
        <th class="center" title="positions V1 mesurées / observations · nombre de départs">n</th>
        <th class="center">V1 moyen</th>
        <th class="center">Gain V1</th>
        <th class="center">Médian</th>
        <th class="center">P1 au V1</th>
        <th class="center">Maintien</th>
        <th class="center">Gain</th>
        <th class="center">Perte</th>
        <th class="center">Arrivée moy.</th>
        <th class="center">Victoire</th>
        <th class="center">Gain total</th>
      </tr>
    </thead>`;
}

function renderGridPosTable(stats) {
  const note = filters.phase === 'MQ'
    ? 'En manche, la position de grille <strong>est</strong> le couloir : ce tableau et le suivant se recoupent.'
    : 'En phase finale, la position de grille est un <strong>rang de qualification</strong>, pas un couloir.';
  return `
    <div class="sst-section">
      <div class="sst-section-title">Par position de grille</div>
      <div class="sst-hint">${note}</div>
      <div class="table-wrap"><table class="sst-table">
        ${positionTableHead('Grille')}
        <tbody>${renderPositionRows(stats, 'gridPos', 'P')}</tbody>
      </table></div>
    </div>`;
}

function renderLaneTable(stats) {
  return `
    <div class="sst-section">
      <div class="sst-section-title">Par couloir</div>
      <div class="sst-hint">Couloir brut, tel qu'il est sur la piste. Le couloir 1 est du côté du premier virage.</div>
      <div class="table-wrap"><table class="sst-table">
        ${positionTableHead('Couloir')}
        <tbody>${renderPositionRows(stats, 'lane', 'C')}</tbody>
      </table></div>
    </div>`;
}

function renderGridRowTable(stats) {
  if (stats.length <= 1) return '';
  return `
    <div class="sst-section">
      <div class="sst-section-title">Par ligne de grille</div>
      <div class="sst-hint">Les pilotes de la deuxième ligne partent derrière : cet écart se mesure ici.</div>
      <div class="table-wrap"><table class="sst-table">
        ${positionTableHead('Ligne')}
        <tbody>${renderPositionRows(stats, 'gridRow', 'L')}</tbody>
      </table></div>
    </div>`;
}

// ── Matrices ──────────────────────────────────────────────

function renderMatrix(m, title, hint) {
  if (!m.size || m.nPairs === 0) {
    return `<div class="sst-matrix"><div class="sst-matrix-title">${title}</div>
            <div class="sst-hint">Pas encore de donnée pour cette taille de grille.</div></div>`;
  }
  const head = Array.from({ length: m.size }, (_, i) => `<th class="center">P${i + 1}</th>`).join('');
  const body = m.cells.map((row, i) => `
    <tr>
      <th class="center">P${i + 1}</th>
      ${row.map(c => {
        if (!c.n) return '<td class="center sst-cell sst-cell--empty">—</td>';
        const intensity = c.rate == null ? 0 : c.rate;
        const shown = c.n < MIN_N_FOR_RATE
          ? `${c.count}/${c.n}`
          : `${Math.round(c.rate * 100)}%`;
        return `<td class="center sst-cell" style="--i:${intensity.toFixed(3)}"
                 title="${c.count} sur ${c.n} observation(s)">${shown}</td>`;
      }).join('')}
      <td class="center sst-n">${row[0]?.n || 0}</td>
    </tr>`).join('');

  return `
    <div class="sst-matrix">
      <div class="sst-matrix-title">${title}</div>
      <div class="sst-hint">${hint} · ${m.nPairs} paire(s) sur ${m.nStarts} départ(s)</div>
      <div class="table-wrap"><table class="sst-table sst-matrix-table">
        <thead><tr><th class="center">↓ / →</th>${head}<th class="center sst-n">n</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

function renderMatrices(rows, size, sizes) {
  const m = allMatrices(rows, size);
  const selector = sizes.length > 1
    ? `<div class="sst-size-picker">Taille de grille :
        ${sizes.map(z => `<button class="sst-size-btn ${z.starters === size ? 'is-active' : ''}"
          data-size="${z.starters}">${z.starters} voitures <span class="sst-n">${z.count}</span></button>`).join('')}
       </div>`
    : '';

  return `
    <div class="sst-section">
      <div class="sst-section-title">Matrices de transition</div>
      ${selector}
      <div class="sst-hint">
        Sous ${MIN_N_FOR_RATE} observations, l'effectif brut est affiché à la place du pourcentage :
        100 % sur 2 départs ne vaut pas 63 % sur 300.
      </div>
      <div class="sst-matrices">
        ${renderMatrix(m.gridToTurn1, 'Grille → V1', 'Ce que le départ crée')}
        ${renderMatrix(m.turn1ToFinish, 'V1 → Arrivée', 'Ce que la course modifie ensuite')}
        ${renderMatrix(m.gridToFinish, 'Grille → Arrivée', 'Effet global de la position de départ')}
      </div>
    </div>`;
}

// ── Graphique simple : gain moyen par position ────────────

function renderGainChart(stats) {
  const usable = stats.filter(st => Number.isFinite(st.gainMean));
  if (usable.length === 0) return '';

  const W = 520, H = 190, padL = 40, padB = 26, padT = 14;
  const maxAbs = Math.max(0.5, ...usable.map(st => Math.abs(st.gainMean)));
  const bw = (W - padL - 10) / usable.length;
  const zeroY = padT + (H - padT - padB) / 2;
  const scale = (H - padT - padB) / 2 / maxAbs;

  const bars = usable.map((st, i) => {
    const h = Math.abs(st.gainMean) * scale;
    const x = padL + i * bw + bw * 0.18;
    const y = st.gainMean >= 0 ? zeroY - h : zeroY;
    const cls = st.gainMean >= 0 ? 'sst-bar--pos' : 'sst-bar--neg';
    return `
      <rect class="sst-bar ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
            width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}">
        <title>P${st.gridPos} : ${fmtNum(st.gainMean)} place(s), n=${st.nMeasured}</title>
      </rect>
      <text class="sst-axis" x="${(x + bw * 0.32).toFixed(1)}" y="${H - 8}" text-anchor="middle">P${st.gridPos}</text>`;
  }).join('');

  return `
    <div class="sst-section">
      <div class="sst-section-title">Gain moyen au premier virage</div>
      <div class="sst-hint">Au-dessus de zéro : des places gagnées. En dessous : des places perdues.</div>
      <svg class="sst-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <line class="sst-axis-line" x1="${padL}" y1="${zeroY}" x2="${W - 10}" y2="${zeroY}" />
        <text class="sst-axis" x="${padL - 6}" y="${zeroY + 4}" text-anchor="end">0</text>
        <text class="sst-axis" x="${padL - 6}" y="${padT + 10}" text-anchor="end">+${maxAbs.toFixed(1)}</text>
        <text class="sst-axis" x="${padL - 6}" y="${H - padB}" text-anchor="end">-${maxAbs.toFixed(1)}</text>
        ${bars}
      </svg>
    </div>`;
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initStartStats() {
  document.addEventListener('viewchange', async (e) => {
    if (e.detail?.view !== 'startStats') return;
    if (!_initialised) {
      _initialised = true;
      filters.championshipId = getActiveChampionshipId() || '';
      renderView();
      await loadAnalyses();
    }
    renderView();
  });

  document.addEventListener('championshipchange', async () => {
    if (!_initialised) return;
    filters.championshipId = getActiveChampionshipId() || '';
    if (document.getElementById('view-startStats')?.style.display !== 'none') renderView();
  });
}
