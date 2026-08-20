/* ═══════════════════════════════════════════════
   QUALIFICATIONDATA.JS — Chargement des données pour le module
   « Projection de qualification ».

   Seul module du dossier à toucher Firestore. Tout le calcul vit dans les
   modules purs voisins, qui reçoivent ces documents tels quels.

   Convention maison respectée : chaque requête porte sur UN SEUL champ
   (`year`), le reste est filtré côté client — pas d'index composite à créer.
═══════════════════════════════════════════════ */

import { db } from '../firebase.js';
import { buildGroups, buildMeetingContext } from './qualificationState.js';
import { buildObservations } from './qualificationHistory.js';

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/** Cache mémoire par année : une saison chargée une fois par session. */
const _cache = new Map();
let _championships = null;

// ─────────────────────────────────────────────────────────
// REQUÊTES
// ─────────────────────────────────────────────────────────

async function fetchByYear(collectionName, year) {
  const { collection, query, where, getDocs } = await import(FS);
  const snap = await getDocs(query(
    collection(db, collectionName),
    where('year', '==', year),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Tous les championnats, avec leur règlement complet. */
export async function loadChampionshipsById() {
  if (_championships) return _championships;
  if (!db) { _championships = {}; return _championships; }
  const { collection, getDocs } = await import(FS);
  const snap = await getDocs(collection(db, 'championships'));
  const out = {};
  snap.docs.forEach(d => { out[d.id] = { id: d.id, ...d.data() }; });
  _championships = out;
  return out;
}

/** Années disponibles, déduites des meetings existants. */
export async function loadAvailableYears() {
  if (!db) return [];
  const { collection, getDocs } = await import(FS);
  const snap = await getDocs(collection(db, 'meetings'));
  const years = new Set();
  snap.docs.forEach(d => { const y = d.data().year; if (y != null) years.add(Number(y)); });
  return [...years].sort((a, b) => a - b);
}

/**
 * Documents bruts d'une saison.
 * @param {number} year
 */
export async function loadSeason(year) {
  if (_cache.has(year)) return _cache.get(year);
  if (!db) {
    const empty = { year, meetings: [], sessions: [], results: [], participants: [] };
    _cache.set(year, empty);
    return empty;
  }
  const [meetings, sessions, results, participants] = await Promise.all([
    fetchByYear('meetings', year),
    fetchByYear('sessions', year),
    fetchByYear('results', year),
    fetchByYear('sessionParticipants', year),
  ]);
  const data = { year, meetings, sessions, results, participants };
  _cache.set(year, data);
  return data;
}

/** Vide le cache — à appeler si les données ont pu changer sous l'application. */
export function clearCache() {
  _cache.clear();
  _championships = null;
}

// ─────────────────────────────────────────────────────────
// CONTEXTES
// ─────────────────────────────────────────────────────────

/**
 * Charge les saisons demandées et construit un contexte par meeting × catégorie.
 *
 * @param {object} params
 * @param {number[]} params.years
 * @returns {Promise<{ contexts, championshipsById, meetings, years }>}
 */
export async function loadContexts({ years } = {}) {
  const championshipsById = await loadChampionshipsById();
  const wanted = years?.length ? years : await loadAvailableYears();

  const seasons = [];
  for (const y of wanted) seasons.push(await loadSeason(y));

  const meetings = seasons.flatMap(s => s.meetings);
  const sessions = seasons.flatMap(s => s.sessions);
  const results = seasons.flatMap(s => s.results);
  const participants = seasons.flatMap(s => s.participants);

  const groups = buildGroups({ sessions, results, participants, meetings });
  const contexts = groups.map(g => {
    const regulation = championshipsById[g.meeting?.championshipId] || null;
    return buildMeetingContext(g, regulation);
  });

  return { contexts, championshipsById, meetings, years: wanted };
}

/**
 * Historique exploitable : observations pilote sur les meetings complets.
 *
 * @param {object} params — { years }
 * @returns {Promise<{ observations, contexts, championshipsById, meetings, years }>}
 */
export async function loadHistory({ years } = {}) {
  const loaded = await loadContexts({ years });
  const observations = buildObservations(loaded.contexts, {
    championshipsById: loaded.championshipsById,
    requireComplete: true,
  });
  return { ...loaded, observations };
}

/**
 * Contexte d'un meeting × catégorie précis, pour la lecture en situation.
 *
 * @param {object} params — { year, meetingId, category }
 */
export async function loadMeetingContext({ year, meetingId, category }) {
  const { contexts, championshipsById } = await loadContexts({ years: [year] });
  const context = contexts.find(c => c.meetingId === meetingId && c.category === category) || null;
  return { context, championshipsById };
}
