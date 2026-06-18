/* ═══════════════════════════════════════════════
   OBS-DATA.JS — Calculs réutilisés par les overlays
   Réutilise js/calc.js (exports purs) et reproduit fidèlement
   la logique de cumul de js/championship.js / js/standings.js,
   SANS dépendre de l'état/DOM de l'app principale.
   `regulation` = le document championship (pointsScale, statusRules,
   interimTiebreaker, interimPointsEnabled, sessionConfig).
═══════════════════════════════════════════════ */

import { db, fsQuery } from './obs-firebase.js';
import {
  calcInterimStandings, calcEcStandings,
  mqPoints, qfPoints, dfPoints, finPoints, calcStatusPoints,
} from '../../js/calc.js';
import { msToDisplay } from '../../js/utils.js';

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

export function getSessions(meetingId, category) {
  return fsQuery('sessions', [['meetingId', '==', meetingId], ['category', '==', category]]);
}
export function getResults(sessionId) {
  return fsQuery('results', [['sessionId', '==', sessionId]]);
}
export function getParticipants(sessionId) {
  return fsQuery('sessionParticipants', [['sessionId', '==', sessionId]]);
}

/** Trouve la session ciblée par la régie (type + num). */
export function findSession(sessions, type, num) {
  const list = sessions.filter(s => s.type === type);
  if (type === 'EC' || type === 'FIN') return list[0] || null;
  return list.find(s => (s.num ?? 1) === (num ?? 1)) || list[0] || null;
}

/** Tri "course" : finishers par chrono, puis DNS/DSQ derrière. */
export function sortRace(results) {
  return [...results].sort((a, b) => {
    const aOut = ['DNS', 'DSQ'].includes(a.status);
    const bOut = ['DNS', 'DSQ'].includes(b.status);
    if (aOut && !bOut) return 1;
    if (!aOut && bOut) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });
}

// ─────────────────────────────────────────────────────────
// POINTS D'UNE PHASE (QF / DF / FIN) — copie fidèle de championship.js
// ─────────────────────────────────────────────────────────

async function calcPhasePoints(session, regulation) {
  const results      = await getResults(session.id);
  const participants = await getParticipants(session.id);
  const resultMap = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const ptsFn = session.type === 'DF' ? (p => dfPoints(p, regulation))
              : session.type === 'QF' ? (p => qfPoints(p, regulation))
              : (p => finPoints(p, regulation));

  const rows = participants.map(p => ({
    driverId:       p.driverId,
    ms:             resultMap[p.driverId]?.ms             ?? null,
    status:         resultMap[p.driverId]?.status         ?? null,
    manualPosition: resultMap[p.driverId]?.manualPosition ?? null,
  }));

  const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const out = {};
  let pos = 1;
  finished.forEach(r => { out[r.driverId] = ptsFn(pos++); });
  rows.filter(r => r.status === 'DNF' && r.manualPosition)
      .forEach(r => { out[r.driverId] = ptsFn(r.manualPosition); });
  const totalEngaged = participants.length;
  participants.forEach(p => {
    if (out[p.driverId] !== undefined) return;
    const r = resultMap[p.driverId];
    out[p.driverId] = r?.status ? calcStatusPoints(r.status, session.type, totalEngaged, regulation) : 0;
  });
  return out;
}

// ─────────────────────────────────────────────────────────
// POINTS D'UN MEETING (interim + QF + DF + FIN) — copie de championship.js
// ─────────────────────────────────────────────────────────

export async function getMeetingPoints(meetingId, category, regulation) {
  const sessions = await getSessions(meetingId, category);
  if (!sessions.length) return [];

  const interimRows = await calcInterimStandings(db, sessions, regulation);
  const driverMap = {};
  interimRows.forEach(r => {
    driverMap[r.driverId] = {
      driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
      interim: r.interimPoints ?? 0, qf: 0, df: 0, fin: 0,
    };
  });
  const blank = p => ({ driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName,
    lastName: p.lastName, interim: 0, qf: 0, df: 0, fin: 0 });

  for (const qf of sessions.filter(s => s.type === 'QF')) {
    const pts = await calcPhasePoints(qf, regulation);
    (await getParticipants(qf.id)).forEach(p => { (driverMap[p.driverId] ||= blank(p)).qf += pts[p.driverId] ?? 0; });
  }
  for (const df of sessions.filter(s => s.type === 'DF')) {
    const pts = await calcPhasePoints(df, regulation);
    (await getParticipants(df.id)).forEach(p => { (driverMap[p.driverId] ||= blank(p)).df += pts[p.driverId] ?? 0; });
  }
  const fin = sessions.find(s => s.type === 'FIN');
  if (fin) {
    const pts = await calcPhasePoints(fin, regulation);
    (await getParticipants(fin.id)).forEach(p => { (driverMap[p.driverId] ||= blank(p)).fin = pts[p.driverId] ?? 0; });
  }

  return Object.values(driverMap)
    .map(d => ({ ...d, total: d.interim + d.qf + d.df + d.fin }))
    .filter(d => d.total > 0);
}

