/* ═══════════════════════════════════════════════
   CHAMPIONSHIPCHART.JS — Évolution du top 5 (un week-end, ou toute la saison)

   Module PUR (ni Firebase, ni DOM) : il reçoit le classement saison déjà
   calculé par championship.js (avec le détail des points par phase de chaque
   meeting) et produit les données du graphique puis son SVG sous forme de
   chaîne. Testable en Node, comme calc.js.

   Les phases qui rapportent des points dépendent du règlement :
     • FFSA : classement intermédiaire → ½ finale → finale
     • FIA  : ¼ de finale → ½ finale → finale (pas de points intermédiaires)
   Le graphique s'adapte donc au règlement actif, et par sécurité ajoute une
   phase dès qu'au moins un pilote y a marqué (config incohérente, ancien
   championnat sans sessionConfig…).
═══════════════════════════════════════════════ */

import { escHtml } from './utils.js';

// ─────────────────────────────────────────────────────────
// PHASES D'UN WEEK-END
// ─────────────────────────────────────────────────────────

export const PHASE_DEFS = {
  interim: { label: 'Classement intermédiaire', short: 'Interm.',  abbr: 'Int.' },
  qf:      { label: '¼ de finale',              short: '¼ finale', abbr: '¼' },
  df:      { label: '½ finale',                 short: '½ finale', abbr: '½' },
  fin:     { label: 'Finale',                   short: 'Finale',   abbr: 'Fin.' },
};

