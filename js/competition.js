/* ═══════════════════════════════════════════════
   COMPETITION.JS — Moteur de cascade QF→DF→FIN
   Gere la repartition des pilotes dans les phases
   finales, les suppleants, et le classement meeting.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// REPARTITION DES SERIES MQ
// ─────────────────────────────────────────────────────────

/**
 * Repartit les pilotes en series pour une manche MQ.
 * @param {Array} drivers - pilotes engages (tries par classement)
 * @param {number} nbSeries - nombre de series
 * @returns {Array<Array>} tableau de series, chaque serie = tableau de pilotes
 */
export function distributeIntoSeries(drivers, nbSeries) {
  const series = Array.from({ length: nbSeries }, () => []);
  drivers.forEach((driver, i) => {
    series[i % nbSeries].push(driver);
  });
  return series;
}

/**
 * Calcule le nombre de series recommande selon le nombre de pilotes.
 * Table FIA : voir reglement 35.1.6
 * @param {number} nbDrivers
 * @param {object|null} seriesTable - table custom du reglement
 * @returns {number} nombre de series
 */
export function getRecommendedSeries(nbDrivers, seriesTable) {
  if (seriesTable && seriesTable[nbDrivers]) {
    return seriesTable[nbDrivers].length;
  }
  // Defaut : ~5-6 pilotes par serie
  if (nbDrivers <= 6) return 1;
  if (nbDrivers <= 12) return 2;
  if (nbDrivers <= 18) return 3;
  if (nbDrivers <= 24) return 4;
  if (nbDrivers <= 30) return 5;
  if (nbDrivers <= 35) return 6;
  return 7;
}

// ─────────────────────────────────────────────────────────
// REPARTITION QF (QUARTS DE FINALE)
// ─────────────────────────────────────────────────────────

/**
 * Repartit les pilotes qualifies dans les quarts de finale.
 * Distribution : QF1 = pos 1,5,9,13... / QF2 = 2,6,10,14... / etc.
 * @param {Array} rankedDrivers - pilotes tries par classement interim
 * @param {object} qfConfig - { count: 4, distribution: [1,5,9,13...], gridSize: 6, qualifiedPerQF: 3 }
 * @returns {Array<Array>} tableau de QF, chaque QF = tableau de pilotes
 */
export function distributeIntoQF(rankedDrivers, qfConfig) {
  const count    = qfConfig?.count || 4;
  const gridSize = qfConfig?.gridSize || 6;
  const maxTotal = count * gridSize;

  // Prendre les N premiers du classement
  const qualified = rankedDrivers.slice(0, maxTotal);

  const qfs = Array.from({ length: count }, () => []);
  qualified.forEach((driver, i) => {
    const qfIdx = i % count;
    if (qfs[qfIdx].length < gridSize) {
      qfs[qfIdx].push(driver);
    }
  });

  return qfs;
}

/**
 * Retourne les suppleants (reserves) pour les QF.
 * Ce sont les pilotes juste apres les qualifies dans le classement.
 * @param {Array} rankedDrivers - classement complet
 * @param {number} totalQualified - nombre de qualifies pour les QF
 * @param {number} maxReserves - nombre max de reserves
 * @returns {Array} pilotes reserves dans l'ordre de priorite
 */
export function getReserves(rankedDrivers, totalQualified, maxReserves) {
  return rankedDrivers.slice(totalQualified, totalQualified + maxReserves);
}

// ─────────────────────────────────────────────────────────
// REPARTITION DF (DEMI-FINALES)
// ─────────────────────────────────────────────────────────

/**
 * Repartit les qualifies des QF dans les DF.
 * QF1+QF3 → DF1, QF2+QF4 → DF2
 * @param {Array<Array>} qfResults - resultats des QF, chaque QF = pilotes tries par position
 * @param {object} dfConfig - { count: 2, qualifiedPerDF: 3 }
 * @param {Array} interimRanking - classement MQ pour departager
 * @returns {Array<Array>} tableau de DF, chaque DF = pilotes ordonnes pour la grille
 */
