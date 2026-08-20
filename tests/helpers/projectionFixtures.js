/* ═══════════════════════════════════════════════
   PROJECTIONFIXTURES.JS — Fabrique de meetings synthétiques pour les tests
   du module de projection.

   Produit des documents de la MÊME forme que Firestore (sessions, results,
   sessionParticipants), pour que les tests exercent le vrai chemin de code
   et pas une version simplifiée.
═══════════════════════════════════════════════ */

/**
 * Règlement de test : barème volontairement trivial (10 - position) pour que
 * les points attendus soient lisibles à l'œil dans les assertions.
 * Les points intermédiaires sont désactivés, donc totalPoints = points MQ.
 */
export const TEST_REGULATION = {
  id: 'champ_test',
  name: 'Championnat de test',
  sessionConfig: {
    EC:  { enabled: false },
    MQ:  { count: 4 },
    QF:  { enabled: false, count: 4, gridSize: 6, qualifiedPerQF: 3 },
    DF:  { count: 1, gridSize: 2, qualifiedPerDF: 2 },
    FIN: { gridSize: 2 },
  },
  pointsScale: {
    MQ: { formula: '10 - position', overrides: {} },
  },
  statusRules: {
    DNF:      { mode: 'engaged_offset', offset: 1 },
    DNS:      { mode: 'fixed', points: 0 },
    DSQ:      { mode: 'fixed', points: 0 },
    DSQ_RACE: { mode: 'fixed', points: 0 },
  },
  interimPointsEnabled: false,
  interimTiebreaker: 'last_manche_time',
  worstResultDrop: 0,
};

/**
 * Sentinelle « pilote engagé mais pas encore passé ».
 *
 * En production, un pilote qui n'a pas encore couru n'a AUCUN document
 * `results` — vérifié sur les données réelles : sur 2 755 résultats de manche,
 * aucun n'est dépourvu à la fois de chrono et de statut. La fixture reproduit
 * donc ce cas en inscrivant le pilote sans créer de résultat.
 */
export const PENDING = Object.freeze({ __pending: true });

/**
 * Construit un meeting complet.
 *
 * @param {object} spec
 * @param {string[]} spec.drivers — identifiants pilotes
 * @param {object} spec.races — { numManche: { driverId: ms | { status } } }
 *        Une manche absente n'est pas créée ; une manche présente mais vide
 *        est créée sans résultat (utile pour tester « pas encore courue »).
 * @param {object} [spec.phases] — { DF: ['A','B'], QF: [...], FIN: [...] }
 *        partants réellement engagés dans les phases finales
 * @param {object} [spec.ec] — { driverId: ms }
 * @param {object} [spec.meeting] — surcharges du document meeting
 * @param {number} [spec.plannedRaces=4]
 * @returns {{ meeting, sessions, results, participants }}
 */
export function makeMeeting(spec) {
  const {
    drivers, races = {}, phases = {}, ec = null,
    meeting: meetingOverrides = {}, plannedRaces = 4,
    meetingId = 'M1', category = 'TestCat', year = 2026,
    championshipId = 'champ_test',
  } = spec;

  const meeting = {
    id: meetingId, date: '2026-05-03', year, location: 'Circuit de test',
    categories: [category], nbMQ: plannedRaces, championshipId,
    ...meetingOverrides,
  };

  const sessions = [];
  const results = [];
  const participants = [];
  let order = 0;

  const addParticipant = (sessionId, driverId) => {
    participants.push({
      id: `${sessionId}_${driverId}_p`, sessionId, driverId,
      carNumber: 1 + drivers.indexOf(driverId),
      firstName: driverId, lastName: `Pilote${driverId}`,
      category, year, meetingId,
    });
  };

  const addResult = (sessionId, sessionType, driverId, value) => {
    const isStatus = value && typeof value === 'object';
    results.push({
      id: `${sessionId}_${driverId}`, sessionId, meetingId, category, year,
      sessionType, driverId,
      carNumber: 1 + drivers.indexOf(driverId),
      firstName: driverId, lastName: `Pilote${driverId}`,
      ms: isStatus ? (value.ms ?? null) : value,
      status: isStatus ? (value.status ?? null) : null,
      manualPosition: isStatus ? (value.manualPosition ?? null) : null,
      serie: isStatus ? (value.serie ?? null) : null,
      couloir: null,
    });
  };

  if (ec) {
    const id = `${meetingId}_EC`;
    sessions.push({ id, meetingId, category, year, type: 'EC', label: 'Essais', num: null, order: order++, status: 'done' });
    for (const d of drivers) addParticipant(id, d);
    for (const [d, v] of Object.entries(ec)) addResult(id, 'EC', d, v);
  }

  for (let n = 1; n <= plannedRaces; n++) {
    const id = `${meetingId}_MQ${n}`;
    sessions.push({ id, meetingId, category, year, type: 'MQ', label: `Manche ${n}`, num: n, order: order++, status: 'done' });
    const race = races[n];
    // Les engagés d'une manche : ceux qui y figurent, sinon tout le plateau.
    const entrants = race ? Object.keys(race) : drivers;
    for (const d of entrants) addParticipant(id, d);
    // PENDING : le pilote est inscrit mais aucun résultat n'est créé.
    if (race) for (const [d, v] of Object.entries(race)) {
      if (v === PENDING) continue;
      addResult(id, 'MQ', d, v);
    }
  }

  for (const [type, ids] of Object.entries(phases)) {
    if (!ids?.length) continue;
    const id = `${meetingId}_${type}`;
    sessions.push({ id, meetingId, category, year, type, label: type, num: type === 'FIN' ? null : 1, order: order++, status: 'done' });
    for (const d of ids) addParticipant(id, d);
  }

  return { meeting, sessions, results, participants };
}

/** Raccourci : plusieurs meetings agrégés en un jeu de documents unique. */
export function mergeFixtures(fixtures) {
  return {
    meetings: fixtures.map(f => f.meeting),
    sessions: fixtures.flatMap(f => f.sessions),
    results: fixtures.flatMap(f => f.results),
    participants: fixtures.flatMap(f => f.participants),
  };
}

/**
 * Meeting « standard » à 6 pilotes et 4 manches, où l'ordre d'arrivée est
 * exactement l'ordre du tableau passé pour chaque manche.
 *
 * @param {object} spec — { id, orders: { 1: ['A','B',…], … }, phases, category }
 */
export function makeOrderedMeeting({ id = 'M1', orders, phases, category, championshipId, meeting, drivers }) {
  const all = drivers || [...new Set(Object.values(orders).flat())];
  const races = {};
  for (const [num, order] of Object.entries(orders)) {
    const race = {};
    order.forEach((entry, i) => {
      if (typeof entry === 'string') race[entry] = 1000 + i * 100;
      else if (entry.pending) race[entry.driver] = PENDING;
      else race[entry.driver] = { status: entry.status, serie: entry.serie ?? null };
    });
    races[num] = race;
  }
  return makeMeeting({
    drivers: all, races, phases, meetingId: id, category, championshipId,
    meeting, plannedRaces: Object.keys(orders).length,
  });
}
