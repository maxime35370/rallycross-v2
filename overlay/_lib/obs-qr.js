/* ═══════════════════════════════════════════════
   OBS-QR.JS — Génération de QR codes (lib vendored qrcode.js)
   Sert au lien d'accès spectateur (pronostics + classements) affiché
   sur l'overlay et partageable depuis la régie.
═══════════════════════════════════════════════ */

import qrcode from './qrcode.js';

/**
 * QR d'un texte → data-URI PNG (autonome, à mettre dans <img src>).
 * @param {string} text
 * @param {{cell?:number, margin?:number, ecc?:'L'|'M'|'Q'|'H'}} [opts]
 * @returns {string} data:image/... ou '' si texte vide / erreur
 */
export function qrDataUrl(text, { cell = 6, margin = 2, ecc = 'M' } = {}) {
  if (!text) return '';
  try {
    const qr = qrcode(0, ecc);   // 0 = version auto (taille minimale selon les données)
    qr.addData(String(text));
    qr.make();
    return qr.createDataURL(cell, margin);
  } catch (e) {
    console.error('[qr]', e);
    return '';
  }
}

/**
 * Construit le lien d'accès spectateur (mode lecture seule scopé) :
 *   {base}/#spectator?meeting=…&category=…
 * @param {string} base       ex. 'https://rxchrono.netlify.app'
 * @param {string} meetingId
 * @param {string} [category]
 */
export function spectatorUrl(base, meetingId, category) {
  const b = (base || 'https://rxchrono.netlify.app').trim().replace(/\/+$/, '');
  const params = [];
  if (meetingId) params.push('meeting=' + encodeURIComponent(meetingId));
  if (category)  params.push('category=' + encodeURIComponent(category));
  return b + '/#spectator' + (params.length ? '?' + params.join('&') : '');
}