/** Libellé court d'un meeting : « 30/08 Lohéac ». */
export function meetingShortLabel(m) {
  const d = m?.date ? new Date(m.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '?';
  return `${d} ${(m?.location || '').split(' ')[0] || '?'}`;
}

/** Ordre chronologique des phases d'un week-end. */
const PHASE_ORDER = ['interim', 'qf', 'df', 'fin'];

/**
 * Phases qui rapportent des points pour ce règlement.
 *
 * @param {object|null} regulation — config du championnat (peut être null :
 *        on retombe alors sur le barème FFSA par défaut, comme calc.js)
 * @param {Array} [meetingRows] — détails { interim, qf, df, fin } observés sur
 *        le meeting : une phase où quelqu'un a marqué est toujours affichée
 * @returns {string[]} clés de phases, dans l'ordre chronologique
 */
export function weekendPhases(regulation, meetingRows = []) {
  const scored = key => meetingRows.some(r => (Number(r?.[key]) || 0) !== 0);

  const interimOn = regulation ? regulation.interimPointsEnabled !== false : true;
  const qfOn = regulation?.sessionConfig?.QF?.enabled === true
            || (Array.isArray(regulation?.competitionPhases) && regulation.competitionPhases.includes('QF'));

  const enabled = {
    interim: interimOn || scored('interim'),
    qf:      qfOn      || scored('qf'),
    df:      true,
    fin:     true,
  };
  return PHASE_ORDER.filter(k => enabled[k]);
}

// ─────────────────────────────────────────────────────────
// DONNÉES DU GRAPHIQUE
// ─────────────────────────────────────────────────────────

/**
 * Construit les courbes du top N pour un meeting donné.
 *
 * @param {object} p
 * @param {Array}  p.standings  — sortie de calcChampionship() : chaque pilote
 *        porte meetingPts { meetingId → total } et meetingDetail
 *        { meetingId → { interim, qf, df, fin, total } }, plus penalty
 * @param {Array}  p.meetings   — meetings de la saison, triés par date
 * @param {string} p.meetingId  — meeting à détailler
 * @param {object} [p.regulation]
 * @param {'season'|'meeting'} [p.mode='season']
 *        'season'  : la courbe part du total saison AVANT le meeting (pénalités
 *                    saison déjà déduites) — on voit le championnat bouger ;
 *        'meeting' : la courbe part de 0 — on ne voit que le week-end.
 * @param {number} [p.topN=5]
 * @returns {object|null} { meeting, mode, phases, labels, series, maxY, minY }
 *          ou null si le meeting est inconnu
 */
export function buildWeekendEvolution({ standings = [], meetings = [], meetingId, regulation = null, mode = 'season', topN = 5 }) {
  const idx = meetings.findIndex(m => m.id === meetingId);
  if (idx < 0) return null;
  const meeting = meetings[idx];
  const before  = meetings.slice(0, idx);

  const details = standings.map(d => d.meetingDetail?.[meetingId]).filter(Boolean);
  const phases  = weekendPhases(regulation, details);

  const all = standings.map((d, rank) => {
    const det     = d.meetingDetail?.[meetingId] || null;
    const present = !!det;
    let start = 0;
    if (mode === 'season') {
      start = before.reduce((s, m) => s + (Number(d.meetingPts?.[m.id]) || 0), 0)
            - (Number(d.penalty) || 0);
    }
    const values = [start];
    const gains  = [];
    let cum = start;
    phases.forEach(k => {
      const g = present ? (Number(det[k]) || 0) : 0;
      gains.push(g);
      cum += g;
      values.push(cum);
    });
    return {
      driverId:  d.driverId,
      firstName: d.firstName ?? '',
      lastName:  d.lastName  ?? '',
      carNumber: d.carNumber ?? '',
      present,
      start,
      gains,
      values,
      end:       cum,
      meetingTotal: present ? (Number(det.total) || 0) : 0,
      seasonRank: rank,
    };
  });

  const pool = mode === 'meeting' ? all.filter(s => s.present) : all;
  pool.sort((a, b) => (b.end - a.end) || (a.seasonRank - b.seasonRank));

  const series = pool.slice(0, topN).map((s, i) => ({ ...s, slot: i + 1 }));
  // Une phase où personne (dans le top N) n'a encore marqué est probablement
  // à venir : on la garde sur l'axe pour montrer ce qui reste à disputer.
  const allVals = series.flatMap(s => s.values);
  const maxY = allVals.length ? Math.max(0, ...allVals) : 0;
  const minY = allVals.length ? Math.min(0, ...allVals) : 0;

  const labels = [mode === 'season' ? 'Avant' : 'Départ', ...phases.map(k => PHASE_DEFS[k].short)];
  const columns = labels.map((label, i) => ({
    label,
    title: i === 0 ? label : PHASE_DEFS[phases[i - 1]].label,
  }));
  series.forEach(s => { s.tableValues = s.values; s.tableGains = s.gains; });

  return {
    scope: 'weekend',
    meeting,
    mode,
    phases,
    labels,
    columns,
    groups: null,
    tableLabels: labels,
    series,
    maxY,
    minY,
  };
}

/**
 * Construit les courbes du top N sur TOUTE la saison : une colonne par
 * phase à points de chaque meeting, dans l'ordre chronologique. Les
 * courbes partent de 0 (pénalités saison déduites, pour que l'arrivée
 * corresponde au total du tableau) ; un pilote absent d'un meeting y a
 * une courbe plate.
 *
 * Le tableau associé est résumé PAR MEETING (cumul après le meeting et
 * points du meeting) : une colonne par phase serait illisible.
 *
 * @param {object} p — { standings, meetings, regulation, topN }
 * @returns {object|null} même forme que buildWeekendEvolution, plus
 *          `groups` = [{ meetingId, label, from, to }] (indices de colonnes)
 */
export function buildSeasonEvolution({ standings = [], meetings = [], regulation = null, topN = 5 }) {
  if (!meetings.length) return null;

  // Colonnes : « Départ » puis, par meeting, ses phases à points
  const columns = [{ label: 'Départ', title: 'Départ de saison', meetingId: null, phase: null }];
  const groups  = [];
  meetings.forEach(m => {
    const details = standings.map(d => d.meetingDetail?.[m.id]).filter(Boolean);
    const phases  = weekendPhases(regulation, details);
    const label   = meetingShortLabel(m);
    const from    = columns.length;
    phases.forEach(k => columns.push({
      label: PHASE_DEFS[k].abbr,
      title: `${label} — ${PHASE_DEFS[k].label}`,
      meetingId: m.id,
      phase: k,
    }));
    groups.push({ meetingId: m.id, label, from, to: columns.length - 1 });
  });

  const all = standings.map((d, rank) => {
    const start  = 0 - (Number(d.penalty) || 0);   // « 0 - » évite un -0 quand pas de pénalité
    const values = [start];
    const gains  = [];
    const tableValues = [start];
    const tableGains  = [];
    let cum = start;
    let present = false;
    columns.slice(1).forEach(c => {
      const det = d.meetingDetail?.[c.meetingId];
      const g   = det ? (Number(det[c.phase]) || 0) : 0;
      gains.push(g);
      cum += g;
      values.push(cum);
    });
    meetings.forEach(m => {
      const det = d.meetingDetail?.[m.id];
      if (det) present = true;
      const g = det ? (Number(det.total) || 0) : 0;
      tableGains.push(g);
      tableValues.push(tableValues[tableValues.length - 1] + g);
    });
    return {
      driverId:  d.driverId,
      firstName: d.firstName ?? '',
      lastName:  d.lastName  ?? '',
      carNumber: d.carNumber ?? '',
      present,
      start,
      gains,
      values,
      end:       cum,
      tableValues,
      tableGains,
      seasonRank: rank,
    };
  });

  all.sort((a, b) => (b.end - a.end) || (a.seasonRank - b.seasonRank));
  const series = all.slice(0, topN).map((s, i) => ({ ...s, slot: i + 1 }));
  const allVals = series.flatMap(s => s.values);

  return {
    scope: 'season',
    meeting: null,
    mode: 'season',
    phases: null,
    labels: columns.map(c => c.label),
    columns,
    groups,
    tableLabels: ['Départ', ...meetings.map(meetingShortLabel)],
    series,
    maxY: allVals.length ? Math.max(0, ...allVals) : 0,
    minY: allVals.length ? Math.min(0, ...allVals) : 0,
  };
}

/**
 * Meeting proposé par défaut : le plus récent où au moins un pilote a marqué.
 * @returns {string|null}
 */
export function defaultChartMeetingId(standings = [], meetings = []) {
  for (let i = meetings.length - 1; i >= 0; i--) {
    const id = meetings[i].id;
    if (standings.some(d => d.meetingPts?.[id] != null)) return id;
  }
  return meetings.length ? meetings[meetings.length - 1].id : null;
}

// ─────────────────────────────────────────────────────────
// RENDU SVG (chaîne, sans DOM)
// ─────────────────────────────────────────────────────────

export const CHART_W = 640;
export const CHART_H = 250;
const PAD = { top: 18, right: 118, bottom: 34, left: 44 };
/** Espace minimal entre deux colonnes en vue saison (le conteneur défile). */
const SEASON_COL_STEP = 48;
/** Hauteur supplémentaire sous l'axe pour la ligne des meetings (vue saison). */
const GROUP_ROW = 16;

/** Pas « joli » pour les graduations Y. */
function niceStep(span, target = 5) {
  if (span <= 0) return 1;
  const rough = span / target;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const m of [1, 2, 5, 10]) if (m * mag >= rough) return m * mag;
  return 10 * mag;
}

