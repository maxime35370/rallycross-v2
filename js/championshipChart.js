/* ═══════════════════════════════════════════════
   CHAMPIONSHIPCHART.JS — Évolution du top 5 sur un week-end

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
  interim: { label: 'Classement intermédiaire', short: 'Interm.' },
  qf:      { label: '¼ de finale',              short: '¼ finale' },
  df:      { label: '½ finale',                 short: '½ finale' },
  fin:     { label: 'Finale',                   short: 'Finale' },
};

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

  return {
    meeting,
    mode,
    phases,
    labels: [mode === 'season' ? 'Avant' : 'Départ', ...phases.map(k => PHASE_DEFS[k].short)],
    series,
    maxY,
    minY,
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

/** Pas « joli » pour les graduations Y. */
function niceStep(span, target = 4) {
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
  const pw  = CHART_W - PAD.left - PAD.right;
  const ph  = CHART_H - PAD.top - PAD.bottom;
  const step  = niceStep(data.maxY - data.minY);
  const yMin  = Math.floor(data.minY / step) * step;
  const yMax  = Math.max(yMin + step, Math.ceil(data.maxY / step) * step);
  const xs    = Array.from({ length: nX }, (_, i) => PAD.left + (nX > 1 ? (i * pw) / (nX - 1) : pw / 2));
  const toY   = v => PAD.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
  return { xs, toY, yMin, yMax, step, pad: PAD, pw, ph };
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
  const { xs, toY, yMin, yMax, step, pad } = g;
  const right = CHART_W - pad.right;

  // Grille horizontale, ticks Y
  let grid = '';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = toY(v).toFixed(1);
    grid += `<line x1="${pad.left}" y1="${y}" x2="${right}" y2="${y}" class="chp-evo-grid"/>`
          + `<text x="${pad.left - 6}" y="${y}" class="chp-evo-tick" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`;
  }

  // Repères verticaux + libellés de phases
  const xLabels = data.labels.map((lbl, i) => {
    const x = xs[i].toFixed(1);
    return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${CHART_H - pad.bottom}" class="chp-evo-grid chp-evo-grid--x"/>`
         + `<text x="${x}" y="${CHART_H - pad.bottom + 16}" class="chp-evo-xlabel" text-anchor="middle">${escHtml(lbl)}</text>`;
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
    12, pad.top + 4, CHART_H - pad.bottom - 4
  ).map(({ s, y }) => {
    const x0 = xs[xs.length - 1];
    const x1 = x0 + 8;
    const name = `${s.carNumber ? '#' + s.carNumber + ' ' : ''}${s.lastName}`;
    return `<line x1="${(x0 + 5).toFixed(1)}" y1="${toY(s.end).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}" class="chp-evo-leader"/>`
         + `<text x="${(x1 + 3).toFixed(1)}" y="${y.toFixed(1)}" class="chp-evo-endlabel" dominant-baseline="middle">`
         + `<tspan class="chp-evo-endlabel-name">${escHtml(name)}</tspan> <tspan class="chp-evo-endlabel-val">${fmt(s.end)}</tspan></text>`;
  }).join('');

  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" class="chp-evo-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Évolution des points du top ${data.series.length} sur le week-end">
    ${grid}
    ${xLabels}
    <line x1="${pad.left}" y1="${toY(0).toFixed(1)}" x2="${right}" y2="${toY(0).toFixed(1)}" class="chp-evo-axis"/>
    ${lines}
    ${endLabels}
    <line class="chp-evo-cursor" x1="0" y1="${pad.top}" x2="0" y2="${CHART_H - pad.bottom}" style="display:none"/>
  </svg>`;
}

/**
 * Légende + tableau détaillé (la « vue table » : chaque valeur du graphique
 * est aussi lisible ici, sans dépendre des couleurs).
 */
export function renderWeekendChartTable(data) {
  const head = data.labels.map((l, i) =>
    `<th class="center${i === 0 ? '' : ' chp-evo-th-phase'}">${escHtml(l)}</th>`).join('');

  const rows = data.series.map(s => {
    const cells = s.values.map((v, i) => {
      if (i === 0) return `<td class="center"><span class="chp-evo-cum">${fmt(v)}</span></td>`;
      const gain = s.gains[i - 1];
      return `<td class="center"><span class="chp-evo-cum">${fmt(v)}</span>`
           + `<span class="chp-evo-gain${gain > 0 ? ' is-pos' : ''}">${gain > 0 ? '+' : ''}${fmt(gain)}</span></td>`;
    }).join('');
    return `<tr>
      <td><span class="chp-evo-swatch" style="background:var(--chp-s${s.slot})"></span>
          ${escHtml(s.firstName)} <strong>${escHtml(s.lastName)}</strong>
          ${s.carNumber ? `<span class="tim-num">${escHtml(s.carNumber)}</span>` : ''}
          ${s.present ? '' : '<span class="chp-absent" title="Absent de ce meeting">absent</span>'}</td>
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
