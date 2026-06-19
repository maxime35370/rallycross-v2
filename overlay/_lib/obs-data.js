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
  calcInterimStandings, calcEcStandings, calcMqStandings,
  mqPoints, qfPoints, dfPoints, finPoints, interimPoints, calcStatusPoints,
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
  const [results, participants] = await Promise.all([getResults(session.id), getParticipants(session.id)]);
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

  // Intermédiaire + phases (QF/DF/FIN) calculés en parallèle (lectures Firestore concurrentes).
  const phaseSessions = sessions.filter(s => ['QF', 'DF', 'FIN'].includes(s.type));
  const [interimRows, phases] = await Promise.all([
    calcInterimStandings(db, sessions, regulation),
    Promise.all(phaseSessions.map(async s => {
      const [pts, parts] = await Promise.all([calcPhasePoints(s, regulation), getParticipants(s.id)]);
      return { field: s.type === 'FIN' ? 'fin' : s.type === 'DF' ? 'df' : 'qf', assign: s.type === 'FIN', pts, parts };
    })),
  ]);

  const driverMap = {};
  interimRows.forEach(r => {
    driverMap[r.driverId] = {
      driverId: r.driverId, carNumber: r.carNumber, firstName: r.firstName, lastName: r.lastName,
      interim: r.interimPoints ?? 0, qf: 0, df: 0, fin: 0,
    };
  });
  const blank = p => ({ driverId: p.driverId, carNumber: p.carNumber, firstName: p.firstName,
    lastName: p.lastName, interim: 0, qf: 0, df: 0, fin: 0 });

  phases.forEach(({ field, assign, pts, parts }) => {
    parts.forEach(p => {
      const d = (driverMap[p.driverId] ||= blank(p));
      if (assign) d[field] = pts[p.driverId] ?? 0;     // FIN : session unique → assignation
      else        d[field] += pts[p.driverId] ?? 0;    // QF/DF : cumul
    });
  });

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

/**
 * Classement intermédiaire "live" : comme getInterim, mais les points de la manche
 * EN COURS sont provisoires (basés sur les chronos déjà saisis — comme la colonne
 * manche / la vue chrono du site) au lieu de la valeur définitive (plateau complet).
 * Les deux convergent en fin de manche. L'ajustement n'opère que pour une MQ en cours.
 * @param {object} currentSession - session affichée
 * @param {Array} [provRank] - getMqRank déjà calculé (pour coller exactement à la colonne manche)
 */
export async function getInterimLive(meetingId, category, regulation, currentSession, provRank) {
  const sessions = await getSessions(meetingId, category);
  const interimRows = await calcInterimStandings(db, sessions, regulation);
  if (currentSession?.type !== 'MQ') {
    return interimRows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  }
  // points définitifs (plateau complet) vs provisoires (chronos saisis) de la manche en cours
  const [defRows, prov] = await Promise.all([
    calcMqStandings(db, currentSession, regulation),
    provRank ? Promise.resolve(provRank) : getMqRank(currentSession, regulation),
  ]);
  const numPts = r => (typeof r.points === 'number' ? r.points : 0);
  const defPts = {}; defRows.forEach(r => { defPts[r.driverId] = numPts(r); });
  const provPts = {}; prov.forEach(r => { if (r.driverId) provPts[r.driverId] = numPts(r); });
  const rows = interimRows.map(r => ({
    ...r,
    totalPoints: (r.totalPoints ?? 0) - (defPts[r.driverId] ?? 0) + (provPts[r.driverId] ?? 0),
  }));
  rows.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
  let p = 1;
  rows.forEach((r, i) => {
    r.position = (i > 0 && r.totalPoints === rows[i - 1].totalPoints) ? rows[i - 1].position : p;
    p = i + 2;
    r.interimPoints = interimPoints(r.position, regulation);   // pts championnat cohérents avec la position live
  });
  return rows;
}

