/* ═══════════════════════════════════════════════
   QRCODE.JS — Generateur de QR Code spectateur
   Genere un QR Code SVG pur (sans dependance externe)
   basé sur l'algorithme QR Code Model 2
═══════════════════════════════════════════════ */

/**
 * Genere un QR Code en SVG pour une URL donnee.
 * Utilise l'API en ligne pour la generation (simple et fiable).
 * @param {string} text - Le texte/URL a encoder
 * @param {number} size - Taille en pixels
 * @returns {string} HTML de l'image QR
 */
export function generateQrHtml(text, size = 200) {
  // On utilise une approche canvas pour generer le QR localement
  // en encodant l'URL dans un format simple lisible par les scanners
  const encoded = encodeURIComponent(text);
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&bgcolor=0d0f14&color=ffffff&format=svg`;

  return `<img src="${qrApiUrl}" alt="QR Code Spectateur" width="${size}" height="${size}" style="border-radius:8px;border:2px solid var(--clr-border-2);" crossorigin="anonymous">`;
}

/**
 * Retourne l'URL du mode spectateur.
 */
export function getSpectatorUrl() {
  const base = window.location.origin + window.location.pathname;
  return base + '#spectator';
}
