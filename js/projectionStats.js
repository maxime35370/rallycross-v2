/* ═══════════════════════════════════════════════
   PROJECTIONSTATS.JS — Vue « Projection de qualification »

   Module de VUE uniquement : il charge (via qualificationData.js) et affiche.
   Tout le calcul vit dans js/projection/*, pur et testé.

   Trois onglets :
     • Situation      — lecture d'un pilote au checkpoint courant d'un meeting
     • Historique     — courbes par écart au seuil et par points
     • Qualité données — sur quoi reposent réellement les chiffres

   Deux règles de présentation, non négociables :
     1. tout taux est affiché avec son effectif et son niveau de confiance ;
     2. DONNÉES HISTORIQUES et SIMULATION sont visuellement séparées et ne sont
        jamais additionnées. À ce stade (LOT 1), aucune simulation n'existe :
        les emplacements concernés annoncent explicitement leur absence plutôt
        que de laisser croire à une projection.
═══════════════════════════════════════════════ */

import { escHtml } from './utils.js';
import { loadHistory, loadContexts, clearCache } from './projection/qualificationData.js';
import {
  filterObservations, distinctValues, aggregateByGap, aggregateByPoints,
  buildHistoricalOutlook, formatGap, resultDistribution,
  conditionalQualificationByResult, rateStats,
} from './projection/qualificationHistory.js';
import { buildStateAfterRace } from './projection/qualificationState.js';
import {
  resolveQualificationThreshold, isTrivialQualification, gapToThreshold,
  checkRegulationSupport,
} from './projection/qualificationRules.js';
import { buildDataQualityReport } from './projection/dataQuality.js';
import { MESSAGES, MIN_CASES_TO_SHOW_RATE } from './projection/projectionConfig.js';

// ─────────────────────────────────────────────────────────
// ÉTAT
// ─────────────────────────────────────────────────────────

let _initialised = false;
let _loading = false;
let _loaded = false;
let _error = null;

let observations = [];
let contexts = [];
let championshipsById = {};
let report = null;

let activeTab = 'situation';

const filters = {
  championshipId: '',
  category: '',
  year: '',
  circuit: '',
  checkpoint: 3,
};

const situation = {
  meetingKey: '',     // `${meetingId}||${category}`
  checkpoint: null,   // null = dernière manche courue
  driverId: '',
};

// ─────────────────────────────────────────────────────────
// HELPERS DE FORMAT
// ─────────────────────────────────────────────────────────

const pct = (r) => (r == null ? '—' : `${(100 * r).toFixed(1).replace('.', ',')} %`);

/** Un taux ne s'affiche jamais nu : effectif + confiance l'accompagnent. */
function rateCell(stats) {
  if (!stats || !stats.n) return `<span class="prj-n">aucun cas</span>`;
  const c = stats.confidence;
  // Sous le minimum, on n'affiche PAS de pourcentage : seulement le comptage
  // brut. Un « 4/4 » se lit comme ce qu'il est ; un « 100 % » induirait en
  // erreur sur un effectif de 4.
  return c.showRate
    ? `<strong>${pct(stats.rate)}</strong> <span class="prj-n">${stats.qualified}/${stats.n}</span> ${confBadge(c)}`
    : `<span class="prj-n">${stats.qualified}/${stats.n} cas</span> ${confBadge(c)}`;
}

function confBadge(c) {
  if (!c) return '';
  return `<span class="prj-conf prj-conf--${c.level}" title="Intervalle 95 % : ${pct(c.interval.low)} – ${pct(c.interval.high)}">${escHtml(c.label)}</span>`;
}

function band(kind) {
  return kind === 'simulation'
    ? `<div class="prj-band prj-band--simulation">${escHtml(MESSAGES.sectionSimulation)}</div>`
    : `<div class="prj-band prj-band--historical">${escHtml(MESSAGES.sectionHistorical)}</div>`;
}

function section(kind, title, body) {
  return `<div class="prj-section">${band(kind)}<div class="prj-body">
    ${title ? `<h3 class="prj-section-title">${escHtml(title)}</h3>` : ''}
    ${body}
  </div></div>`;
}

function card(label, value, sub) {
  return `<div class="prj-card">
    <div class="prj-card-label">${escHtml(label)}</div>
    <div class="prj-card-value">${value}</div>
    ${sub ? `<div class="prj-card-sub">${sub}</div>` : ''}
  </div>`;
}

function warn(text, blocking) {
  return `<div class="prj-warning${blocking ? ' prj-warning--blocking' : ''}"><span>${blocking ? '⛔' : '⚠️'}</span><span>${text}</span></div>`;
}

