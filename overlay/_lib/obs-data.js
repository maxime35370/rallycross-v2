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

// Ordre des sessions dans une épreuve, pour les classements « au moment de la session
// affichée » (on ne compte pas les phases postérieures).
const PHASE_ORDER = { EC: 0, MQ: 1, QF: 2, DF: 3, FIN: 4 };
const sessionRank = s => (PHASE_ORDER[s?.type] ?? 9) * 100 + (s?.num ?? 1);
/** Filtre les sessions jusqu'à `upTo` inclus (selon l'ordre EC<MQ<QF<DF<FIN). */
const upToSessions = (sessions, upTo) => upTo ? sessions.filter(s => sessionRank(s) <= sessionRank(upTo)) : sessions;

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

/**
 * Sessions dont les données influent sur le résultat d'un pronostic « au résultat »
 * → à surveiller en temps réel pour re-synchroniser le gagnant.
 *  'session'       → la session cible.
 *  'interim_after' → EC + manches 1..N (une pénalité sur l'une d'elles peut changer
 *                    le leader intermédiaire après la manche N).
 * @returns {Promise<string[]>} ids de sessions
 */
export async function pronoWatchSessionIds(prono) {
  const t = prono?.resultTarget || {};
  const sessions = await getSessions(prono.meetingId, prono.category);
  if (t.kind === 'session') {
    const s = findSession(sessions, t.sessionType, t.sessionNum);
    return s ? [s.id] : [];
  }
  if (t.kind === 'interim_after') {
    const n = t.sessionNum || 2;
    const mqs = sessions.filter(s => s.type === 'MQ').sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
    const target = mqs.filter(s => (s.num ?? 0) <= n).slice(-1)[0];
    if (!target) return [];
    return sessions.filter(s => sessionRank(s) <= sessionRank(target)).map(s => s.id);
  }
  return [];
}

/**
 * Classement intermédiaire APRÈS la manche N (ordonné par position), ou null si les
 * manches 1..N ne sont pas TOUTES complètes (anti-flicker : on n'affiche pas de
 * leader tant qu'une manche est en cours de saisie). Nécessite le règlement (points).
 */
