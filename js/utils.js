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

// ─────────────────────────────────────────────────────────
// TIMECODES VIDÉO (YouTube)
// ─────────────────────────────────────────────────────────

/**
 * Parse un timecode texte en secondes.
 * Accepte : "1:23:45" (h:m:s), "23:45" (m:s), "45" (s).
 * Retourne null si invalide (chaîne vide → null).
 */
export function parseTimecode(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const parts = s.split(':').map(p => p.trim());
  if (parts.some(p => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) {
    if (nums[1] > 59) return null;
    return nums[0] * 60 + nums[1];
  }
  if (nums.length === 3) {
    if (nums[1] > 59 || nums[2] > 59) return null;
    return nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  return null;
}

/**
 * Formate des secondes en "H:MM:SS" ou "M:SS" si < 1h.
 */
export function formatTimecode(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Extrait l'ID YouTube d'une URL variée :
 *  - https://www.youtube.com/watch?v=XXX
 *  - https://youtu.be/XXX
 *  - https://youtube.com/embed/XXX
 *  - https://www.youtube.com/live/XXX
 *  - https://youtube.com/shorts/XXX
 * Retourne null si non reconnu.
 */
export function extractYoutubeId(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  return null;
}

/**
 * Extrait le timecode d'une URL YouTube contenant `?t=…` ou `&t=…`.
 * Formats acceptés :
 *   - `?t=1118`      → 1118 secondes
 *   - `?t=1118s`     → 1118 secondes
 *   - `?t=18m38s`    → 1118 secondes
 *   - `?t=1h2m3s`    → 3723 secondes
 *   - `?start=1118`  → 1118 secondes (alias historique YouTube)
 * Retourne { seconds, videoId } quand une URL YouTube ET un timecode
 * sont détectés (videoId peut être null si l'URL n'est pas reconnue).
 * Retourne null si la chaîne n'est pas une URL YouTube ou n'a pas de timecode.
 */
export function extractYoutubeTimecode(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s) return null;

  // Ne traite que les entrées qui ressemblent à une URL (ou fragment).
  if (!/^(https?:\/\/|\/\/|www\.|youtu)/i.test(s) && !s.includes('?t=') && !s.includes('&t=')) {
    return null;
  }

  const tMatch = s.match(/[?&](?:t|start)=([^&#\s]+)/);
  if (!tMatch) return null;
  const raw = tMatch[1];

  let seconds = null;

  // Format composé h/m/s (ex: "1h2m3s", "18m38s", "90s")
  const composed = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (composed && (composed[1] || composed[2] || composed[3])) {
    const h = Number(composed[1] || 0);
    const m = Number(composed[2] || 0);
    const sec = Number(composed[3] || 0);
    seconds = h * 3600 + m * 60 + sec;
  } else if (/^\d+$/.test(raw)) {
    seconds = Number(raw);
  }

  if (seconds == null || isNaN(seconds) || seconds < 0) return null;

  const videoId = extractYoutubeId(s);
  return { seconds, videoId };
}

/**
 * Construit une URL YouTube avec un timecode (en secondes).
 * @param {string} idOrUrl - ID vidéo ou URL complète
 * @param {number} seconds - Secondes depuis le début (0 ou null = pas de timecode)
 * @returns {string|null}
 */
export function buildYoutubeUrl(idOrUrl, seconds) {
  const id = extractYoutubeId(idOrUrl);
  if (!id) return null;
  const t = seconds && seconds > 0 ? `?t=${Math.floor(seconds)}s` : '';
  return `https://youtu.be/${id}${t}`;
}

/**
 * Construit une clé map pour un timecode (session × catégorie).
 * Utilisé pour le stockage dans `meeting.videoTimecodes[key]`.
 * Ex : ("MQ", 1, "Division 5") → "MQ1__Division_5"
 *      ("FIN", null, "Féminines") → "FIN__Feminines"
 * @param {string} sessionType — EC, MQ, QF, DF, FIN
 * @param {number|null} sessionNum — Numéro (pour MQ, QF, DF)
 * @param {string} category — Ex: "Supercar", "Division 5"
 */
export function timecodeKey(sessionType, sessionNum, category) {
  const cat = String(category || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '_');
  const t = sessionNum ? `${sessionType}${sessionNum}` : sessionType;
  return `${t}__${cat}`;
}
// ─────────────────────────────────────────────────────────
// IDENTIFIANTS DÉTERMINISTES — ANTI-DOUBLON
// ─────────────────────────────────────────────────────────

/**
 * Identifiant canonique d'un document `sessionParticipants`.
 *
 * Convention maison, déjà appliquée à `results` : l'identifiant du document
 * PORTE la clé métier. Deux écritures concurrentes pour le même pilote et la
 * même session visent alors le même document et se écrasent au lieu de créer
 * deux inscriptions. C'est ce qui rend le doublon structurellement impossible,
 * là où un `addDoc` + vérification préalable laisse une fenêtre de course.
 *
 * La règle Firestore correspondante impose ce format à la création (voir
 * firestore.rules, match /sessionParticipants) : la contrainte n'est donc pas
 * seulement une politesse du client.
 *
 * @param {string} sessionId
 * @param {string} driverId
 * @returns {string}
 */
export function sessionParticipantId(sessionId, driverId) {
  return `${sessionId}_${driverId}`;
}

/** Identifiant canonique d'un document `results`. Même convention. */
export function resultId(sessionId, driverId) {
  return `${sessionId}_${driverId}`;
}

/**
 * Dédoublonne des inscriptions par pilote.
 *
 * Garde en priorité le document dont l'identifiant est déterministe ; à défaut
 * le plus ancien. Les documents créés avant l'adoption de l'identifiant
 * déterministe portent un identifiant aléatoire et peuvent donc être en double.
 *
 * Un doublon ne fausse pas seulement un décompte d'affichage : le nombre
 * d'engagés sert au calcul des points des abandons (`mode: 'engaged_offset'`),
 * donc un DNF vaudrait les points d'une place inexistante.
 *
 * @param {Array} rows — documents sessionParticipants d'UNE session
 * @param {string} [sessionId] — pour reconnaître l'identifiant déterministe
 * @returns {{ participants: Array, duplicates: Array }} `duplicates` contient
 *          les documents écartés, pour permettre un nettoyage éventuel.
 */
export function dedupeParticipants(rows = [], sessionId) {
  const byDriver = new Map();
  for (const r of rows) {
    const arr = byDriver.get(r.driverId) || [];
    arr.push(r);
    byDriver.set(r.driverId, arr);
  }

  const participants = [];
  const duplicates = [];
  for (const [driverId, docs] of byDriver) {
    if (docs.length === 1) { participants.push(docs[0]); continue; }
    const expectedId = sessionParticipantId(sessionId ?? docs[0].sessionId, driverId);
    const sorted = docs.slice().sort((a, b) => {
      if (a.id === expectedId && b.id !== expectedId) return -1;
      if (b.id === expectedId && a.id !== expectedId) return 1;
      const ta = a.createdAt?.toMillis?.() ?? Date.parse(a.createdAt ?? '') ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? Date.parse(b.createdAt ?? '') ?? 0;
      return (isFinite(ta) ? ta : 0) - (isFinite(tb) ? tb : 0);
    });
    participants.push(sorted[0]);
    duplicates.push(...sorted.slice(1));
  }
  return { participants, duplicates };
}