function notes(list) {
  if (!list?.length) return '';
  return `<ul class="prj-notes">${list.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>`;
}

function why(title, rows) {
  return `<details class="prj-why"><summary>${escHtml(title)}</summary>
    <div class="prj-why-body"><dl>
      ${rows.filter(Boolean).map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${v}</dd>`).join('')}
    </dl></div></details>`;
}

/** Barre horizontale : un taux, son effectif, son intervalle. */
function barRow(label, stats, { highlight = false } = {}) {
  const c = stats.confidence;
  // Aucune barre n'est tracée sous le minimum de cas : une barre pleine
  // largeur hachurée se lisait comme un taux de 100 %, exactement l'erreur
  // que ce garde-fou doit empêcher.
  const track = c.showRate
    ? `<div class="prj-bar-fill" style="width:${Math.round(100 * stats.rate)}%"
           title="Intervalle 95 % : ${pct(c.interval.low)} – ${pct(c.interval.high)}"></div>`
    : `<span class="prj-bar-empty">échantillon insuffisant (n &lt; ${MIN_CASES_TO_SHOW_RATE})</span>`;
  return `<div class="prj-bar-row">
    <div class="prj-bar-label${highlight ? ' is-cut' : ''}">${escHtml(label)}</div>
    <div class="prj-bar-track${c.showRate ? '' : ' is-empty'}">${track}</div>
    <div class="prj-bar-value">${rateCell(stats)}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// CHARGEMENT
// ─────────────────────────────────────────────────────────

async function load() {
  if (_loading) return;
  _loading = true;
  _error = null;
  try {
    const h = await loadHistory({});
    observations = h.observations;
    contexts = h.contexts;
    championshipsById = h.championshipsById;
    report = buildDataQualityReport(contexts, { championshipsById });
    _loaded = true;
  } catch (e) {
    console.error('projection : chargement', e);
    _error = e?.message || String(e);
  } finally {
    _loading = false;
  }
}

/** Observations correspondant aux filtres de l'onglet Historique. */
function selected() {
  return filterObservations(observations, {
    championshipId: filters.championshipId,
    category: filters.category,
    year: filters.year || undefined,
    circuit: filters.circuit,
  });
}

// ─────────────────────────────────────────────────────────
// RENDU — CADRE
// ─────────────────────────────────────────────────────────