export function distributeIntoDF(qfResults, dfConfig, interimRanking) {
  const dfCount = dfConfig?.count || 2;
  const qualPerQF = dfConfig?.qualifiedPerQF || 3;

  // Extraire les qualifies de chaque QF
  const qualifiedByQF = qfResults.map(qf => qf.slice(0, qualPerQF));

  const dfs = Array.from({ length: dfCount }, () => []);

  if (qfResults.length === 4 && dfCount === 2) {
    // FIA : QF1+QF3 → DF1, QF2+QF4 → DF2
    dfs[0] = [...qualifiedByQF[0], ...qualifiedByQF[2]];
    dfs[1] = [...qualifiedByQF[1], ...qualifiedByQF[3]];
  } else {
    // Repartition generique : alterner
    qualifiedByQF.forEach((qfQ, qfIdx) => {
      const dfIdx = qfIdx % dfCount;
      dfs[dfIdx].push(...qfQ);
    });
  }

  // Ordonner chaque DF : vainqueurs QF en premier, puis 2emes, puis 3emes
  // Departage par classement MQ
  dfs.forEach(df => {
    sortByQFPositionThenInterim(df, qfResults, interimRanking);
  });

  return dfs;
}

/**
 * Repartit les qualifies des DF dans la finale.
 * @param {Array<Array>} dfResults - resultats des DF
 * @param {number} qualifiedPerDF - nombre de qualifies par DF (ex: 3)
 * @param {Array} interimRanking - classement MQ pour departage
 * @returns {{ finalists: Array, reserves: Array }}
 */
