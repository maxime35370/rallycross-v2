/* ═══════════════════════════════════════════════
   PROJECTIONCONFIG.JS — Configuration centralisée du module
   « Projection de qualification ».

   Règle absolue : AUCUNE constante de seuil, de tranche, de confiance ou de
   formulation ne doit apparaître ailleurs dans le module. Tout ce qui est
   calibrable un jour vit ici, y compris les libellés — pour qu'un
   backtesting puisse remplacer un jeu de valeurs sans toucher au calcul.

   Voir docs/qualification-projection/ANALYSE.md §7.
═══════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────
// CONFIANCE / TAILLE D'ÉCHANTILLON
// ─────────────────────────────────────────────────────────

/**
 * Niveaux de confiance, du plus exigeant au moins exigeant. Le premier
 * niveau dont `minCases` est atteint gagne.
 *
 * `maxIntervalWidth` ajoute le critère de DISPERSION demandé : un taux mesuré
 * sur assez de cas mais dont l'intervalle de confiance reste très large est
 * rétrogradé d'un cran. Un 80 % sur 12 cas très dispersés ne doit pas
 * s'afficher comme un 80 % sur 100 cas serrés.
 */
export const CONFIDENCE_LEVELS = [
  { id: 'high',   label: 'élevée',  minCases: 30, maxIntervalWidth: 0.30 },
  { id: 'medium', label: 'moyenne', minCases: 12, maxIntervalWidth: 0.50 },
  { id: 'low',    label: 'faible',  minCases: 0,  maxIntervalWidth: 1 },
];

/**
 * En dessous de ce nombre de cas, on n'affiche PAS de taux : seulement
 * l'effectif et un message. Aligné sur la doctrine déjà appliquée par
 * startStatsCalc.MIN_N_FOR_RATE.
 */
export const MIN_CASES_TO_SHOW_RATE = 5;

// ─────────────────────────────────────────────────────────
// HISTORIQUE
// ─────────────────────────────────────────────────────────

export const HISTORY = {
  /** Bornes de l'axe normalisé « écart de rang au seuil ». */
  gapRange: { min: -10, max: 10 },

  /**
   * Tranches de points ADAPTATIVES : on part de bacs de `minWidth` points et
   * on fusionne les bacs voisins tant qu'ils n'atteignent pas `targetCases`,
   * sans dépasser `maxWidth`. Évite d'imposer des tranches de 5 points quand
   * l'échantillon ne le permet pas (cf. ANALYSE.md §4.4).
   */
  adaptiveBuckets: { targetCases: 20, minWidth: 5, maxWidth: 40 },

  /**
   * Cas triviaux (engagés <= seuil : tout le monde passe mécaniquement).
   * Exclus par défaut des statistiques ET des projections ; restent
   * consultables dans l'écran « Qualité des données ».
   */
  excludeTrivialByDefault: true,

  /**
   * L'axe en points absolus n'est comparable qu'à périmètre homogène.
   * Ces clés doivent être fixées (filtre actif) pour que la vue en points
   * soit proposée sans avertissement bloquant.
   */
  pointsAxisRequiresFixed: ['championshipId', 'category'],

  /** Élargissement progressif de la recherche de cas comparables. */
  comparableStrategies: [
    { id: 'exact',        label: 'même championnat, même catégorie, même écart au seuil', match: ['championshipId', 'category'], gapTolerance: 0 },
    { id: 'championship', label: 'même championnat, toutes catégories, même écart au seuil', match: ['championshipId'],           gapTolerance: 0 },
    { id: 'all',          label: 'tous championnats, même écart au seuil',                   match: [],                          gapTolerance: 0 },
    { id: 'widened',      label: 'tous championnats, écart au seuil ±1 place',               match: [],                          gapTolerance: 1 },
  ],
};

/**
 * Regroupement des résultats d'une manche pour l'analyse conditionnelle
 * (« qu'ont fait en Q4 les pilotes historiquement comparables ? »).
 * `status: true` capte DNF / DNS / DSQ / DSQ_RACE, qui doivent être classés
 * par leur statut et jamais par la position technique que leur attribue
 * buildMqStandings (engagés + 1).
 */
export const RESULT_BUCKETS = [
  { id: 'p1_3',   label: 'P1-P3',       min: 1,  max: 3 },
  { id: 'p4_7',   label: 'P4-P7',       min: 4,  max: 7 },
  { id: 'p8_12',  label: 'P8-P12',      min: 8,  max: 12 },
  { id: 'p13',    label: 'P13 et au-delà', min: 13, max: Infinity },
  { id: 'out',    label: 'DNF / DNS / DSQ', status: true },
];

// ─────────────────────────────────────────────────────────
// STRATÉGIE (utilisé à partir du LOT 2)
// ─────────────────────────────────────────────────────────

