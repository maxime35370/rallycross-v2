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
  qfPoints, dfPoints, finPoints, calcStatusPoints,
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

/**
 * Ordre de départ AUTO d'une session. Règles :
 *  - EC (essais)      → ordre INVERSE du classement championnat (dernier = 1er)
 *  - MQ (manche N)    → classement de la manche N-1, INVERSÉ (dernier = 1er)
 *                       (manche 1 : essais inversés, sinon championnat inversé)
 *  - QF/DF/FIN        → classement intermédiaire (meilleur = pole)
 * Renvoie [{pos, driverId, carNumber, lastName}]. L'opérateur peut corriger à la main.
 */
export async function getGridOrder(session, meetingSessions, regulation, meetings) {
  const participants = await getParticipants(session.id);
  if (!participants.length) return [];
  const numCmp = (a, b) => String(a.carNumber).localeCompare(String(b.carNumber), 'fr', { numeric: true });
  const rank = {};
  let dir = 'asc';   // 'asc' = meilleur en tête ; 'desc' = dernier en tête (essais/manches)

  if (session.type === 'EC') {
    const champ = meetings ? await getChampionshipStandings(meetings, session.category, regulation) : [];
    champ.forEach(r => { rank[r.driverId] = r.position ?? 0; });
    dir = 'desc';
  } else if (session.type === 'MQ') {
    const prev = meetingSessions.find(s => s.type === 'MQ' && s.num === (session.num ?? 1) - 1)
              || meetingSessions.find(s => s.type === 'EC');
    let standings = [];
    if (prev) standings = prev.type === 'EC'
      ? await calcEcStandings(db, meetingSessions, regulation)
      : await calcMqStandings(db, prev, regulation);
    if (!standings.length && meetings) standings = await getChampionshipStandings(meetings, session.category, regulation);
    standings.forEach(r => { rank[r.driverId] = r.position ?? 0; });
    dir = 'desc';
  } else {
    const interim = await calcInterimStandings(db, meetingSessions, regulation);
    interim.forEach(r => { rank[r.driverId] = r.position ?? 999; });
    dir = 'asc';
  }

  participants.sort((a, b) => dir === 'desc'
    ? ((rank[b.driverId] ?? -1) - (rank[a.driverId] ?? -1)) || numCmp(a, b)   // dernier/inconnu en tête
    : ((rank[a.driverId] ?? 999) - (rank[b.driverId] ?? 999)) || numCmp(a, b)); // meilleur en tête
  return participants.map((p, i) => ({
    pos: i + 1, driverId: p.driverId, carNumber: p.carNumber, lastName: p.lastName,
  }));
}

// ─────────────────────────────────────────────────────────
// CLASSEMENTS "comme sur le site" pour la vue session (essais/manche)
// ─────────────────────────────────────────────────────────

/** Classement essais : pilotes ayant un chrono, triés, avec points bonus. */
export async function getEcRank(sessions, regulation) {
  const rows = await calcEcStandings(db, sessions, regulation);
  return rows.filter(r => r.ms != null)
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
    .map(r => ({
      position: r.position, carNumber: r.carNumber, lastName: r.lastName,
      value: msToDisplay(r.ms), points: r.bonusPoints ? '+' + r.bonusPoints : '',
    }));
}

/** Classement d'une manche : finishers triés (temps/écart) + points. */
export async function getMqRank(session, regulation) {
  const rows = await calcMqStandings(db, session, regulation);
  const fin = rows.filter(r => r.ms != null && !r.status).sort((a, b) => a.ms - b.ms);
  const lead = fin[0]?.ms ?? 0;
  return fin.map((r, i) => ({
    position: r.position ?? i + 1, carNumber: r.carNumber, lastName: r.lastName,
    value: i === 0 ? msToDisplay(r.ms) : '+' + ((r.ms - lead) / 1000).toFixed(1),
    points: r.points ?? '',
  }));
}

/** Récupère le gridLayout du règlement pour un type de session. */
export function getGridLayout(regulation, sessionType) {
  return regulation?.sessionConfig?.[sessionType]?.gridLayout
      || { lanes: 5, rows: 3, positions: {} };
}
