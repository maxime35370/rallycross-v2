/* ═══════════════════════════════════════════════
   OBS-FIT.JS — Adapte la « toile » de l'overlay à la taille réelle de la fenêtre.
   L'overlay est conçu sur une base 1920×1080 : on met la page à l'échelle k (la plus contraignante
   des deux dimensions) puis on AGRANDIT la toile dans l'autre dimension, pour qu'elle remplisse
   toute la fenêtre sans bandes vides ni déformation. Les tableaux (grilles / flex) se répartissent
   sur la place gagnée. À 1920×1080 : k = 1, toile 1920×1080 → rendu strictement inchangé.
═══════════════════════════════════════════════ */

export const BASE_W = 1920, BASE_H = 1080;

/** Échelle et taille de toile (en px de mise en page) pour une fenêtre iw×ih. */
export function fitCanvas(iw, ih, bw = BASE_W, bh = BASE_H) {
  if (!(iw > 0) || !(ih > 0)) return { k: 1, w: bw, h: bh };
  const k = Math.min(iw / bw, ih / bh);
  return { k, w: iw / k, h: ih / k };
}

/** Applique l'ajustement au document (échelle sur <body>, variables --cw / --ch pour le CSS). */
export function applyFit(win = window, doc = document) {
  const { k, w, h } = fitCanvas(win.innerWidth, win.innerHeight);
  const de = doc.documentElement.style, b = doc.body.style;
  de.width = '100%'; de.height = '100%';
  b.width = w + 'px'; b.height = h + 'px';
  b.transformOrigin = '0 0'; b.transform = Math.abs(k - 1) < 0.0005 ? '' : `scale(${k})`;
  de.setProperty('--cw', w + 'px'); de.setProperty('--ch', h + 'px');
  return { k, w, h };
}

/** Largeur de toile courante (px de mise en page), 1920 par défaut. */
export function canvasWidth(doc = document) {
  return parseFloat(doc.documentElement.style.getPropertyValue('--cw')) || BASE_W;
}
