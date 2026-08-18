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
  filterAnalyses, toRows, byGridPos, byLane, byGridRow, gridPosEqualsLane,
  laneOrientation, orderLanesForDisplay,
  allMatrices, summary, availableSizes, phaseGroupOf,
  formatRate, MIN_N_FOR_RATE,
} from './startStatsCalc.js';

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let allAnalyses = [];
// Côté de la pole par meeting : le couloir 1 est du côté du premier virage,
// c'est donc lui qui donne le sens de lecture des couloirs. Les analyses
// enregistrées avant l'ajout de `poleSide` n'en portent pas : cette table
// permet de les afficher correctement sans avoir à les revalider.
let poleSideByMeeting = {};
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

  // Orientation des circuits, lue une fois. Échec sans conséquence : les
  // couloirs s'affichent alors dans l'ordre 1 → n, et le tableau le dit.
  poleSideByMeeting = {};
  try {
    const meetings = await getDocs(collection(db, 'meetings'));
    meetings.forEach(m => { poleSideByMeeting[m.id] = m.data()?.poleSide || ''; });
  } catch (e) {
    console.warn('startStats — orientation des circuits indisponible :', e);
  }
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
  const orientation = laneOrientation(analyses, poleSideByMeeting);
  const sameAsLane = gridPosEqualsLane(rows);

  el.innerHTML = [
    renderSummary(s, sizes),
    renderLegend(),
    // Sur une grille à une seule ligne, place de grille et couloir se
    // confondent. Les deux tableaux ne méritent d'exister séparément que si
    // l'ordre physique de la piste les distingue réellement.
    renderGridPosTable(byGridPos(rows), sameAsLane && orientation !== 'right'),
    renderLaneTable(byLane(rows), orientation, sameAsLane && orientation !== 'right'),
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

/**
 * En-tête sur deux niveaux : le premier dit DE QUOI on parle (du départ au
 * premier virage, puis jusqu'à l'arrivée), le second nomme chaque colonne en
 * clair. Sans ce regroupement, « Gain » désignait tantôt un nombre de places,
 * tantôt un pourcentage de départs.
 *
 * @param {string} first — libellé du coin haut-gauche, la dimension analysée
 * @param {string} [firstTitle] — son explication au survol
 */
function positionTableHead(first, firstTitle = '') {
  const th = (label, title, cls = '') =>
    `<th class="center ${cls}" title="${escHtml(title)}">${label}</th>`;
  return `
    <thead>
      <tr class="sst-head-group">
        <th class="center sst-corner" rowspan="2" title="${escHtml(firstTitle)}">${first}</th>
        <th class="center" rowspan="2"
            title="places au 1er virage mesurées / pilotes observés · nombre de départs distincts">n</th>
        <th class="center sst-grp" colspan="7">Du départ au 1er virage</th>
        <th class="center sst-grp" colspan="3">Du départ à l'arrivée</th>
      </tr>
      <tr>
        ${th('Place au<br>1er virage', 'Place moyenne à la sortie du premier virage')}
        ${th('Places<br>gagnées', 'Places gagnées en moyenne entre le départ et le 1er virage (négatif = places perdues)')}
        ${th('Médiane', 'Même chose en médiane : un seul départ exceptionnel ne la déforme pas')}
        ${th('En tête', 'Part des départs où cette place mène au 1er virage')}
        ${th('Garde<br>sa place', 'Part des départs où la place est inchangée entre le départ et le 1er virage')}
        ${th('Gagne', 'Part des départs où au moins une place est gagnée avant le 1er virage')}
        ${th('Perd', 'Part des départs où au moins une place est perdue avant le 1er virage')}
        ${th('Place à<br>l\'arrivée', 'Place moyenne à l\'arrivée de la course', 'sst-sep')}
        ${th('Victoire', 'Part des départs gagnés')}
        ${th('Bilan', 'Places gagnées en moyenne entre le départ et l\'arrivée')}
      </tr>
    </thead>`;
}

/** Légende détaillée, repliée : affichée une seule fois pour les trois tableaux. */
function renderLegend() {
  const items = [
    ['n', 'Trois nombres : places au 1er virage réellement mesurées / pilotes observés · nombre de départs distincts. '
        + `Sous ${MIN_N_FOR_RATE} mesures, les pourcentages laissent la place à l'effectif brut (« 2/8 »), `
        + 'parce que 100 % sur 2 départs ne vaut pas 63 % sur 300.'],
    ['Place au 1er virage', 'Place moyenne à la sortie du premier virage. Plus le nombre est bas, mieux la place s\'en sort.'],
    ['Places gagnées', 'Différence moyenne entre la place au départ et la place au 1er virage. '
        + '+1 signifie « gagne une place en moyenne », −1 « en perd une ».'],
    ['Médiane', 'La valeur du milieu plutôt que la moyenne : un carambolage isolé ne la fait pas basculer.'],
    ['En tête / Garde sa place / Gagne / Perd', 'Les quatre issues possibles du départ, en part des départs. '
        + '« Garde », « Gagne » et « Perd » se complètent à 100 % ; « En tête » les recoupe.'],
    ['Place à l\'arrivée', 'Place moyenne à la fin de la course, dans ce même départ.'],
    ['Victoire', 'Part des départs remportés.'],
    ['Bilan', 'Places gagnées entre le départ et l\'arrivée : l\'effet complet de la place de départ, '
        + 'départ et course confondus.'],
  ];
  return `
    <details class="sst-legend">
      <summary>ℹ️ Comment lire ces tableaux</summary>
      <dl>
        ${items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
      </dl>
    </details>`;
}

/** Phrase décrivant le sens de la piste, ou chaîne vide si on ne le sait pas. */
function orientationNote(orientation, lanes) {
  if (orientation === 'right') {
    return `Le couloir 1 est <strong>à droite</strong>, côté du premier virage. `
         + `Les lignes vont donc de la gauche de la piste vers la droite : `
         + `${lanes.slice().reverse().join(' · ')}.`;
  }
  if (orientation === 'left') {
    return `Le couloir 1 est <strong>à gauche</strong>, côté du premier virage. `
         + `Les lignes suivent la piste de gauche à droite : ${lanes.join(' · ')}.`;
  }
  if (orientation === 'mixed') {
    return 'La sélection mélange des circuits dont le premier virage n\'est pas du même côté : '
         + 'les couloirs restent affichés dans l\'ordre 1 → n, sans ordre physique commun.';
  }
  return 'Côté du premier virage inconnu pour cette sélection : couloirs affichés dans l\'ordre 1 → n.';
}

function renderGridPosTable(stats, mergedWithLanes) {
  const note = mergedWithLanes
    ? 'Grille à une seule ligne : la n-ième place de grille <strong>est</strong> le n-ième couloir. '
      + 'Les deux lectures se confondent, ce tableau vaut donc aussi pour les couloirs.'
    : 'En phase finale, la place de grille est un <strong>rang de qualification</strong>, pas un couloir : '
      + 'le tableau des couloirs regroupe ces places autrement.';
  const title = mergedWithLanes ? 'Par place au départ (= couloir)' : 'Par place au départ';
  return `
    <div class="sst-section">
      <div class="sst-section-title">${title}</div>
      <div class="sst-hint">${note}</div>
      <div class="table-wrap"><table class="sst-table">
        ${positionTableHead('Place au<br>départ',
          'Rang sur la grille : P1 = premier de la grille de ce départ')}
        <tbody>${renderPositionRows(stats, 'gridPos', 'P')}</tbody>
      </table></div>
    </div>`;
}

/**
 * Tableau des couloirs, ordonné comme sur la piste.
 *
 * @param {Array} stats — sortie de byLane(), toujours dans l'ordre 1 → n
 * @param {string} orientation — voir laneOrientation()
 * @param {boolean} skip — vrai quand ce tableau serait le clone du précédent
 */
function renderLaneTable(stats, orientation, skip) {
  // Sur une grille à une seule ligne ET sans ordre physique connu, ce tableau
  // reprendrait exactement le précédent : inutile de le répéter.
  if (skip) return '';
  const ordered = orderLanesForDisplay(stats, orientation);
  const lanes = stats.map(st => `C${st.lane}`);
  const arrow = orientation === 'right' ? 'C1 ▶ 1er virage' : '1er virage ◀ C1';
  return `
    <div class="sst-section">
      <div class="sst-section-title">Par couloir de départ</div>
      <div class="sst-hint">${orientationNote(orientation, lanes)}</div>
      <div class="table-wrap"><table class="sst-table">
        ${positionTableHead(`Couloir<br><span class="sst-corner-sub">${arrow}</span>`,
          'Couloir physique sur la piste. Le couloir 1 est du côté du premier virage.')}
        <tbody>${renderPositionRows(ordered, 'lane', 'C')}</tbody>
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
        ${positionTableHead('Ligne de<br>grille',
          'L1 = première ligne de la grille, L2 = juste derrière, etc.')}
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
