/* ═══════════════════════════════════════════════
   OBS-SCENES.JS — Rendu HTML des scènes overlay
   Fonctions pures : (données) → HTML. Le routeur (live.html)
   fournit les données issues de Firestore / obs-data.js.
═══════════════════════════════════════════════ */

import { escHtml, msToDisplay } from '../../js/utils.js';

const STATUS_LABEL = { DNS: 'DNS', DNF: 'DNF', DSQ: 'DSQ HC', DSQ_RACE: 'DSQ EC' };

// ─────────────────────────────────────────────────────────
// LIGNES
// ─────────────────────────────────────────────────────────

/** Ligne de course (live) : pos, n°, nom, chrono ou écart. */
function raceRow(r, pos, leaderMs) {
  const isP1 = pos === 1;
  let val, cls = 'val';
  if (r.ms && !r.status) {
    val = isP1 ? msToDisplay(r.ms) : '+' + ((r.ms - leaderMs) / 1000).toFixed(3);
    if (!isP1) cls += ' gap';
  } else {
    val = STATUS_LABEL[r.status] || '—'; cls += ' gap';
  }
  return `<div class="row ${isP1 ? 'p1' : ''}">
    ${isP1 ? '<span class="accent"></span>' : ''}
    <span class="pos">${r.ms && !r.status ? pos : '—'}</span>
    <span class="num">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="name">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="${cls}">${escHtml(val)}</span></div>`;
}

/** Ligne de classement points : pos, n°, nom, [évolution], pts [(+meeting)]. */
function ptsRow(r, pts) {
  const isP1 = r.position === 1;
  let evo = '<span class="evo"></span>';
  if (r.delta === 'new') evo = '<span class="evo nw">NEW</span>';
  else if (typeof r.delta === 'number' && r.delta > 0) evo = `<span class="evo up">▲${r.delta}</span>`;
  else if (typeof r.delta === 'number' && r.delta < 0) evo = `<span class="evo dn">▼${-r.delta}</span>`;
  const val = r.meetingPts != null
    ? `${pts} <span class="mpts">(+${r.meetingPts})</span>`
    : `${pts}<small>pts</small>`;
  return `<div class="row ${isP1 ? 'p1' : ''} ${r.finalist ? 'finalist' : ''}">
    ${isP1 ? '<span class="accent"></span>' : ''}
    <span class="pos">${r.position ?? '—'}</span>
    <span class="num">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="name">${escHtml((r.lastName || '').toUpperCase())}</span>
    ${evo}
    <span class="val">${val}</span></div>`;
}

function raceRowsHtml(results) {
  if (!results?.length) return `<div class="empty">En attente des résultats…</div>`;
  const leader = results.find(r => r.ms && !r.status);
  const leaderMs = leader?.ms ?? 0;
  let pos = 0;
  return results.map(r => raceRow(r, (r.ms && !r.status) ? ++pos : '—', leaderMs)).join('');
}

