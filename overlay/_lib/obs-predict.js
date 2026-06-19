/* ═══════════════════════════════════════════════
   OBS-PREDICT.JS — Moteur de prédiction d'objectifs (scénarios live)
   Fonctions pures : (classement + barème) → scénario. Aucun accès Firestore :
   le routeur (live.html) fournit le classement déjà calculé (obs-data.js) et
   le barème vient du règlement (calc.js).

   Deux niveaux :
   • NIVEAU 1 — manche : objectifs sur le classement INTERMÉDIAIRE du meeting
     (prendre/garder la tête, atteindre/conserver une place qualificative),
     à partir des points de la manche en cours.
   • NIVEAU 2 — phase finale : objectifs sur le CHAMPIONNAT, à partir des
     points de la session finale (QF/DF/Finale) en cours.

   Le cœur calcule, pour un pilote D et une position cible T :
   • SÉCURISÉ : la pire place que D peut faire en garantissant ≤ T quoi qu'il
     arrive (cas le plus défavorable pour D = adversaires maximisés).
   • ATTEIGNABLE : peut-il encore atteindre ≤ T au mieux (adversaires minimisés)
     et que lui faut-il.
═══════════════════════════════════════════════ */

import { mqPoints, qfPoints, dfPoints, finPoints, calcStatusPoints } from '../../js/calc.js';

// ─────────────────────────────────────────────────────────
// BARÈMES (points P1..PN d'une session)
// ─────────────────────────────────────────────────────────
function mancheScale(n, regulation) {
  const out = [];
  for (let p = 1; p <= Math.max(1, n); p++) out.push(mqPoints(p, regulation));
  return out;
}
/** Barème d'une phase finale (QF/DF/FIN) pour les positions 1..n. */
export function phaseScale(sessionType, n, regulation) {
  const f = sessionType === 'FIN' ? finPoints : sessionType === 'DF' ? dfPoints : qfPoints;
  const out = [];
  for (let p = 1; p <= Math.max(1, n); p++) out.push(f(p, regulation));
  return out;
}

// ─────────────────────────────────────────────────────────
// APPARIEMENTS GLOUTONS (optimaux)
// ─────────────────────────────────────────────────────────
/** Nb max de "besoins" satisfaits par des "créneaux" distincts (créneau ≥ besoin). */
function maxGE(needs, slots) {
  const ns = [...needs].sort((a, b) => a - b);
  const ss = [...slots].sort((a, b) => a - b);
  let i = 0, c = 0;
  for (let j = 0; j < ss.length && i < ns.length; j++) {
    if (ss[j] >= ns[i]) { c++; i++; }
  }
  return c;
}
/** Nb max de rivaux "sauvés" (un créneau distinct avec créneau ≤ plafond). */
function maxLE(caps, slots) {
  const cs = [...caps].sort((a, b) => a - b);
  const ss = [...slots].sort((a, b) => a - b);
  let j = 0, c = 0;
  for (let i = 0; i < cs.length; i++) {
    if (j < ss.length && ss[j] <= cs[i]) { c++; j++; }
  }
  return c;
}

/**
 * Place finale de D s'il marque `dGain`, les rivaux se partageant `slots`.
 * mode 'worst' : adversaire MAXIMISE les rivaux ≥ D (above-or-tie, pessimiste).
 * mode 'best'  : on MINIMISE les rivaux > D (strict, optimiste — égalité = OK pour D).
 *  - `fixedRivals` : rivaux dont le total ne bouge plus (hors session, niveau 2).
 */