async function interimStandingsAfter(meetingId, category, regulation, mqNum) {
  const sessions = await getSessions(meetingId, category);
  const mqs = sessions.filter(s => s.type === 'MQ').sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  const upToMqs = mqs.filter(s => (s.num ?? 0) <= mqNum);
  if (upToMqs.length < mqNum) return null;   // pas encore assez de manches créées
  for (const m of upToMqs) {   // chaque manche 1..N doit être entièrement saisie
    const [res, parts] = await Promise.all([getResults(m.id), getParticipants(m.id)]);
    if (!parts.length) return null;
    const entered = new Set(res.filter(r => r.ms != null || r.status).map(r => r.driverId));
    if (!parts.every(p => entered.has(p.driverId))) return null;   // manche en cours → on attend
  }
  const target = upToMqs[upToMqs.length - 1];
  const upto = sessions.filter(s => sessionRank(s) <= sessionRank(target));
  const rows = await calcInterimStandings(db, upto, regulation);
  return rows.slice().sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

/**
 * Vainqueur RÉEL d'un pronostic « au résultat », calculé depuis les données live
 * → suit l'évolution des classements (pénalités comprises).
 *  'session'       → P1 au chrono de la session, PARMI les pilotes proposés (sans règlement).
 *  'interim_after' → leader du classement intermédiaire après la manche N, PARMI les
 *                    pilotes proposés (nécessite `regulation` pour les points).
 * ANTI-FLICKER : ne renvoie un gagnant que lorsque la/les session(s) concernée(s)
 * sont COMPLÈTES (tous les pilotes attendus saisis). Sinon null.
 * @returns {Promise<string|null>}
 */
export async function computePronoWinner(prono, regulation) {
  const t = prono?.resultTarget || {};
  const opts = Array.isArray(prono.options) ? prono.options : [];
  if (!opts.length) return null;
  const optIds = new Set(opts.map(o => o.driverId));

  if (t.kind === 'session') {
    const sessions = await getSessions(prono.meetingId, prono.category);
    const s = findSession(sessions, t.sessionType, t.sessionNum);
    if (!s) return null;
    const [results, participants] = await Promise.all([getResults(s.id), getParticipants(s.id)]);
    const entered = new Set(results.filter(r => r.ms != null || r.status).map(r => r.driverId));
    // Série complète = tous les pilotes proposés QUI PARTICIPENT à la session ont un
    // résultat (temps ou statut). On n'attend PAS un pilote proposé absent des engagés
    // (ex. un favori DNS jamais aligné → aucun résultat ne viendra, aucune ligne à taguer) :
    // sinon le gagnant ne se calcule jamais. Repli sur les proposés si la liste d'engagés
    // n'est pas disponible.
    const partIds = participants.length ? new Set(participants.map(p => p.driverId)) : null;
    const waiting = partIds ? opts.filter(o => partIds.has(o.driverId)) : opts;
    if (!waiting.every(o => entered.has(o.driverId))) return null;   // saisie en cours → on attend
    // Gagnant = meilleur chrono PARMI les proposés ayant un temps valide (finisher « propre »).
    // On IGNORE les pilotes en statut (DNF / DNS / DSQ) au lieu d'abandonner le calcul quand
    // le tri en fait remonter un en tête. Vaut pour TOUTES les phases (EC / MQ / QF / DF / FIN).
    const w = sortRace(results.filter(r => optIds.has(r.driverId) && r.ms != null && !r.status))[0];
    return w?.driverId || null;   // aucun proposé n'a de temps valide → pas de gagnant auto
  }

  if (t.kind === 'interim_after') {
    const ordered = await interimStandingsAfter(prono.meetingId, prono.category, regulation, t.sessionNum || 2);
    if (!ordered) return null;   // manches pas encore toutes complètes
    const best = ordered.find(r => optIds.has(r.driverId));   // mieux classé parmi les pilotes proposés
    return best?.driverId || null;
  }

  return null;   // 'manual'
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

export async function getMeetingPoints(meetingId, category, regulation, upTo) {
  // upTo : ne compter que les sessions jusqu'à celle affichée (intermédiaire + QF/DF/FIN antérieurs)
  const sessions = upToSessions(await getSessions(meetingId, category), upTo);
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

/** Classement de l'épreuve (meeting) trié + positions. `upTo` : au moment de la session affichée. */
export async function getMeetingStandings(meetingId, category, regulation, upTo) {
  const rows = await getMeetingPoints(meetingId, category, regulation, upTo);
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
  // « au moment de la session » : on n'inclut pas les manches/phases postérieures
  const sessions = upToSessions(await getSessions(meetingId, category), currentSession);
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
    _origPos: r.position,   // position DÉPARTAGÉE par le site (tie-breaker), à conserver
    totalPoints: (r.totalPoints ?? 0) - (defPts[r.driverId] ?? 0) + (provPts[r.driverId] ?? 0),
  }));
  // tri : points (provisoires) puis ordre départagé du site (préserve le tie-breaker)
  rows.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0) || (a._origPos ?? 99) - (b._origPos ?? 99));
  let pos = 1;
  rows.forEach((r, i) => {
    // ex æquo SEULEMENT si le site ne les départage pas (mêmes points ET même position d'origine)
    if (i > 0 && !(r.totalPoints === rows[i - 1].totalPoints && r._origPos === rows[i - 1]._origPos)) pos = i + 1;
    r.position = pos;
    r.interimPoints = interimPoints(r.position, regulation);   // pts championnat cohérents avec la position
  });
  return rows;
}

/** Classement intermédiaire AVANT une manche (sessions strictement antérieures à
 *  `currentSession`, donc sans la manche en cours NI les suivantes). Réf. pour la "remontada". */