export function distributeIntoFIN(dfResults, qualifiedPerDF, interimRanking) {
  const finalists = [];
  const reserves  = [];

  dfResults.forEach(df => {
    df.forEach((driver, pos) => {
      if (pos < qualifiedPerDF) {
        finalists.push({ ...driver, dfPosition: pos + 1 });
      } else {
        reserves.push({ ...driver, dfPosition: pos + 1 });
      }
    });
  });

  // Ordonner les finalistes : vainqueurs DF en ligne 1, etc.
  sortByPhasePositionThenInterim(finalists, 'dfPosition', interimRanking);

  // Reserves triees par classement MQ
  sortByInterim(reserves, interimRanking);

  return { finalists, reserves };
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT MEETING (mode cascade FIA)
// ─────────────────────────────────────────────────────────

/**
 * Classement meeting en mode cascade :
 * Top 1-6  : resultat finale
 * Top 7-12 : 4e/5e/6e des DF, departages par MQ
 * Top 13-24: 4e/5e/6e des QF, departages par MQ
 * Reste    : classement MQ
 *
 * @param {Array} finResults - resultat finale (tries par position)
 * @param {Array<Array>} dfResults - resultats des DF
 * @param {Array<Array>} qfResults - resultats des QF
 * @param {Array} interimRanking - classement MQ complet
 * @param {object} config - { qualifiedPerDF, qualifiedPerQF }
 * @returns {Array} classement complet du meeting avec position
 */
export function buildMeetingClassification(finResults, dfResults, qfResults, interimRanking, config) {
  const qualPerDF = config?.qualifiedPerDF || 3;
  const qualPerQF = config?.qualifiedPerQF || 3;
  const ranking = [];
  const placed = new Set();

  // Top : resultat finale
  finResults.forEach((driver, i) => {
    ranking.push({ ...driver, meetingPosition: ranking.length + 1, phase: 'FIN', phasePosition: i + 1 });
    placed.add(driver.driverId);
  });

  // Ensuite : elimines des DF (positions qualPerDF+1 et plus), tries par position DF puis MQ
  const dfEliminated = [];
  dfResults.forEach(df => {
    df.forEach((driver, pos) => {
      if (pos >= qualPerDF && !placed.has(driver.driverId)) {
        dfEliminated.push({ ...driver, dfPosition: pos + 1 });
      }
    });
  });
  sortByPhasePositionThenInterim(dfEliminated, 'dfPosition', interimRanking);
  dfEliminated.forEach(driver => {
    ranking.push({ ...driver, meetingPosition: ranking.length + 1, phase: 'DF' });
    placed.add(driver.driverId);
  });

  // Ensuite : elimines des QF, tries par position QF puis MQ
  if (qfResults && qfResults.length > 0) {
    const qfEliminated = [];
    qfResults.forEach(qf => {
      qf.forEach((driver, pos) => {
        if (pos >= qualPerQF && !placed.has(driver.driverId)) {
          qfEliminated.push({ ...driver, qfPosition: pos + 1 });
        }
      });
    });
    sortByPhasePositionThenInterim(qfEliminated, 'qfPosition', interimRanking);
    qfEliminated.forEach(driver => {
      ranking.push({ ...driver, meetingPosition: ranking.length + 1, phase: 'QF' });
      placed.add(driver.driverId);
    });
  }

  // Reste : classement MQ
  interimRanking.forEach(driver => {
    if (!placed.has(driver.driverId)) {
      ranking.push({ ...driver, meetingPosition: ranking.length + 1, phase: 'MQ' });
    }
  });

  return ranking;
}

// ─────────────────────────────────────────────────────────
// GRILLE DE DEPART — placement avec pole par classement MQ
// ─────────────────────────────────────────────────────────

/**
 * Place les pilotes sur la grille selon le layout et les regles de pole.
 * Sur chaque ligne, le pilote avec le meilleur classement MQ
 * prend la meilleure position (cote pole).
 *
 * @param {Array} drivers - pilotes a placer, deja ordonnes par position phase
 * @param {object} gridLayout - { lanes, rows, positions: { 'r-c': pos } }
 * @param {Array} interimRanking - classement MQ pour pole
 * @param {boolean} poleLeft - true si pole = colonne 0 (depend du circuit)
 * @returns {Array} pilotes avec gridRow et gridCol assignes
 */
export function assignGridPositions(drivers, gridLayout, interimRanking, poleLeft) {
  if (!gridLayout?.positions) return drivers;

  // Construire la map position → {row, col}
  const posToCell = {};
  Object.entries(gridLayout.positions).forEach(([key, pos]) => {
    const [r, c] = key.split('-').map(Number);
    posToCell[pos] = { row: r, col: c };
  });

  // Grouper les positions par ligne
  const lineGroups = {};
  Object.entries(posToCell).forEach(([pos, cell]) => {
    if (!lineGroups[cell.row]) lineGroups[cell.row] = [];
    lineGroups[cell.row].push(parseInt(pos));
  });

  // Ranking lookup
  const interimMap = {};
  if (interimRanking) {
    interimRanking.forEach((d, i) => { interimMap[d.driverId] = i; });
  }

  // Assigner les positions
  const result = [];
  const sortedPositions = Object.keys(posToCell).map(Number).sort((a, b) => a - b);

  sortedPositions.forEach((pos, i) => {
    if (i < drivers.length) {
      const cell = posToCell[pos];
      result.push({
        ...drivers[i],
        gridPosition: pos,
        gridRow: cell.row,
        gridCol: cell.col,
      });
    }
  });

  return result;
}

// ─────────────────────────────────────────────────────────
// HELPERS TRI
// ─────────────────────────────────────────────────────────

function getInterimPosition(driver, interimRanking) {
  if (!interimRanking) return 9999;
  const idx = interimRanking.findIndex(d => d.driverId === driver.driverId);
  return idx >= 0 ? idx : 9999;
}

function sortByInterim(arr, interimRanking) {
  arr.sort((a, b) => getInterimPosition(a, interimRanking) - getInterimPosition(b, interimRanking));
}

function sortByPhasePositionThenInterim(arr, posField, interimRanking) {
  arr.sort((a, b) => {
    const pa = a[posField] || 999;
    const pb = b[posField] || 999;
    if (pa !== pb) return pa - pb;
    return getInterimPosition(a, interimRanking) - getInterimPosition(b, interimRanking);
  });
}

function sortByQFPositionThenInterim(dfDrivers, qfResults, interimRanking) {
  // Trouver la position QF de chaque pilote
  const qfPosMap = {};
  qfResults.forEach(qf => {
    qf.forEach((driver, pos) => {
      qfPosMap[driver.driverId] = pos + 1;
    });
  });

  dfDrivers.sort((a, b) => {
    const pa = qfPosMap[a.driverId] || 999;
    const pb = qfPosMap[b.driverId] || 999;
    if (pa !== pb) return pa - pb;
    return getInterimPosition(a, interimRanking) - getInterimPosition(b, interimRanking);
  });
}