function fieldPos(dTotal, dGain, rivals, slots, mode, fixedRivals = []) {
  const dFinal = dTotal + dGain;
  if (mode === 'worst') {
    const fixedAbove = fixedRivals.filter(r => (r.total ?? 0) >= dFinal).length;
    const needs = rivals.map(r => dFinal - (r.total ?? 0));   // créneau ≥ besoin ⇒ rival ≥ D
    return fixedAbove + maxGE(needs, slots) + 1;
  }
  const fixedAbove = fixedRivals.filter(r => (r.total ?? 0) > dFinal).length;
  const caps = rivals.map(r => dFinal - (r.total ?? 0));       // créneau ≤ plafond ⇒ rival ≤ D (sauvé)
  const saved = maxLE(caps, slots);
  return fixedAbove + (rivals.length - saved) + 1;
}

// ─────────────────────────────────────────────────────────
// MISE EN FORME (français)
// ─────────────────────────────────────────────────────────
const U = s => (s || '').toString().toUpperCase();
const drv = r => `N°${r.carNumber} ${U(r.lastName)}`;
const Pn  = idx => 'P' + (idx + 1);                 // index 0-based → "P1"
const sg  = g => (g > 0 ? `${g} pt${g > 1 ? 's' : ''}` : g === 0 ? 'à égalité' : `${-g} pt${-g < -1 ? 's' : ''}`);

const cap1 = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const winOrPos = (idx, word) => idx === 0 ? `gagner ${word}` : `finir au moins ${Pn(idx)}`;

/**
 * Construit l'objet d'affichage à partir des grandeurs calculées.
 *
 * Principe des énoncés :
 *  • `minSecureIdx` = pire place que D peut faire en GARANTISSANT ≤ T quoi qu'il
 *    arrive → énoncé ferme « doit finir au moins Pn ».
 *  • si aucune place ne garantit (même la victoire), on bascule sur un énoncé
 *    CONDITIONNEL « doit gagner ET que {rival} ne fasse pas mieux que Pk »
 *    (réaliste, pas optimiste à l'excès).
 *
 * @returns {{ok, scope, objectiveLabel, driver, meta, state, pill:{text,tone}, lines:[{icon,text}]}}
 */
function frScenario(o) {
  const { scope, goal, curPos, dTotal, scale, rival, gap,
          minSecureIdx, securedIfLast, securedIfDnf, reachable, rivalCeilIdx, inBand } = o;
  const lines = [];
  let state, pill;
  const D = o.driver;
  const word = o.raceWord || (scope === 'CHAMPIONNAT' ? 'la finale' : 'la manche');
  const threat = rival ? `${drv(rival)} (${sg(gap)})` : '';
  // énoncé conditionnel commun (objectif atteignable seulement avec un coup de pouce)
  const conditional = () => {
    const rc = rivalCeilIdx != null && rival
      ? ` et que ${drv(rival)} ne fasse pas mieux que ${Pn(rivalCeilIdx)}`
      : (rival ? ` et un faux pas de ${drv(rival)}` : '');
    return `${drv(D)} doit gagner ${word}${rc}.`;
  };

  if (inBand) {
    if (securedIfDnf) {
      state = 'locked'; pill = { text: 'OBJECTIF ACQUIS', tone: 'good' };
      lines.push({ icon: '🏆', text: `${drv(D)} a verrouillé ${goal} : plus rien ne peut l'en déloger.` });
    } else if (securedIfLast) {
      state = 'safe'; pill = { text: 'QUASI ASSURÉ', tone: 'good' };
      lines.push({ icon: '🏆', text: `${drv(D)} tient ${goal} — seul un abandon pourrait l'inquiéter.` });
      if (rival) lines.push({ icon: '🏁', text: `Premier poursuivant : ${threat}.` });
    } else if (minSecureIdx !== null) {
      state = 'defend'; pill = { text: 'À DÉFENDRE', tone: 'warn' };
      lines.push({ icon: '🛡️', text: `Pour garder ${goal}, ${drv(D)} doit ${winOrPos(minSecureIdx, word)} (≥ ${scale[minSecureIdx]} pts).` });
      if (rival) lines.push({ icon: '🏁', text: `Menace directe : ${threat}.` });
    } else {
      state = 'atrisk'; pill = { text: 'SOUS PRESSION', tone: 'warn' };
      lines.push({ icon: '⚠️', text: `${drv(D)} ne peut plus garantir ${goal} seul : ${conditional()}` });
    }
  } else {
    if (minSecureIdx !== null) {
      state = 'chase'; pill = { text: "C'EST JOUABLE", tone: 'live' };
      lines.push({ icon: '🎯', text: `Pour prendre ${goal}, ${drv(D)} doit ${winOrPos(minSecureIdx, word)} (≥ ${scale[minSecureIdx]} pts).` });
      if (rival) lines.push({ icon: '🏁', text: `À reprendre sur ${threat}.` });
    } else if (reachable) {
      state = 'open'; pill = { text: "ENCORE POSSIBLE", tone: 'live' };
      lines.push({ icon: '🎯', text: `${cap1(goal)} reste jouable : ${conditional()}` });
    } else {
      state = 'lost'; pill = { text: "HORS D'ATTEINTE", tone: 'bad' };
      const here = scope === 'CHAMPIONNAT' ? 'sur cette finale' : 'cette manche';
      lines.push({ icon: '🔒', text: `${cap1(goal)} est hors de portée ${here} pour ${drv(D)}${rival ? ` (${sg(gap)} sur ${drv(rival)})` : ''}.` });
    }
  }

  return {
    ok: true, scope, objectiveLabel: o.objectiveLabel, driver: D,
    meta: `Actuellement P${curPos} · ${dTotal} pts`,
    state, pill, lines,
  };
}