export async function getInterimBefore(meetingId, category, regulation, currentSession) {
  const sessions = (await getSessions(meetingId, category))
    .filter(s => sessionRank(s) < sessionRank(currentSession));
  const rows = await calcInterimStandings(db, sessions, regulation);
  return rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

/**
 * Points cumulés AVANT la manche en cours, SANS la règle d'éligibilité « ≥ 2 manches »
 * (contrairement à calcInterimStandings) : EC bonus + somme des points de chaque manche
 * antérieure, pour TOUS les pilotes ayant marqué. Sert de base au moteur de prédiction
 * (utilisable dès la 2e manche). @returns [{driverId, carNumber, lastName, firstName, total}]
 */
export async function getCumulBefore(meetingId, category, regulation, currentSession) {
  const sessions = await getSessions(meetingId, category);
  const prevMqs = sessions
    .filter(s => s.type === 'MQ' && sessionRank(s) < sessionRank(currentSession))
    .sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  const [ecRows, perManche] = await Promise.all([
    calcEcStandings(db, sessions, regulation).catch(() => []),
    Promise.all(prevMqs.map(m => calcMqStandings(db, m, regulation))),
  ]);
  const map = {};
  const add = (r, pts) => {
    const d = (map[r.driverId] ||= { driverId: r.driverId, carNumber: r.carNumber,
      lastName: r.lastName, firstName: r.firstName, total: 0 });
    d.total += pts;
  };
  ecRows.forEach(r => add(r, r.bonusPoints ?? 0));
  perManche.forEach(rows => rows.forEach(r => { if (r.points != null) add(r, r.points); }));
  return Object.values(map);
}

/**
 * Évolution du classement intermédiaire manche par manche : pour chaque pilote,
 * points cumulés (bonus essais + somme des points de manche) après chaque manche
 * disputée. Sert au graphique d'évolution (places = rang par points ; points = cumul).
 * @returns {{ series: string[], drivers: Array<{carNumber, lastName, pts:number[]}> }}
 */
export async function getInterimEvolution(meetingId, category, regulation, upTo) {
  const sessions = await getSessions(meetingId, category);
  let mqs = sessions.filter(s => s.type === 'MQ').sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  if (upTo?.type === 'MQ') mqs = mqs.filter(m => (m.num ?? 0) <= (upTo.num ?? 0));   // pas les manches postérieures
  const [ecRows, perManche] = await Promise.all([
    calcEcStandings(db, sessions, regulation).catch(() => []),
    Promise.all(mqs.map(m => calcMqStandings(db, m, regulation))),
  ]);
  const ec = {}; ecRows.forEach(r => { ec[r.driverId] = r.bonusPoints ?? 0; });
  const doneIdx = perManche.map((rows, i) => rows.some(r => r.points != null) ? i : -1).filter(i => i >= 0);
  if (doneIdx.length < 2) return { series: [], drivers: [] };   // graphique pertinent ≥ 2 manches
  const info = {};
  perManche.forEach(rows => rows.forEach(r => { if (!info[r.driverId]) info[r.driverId] = { carNumber: r.carNumber, lastName: r.lastName }; }));
  const drivers = Object.keys(info).map(id => {
    let acc = ec[id] ?? 0;
    const pts = doneIdx.map(i => { acc += (perManche[i].find(x => x.driverId === id)?.points ?? 0); return acc; });
    return { carNumber: info[id].carNumber, lastName: info[id].lastName, pts };
  });
  return { series: doneIdx.map((i, k) => 'M' + (mqs[i].num ?? k + 1)), drivers };
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT CHAMPIONNAT (cumul tous meetings) — copie de championship.js
// ─────────────────────────────────────────────────────────

/** Pénalités « points championnat » (niveau saison) : driverId → points à retirer.
 *  Doc id = `${championshipId}__${driverId}`, saisi côté régie (js/championship.js). */
async function getChampionshipPenalties(championshipId) {
  if (!championshipId) return {};
  try {
    const rows = await fsQuery('championshipPenalties', [['championshipId', '==', championshipId]]);
    const map = {};
    rows.forEach(r => { map[r.driverId] = Number(r.points) || 0; });
    return map;
  } catch { return {}; }
}

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
  // Pénalités saison retirées du total AVANT le tri (cohérent avec l'app admin) :
  // overlay, classement spectateur et cote des pronostics reflètent la sanction.
  const championshipId = (meetings || []).find(m => m.championshipId)?.championshipId || null;
  const penalties = await getChampionshipPenalties(championshipId);
  Object.values(champMap).forEach(d => { d.penalty = penalties[d.driverId] || 0; d.grandTotal -= d.penalty; });
  const standings = Object.values(champMap).sort((a, b) => b.grandTotal - a.grandTotal);
  let pos = 1;
  standings.forEach((d, i) => {
    d.position = (i > 0 && d.grandTotal === standings[i - 1].grandTotal) ? standings[i - 1].position : pos;
    pos = i + 2;
  });
  return standings;
}

/**
 * COTE de performance par pilote (rang de force) pour une épreuve/catégorie.
 * Combine la FORME DU MEETING (classement intermédiaire ; à défaut les essais chronos) —
 * pondérée le plus fort (60%) — et le CHAMPIONNAT saison (40%). Rang 1 = plus grand favori.
 * Sert de « cote » aux points pronostiqueurs : gagnant favori = peu de points, outsider = beaucoup.
 * @returns {Promise<Object>} { driverId: rangDeForce (1 = favori) }
 */
export async function getDriverStrength(meetingId, category, meetings, regulation) {
  const sessions = await getSessions(meetingId, category);
  // Forme du meeting : intermédiaire si dispo (≥ 2 manches), sinon essais chronos.
  const meetingRank = {};
  try {
    (await calcInterimStandings(db, sessions, regulation) || [])
      .forEach(r => { if (r.position != null) meetingRank[r.driverId] = r.position; });
  } catch {}
  if (!Object.keys(meetingRank).length) {
    try { (await getEcRank(sessions, regulation))
      .forEach(r => { if (r.position != null) meetingRank[r.driverId] = r.position; }); } catch {}
  }
  // Championnat (saison) : base de fond.
  const champRank = {};
  try { (await getChampionshipStandings(meetings || [], category, regulation))
    .forEach(d => { if (d.position != null) champRank[d.driverId] = d.position; }); } catch {}
  // Pondération : forme du meeting 60%, championnat 40% (l'un des deux si l'autre manque).
  const blended = [];
  new Set([...Object.keys(meetingRank), ...Object.keys(champRank)]).forEach(id => {
    const m = meetingRank[id], c = champRank[id];
    const v = (m != null && c != null) ? (0.6 * m + 0.4 * c) : (m != null ? m : c);
    if (v != null) blended.push([id, v]);
  });
  blended.sort((a, b) => a[1] - b[1]);   // plus fort (rang le plus bas) d'abord
  const out = {};
  blended.forEach(([id], i) => { out[id] = i + 1; });
  return out;
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
    // Effectif réduit : aucune demi-finale disputée (dfPos vide) → la grille
    // finale suit directement le classement intermédiaire (position départagée),
    // et non les points/positions de DF inexistants (sinon égalité = ordre numéro).
    if (!Object.keys(dfPos).length) {
      const rank = {};
      interimRows.forEach(r => { rank[r.driverId] = r.position ?? 999; });
      const numCmp = (a, b) => String(a.carNumber).localeCompare(String(b.carNumber), 'fr', { numeric: true });
      return [...raw].sort((a, b) => (rank[a.driverId] ?? 999) - (rank[b.driverId] ?? 999) || numCmp(a, b)).map(toSlot);
    }
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
    // tri par type de statut, puis par position manuelle (DNF 7e avant DNF 8e)
    .sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9)
                  || (a.manualPosition ?? 999) - (b.manualPosition ?? 999))
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

