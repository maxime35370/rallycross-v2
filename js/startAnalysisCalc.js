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
      if (dnsIds.length) {
        localWarnings.push(
          `Série ${serie} : ${dnsIds.length} pilote(s) DNS — non compté(s) parmi les partants, ` +
          'leur couloir reste vide'
        );
      }
      return {
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
  if (dnsIds.length) {
    localWarnings.push(
      `${dnsIds.length} pilote(s) DNS — non compté(s) parmi les partants, leur emplacement reste vide`
    );
  }
  return {
    starts: [{
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
  if (nonStarters.length) {
    warnings.push(
      `${nonStarters.length} pilote(s) DNS — absent(s) de la grille, exclu(s) de l'analyse ` +
      `(${starters} partant(s) réel(s))`
    );
  }
  if (rows.some(r => r.confidence === 'yellow')) {
    warnings.push('Certaines lignes sont à vérifier (🟡)');
  }
  if (rows.some(r => r.lane == null)) {
    warnings.push('Certains pilotes n\'ont pas de couloir : ils seront exclus des statistiques par couloir');
  }

  return { ok: errors.length === 0, errors, warnings };
}