// ─────────────────────────────────────────────────────────
// MOTEUR GÉNÉRIQUE (cible de position T sur un classement)
// ─────────────────────────────────────────────────────────
/**
 * @param rows   classement courant : [{driverId, carNumber, lastName, total}]
 *               `total` = métrique avant la session prédite (intermédiaire ou
 *               championnat). Les places sont recalculées par total décroissant.
 * @param scale  barème de la session prédite (points P1..PN).
 * @param fixedIds  (niveau 2) ids des pilotes dont le total ne bouge pas
 *               (absents de la session finale). Vide ⇒ tout le plateau marque.
 */
function predictTarget(rows0, driverId, target, scale, scope, goalFor, objectiveLabel, fixedIds = null) {
  const rows = (rows0 || []).filter(r => r && r.driverId != null)
    .map(r => ({ ...r, total: r.total ?? 0 }))
    .sort((a, b) => b.total - a.total);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const D = rows.find(r => r.driverId === driverId);
  if (!D) return { ok: false };

  const N = rows.length;
  const T = Math.max(1, Math.min(target || 1, N));
  const dTotal = D.total;
  const curPos = D.rank;
  const goal = goalFor(T);

  // rivaux mobiles (qui marquent dans la session) vs fixes (niveau 2 hors finale)
  const others = rows.filter(r => r.driverId !== driverId);
  const fixedSet = fixedIds ? new Set(fixedIds) : null;
  const moving = fixedSet ? others.filter(r => fixedSet.has(r.driverId)) : others;
  const fixed  = fixedSet ? others.filter(r => !fixedSet.has(r.driverId)) : [];

  // créneaux de points disponibles dans la session pour les rivaux mobiles :
  // autant que de pilotes qui marquent (D + mobiles), donc on prend les
  // premières places du barème.
  const nScoring = moving.length + 1;
  const fullSlots = scale.slice(0, Math.max(1, nScoring));
  const lastIdx = fullSlots.length - 1;
  const dnfPts = scope === 'INTERMÉDIAIRE' ? calcStatusPoints('DNF', 'MQ', N, undefined) : 0;

  const posAt = (pIdx, mode) => {
    const slots = fullSlots.slice(); slots.splice(pIdx, 1);
    return fieldPos(dTotal, fullSlots[pIdx], moving, slots, mode, fixed);
  };

  // SÉCURISÉ : pire place encore garantie ≤ T
  let minSecureIdx = null;
  for (let p = lastIdx; p >= 0; p--) { if (posAt(p, 'worst') <= T) { minSecureIdx = p; break; } }
  const securedIfLast = minSecureIdx === lastIdx;
  const securedIfDnf = fieldPos(dTotal, dnfPts, moving, fullSlots.slice(), 'worst', fixed) <= T;

  // ATTEIGNABLE (au mieux) : existe-t-il une place de D donnant ≤ T si les rivaux faiblissent ?
  let reachable = false;
  for (let p = 0; p <= lastIdx; p++) { if (posAt(p, 'best') <= T) { reachable = true; break; } }

  const inBand = curPos <= T;
  // rival clé : en bande → 1er hors-bande (menace) ; sinon → détenteur de la place T (à dépasser)
  let rival = null, gap = null;
  if (inBand) {
    rival = rows[T] && rows[T].driverId !== driverId ? rows[T] : (rows[T + 1] || null);
    if (rival) gap = dTotal - rival.total;
  } else {
    rival = rows[T - 1] || null;
    if (rival) gap = rival.total - dTotal;
  }

  // pour l'énoncé conditionnel : si D gagne, pire place que le rival clé peut
  // prendre en restant DERRIÈRE D (barème décroissant → 1re place qui passe sous D).
  let rivalCeilIdx = null;
  if (rival) {
    const dWin = dTotal + fullSlots[0];
    for (let idx = 0; idx < fullSlots.length; idx++) {
      if (fullSlots[idx] < dWin - rival.total) { rivalCeilIdx = idx; break; }
    }
  }

  return frScenario({
    scope, goal, objectiveLabel, driver: D, curPos, dTotal, scale: fullSlots,
    rival, gap, minSecureIdx, securedIfLast, securedIfDnf, reachable, rivalCeilIdx, inBand,
  });
}