// ─────────────────────────────────────────────────────────
// BANDEAU PRÉDICTION (scénario d'objectif d'un pilote, bas d'écran)
//   Données : objet produit par obs-predict.js (buildPrediction).
// ─────────────────────────────────────────────────────────
export function predictBanner(p) {
  if (!p || !p.ok) return '';
  const tone = (p.pill && p.pill.tone) || 'neutral';
  const lines = (p.lines || []).map(l =>
    `<div class="pl"><span class="pi">${l.icon || '•'}</span><span>${escHtml(l.text)}</span></div>`).join('');
  return `
  <div class="pred-bar pred-${escHtml(p.state || '')}">
    <div class="pred-tag"><span class="pk">SCÉNARIO</span><span class="pv">${escHtml(p.scope || '')}</span></div>
    <div class="pred-drv">
      <div class="ptop"><span class="pn">${escHtml(String(p.driver?.carNumber ?? ''))}</span>
        <span class="pnm">${escHtml((p.driver?.lastName || '').toUpperCase())}</span></div>
      <span class="pobj">${escHtml(p.objectiveLabel || '')}</span>
      <span class="pmeta">${escHtml(p.meta || '')}</span>
    </div>
    <div class="pred-lines">${lines}</div>
    <div class="pred-pill pill-${tone}">${escHtml((p.pill && p.pill.text) || '')}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : DASHBOARD
// ─────────────────────────────────────────────────────────

export function renderDashboard(d) {
  const fastest = (d.race || []).find(r => r.ms && !r.status);
  const hasMeeting = Array.isArray(d.meeting);   // finale : colonne intermédiaire + (meeting/championnat)
  const threeCol   = hasMeeting || d.threeCol;   // QF/DF/FIN : dashboard sur 3 colonnes
  const empty = `<div class="empty">En attente…</div>`;

  const panel = (cls, title, sub, rows, live) => `
        <div class="dpanel ${cls}">
          <div class="dhead">${live ? '<span class="d"></span>' : ''}${title}${sub ? `<span class="sub">${escHtml(sub)}</span>` : ''}</div>
          <div class="body">${rows || empty}</div>${cls === 'race'
            ? `<div class="foot">${(d.race || []).length} partants${fastest ? ` · meilleur chrono <span class="bl">${msToDisplay(fastest.ms)}</span>` : ''}</div>` : ''}
        </div>`;
  const raceTitle    = d.raceTitle || (hasMeeting ? 'Finale en cours' : 'Manche en cours');
  const racePanel    = panel('race', raceTitle, d.raceSub, raceRowsHtml(d.race), true);
  // Panneau classement : lignes compactes (.dense) au-delà de 13 pilotes (jusqu'à 20).
  const stdPanel = (title, sub, items, valOf, max) => {
    const shown = (items || []).slice(0, max);
    return panel('standings' + (shown.length > 13 ? ' dense' : ''), title, sub,
      shown.map(r => ptsRow(r, valOf(r))).join(''));
  };
  const interimPanel = max => stdPanel('Classement intermédiaire', d.interimSub, d.interim, r => r.totalPoints ?? 0, max);
  const champPanel   = max => stdPanel('Championnat', d.champSub, d.champ, r => r.grandTotal ?? 0, max);
  const meetingPanel = max => stdPanel('Classement du meeting', d.meetingSub, d.meeting, r => r.total ?? 0, max);

  const header = `
    <div class="dash-top">
      <span class="brand">RX<b>CHRONO</b></span>
      <span class="sep"></span>
      <span class="info"><span class="pin">📍</span><span>${escHtml(d.headerText || d.category || '')}</span></span>
      <span class="live"><span class="d"></span>LIVE</span>
    </div>`;

  // FINALE : 3 colonnes — finale | intermédiaire | (meeting au-dessus du championnat)
  // QF/DF : 3 colonnes — course | intermédiaire | championnat (un panneau par colonne)
  // DÉFAUT (essais/manches) : 2 colonnes — manche | (intermédiaire + championnat)
  let body;
  if (hasMeeting) {
    body = `<div class="dash-body finale">
        ${racePanel}
        ${interimPanel(20)}
        ${meetingPanel(20)}
        ${champPanel(20)}
      </div>`;
  } else if (threeCol) {
    body = `<div class="dash-body cols3">
        ${racePanel}
        ${interimPanel(20)}
        ${champPanel(20)}
      </div>`;
  } else {
    body = `<div class="dash-body">
        ${racePanel}
        <div class="dright">${interimPanel(9)}${champPanel(8)}</div>
      </div>`;
  }

  // classe de placement vidéo : les tableaux réservent le coin (CSS .dash.vl-*)
  const vl = d.videoLayout && d.videoLayout !== 'none' ? ' vl-' + d.videoLayout : '';
  return `<div class="dash${vl}">${header}${body}${predictBanner(d.predict)}</div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : GRILLE DE DÉPART (matrice du règlement)
// ─────────────────────────────────────────────────────────

/** Matrice quinconce de la grille (QF/DF/FIN). `slots[].state` (qual|elim|gold|silver|bronze)
 *  colore l'encadrement (résultat de la phase). `colW` = largeur de colonne (px). */
function gridMatrixHtml(d, colW = 248) {
  const { lanes = 5, rows = 3, positions = {} } = d.layout || {};
  const byPos = {};
  (d.slots || []).forEach(s => { byPos[s.pos] = s; });
  const mirror = d.poleSide === 'droite';   // 1er virage à droite → pole à droite (cf. site)
  let cells = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < lanes; c++) {
    const p = positions[r + '-' + c];
    const occ = p && byPos[p];
    if (occ) {
      const col = (mirror ? (lanes - 1 - c) : c) + 1;
      cells += `<div class="car ${p === 1 ? 'p1' : ''} ${occ.edited ? 'edited' : ''} ${occ.state ? 'st-' + occ.state : ''}"
        style="grid-column:${col};grid-row:${r + 1}">
      <span class="gp">${p}</span><span class="gn">${escHtml(String(occ.carNumber ?? ''))}</span>
      <span class="gl">${escHtml((occ.lastName || '').toUpperCase())}</span>
      ${p === 1 ? '<span class="pole">POLE</span>' : ''}</div>`;
    }
  }
  return `<div class="grid-matrix" style="grid-template-columns:repeat(${lanes},${colW}px)">${cells}</div>`;
}

