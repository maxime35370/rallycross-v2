/* ═══════════════════════════════════════════════
   STARTANALYSISCALC.JS — Logique métier pure de
   l'analyse des départs.

   AUCUNE dépendance Firestore ni DOM : tout est
   testable (tests/startAnalysisCalc.test.js).

   Principe directeur : une analyse = UN DÉPART
   PHYSIQUE RÉEL, jamais une session.
     • MQ          : 1 série = 1 départ (N séries → N départs)
     • QF/DF/FIN   : 1 session = 1 grille = 1 départ

   Sources de vérité (ne jamais les mélanger) :
     • gridPos      → results.couloir (MQ) / cascade de qualification (finales)
     • gridRow/lane → RÈGLEMENT du championnat (sessionConfig[type].gridLayout)
     • orientation  → meeting.poleSide, DÉJÀ en base ('droite' | 'gauche')

   Convention de numérotation des couloirs, vérifiée dans le code existant
   (standings.js : « 1er virage à droite — couloir 1 à droite ») :
     ⇒ le COULOIR 1 est TOUJOURS du côté du premier virage, donc à l'INTÉRIEUR.
   La zone latérale ne dépend donc QUE de (lane, gridLanes) : aucune orientation
   n'est nécessaire pour la calculer.

   Voir docs/video-analysis/ARCHITECTURE.md §1.5, §4.7, §4.10.
═══════════════════════════════════════════════ */

import { computeSeriesSizes } from './calc.js';

// ─────────────────────────────────────────────────────────
// IDENTIFIANTS
// ─────────────────────────────────────────────────────────

/**
 * Identifiant déterministe d'un départ physique.
 * Convention maison (cf. results / sessionParticipants) : jamais de doublon
 * possible, même en cas d'appels concurrents, grâce à setDoc(..., {merge:true}).
 *
 * @param {string} sessionId
 * @param {number} startIndex — n° de série (MQ) ou 1 (QF/DF/FIN)
 * @returns {string} ex. 'aBc123_s3'
 */
export function startDocId(sessionId, startIndex) {
  if (!sessionId) throw new Error('startDocId: sessionId requis');
  const idx = Number(startIndex);
  if (!Number.isInteger(idx) || idx < 1) {
    throw new Error(`startDocId: startIndex invalide (${startIndex})`);
  }
  return `${sessionId}_s${idx}`;
}

/**
 * Empreinte stable d'une géométrie de grille.
 * Deux départs ne sont comparables « au couloir près » que s'ils partagent
 * ce même gridLayoutKey (cf. ARCHITECTURE.md §4.8).
 *
 * @param {{lanes?:number, rows?:number, positions?:object}|null} gridLayout
 * @returns {string} ex. '5x3:0-0=1,0-2=2,…' — ou 'none' si absent
 */
export function gridLayoutKey(gridLayout) {
  if (!gridLayout || !gridLayout.positions) return 'none';
  const lanes = gridLayout.lanes || 0;
  const rows  = gridLayout.rows  || 0;
  // Tri des clés pour que l'empreinte ne dépende pas de l'ordre d'insertion
  const cells = Object.keys(gridLayout.positions)
    .sort()
    .map(k => `${k}=${gridLayout.positions[k]}`)
    .join(',');
  return `${lanes}x${rows}:${cells}`;
}

/**
 * Empreinte de la composition d'un départ, pour détecter qu'une série a été
 * recomposée après validation (results.serie est modifiable par la régie).
 *
 * @param {string[]} driverIds
 * @returns {string}
 */
