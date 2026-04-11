/* ═══════════════════════════════════════════════
   CALC.JS — Calculs partagés (standings + sessions)
   Supporte les reglements dynamiques : si un reglement
   est passe en parametre, il est utilise. Sinon, le
   bareme FFSA 2026 par defaut s'applique.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// BAREME PAR DEFAUT (FFSA 2026) — utilise si aucun reglement
// ─────────────────────────────────────────────────────────

const DEFAULT_POINTS_SCALE = {
  MQ: {
    formula: '44 - position',
    overrides: { 1: 50, 2: 45, 3: 42 },
  },
  DF: {
    formula: null,
    overrides: { 1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 },
  },
  FIN: {
    formula: null,
    overrides: { 1: 15, 2: 12, 3: 9, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3 },
  },
};

const DEFAULT_STATUS_RULES = {
  DNF:      { mode: 'engaged_offset', offset: 1 },
  DNS:      { mode: 'fixed', points: 0 },
  DSQ_RACE: { mode: 'fixed', points: 0 },
  DSQ:      { mode: 'fixed', points: 0 },
};

// ─────────────────────────────────────────────────────────
// CALCUL DE POINTS GENERIQUE (depuis un pointsScale)
// ─────────────────────────────────────────────────────────

/**
 * Evalue une formule de points avec la variable 'position'.
 * @param {string|null} formula — ex: '44 - position'
 * @param {number} position
 * @returns {number|null}
 */
function evalFormula(formula, position) {
  if (!formula || !formula.trim()) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('position', `"use strict"; return (${formula})`)(position);
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return Math.max(0, Math.round(result));
  } catch {
    return null;
  }
}

/**
 * Calcule les points pour une position donnee selon un scale (formula + overrides).
 * @param {number} position
 * @param {{ formula?: string|null, overrides?: object }} scale
 * @returns {number}
 */
export function calcPointsFromScale(position, scale) {
  if (!position || position <= 0) return 0;
  if (!scale) return 0;
  const overrides = scale.overrides || {};
  if (overrides[position] !== undefined) return overrides[position];
  const computed = evalFormula(scale.formula, position);
  return computed !== null ? computed : 0;
}

/**
 * Calcule les points pour un statut special (DNF, DNS, DSQ, DSQ_RACE).
 * @param {string} status
 * @param {string} sessionType — 'MQ', 'DF', 'FIN'
 * @param {number} totalEngaged
 * @param {object} [regulation] — reglement optionnel
 * @returns {number}
 */
export function calcStatusPoints(status, sessionType, totalEngaged, regulation) {
  const rules = regulation?.statusRules || DEFAULT_STATUS_RULES;
  const scale = (regulation?.pointsScale || DEFAULT_POINTS_SCALE)[sessionType];
  const rule  = rules[status];
  if (!rule) return 0;

  if (rule.mode === 'engaged_offset') {
    return calcPointsFromScale(totalEngaged + (rule.offset || 1), scale);
  }
  return rule.points ?? 0;
}

// ─────────────────────────────────────────────────────────
// BAREMES (avec support reglement optionnel)
// ─────────────────────────────────────────────────────────

/**
 * Points MQ pour une position.
 * @param {number} position
 * @param {object} [regulation] — reglement optionnel
 */
export function mqPoints(position, regulation) {
  const scale = (regulation?.pointsScale || DEFAULT_POINTS_SCALE).MQ;
  return calcPointsFromScale(position, scale);
}

/**
 * Points bonus EC (top 5 → 5/4/3/2/1).
 * @param {number} position
 * @param {object} [regulation] — reglement optionnel (ecBonus dans pointsScale)
 */
export function ecBonusPoints(position, regulation) {
  // EC bonus : si le reglement a un ecBonus scale, l'utiliser
  if (regulation?.pointsScale?.EC_BONUS) {
    return calcPointsFromScale(position, regulation.pointsScale.EC_BONUS);
  }
  // Defaut FFSA : top 5 → 6 - position
  if (position <= 5) return 6 - position;
  return 0;
}

/**
 * Points intermediaires (position → bonus classement interim).
 * @param {number} position
 * @param {object} [regulation] — reglement optionnel (interimBonus dans pointsScale)
 */
export function interimPoints(position, regulation) {
  // Si explicitement desactive
  if (regulation?.interimPointsEnabled === false) return 0;
  if (regulation?.pointsScale?.INTERIM) {
    return calcPointsFromScale(position, regulation.pointsScale.INTERIM);
  }
  // Defaut FFSA : max(0, 17 - position)
  return Math.max(0, 17 - position);
}

/**
 * Points DF pour une position.
 * @param {number} position
 * @param {object} [regulation]
 */
export function dfPoints(position, regulation) {
  const scale = (regulation?.pointsScale || DEFAULT_POINTS_SCALE).DF;
  return calcPointsFromScale(position, scale);
}

/**
 * Points Finale pour une position.
 * @param {number} position
 * @param {object} [regulation]
 */
export function finPoints(position, regulation) {
  const scale = (regulation?.pointsScale || DEFAULT_POINTS_SCALE).FIN;
  return calcPointsFromScale(position, scale);
}

// ─────────────────────────────────────────────────────────
// HELPERS FIRESTORE
// ─────────────────────────────────────────────────────────

