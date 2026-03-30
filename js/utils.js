/* ═══════════════════════════════════════════════
   UTILS.JS — Utilitaires génériques
   Formatage des temps, conversions, helpers
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// FORMATAGE DES TEMPS
// ─────────────────────────────────────────────────────────

/**
 * Convertit des millisecondes en chaîne affichable.
 * Format : m:ss.mmm  (ex: 1:23.456)
 * Si < 1 min :        ss.mmm  (ex: 45.123)
 * @param {number|null} ms
 * @returns {string}
 */
export function msToDisplay(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return '—';
  const total = Math.round(ms);
  const min   = Math.floor(total / 60000);
  const sec   = Math.floor((total % 60000) / 1000);
  const mil   = total % 1000;
  if (min > 0) {
    return `${min}:${String(sec).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
  }
  return `${sec}.${String(mil).padStart(3, '0')}`;
}

/**
 * Convertit une saisie utilisateur (champs min, sec, ms) en millisecondes.
 * Retourne null si invalide.
 * @param {string|number} min
 * @param {string|number} sec
 * @param {string|number} mil
 * @returns {number|null}
 */
export function inputToMs(min, sec, mil) {
  const m = parseInt(min) || 0;
  const s = parseInt(sec) || 0;
  const ms = parseInt(mil) || 0;
  if (s < 0 || s > 59) return null;
  if (ms < 0 || ms > 999) return null;
  if (m < 0) return null;
  return m * 60000 + s * 1000 + ms;
}

/**
 * Parse une saisie libre de type "1:23.456" ou "45.123" en ms.
 * Accepte aussi "1:23,456" (virgule).
 * Retourne null si non parsable.
 * @param {string} str
 * @returns {number|null}
 */
export function parseTimeString(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().replace(',', '.');

  // Format m:ss.mmm
  const full = s.match(/^(\d+):(\d{1,2})\.(\d{1,3})$/);
  if (full) {
    return inputToMs(full[1], full[2], full[3].padEnd(3, '0'));
  }

  // Format ss.mmm
  const short = s.match(/^(\d+)\.(\d{1,3})$/);
  if (short) {
    return inputToMs(0, short[1], short[2].padEnd(3, '0'));
  }

  return null;
}

/**
 * Décompose des millisecondes en objet { min, sec, mil } pour remplir des champs.
 * @param {number|null} ms
 * @returns {{ min: string, sec: string, mil: string }}
 */
export function msToFields(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) {
    return { min: '', sec: '', mil: '' };
  }
  const total = Math.round(ms);
  return {
    min: String(Math.floor(total / 60000)),
    sec: String(Math.floor((total % 60000) / 1000)).padStart(2, '0'),
    mil: String(total % 1000).padStart(3, '0'),
  };
}

// ─────────────────────────────────────────────────────────
// CATÉGORIES
// ─────────────────────────────────────────────────────────

export const CATEGORIES = [
  'Supercar',
  'Super1600',
  'Division 5',
  'Féminines',
  'D3',
  'D4',
];

/**
 * Retourne la clé CSS normalisée pour une catégorie.
 * Ex: 'Féminines' → 'feminines'
 */
export function categoryKey(cat) {
  return (cat || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// ─────────────────────────────────────────────────────────
// TYPES DE SESSION
// ─────────────────────────────────────────────────────────

export const SESSION_TYPES = {
  EC:  { label: 'Essais chronométrés', short: 'Essais', tours: 1  },
  MQ:  { label: 'Manche qualificative', short: 'Qualif.',  tours: 4  },
  DF:  { label: 'Demi-finale',          short: '½ Finale', tours: 6  },
  FIN: { label: 'Finale',               short: 'Finale',   tours: 7  },
};

// ─────────────────────────────────────────────────────────
// STATUTS DE COURSE
// ─────────────────────────────────────────────────────────

export const STATUSES = ['DNS', 'DNF', 'DSQ', 'DSQ_RACE'];

/**
 * Retourne true si le statut est un statut spécial (pas un temps normal).
 */
export function isSpecialStatus(status) {
  return STATUSES.includes(status?.toUpperCase());
}

// ─────────────────────────────────────────────────────────
// SANITISATION
// ─────────────────────────────────────────────────────────

/**
 * Échappe les caractères HTML dangereux.
 * À utiliser avant tout innerHTML avec des données utilisateur.
 * @param {string} str
 * @returns {string}
 */
export function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Nettoie une chaîne de saisie utilisateur.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function sanitize(str, maxLen = 100) {
  return String(str || '').trim().slice(0, maxLen);
}

// ─────────────────────────────────────────────────────────
// DIVERS
// ─────────────────────────────────────────────────────────

/**
 * Formate une date Firestore (Timestamp ou string) en dd/mm/yyyy.
 * @param {any} val
 * @returns {string}
 */
export function formatDate(val) {
  if (!val) return '—';
  const d = val.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Génère un ID aléatoire court (usage local uniquement, pas Firestore).
 */
export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Debounce : retarde l'exécution d'une fonction.
 * @param {Function} fn
 * @param {number} delay ms
 */
export function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}