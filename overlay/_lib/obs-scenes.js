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
  const meetingPanel = ()  => stdPanel('Classement du meeting', d.meetingSub, d.meeting, r => r.total ?? 0, 6);

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
        <div class="dright">${meetingPanel()}${champPanel(7)}</div>
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

  return `<div class="dash">${header}${body}</div>`;
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
// SCÈNE : SESSION (essais / manche) — à passer | classement | intermédiaire
// ─────────────────────────────────────────────────────────

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

  if (d.mode === 'ec') {
    return `<div class="dash">${header}<div class="sess-body sess-ec">
      ${col('À passer', 'ordre inverse championnat', d.todo || [], todoRow, true, true)}
      ${col('Classement essais', '', d.rank || [], rankRow, false, false)}
    </div></div>`;
  }
  return `<div class="dash">${header}<div class="sess-body sess-mq">
    ${col('À passer', '', d.todo || [], todoRow, true, true)}
    ${col(d.sessionLabel || 'Classement manche', '', d.rank || [], rankRow, false, false)}
    ${col('Classement intermédiaire', '', d.interim || [], ptsRow, true, false)}
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
    case 'dashboard':
    default:             return renderDashboard(data);
  }
}
