/* ═══════════════════════════════════════════════
   PROVIDERS/ITS-LIVE.JS — Provider ITS Live
   Plateforme officielle de chronométrage utilisée par
   le championnat de France Rallycross (FFSA) entre
   autres. API : https://api-live.its-live.net/v1
═══════════════════════════════════════════════ */

export const id          = 'its-live';
export const name        = 'ITS Live';
export const description = 'Plateforme ITS (api-live.its-live.net) — utilisée par le championnat de France RX';

const API_BASE = 'https://api-live.its-live.net/v1';

// Clé locale pour stocker un identifiant de "screen" stable côté navigateur.
// L'API ITS attend ce header sur chaque appel.
const SCREEN_UUID_KEY = 'rx_its_live_screen_uuid';

function getScreenUuid() {
  let uuid = localStorage.getItem(SCREEN_UUID_KEY);
  if (!uuid) {
    uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SCREEN_UUID_KEY, uuid);
  }
  return uuid;
}

function commonHeaders() {
  return {
    'accept': '*/*',
    'x-screen-uuid': getScreenUuid(),
  };
}

// ─────────────────────────────────────────────────────────
// CHAMPIONNATS CONNUS
// Liste de cs_id ITS qu'on a déjà rencontrés, pour pré-remplir
// le dropdown de la modal d'import. Si un cs_id n'est pas dans
// cette liste, l'utilisateur peut tout de même le saisir
// manuellement via l'option « Autre… ».
// ─────────────────────────────────────────────────────────

export const KNOWN_CHAMPIONSHIPS = [
  { value: 'rallycrossfr', label: 'Championnat de France Rallycross (FFSA)' },
];

// ─────────────────────────────────────────────────────────
// SCHÉMA DE CONFIGURATION
// Permet à l'UI d'afficher dynamiquement les champs requis,
// avec dropdowns en cascade : championnat → saison → événement.
// ─────────────────────────────────────────────────────────

export const configSchema = {
  championship: [
    {
      key: 'cs_id',
      label: 'Championnat',
      type: 'select',
      required: true,
      options: KNOWN_CHAMPIONSHIPS,
      allowCustom: true,
      customLabel: 'Autre…',
      customPlaceholder: 'ex : rallycrossfr',
      help: 'Identifiant ITS du championnat. Si non listé, choisissez « Autre… » et tapez-le (visible dans l\'URL its-results.com/<cs_id>/...).',
    },
  ],
  meeting: [
    {
      key: 'season',
      label: 'Saison',
      type: 'dynamicSelect',
      required: true,
      dependsOn: ['cs_id'],
      placeholder: '— Choisir une saison —',
      loadOptions: async ({ cs_id }) => {
        const seasons = await listSeasons(cs_id);
        return (seasons || []).map(s => ({
          value: String(s.name),
          label: String(s.name),
          raw: s,
        }));
      },
    },
    {
      key: 'event_id',
      label: 'Manche / Événement',
      type: 'dynamicSelect',
      required: true,
      dependsOn: ['cs_id', 'season'],
      placeholder: '— Choisir un événement —',
      loadOptions: async ({ cs_id, season }) => {
        const events = await listEvents(cs_id, season);
        return (events || []).map(e => {
          const date = e.begin_date
            ? new Date(e.begin_date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
            : '';
          const parts = [e.name || e.event_id];
          if (e.location_name && e.location_name !== e.name) parts.push(e.location_name);
          if (date) parts.push(date);
          return { value: e.event_id, label: parts.join(' — '), raw: e };
        });
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────
// APPELS API
// ─────────────────────────────────────────────────────────

async function apiGet(path, extraHeaders = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { ...commonHeaders(), ...extraHeaders },
    mode: 'cors',
    credentials: 'omit',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`ITS Live (${r.status}) : ${text || r.statusText}`);
  }
  return r.json();
}

async function apiPost(path, body, extraHeaders = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      ...commonHeaders(),
      'content-type': 'application/json',
      ...extraHeaders,
    },
    mode: 'cors',
    credentials: 'omit',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`ITS Live (${r.status}) : ${text || r.statusText}`);
  }
  return r.json();
}

/** Liste les saisons disponibles pour un cs_id. */
export async function listSeasons(cs_id) {
  return apiGet(`/Events/ListSeasons/${encodeURIComponent(cs_id)}`);
}

/** Liste les événements (rounds) d'une saison. */
export async function listEvents(cs_id, season) {
  return apiGet(`/Events/ListEvents/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}`);
}

