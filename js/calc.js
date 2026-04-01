/* ═══════════════════════════════════════════════
   CALC.JS — Calculs partagés (standings + sessions)
   Élimine le besoin de sauvegarder interimStandings
   en Firestore. Tout se calcule à la volée.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// BARÈMES
// ─────────────────────────────────────────────────────────

export function mqPoints(position) {
  if (position === 1) return 50;
  if (position === 2) return 45;
  if (position === 3) return 42;
  if (position >= 4) return Math.max(0, 44 - position);
  return 0;
}

export function ecBonusPoints(position) {
  if (position <= 5) return 6 - position;
  return 0;
}

export function interimPoints(position) {
  return Math.max(0, 17 - position);
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

export async function calcEcStandings(db, sessions) {
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
    const bonus    = hasTime ? ecBonusPoints(position) : 0;
    return { ...r, position, bonusPoints: bonus };
  });
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT MQ (une manche)
// ─────────────────────────────────────────────────────────

export async function calcMqStandings(db, session) {
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
  const lastPoints   = mqPoints(totalEngaged);

  const finished = rows.filter(r => r.ms && !r.status).sort((a, b) => a.ms - b.ms);
  const dnf      = rows.filter(r => r.status === 'DNF');
  const dsqRace  = rows.filter(r => r.status === 'DSQ_RACE');
  const dns      = rows.filter(r => r.status === 'DNS');
  const dsq      = rows.filter(r => r.status === 'DSQ');
  const noResult = rows.filter(r => !r.ms && !r.status);

  let pos = 1;
  const result = [];
  finished.forEach(r => result.push({ ...r, position: pos++, points: mqPoints(pos - 1) }));
  dnf.forEach(r     => result.push({ ...r, position: totalEngaged + 1, points: Math.max(0, lastPoints - 1) }));
  dsqRace.forEach(r => result.push({ ...r, position: totalEngaged + 3, points: Math.max(0, lastPoints - 3) }));
  dns.forEach(r     => result.push({ ...r, position: null, points: 0 }));
  dsq.forEach(r     => result.push({ ...r, position: null, points: 0 }));
  noResult.forEach(r => result.push({ ...r, position: null, points: null }));

  return result;
}

// ─────────────────────────────────────────────────────────
// CALCUL CLASSEMENT INTERMÉDIAIRE
// C'est LA fonction centrale partagée par standings.js,
// sessions.js et championship.js
// ─────────────────────────────────────────────────────────

/**
 * @param {object} db       - instance Firestore
 * @param {Array}  sessions - sessions du meeting+catégorie courant
 * @returns {Array} standings triés avec position et interimPoints
 */
export async function calcInterimStandings(db, sessions) {
  const mqSessions = sessions.filter(s => s.type === 'MQ').sort((a, b) => a.num - b.num);
  if (mqSessions.length === 0) return [];

  // Points bonus EC
  const ecStandings = await calcEcStandings(db, sessions);
  const ecBonus = {};
  ecStandings.forEach(r => { ecBonus[r.driverId] = r.bonusPoints ?? 0; });

  // Collecter tous les pilotes et leurs points MQ
  const driverMap = {};
  for (const mq of mqSessions) {
    const standings = await calcMqStandings(db, mq);
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
    d.interimPoints = interimPoints(pos);
  });

  return eligible;
}