/** Classement intermédiaire AVANT une manche (= en excluant cette session). Réf. pour la "remontada". */
export async function getInterimBefore(meetingId, category, regulation, excludeSessionId) {
  const sessions = (await getSessions(meetingId, category)).filter(s => s.id !== excludeSessionId);
  const rows = await calcInterimStandings(db, sessions, regulation);
  return rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT CHAMPIONNAT (cumul tous meetings) — copie de championship.js
// ─────────────────────────────────────────────────────────

export async function getChampionshipStandings(meetings, category, regulation) {
  // Points de chaque meeting en parallèle (au lieu d'enchaîner les lectures une par une).
  const perMeeting = await Promise.all(meetings.map(m => getMeetingPoints(m.id, category, regulation)));
  const champMap = {};
  meetings.forEach((m, i) => {
    perMeeting[i].forEach(d => {
      const c = (champMap[d.driverId] ||= {
        driverId: d.driverId, carNumber: d.carNumber, firstName: d.firstName,
        lastName: d.lastName, meetingPts: {}, grandTotal: 0,
      });
      c.meetingPts[m.id] = d.total;
      c.grandTotal += d.total;
    });
  });
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
    // Points cumulés des meetings précédents — meetings traités en parallèle, puis fusion (additive).
    const partials = await Promise.all(past.map(async m => {
      const ms = await getSessions(m.id, session.category);
      if (!ms.length) return {};
      const local = {};
      const dfs = ms.filter(s => s.type === 'DF');
      const fin = ms.find(s => s.type === 'FIN');
      const [interim, ...reads] = await Promise.all([
        calcInterimStandings(db, ms, regulation),
        ...dfs.map(df => getResults(df.id)),
        ...(fin ? [getResults(fin.id)] : []),
      ]);
      interim.forEach(r => { local[r.driverId] = (local[r.driverId] || 0) + (r.interimPoints ?? 0); });
      dfs.forEach((df, i) => {
        reads[i].filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms)
          .forEach((r, k) => { local[r.driverId] = (local[r.driverId] || 0) + (DF_PTS[k + 1] ?? 0); });
      });
      if (fin) reads[dfs.length].filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms)
        .forEach((r, k) => { local[r.driverId] = (local[r.driverId] || 0) + (FIN_PTS[k + 1] ?? 0); });
      return local;
    }));
    const pts = {};
    partials.forEach(local => { for (const id in local) pts[id] = (pts[id] || 0) + local[id]; });
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

  // FIN : grille = répartition des qualifiés des demi-finales — RÉPLIQUE EXACTE de
  // timing.js (generateStartGrid). Tri : position d'arrivée en DF, puis points
  // (interim + DF) décroissants, puis temps en DF. (≠ simple classement intermédiaire :
  // un pilote 1er au championnat mais 4e de sa demi part en 4e ligne.)
  if (session.type === 'FIN') {
    const dfSessions = meetingSessions.filter(s => s.type === 'DF');
    // Lectures des demi-finales + intermédiaire en parallèle.
    const [dfData, interimRows] = await Promise.all([
      Promise.all(dfSessions.map(async df => {
        const [res, parts] = await Promise.all([getResults(df.id), getParticipants(df.id)]);
        return { res, parts };
      })),
      calcInterimStandings(db, meetingSessions, regulation),
    ]);
    const dfPos = {}, dfPts = {}, dfMs = {};
    dfData.forEach(({ res, parts }) => {
      const resMap = {};
      res.forEach(r => { resMap[r.driverId] = r; });
      parts
        .map(p => ({ driverId: p.driverId, ms: resMap[p.driverId]?.ms ?? null }))
        .filter(r => r.ms)
        .sort((a, b) => a.ms - b.ms)
        .forEach((r, i) => {
          dfPos[r.driverId] = i + 1;
          dfPts[r.driverId] = resMap[r.driverId]?.points ?? 0;
          dfMs[r.driverId]  = resMap[r.driverId]?.ms ?? Infinity;
        });
    });
    const intPts = {};
    interimRows.forEach(r => { intPts[r.driverId] = r.interimPoints ?? 0; });
    const total = id => (intPts[id] ?? 0) + (dfPts[id] ?? 0);
    return [...raw].sort((a, b) => {
      const pa = dfPos[a.driverId] ?? 99, pb = dfPos[b.driverId] ?? 99;
      if (pa !== pb) return pa - pb;
      const ta = total(a.driverId), tb = total(b.driverId);
      if (ta !== tb) return tb - ta;
      return (dfMs[a.driverId] ?? Infinity) - (dfMs[b.driverId] ?? Infinity);
    }).map(toSlot);
  }

  // QF / DF : classement intermédiaire (meilleur = pole) pour la grille quinconce
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
    driverId: r.driverId, position: r.position, carNumber: r.carNumber, lastName: r.lastName,
    value: msToDisplay(r.ms), points: r.bonusPoints ? '+' + r.bonusPoints : '',
  }));
  rows.filter(r => r.ms == null && r.status)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9))
    .forEach(r => out.push({
      driverId: r.driverId, position: null, carNumber: r.carNumber, lastName: r.lastName,
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
    driverId: r.driverId, position: i + 1, carNumber: r.carNumber, lastName: r.lastName,
    value: i === 0 ? msToDisplay(r.ms) : '+' + ((r.ms - lead) / 1000).toFixed(1),
    points: mqPoints(i + 1, regulation),
  }));
  results.filter(r => r.status)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9))
    .forEach(r => out.push({
      driverId: r.driverId, position: null, carNumber: r.carNumber, lastName: r.lastName,
      value: STATUS_LABEL[r.status] || r.status,
      points: calcStatusPoints(r.status, 'MQ', totalEngaged, regulation), status: r.status,
    }));
  return out;
}