/** Récupère le détail d'un événement. */
export async function getEvent({ cs_id, season, event_id }) {
  return apiGet(
    `/Events/GetEventById/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}/${encodeURIComponent(event_id)}`,
    { 'x-block': cs_id }
  );
}

/**
 * Liste les sessions d'un événement.
 * Retourne un tableau enrichi : `result.debug` contient la réponse brute
 * et la liste des endpoints tentés (utile pour afficher des détails
 * techniques quand aucune session n'est trouvée).
 *
 * Le format précis du payload `getEvent` peut varier selon la version de
 * l'API et le championnat. On essaie plusieurs stratégies :
 *  1. Recherche profonde dans la réponse de GetEventById.
 *  2. Si rien trouvé, appel direct à un endpoint dédié (ListSessions /
 *     GetSessionsList) — couvre les cas où l'événement n'inclut pas
 *     ses sessions inline.
 */
export async function listSessions(config) {
  const debug = { rawEvent: null, triedEndpoints: [] };

  let event;
  try {
    event = await getEvent(config);
    debug.rawEvent = event;
  } catch (err) {
    debug.rawEvent = { error: err.message || String(err) };
    throw err;
  }

  let rawSessions = findSessionsArray(event);

  if (!rawSessions || rawSessions.length === 0) {
    rawSessions = await tryDedicatedSessionsEndpoints(config, debug);
  }

  const result = !rawSessions || rawSessions.length === 0
    ? []
    : rawSessions.map(s => ({
        session_id: pickFirst(s, ['session_id', 'sessionId', 'id', 'ssid_session_id']),
        name:       pickFirst(s, ['name', 'label', 'title', 'description', 'session_name']) || '',
        category:   pickFirst(s, ['category', 'cat', 'class', 'category_name', 'class_name', 'group', 'group_name']) || '',
        type:       pickFirst(s, ['type', 'session_type', 'kind', 'phase', 'phase_type']) || '',
        raw: s,
      })).filter(s => s.session_id != null);

  if (result.length === 0 && typeof console !== 'undefined' && console.warn) {
    console.warn('[ITS Live] Aucune session trouvée. Réponse brute :', event);
    if (debug.triedEndpoints.length) {
      console.warn('[ITS Live] Endpoints tentés :', debug.triedEndpoints);
    }
  }

  result.debug = debug;
  return result;
}

/**
 * Cherche un tableau de sessions dans une réponse JSON.
 *  1. Aux clés bien connues au top-level.
 *  2. Aux clés bien connues dans des wrappers usuels (data, result, event…).
 *  3. Recherche profonde par heuristique (looksLikeSession).
 */
function findSessionsArray(payload) {
  if (!payload) return null;

  const wellKnown = [
    'sessions', 'Sessions', 'sessionList', 'sessions_list', 'session_list',
    'phases', 'runs', 'races', 'heats',
  ];

  for (const key of wellKnown) {
    const arr = payload[key];
    if (Array.isArray(arr) && arr.length > 0) return arr;
  }

  for (const wrapper of ['data', 'result', 'event', 'payload', 'response', 'Event']) {
    const inner = payload[wrapper];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      for (const key of wellKnown) {
        const arr = inner[key];
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    }
  }

  // Recherche récursive bornée pour éviter les payloads gigantesques.
  const seen = new Set();
  const queue = [{ node: payload, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 4) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length > 0 && looksLikeSession(node[0])) return node;
      for (const item of node) queue.push({ node: item, depth: depth + 1 });
      continue;
    }

    for (const v of Object.values(node)) {
      if (Array.isArray(v) && v.length > 0 && looksLikeSession(v[0])) return v;
      if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 });
    }
  }
  return null;
}

function looksLikeSession(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return ['session_id', 'sessionId', 'id', 'ssid_session_id']
    .some(k => obj[k] !== undefined && obj[k] !== null);
}

/** Essaie quelques endpoints dédiés pour lister les sessions. */
async function tryDedicatedSessionsEndpoints({ cs_id, season, event_id }, debug) {
  const headers = { 'x-block': cs_id };
  const candidates = [
    `/Events/ListSessions/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}/${encodeURIComponent(event_id)}`,
    `/Sessions/ListSessions/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}/${encodeURIComponent(event_id)}`,
    `/Session/ListSessions/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}/${encodeURIComponent(event_id)}`,
    `/Session/GetSessionsByEventId/${encodeURIComponent(cs_id)}/${encodeURIComponent(season)}/${encodeURIComponent(event_id)}`,
  ];
  for (const path of candidates) {
    try {
      const data = await apiGet(path, headers);
      debug?.triedEndpoints.push({ path, status: 'ok' });
      if (Array.isArray(data) && data.length > 0) return data;
      const arr = findSessionsArray(data);
      if (arr && arr.length > 0) return arr;
    } catch (err) {
      debug?.triedEndpoints.push({ path, status: 'error', message: err.message || String(err) });
    }
  }
  return null;
}