// ─────────────────────────────────────────────────────────
// NIVEAU 1 — MANCHE (classement intermédiaire)
// ─────────────────────────────────────────────────────────
/**
 * @param standings classement intermédiaire AVANT la manche prédite :
 *                  [{driverId, carNumber, lastName, total}]
 * @param target    1 = tête de l'intermédiaire ; N = place qualificative (cutoff)
 * @param kind      'p1' | 'qualif' (libellé)
 */
export function predictManche(standings, driverId, target, regulation, kind = 'p1') {
  const scale = mancheScale((standings || []).length, regulation);
  const goalFor = T => kind === 'qualif'
    ? (T <= 1 ? 'la qualification' : `une place dans les ${T} qualifiés`)
    : "la tête de l'intermédiaire";
  const objectiveLabel = kind === 'qualif' ? `Place qualificative · top ${target}` : "Tête de l'intermédiaire";
  return predictTarget(standings, driverId, target, scale, 'INTERMÉDIAIRE', goalFor, objectiveLabel);
}

// ─────────────────────────────────────────────────────────
// NIVEAU 2 — PHASE FINALE (championnat)
// ─────────────────────────────────────────────────────────
/**
 * @param standings classement championnat AVANT les points de la session :
 *                  [{driverId, carNumber, lastName, total}] (total = grandTotal)
 * @param sessionScale barème de la session (finPoints/dfPoints… P1..PN)
 * @param inSessionIds ids des pilotes ENGAGÉS dans la session (seuls eux marquent)
 * @param kind     'champ_p1' (T=1) | 'champ_top3' (T=3)
 */
export function predictChampSession(standings, driverId, sessionScale, inSessionIds, kind = 'champ_p1') {
  const T = kind === 'champ_top3' ? 3 : 1;
  const goalFor = t => (t === 1 ? 'la tête du championnat' : `le top ${t} du championnat`);
  const objectiveLabel = kind === 'champ_top3' ? 'Top 3 du championnat' : 'Tête du championnat';
  return predictTarget(standings, driverId, T, sessionScale, 'CHAMPIONNAT', goalFor, objectiveLabel, inSessionIds);
}