function renderView() {
  const el = document.getElementById('view-projection');
  if (!el) return;

  el.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">📐 <span>Projection de qualification</span></h2>
    </div>
    <div class="prj-tabs">
      <button class="prj-tab ${activeTab === 'situation' ? 'is-active' : ''}" data-tab="situation">En situation</button>
      <button class="prj-tab ${activeTab === 'history' ? 'is-active' : ''}" data-tab="history">Historique</button>
      <button class="prj-tab ${activeTab === 'quality' ? 'is-active' : ''}" data-tab="quality">Qualité des données</button>
    </div>
    <div id="prj-content"></div>
  `;

  el.querySelectorAll('.prj-tab').forEach(b => {
    b.addEventListener('click', () => { activeTab = b.dataset.tab; renderView(); });
  });

  renderContent();
}

function renderContent() {
  const el = document.getElementById('prj-content');
  if (!el) return;

  if (_loading || !_loaded) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Chargement de l'historique…</div>`;
    return;
  }
  if (_error) {
    el.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">⚠️</div>
      <div class="placeholder-title">Impossible de charger les données</div>
      <div class="placeholder-desc">${escHtml(_error)}</div></div>`;
    return;
  }

  if (activeTab === 'situation') renderSituation(el);
  else if (activeTab === 'history') renderHistory(el);
  else renderQuality(el);
}

// ─────────────────────────────────────────────────────────
// ONGLET « EN SITUATION »
// ─────────────────────────────────────────────────────────

/** Meetings ayant au moins une manche courue — les seuls exploitables ici. */
function situationCandidates() {
  return contexts
    .filter(c => c.lastCompletedRace > 0)
    .sort((a, b) => String(b.meeting?.date).localeCompare(String(a.meeting?.date))
      || String(a.category).localeCompare(String(b.category)));
}

function renderSituation(el) {
  const candidates = situationCandidates();
  if (!candidates.length) {
    el.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📐</div>
      <div class="placeholder-title">Aucun meeting avec des manches courues</div></div>`;
    return;
  }

  const ctx = candidates.find(c => c.key === situation.meetingKey) || candidates[0];
  situation.meetingKey = ctx.key;

  const checkpoints = ctx.completedRaces;
  const checkpoint = checkpoints.includes(situation.checkpoint)
    ? situation.checkpoint
    : ctx.lastCompletedRace;

  const state = buildStateAfterRace(ctx, checkpoint);
  const threshold = resolveQualificationThreshold({
    regulation: ctx.regulation,
    observedPhaseCounts: ctx.observedPhaseCounts,
    engagedCount: ctx.engagedCount,
  });
  const support = checkRegulationSupport(ctx.regulation);
  const trivial = isTrivialQualification(ctx.engagedCount, threshold.threshold);

  const driver = state.standings.find(d => d.driverId === situation.driverId) || null;

  el.innerHTML = `
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-meeting" style="flex:1;min-width:220px">
        ${candidates.map(c => `<option value="${escHtml(c.key)}" ${c.key === ctx.key ? 'selected' : ''}>
          ${escHtml(c.meeting?.date || '')} · ${escHtml(c.meeting?.location || c.meetingId)} · ${escHtml(c.category)}
        </option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-checkpoint">
        ${checkpoints.map(n => `<option value="${n}" ${n === checkpoint ? 'selected' : ''}>Après Q${n}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-driver" style="flex:1;min-width:200px">
        <option value="">— Choisir un pilote —</option>
        ${state.standings.map(d => `<option value="${escHtml(d.driverId)}" ${d.driverId === situation.driverId ? 'selected' : ''}>
          P${d.position} · #${escHtml(String(d.carNumber))} ${escHtml(d.lastName || '')} ${escHtml(d.firstName || '')}
        </option>`).join('')}
      </select>
    </div>
    ${!support.supported ? warn(`${escHtml(MESSAGES.unsupportedRegulation)} — ${escHtml(support.reasons.join(' '))}`, true) : ''}
    <div id="prj-situation-body"></div>
  `;

  document.getElementById('prj-meeting')?.addEventListener('change', e => {
    situation.meetingKey = e.target.value;
    situation.checkpoint = null;
    situation.driverId = '';
    renderContent();
  });
  document.getElementById('prj-checkpoint')?.addEventListener('change', e => {
    situation.checkpoint = Number(e.target.value);
    renderContent();
  });
  document.getElementById('prj-driver')?.addEventListener('change', e => {
    situation.driverId = e.target.value;
    renderContent();
  });

  const body = document.getElementById('prj-situation-body');
  if (!support.supported) { body.innerHTML = ''; return; }

  body.innerHTML = [
    renderSituationHeader(ctx, state, threshold, checkpoint, trivial),
    driver ? renderDriverOutlook(ctx, state, threshold, checkpoint, driver, trivial) : '',
    renderStandingsTable(state, threshold, driver),
    renderSimulationPlaceholder(checkpoint, ctx),
  ].join('');
}

function renderSituationHeader(ctx, state, threshold, checkpoint, trivial) {
  const remaining = state.remainingRaces;
  const cards = [
    card('Meeting', escHtml(ctx.meeting?.location || ctx.meetingId), escHtml(ctx.category)),
    card('Checkpoint', `Après Q${checkpoint}`, remaining.length
      ? `Reste ${remaining.map(n => `Q${n}`).join(', ')}`
      : 'Manches qualificatives terminées'),
    card('Engagés', String(ctx.engagedCount), `${state.count} classés`),
    card('Places qualificatives', threshold.threshold != null ? String(threshold.threshold) : '—', escHtml(threshold.label)),
  ].join('');

  const trivialNote = trivial
    ? warn(escHtml(MESSAGES.trivialQualification(ctx.engagedCount, threshold.threshold)))
    : '';

  return section('historical', null, `${trivialNote}<div class="prj-cards">${cards}</div>`);
}

function renderDriverOutlook(ctx, state, threshold, checkpoint, driver, trivial) {
  const gap = gapToThreshold(driver.position, threshold.threshold);
  const finalRace = ctx.plannedRaceCount;

  // L'historique EXCLUT le meeting analysé : sinon on lirait le résultat qu'on
  // cherche à anticiper.
  const history = filterObservations(observations).filter(o => o.meetingId !== ctx.meetingId);

  const outlook = buildHistoricalOutlook({
    observations: history, checkpoint, finalRace,
    driver: { points: driver.totalPoints, position: driver.position, gap },
    filters: { championshipId: ctx.meeting?.championshipId, category: ctx.category },
  });

  const c = outlook.comparable;
  const cards = [
    card('Points', String(driver.totalPoints), `après Q${checkpoint}`),
    card('Classement', `P${driver.position}`, `sur ${state.count} classés`),
    card('Écart au seuil', escHtml(formatGap(gap)), gap <= 0 ? 'dans la zone qualificative' : 'hors zone qualificative'),
    card('Taux historique', c.confidence.showRate ? pct(c.rate) : '—',
      `${c.qualified}/${c.n} cas · ${confBadge(c.confidence)}`),
  ].join('');

  const whyPanel = why('Pourquoi ce chiffre ?', [
    ['Situation analysée', `${escHtml(formatGap(gap))} — ${driver.totalPoints} pts après Q${checkpoint}`],
    ['Cas comparables', `${c.n}`],
    ['dont qualifiés', `${c.qualified}`],
    ['Taux historique', c.confidence.showRate ? pct(c.rate) : `non affiché (n &lt; ${MIN_CASES_TO_SHOW_RATE})`],
    ['Intervalle 95 %', `${pct(c.confidence.interval.low)} – ${pct(c.confidence.interval.high)}`],
    ['Confiance', escHtml(c.confidence.label)],
    ['Périmètre retenu', escHtml(c.label)],
    ['Périmètres essayés', c.tried.map(t => `${escHtml(t.label)} → ${t.n} cas`).join('<br>')],
    ['Seuil de qualification', escHtml(threshold.label)],
    ['Meeting analysé', 'exclu de l\'historique'],
    ['Nature', 'observation historique — aucune simulation'],
  ]);

  const pointsView = outlook.pointsView.available
    ? `<p style="margin:var(--sp-sm) 0 0;font-size:.85rem">
         Lecture en points, à catégorie fixée — tranche <strong>${escHtml(outlook.pointsView.bucket.label)}</strong> :
         ${rateCell(outlook.pointsView.bucket)}
       </p>`
    : `<p class="prj-n" style="margin:var(--sp-sm) 0 0">Lecture en points indisponible ici : ${escHtml(outlook.pointsView.warning || 'périmètre non homogène')}</p>`;

  const remaining = outlook.remaining.map(r => renderRemainingRace(r, c.n)).join('');

  return section('historical',
    `${driver.firstName || ''} ${driver.lastName || ''} — ce qu'ont vécu les pilotes dans la même situation`,
    `${trivial ? warn(escHtml(MESSAGES.trivialQualification(ctx.engagedCount, threshold.threshold))) : ''}
     <div class="prj-cards">${cards}</div>
     ${notes(outlook.messages)}
     ${pointsView}
     ${whyPanel}
     ${remaining}`);
}

function renderRemainingRace(r, nComparables) {
  const d = r.distribution;
  if (!d.total) {
    return `<p class="prj-n" style="margin-top:var(--sp-md)">Q${r.raceNum} — aucun cas comparable exploitable.</p>`;
  }
  return `
    <h4 class="prj-section-title" style="margin-top:var(--sp-lg);font-size:.95rem">
      Q${r.raceNum} — résultats obtenus par ces ${nComparables} pilotes comparables
    </h4>
    <p class="prj-n">Place médiane ${d.median ?? '—'} · moyenne ${d.mean != null ? d.mean.toFixed(1).replace('.', ',') : '—'} ·
       ${d.withStatus} sans place (DNF / DNS / DSQ)</p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr>
        <th>Résultat en Q${r.raceNum}</th>
        <th class="center">Cas</th>
        <th class="center">Part</th>
        <th>Qualifiés au final</th>
      </tr></thead>
      <tbody>
        ${r.conditional.map(cnd => {
          const dist = d.byBucket.find(b => b.id === cnd.id);
          return `<tr>
            <td>${escHtml(cnd.label)}</td>
            <td class="center">${cnd.n}</td>
            <td class="center">${dist ? pct(dist.share) : '—'}</td>
            <td>${rateCell(cnd)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
}

function renderStandingsTable(state, threshold, focus) {
  const rows = state.standings.map(d => {
    const isCut = threshold.threshold != null && d.position === threshold.threshold;
    return `<tr class="${d.driverId === focus?.driverId ? 'is-focus' : ''} ${isCut ? 'prj-cutline' : ''}">
      <td class="center">P${d.position}</td>
      <td class="center">#${escHtml(String(d.carNumber))}</td>
      <td>${escHtml(d.lastName || '')} ${escHtml(d.firstName || '')}</td>
      <td class="center">${d.totalPoints}</td>
      <td class="center">${escHtml(formatGap(gapToThreshold(d.position, threshold.threshold)))}</td>
    </tr>`;
  }).join('');

  return section('historical', 'Classement intermédiaire au checkpoint', `
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th class="center">Pos.</th><th class="center">N°</th><th>Pilote</th>
        <th class="center">Points</th><th class="center">Écart au seuil</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="prj-n" style="margin-top:var(--sp-sm)">La ligne pointillée marque la dernière place qualificative.</p>
  `);
}

/**
 * L'emplacement de la simulation est matérialisé dès maintenant, vide et
 * annoncé comme tel : mieux vaut une absence explicite qu'un chiffre
 * historique que l'utilisateur prendrait pour une projection.
 */
function renderSimulationPlaceholder(checkpoint, ctx) {
  const remaining = ctx.plannedRaceCount - checkpoint;
  const body = remaining > 0
    ? `<p style="margin:0">Simulation ${remaining > 1 ? `des ${remaining} manches restantes` : 'de la manche restante'}
       (probabilité de qualification, scénarios « et si », résultat cible) : pas encore disponible.
       Les chiffres ci-dessus sont exclusivement des observations historiques.</p>`
    : `<p style="margin:0">Toutes les manches qualificatives sont courues : il n'y a rien à simuler,
       seule l'analyse réelle s'applique.</p>`;
  return section('simulation', null, body);
}

// ─────────────────────────────────────────────────────────
// ONGLET « HISTORIQUE »
// ─────────────────────────────────────────────────────────

function renderHistory(el) {
  const all = observations;
  const champs = [...new Set(all.map(o => o.championshipId).filter(Boolean))];
  const cats = distinctValues(filters.championshipId ? all.filter(o => o.championshipId === filters.championshipId) : all, 'category');
  const years = distinctValues(all, 'year');
  const circuits = distinctValues(all, 'circuit');

  el.innerHTML = `
    <div class="toolbar" style="flex-wrap:wrap;gap:var(--sp-sm)">
      <select class="toolbar-select" id="prj-h-champ">
        <option value="">Tous championnats</option>
        ${champs.map(id => `<option value="${escHtml(id)}" ${id === filters.championshipId ? 'selected' : ''}>${escHtml(championshipsById[id]?.name || id)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-cat">
        <option value="">Toutes catégories</option>
        ${cats.map(c => `<option value="${escHtml(c)}" ${c === filters.category ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-year">
        <option value="">Toutes saisons</option>
        ${years.map(y => `<option value="${y}" ${String(y) === String(filters.year) ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-circuit">
        <option value="">Tous circuits</option>
        ${circuits.map(c => `<option value="${escHtml(c)}" ${c === filters.circuit ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
      </select>
      <select class="toolbar-select" id="prj-h-cp">
        ${[1, 2, 3].map(n => `<option value="${n}" ${n === filters.checkpoint ? 'selected' : ''}>Après Q${n}</option>`).join('')}
      </select>
    </div>
    <div id="prj-history-body"></div>
  `;

  const on = (id, key, cast = v => v) => document.getElementById(id)
    ?.addEventListener('change', e => { filters[key] = cast(e.target.value); renderContent(); });
  on('prj-h-champ', 'championshipId');
  on('prj-h-cat', 'category');
  on('prj-h-year', 'year', v => (v ? Number(v) : ''));
  on('prj-h-circuit', 'circuit');
  on('prj-h-cp', 'checkpoint', v => Number(v));

  const obs = selected();
  const body = document.getElementById('prj-history-body');

  if (!obs.length) {
    body.innerHTML = `<div class="tim-placeholder"><div class="placeholder-icon">📊</div>
      <div class="placeholder-title">Aucun cas exploitable pour cette sélection</div>
      <div class="placeholder-desc">Les meetings où tous les engagés tiennent dans les places
      qualificatives sont exclus : la qualification y est mécanique.</div></div>`;
    return;
  }

  body.innerHTML = [
    renderHistorySummary(obs),
    renderGapChart(obs),
    renderPointsChart(obs),
    renderFinalRaceAnalysis(obs),
  ].join('');
}

function renderHistorySummary(obs) {
  const meetings = new Set(obs.map(o => o.meetingId)).size;
  const cats = new Set(obs.map(o => o.category)).size;
  const seasons = new Set(obs.map(o => o.year)).size;
  const s = rateStats(obs);
  return section('historical', null, `<div class="prj-cards">
    ${card('Cas exploitables', String(obs.length), 'hors qualification mécanique')}
    ${card('Meetings', String(meetings), `${cats} catégorie${cats > 1 ? 's' : ''} · ${seasons} saison${seasons > 1 ? 's' : ''}`)}
    ${card('Qualifiés', String(s.qualified), `soit ${pct(s.rate)}`)}
    ${card('Confiance globale', escHtml(s.confidence.label), `intervalle ${pct(s.confidence.interval.low)} – ${pct(s.confidence.interval.high)}`)}
  </div>`);
}

function renderGapChart(obs) {
  const cp = filters.checkpoint;
  const agg = aggregateByGap(obs, cp);
  if (!agg.rows.length) return '';
  const rows = agg.rows.map(r => barRow(r.label, r, { highlight: r.gap === 0 })).join('');
  const thin = agg.rows.filter(r => !r.confidence.showRate).length;
  const thinNote = thin > agg.rows.length / 2
    ? warn(`À ce périmètre, ${thin} écarts sur ${agg.rows.length} comptent moins de ${MIN_CASES_TO_SHOW_RATE} cas. Élargissez les filtres pour une lecture fiable.`)
    : '';

  return section('historical',
    `Taux de qualification finale par écart au seuil — après Q${cp}`,
    `<p class="prj-n" style="margin-bottom:var(--sp-sm)">
       Axe normalisé : comparable entre catégories et championnats, contrairement aux points.
       Négatif = dans la zone qualificative. ${agg.total} cas.
     </p>
     ${thinNote}
     <div class="prj-chart">${rows}</div>
     ${why('Comment lire cette courbe ?', [
       ['Lecture', 'chaque ligne regroupe les pilotes qui étaient à cet écart de la dernière place qualificative après Q' + cp],
       ['Qualifié', 'au sens de la règle sportive (classement final ≤ seuil)'],
       ['Sans barre', `effectif inférieur à ${MIN_CASES_TO_SHOW_RATE} cas : le comptage brut est affiché, pas de taux`],
       ['Exclusions', 'meetings où tous les engagés tiennent dans les places qualificatives'],
       ['Nature', 'observations mesurées — aucune simulation'],
     ])}`);
}

const POINTS_WHY = [
  ['Raison', 'le barème dépend de la taille du plateau : à position égale, un pilote marque plus de points dans une catégorie à 30 engagés que dans une à 10'],
  ['Conséquence', 'mélanger les catégories rend la courbe non monotone et trompeuse'],
  ['Condition', 'championnat et catégorie doivent être fixés dans les filtres'],
  ['Tranches', 'largeur adaptée pour viser un effectif exploitable, plafonnée pour rester lisible'],
];

function renderPointsChart(obs) {
  const cp = filters.checkpoint;
  const agg = aggregateByPoints(obs, cp, { filters });
  if (!agg.rows.length) return '';

  // Hors périmètre homogène, la courbe n'est PAS tracée : elle mélangerait des
  // barèmes incomparables et se lirait pourtant comme une courbe valide.
  if (!agg.comparable) {
    return section('historical', `Taux de qualification finale par points — après Q${cp}`,
      `${warn(escHtml(agg.warning))}
       <p class="prj-n">Filtres manquants : ${agg.missingFilters.map(f => f === 'championshipId' ? 'championnat' : 'catégorie').join(' et ')}.</p>
       ${why('Pourquoi cette vue est-elle conditionnée ?', POINTS_WHY)}`);
  }

  const rows = agg.rows.map(r => barRow(r.label, r)).join('');
  const head = `<p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Tranches adaptatives : leur largeur s'ajuste à l'échantillon plutôt que d'imposer un pas fixe. ${agg.total} cas.
    </p>`;

  return section('historical', `Taux de qualification finale par points — après Q${cp}`,
    `${head}<div class="prj-chart">${rows}</div>
     ${why('Pourquoi cette vue est-elle conditionnée ?', POINTS_WHY)}`);
}

function renderFinalRaceAnalysis(obs) {
  const cp = filters.checkpoint;
  const finalRaces = [...new Set(obs.map(o => o.finalRace))];
  if (finalRaces.length !== 1) {
    return section('historical', 'Analyse de la dernière manche',
      `<p class="prj-n">La sélection mélange des meetings avec des nombres de manches différents (${finalRaces.join(', ')}). Affinez les filtres pour cette analyse.</p>`);
  }
  const last = finalRaces[0];
  if (last <= cp) return '';

  const groups = [-2, -1, 0, 1, 2].map(gap => {
    const cases = obs.filter(o => o.checkpoints?.[cp]?.gap === gap);
    return { gap, cases, dist: resultDistribution(cases, last), cond: conditionalQualificationByResult(cases, last) };
  }).filter(g => g.cases.length);

  if (!groups.length) return '';

  const tables = groups.map(g => `
    <h4 class="prj-section-title" style="margin-top:var(--sp-md);font-size:.95rem">
      Après Q${cp} : ${escHtml(formatGap(g.gap))} <span class="prj-n">— ${g.cases.length} cas</span>
    </h4>
    <p class="prj-n">Place médiane en Q${last} : ${g.dist.median ?? '—'} · ${g.dist.withStatus} sans place (DNF / DNS / DSQ)</p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Résultat en Q${last}</th><th class="center">Cas</th><th class="center">Part</th><th>Qualifiés au final</th></tr></thead>
      <tbody>${g.cond.map(c => {
        const d = g.dist.byBucket.find(b => b.id === c.id);
        return `<tr><td>${escHtml(c.label)}</td><td class="center">${c.n}</td>
          <td class="center">${d ? pct(d.share) : '—'}</td><td>${rateCell(c)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`).join('');

  return section('historical', `Ce qui s'est passé en Q${last} selon la position après Q${cp}`,
    `<p class="prj-n">Constat brut : quels résultats ces pilotes ont obtenu, et combien se sont qualifiés.
       Les causes ne sont pas observables dans les données et ne sont donc pas interprétées ici.</p>
     ${tables}`);
}

// ─────────────────────────────────────────────────────────
// ONGLET « QUALITÉ DES DONNÉES »
// ─────────────────────────────────────────────────────────

function renderQuality(el) {
  const s = report.summary;
  const cov = s.checkpointCoverage;
  const checkpoints = [...new Set([
    ...Object.keys(cov.withDefaultRule), ...Object.keys(cov.withProjectionRule),
  ])].map(Number).sort((a, b) => a - b);

  const blockers = report.blockers.length
    ? warn(`${escHtml(MESSAGES.unsupportedRegulation)} pour : ${report.blockers.map(b => `${escHtml(b.championshipName)} (${escHtml(b.reasons.join(' '))})`).join(', ')}`, true)
    : '';

  el.innerHTML = [
    blockers,
    section('historical', 'Ce sur quoi reposent les chiffres', `<div class="prj-cards">
      ${card('Groupes meeting × catégorie', String(s.totalGroups),
        `${s.completeGroups} complets · ${s.partialGroups} partiels · ${s.emptyGroups} sans résultat`)}
      ${card('Exploitables', String(s.exploitableGroups), `${s.trivialGroups} exclus (qualification mécanique)`)}
      ${card('Meetings complets', String(s.meetings), `${s.seasons.join(', ')}`)}
      ${card('Championnats', String(s.championships.length), escHtml(s.championships.join(' · ')))}
      ${card('Cas pilote', String(observations.length), `${filterObservations(observations).length} exploitables`)}
      ${card('Divergences règle / réalité', String(s.divergenceCount), 'forfaits et repêchages')}
      ${card('Participations en double', String(s.duplicateParticipants),
        s.duplicateParticipants ? `sur ${s.groupsWithDuplicates} groupe${s.groupsWithDuplicates > 1 ? 's' : ''} · ignorées au calcul` : 'aucune')}
    </div>
    ${s.duplicateParticipants ? warn(`${s.duplicateParticipants} document${s.duplicateParticipants > 1 ? 's' : ''} <em>sessionParticipants</em> inscrivent un pilote deux fois à la même manche. Le module les ignore, mais le nombre d'engagés affiché ailleurs dans l'application en est faussé — et avec lui les points attribués aux DNF.`) : ''}`),

    section('historical', 'Couverture des checkpoints', `
      <p class="prj-n" style="margin-bottom:var(--sp-sm)">
        Nombre de lignes pilote reconstruites après chaque manche, sur les meetings complets.
        La règle de l'application exige 2 manches classées pour figurer au classement intermédiaire :
        elle est correcte pour attribuer des points, mais rend le checkpoint après Q1 inexploitable.
        Le module de projection n'en exige qu'une.
      </p>
      <div class="prj-scroll"><table class="prj-table">
        <thead><tr><th>Règle appliquée</th>${checkpoints.map(n => `<th class="center">Après Q${n}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>Application (min. 2 manches classées)</td>
            ${checkpoints.map(n => `<td class="center ${cov.withDefaultRule[n] ? '' : 'prj-dq-warn'}">${cov.withDefaultRule[n] ?? 0}</td>`).join('')}</tr>
          <tr><td>Projection (min. 1 manche classée)</td>
            ${checkpoints.map(n => `<td class="center prj-dq-ok">${cov.withProjectionRule[n] ?? 0}</td>`).join('')}</tr>
        </tbody>
      </table></div>`),

    renderDivergences(),
    renderGroupsTable(),
  ].join('');
}

function renderDivergences() {
  if (!report.divergences.length) {
    return section('historical', 'Divergences règle / réalité',
      `<p class="prj-n">Aucune : tous les pilotes classés qualifiés étaient bien présents en phase suivante.</p>`);
  }
  return section('historical', `Divergences règle / réalité (${report.divergences.length})`, `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Ces pilotes sont les seuls cas où la règle sportive et la réalité s'écartent.
      La projection se calibre sur la règle : un forfait n'est pas prévisible.
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Meeting</th><th>Catégorie</th><th>Pilote</th>
        <th class="center">Pos.</th><th class="center">Seuil</th><th>Explication</th></tr></thead>
      <tbody>${report.divergences.map(d => `<tr>
        <td>${escHtml(d.meetingLabel)}</td>
        <td>${escHtml(d.category)}</td>
        <td>#${escHtml(String(d.carNumber ?? '?'))} ${escHtml(d.lastName || '?')}</td>
        <td class="center">${d.position != null ? 'P' + d.position : '—'}</td>
        <td class="center">${d.threshold ?? '—'}</td>
        <td>${escHtml(d.description)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`);
}

function renderGroupsTable() {
  const rows = report.groups.map(g => {
    const races = g.races.map(r => {
      if (!r.hasResults) return `<span class="prj-dq-off" title="Manche non courue">·</span>`;
      const cls = (r.empty > 0 || r.duplicates > 0) ? 'prj-dq-warn' : 'prj-dq-ok';
      const dup = r.duplicates ? ` · ${r.duplicates} inscription(s) en double ignorée(s)` : '';
      return `<span class="${cls}" title="${r.engaged} engagés · ${r.timed} chronos · ${r.withStatus} statuts · ${r.empty} sans saisie${dup}">${r.results}</span>`;
    }).join(' ');

    const etat = !g.hasAnyResult ? '<span class="prj-chip">à venir</span>'
      : g.isComplete
        ? (g.trivial ? '<span class="prj-chip prj-chip--info">mécanique</span>' : '<span class="prj-chip prj-chip--ok">exploitable</span>')
        : '<span class="prj-chip prj-chip--ko">incomplet</span>';

    return `<tr>
      <td>${escHtml(g.meetingDate || '')}</td>
      <td>${escHtml(g.meetingLabel)}</td>
      <td>${escHtml(g.category)}</td>
      <td class="center">${g.engagedCount}</td>
      <td class="prj-dq-race center">${races}</td>
      <td class="center">${g.threshold ?? '—'}</td>
      <td class="center"><span class="prj-chip" title="${escHtml(g.thresholdLabel)}">${escHtml(g.thresholdSource)}</span></td>
      <td class="center">${g.divergenceCount || '—'}</td>
      <td class="center">${g.duplicateParticipants ? `<span class="prj-chip prj-chip--ko">${g.duplicateParticipants}</span>` : '—'}</td>
      <td class="center">${etat}</td>
    </tr>`;
  }).join('');

  return section('historical', 'Détail meeting par meeting', `
    <p class="prj-n" style="margin-bottom:var(--sp-sm)">
      Chaque cellule de manche indique le nombre de résultats saisis ; un point signale une manche non courue.
      Survolez pour le détail engagés / chronos / statuts.
    </p>
    <div class="prj-scroll"><table class="prj-table">
      <thead><tr><th>Date</th><th>Meeting</th><th>Catégorie</th><th class="center">Engagés</th>
        <th class="center">Q1 Q2 Q3 Q4</th><th class="center">Seuil</th><th class="center">Source</th>
        <th class="center">Div.</th><th class="center" title="Participations en double, ignorées au calcul">Doub.</th>
        <th class="center">État</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`);
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────

export function initProjection() {
  if (_initialised) return;
  _initialised = true;

  document.addEventListener('viewchange', async e => {
    if (e.detail.view !== 'projection') return;
    renderView();
    if (!_loaded && !_loading) {
      await load();
      renderContent();
    }
  });

  // Un changement de championnat peut modifier les règlements chargés :
  // on repart des documents plutôt que d'un cache potentiellement obsolète.
  document.addEventListener('championshipchange', () => {
    clearCache();
    _loaded = false;
    observations = []; contexts = []; report = null;
    if (document.getElementById('view-projection')?.style.display !== 'none') {
      renderView();
      load().then(renderContent);
    }
  });
}

/** Exporté pour un futur point d'entrée depuis la vue Classements. */
export async function preloadProjection() {
  if (!_loaded && !_loading) await load();
  return { observations, contexts, championshipsById };
}

// Réexport utilisé par les points d'entrée croisés (aucun calcul ici).
export { loadContexts };