/**
 * Données « fiche pilote / duel » pour un ou deux pilotes (même catégorie) :
 * position championnat (+points, écart au leader), position épreuve, meilleur
 * chrono du meeting, nb de victoires de manche et « forme » (place par manche).
 * Standings championnat/épreuve calculés une seule fois pour tous les pilotes.
 * @returns {{ drivers: Array }}
 */
export async function getFicheData(meetingId, category, regulation, driverIds, meetings) {
  const ids = [...new Set((driverIds || []).filter(Boolean))];
  if (!ids.length) return { drivers: [] };
  const sessions = await getSessions(meetingId, category);
  const mqs = sessions.filter(s => s.type === 'MQ').sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  const [champ, meet, mqRanks, mqResults] = await Promise.all([
    getChampionshipStandings(meetings || [], category, regulation).catch(() => []),
    getMeetingStandings(meetingId, category, regulation).catch(() => []),
    Promise.all(mqs.map(m => getMqRank(m, regulation).catch(() => []))),
    Promise.all(mqs.map(m => getResults(m.id).catch(() => []))),
  ]);
  const leaderPts = champ[0]?.grandTotal ?? 0;
  const cMap = {}, mMap = {};
  champ.forEach(r => { cMap[r.driverId] = r; });
  meet.forEach(r => { mMap[r.driverId] = r; });

  const drivers = ids.map(id => {
    const c = cMap[id], m = mMap[id];
    let carNumber, lastName, firstName, bestMs = null, wins = 0;
    const forme = mqs.map((mq, i) => {
      const rk = mqRanks[i].find(x => x.driverId === id);
      if (rk && rk.position === 1) wins++;
      return { manche: mq.num ?? i + 1, pos: rk?.position ?? null, status: rk?.status ?? null };
    });
    mqResults.forEach(res => res.forEach(r => {
      if (r.driverId === id) {
        carNumber = r.carNumber; lastName = r.lastName; firstName = r.firstName;
        if (r.ms && !r.status && (bestMs === null || r.ms < bestMs)) bestMs = r.ms;
      }
    }));
    return {
      driverId: id, carNumber: carNumber ?? c?.carNumber ?? m?.carNumber,
      lastName: lastName ?? c?.lastName ?? m?.lastName, firstName,
      champPos: c?.position ?? null, champPts: c?.grandTotal ?? 0,
      champGap: c ? Math.max(0, leaderPts - c.grandTotal) : null,
      meetPos: m?.position ?? null, bestMs, wins, forme,
    };
  });
  return { drivers };
}

/** Récupère le gridLayout du règlement pour un type de session. */
export function getGridLayout(regulation, sessionType) {
  return regulation?.sessionConfig?.[sessionType]?.gridLayout
      || { lanes: 5, rows: 3, positions: {} };
}

/**
 * Nombre de qualifiés pour la phase finale (cutoff « place qualificative »),
 * d'après le RÈGLEMENT : capacité de la phase qui suit directement les manches
 * (quarts si activés, sinon demi-finales) = nb de séries × places par série.
 * Ex. FFSA : 2 demi-finales × 8 = 16. Renvoie 0 si indéterminable.
 */
export function getQualifCutoff(regulation) {
  const sc = regulation?.sessionConfig || {};
  const cap = cfg => cfg?.gridSize
    || Object.keys(cfg?.gridLayout?.positions || {}).length
    || ((cfg?.gridLayout?.lanes || 0) * (cfg?.gridLayout?.rows || 0));
  if (sc.QF?.enabled) { const c = cap(sc.QF); if (c) return (sc.QF.count || 4) * c; }
  const c = cap(sc.DF); if (c) return (sc.DF?.count || 2) * c;
  return 0;
}
