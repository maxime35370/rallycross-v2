/* ═══════════════════════════════════════════════
   LICENSECALC.JS — Règle d'accès Stratégie Live. PUR et TESTÉ.

   Aucune dépendance : ni Firestore, ni DOM, ni Firebase. Ce module reçoit
   des licences et un meeting, et répond « autorisé ou non ». Convention
   maison : le calcul vit ici, l'accès aux données vit dans licenses.js,
   le rendu dans accessAdmin.js (cf. js/calc.js et js/projection/*).

   ── Pourquoi ce fichier existe séparément ──────────────────────────────
   Le jour où le moteur passera côté serveur (LOT C), c'est EXACTEMENT cette
   règle qui devra être appliquée par la Cloud Function, avant tout calcul.
   L'écrire pure et testée aujourd'hui, c'est la déplacer sans la réécrire
   demain — et surtout sans risquer que la version serveur diverge de la
   version client.

   ── Ce que ce module NE fait PAS ───────────────────────────────────────
   Il ne protège rien. Il filtre une interface. Tant que le moteur est servi
   au navigateur, un utilisateur déterminé s'en passe (voir
   docs/monetisation/PLAN-A0-ET-POC-VIDEO.md §1.6). La protection réelle,
   à ce stade, est portée par les règles Firestore : personne ne peut se
   fabriquer une licence. C'est une distinction à garder nette.
═══════════════════════════════════════════════ */

/** Portées commerciales reconnues. */
export const SCOPES = ['meeting', 'season'];

/** États d'une licence. Seul `active` ouvre l'accès. */
export const STATUSES = ['active', 'suspended', 'revoked'];

/** Origines. `purchase` est réservé au futur circuit de paiement. */
export const ORIGINS = ['admin_grant', 'trial', 'purchase'];

/** Motifs de refus, exposés pour que l'interface dise POURQUOI. */
export const DENIAL = {
  noLicense:      'no_license',
  wrongScope:     'wrong_scope',
  notActive:      'not_active',
  expired:        'expired',
  notYetValid:    'not_yet_valid',
  unknownDriver:  'unknown_driver',
};

// ─────────────────────────────────────────────────────────
// DATES
// ─────────────────────────────────────────────────────────

/**
 * Ramène en millisecondes une date venue de n'importe où.
 *
 * Firestore rend des `Timestamp` (avec `toMillis()`), le cache hors ligne
 * peut rendre `{seconds, nanoseconds}`, un import manuel rend une chaîne
 * ISO, et les tests passent des nombres. Tout converger ici évite que
 * chaque appelant improvise sa propre conversion — et qu'une licence
 * paraisse expirée uniquement à cause d'une forme de date.
 *
 * @returns {number|null} null si la valeur est absente ou illisible
 */
