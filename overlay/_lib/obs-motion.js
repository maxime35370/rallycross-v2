/* ═══════════════════════════════════════════════
   OBS-MOTION.JS — Transitions douces de l'overlay (DOM uniquement, aucune donnée).
   • crossfade   : fondu entre l'ancienne et la nouvelle scène (changement de scène / catégorie / session) ;
   • snapshotRows + playFlip : quand un classement se met à jour, les lignes GLISSENT vers leur nouvelle
     place au lieu de sauter (technique « FLIP ») ; une ligne nouvelle apparaît en fondu ;
   • ghostOf     : copie figée d'un élément qui s'efface pendant que le nouveau entre (rotation des classements).
   Tout est à usage unique (pas de boucle) et en transform / opacity : léger dans OBS.
═══════════════════════════════════════════════ */

export const ROW_SEL   = '.cr, .row, .gr-row, .sr';
const NUM_SEL          = '.n, .num, .sn, .gn';
const PANEL_SEL        = '.col, .dpanel, .gr-res, .st-board';
export const FADE_MS   = 450;      // durée du fondu de l'ancienne scène
export const FLIP_MS   = 600;      // durée du glissement des lignes

/** Échelle courante de la page (obs-fit.js met <body> à l'échelle) : px écran / px de mise en page. */
export function scaleOf(body) {
  const w = body.offsetWidth;
  return w ? body.getBoundingClientRect().width / w || 1 : 1;
}

/** Clé stable d'une ligne : panneau + n° de voiture (+ rang d'apparition si doublon). */
function eachRow(root, fn) {
  const panels = [...root.querySelectorAll(PANEL_SEL)];
  const seen = new Map();
  root.querySelectorAll(ROW_SEL).forEach(el => {
    const n = el.querySelector(NUM_SEL);
    const num = n && n.textContent ? n.textContent.trim() : '';
    if (!num) return;
    const panel = el.closest(PANEL_SEL);
    const base = panels.indexOf(panel) + '|' + num;
    const c = (seen.get(base) || 0) + 1; seen.set(base, c);
    fn(el, base + '#' + c);
  });
}

/** Position verticale (px écran) de chaque ligne, avant une mise à jour. */
export function snapshotRows(root) {
  const snap = new Map();
  eachRow(root, (el, key) => snap.set(key, el.getBoundingClientRect().top));
  return snap;
}

/**
 * Après la mise à jour : chaque ligne qui a changé de place glisse depuis son ancienne position ;
 * une ligne absente de l'instantané apparaît en fondu. Rend le nombre de lignes déplacées.
 */
export function playFlip(root, snap, body = root.ownerDocument.body) {
  if (!snap || !snap.size) return 0;          // 1er affichage (ou liste vide) : rien à animer
  const k = scaleOf(body);
  const moved = [];
  eachRow(root, (el, key) => {
    const y0 = snap.get(key);
    if (y0 == null) { el.classList.add('row-new'); return; }
    const dy = (y0 - el.getBoundingClientRect().top) / k;
    if (Math.abs(dy) < 1) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    moved.push(el);
  });
  if (!moved.length) return 0;
  void root.offsetWidth;                       // force le calcul de style avant de lancer la transition
  moved.forEach(el => {
    el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.8,.2,1)`;
    el.style.transform = '';
  });
  setTimeout(() => moved.forEach(el => { el.style.transition = ''; }), FLIP_MS + 60);
  return moved.length;
}

/** Copie figée d'un élément, sans identifiants ni animations d'entrée (pour qu'elle ne se rejoue pas). */
export function ghostOf(el, className) {
  const g = el.cloneNode(true);
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  g.querySelectorAll('.enter').forEach(e => e.classList.remove('enter'));
  g.className = [g.className.replace(/\benter\b/, ''), className].join(' ').trim();
  return g;
}

/**
 * Remplace le contenu de `root` par `html` avec un fondu croisé : l'ancienne scène s'efface par-dessus
 * pendant que la nouvelle apparaît. Pas de fondu si l'overlay est masqué (il ne doit rien révéler).
 * @param {(html:string)=>void} setHtml  écrit réellement le contenu
 */
export function crossfade(root, html, setHtml, doc = root.ownerDocument) {
  const hidden = root.classList.contains('hidden');
  const hadContent = !!root.firstElementChild;
  let ghost = null;
  if (!hidden && hadContent) {
    ghost = doc.createElement('div');
    ghost.className = 'overlay-root ov-ghost';
    ghost.innerHTML = root.innerHTML;
    ghost.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
    ghost.querySelectorAll('.enter').forEach(e => e.classList.remove('enter'));
    doc.body.appendChild(ghost);
  }
  setHtml(html);
  if (hidden) return;
  root.classList.remove('scene-in'); void root.offsetWidth; root.classList.add('scene-in');
  setTimeout(() => { if (ghost) ghost.remove(); root.classList.remove('scene-in'); }, FADE_MS + 250);
}