/** Classement de l'épreuve (meeting) trié + positions. */
export async function getMeetingStandings(meetingId, category, regulation) {
  const rows = await getMeetingPoints(meetingId, category, regulation);
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((d, i) => { d.position = (i > 0 && d.total === rows[i - 1].total) ? rows[i - 1].position : i + 1; });
  return rows;
}

/** Classement intermédiaire (manches qualificatives). */
export async function getInterim(meetingId, category, regulation) {
  const sessions = await getSessions(meetingId, category);
  const rows = await calcInterimStandings(db, sessions, regulation);
  return rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT CHAMPIONNAT (cumul tous meetings) — copie de championship.js
// ─────────────────────────────────────────────────────────

export async function getChampionshipStandings(meetings, category, regulation) {
  const champMap = {};
  for (const m of meetings) {
    const pts = await getMeetingPoints(m.id, category, regulation);
    pts.forEach(d => {
      const c = (champMap[d.driverId] ||= {
        driverId: d.driverId, carNumber: d.carNumber, firstName: d.firstName,
        lastName: d.lastName, meetingPts: {}, grandTotal: 0,
      });
      c.meetingPts[m.id] = d.total;
      c.grandTotal += d.total;
    });
  }
  const standings = Object.values(champMap).sort((a, b) => b.grandTotal - a.grandTotal);
  let pos = 1;
  standings.forEach((d, i) => {
    d.position = (i > 0 && d.grandTotal === standings[i - 1].grandTotal) ? standings[i - 1].position : pos;
    pos = i + 2;
  });
  return standings;
}

// ─────────────────────────────────────────────────────────
// GRILLE DE DÉPART — ordre (depuis classement) + disposition (règlement)
// ─────────────────────────────────────────────────────────

// Résultats d'une session triés comme le site (DNS/DSQ en fin, puis DNF, puis chrono).
async function getSessionResultsSorted(sessionId) {
  const res = await getResults(sessionId);
  return res.sort((a, b) => {
    const aZero = ['DNS', 'DSQ'].includes(a.status), bZero = ['DNS', 'DSQ'].includes(b.status);
    if (aZero && !bZero) return 1; if (!aZero && bZero) return -1;
    const aSp = ['DNF', 'DSQ_RACE'].includes(a.status), bSp = ['DNF', 'DSQ_RACE'].includes(b.status);
    if (aSp && !bSp) return 1; if (!aSp && bSp) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });
}

// Inverse l'ordre d'une référence (copie fidèle de timing.js).
function sortByReferenceInverse(raw, reference) {
  const posMap = {};
  reference.forEach((r, i) => { posMap[r.driverId] = i; });
  const numDesc = (a, b) => (Number(b.carNumber) || 0) - (Number(a.carNumber) || 0);
  const notInRef = raw.filter(p => posMap[p.driverId] === undefined).sort(numDesc);
  const inRef = raw.filter(p => posMap[p.driverId] !== undefined).sort((a, b) => posMap[b.driverId] - posMap[a.driverId]);
  return [...notInRef, ...inRef];
}

/**
 * Ordre de départ ("à passer"), RÉPLIQUE EXACTE de js/timing.js :
 *  - EC      → inverse du championnat (points cumulés des meetings précédents :
 *              nouveaux d'abord par n° décroissant, puis du - de pts au + de pts)
 *  - MQ N    → inverse des résultats de la référence (EC pour M1, MQ N-1 sinon)
 *  - QF/DF/FIN → classement intermédiaire (placement quinconce)
 */
export async function getGridOrder(session, meetingSessions, regulation, meetings) {
  const raw = await getParticipants(session.id);
  if (!raw.length) return [];
  const toSlot = (p, i) => ({ pos: i + 1, driverId: p.driverId, carNumber: p.carNumber, lastName: p.lastName });
  const numDesc = (a, b) => (Number(b.carNumber) || 0) - (Number(a.carNumber) || 0);

  if (session.type === 'EC') {
    const DF_PTS = [0, 10, 8, 6, 5, 4, 3, 2, 1], FIN_PTS = [0, 15, 12, 9, 7, 6, 5, 4, 3];
    const current = (meetings || []).find(m => m.id === session.meetingId);
    const past = (meetings || []).filter(m => m.id !== session.meetingId && (m.date || '') < (current?.date || '9999'));
    if (!past.length) return [...raw].sort(numDesc).map(toSlot);
    const pts = {};
    for (const m of past) {
      const ms = await getSessions(m.id, session.category);
      if (!ms.length) continue;
      (await calcInterimStandings(db, ms, regulation)).forEach(r => { pts[r.driverId] = (pts[r.driverId] || 0) + (r.interimPoints ?? 0); });
      for (const df of ms.filter(s => s.type === 'DF'))
        (await getResults(df.id)).filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms)
          .forEach((r, i) => { pts[r.driverId] = (pts[r.driverId] || 0) + (DF_PTS[i + 1] ?? 0); });
      const fin = ms.find(s => s.type === 'FIN');
      if (fin) (await getResults(fin.id)).filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms)
        .forEach((r, i) => { pts[r.driverId] = (pts[r.driverId] || 0) + (FIN_PTS[i + 1] ?? 0); });
    }
    const notRanked = raw.filter(p => !pts[p.driverId]).sort(numDesc);
    const ranked = raw.filter(p => pts[p.driverId]).sort((a, b) => pts[a.driverId] - pts[b.driverId]);
    return [...notRanked, ...ranked].map(toSlot);
  }

  if (session.type === 'MQ') {
    const ref = (session.num ?? 1) === 1
      ? meetingSessions.find(s => s.type === 'EC')
      : meetingSessions.find(s => s.type === 'MQ' && s.num === (session.num ?? 1) - 1);
    if (ref) {
      const refRes = await getSessionResultsSorted(ref.id);
      if (refRes.length) return sortByReferenceInverse(raw, refRes).map(toSlot);
    }
    return [...raw].sort(numDesc).map(toSlot);
  }

  // QF / DF / FIN : classement intermédiaire (meilleur = pole) pour la grille quinconce
  const interim = await calcInterimStandings(db, meetingSessions, regulation);
  const rank = {};
  interim.forEach(r => { rank[r.driverId] = r.position ?? 999; });
  const numCmp = (a, b) => String(a.carNumber).localeCompare(String(b.carNumber), 'fr', { numeric: true });
  return [...raw].sort((a, b) => (rank[a.driverId] ?? 999) - (rank[b.driverId] ?? 999) || numCmp(a, b)).map(toSlot);
}