export function seriesFingerprint(driverIds) {
  const ids = [...(driverIds || [])].filter(Boolean).map(String).sort();
  if (ids.length === 0) return 'empty';
  // Hachage court déterministe (FNV-1a 32 bits) — suffisant pour détecter
  // un changement, ce n'est pas un usage cryptographique.
  let h = 0x811c9dc5;
  const s = ids.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${ids.length}:${h.toString(16).padStart(8, '0')}`;
}

// ─────────────────────────────────────────────────────────
// GÉOMÉTRIE DE GRILLE — le RÈGLEMENT est l'unique source de vérité
// ─────────────────────────────────────────────────────────

/**
 * Taille max d'une série MQ pour une catégorie donnée du championnat.
 * @param {object|null} championship
 * @param {string} category
 * @returns {number}
 */
export function maxPerSeries(championship, category) {
  const cats = championship?.categories;
  if (Array.isArray(cats) && category) {
    const cat = cats.find(c => (c.id || c.name) === category);
    if (cat?.maxPerSeries) return cat.maxPerSeries;
  }
  return 5;
}

/**
 * Résout la géométrie de grille d'un type de session.
 *
 * ⚠️ Le championnat doit être celui DU MEETING (via meeting.championshipId),
 * jamais le championnat « actif » de l'interface : une analyse rejouée plus
 * tard avec une autre sélection reconstruirait sinon une géométrie fausse.
 *
 * @param {object|null} championship — document championships/{id}
 * @param {string} sessionType — 'MQ' | 'QF' | 'DF' | 'FIN'
 * @param {string} [category]
 * @returns {{gridLanes:number, gridRowsTotal:number, gridLayout:object|null,
 *            gridLayoutKey:string, source:string}}
 */
export function resolveGridGeometry(championship, sessionType, category) {
  const type = String(sessionType || '').toUpperCase();

  // MQ : une série = une seule ligne de N voitures côte à côte.
  if (type === 'MQ') {
    const lanes = maxPerSeries(championship, category);
    return {
      gridLanes: lanes,
      gridRowsTotal: 1,
      gridLayout: null,
      gridLayoutKey: `mq:${lanes}`,
      source: 'mq_max_per_series',
    };
  }

  const layout = championship?.sessionConfig?.[type]?.gridLayout || null;
  if (!layout || !layout.positions || Object.keys(layout.positions).length === 0) {
    // Pas de gridLayout dans le règlement → aucune valeur inventée.
    return {
      gridLanes: 0,
      gridRowsTotal: 0,
      gridLayout: null,
      gridLayoutKey: 'none',
      source: 'missing',
    };
  }

  return {
    gridLanes: layout.lanes || 0,
    gridRowsTotal: layout.rows || 0,
    gridLayout: layout,
    gridLayoutKey: gridLayoutKey(layout),
    source: 'grid_layout',
  };
}

/**
 * Cellules d'un gridLayout triées par numéro de position croissant.
 * Reproduit EXACTEMENT la logique de sessions.js : les clés sont
 * "ligne-colonne" en base 0, et l'attribution se fait par rang et non par
 * recherche de valeur — l'éditeur de settings.js autorise des numéros non
 * contigus, il ne faut donc pas inverser la map par valeur.
 *
 * @param {object} gridLayout
 * @returns {Array<{row:number, lane:number, posNum:number}>} 1-based
 */
export function gridCellsInOrder(gridLayout) {
  if (!gridLayout?.positions) return [];
  return Object.entries(gridLayout.positions)
    .sort((a, b) => a[1] - b[1])
    .map(([key, posNum]) => {
      const [r, c] = String(key).split('-').map(Number);
      return { row: r + 1, lane: c + 1, posNum };
    });
}

/**
 * Place une position sportive sur la grille physique.
 *
 * gridPos = RANG SPORTIF (1 = meilleur qualifié), pas un numéro de couloir.
 * Sur une grille en quinconce, P4 se trouve en LIGNE 2 — pas dans le couloir 4.
 *
 * @param {number} gridPos — 1-based
 * @param {object|null} gridLayout
 * @returns {{gridRow:number, lane:number, layoutPosNum:number}|null}
 *          null si la grille ne comporte pas assez de cellules
 */
export function placeOnGrid(gridPos, gridLayout) {
  const cells = gridCellsInOrder(gridLayout);
  const idx = Number(gridPos) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= cells.length) return null;
  const cell = cells[idx];
  return { gridRow: cell.row, lane: cell.lane, layoutPosNum: cell.posNum };
}

/**
 * Contrôles de cohérence d'un gridLayout (l'éditeur de settings.js est libre).
 * @param {object|null} gridLayout
 * @param {number} [starters] — nb de partants, pour vérifier la capacité
 * @returns {string[]} avertissements (vide = tout va bien)
 */
export function checkGridLayout(gridLayout, starters) {
  const warnings = [];
  if (!gridLayout?.positions) {
    warnings.push('Aucune géométrie de grille définie dans le règlement');
    return warnings;
  }
  const cells = gridCellsInOrder(gridLayout);

  // Doublons de numéros de position → configuration invalide
  const nums = cells.map(c => c.posNum);
  const dupes = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
  if (dupes.length) {
    warnings.push(`Numéros de position en doublon dans le règlement : ${dupes.join(', ')}`);
  }

  // Numéros non contigus → le n° affiché sur la grille diffère du rang sportif
  const contiguous = nums.every((n, i) => n === i + 1);
  if (!contiguous && !dupes.length) {
    warnings.push(
      'Numéros de position non contigus : le numéro affiché sur la grille ne ' +
      'correspond pas au rang sportif'
    );
  }

  // Cellules hors des dimensions déclarées
  const lanes = gridLayout.lanes || 0;
  const rows  = gridLayout.rows  || 0;
  if (cells.some(c => c.lane > lanes || c.row > rows)) {
    warnings.push('Certaines positions sortent des dimensions déclarées (lanes × rows)');
  }

  if (starters != null && starters > cells.length) {
    warnings.push(
      `${starters} partants pour ${cells.length} emplacements : les partants ` +
      'surnuméraires n\'auront pas de position physique'
    );
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────
// COULOIRS : intérieur / milieu / extérieur
// ─────────────────────────────────────────────────────────

/**
 * Zone latérale d'un couloir : intérieur / milieu / extérieur.
 *
 * ⚠️ AIDE D'AFFICHAGE UNIQUEMENT — cette valeur n'est PAS stockée dans
 * startAnalyses. Seuls `lane` (brut) et `gridLanes` le sont, et la vue
 * statistiques regroupe comme elle veut (décision : « pas de regroupement »
 * figé en base). Cette fonction est donc un utilitaire pour cette vue.
 *
 * Le couloir 1 étant toujours du côté du premier virage (voir en-tête), la zone
 * ne dépend que du couloir et du nombre de couloirs de la géométrie :
 *   couloir 1 = intérieur … couloir gridLanes = extérieur
 *
 * Dénominateur = `gridLanes` (RÈGLEMENT) et non le nombre de voitures
 * présentes : le couloir 3 reste au milieu d'une géométrie à 5 couloirs, même
 * dans une série de 3 (ARCHITECTURE.md §4.10 A).
 *
 * Découpage par tiers de la largeur : 5 couloirs → 2 / 1 / 2.
 *
 * @param {number} lane — 1-based
 * @param {number} gridLanes — nb de couloirs de la géométrie
 * @returns {'inside'|'middle'|'outside'|null} null si indéterminable
 */
export function laneZone(lane, gridLanes) {
  const l = Number(lane);
  const L = Number(gridLanes);
  if (!Number.isFinite(l) || !Number.isFinite(L) || l < 1 || L < 1 || l > L) return null;
  if (L === 1) return 'middle';         // aucun choix latéral possible

  const t = (l - 1) / (L - 1);          // 0 = couloir 1 = intérieur
  if (t < 1 / 3) return 'inside';
  if (t > 2 / 3) return 'outside';
  return 'middle';
}

/**
 * Normalise meeting.poleSide vers 'left' | 'right'.
 * Sert à l'affichage (orientation de la grille, repère vidéo), jamais au calcul
 * de laneZone.
 * @param {string} poleSide — 'droite' | 'gauche'
 * @returns {'left'|'right'}
 */
export function normalizePoleSide(poleSide) {
  return String(poleSide || '').toLowerCase() === 'gauche' ? 'left' : 'right';
}

// ─────────────────────────────────────────────────────────
// QUI A RÉELLEMENT PRIS LE DÉPART
// ─────────────────────────────────────────────────────────

/**
 * Un pilote noté DNS (Did Not Start) n'était PAS sur la grille : il ne compte
 * pas parmi les partants et ne peut pas avoir de position au premier virage.
 *
 * Les autres statuts correspondent à des pilotes qui ONT pris le départ :
 *   • DNF      — parti, pas arrivé : il a bien une position possible au V1 ;
 *   • DSQ_RACE — disqualifié de la course, donc il l'a disputée ;
 *   • DSQ      — disqualification prononcée après coup.
 * Seul DNS signifie sans ambiguïté « absent de la ligne de départ ».
 *
 * ⚠️ Son couloir reste VIDE : les autres pilotes ne sont pas renumérotés.
 * Si le couloir 2 est absent, le pilote du couloir 3 garde le couloir 3.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isNonStarter(status) {
  return String(status || '').toUpperCase() === 'DNS';
}

/** Nombre de pilotes réellement au départ dans un jeu de lignes. */
export function countStarters(rows = []) {
  return rows.filter(r => !r.didNotStart).length;
}

// ─────────────────────────────────────────────────────────
// ÉNUMÉRATION DES DÉPARTS PHYSIQUES
// ─────────────────────────────────────────────────────────

const SESSION_LABEL = { MQ: 'MQ', QF: 'QF', DF: 'DF', FIN: 'FIN', EC: 'EC' };

/**
 * Libellé lisible d'un départ. Ex. « MQ1 · Série 3 », « DF2 », « FIN ».
 * @param {{type:string, num?:number|null}} session
 * @param {number} startIndex
 * @param {boolean} multiStart — true si la session comporte plusieurs départs
 */
export function startLabel(session, startIndex, multiStart) {
  const type = String(session?.type || '').toUpperCase();
  const base = (SESSION_LABEL[type] || type) + (session?.num ? String(session.num) : '');
  return multiStart ? `${base} · Série ${startIndex}` : base;
}

/**
 * Énumère les DÉPARTS PHYSIQUES d'une session.
 *
 * • MQ        : regroupe les résultats par `serie` → un départ par série.
 *               La composition vit dans results.serie / results.couloir, qui
 *               sont NULLABLES : si aucune série n'est renseignée, on renvoie
 *               un tableau vide avec un avertissement — on n'invente jamais
 *               de composition.
 * • QF/DF/FIN : un unique départ (startIndex = 1) à partir des participants.
 *
 * @param {object} params
 * @param {{id:string, type:string, num?:number}} params.session
 * @param {Array} params.results — documents results de la session
 * @param {Array} params.participants — documents sessionParticipants de la session
 * @param {object|null} params.championship — championnat DU MEETING
 * @param {string} params.category
 * @returns {{starts:Array, warnings:string[]}}
 */
export function enumerateStarts({ session, results = [], participants = [], championship = null, category = '' }) {
  const type = String(session?.type || '').toUpperCase();
  const warnings = [];

  if (type === 'EC') {
    return { starts: [], warnings: ['Les essais chronométrés ne comportent pas de départ en grille'] };
  }

  const geometry = resolveGridGeometry(championship, type, category);

  // ── MQ : un départ par série ──────────────────────────
  if (type === 'MQ') {
    const bySerie = new Map();
    let missingSerie = 0;
    for (const r of results) {
      const serie = Number(r?.serie);
      if (!Number.isInteger(serie) || serie < 1) { missingSerie++; continue; }
      if (!bySerie.has(serie)) bySerie.set(serie, []);
      bySerie.get(serie).push(r);
    }

    if (bySerie.size === 0) {
      warnings.push(
        'Aucune série renseignée pour cette manche : impossible de reconstituer ' +
        'les départs. Renseignez série et couloir dans la vue Chronométrage, ' +
        'ou groupez les pilotes manuellement.'
      );
      return { starts: [], warnings };
    }
    if (missingSerie > 0) {
      warnings.push(`${missingSerie} pilote(s) sans série renseignée — exclus des départs`);
    }

    // Tailles attendues, pour un contrôle de cohérence uniquement
    const expected = computeSeriesSizes(
      participants.length,
      maxPerSeries(championship, category),
      championship?.seriesDistributionMode
    );

    const indexes = [...bySerie.keys()].sort((a, b) => a - b);
    const multi = indexes.length > 1;
    const starts = indexes.map(serie => {
      const rows = bySerie.get(serie);
      const localWarnings = [];
      const exp = expected[serie - 1];
      if (exp != null && exp !== rows.length) {
        localWarnings.push(
          `Série ${serie} : ${rows.length} pilote(s) trouvé(s), ${exp} attendu(s) ` +
          'selon le règlement'
        );
      }
      // Couloirs : manquants ou en doublon
      const couloirs = rows.map(r => Number(r.couloir)).filter(n => Number.isInteger(n) && n > 0);
      if (couloirs.length !== rows.length) {
        localWarnings.push(`Série ${serie} : couloir manquant pour ${rows.length - couloirs.length} pilote(s)`);
      }
      const dupes = [...new Set(couloirs.filter((c, i) => couloirs.indexOf(c) !== i))];
      if (dupes.length) localWarnings.push(`Série ${serie} : couloir(s) en doublon : ${dupes.join(', ')}`);

      const dnsIds = rows.filter(r => isNonStarter(r.status)).map(r => r.driverId);
      // Un DNS est une situation NORMALE : simple information, pas un problème.
      const localNotes = dnsIds.length
        ? [`${dnsIds.length} pilote(s) DNS — couloir laissé vide, ${rows.length - dnsIds.length} partant(s)`]
        : [];
      return {
        notes: localNotes,
        startIndex: serie,
        startLabel: startLabel(session, serie, multi),
        sessionId: session.id,
        sessionType: type,
        sessionNum: session.num ?? null,
        driverIds: rows.map(r => r.driverId),
        dnsDriverIds: dnsIds,
        sourceRows: rows,
        starters: rows.length - dnsIds.length,
        gridSource: 'mq_couloir',
        ...geometry,
        warnings: localWarnings,
      };
    });
    return { starts, warnings };
  }

  // ── QF / DF / FIN : un seul départ ────────────────────
  if (participants.length === 0) {
    warnings.push('Aucun participant enregistré pour cette session');
    return { starts: [], warnings };
  }

  const statusByDriver = new Map(results.map(r => [r.driverId, r.status]));
  const dnsIds = participants
    .filter(p => isNonStarter(statusByDriver.get(p.driverId)))
    .map(p => p.driverId);
  const starters = participants.length - dnsIds.length;

  const localWarnings = checkGridLayout(geometry.gridLayout, starters);
  const localNotes = dnsIds.length
    ? [`${dnsIds.length} pilote(s) DNS — emplacement laissé vide, ${starters} partant(s)`]
    : [];
  return {
    starts: [{
      notes: localNotes,
      startIndex: 1,
      startLabel: startLabel(session, 1, false),
      sessionId: session.id,
      sessionType: type,
      sessionNum: session.num ?? null,
      driverIds: participants.map(p => p.driverId),
      dnsDriverIds: dnsIds,
      sourceRows: participants,
      starters,
      gridSource: geometry.source === 'grid_layout' ? 'grid_layout' : 'manual',
      ...geometry,
      warnings: localWarnings,
    }],
    warnings,
  };
}

// ─────────────────────────────────────────────────────────
// ORDRE DE LA GRILLE DES PHASES FINALES
// ─────────────────────────────────────────────────────────

/**
 * Ordre d'arrivée d'une course, tel que le calcule déjà sessions.js
 * (fonction getTopN) : temps croissant, puis DNF, puis DSQ_RACE, puis le reste.
 *
 * @param {Array<{driverId:string, ms?:number|null, status?:string|null}>} rows
 * @returns {string[]} driverIds dans l'ordre d'arrivée
 */
export function orderByRaceResult(rows = []) {
  const key = r => r.ms ? r.ms
    : r.status === 'DNF' ? 9000000
    : r.status === 'DSQ_RACE' ? 9100000
    : 9999999;
  return [...rows].sort((a, b) => key(a) - key(b)).map(r => r.driverId);
}

/**
 * Grille d'une QF ou d'une DF : les pilotes sont placés dans l'ordre du
 * CLASSEMENT INTERMÉDIAIRE établi à l'issue des manches qualificatives.
 *
 * Le leader du classement intermédiaire est en pole de SA demi-finale, le
 * deuxième en pole de l'AUTRE : la répartition entre les demi-finales est déjà
 * faite par l'application (1er et 3e ensemble, 2e et 4e ensemble, etc.).
 * Il ne reste donc ici qu'à trier les pilotes d'un même départ.
 *
 * Un pilote absent du classement passe en fin de grille plutôt que d'être
 * placé arbitrairement.
 *
 * @param {string[]} driverIds — pilotes de CE départ
 * @param {string[]} interimOrder — driverIds du classement intermédiaire, 1er en tête
 * @returns {string[]} driverIds ordonnés pour la grille
 */
export function orderGridByInterim(driverIds = [], interimOrder = []) {
  const rank = new Map(interimOrder.map((id, i) => [id, i]));
  return [...driverIds].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return driverIds.indexOf(a) - driverIds.indexOf(b);   // stable
  });
}

/**
 * Grille de la FINALE : composée par paires depuis les demi-finales, comme le
 * fait déjà sessions.js — le vainqueur de la DF1 puis celui de la DF2, ensuite
 * les deuxièmes de chaque DF, et ainsi de suite.
 *
 * Les finalistes qui ne proviennent d'aucune demi-finale (ajout manuel, ou
 * catégorie à petit effectif disputant la finale sans demi-finales) sont
 * ajoutés ensuite, dans l'ordre du classement intermédiaire.
 *
 * @param {string[]} driverIds — finalistes de CE départ
 * @param {string[][]} semiFinishOrders — un tableau d'ordres d'arrivée par DF
 * @param {string[]} [interimOrder] — repli pour les pilotes hors demi-finales
 * @returns {string[]} driverIds ordonnés pour la grille
 */
export function orderFinalGridFromSemis(driverIds = [], semiFinishOrders = [], interimOrder = []) {
  const wanted = new Set(driverIds);
  const out = [];
  const placed = new Set();

  const depth = Math.max(0, ...semiFinishOrders.map(o => o.length));
  for (let i = 0; i < depth; i++) {
    for (const order of semiFinishOrders) {
      const id = order[i];
      if (id && wanted.has(id) && !placed.has(id)) { out.push(id); placed.add(id); }
    }
  }

  // Finalistes hors demi-finales : classement intermédiaire, puis ordre d'origine
  const rest = driverIds.filter(id => !placed.has(id));
  out.push(...orderGridByInterim(rest, interimOrder));
  return out;
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT À L'ARRIVÉE, AU SEIN DU DÉPART
// ─────────────────────────────────────────────────────────

/**
 * Rang d'arrivée AU SEIN d'un départ (et non de la session entière).
 *
 * Indispensable pour les MQ : calcMqStandings() classe TOUTE la manche
 * (1..30), ce qui n'est pas comparable à une grille de 5. La seule grandeur
 * homogène pour les matrices de transition est le rang dans le départ.
 *
 * Ordre appliqué, aligné sur calcPhaseStandings() de standings.js :
 *   temps croissant → DNF avec manualPosition → tout le reste non classé (null).
 *
 * ⚠️ Divergence VOULUE avec calcMqStandings() de calc.js, qui attribue aux DNF
 * la position `totalEngaged + 1` et aux DSQ_RACE `totalEngaged + 3`. Ces valeurs
 * servent à calculer des POINTS, pas à exprimer un ordre d'arrivée : les injecter
 * dans une matrice de transition fausserait la statistique. Ici, un pilote non
 * classé vaut `null` et sera exclu des matrices — même convention que
 * `turn1Pos = null` pour un abandon avant le virage 1 (ARCHITECTURE.md §4.10 B).
 *
 * @param {Array<{driverId:string, ms?:number|null, status?:string|null, manualPosition?:number|null}>} rows
 * @returns {Map<string, number|null>} driverId → rang (null si non classé)
 */
export function finishPosInStart(rows = []) {
  const out = new Map();
  const finished = rows.filter(r => r.ms != null && r.ms > 0 && !r.status)
                       .sort((a, b) => a.ms - b.ms);
  let pos = 1;
  for (const r of finished) out.set(r.driverId, pos++);

  // DNF classés par la régie : on respecte manualPosition telle quelle
  for (const r of rows.filter(r => r.status === 'DNF' && r.manualPosition)) {
    out.set(r.driverId, Number(r.manualPosition));
  }
  // Tous les autres : non classés
  for (const r of rows) if (!out.has(r.driverId)) out.set(r.driverId, null);
  return out;
}

// ─────────────────────────────────────────────────────────
// CONSTRUCTION DE LA GRILLE D'UN DÉPART
// ─────────────────────────────────────────────────────────

/**
 * Construit les lignes d'un départ : position sportive + position physique.
 *
 * @param {object} params
 * @param {object} params.start — un élément renvoyé par enumerateStarts()
 * @param {Array} params.results — documents results de la SESSION
 * @param {Array} params.participants — sessionParticipants de la SESSION
 * @param {string[]} [params.rankedDriverIds] — pour QF/DF/FIN : ordre de la
 *        cascade de qualification (meilleur qualifié en premier). Si absent,
 *        l'ordre des participants est utilisé et un avertissement est émis.
 * @returns {{rows:Array, warnings:string[]}}
 *
 * Note : `laneZone` n'est PAS produit ici. Seul le couloir brut est conservé ;
 * le regroupement intérieur/milieu/extérieur se fait à l'affichage (§4.10 A).
 */
export function buildStartGrid({ start, results = [], participants = [], rankedDriverIds = null }) {
  const warnings = [...(start.warnings || [])];
  const resultByDriver = new Map(results.map(r => [r.driverId, r]));
  const partByDriver   = new Map(participants.map(p => [p.driverId, p]));

  // Rang d'arrivée au sein du départ, sur les seuls pilotes du départ
  const startRows = start.driverIds.map(id => {
    const r = resultByDriver.get(id) || {};
    return { driverId: id, ms: r.ms ?? null, status: r.status ?? null, manualPosition: r.manualPosition ?? null };
  });
  const finishInStart = finishPosInStart(startRows);

  let rows;

  if (start.sessionType === 'MQ') {
    // gridPos ≡ couloir, une seule ligne
    rows = start.driverIds.map(id => {
      const r = resultByDriver.get(id) || {};
      const couloir = Number(r.couloir);
      const lane = Number.isInteger(couloir) && couloir > 0 ? couloir : null;
      const p = partByDriver.get(id) || {};
      return {
        driverId: id,
        carNumber: p.carNumber ?? r.carNumber ?? null,
        firstName: p.firstName ?? r.firstName ?? '',
        lastName:  p.lastName  ?? r.lastName  ?? '',
        gridPos: lane,
        gridRow: lane != null ? 1 : null,
        lane,
        didNotStart: isNonStarter(r.status),
        turn1Pos: null,
        autoTurn1Pos: null,
        finishPosInStart: finishInStart.get(id) ?? null,
        finishStatus: r.status ?? null,
        confidence: 'green',
        corrected: false,
        note: '',
      };
    }).sort((a, b) => (a.gridPos ?? 99) - (b.gridPos ?? 99));
  } else {
    // QF/DF/FIN : gridPos = rang de qualification, position physique via gridLayout
    let order = rankedDriverIds;
    if (!Array.isArray(order) || order.length === 0) {
      order = start.driverIds;
      warnings.push('Ordre de qualification inconnu : grille reconstituée dans l\'ordre des participants');
    }
    // On ne garde que les pilotes réellement au départ, dans l'ordre du classement
    const ordered = order.filter(id => start.driverIds.includes(id));
    for (const id of start.driverIds) if (!ordered.includes(id)) ordered.push(id);

    rows = ordered.map((id, i) => {
      const gridPos = i + 1;
      const place = placeOnGrid(gridPos, start.gridLayout);
      const r = resultByDriver.get(id) || {};
      const p = partByDriver.get(id) || {};
      return {
        driverId: id,
        carNumber: p.carNumber ?? r.carNumber ?? null,
        firstName: p.firstName ?? r.firstName ?? '',
        lastName:  p.lastName  ?? r.lastName  ?? '',
        gridPos,
        gridRow: place?.gridRow ?? null,
        lane: place?.lane ?? null,
        didNotStart: isNonStarter(r.status),
        turn1Pos: null,
        autoTurn1Pos: null,
        finishPosInStart: finishInStart.get(id) ?? null,
        finishStatus: r.status ?? null,
        confidence: 'green',
        corrected: false,
        note: '',
      };
    });
  }

  return { rows, warnings };
}

// ─────────────────────────────────────────────────────────
// SAISIE DE L'ORDRE AU PREMIER VIRAGE
// ─────────────────────────────────────────────────────────

/**
 * Positions encore disponibles pour un pilote donné à la saisie du V1.
 *
 * Une position déjà attribuée à un AUTRE pilote du même départ est retirée :
 * on empêche l'erreur au lieu de la signaler après coup.
 *
 * La position courante du pilote reste toujours proposée, même si elle
 * apparaît en doublon — cela peut arriver sur un brouillon enregistré avant
 * cette règle, et il ne faut pas que le sélecteur se vide silencieusement.
 * Le contrôle de doublon de validateAnalysis() reste donc utile.
 *
 * @param {string} driverId — pilote pour qui on construit la liste
 * @param {Array<{driverId:string, turn1Pos?:number|null}>} rows — lignes du départ
 * @param {number} starters — nombre de partants (borne haute)
 * @returns {number[]} positions proposables, dans l'ordre croissant
 */
/**
 * Prochaine position libre au premier virage — la règle du pointage dans
 * l'ordre, isolée pour être testable et affichable.
 *
 * L'écran s'en sert pour annoncer ce qu'un clic donnerait (« → P3 ») ; c'est
 * une décision métier, pas de la mise en forme.
 *
 * @returns {number|null} la plus petite position libre, ou null s'il n'en
 *   reste aucune dans la limite des partants.
 */
export function nextFreeTurn1Pos(rows = [], starters = 0) {
  const n = Number(starters);
  if (!Number.isInteger(n) || n < 1) return null;
  const prises = new Set(rows.map(r => turn1Rank(r.turn1Pos)).filter(p => p != null));
  for (let k = 1; k <= n; k++) if (!prises.has(k)) return k;
  return null;
}

/**
 * Rang de premier virage valide, ou null.
 *
 * `Number(null)` vaut 0 et passe `Number.isInteger` : sans ce garde, une
 * position VIDE se lit comme la position 0. C'est le défaut qu'ont attrapé
 * les tests du pointage dans l'ordre.
 */
function turn1Rank(v) {
  if (v == null || v === '') return null;
  const k = Number(v);
  return Number.isInteger(k) && k > 0 ? k : null;
}

/**
 * POINTAGE DANS L'ORDRE — un clic par pilote, dans l'ordre de passage au V1.
 *
 * Le pointage position par position oblige à traduire ce qu'on voit (« celle-ci
 * passe avant celle-là ») en numéros (« ce pilote est P3 »). Cette traduction
 * est faite de tête, devant une vidéo qui défile, et c'est là que se logent les
 * erreurs. Pointer dans l'ordre supprime l'étape : on désigne les voitures dans
 * l'ordre où elles franchissent le virage, la numérotation suit.
 *
 * Trois règles, et rien d'autre :
 *   • un pilote non classé prend la plus petite position libre ;
 *   • un pilote déjà classé est RETIRÉ, et tous ceux qui le suivaient remontent
 *     d'un cran — sans quoi un retrait laisserait un trou à reboucher à la main ;
 *   • un pilote non partant n'est jamais classé.
 *
 * Fonction pure : elle ne modifie rien, elle rend la liste telle qu'elle doit
 * devenir. L'appelant décide quoi en faire.
 *
 * @param {string} driverId — le pilote désigné
 * @param {Array}  rows — lignes de grille, avec `driverId`, `turn1Pos`, `didNotStart`
 * @param {number} starters — nombre de partants, borne haute des positions
 * @returns {Array} une NOUVELLE liste de lignes, positions mises à jour
 */
export function pointTurn1InOrder(driverId, rows = [], starters = 0) {
  const n = Number(starters);
  const self = rows.find(r => r.driverId === driverId);
  if (!self || self.didNotStart || !Number.isInteger(n) || n < 1) return rows.map(r => ({ ...r }));

  const actuelle = turn1Rank(self.turn1Pos);

  // Retrait : on enlève la position et on resserre ceux qui suivaient.
  if (actuelle != null) {
    return rows.map(r => {
      if (r.driverId === driverId) return { ...r, turn1Pos: null, corrected: true };
      const p = turn1Rank(r.turn1Pos);
      if (p != null && p > actuelle) return { ...r, turn1Pos: p - 1 };
      return { ...r };
    });
  }

  // Ajout : la plus petite position libre, dans la limite du nombre de partants.
  const libre = nextFreeTurn1Pos(rows.filter(r => r.driverId !== driverId), n);
  if (libre == null) return rows.map(r => ({ ...r }));

  return rows.map(r => (r.driverId === driverId
    ? { ...r, turn1Pos: libre, corrected: true }
    : { ...r }));
}

export function availableTurn1Positions(driverId, rows = [], starters = 0) {
  const n = Number(starters);
  if (!Number.isInteger(n) || n < 1) return [];
  const self = rows.find(r => r.driverId === driverId) || {};
  // Un pilote DNS n'était pas sur la grille : aucune position ne lui est proposée.
  if (self.didNotStart) return [];
  const taken = new Set(
    rows.filter(r => r.driverId !== driverId && r.turn1Pos != null)
        .map(r => Number(r.turn1Pos))
  );
  const out = [];
  for (let k = 1; k <= n; k++) {
    if (taken.has(k) && Number(self.turn1Pos) !== k) continue;
    out.push(k);
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// VALIDATION AVANT ENREGISTREMENT
// ─────────────────────────────────────────────────────────

/**
 * Vérifie qu'une analyse peut passer au statut 'validated'.
 * Règle absolue : aucune donnée non validée n'alimente les statistiques,
 * et une analyse incomplète ou incertaine ne peut pas être validée.
 *
 * @param {object} analysis — document startAnalyses en préparation
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateAnalysis(analysis) {
  const errors = [];
  const warnings = [];
  const rows = analysis?.rows || [];

  if (rows.length === 0) errors.push('Aucun pilote dans ce départ');

  if (analysis?.orderCompleteness === 'partial') {
    errors.push(
      'Ordre incomplet : l\'ordre relatif des voitures n\'est pas garanti. ' +
      'Passez en « toutes visibles » ou « leaders certifiés » pour valider.'
    );
  }

  // Les pilotes DNS n'étaient pas sur la grille : ils sortent de tous les calculs
  const starters = countStarters(rows);
  const nonStarters = rows.filter(r => r.didNotStart);
  const withPos = rows.filter(r => r.turn1Pos != null);

  if (starters === 0) errors.push('Aucun pilote n\'a pris le départ');
  if (withPos.length === 0 && starters > 0) errors.push('Aucune position au premier virage saisie');

  // Un DNS ne peut pas avoir de position au premier virage
  const dnsWithPos = nonStarters.filter(r => r.turn1Pos != null);
  if (dnsWithPos.length) {
    errors.push(`${dnsWithPos.length} pilote(s) DNS ont une position au 1er virage : impossible, ils n'ont pas pris le départ`);
  }

  // Positions V1 : entières, dans les bornes (nombre de PARTANTS), sans doublon
  const positions = withPos.map(r => Number(r.turn1Pos));
  if (positions.some(p => !Number.isInteger(p) || p < 1 || p > starters)) {
    errors.push(`Positions au premier virage hors bornes (1..${starters})`);
  }
  const dupes = [...new Set(positions.filter((p, i) => positions.indexOf(p) !== i))];
  if (dupes.length) errors.push(`Position(s) au premier virage en doublon : ${dupes.join(', ')}`);

  // Une ligne 🔴 non traitée bloque la validation
  const reds = rows.filter(r => r.confidence === 'red');
  if (reds.length) {
    errors.push(`${reds.length} pilote(s) en identification incertaine (🔴) : à corriger avant validation`);
  }

  // Avertissements non bloquants
  // Avertissement de saisie PARTIELLE uniquement : quand rien n'est encore
  // saisi, l'erreur ci-dessus le dit déjà, et parler d'« abandon » serait faux.
  // On ne présume donc pas de la raison : abandon, ou voiture hors champ.
  const missing = starters - withPos.length;
  if (missing > 0 && withPos.length > 0) {
    warnings.push(
      `${missing} pilote(s) sans position au 1er virage — exclus des matrices ` +
      `(abandon, ou voiture non visible à l'image de mesure)`
    );
  }
  // Les DNS ne sont PAS signalés ici : c'est une situation normale, déjà
  // indiquée en tête du départ. La répéter en orange laisserait croire à un
  // problème et découragerait la validation.
  if (rows.some(r => r.confidence === 'yellow')) {
    warnings.push('Certaines lignes sont à vérifier (🟡)');
  }
  if (rows.some(r => r.lane == null)) {
    warnings.push('Certains pilotes n\'ont pas de couloir : ils seront exclus des statistiques par couloir');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────
// PROPOSITION AUTOMATIQUE DU CLASSEMENT AU PREMIER VIRAGE
// ─────────────────────────────────────────────────────────

/*
   L'analyse vidéo ne saisit JAMAIS à la place de l'opérateur. Elle remplit
   `autoTurn1Pos`, un champ distinct de `turn1Pos` ; seul un geste humain fait
   passer l'un dans l'autre. C'est la règle absolue du module — « aucune donnée
   non validée n'alimente les statistiques » — et elle se tient ici, dans le
   code, pas seulement dans l'intention.

   Format d'échange `rx-v1-order/1`, volontairement minuscule (moins d'un ko) :
   la vidéo annotée ne circule pas, seul le résultat chiffré revient.

     { schema: 'rx-v1-order/1',
       startAt: 3.0, turn1At: 13.5,
       methode: 'similitude-groupe/1 + hsv-zonee/1',
       positions: [ { carNumber: 12, turn1Pos: 1, confiance: 0.92 },
                    { carNumber: 7,  turn1Pos: null, confiance: 0 } ] }

   `turn1Pos: null` veut dire NON DÉCIDÉ, et c'est un résultat légitime : une
   case vide se remplit en deux secondes, une case fausse coûte bien plus cher
   à repérer puis à corriger.
*/

/** Le document est-il une proposition exploitable ? */
export function isV1OrderProposal(doc) {
  return Boolean(doc) && doc.schema === 'rx-v1-order/1' && Array.isArray(doc.positions);
}

/**
 * Applique une proposition aux lignes d'un départ, sans jamais toucher à
 * `turn1Pos`.
 *
 * Tout ce qui ne se rattache pas proprement est ÉCARTÉ et rapporté, plutôt
 * que rapproché de force : une proposition à moitié comprise vaut moins que
 * pas de proposition du tout.
 *
 * @returns {{rows:Array, applied:number, rejected:Array<{carNumber:*, raison:string}>}}
 */
export function applyV1OrderProposal({ rows = [], proposal = null, starters = null } = {}) {
  const sortie = rows.map(r => ({ ...r, autoTurn1Pos: null, autoConfidence: null }));
  const rejected = [];
  if (!isV1OrderProposal(proposal)) {
    return { rows: sortie, applied: 0, rejected: [{ carNumber: null, raison: 'format non reconnu' }] };
  }

  const n = Number.isInteger(Number(starters)) && Number(starters) > 0
    ? Number(starters) : countStarters(rows);
  const parNumero = new Map();
  for (const r of sortie) {
    const num = Number(r.carNumber);
    if (!Number.isFinite(num)) continue;
    // Deux pilotes au même numéro dans un départ : on ne devine pas lequel.
    if (parNumero.has(num)) parNumero.set(num, null); else parNumero.set(num, r);
  }

  // Premier passage : ne garder que des propositions individuellement valables.
  const retenues = [];
  for (const p of proposal.positions) {
    const num = Number(p?.carNumber);
    const pos = turn1Rank(p?.turn1Pos);
    const ligne = parNumero.get(num);
    if (!Number.isFinite(num)) { rejected.push({ carNumber: p?.carNumber, raison: 'numéro illisible' }); continue; }
    if (ligne === undefined) { rejected.push({ carNumber: num, raison: 'absent de ce départ' }); continue; }
    if (ligne === null) { rejected.push({ carNumber: num, raison: 'numéro en double dans le départ' }); continue; }
    if (pos == null) continue;                       // non décidé : silence, pas un rejet
    if (pos > n) { rejected.push({ carNumber: num, raison: `position ${pos} au-delà de ${n} partants` }); continue; }
    if (ligne.didNotStart) { rejected.push({ carNumber: num, raison: 'pilote non partant' }); continue; }
    retenues.push({ ligne, pos, confiance: Number(p?.confiance) });
  }

  // Second passage : une position revendiquée deux fois n'est attribuée à
  // personne. Trancher au hasard ferait entrer une erreur silencieuse.
  const compte = new Map();
  for (const x of retenues) compte.set(x.pos, (compte.get(x.pos) || 0) + 1);
  let applied = 0;
  for (const x of retenues) {
    if (compte.get(x.pos) > 1) {
      rejected.push({ carNumber: Number(x.ligne.carNumber), raison: `position ${x.pos} proposée à plusieurs voitures` });
      continue;
    }
    x.ligne.autoTurn1Pos = x.pos;
    x.ligne.autoConfidence = Number.isFinite(x.confiance) ? x.confiance : null;
    applied += 1;
  }
  return { rows: sortie, applied, rejected };
}

/**
 * Reprend les propositions à son compte : `autoTurn1Pos` devient `turn1Pos`.
 *
 * Jamais d'écrasement : une position déjà saisie à la main l'emporte toujours
 * sur la machine, et les propositions qui entreraient en collision avec elle
 * sont laissées de côté.
 *
 * @returns {{rows:Array, accepted:number, skipped:number}}
 */
export function acceptV1Proposals(rows = []) {
  const prises = new Set(rows.map(r => turn1Rank(r.turn1Pos)).filter(p => p != null));
  let accepted = 0, skipped = 0;
  const sortie = rows.map(r => {
    const auto = turn1Rank(r.autoTurn1Pos);
    if (auto == null || turn1Rank(r.turn1Pos) != null || r.didNotStart) {
      if (auto != null && turn1Rank(r.turn1Pos) == null && !r.didNotStart) skipped += 1;
      return { ...r };
    }
    if (prises.has(auto)) { skipped += 1; return { ...r }; }
    prises.add(auto);
    accepted += 1;
    return { ...r, turn1Pos: auto, corrected: false };
  });
  return { rows: sortie, accepted, skipped };
}

// ─────────────────────────────────────────────────────────
// GRILLE ANNONCÉE, EXPORTABLE VERS L'OUTIL D'ANALYSE VIDÉO
// ─────────────────────────────────────────────────────────

/*
   L'outil d'analyse vidéo est séparé de l'application : il n'a pas accès à la
   base. Pour qu'il puisse afficher des NOMS et pas seulement des numéros, la
   grille lui est transmise telle qu'elle est annoncée.

   Les noms ne sont pas un confort d'affichage : on reconnaît une voiture à sa
   déco bien plus vite qu'à son numéro, souvent invisible sous l'angle de la
   caméra. Ce sont eux qui permettent de vérifier d'un coup d'œil que
   l'attribution est juste.

   Format `rx-start-grid/1` — et rien de plus que ce qu'il faut : ni pilote
   non partant (il n'est pas sur la grille), ni résultat, ni identifiant de
   base au-delà de celui du départ.
*/

/**
 * @param {object} start — le départ (startLabel, sessionType, starters…)
 * @param {Array} rows — lignes de grille issues de `buildStartGrid`
 * @param {string} poleSide — 'droite' | 'gauche' (meeting.poleSide)
 * @returns {object} document `rx-start-grid/1`
 */
export function buildStartGridExport({ start = {}, rows = [], poleSide = null } = {}) {
  const partants = rows
    .filter(r => !r.didNotStart)
    .slice()
    .sort((a, b) => (a.lane ?? a.gridPos ?? 99) - (b.lane ?? b.gridPos ?? 99));
  return {
    schema: 'rx-start-grid/1',
    // Les départs énumérés ne portent pas d'`id` : c'est la paire
    // (session, série) qui les identifie, comme pour le document Firestore.
    // Sans lui, un classement qui revient ne saurait pas à quel départ il
    // appartient — et deux départs ouverts se rempliraient l'un l'autre.
    startId: start.id ?? identifiantDepart(start),
    startLabel: start.startLabel ?? null,
    sessionType: start.sessionType ?? null,
    // Le couloir 1 est toujours du côté du premier virage : l'outil vidéo en a
    // besoin pour proposer l'ordre gauche → droite à l'image.
    poleSide: normalizePoleSide(poleSide),
    starters: countStarters(rows),
    drivers: partants.map(r => ({
      carNumber: r.carNumber ?? null,
      firstName: r.firstName || '',
      lastName: r.lastName || '',
      lane: r.lane ?? null,
      gridPos: r.gridPos ?? null,
    })),
  };
}

/** Identifiant du départ, ou rien si les données ne permettent pas de le former. */
function identifiantDepart(start) {
  try { return startDocId(start.sessionId, start.startIndex); } catch { return null; }
}

/** Le document est-il une grille annoncée exploitable ? */
export function isStartGridExport(doc) {
  return Boolean(doc) && doc.schema === 'rx-start-grid/1' && Array.isArray(doc.drivers);
}