export async function getResults(db, sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'results'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getParticipants(db, sessionId) {
  if (!db || !sessionId) return [];
  const { collection, query, where, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
  );
  const snap = await getDocs(query(
    collection(db, 'sessionParticipants'),
    where('sessionId', '==', sessionId)
  ));
  return snap.docs.map(d => d.data());
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT EC
// ─────────────────────────────────────────────────────────

export async function calcEcStandings(db, sessions, regulation) {
  const ecSession = sessions.find(s => s.type === 'EC');
  if (!ecSession) return [];

  const results      = await getResults(db, ecSession.id);
  const participants = await getParticipants(db, ecSession.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const rows = participants.map(p => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    ms:        resultMap[p.driverId]?.ms     ?? null,
    status:    resultMap[p.driverId]?.status ?? null,
  }));

  rows.sort((a, b) => {
    const aOut = !a.ms && a.status;
    const bOut = !b.ms && b.status;
    if (aOut && !bOut) return 1;
    if (!aOut && bOut) return -1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  let pos = 1;
  return rows.map(r => {
    const hasTime  = r.ms != null;
    const position = hasTime ? pos++ : null;
    const bonus    = hasTime ? ecBonusPoints(position, regulation) : 0;
    return { ...r, position, bonusPoints: bonus };
  });
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT MQ (une manche)
// ─────────────────────────────────────────────────────────

export async function calcMqStandings(db, session, regulation) {
  const results      = await getResults(db, session.id);
  const participants = await getParticipants(db, session.id);
  const resultMap    = {};
  results.forEach(r => { resultMap[r.driverId] = r; });

  const rows = participants.map(p => ({
    driverId:  p.driverId,
    carNumber: p.carNumber,
    firstName: p.firstName,
    lastName:  p.lastName,
    ms:        resultMap[p.driverId]?.ms     ?? null,
    status:    resultMap[p.driverId]?.status ?? null,
  }));

  const totalEngaged = rows.length;

  const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const dnf      = rows.filter(r => r.status === 'DNF');
  const dsqRace  = rows.filter(r => r.status === 'DSQ_RACE');
  const dns      = rows.filter(r => r.status === 'DNS');
  const dsq      = rows.filter(r => r.status === 'DSQ');
  const noResult = rows.filter(r => !r.ms && !r.status);

  let pos = 1;
  const result = [];
  finished.forEach(r => result.push({ ...r, position: pos++, points: mqPoints(pos - 1, regulation) }));
  dnf.forEach(r     => result.push({ ...r, position: totalEngaged + 1, points: calcStatusPoints('DNF', 'MQ', totalEngaged, regulation) }));
  dsqRace.forEach(r => result.push({ ...r, position: totalEngaged + 3, points: calcStatusPoints('DSQ_RACE', 'MQ', totalEngaged, regulation) }));
  dns.forEach(r     => result.push({ ...r, position: null, points: calcStatusPoints('DNS', 'MQ', totalEngaged, regulation) }));
  dsq.forEach(r     => result.push({ ...r, position: null, points: calcStatusPoints('DSQ', 'MQ', totalEngaged, regulation) }));
  noResult.forEach(r => result.push({ ...r, position: null, points: null }));

  return result;
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT INTERMÉDIAIRE
// ─────────────────────────────────────────────────────────

/**
 * @param {object} db          - instance Firestore
 * @param {Array}  sessions    - sessions du meeting+catégorie courant
 * @param {object} [regulation] - reglement optionnel
 * @returns {Array} standings triés avec position et interimPoints
 */
export async function calcInterimStandings(db, sessions, regulation) {
  const mqSessions = sessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);
  if (mqSessions.length === 0) return [];

  // Points bonus EC
  const ecStandings = await calcEcStandings(db, sessions, regulation);
  const ecBonus = {};
  ecStandings.forEach(r => { ecBonus[r.driverId] = r.bonusPoints ?? 0; });

  // Collecter tous les pilotes et leurs points MQ
  const driverMap = {};
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(db, mq, regulation);
    standings.forEach(r => {
      if (!driverMap[r.driverId]) {
        driverMap[r.driverId] = {
          driverId:  r.driverId,
          carNumber: r.carNumber,
          firstName: r.firstName,
          lastName:  r.lastName,
          mqPoints:  {},
          mqPos:     {},
          mqCount:   0,
        };
      }
      if (r.points !== null && r.points !== undefined) {
        driverMap[r.driverId].mqPoints[mq.num] = r.points ?? 0;
        driverMap[r.driverId].mqPos[mq.num]    = r.position;
        if (r.status !== 'DNS' && r.status !== 'DSQ') {
          driverMap[r.driverId].mqCount++;
        }
      }
    });
  }

  // Règle : au moins 2 MQ classées
  const eligible = Object.values(driverMap).filter(d => d.mqCount >= 2);

  eligible.forEach(d => {
    d.totalMqPoints = Object.values(d.mqPoints).reduce((s, p) => s + p, 0);
    d.ecBonus       = ecBonus[d.driverId] ?? 0;
    d.totalPoints   = d.totalMqPoints + d.ecBonus;
  });

  // Tri : total desc → MQ du plus récent au plus ancien
  eligible.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    for (let n = mqSessions.length; n >= 1; n--) {
      const pa = a.mqPoints[n] ?? -1;
      const pb = b.mqPoints[n] ?? -1;
      if (pb !== pa) return pb - pa;
    }
    return 0;
  });

  // Positions + points intermédiaires
  let pos = 1;
  eligible.forEach((d, i) => {
    if (i > 0) {
      const prev = eligible[i - 1];
      let sameAll = d.totalPoints === prev.totalPoints;
      if (sameAll) {
        for (let n = mqSessions.length; n >= 1; n--) {
          if ((d.mqPoints[n] ?? -1) !== (prev.mqPoints[n] ?? -1)) { sameAll = false; break; }
        }
      }
      if (!sameAll) pos = i + 1;
    }
    d.position      = pos;
    d.interimPoints = interimPoints(pos, regulation);
  });

  return eligible;
}