export const TARGET = {
  /**
   * Seuil de rendement décroissant : en dessous de ce gain de probabilité
   * (en points de pourcentage) par place gagnée, on considère que le gain
   * marginal devient faible.
   */
  diminishingReturnPctPerPosition: 1.0,
};

export const CLASSIFICATION = {
  green:  { minProbability: 0.90, maxMarginalGainPct: 2.0 },
  orange: { minProbability: 0.40 },
  // en dessous d'orange.minProbability → rouge
};

export const SIMULATION = {
  profiles: { dev: 10000, validation: 50000, performance: 100000 },
  defaultProfile: 'dev',
  /**
   * Graine par défaut. Elle est TOUJOURS remontée dans les sorties : une
   * probabilité affichée doit pouvoir être rejouée à l'identique.
   */
  defaultSeed: 20260101,
  /**
   * Les scénarios « et si » sont nombreux (une position forcée par place
   * possible, plus les statuts). Ils utilisent par défaut moins de tirages que
   * la probabilité principale, et surtout les MÊMES nombres aléatoires d'un
   * scénario à l'autre (variables antithétiques communes) : la comparaison
   * entre deux positions forcées porte alors sur la différence de scénario et
   * non sur le bruit de tirage.
   */
  whatIfSimulations: 2000,
  /** Tirages utilisés par point de mesure dans le backtest. */
  backtestSimulations: 3000,
};

/**
 * Modèle de performance pilote — toutes les constantes de contraction.
 *
 * Volontairement isolées : ce sont les premières valeurs qu'un backtesting
 * cherchera à recalibrer. Elles sont explicables, pas optimisées.
 */
export const PERFORMANCE_MODEL = {
  /** Observations « virtuelles » tirant la force du pilote vers le milieu de plateau. */
  priorStrength: 2,
  /** Poids de la dispersion de plateau face à la dispersion propre du pilote. */
  dispersionPrior: 6,
  /** Dispersion latente retenue si le matériau ne permet pas de l'estimer. */
  defaultDispersion: 0.75,
  minSigma: 0.30,
  maxSigma: 1.60,
  /** Observations « virtuelles » pour le taux d'incident. */
  incidentPrior: 4,
  defaultIncidentRate: 0.08,
  minIncidentRate: 0.01,
  maxIncidentRate: 0.60,
};

/**
 * Pondération des sources de performance d'un pilote, par ordre de priorité.
 * Volontairement isolée ici : ces valeurs sont des points de départ
 * explicables, destinées à être remplacées par un jeu calibré au backtesting.
 */
export const PERFORMANCE_SOURCE_WEIGHTS = {
  currentMeeting: 0.50,
  currentSeason:  0.30,
  sameCircuit:    0.15,
  overall:        0.05,
};

// ─────────────────────────────────────────────────────────
// FORMULATIONS
// ─────────────────────────────────────────────────────────

/**
 * Toutes les phrases produites par le module. Descriptives uniquement :
 * on montre ce qui est observable, on n'interprète pas l'intention d'un
 * pilote et on ne donne aucune consigne de course.
 */
export const MESSAGES = {
  unsupportedRegulation: 'Projection indisponible : règle non supportée',
  insufficientSample:    'Données insuffisantes pour une estimation historique fiable',
  fewCases:              (n) => `Seulement ${n} cas comparable${n > 1 ? 's' : ''}.`,
  lowConfidence:         'Confiance faible.',
  trivialQualification:  (engaged, threshold) =>
    `Qualification mécanique : ${engaged} engagé${engaged > 1 ? 's' : ''} pour ${threshold} place${threshold > 1 ? 's' : ''} qualificatives.`,
  historicalObservation: (n, qualified) =>
    `Observé sur ${n} cas comparable${n > 1 ? 's' : ''} : ${qualified} qualifié${qualified > 1 ? 's' : ''} après la dernière manche.`,
  targetBeyond:          (label) => `Au-delà de ${label}, le gain estimé de probabilité de qualification devient faible.`,
  targetFlat:            'La probabilité estimée de qualification reste stable quelle que soit la place obtenue : aucune place du plateau ne la modifie sensiblement.',
  targetSensitive:       'La probabilité estimée de qualification varie dès la première place gagnée : chaque place compte sur toute la courbe.',
  sectionHistorical:     'DONNÉES HISTORIQUES — observations réellement mesurées',
  sectionSimulation:     'SIMULATION MONTE-CARLO — projection statistique',
  sectionStrategy:       'INTERPRÉTATION STRATÉGIQUE — lecture des projections',
};

/**
 * Formulations interdites. Un test parcourt les sources du module et vérifie
 * qu'aucune n'y figure : le module décrit des faits, il ne conclut pas sur
 * l'intention d'un pilote et ne donne pas d'ordre stratégique.
 */
export const FORBIDDEN_WORDINGS = [
  'levé le pied',
  'lever le pied',
  'leve le pied',
  'doit gagner',
  'doit lever',
  'il suffit de',
  'garantit la qualification',
];