// ─────────────────────────────────────────────────────────
// CLASSEMENTS "comme sur le site" pour la vue session (essais/manche)
// ─────────────────────────────────────────────────────────

// Libellés de statut identiques au site.
const STATUS_LABEL = { DNS: 'DNS', DNF: 'DNF', DSQ: 'DSQ HC', DSQ_RACE: 'DSQ EC' };
// Ordre d'affichage des statuts (après les finishers) — comme le site.
const STATUS_ORDER = { DNF: 1, DSQ_RACE: 2, DNS: 3, DSQ: 4 };

/** Classement essais : finishers (chrono + bonus), puis pilotes en statut (badge). */
export async function getEcRank(sessions, regulation) {
  const rows = await calcEcStandings(db, sessions, regulation);
  const fin = rows.filter(r => r.ms != null).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const out = fin.map(r => ({
    position: r.position, carNumber: r.carNumber, lastName: r.lastName,
    value: msToDisplay(r.ms), points: r.bonusPoints ? '+' + r.bonusPoints : '',
  }));
  rows.filter(r => r.ms == null && r.status)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9))
    .forEach(r => out.push({
      position: null, carNumber: r.carNumber, lastName: r.lastName,
      value: STATUS_LABEL[r.status] || r.status, points: '', status: r.status,
    }));
  return out;
}

/**
 * Classement d'une manche EN DIRECT, réplique fidèle de timing.js (pointsFromResult) :
 * le nombre d'engagés = nombre de résultats déjà saisis (points provisoires qui
 * convergent vers le définitif quand tous les pilotes sont chronométrés).
 */
export async function getMqRank(session, regulation) {
  const results = await getResults(session.id);
  const totalEngaged = results.length;   // = Object.keys(sessionResults).length côté site
  const fin = results.filter(r => r.ms != null && !r.status).sort((a, b) => a.ms - b.ms);
  const lead = fin[0]?.ms ?? 0;
  const out = fin.map((r, i) => ({
    position: i + 1, carNumber: r.carNumber, lastName: r.lastName,
    value: i === 0 ? msToDisplay(r.ms) : '+' + ((r.ms - lead) / 1000).toFixed(1),
    points: mqPoints(i + 1, regulation),
  }));
  results.filter(r => r.status)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9))
    .forEach(r => out.push({
      position: null, carNumber: r.carNumber, lastName: r.lastName,
      value: STATUS_LABEL[r.status] || r.status,
      points: calcStatusPoints(r.status, 'MQ', totalEngaged, regulation), status: r.status,
    }));
  return out;
}

/** Récupère le gridLayout du règlement pour un type de session. */
export function getGridLayout(regulation, sessionType) {
  return regulation?.sessionConfig?.[sessionType]?.gridLayout
      || { lanes: 5, rows: 3, positions: {} };
}