/**
 * NIVEAU 2 — "Recoller au leader" : combien D peut reprendre au 1er du
 * championnat sur cette session (meilleur des cas réaliste).
 */
export function predictChampGap(standings, driverId, sessionScale, inSessionIds) {
  const rows = (standings || []).filter(r => r && r.driverId != null)
    .map(r => ({ ...r, total: r.total ?? 0 })).sort((a, b) => b.total - a.total);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const D = rows.find(r => r.driverId === driverId);
  const leader = rows[0];
  if (!D || !leader) return { ok: false };
  if (D.driverId === leader.driverId) {
    // D est leader → c'est plutôt un objectif "conserver"
    return predictChampSession(standings, driverId, sessionScale, inSessionIds, 'champ_p1');
  }
  const inSet = new Set(inSessionIds || []);
  const gap = leader.total - D.total;
  const dMax = inSet.has(D.driverId) ? (sessionScale[0] ?? 0) : 0;
  // le leader marque au minimum : s'il est dans la session, sa pire place qui marque ;
  // sinon il ne marque pas (0). On prend le meilleur des cas pour D.
  const leaderMin = inSet.has(leader.driverId)
    ? (sessionScale[Math.min(sessionScale.length - 1, (inSessionIds || []).length - 1)] ?? 0)
    : 0;
  const clawback = dMax - leaderMin;
  const newGap = gap - clawback;
  const lines = [];
  let pill;
  if (clawback <= 0) {
    pill = { text: 'STATU QUO', tone: 'warn' };
    lines.push({ icon: '➖', text: `${drv(D)} ne peut pas reprendre de points au leader ${drv(leader)} sur cette session.` });
  } else if (newGap <= 0) {
    pill = { text: 'PEUT PASSER DEVANT', tone: 'live' };
    lines.push({ icon: '🎯', text: `Au mieux, ${drv(D)} repasse devant ${drv(leader)} (gain possible : ${clawback} pts pour ${gap} d'écart).` });
  } else {
    pill = { text: 'PEUT RECOLLER', tone: 'live' };
    lines.push({ icon: '🎯', text: `${drv(D)} peut reprendre jusqu'à ${clawback} pts au leader ${drv(leader)} : écart ramené à ${newGap} pts au mieux.` });
  }
  return {
    ok: true, scope: 'CHAMPIONNAT', objectiveLabel: 'Recoller au leader', driver: D,
    meta: `${gap} pts derrière ${drv(leader)}`, state: 'gap', pill, lines,
  };
}

// ─────────────────────────────────────────────────────────
// AIGUILLAGE (appelé par le routeur)
// ─────────────────────────────────────────────────────────
/**
 * @param input {
 *   objective: 'p1'|'qualif'|'champ_p1'|'champ_top3'|'champ_gap',
 *   standings, driverId, regulation,
 *   cutoff,                       // top N qualifiés (objective 'qualif')
 *   sessionType, inSessionIds     // niveau 2 : type de phase finale + engagés (qui marquent)
 * }
 */
export function buildPrediction(input) {
  const { objective, standings, driverId } = input || {};
  if (!driverId || !Array.isArray(standings) || !standings.length) return { ok: false };
  const champScale = () => phaseScale(input.sessionType || 'FIN', standings.length, input.regulation);
  switch (objective) {
    case 'qualif':     return predictManche(standings, driverId, input.cutoff || 1, input.regulation, 'qualif');
    case 'champ_p1':   return predictChampSession(standings, driverId, champScale(), input.inSessionIds || [], 'champ_p1');
    case 'champ_top3': return predictChampSession(standings, driverId, champScale(), input.inSessionIds || [], 'champ_top3');
    case 'champ_gap':  return predictChampGap(standings, driverId, champScale(), input.inSessionIds || []);
    case 'p1':
    default:           return predictManche(standings, driverId, 1, input.regulation, 'p1');
  }
}
