/* ═══════════════════════════════════════════════
   VIDEOCOMPARECALC.JS — Calculs purs du comparateur vidéo (testés)
═══════════════════════════════════════════════ */

export const DELTAS = [1, 2, 5, 10, 15, 30, 60];
export const DEFAULT_DELTA = 5;
export const RATES = [0.25, 0.5, 1, 1.5, 2];

/**
 * Lit un instant saisi : "83", "83,5", "1:23", "1:23:45", "1:23:45.5",
 * "1h2m3s". Retourne des secondes (≥ 0), ou null si illisible.
 */
export function parseStartTime(str) {
  if (str == null) return null;
  const s = String(str).trim().replace(',', '.');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);

  const hms = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/i);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  }

  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p, i) => (i === parts.length - 1 ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p))) return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some(n => n >= 60)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

/** Secondes → "M:SS" ou "H:MM:SS", avec un dixième si la valeur n'est pas entière. */
export function formatStartTime(t) {
  const v = Math.max(0, Number.isFinite(t) ? t : 0);
  const tenths = Math.round(v * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = String(whole % 60).padStart(2, '0');
  const base = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  return frac ? `${base}.${frac}` : base;
}

/** Position après un déplacement de `delta` secondes, jamais avant 0 (arrondi au dixième). */
export function shiftedTime(t, delta) {
  return Math.max(0, Math.round(((t || 0) + delta) * 10) / 10);
}