/**
 * Classement d'une phase (QF / DF / FIN) EN DIRECT : finishers triés par chrono +
 * pilotes en statut, avec les points de la phase (barème du règlement). Réplique
 * fidèle de championship.js (calcPhasePoints) + affichage façon getMqRank.
 * Le nombre d'engagés (pour les statuts) = nombre de participants à la session.
 */
export async function getPhaseRank(session, regulation) {
  const [results, participants] = await Promise.all([getResults(session.id), getParticipants(session.id)]);
  const totalEngaged = participants.length || results.length;
  const ptsFn = session.type === 'DF' ? (p => dfPoints(p, regulation))
              : session.type === 'QF' ? (p => qfPoints(p, regulation))
              : (p => finPoints(p, regulation));
  const fin = results.filter(r => r.ms != null && !r.status).sort((a, b) => a.ms - b.ms);
  const lead = fin[0]?.ms ?? 0;
  const out = fin.map((r, i) => ({
    driverId: r.driverId, position: i + 1, carNumber: r.carNumber, lastName: r.lastName,
    value: i === 0 ? msToDisplay(r.ms) : '+' + ((r.ms - lead) / 1000).toFixed(1),
    points: ptsFn(i + 1),
  }));
  results.filter(r => r.status)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9))
    .forEach(r => out.push({
      driverId: r.driverId, position: null, carNumber: r.carNumber, lastName: r.lastName,
      value: STATUS_LABEL[r.status] || r.status,
      // DNF avec position manuelle → points de cette position, sinon points de statut
      points: r.status === 'DNF' && r.manualPosition
        ? ptsFn(r.manualPosition)
        : calcStatusPoints(r.status, session.type, totalEngaged, regulation),
      status: r.status,
    }));
  return out;
}

/** Récupère le gridLayout du règlement pour un type de session. */
export function getGridLayout(regulation, sessionType) {
  return regulation?.sessionConfig?.[sessionType]?.gridLayout
      || { lanes: 5, rows: 3, positions: {} };
}
