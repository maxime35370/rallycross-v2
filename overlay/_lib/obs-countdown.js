/* ═══════════════════════════════════════════════
   OBS-COUNTDOWN.JS — Logique PURE de l'alerte « le compte à rebours se termine ».
   La régie prévient X secondes AVANT la fin (réglable) pour laisser le temps de préparer la reprise.
═══════════════════════════════════════════════ */

/** Délais d'avance proposés (secondes) ; 0 = au moment où le chrono atteint 0. */
export const LEAD_CHOICES = [0, 15, 30, 60, 120];
export const LEAD_DEFAULT = 30;

export const leadLabel = s => s === 0 ? 'à 0 (à la fin)' : s < 60 ? `${s} s avant la fin` : `${s / 60} min avant la fin`;

export function normalizeLead(v) {
  const n = Math.round(Number(v));
  return LEAD_CHOICES.includes(n) ? n : LEAD_DEFAULT;
}

/**
 * Délai d'avance réellement appliqué : jamais plus de la moitié de la durée totale du chrono,
 * pour qu'un chrono court (ex. 1 min) ne déclenche pas l'alerte dès son lancement.
 */
export function effectiveLeadMs(leadSec, start, end) {
  const lead = normalizeLead(leadSec) * 1000;
  const total = start > 0 && end > start ? end - start : 0;
  return total ? Math.min(lead, Math.floor(total / 2)) : lead;
}

/**
 * État de l'alerte à l'instant `now`.
 * @returns {{ show: boolean, phase: 'none'|'soon'|'done', left: number }}
 *   soon = la fin approche (left > 0) ; done = chrono terminé.
 * @param {{end:number,start?:number,now:number,leadSec:number,acked:number,armed:number,onAir:boolean}} p
 *   acked : fin déjà acquittée ; armed : fin dont on a vu le décompte courir (alerte « fraîche »).
 */
export function alertState({ end, start = 0, now, leadSec, acked, armed, onAir }) {
  const left = (end || 0) - now;
  if (!(end > 0) || !onAir || acked === end) return { show: false, phase: 'none', left };
  const lead = effectiveLeadMs(leadSec, start, end);
  // pas d'alerte sur un vieux décompte déjà expiré à l'ouverture de la page
  const fresh = armed === end || left > -120000;
  if (!fresh) return { show: false, phase: 'none', left };
  if (left <= 0) return { show: true, phase: 'done', left };
  if (left <= lead) return { show: true, phase: 'soon', left };
  return { show: false, phase: 'none', left };
}

/** « 0:30 » / « 1:05 » — temps restant lisible. */
export function mmss(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