/**
 * Géométrie partagée entre le SVG et la couche de survol (championship.js
 * lit les mêmes x pour placer le curseur).
 */
export function chartGeometry(data) {
  const nX  = data.labels.length;
  const hasGroups = Array.isArray(data.groups) && data.groups.length > 0;
  const pad = hasGroups ? { ...PAD, bottom: PAD.bottom + GROUP_ROW } : PAD;
  // Vue saison : la largeur suit le nombre de colonnes (défilement horizontal)
  const W   = hasGroups
    ? Math.max(CHART_W, pad.left + pad.right + (nX - 1) * SEASON_COL_STEP)
    : CHART_W;
  const H   = CHART_H;
  const pw  = W - pad.left - pad.right;
  const ph  = H - pad.top - pad.bottom;
  const step  = niceStep(data.maxY - data.minY);
  const yMin  = Math.floor(data.minY / step) * step;
  const yMax  = Math.max(yMin + step, Math.ceil(data.maxY / step) * step);
  const xs    = Array.from({ length: nX }, (_, i) => pad.left + (nX > 1 ? (i * pw) / (nX - 1) : pw / 2));
  const toY   = v => pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
  return { W, H, xs, toY, yMin, yMax, step, pad, pw, ph };
}

/**
 * Écarte verticalement les libellés de fin de courbe pour qu'ils ne se
 * chevauchent pas (espacement minimal `gap`, dans les limites du tracé).
 */
function spreadLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
  if (overflow > 0) sorted.forEach(it => { it.y -= overflow; });
  sorted.forEach(it => { if (it.y < top) it.y = top; });
  return sorted;
}

function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }

/**
 * SVG du graphique. Les couleurs viennent des variables CSS --chp-s1…s5
 * (définies dans championship.css) : la couleur suit le pilote, jamais son
 * rang du moment — le slot est attribué à la construction et ne change pas
 * quand on bascule de mode.
 */
