/* ═══════════════════════════════════════════════
   OBS-RECAP-IMAGE.JS — Image récap PNG (1080×1080, format carré universel
   Instagram/X/Facebook) générée à la révélation d'un pronostic, pour
   partage rapide sur les réseaux.

   100% client (Canvas 2D), aucune clé ni API externe : la régie clique,
   l'image se télécharge, elle la poste elle-même où elle veut — pas de
   secret à gérer, pas de service tiers.
═══════════════════════════════════════════════ */

const W = 1080, H = 1080;
const ORANGE = '#ff5500';
const INK    = '#0a0c11';
const GREEN  = '#39d98a';
const MUT    = '#8b95a4';
const WHITE  = '#eef2f7';

/** Découpe un texte en lignes tenant dans maxWidth, les dessine, renvoie le nombre de lignes. */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Génère l'image récap d'un pronostic révélé.
 * @param {object} p pronostic (question, category, options, tally, totalVotes, correctDriverId)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderRecapCanvas(p) {
  // Les polices web (Orbitron/Barlow Condensed, déjà chargées par la page
  // régie pour l'affichage courant) doivent être prêtes AVANT de dessiner
  // du texte sur le canvas, sinon fillText retombe silencieusement sur une
  // police système.
  try { await document.fonts.ready; } catch { /* environnement sans CSS Font Loading API : tant pis, fallback système */ }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Fond dégradé — même esprit que la régie/l'overlay.
  const grad = ctx.createRadialGradient(W * 0.7, 0, 0, W * 0.7, 0, W * 1.3);
  grad.addColorStop(0, '#161d2a');
  grad.addColorStop(1, INK);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Bandeau haut : catégorie + marque.
  ctx.textAlign = 'left';
  ctx.fillStyle = MUT;
  ctx.font = '600 30px "Barlow Condensed", sans-serif';
  ctx.fillText((p.category || '').toUpperCase(), 64, 90);
  ctx.textAlign = 'right';
  ctx.fillStyle = ORANGE;
  ctx.font = '900 34px "Orbitron", sans-serif';
  ctx.fillText('RX CHRONO', W - 64, 90);
  ctx.textAlign = 'left';

  // Question.
  ctx.fillStyle = WHITE;
  ctx.font = '700 52px "Barlow Condensed", sans-serif';
  const qLines = wrapText(ctx, p.question || '', 64, 180, W - 128, 58);

  // Barres de résultat (top 8 max, triées par nombre de votes).
  const opts = Array.isArray(p.options) ? p.options : [];
  const counts = p.tally || {};
  const total = p.totalVotes || opts.reduce((s, o) => s + (counts[o.driverId] || 0), 0);
  const rows = opts
    .map(o => ({ o, c: counts[o.driverId] || 0 }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 8);
  const maxC = rows.length ? Math.max(...rows.map(r => r.c), 1) : 1;

  let y = 180 + qLines * 58 + 50;
  const barH = 64, gap = 16, barX = 64, barW = W - 128;
  for (const r of rows) {
    const win = !!p.correctDriverId && p.correctDriverId === r.o.driverId;
    const pct = total ? Math.round((r.c / total) * 100) : 0;
    const fillW = Math.max(barW * (r.c / maxC), 6);

    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, barX, y, barW, barH, 12); ctx.fill();

    ctx.fillStyle = win ? GREEN : 'rgba(255,85,0,0.55)';
    roundRect(ctx, barX, y, fillW, barH, 12); ctx.fill();

    ctx.fillStyle = WHITE;
    ctx.font = '700 30px "Barlow Condensed", sans-serif';
    const label = `${win ? '🏆 ' : ''}${r.o.num ? 'N°' + r.o.num + ' ' : ''}${(r.o.name || '').toUpperCase()}`;
    ctx.fillText(label, barX + 24, y + 42);

    ctx.textAlign = 'right';
    ctx.fillStyle = win ? INK : WHITE;
    ctx.font = '800 28px "Orbitron", sans-serif';
    ctx.fillText(`${pct}%`, barX + barW - 24, y + 41);
    ctx.textAlign = 'left';

    y += barH + gap;
  }

  // Pied : total votes.
  ctx.fillStyle = MUT;
  ctx.font = '600 26px "Barlow Condensed", sans-serif';
  ctx.fillText(`🗳️ ${total} vote${total > 1 ? 's' : ''} · Résultat officiel`, 64, H - 56);

  return canvas;
}

/** Génère l'image récap et déclenche son téléchargement direct (PNG). */
export async function downloadRecapImage(p, filename) {
  const canvas = await renderRecapCanvas(p);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename || 'rxchrono-recap.png';
  a.click();
}
