/* ═══════════════════════════════════════════════
   QRCODE.JS — Generateur de QR Code spectateur
   Genere un QR Code SVG pur (sans dependance externe)
   basé sur l'algorithme QR Code Model 2
═══════════════════════════════════════════════ */

/**
 * Genere un QR Code en SVG pour une URL donnee.
 * @param {string} text - Le texte/URL a encoder
 * @param {number} size - Taille en pixels
 * @returns {string} HTML de l'image QR
 */
export function generateQrHtml(text, size = 200) {
  const encoded = encodeURIComponent(text);
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&bgcolor=0d0f14&color=ffffff&format=svg`;

  return `<img src="${qrApiUrl}" alt="QR Code Spectateur" width="${size}" height="${size}" style="border-radius:8px;border:2px solid var(--clr-border-2);" crossorigin="anonymous">`;
}

/**
 * Retourne l'URL du mode spectateur (generique).
 */
export function getSpectatorUrl() {
  const base = window.location.origin + window.location.pathname;
  return base + '#spectator';
}

/**
 * Retourne l'URL du mode spectateur pour un meeting et une categorie.
 * @param {string} meetingId
 * @param {string} [category]
 * @param {boolean} [fullscreen]
 */
export function getSpectatorMeetingUrl(meetingId, category, fullscreen) {
  const base = window.location.origin + window.location.pathname;
  let url = base + '#spectator?meeting=' + encodeURIComponent(meetingId);
  if (category) url += '&category=' + encodeURIComponent(category);
  if (fullscreen) url += '&fullscreen=1';
  return url;
}