export function renderWeekendChartSvg(data) {
  const g = chartGeometry(data);
  const { W, H, xs, toY, yMin, yMax, step, pad } = g;
  const right = W - pad.right;

  // Grille horizontale, ticks Y
  let grid = '';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = toY(v).toFixed(1);
    grid += `<line x1="${pad.left}" y1="${y}" x2="${right}" y2="${y}" class="chp-evo-grid"/>`
          + `<text x="${pad.left - 6}" y="${y}" class="chp-evo-tick" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`;
  }

  // Repères verticaux + libellés de phases
  const axisY = H - pad.bottom;
  const xLabels = data.labels.map((lbl, i) => {
    const x = xs[i].toFixed(1);
    return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${axisY}" class="chp-evo-grid chp-evo-grid--x"/>`
         + `<text x="${x}" y="${axisY + 16}" class="chp-evo-xlabel${data.groups ? ' chp-evo-xlabel--abbr' : ''}" text-anchor="middle">${escHtml(lbl)}</text>`;
  }).join('');

  // Vue saison : séparateurs et libellés de meetings sous les phases
  const groupsSvg = (data.groups || []).map(grp => {
    const half = (xs[1] - xs[0]) / 2;
    const x0 = xs[grp.from] - half;
    const x1 = xs[grp.to] + half;
    const cx = (x0 + x1) / 2;
    return `<line x1="${x0.toFixed(1)}" y1="${pad.top}" x2="${x0.toFixed(1)}" y2="${axisY + 6}" class="chp-evo-group-sep"/>`
         + `<text x="${cx.toFixed(1)}" y="${axisY + 16 + GROUP_ROW}" class="chp-evo-group-label" text-anchor="middle">${escHtml(grp.label)}</text>`;
  }).join('');

  // Courbes
  const lines = data.series.map(s => {
    const pts = s.values.map((v, i) => `${xs[i].toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
    const dots = s.values.map((v, i) =>
      `<circle cx="${xs[i].toFixed(1)}" cy="${toY(v).toFixed(1)}" r="4" class="chp-evo-dot" style="fill:var(--chp-s${s.slot})"><title>${escHtml(`${s.lastName} — ${data.labels[i]} : ${fmt(v)} pts`)}</title></circle>`
    ).join('');
    return `<g class="chp-evo-series" data-driver="${escHtml(s.driverId)}">`
         + `<polyline points="${pts}" class="chp-evo-line" style="stroke:var(--chp-s${s.slot})"/>`
         + dots + `</g>`;
  }).join('');

  // Libellés directs en fin de courbe (N° + nom), écartés si trop proches
  const endLabels = spreadLabels(
    data.series.map(s => ({ s, y: toY(s.end) })),
    12, pad.top + 4, axisY - 4
  ).map(({ s, y }) => {
    const x0 = xs[xs.length - 1];
    const x1 = x0 + 8;
    const name = `${s.carNumber ? '#' + s.carNumber + ' ' : ''}${s.lastName}`;
    return `<line x1="${(x0 + 5).toFixed(1)}" y1="${toY(s.end).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" class="chp-evo-leader"/>`
         + `<text x="${(x1 + 3).toFixed(1)}" y="${y.toFixed(1)}" class="chp-evo-endlabel" dominant-baseline="middle">`
         + `<tspan class="chp-evo-endlabel-name">${escHtml(name)}</tspan> <tspan class="chp-evo-endlabel-val">${fmt(s.end)}</tspan></text>`;
  }).join('');

  const scopeTxt = data.scope === 'season' ? 'sur la saison' : 'sur le week-end';
  return `<svg viewBox="0 0 ${W} ${H}" class="chp-evo-svg${data.groups ? ' chp-evo-svg--season' : ''}" style="min-width:${Math.max(560, W)}px" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Évolution des points du top ${data.series.length} ${scopeTxt}">
    ${grid}
    ${xLabels}
    ${groupsSvg}
    <line x1="${pad.left}" y1="${toY(0).toFixed(1)}" x2="${right}" y2="${toY(0).toFixed(1)}" class="chp-evo-axis"/>
    ${lines}
    ${endLabels}
    <line class="chp-evo-cursor" x1="0" y1="${pad.top}" x2="0" y2="${axisY}" style="display:none"/>
  </svg>`;
}

/**
 * Légende + tableau détaillé (la « vue table » : chaque valeur du graphique
 * est aussi lisible ici, sans dépendre des couleurs).
 */
export function renderWeekendChartTable(data) {
  const labels = data.tableLabels || data.labels;
  const head = labels.map((l, i) =>
    `<th class="center${i === 0 ? '' : ' chp-evo-th-phase'}">${escHtml(l)}</th>`).join('');

  const rows = data.series.map(s => {
    const values = s.tableValues || s.values;
    const gains  = s.tableGains  || s.gains;
    const cells = values.map((v, i) => {
      if (i === 0) return `<td class="center"><span class="chp-evo-cum">${fmt(v)}</span></td>`;
      const gain = gains[i - 1];
      return `<td class="center"><span class="chp-evo-cum">${fmt(v)}</span>`
           + `<span class="chp-evo-gain${gain > 0 ? ' is-pos' : ''}">${gain > 0 ? '+' : ''}${fmt(gain)}</span></td>`;
    }).join('');
    return `<tr>
      <td><span class="chp-evo-swatch" style="background:var(--chp-s${s.slot})"></span>
          ${escHtml(s.firstName)} <strong>${escHtml(s.lastName)}</strong>
          ${s.carNumber ? `<span class="tim-num">${escHtml(s.carNumber)}</span>` : ''}
          ${s.present || data.scope === 'season' ? '' : '<span class="chp-absent" title="Absent de ce meeting">absent</span>'}</td>
      ${cells}
    </tr>`;
  }).join('');

  return `<div class="table-wrap chp-evo-table-wrap">
    <table class="chp-evo-table">
      <thead><tr><th>Pilote</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
