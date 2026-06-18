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

/** Ligne de classement points : pos, n°, nom, pts. */
function ptsRow(r, pts) {
  const isP1 = r.position === 1;
  return `<div class="row ${isP1 ? 'p1' : ''}">
    ${isP1 ? '<span class="accent"></span>' : ''}
    <span class="pos">${r.position ?? '—'}</span>
    <span class="num">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="name">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="val">${pts}<small>pts</small></span></div>`;
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
  return `
  <div class="dash">
    <div class="dash-top">
      <span class="brand">RX<b>CHRONO</b></span>
      <span class="sep"></span>
      <span class="info"><span class="pin">📍</span><span>${escHtml(d.headerText || d.category || '')}</span></span>
      <span class="live"><span class="d"></span>LIVE</span>
    </div>
    <div class="dash-body">
      <div class="dpanel race">
        <div class="dhead"><span class="d"></span>Manche en cours<span class="sub">${escHtml(d.raceSub || '')}</span></div>
        <div class="body">${raceRowsHtml(d.race)}</div>
        <div class="foot">${(d.race || []).length} partants${fastest ? ` · meilleur chrono <span class="bl">${msToDisplay(fastest.ms)}</span>` : ''}</div>
      </div>
      <div class="dright">
        <div class="dpanel standings">
          <div class="dhead">Classement intermédiaire<span class="sub">${escHtml(d.interimSub || '')}</span></div>
          <div class="body">${(d.interim || []).length
            ? (d.interim).slice(0, 9).map(r => ptsRow(r, r.totalPoints ?? 0)).join('')
            : `<div class="empty">En attente…</div>`}</div>
        </div>
        <div class="dpanel standings">
          <div class="dhead">Championnat<span class="sub">${escHtml(d.champSub || '')}</span></div>
          <div class="body">${(d.champ || []).length
            ? (d.champ).slice(0, 8).map(r => ptsRow(r, r.grandTotal ?? 0)).join('')
            : `<div class="empty">En attente…</div>`}</div>
        </div>
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────
// SCÈNE : GRILLE DE DÉPART (matrice du règlement)
// ─────────────────────────────────────────────────────────

export function renderGrid(d) {
  const { lanes = 5, rows = 3, positions = {} } = d.layout || {};
  const slots = d.slots || [];
  const hasMatrix = Object.keys(positions).length > 0;   // QF/DF/FIN = grille en quinconce
  const title = hasMatrix ? 'Grille de départ' : 'Ordre de départ';

  let body;
  if (!slots.length) {
    body = '<div class="empty">Grille à venir…</div>';
  } else if (hasMatrix) {
    const byPos = {};
    slots.forEach(s => { byPos[s.pos] = s; });
    let cells = '';
    for (let r = 0; r < rows; r++) for (let c = 0; c < lanes; c++) {
      const p = positions[r + '-' + c];
      const occ = p && byPos[p];
      if (occ) cells += `<div class="car ${p === 1 ? 'p1' : ''} ${occ.edited ? 'edited' : ''}"
          style="grid-column:${c + 1};grid-row:${r + 1}">
        <span class="gp">${p}</span><span class="gn">${escHtml(String(occ.carNumber ?? ''))}</span>
        <span class="gl">${escHtml((occ.lastName || '').toUpperCase())}</span></div>`;
    }
    body = `<div class="grid-matrix" style="grid-template-columns:repeat(${lanes},248px)">${cells}</div>`;
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
  const rankRow = (r, i) => `<div class="cr rank ${i === 0 && !r.status ? 'p1' : ''} ${r.justAdded ? 'just-added' : ''}">
    <span class="p">${r.status ? '—' : (r.position ?? i + 1)}</span><span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="v ${r.status ? 'st' : ''}">${escHtml(r.value || '')}</span>
    <span class="pt">${r.points != null && r.points !== '' ? r.points + ' pt' : ''}</span></div>`;
  const deltaHtml = d => d == null ? '' : d === 'new' ? '<span class="delta nw">NEW</span>'
    : d > 0 ? `<span class="delta up">▲${d}</span>` : d < 0 ? `<span class="delta dn">▼${-d}</span>` : '';
  const ptsRow = (r, i) => `<div class="cr pts ${i === 0 ? 'p1' : ''} ${r.justAdded ? 'just-added' : ''} ${r.done === false ? 'pending' : ''}">
    <span class="p">${r.position ?? i + 1}</span><span class="n">${escHtml(String(r.carNumber ?? ''))}</span>
    <span class="nm">${escHtml((r.lastName || '').toUpperCase())}</span>
    <span class="dlt">${deltaHtml(r.delta)}</span>
    <span class="pt">${r.totalPoints ?? 0} pt</span></div>`;
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