export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value.toMillis === 'function') {
    const t = value.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// VALIDITÉ D'UNE LICENCE
// ─────────────────────────────────────────────────────────

/**
 * La licence est-elle en vigueur à l'instant donné ?
 *
 * `validUntil` absent signifie « sans échéance » — c'est le cas d'une
 * licence saison qu'on ne veut pas voir expirer au milieu du championnat
 * pour une erreur de saisie. `validFrom` absent signifie « depuis
 * toujours » : une licence attribuée à la volée en bord de piste doit
 * marcher immédiatement, sans que l'admin ait à penser à l'horodatage.
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function licenseValidity(license, now = Date.now()) {
  if (!license) return { ok: false, reason: DENIAL.noLicense };
  if (license.status !== 'active') return { ok: false, reason: DENIAL.notActive };

  const from = toMillis(license.validFrom);
  const until = toMillis(license.validUntil);
  if (from != null && now < from) return { ok: false, reason: DENIAL.notYetValid };
  if (until != null && now > until) return { ok: false, reason: DENIAL.expired };
  return { ok: true };
}

/**
 * La licence couvre-t-elle CE meeting ?
 *
 * ── Le point que le modèle doit absolument garantir ────────────────────
 * `personId` dit DE QUI on parle. Il ne dit rien de CE QUI a été acheté.
 * Un pilote peut courir la même saison en Championnat de France et en
 * Euro RX sous deux inscriptions distinctes (mesuré : 11 pilotes sur 12
 * dans ce cas, cf. docs/monetisation/AUDITS-ET-PLANS.md §2.3). Une licence
 * FFSA ne doit JAMAIS ouvrir l'Euro RX, et réciproquement.
 *
 * D'où la vérification systématique du championnat ET de l'année, quelle
 * que soit la portée. Pour une portée `meeting`, comparer l'identifiant
 * suffirait en théorie — on vérifie quand même le championnat, parce
 * qu'une licence mal saisie doit échouer fermé plutôt que d'ouvrir large.
 *
 * Cas concret : Lohéac 2026-08-30 existe en DEUX meetings, un par
 * championnat. Ce sont deux droits différents.
 *
 * @param {object} license
 * @param {{id:string, championshipId:string|null, year:number}} meeting
 * @returns {{ok:boolean, reason?:string}}
 */
export function licenseCoversMeeting(license, meeting) {
  if (!license || !meeting) return { ok: false, reason: DENIAL.wrongScope };

  // Le périmètre commercial est d'abord un championnat et une saison.
  if (String(license.championshipId || '') !== String(meeting.championshipId || '')) {
    return { ok: false, reason: DENIAL.wrongScope };
  }
  if (Number(license.year) !== Number(meeting.year)) {
    return { ok: false, reason: DENIAL.wrongScope };
  }

  if (license.scope === 'season') return { ok: true };

  if (license.scope === 'meeting') {
    return String(license.meetingId || '') === String(meeting.id)
      ? { ok: true }
      : { ok: false, reason: DENIAL.wrongScope };
  }

  // Portée inconnue : on refuse. Une valeur inattendue en base ne doit pas
  // se traduire par un accès, même par accident.
  return { ok: false, reason: DENIAL.wrongScope };
}

// ─────────────────────────────────────────────────────────
// DÉCISION
// ─────────────────────────────────────────────────────────

/**
 * Décision d'accès pour une fiche pilote sur un meeting donné.
 *
 * @param {object} p
 * @param {Array}  p.licenses — licences des teams de l'utilisateur
 * @param {string} p.personId — fiche pilote analysée
 * @param {object} p.meeting  — {id, championshipId, year}
 * @param {boolean} [p.isAdmin=false] — court-circuit total
 * @param {number} [p.now]
 * @returns {{allowed:boolean, license:object|null, reason:string|null}}
 */
export function canAnalysePerson({ licenses = [], personId, meeting, isAdmin = false, now = Date.now() } = {}) {
  // L'administrateur passe AVANT toute vérification : il ne détient aucune
  // licence et ne doit jamais avoir à s'en fabriquer une pour travailler.
  if (isAdmin) return { allowed: true, license: null, reason: null };

  if (!personId) return { allowed: false, license: null, reason: DENIAL.unknownDriver };

  // On retient le motif le plus « proche du but » pour pouvoir expliquer :
  // une licence expirée sur le bon meeting est un message différent d'une
  // licence valide sur un autre championnat.
  let best = DENIAL.noLicense;
  const rank = {
    [DENIAL.noLicense]: 0, [DENIAL.wrongScope]: 1,
    [DENIAL.notActive]: 2, [DENIAL.notYetValid]: 3, [DENIAL.expired]: 4,
  };

  for (const lic of licenses) {
    if (String(lic.personId || '') !== String(personId)) continue;

    const scope = licenseCoversMeeting(lic, meeting);
    if (!scope.ok) {
      if ((rank[scope.reason] ?? 0) > (rank[best] ?? 0)) best = scope.reason;
      continue;
    }
    const validity = licenseValidity(lic, now);
    if (!validity.ok) {
      if ((rank[validity.reason] ?? 0) > (rank[best] ?? 0)) best = validity.reason;
      continue;
    }
    return { allowed: true, license: lic, reason: null };
  }
  return { allowed: false, license: null, reason: best };
}

/**
 * Même décision, mais à partir d'un `driverId` sportif.
 *
 * C'est la forme qu'utilise l'interface : Stratégie Live raisonne en
 * inscriptions (`driverId`), le commerce raisonne en personnes
 * (`personId`). La traduction se fait ici, et nulle part ailleurs.
 *
 * @param {object} p
 * @param {Map<string,string>|object} p.personByDriver — driverId → personId
 */
export function canAnalyseDriver({ licenses, driverId, personByDriver, meeting, isAdmin = false, now = Date.now() } = {}) {
  if (isAdmin) return { allowed: true, license: null, reason: null };
  const personId = personByDriver instanceof Map
    ? personByDriver.get(driverId)
    : personByDriver?.[driverId];
  if (!personId) return { allowed: false, license: null, reason: DENIAL.unknownDriver };
  return canAnalysePerson({ licenses, personId, meeting, isAdmin, now });
}

/**
 * Ensemble des `driverId` analysables sur ce meeting.
 *
 * Sert à FILTRER le sélecteur de pilote. Le moteur, lui, continue de
 * charger tout le plateau : la restriction porte sur le pilote ANALYSÉ,
 * jamais sur les adversaires utilisés par les simulations.
 *
 * ── Contrat, et pourquoi `driverIds` compte ────────────────────────────
 * L'autorisation se décide par PERSONNE et par MEETING. Or une personne
 * peut porter plusieurs inscriptions, y compris dans un autre championnat
 * — Fabien Pailler est #7 Supercar en FFSA et #29 RX1 en Euro RX. Si on
 * balayait toute la table `personByDriver`, une licence FFSA ferait
 * remonter AUSSI son inscription Euro RX : inoffensif tant que l'appelant
 * recoupe avec le plateau réel, dangereux le jour où il oublie.
 *
 * On exige donc de l'appelant qu'il dise quelles inscriptions sont
 * réellement au départ de ce meeting. `state.standings` le donne
 * directement. Sans cet argument, on retombe sur la table complète et le
 * risque décrit ci-dessus.
 *
 * @param {object} p
 * @param {string[]|null} [p.driverIds=null] — inscriptions présentes sur CE
 *        meeting. Recommandé. `null` = toute la table `personByDriver`.
 * @returns {Set<string>}
 */
export function allowedDriverIds({
  licenses = [], personByDriver, driverIds = null, meeting, isAdmin = false, now = Date.now(),
} = {}) {
  const lookup = personByDriver instanceof Map
    ? (id) => personByDriver.get(id)
    : (id) => personByDriver?.[id];
  const ids = driverIds ?? (personByDriver instanceof Map
    ? [...personByDriver.keys()]
    : Object.keys(personByDriver || {}));

  if (isAdmin) return new Set(ids);

  const out = new Set();
  for (const driverId of ids) {
    const personId = lookup(driverId);
    if (!personId) continue;
    if (canAnalysePerson({ licenses, personId, meeting, now }).allowed) out.add(driverId);
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// ÉTAT DU VISITEUR
// ─────────────────────────────────────────────────────────

/** Niveaux, du plus ouvert au plus fermé. */
export const VIEWER = {
  admin:      'admin',       // accès total, aucune licence requise
  loading:    'loading',     // droits pas encore connus — ne RIEN affirmer
  anonymous:  'anonymous',   // pas de compte, ou session anonyme (pronostics)
  unverified: 'unverified',  // compte réel, adresse non confirmée
  none:       'none',        // compte valide, aucune licence
  licensed:   'licensed',    // au moins une licence lisible
};

/**
 * Que doit montrer Stratégie Live à ce visiteur ?
 *
 * Séparé du rendu pour être testable sans DOM ni Firebase — c'est la table
 * de décision que le lot A0 doit garantir, et elle mérite mieux qu'une
 * vérification à l'œil.
 *
 * ── Pourquoi `loading` est un niveau à part ────────────────────────────
 * Tant que les licences ne sont pas chargées, on ne peut pas dire « vous
 * n'avez pas accès » : ce serait faux à chaque ouverture de page, et c'est
 * précisément le message qui fait douter un client qui a payé. On affiche
 * une attente, jamais un refus.
 *
 * @param {object} p
 * @param {boolean} p.isAdmin @param {boolean} p.isRealUser
 * @param {boolean} p.isVerified @param {boolean} p.accessReady
 * @param {Array} p.licenses
 * @returns {{level:string, ready:boolean, canSeeAnything:boolean}}
 */
export function viewerState({
  isAdmin = false, isRealUser = false, isVerified = false,
  accessReady = false, licenses = [],
} = {}) {
  // L'administrateur passe avant tout, y compris avant le chargement des
  // droits : il n'en a aucun à charger.
  if (isAdmin) return { level: VIEWER.admin, ready: true, canSeeAnything: true };
  if (!isRealUser) return { level: VIEWER.anonymous, ready: true, canSeeAnything: false };
  if (!isVerified) return { level: VIEWER.unverified, ready: true, canSeeAnything: false };
  if (!accessReady) return { level: VIEWER.loading, ready: false, canSeeAnything: false };
  return licenses.length
    ? { level: VIEWER.licensed, ready: true, canSeeAnything: true }
    : { level: VIEWER.none, ready: true, canSeeAnything: false };
}

// ─────────────────────────────────────────────────────────
// LIBELLÉS
// ─────────────────────────────────────────────────────────

/**
 * Message affiché quand l'accès est refusé.
 *
 * Un écran vide ou cassé laisse croire à une panne et fait perdre la
 * confiance d'un client qui, lui, a bien un accès — ailleurs. On dit donc
 * précisément ce qui manque.
 */
export function denialMessage(reason, { hasAnyLicense = false } = {}) {
  switch (reason) {
    case DENIAL.wrongScope:
      return "Cette analyse n'est pas incluse dans votre accès : elle porte sur un autre championnat ou un autre meeting.";
    case DENIAL.expired:
      return "Votre accès pour ce pilote est arrivé à échéance.";
    case DENIAL.notYetValid:
      return "Votre accès pour ce pilote n'est pas encore ouvert.";
    case DENIAL.notActive:
      return "Votre accès pour ce pilote est suspendu.";
    case DENIAL.unknownDriver:
      return "Ce pilote n'est rattaché à aucune fiche pilote : l'accès ne peut pas être vérifié.";
    default:
      return hasAnyLicense
        ? "Cette analyse n'est pas incluse dans votre accès."
        : "Stratégie Live est réservé aux teams disposant d'un accès.";
  }
}

/** Libellé court d'une portée, pour l'écran d'administration et le bandeau. */
export function scopeLabel(license, { meetingLabel = null, championshipLabel = null } = {}) {
  // Ordre de préférence : le libellé fourni par l'appelant (qui a les
  // référentiels sous la main), puis celui FIGÉ sur la licence à
  // l'attribution, puis l'identifiant brut en dernier recours. Ce dernier
  // cas ne devrait jamais s'afficher à un client.
  const champ = championshipLabel || license?.championshipLabel || license?.championshipId || '?';
  if (license?.scope === 'season') return `Saison ${champ} ${license.year}`;
  const mtg = meetingLabel || license?.meetingLabel || license?.meetingId || '?';
  return `${mtg} · ${champ}`;
}

/**
 * Résumé des accès en cours, pour le bandeau affiché au team.
 * Trié par nom de pilote pour rester stable d'un rendu à l'autre.
 */
export function accessSummary({ licenses = [], now = Date.now(), personsById = {}, championshipsById = {}, meetingsById = {} } = {}) {
  return licenses
    .filter(l => licenseValidity(l, now).ok)
    .map(l => {
      const p = personsById[l.personId];
      const m = meetingsById[l.meetingId];
      return {
        licenseId: l.id,
        personId: l.personId,
        personLabel: p ? `${p.firstName || ''} ${p.lastName || ''}`.trim()
                       : (l.personLabel || l.personId),
        scope: l.scope,
        scopeLabel: scopeLabel(l, {
          championshipLabel: championshipsById[l.championshipId]?.name,
          meetingLabel: m ? `${m.date || ''} ${m.location || ''}`.trim() : null,
        }),
        validUntil: toMillis(l.validUntil),
        origin: l.origin,
      };
    })
    .sort((a, b) => a.personLabel.localeCompare(b.personLabel, 'fr'));
}