/**
 * Récupère le classement complet d'une session.
 * Retourne une liste normalisée :
 *   [{ carNumber, time_ms, status, position, firstName, lastName, raw }, ...]
 */
export async function getRanking({ cs_id, season, event_id, session_id }) {
  const data = await apiPost(
    '/Session/GetRankingWithBestOfAll',
    {
      ssid: { cs_id, season, event_id, session_id: Number(session_id) },
      startPos: 1,
      endPos: 99999999,
      startId: 0,
    },
    { 'x-block': cs_id }
  );

  return parseRanking(data);
}

// ─────────────────────────────────────────────────────────
// PARSING — robuste aux variations de format
// ─────────────────────────────────────────────────────────

function parseRanking(payload) {
  const rows = pickFirst(payload, ['rows', 'results', 'entries', 'data', 'ranking', 'Ranking']) || [];
  return rows
    .map(extractRow)
    .filter(r => r && r.carNumber != null);
}

function extractRow(row) {
  const carNumber = pickFirst(row, [
    'carNumber', 'car_number', 'num', 'number',
    'pilotNumber', 'pilot_number', 'numero', 'race_number',
  ]);
  if (carNumber == null) return null;

  const rawTime = pickFirst(row, [
    'totalTime_ms', 'totalTimeMs', 'total_time_ms',
    'totalTime', 'total_time',
    'time_ms', 'timeMs',
    'time', 'best_time', 'bestTime',
    'gap_total',
  ]);
  const time_ms = parseTimeFlex(rawTime);

  const rawStatus = pickFirst(row, ['status', 'state', 'finishStatus', 'finish_status']);
  const status = parseStatusFlex(rawStatus);

  const position = pickFirst(row, ['position', 'rank', 'pos', 'rank_position']);
  const firstName = pickFirst(row, ['firstName', 'first_name', 'firstname', 'prenom']);
  const lastName  = pickFirst(row, ['lastName',  'last_name',  'lastname',  'nom', 'familyName']);

  return {
    carNumber: Number(carNumber),
    time_ms,
    status,
    position: position != null ? Number(position) : null,
    firstName: firstName || null,
    lastName:  lastName  || null,
    raw: row,
  };
}

function pickFirst(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

/**
 * Convertit divers formats de temps en millisecondes.
 *  - number → ms tels quels (avec arrondi)
 *  - "1:23.456" / "1:23,456"
 *  - "83.456" / "83,456"
 *  - "PT1M23.456S" (ISO 8601)
 *  - chaîne d'entiers → ms
 */
export function parseTimeFlex(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    if (!isFinite(val) || val <= 0) return null;
    return Math.round(val);
  }
  const s = String(val).trim();
  if (!s) return null;

  const iso = s.match(/^PT(?:(\d+)M)?(\d+(?:[.,]\d+)?)S$/i);
  if (iso) {
    const min = Number(iso[1] || 0);
    const sec = Number(iso[2].replace(',', '.'));
    return Math.round(min * 60000 + sec * 1000);
  }

  const full = s.match(/^(\d+):(\d{1,2})[.,](\d{1,3})$/);
  if (full) {
    return Number(full[1]) * 60000 + Number(full[2]) * 1000 + Number(full[3].padEnd(3, '0'));
  }

  const short = s.match(/^(\d+)[.,](\d{1,3})$/);
  if (short) {
    return Number(short[1]) * 1000 + Number(short[2].padEnd(3, '0'));
  }

  if (/^\d+$/.test(s)) return Number(s);

  return null;
}

export function parseStatusFlex(val) {
  if (!val) return null;
  const s = String(val).toUpperCase();
  if (s.includes('DNS') || s === 'NOT_STARTED' || s === 'NOTSTART')   return 'DNS';
  if (s.includes('DNF') || s === 'RETIRED' || s === 'OUT' || s === 'ABD') return 'DNF';
  if (s.includes('DSQ') || s.includes('DISQUAL'))                       return 'DSQ';
  return null;
}