const PODIUM = { 1: 'gold', 2: 'silver', 3: 'bronze' };

/** État (couleur) d'une position selon la phase : DF = qualifié/éliminé, FIN = podium. */
function phaseState(phase, position, qualify) {
  if (position == null) return '';
  if (phase === 'FIN') return PODIUM[position] || '';
  if (phase === 'DF')  return position <= (qualify || 3) ? 'qual' : 'elim';
  return '';
}

export function renderGrid(d) {
  // DF / Finale en cours ou terminées → vue combinée grille + résultats
  if ((d.phase === 'DF' || d.phase === 'FIN') && Array.isArray(d.results)) return renderGridResults(d);

  const { positions = {} } = d.layout || {};
  const slots = d.slots || [];
  const hasMatrix = Object.keys(positions).length > 0;   // QF/DF/FIN = grille en quinconce
  const title = hasMatrix ? 'Grille de départ' : 'Ordre de départ';

  let body;
  if (!slots.length) {
    body = '<div class="empty">Grille à venir…</div>';
  } else if (hasMatrix) {
    body = gridMatrixHtml(d);
  } else {
    // Essais / manches : ordre de départ en liste ordonnée (2 colonnes si gros plateau)
    const cols = slots.length > 10 ? 2 : 1;
    body = `<div class="grid-list" style="grid-template-columns:repeat(${cols},minmax(440px,1fr))">
      ${slots.map(s => `<div class="g-li ${s.pos === 1 ? 'p1' : ''} ${s.edited ? 'edited' : ''}">
        <span class="gp">${s.pos}</span>
        <span class="gn">${escHtml(String(s.carNumber ?? ''))}</span>
        <span class="gl">${escHtml((s.lastName || '').toUpperCase())}</span></div>`).join('')}
    </div>`;
  }
  return `
  <div class="grid-wrap">
    <div class="head"><span class="h-cat">${title}</span><span class="h-sub">${escHtml(d.sessionLabel || '')}</span></div>
    ${d.headerText ? `<div class="grid-info"><span class="pin">📍</span><span>${escHtml(d.headerText)}</span></div>` : ''}
    <div class="track">${hasMatrix ? '<div class="dir">SENS COURSE</div>' : ''}${body}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : GRILLE + RÉSULTATS (DF / Finale) — grille en haut, résultats + points en bas
//   DF  : barres / encadrements bleus = qualifiés finale, rouges = éliminés
//   FIN : barres / encadrements or-argent-bronze = podium
// ─────────────────────────────────────────────────────────

export function renderGridResults(d) {
  const phase   = d.phase;
  const qualify = d.qualify || 3;
  const results = d.results || [];
  const isFin   = phase === 'FIN';

  // Résultat par pilote (n° ou driverId) → état coloré de l'encadrement sur la grille.
  const byKey = {};
  results.forEach(r => {
    if (r.driverId != null) byKey['d' + r.driverId] = r;
    byKey['n' + r.carNumber] = r;
  });
  const slots = (d.slots || []).map(s => {
    const res = (s.driverId != null && byKey['d' + s.driverId]) || byKey['n' + s.carNumber];
    let state = '';
    if (res) {
      if (phase === 'DF') state = (!res.status && res.position <= qualify) ? 'qual' : 'elim';
      else if (!res.status) state = phaseState(phase, res.position, qualify);   // finale : podium
    }
    return { ...s, state };
  });
  const matrix = (d.slots || []).length
    ? gridMatrixHtml({ ...d, slots }, 244)
    : '<div class="empty">Grille à venir…</div>';

  const resRow = r => {
    const st = r.status ? '' : phaseState(phase, r.position, qualify);
    // La barre bleue/podium sur le côté suffit à indiquer les qualifiés (pas de chip).
    return `<div class="gr-row ${st} ${r.status ? 'out' : ''}">
      <span class="bar"></span>
      <span class="p">${r.status ? '—' : (r.position ?? '')}</span>
      <span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
      <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span>
      <span class="v ${r.status ? 'st' : ''}">${escHtml(r.value || '')}</span>
      <span class="pt">${r.points != null && r.points !== '' ? '+' + r.points : ''}</span></div>`;
  };

  const dir    = d.poleSide === 'droite' ? 'SENS COURSE →' : '← SENS COURSE';
  const subRes = isFin ? 'Podium · points championnat' : `${qualify} qualifiés pour la finale · points championnat`;

  return `
  <div class="gr-combo">
    <div class="dash-top">
      <span class="brand">RX<b>CHRONO</b></span><span class="sep"></span>
      <span class="info"><span class="pin">📍</span><span>${escHtml(d.headerText || d.sessionLabel || '')}</span></span>
      <span class="live"><span class="d"></span>LIVE</span>
    </div>
    <div class="gr-body">
      <div class="gr-grid">
        <div class="gr-ch">Grille de départ<span class="sub">${escHtml(d.sessionLabel || '')}</span></div>
        <div class="gr-track"><div class="dir">${dir}</div>${matrix}</div>
      </div>
      <div class="gr-res">
        <div class="gr-ch alt">Résultats &amp; points<span class="sub">${subRes}</span></div>
        <div class="gr-rows">${results.length
          ? results.map(resRow).join('')
          : '<div class="empty">En attente des résultats…</div>'}</div>
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : À SUIVRE (bandeau bas)
// ─────────────────────────────────────────────────────────

export function renderNextHeat(d) {
  const list = (d.slots || []).slice(0, 8).map(s => `
    <div class="chip"><span class="n">${escHtml(String(s.carNumber ?? ''))}</span>
      <span class="nm">${escHtml((s.lastName || '').toUpperCase())}</span>
      <span class="pp">P${s.pos}</span></div>`).join('');
  return `
  <div class="lower">
    <div class="lower-inner">
      <div class="badge"><span class="k">À SUIVRE</span><span class="v">${escHtml(d.sessionLabel || '')}</span></div>
      <div class="list">${list || '<span class="empty">Série à venir…</span>'}</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : ENTRE DEUX MANCHES
// ─────────────────────────────────────────────────────────

/** Texte "mm:ss" du temps restant jusqu'à `end` (timestamp ms). */
export function countdownText(end) {
  const t = Math.max(0, Math.round(((end || 0) - Date.now()) / 1000));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

export function renderIntermission(d) {
  const hasCd = d.countdownEnd && d.countdownEnd > Date.now();
  const next  = d.nextText || d.headerText || d.sessionLabel;
  return `
  <div class="inter">
    <div class="big">DE <b>RETOUR</b></div>
    <div class="tagline">${hasCd ? 'dans' : 'dans un instant'}</div>
    ${hasCd ? `<div class="cd-big" id="ov-cd">${countdownText(d.countdownEnd)}</div>` : ''}
    ${next ? `<div class="next"><span class="k">À SUIVRE</span><span class="v">${escHtml(next)}</span></div>` : ''}
    ${d.social ? `<div class="social">${escHtml(d.social)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : FIN DE STREAM (outro + compte à rebours pour couper proprement)
// ─────────────────────────────────────────────────────────

export function renderEnding(d) {
  const hasCd = d.countdownEnd && d.countdownEnd > Date.now();
  return `
  <div class="inter ending">
    <div class="big">MERCI <b>À TOUS</b></div>
    <div class="tagline">Fin du direct — à très vite</div>
    ${hasCd ? `<div class="cd-big" id="ov-cd">${countdownText(d.countdownEnd)}</div>` : ''}
    ${d.nextText ? `<div class="next"><span class="k">PROCHAINEMENT</span><span class="v">${escHtml(d.nextText)}</span></div>` : ''}
    ${d.social ? `<div class="social">${escHtml(d.social)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : SESSION (essais / manche) — à passer | classement | intermédiaire
// ─────────────────────────────────────────────────────────

/** Graphique d'évolution (SVG) : une courbe par pilote sur les manches.
 *  mode 'places' = bump-chart (place 1 en haut) ; mode 'points' = points cumulés.
 *  drivers = [{ carNumber, lastName, pts:[cumul M1, M2, …] }]. Top 8 (place finale) en couleur, reste en gris. */
function evolutionSvg(drivers, series, mode) {
  const N = series.length;
  if (!drivers.length || N < 2) return '<div class="empty">Graphique disponible après 2 manches…</div>';
  const W = 1000, H = 750, mL = 50, mR = 116, mT = 24, mB = 40;
  const pw = W - mL - mR, ph = H - mT - mB, nD = drivers.length;
  const xAt = i => mL + i / (N - 1) * pw;

  // place de chaque pilote à chaque manche (tri par points cumulés décroissants)
  const posOf = drivers.map(() => []);
  for (let i = 0; i < N; i++) {
    drivers.map((d, idx) => ({ idx, v: d.pts[i] ?? 0 })).sort((a, b) => b.v - a.v)
      .forEach((o, r) => { posOf[o.idx][i] = r + 1; });
  }
  const maxPts = Math.max(1, ...drivers.flatMap(d => d.pts.map(v => v ?? 0)));
  const yAt = (idx, i) => mode === 'points'
    ? mT + ph - ((drivers[idx].pts[i] ?? 0) / maxPts) * ph
    : mT + (nD <= 1 ? 0 : (posOf[idx][i] - 1) / (nD - 1) * ph);

  // top 8 selon la place finale → couleurs ; le reste en gris
  const order = drivers.map((d, idx) => idx).sort((a, b) => posOf[a][N - 1] - posOf[b][N - 1]);
  const rankOf = {}; order.forEach((idx, r) => { rankOf[idx] = r; });
  const PAL = ['#ff5500', '#39d98a', '#38a0ff', '#ffcc33', '#c084fc', '#ff7ab8', '#4dd0e1', '#f1f5f9'];
  const isTop = idx => rankOf[idx] < 8;

  // gridlines + repères d'axes
  let grid = '';
  if (mode === 'points') {
    const step = maxPts <= 60 ? 10 : maxPts <= 160 ? 25 : 50;
    for (let v = 0; v <= maxPts; v += step) { const yy = mT + ph - (v / maxPts) * ph;
      grid += `<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${mL + pw}" y2="${yy.toFixed(1)}" class="gl"/><text x="${mL - 8}" y="${(yy + 5).toFixed(1)}" class="gy">${v}</text>`; }
  } else {
    [1, 5, 10, 15, 20, 25].filter(p => p <= nD).forEach(p => { const yy = mT + (nD <= 1 ? 0 : (p - 1) / (nD - 1) * ph);
      grid += `<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${mL + pw}" y2="${yy.toFixed(1)}" class="gl"/><text x="${mL - 8}" y="${(yy + 5).toFixed(1)}" class="gy">${p}</text>`; });
  }
  let xax = ''; series.forEach((s, i) => { xax += `<text x="${xAt(i).toFixed(1)}" y="${H - 12}" class="gx">${escHtml(s)}</text>`; });

  const polyline = idx => {
    const pts = series.map((_, i) => `${xAt(i).toFixed(1)},${yAt(idx, i).toFixed(1)}`).join(' ');
    if (!isTop(idx)) return `<polyline points="${pts}" class="ev-grey"/>`;
    const c = PAL[rankOf[idx]];
    const dots = series.map((_, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(idx, i).toFixed(1)}" r="4.5" fill="${c}"/>`).join('');
    const lx = xAt(N - 1) + 12, ly = yAt(idx, N - 1) + 5;
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>${dots}<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="ev-lab" fill="${c}">${escHtml(String(drivers[idx].carNumber ?? ''))}</text>`;
  };
  const greys = drivers.map((_, idx) => isTop(idx) ? '' : polyline(idx)).join('');
  const tops  = order.filter(isTop).map(polyline).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="ev-svg">${grid}${xax}${greys}${tops}</svg>`;
}

export function renderSession(d) {
  const todoRow = r => `<div class="cr todo">
    <span class="p">${r.pos}</span><span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span></div>`;
  const rankRow = (r, i) => `<div class="cr rank ${i === 0 && !r.status ? 'p1' : ''} ${r.justAdded ? 'just-added' : ''} ${r.justFlashed ? 'just-flashed' : ''}">
    <span class="p">${r.status ? '—' : (r.position ?? i + 1)}</span><span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="v ${r.status ? 'st' : ''}">${escHtml(r.value || '')}</span>
    <span class="pt">${r.points != null && r.points !== '' ? r.points + ' pt' : ''}</span></div>`;
  const deltaHtml = d => d == null ? '' : d === 'new' ? '<span class="delta nw">NEW</span>'
    : d > 0 ? `<span class="delta up">▲${d}</span>` : d < 0 ? `<span class="delta dn">▼${-d}</span>` : '';
  const ptsRow = (r, i) => `<div class="cr pts ${i === 0 ? 'p1' : ''} ${r.justAdded ? 'just-added' : ''} ${r.justFlashed ? 'just-flashed' : ''} ${r.done === false ? 'pending' : ''}">
    <span class="p">${r.position ?? i + 1}</span><span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="dlt">${deltaHtml(r.delta)}</span>
    <span class="pt">${r.totalPoints ?? 0}${r.champPts != null ? ` <span class="cpt">(+${r.champPts})</span>` : ' pt'}</span></div>`;
  const col = (title, sub, rows, builder, alt, live) => `<div class="col">
    <div class="ch ${alt ? 'alt' : ''}">${live ? '<span class="d"></span>' : ''}${title}${sub ? `<span class="sub">${sub}</span>` : ''}</div>
    <div class="cb">${rows.length ? rows.map(builder).join('') : '<div class="empty">—</div>'}</div></div>`;

  const header = `<div class="dash-top">
    <span class="brand">RX<b>CHRONO</b></span><span class="sep"></span>
    <span class="info"><span class="pin">📍</span><span>${escHtml(d.headerText || d.sessionLabel || '')}</span></span>
    <span class="live"><span class="d"></span>LIVE</span></div>`;

  const pb = predictBanner(d.predict);
  const vl = d.videoLayout && d.videoLayout !== 'none' ? ' vl-' + d.videoLayout : '';

  if (d.mode === 'ec') {
    return `<div class="dash${vl}">${header}<div class="sess-body sess-ec">
      ${col('À passer', 'ordre inverse championnat', d.todo || [], todoRow, true, true)}
      ${col('Classement essais', '', d.rank || [], rankRow, false, false)}
    </div>${pb}</div>`;
  }
  // Manche terminée : 2 colonnes (manche + intermédiaire) à gauche + graphique d'évolution à droite
  if (d.graph) {
    const gm = d.graph.mode === 'points' ? 'points' : 'places';
    return `<div class="dash${vl}">${header}<div class="sess-body sess-graph">
      ${col(d.sessionLabel || 'Classement manche', '', d.rank || [], rankRow, false, false)}
      ${col('Classement intermédiaire', '', d.interim || [], ptsRow, true, false)}
      <div class="col">
        <div class="ch alt">Évolution · ${gm === 'points' ? 'points' : 'places'}<span class="sub">classement intermédiaire</span></div>
        <div class="cb graph-cb">${evolutionSvg(d.graph.drivers || [], d.graph.series || [], gm)}</div>
      </div>
    </div>${pb}</div>`;
  }
  // Manche : 3 colonnes dès qu'un intermédiaire est fourni (manche ≥ 2),
  // sinon 2 colonnes (manche 1 : l'intermédiaire n'a pas encore de sens).
  const showInterim = Array.isArray(d.interim);
  return `<div class="dash${vl}">${header}<div class="sess-body ${showInterim ? 'sess-mq' : 'sess-mq2'}">
    ${col('À passer', '', d.todo || [], todoRow, true, true)}
    ${col(d.sessionLabel || 'Classement manche', '', d.rank || [], rankRow, false, false)}
    ${showInterim ? col('Classement intermédiaire', '', d.interim, ptsRow, true, false) : ''}
  </div>${pb}</div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : FICHE PILOTE / DUEL
//   1 pilote → fiche ; 2 pilotes (même catégorie) → duel comparatif.
//   data.drivers = [{ carNumber, lastName, champPos, champPts, champGap,
//                     meetPos, bestMs, wins, forme:[{manche,pos,status}] }]
// ─────────────────────────────────────────────────────────

function ficheTagline(dr) {
  if (dr.champPos === 1) return '🏆 Leader du championnat';
  if (dr.champGap != null && dr.champGap > 0) return `🎯 À ${dr.champGap} pts du leader`;
  return dr.champPos ? `P${dr.champPos} au championnat` : '';
}
const fPos = p => (p != null ? 'P' + p : '—');
const fChrono = ms => (ms != null ? msToDisplay(ms) : '—');
function ficheForme(forme) {
  if (!forme || !forme.length) return '';
  return `<div class="fi-forme"><span class="fi-fk">Forme</span>${forme.map(f =>
    `<div class="fi-fchip ${f.pos === 1 ? 'win' : ''}"><b>${f.status ? escHtml(f.status) : fPos(f.pos)}</b><span>M${f.manche}</span></div>`).join('')}</div>`;
}
function ficheHead(headerText) {
  return `<div class="dash-top">
    <span class="brand">RX<b>CHRONO</b></span><span class="sep"></span>
    <span class="info"><span class="pin">📍</span><span>${escHtml(headerText || '')}</span></span>
    <span class="live"><span class="d"></span>LIVE</span></div>`;
}
function ficheHero(dr) {
  return `<span class="fi-num">${escHtml(String(dr.carNumber ?? ''))}</span>
    <span class="fi-name">${escHtml((dr.lastName || '').toUpperCase())}</span>`;
}

export function renderFiche(d) {
  const drivers = (d.drivers || []).filter(Boolean);
  const header = ficheHead(d.headerText);
  if (!drivers.length) {
    return `<div class="dash">${header}<div class="fi-body"><div class="empty">Sélectionne un pilote en régie…</div></div></div>`;
  }

  // DUEL (2 pilotes)
  if (drivers.length >= 2) {
    const [a, b] = drivers;
    const cmp = (label, la, ra, betterLow) => {
      const na = parseFloat(la), nb = parseFloat(ra);
      let win = '';
      if (la !== '—' && ra !== '—' && !isNaN(na) && !isNaN(nb) && na !== nb) win = (betterLow ? na < nb : na > nb) ? 'l' : 'r';
      return `<div class="fi-crow"><span class="cl ${win === 'l' ? 'win' : ''}">${escHtml(la)}</span>
        <span class="ck">${label}</span><span class="cr ${win === 'r' ? 'win' : ''}">${escHtml(ra)}</span></div>`;
    };
    return `<div class="dash">${header}<div class="fi-body duel">
      <div class="fi-duel">
        <div class="fi-side l"><div class="fi-dtop">${ficheHero(a)}</div><div class="fi-tag">${escHtml(ficheTagline(a))}</div></div>
        <div class="fi-vs"><b>VS</b><span>${escHtml(d.category || 'DUEL')}</span></div>
        <div class="fi-side r"><div class="fi-dtop">${ficheHero(b)}</div><div class="fi-tag alt">${escHtml(ficheTagline(b))}</div></div>
      </div>
      <div class="fi-cmp">
        ${cmp('Championnat', fPos(a.champPos), fPos(b.champPos), true)}
        ${cmp('Points', String(a.champPts ?? '—'), String(b.champPts ?? '—'), false)}
        ${cmp('Épreuve', fPos(a.meetPos), fPos(b.meetPos), true)}
        ${cmp('Meilleur chrono', fChrono(a.bestMs), fChrono(b.bestMs), true)}
        ${cmp('Victoires manches', String(a.wins ?? 0), String(b.wins ?? 0), false)}
      </div>
    </div></div>`;
  }

  // FICHE (1 pilote)
  const dr = drivers[0];
  return `<div class="dash">${header}<div class="fi-body">
    <div class="fi-card">
      <div class="fi-top">${ficheHero(dr)}<span class="fi-cat">${escHtml(d.category || '')}</span></div>
      <div class="fi-tag">${escHtml(ficheTagline(dr))}</div>
      <div class="fi-stats">
        <div class="fi-stat ${dr.champPos === 1 ? 'p1' : ''}"><div class="k">Championnat</div><div class="v">${fPos(dr.champPos)} <small>${dr.champPts ?? 0} pts</small></div></div>
        <div class="fi-stat"><div class="k">Épreuve</div><div class="v">${fPos(dr.meetPos)}</div></div>
        <div class="fi-stat"><div class="k">Meilleur chrono</div><div class="v sm">${fChrono(dr.bestMs)}</div></div>
      </div>
      ${ficheForme(dr.forme)}
    </div>
  </div></div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : PRONOSTIC (résultats des votes spectateurs)
//   Vote OUVERT   → appel à voter, AUCUN chiffre (pas d'influence).
//   Vote FERMÉ    → barres de résultats (tendances figées à la fermeture).
//   RÉVÉLÉ        → gagnant réel surligné en vert.
//   Données : { headerText, category, voteUrl, pronostic }
// ─────────────────────────────────────────────────────────
function qrCells() {
  // QR décoratif (le vrai QR = lien scope spectateur, à câbler). Motif fixe.
  const pat = '1101011100101101001011010110010111010001101010011';
  let cells = '';
  for (let i = 0; i < 49; i++) cells += pat[i % pat.length] === '1' ? '<b></b>' : '<i></i>';
  return `<div class="po-qrbox">${cells}</div>`;
}

export function renderPronostic(d) {
  const header = ficheHead(d.headerText || d.category || '');
  const p = d.pronostic;
  if (!p) return `<div class="dash">${header}<div class="po-body"><div class="empty">Aucun pronostic sélectionné en régie…</div></div></div>`;
  const opts = Array.isArray(p.options) ? p.options : [];
  // densité : réduit police + hauteur des lignes selon le nombre de pilotes (EC = beaucoup)
  const n = opts.length;
  const dens = n <= 8 ? 'po-d1' : n <= 14 ? 'po-d2' : n <= 20 ? 'po-d3' : 'po-d4';
  const kick = `<div class="po-kick"><span class="po-vt">PRONOSTIC</span><span>Le pronostic des spectateurs</span></div>`;
  const q    = `<div class="po-q">${escHtml(p.question || '')}</div>`;

  // ── Vote ouvert (ou brouillon) : appel à voter, pas de chiffres ──
  if (p.status === 'open' || p.status === 'draft') {
    const grid = opts.map(o =>
      `<div class="po-opt"><span class="po-onum">${escHtml(String(o.num ?? ''))}</span><span class="po-onm">${escHtml((o.name || '').toUpperCase())}</span></div>`).join('');
    return `<div class="dash">${header}<div class="po-body po-open ${dens}">
      ${kick}${q}
      <div class="po-grid">${grid || '<div class="empty">—</div>'}</div>
      <div class="po-cta">
        ${d.qrDataUrl ? `<img class="po-qrimg" src="${escHtml(d.qrDataUrl)}" alt="QR vote">` : qrCells()}
        <div class="po-ctatxt"><b>Scanne &amp; vote&nbsp;!</b><span>${escHtml(d.voteUrl || 'Rejoins le mode spectateur RX Chrono')}</span></div>
      </div>
    </div></div>`;
  }

  // ── Vote fermé / révélé : barres de résultats ──
  const counts   = p.tally || {};
  const total    = p.totalVotes || opts.reduce((s, o) => s + (counts[o.driverId] || 0), 0);
  const revealed = p.status === 'revealed';
  const rows = opts.map(o => ({ o, c: counts[o.driverId] || 0 })).sort((a, b) => b.c - a.c);
  const maxC = rows.length ? rows[0].c : 0;
  const bars = rows.map(r => {
    const pct  = total ? Math.round(r.c / total * 100) : 0;
    const win  = revealed && p.correctDriverId === r.o.driverId;
    const lead = !revealed && r.c === maxC && maxC > 0;
    return `<div class="po-bar ${win ? 'win' : ''} ${lead ? 'lead' : ''}"><span class="po-f" style="width:${pct}%"></span>
      <span class="po-num">${escHtml(String(r.o.num ?? ''))}</span>
      <span class="po-nm">${escHtml((r.o.name || '').toUpperCase())}${win ? '<span class="po-ok">✓ gagnant</span>' : ''}</span>
      <span class="po-cnt">${r.c} vote${r.c > 1 ? 's' : ''}</span>
      <span class="po-pct">${pct}%</span></div>`;
  }).join('');
  return `<div class="dash">${header}<div class="po-body ${dens}">
    ${kick}${q}
    <div class="po-bars">${bars || '<div class="empty">Aucun vote enregistré.</div>'}</div>
    <div class="po-foot"><span class="po-tot">🗳️ <b>${total}</b> vote${total > 1 ? 's' : ''}</span>
      <span class="po-res ${revealed ? '' : 'muted'}">${revealed ? 'Résultat officiel' : 'Votes clos'}</span>
      ${d.qrDataUrl ? `<span class="po-footqr"><img src="${escHtml(d.qrDataUrl)}" alt="QR"><span>Scanne&nbsp;&amp;&nbsp;joue</span></span>` : ''}</div>
  </div></div>`;
}

// ─────────────────────────────────────────────────────────
// AIGUILLAGE
// ─────────────────────────────────────────────────────────

export function renderScene(scene, data) {
  switch (scene) {
    case 'session':      return renderSession(data);
    case 'grid':         return renderGrid(data);
    case 'next-heat':    return renderNextHeat(data);
    case 'intermission': return renderIntermission(data);
    case 'ending':       return renderEnding(data);
    case 'fiche':        return renderFiche(data);
    case 'pronostic':    return renderPronostic(data);
    case 'dashboard':
    default:             return renderDashboard(data);
  }
}
