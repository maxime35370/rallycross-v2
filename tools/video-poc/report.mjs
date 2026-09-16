/* ═══════════════════════════════════════════════
   REPORT.MJS — Rapport HTML autonome et INTERACTIF.

   Ce fichier ne calcule pas de rappel : il fabrique l'outil qui permet à un
   humain de l'établir honnêtement. Le principe est simple et volontairement
   contraignant :

     • le banc ne sait pas ce qu'est une voiture ratée — seul l'œil le sait ;
     • une voiture ratée doit être POINTÉE sur l'image, pas comptée de tête ;
     • chaque échec porte une CAUSE, sinon le POC donne un chiffre sans
       enseignement.

   L'état est conservé dans le navigateur (localStorage) et exportable en
   JSON : on peut fermer la page et reprendre le comptage plus tard.
═══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Causes d'échec — la liste demandée, figée pour que les tags soient comparables. */
const CAUSES = [
  ['distance',   'Distance'],
  ['poussiere',  'Poussière'],
  ['occlusion',  'Partiellement cachée'],
  ['chevauch',   'Chevauchement'],
  ['angle',      'Angle caméra'],
  ['flou',       'Flou / mouvement'],
  ['taille',     'Trop petite'],
  ['autre',      'Autre'],
];

export function buildReport({ summary, results, imgDir }) {
  const cards = results.map((r, i) => {
    const ext = extname(r.file).toLowerCase();
    const b64 = readFileSync(join(imgDir, r.file)).toString('base64');
    const src = `data:${MIME[ext] || 'image/jpeg'};base64,${b64}`;

    const boxes = r.boxes.map((b, j) => `
      <g class="bx" data-img="${i}" data-box="${j}">
        <rect x="${(100 * b.x1 / r.width).toFixed(3)}%" y="${(100 * b.y1 / r.height).toFixed(3)}%"
              width="${(100 * (b.x2 - b.x1) / r.width).toFixed(3)}%"
              height="${(100 * (b.y2 - b.y1) / r.height).toFixed(3)}%"/>
        <text x="${(100 * b.x1 / r.width).toFixed(3)}%" y="${(100 * b.y1 / r.height).toFixed(3)}%" dy="-6">
          ${esc(b.className)} ${(b.score * 100).toFixed(0)}% · ${b.areaPct}%
        </text>
      </g>`).join('');

    const m = r.meta || {};
    const metaLine = [m.start && `départ : ${m.start}`, m.angle && `angle : ${m.angle}`,
                      Array.isArray(m.difficulte) && m.difficulte.length && m.difficulte.join(', ')]
      .filter(Boolean).map(esc).join(' · ');

    return `
    <section class="card" data-img="${i}">
      <header>
        <h3>${esc(r.file)}</h3>
        <div class="meta">${r.width}×${r.height} · ${r.boxes.length} détections · ${r.inferenceMs} ms${metaLine ? ' · ' + metaLine : ''}</div>
      </header>
      <div class="stage" data-img="${i}">
        <img src="${src}" alt="${esc(r.file)}">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="ov">${boxes}</svg>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="marks" data-img="${i}"></svg>
      </div>
      <div class="tally" data-img="${i}"></div>
      <div class="misslist" data-img="${i}"></div>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>POC YOLOX — ${esc(summary.model)}</title>
<style>
:root{--bg:#0d0f14;--bg2:#161a22;--bg3:#1e2430;--tx:#e8ecf3;--tx2:#9aa5b8;--tx3:#6b7688;
      --ac:#ff5500;--ok:#00dc78;--ko:#ff5a5a;--wa:#ffaa00;--bd:#2a3140;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);
     font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:1.5rem;margin:0 0 4px}
h1 span{color:var(--ac)}
.sub{color:var(--tx2);font-size:.9rem;margin-bottom:22px}
.panel{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:18px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px}
.kpi{background:var(--bg3);border-radius:9px;padding:12px 14px}
.kpi .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--tx3)}
.kpi .v{font-size:1.5rem;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums}
.kpi .v small{font-size:.8rem;color:var(--tx2);font-weight:400}
.verdict{margin-top:16px;padding:13px 16px;border-radius:9px;font-weight:600;border:1px solid}
.v-go{background:rgba(0,220,120,.1);border-color:var(--ok);color:var(--ok)}
.v-mid{background:rgba(255,170,0,.1);border-color:var(--wa);color:var(--wa)}
.v-no{background:rgba(255,90,90,.1);border-color:var(--ko);color:var(--ko)}
.v-wait{background:var(--bg3);border-color:var(--bd);color:var(--tx2);font-weight:400}
.how{font-size:.88rem;color:var(--tx2)}
.how b{color:var(--tx)}
.how kbd{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:1px 6px;font-size:.82rem}
.card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;overflow:hidden;margin-bottom:22px}
.card header{padding:13px 16px;border-bottom:1px solid var(--bd)}
.card h3{margin:0;font-size:1rem}
.card .meta{color:var(--tx3);font-size:.82rem;margin-top:2px}
.stage{position:relative;line-height:0;background:#000;cursor:crosshair}
.stage img{width:100%;height:auto;display:block}
.ov,.marks{position:absolute;inset:0;width:100%;height:100%}
.ov rect{fill:none;stroke:var(--ok);stroke-width:.35;vector-effect:non-scaling-stroke}
.ov text{fill:var(--ok);font-size:2.6px;font-weight:600;paint-order:stroke;
         stroke:rgba(0,0,0,.8);stroke-width:.7px}
.bx{cursor:pointer}
.bx.fp rect{stroke:var(--ko);stroke-dasharray:2 1.4}
.bx.fp text{fill:var(--ko)}
.bx.dup rect{stroke:var(--wa);stroke-dasharray:1 1}
.bx.dup text{fill:var(--wa)}
.marks{pointer-events:none}
.marks circle{fill:rgba(255,170,0,.35);stroke:var(--wa);stroke-width:.4;vector-effect:non-scaling-stroke}
.marks text{fill:#000;font-size:2.4px;font-weight:800;text-anchor:middle}
.tally{padding:11px 16px;border-top:1px solid var(--bd);font-size:.86rem;
       display:flex;gap:20px;flex-wrap:wrap;font-variant-numeric:tabular-nums}
.tally b{font-weight:650}
.misslist{padding:0 16px 14px}
.miss{background:var(--bg3);border-radius:8px;padding:9px 12px;margin-top:9px;font-size:.84rem}
.miss .hd{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.miss .num{background:var(--wa);color:#000;font-weight:800;border-radius:50%;
           width:20px;height:20px;display:grid;place-items:center;font-size:.74rem}
.tags{display:flex;gap:6px;flex-wrap:wrap}
.tag{border:1px solid var(--bd);background:var(--bg2);color:var(--tx2);border-radius:20px;
     padding:3px 11px;font-size:.76rem;cursor:pointer;user-select:none}
.tag.on{background:var(--ac);border-color:var(--ac);color:#fff}
.btn{background:var(--bg3);border:1px solid var(--bd);color:var(--tx);border-radius:7px;
     padding:7px 14px;font-size:.85rem;cursor:pointer}
.btn:hover{border-color:var(--ac)}
.btn.x{color:var(--ko);border:none;background:none;padding:2px 6px;margin-left:auto}
.bar{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}
.causes{margin-top:14px;font-size:.86rem}
.causes .row{display:flex;align-items:center;gap:10px;margin-top:5px}
.causes .lbl{width:170px;color:var(--tx2)}
.causes .track{flex:1;height:8px;background:var(--bg3);border-radius:4px;overflow:hidden}
.causes .fill{height:100%;background:var(--ac)}
.causes .n{width:34px;text-align:right;font-variant-numeric:tabular-nums;color:var(--tx2)}
</style></head><body><div class="wrap">

<h1>POC détection — <span>${esc(summary.model)}</span></h1>
<div class="sub">${summary.images} images · seuil ${summary.scoreThreshold} · NMS ${summary.iouThreshold}
 · canaux ${esc(summary.channelOrder)} · classes ${esc(Array.isArray(summary.classes) ? summary.classes.join('/') : summary.classes)}
 · ${esc(summary.runtime)}</div>

<div class="panel">
  <div class="grid" id="kpis"></div>
  <div class="verdict v-wait" id="verdict">Vérité terrain à établir — pointe les voitures ratées ci-dessous.</div>
  <div class="causes" id="causes"></div>
  <div class="bar">
    <button class="btn" id="exp">⬇ Exporter le relevé (JSON)</button>
    <button class="btn" id="rst">↺ Tout effacer</button>
  </div>
</div>

<div class="panel how">
  <b>Comment relever</b> — une voiture compte comme <b>détectable</b> lorsque
  <b>plus de la moitié de sa carrosserie est visible</b>. Une voiture noyée dans la poussière ou
  masquée à 90 % n'est pas un échec du détecteur et ne doit pas être pointée.<br><br>
  • <kbd>clic sur l'image</kbd> → marque une <b style="color:var(--wa)">voiture ratée</b>, à l'endroit où elle se trouve<br>
  • <kbd>clic sur un rectangle</kbd> → fait tourner son état :
    <b style="color:var(--ok)">correcte</b> → <b style="color:var(--ko)">faux positif</b> →
    <b style="color:var(--wa)">doublon</b> → correcte<br>
  • pour chaque voiture ratée, coche <b>la ou les causes</b> — c'est ce qui donne au POC sa valeur
</div>

${cards}

<script>
const DATA = ${JSON.stringify(results.map(r => ({ file: r.file, boxes: r.boxes.length })))};
const CAUSES = ${JSON.stringify(CAUSES)};
const KEY = 'rx_poc_${esc(summary.model)}';

let S = { boxState: {}, misses: {} };
try { const raw = localStorage.getItem(KEY); if (raw) S = JSON.parse(raw); } catch (e) {}
S.boxState ||= {}; S.misses ||= {};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };

// ── Clic sur une boîte : correcte → faux positif → doublon → correcte ──
document.querySelectorAll('.bx').forEach(g => {
  g.addEventListener('click', ev => {
    ev.stopPropagation();
    const k = g.dataset.img + ':' + g.dataset.box;
    S.boxState[k] = { undefined: 'fp', ok: 'fp', fp: 'dup', dup: 'ok' }[S.boxState[k] || 'ok'];
    save(); render();
  });
});

// ── Clic sur l'image : nouvelle voiture ratée ──
document.querySelectorAll('.stage').forEach(st => {
  st.addEventListener('click', ev => {
    const i = st.dataset.img;
    const r = st.getBoundingClientRect();
    (S.misses[i] ||= []).push({
      x: +(100 * (ev.clientX - r.left) / r.width).toFixed(2),
      y: +(100 * (ev.clientY - r.top) / r.height).toFixed(2),
      causes: [],
    });
    save(); render();
  });
});

function stats() {
  let tp = 0, fp = 0, dup = 0, fn = 0;
  const causeCount = Object.fromEntries(CAUSES.map(([id]) => [id, 0]));
  DATA.forEach((d, i) => {
    for (let j = 0; j < d.boxes; j++) {
      const s = S.boxState[i + ':' + j] || 'ok';
      if (s === 'ok') tp++; else if (s === 'fp') fp++; else dup++;
    }
    (S.misses[i] || []).forEach(m => {
      fn++;
      (m.causes || []).forEach(c => { if (c in causeCount) causeCount[c]++; });
    });
  });
  const detectable = tp + fn;
  return {
    tp, fp, dup, fn, detectable, causeCount,
    recall:    detectable ? tp / detectable : null,
    precision: (tp + fp + dup) ? tp / (tp + fp + dup) : null,
  };
}

function render() {
  // boîtes
  document.querySelectorAll('.bx').forEach(g => {
    const s = S.boxState[g.dataset.img + ':' + g.dataset.box] || 'ok';
    g.classList.toggle('fp', s === 'fp');
    g.classList.toggle('dup', s === 'dup');
  });
  // marqueurs + listes
  document.querySelectorAll('.marks').forEach(svg => {
    const i = svg.dataset.img;
    svg.innerHTML = (S.misses[i] || []).map((m, n) =>
      '<circle cx="' + m.x + '" cy="' + m.y + '" r="2.2"/>' +
      '<text x="' + m.x + '" y="' + (m.y + 0.9) + '">' + (n + 1) + '</text>').join('');
  });
  document.querySelectorAll('.misslist').forEach(box => {
    const i = box.dataset.img;
    box.innerHTML = (S.misses[i] || []).map((m, n) =>
      '<div class="miss"><div class="hd"><span class="num">' + (n + 1) + '</span>' +
      '<span>voiture ratée — cause :</span>' +
      '<button class="btn x" data-del="' + i + ':' + n + '">✕ retirer</button></div>' +
      '<div class="tags">' + CAUSES.map(([id, lbl]) =>
        '<span class="tag' + ((m.causes || []).includes(id) ? ' on' : '') +
        '" data-tag="' + i + ':' + n + ':' + id + '">' + lbl + '</span>').join('') +
      '</div></div>').join('');
  });
  document.querySelectorAll('.tally').forEach(t => {
    const i = t.dataset.img;
    let tp = 0, fp = 0, dp = 0;
    for (let j = 0; j < DATA[i].boxes; j++) {
      const s = S.boxState[i + ':' + j] || 'ok';
      if (s === 'ok') tp++; else if (s === 'fp') fp++; else dp++;
    }
    const fn = (S.misses[i] || []).length;
    t.innerHTML =
      '<span style="color:var(--ok)">correctes <b>' + tp + '</b></span>' +
      '<span style="color:var(--ko)">faux positifs <b>' + fp + '</b></span>' +
      '<span style="color:var(--wa)">doublons <b>' + dp + '</b></span>' +
      '<span style="color:var(--wa)">ratées <b>' + fn + '</b></span>' +
      '<span style="color:var(--tx2)">détectables <b>' + (tp + fn) + '</b></span>';
  });

  const s = stats();
  const pc = v => v == null ? '—' : (100 * v).toFixed(1).replace('.', ',') + ' <small>%</small>';
  document.getElementById('kpis').innerHTML = [
    ['Détectables', s.detectable], ['Correctement détectées', s.tp],
    ['Manquées', s.fn], ['Faux positifs', s.fp + s.dup],
    ['Rappel', pc(s.recall)], ['Précision', pc(s.precision)],
    ['Inférence médiane', ${summary.inferenceMs.median} + ' <small>ms</small>'],
    ['Inférence p90', ${summary.inferenceMs.p90} + ' <small>ms</small>'],
  ].map(([k, v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

  const el = document.getElementById('verdict');
  if (s.detectable === 0) {
    el.className = 'verdict v-wait';
    el.textContent = 'Vérité terrain à établir — pointe les voitures ratées ci-dessous.';
  } else {
    const r = s.recall, p = s.precision;
    let cls, txt;
    if (p != null && p < 0.5) { cls = 'v-no'; txt = 'NO GO — précision < 50 % : trop de fausses boîtes, l\\'écran devient illisible.'; }
    else if (r >= 0.90) { cls = 'v-go';  txt = 'GO — rappel ≥ 90 %. V1 puis V2/V3 restent ouverts.'; }
    else if (r >= 0.80) { cls = 'v-mid'; txt = 'GO ASSISTÉ — rappel entre 80 et 90 %. V1 vaut le coup ; le tracking (V2) sera fragile.'; }
    else if (r >= 0.60) { cls = 'v-no';  txt = 'INSUFFISANT — rappel < 80 %. Rejouer le MÊME corpus avec YOLOX-s avant toute conclusion.'; }
    else { cls = 'v-no'; txt = 'NO GO — rappel < 60 % : on retombe sur le constat de la révision 5, autant de clics gagnés que perdus.'; }
    el.className = 'verdict ' + cls;
    el.textContent = txt + '  (rappel ' + (100 * r).toFixed(1) + ' % sur ' + s.detectable + ' voitures détectables)';
  }

  const maxC = Math.max(1, ...Object.values(s.causeCount));
  document.getElementById('causes').innerHTML =
    (s.fn ? '<b>Causes des ' + s.fn + ' échecs</b>' : '') +
    CAUSES.filter(([id]) => s.causeCount[id] > 0).map(([id, lbl]) =>
      '<div class="row"><span class="lbl">' + lbl + '</span>' +
      '<span class="track"><span class="fill" style="width:' + (100 * s.causeCount[id] / maxC) + '%"></span></span>' +
      '<span class="n">' + s.causeCount[id] + '</span></div>').join('');
}

document.addEventListener('click', ev => {
  const t = ev.target.dataset.tag, d = ev.target.dataset.del;
  if (t) {
    const [i, n, id] = t.split(':');
    const m = S.misses[i][n]; m.causes ||= [];
    const k = m.causes.indexOf(id);
    k >= 0 ? m.causes.splice(k, 1) : m.causes.push(id);
    save(); render();
  }
  if (d) {
    const [i, n] = d.split(':');
    S.misses[i].splice(n, 1); save(); render();
  }
});

document.getElementById('exp').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ model: '${esc(summary.model)}', stats: stats(), state: S }, null, 2)],
                        { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'releve-${esc(summary.model)}.json';
  a.click();
});
document.getElementById('rst').addEventListener('click', () => {
  if (confirm('Effacer tout le relevé ?')) { S = { boxState: {}, misses: {} }; save(); render(); }
});

render();
</script>
</div></body></html>`;
}
