/* ═══════════════════════════════════════════════
   OBS-PRONO-AUTO.JS — Automatisation des pronostics (championnats
   suivis en direct via un provider de chronométrage, ex. ITS Live / FFSA)

   Portée volontairement étroite : cette automatisation ne lit JAMAIS le
   contenu des temps. Elle ne fait que deux choses par catégorie :
     1. FERMER le pronostic « au résultat » ouvert dès qu'AU MOINS UN temps
        apparaît côté provider pour la session en cours (sans savoir lequel).
     2. OUVRIR le pronostic de la session suivante une fois que le NOMBRE de
        temps reçus égale le nombre d'engagés prévus (session « complète »).
   L'ouverture du tout premier pronostic d'une catégorie (EC ou manche 1)
   est déclenchée localement dès que des `sessionParticipants` existent pour
   cette session — aucun appel provider nécessaire pour ce déclencheur.

   La RÉVÉLATION reste entièrement manuelle (import des temps à la main +
   bouton « Révéler » de la régie, cf. control.html) : cette automatisation
   n'y touche jamais.

   État persisté par catégorie : `pronoAuto/{meetingId}_{category}`
   (un seul document, pas de sous-collection). Volontairement dérivé au
   maximum de données déjà existantes (sessions, sessionParticipants,
   pronostics) — seul le nécessaire (activé ?, étape en cours, ids des
   pronostics de cette étape) est mémorisé ici, ce qui permet à
   l'automatisation de survivre à un rechargement de la page régie sans se
   désynchroniser de la réalité.

   Piloté depuis control.html : la page régie appelle `runAutoTick(...)` à
   intervalle régulier pour chaque catégorie activée du meeting affiché
   (l'appel réel au provider est lui-même throttlé en interne à ~90s, cf.
   POLL_INTERVAL_MS, pour ne pas solliciter ITS trop souvent).
═══════════════════════════════════════════════ */

import { watchQuery, getDocById, setDocMerged } from './obs-firebase.js';
import { getSessions, getParticipants } from './obs-data.js';
import { createPronostic, openPronostic, closePronostic } from './obs-pronostics.js';
import { getProvider } from '../../js/providers/index.js';

export const PRONO_AUTO_COL = 'pronoAuto';

// Appel réel au provider (listSessions/getRanking) au plus une fois par
// catégorie toutes les ~90s, quelle que soit la fréquence d'appel de
// runAutoTick() par le caller (cf. control.html, qui peut ticker plus vite
// pour rester réactif aux déclencheurs purement Firestore).
const POLL_INTERVAL_MS = 90 * 1000;

// Cache court des sessions distantes (un seul appel `listSessions` peut
// servir plusieurs catégories du même événement).
const REMOTE_SESSIONS_TTL_MS = 60 * 1000;
const _remoteSessionsCache = new Map();   // key -> { at, sessions }

// ─────────────────────────────────────────────────────────
// CACHE LOCAL (Firestore) — runAutoTick() est appelée par le caller à un
// rythme bien plus fréquent (cf. control.html) que ce dont la logique a
// réellement besoin : `sessions` et `sessionParticipants` ne changent quasi
// jamais en cours de meeting. Sans ce cache, chaque tick relisait
// intégralement ces collections (des dizaines de documents), multiplié par
// le nombre de catégories activées — largement suffisant pour épuiser le
// quota Firestore gratuit en quelques heures. Un cache court (30-60s)
// élimine l'essentiel de ce coût sans perdre en réactivité perceptible.
// ─────────────────────────────────────────────────────────
const SESSIONS_CACHE_TTL_MS = 60 * 1000;
const _sessionsCache = new Map();         // `${meetingId}|${category}` -> { at, sessions }
const PARTICIPANTS_CACHE_TTL_MS = 30 * 1000;
const _participantsCache = new Map();     // sessionId -> { at, participants }

async function cachedSessions(meetingId, category) {
  const key = meetingId + '|' + category;
  const hit = _sessionsCache.get(key);
  if (hit && (Date.now() - hit.at) < SESSIONS_CACHE_TTL_MS) return hit.sessions;
  const sessions = await getSessions(meetingId, category);
  _sessionsCache.set(key, { at: Date.now(), sessions });
  return sessions;
}

async function cachedParticipants(sessionId) {
  const hit = _participantsCache.get(sessionId);
  if (hit && (Date.now() - hit.at) < PARTICIPANTS_CACHE_TTL_MS) return hit.participants;
  const participants = await getParticipants(sessionId);
  _participantsCache.set(sessionId, { at: Date.now(), participants });
  return participants;
}

export function autoDocId(meetingId, category) {
  return `${meetingId}_${category}`;
}

// ─────────────────────────────────────────────────────────
// ORDRE DES SESSIONS D'UNE CATÉGORIE — dérivé des documents Firestore
// réels (jamais codé en dur : s'adapte à un meeting sans EC, avec un
// nombre de manches différent, etc.)
// Ordre piste : EC → MQ1..N → QF1..N (si utilisé) → DF (½ B=num2 AVANT
// ½ A=num1, comme sur la piste) → FIN.
// ─────────────────────────────────────────────────────────

const PHASE_ORDER = { EC: 0, MQ: 1, QF: 2, DF: 3, FIN: 4 };
function stepOrderKey(s) {
  const base = (PHASE_ORDER[s.type] ?? 9) * 100;
  if (s.type === 'DF') return base + (s.num === 2 ? 0 : 1);   // ½ B avant ½ A
  return base + (s.num || 1);
}

/** Chaîne ordonnée des sessions d'une catégorie (docs `sessions` bruts). */
export function deriveChain(sessions) {
  return sessions
    .filter(s => s.type in PHASE_ORDER)
    .slice()
    .sort((a, b) => stepOrderKey(a) - stepOrderKey(b));
}

// ─────────────────────────────────────────────────────────
// PRONOSTIC(S) D'UNE ÉTAPE — reproduit fidèlement (en pur, sans état UI)
// la logique du composer manuel de control.html (autoTitle/pronoTargetFor).
// Une manche >= 2 ouvre TOUJOURS le prono « vainqueur » ET le prono
// « leader intermédiaire » ensemble (même déclencheur, même fermeture).
// ─────────────────────────────────────────────────────────

function phaseLabelLong(type, num) {
  if (type === 'EC')  return 'les essais chronos';
  if (type === 'MQ')  return 'la manche ' + num;
  if (type === 'QF')  return 'le quart ' + num;
  if (type === 'DF')  return 'la ½ finale ' + (num === 1 ? 'A' : 'B');
  if (type === 'FIN') return 'la finale';
  return 'la course';
}

/** @returns {Array<{type,question,resultTarget}>} 1 ou 2 pronostics pour cette étape. */
export function stepTargets(step, nbMQ, catName) {
  const { type, num } = step;
  const targets = [];
  if (type === 'EC') {
    targets.push({
      type: 'ec_best',
      question: `Qui signe le meilleur temps aux essais chronos ${catName} ?`,
      resultTarget: { kind: 'session', sessionType: 'EC', sessionNum: 1 },
    });
  } else if (type === 'FIN') {
    targets.push({
      type: 'final_winner',
      question: `Qui gagne la finale ${catName} ?`,
      resultTarget: { kind: 'session', sessionType: 'FIN', sessionNum: 1 },
    });
  } else if (type === 'MQ' || type === 'QF' || type === 'DF') {
    targets.push({
      type: type === 'MQ' ? 'manche_winner' : type === 'DF' ? 'df_winner' : 'serie_winner',
      question: `Qui gagne ${phaseLabelLong(type, num)} ${catName} ?`,
      resultTarget: { kind: 'session', sessionType: type, sessionNum: num },
    });
    if (type === 'MQ' && num >= 2) {
      const isLast = num === nbMQ;
      targets.push({
        type: isLast ? 'interim_final' : 'interim_m2',
        question: isLast
          ? `Qui sera leader du classement intermédiaire ${catName} à l'issue des ${nbMQ} manches ?`
          : `Qui sera leader du classement intermédiaire ${catName} après la manche ${num} ?`,
        resultTarget: { kind: 'interim_after', sessionType: 'MQ', sessionNum: num },
      });
    }
  }
  return targets;
}

// ─────────────────────────────────────────────────────────
// ÉTAT PERSISTÉ (pronoAuto/{meetingId}_{category})
// phase : 'idle' (étape pas encore ouverte, en attente de déclencheur)
//       | 'open' (pronostic(s) ouverts, en attente d'un 1er temps ITS)
//       | 'awaiting_complete' (fermés, en attente que la session soit complète)
//       | 'done' (chaîne entièrement parcourue)
// ─────────────────────────────────────────────────────────

/** Lecture ponctuelle de l'état d'une catégorie. */
export function getAutoState(meetingId, category) {
  return getDocById(PRONO_AUTO_COL, autoDocId(meetingId, category));
}

/** Abonnement temps réel à tous les états d'automatisation d'un meeting. */
export function watchAutoStates(meetingId, cb, onErr) {
  return watchQuery(PRONO_AUTO_COL, [['meetingId', '==', meetingId]], cb, onErr);
}

/**
 * Active/désactive l'automatisation d'une catégorie. Un ré-activation après
 * pause REPREND où l'automatisation s'était arrêtée (stepIndex/phase
 * conservés) — seule une toute première activation initialise l'état.
 */
export async function setAutoEnabled(meetingId, category, championshipId, enabled) {
  const id = autoDocId(meetingId, category);
  const existing = await getDocById(PRONO_AUTO_COL, id);
  if (!existing) {
    await setDocMerged(PRONO_AUTO_COL, id, {
      meetingId, category, championshipId, enabled,
      stepIndex: 0, phase: 'idle', pronoIds: [],
      lastRowCount: null, lastPolledAt: null, lastError: null,
      updatedAt: Date.now(),
    });
  } else {
    await setDocMerged(PRONO_AUTO_COL, id, { enabled, updatedAt: Date.now() });
  }
}

/**
 * Filet de sécurité manuel : passe à l'étape suivante de la chaîne sans
 * attendre la condition ITS (utile si un pilote DNS ne remontera jamais
 * dans le classement et bloque le compte d'engagés). Ferme au mieux les
 * pronostics de l'étape en cours si besoin. Les boutons manuels habituels
 * restent par ailleurs disponibles à tout moment, automatisation activée
 * ou non.
 */
export async function forceAdvanceStep(meetingId, category) {
  const id = autoDocId(meetingId, category);
  const cur = await getDocById(PRONO_AUTO_COL, id);
  if (!cur) return;
  for (const pid of (cur.pronoIds || [])) {
    try { await closePronostic(pid); } catch { /* déjà fermé/supprimé : sans effet */ }
  }
  await setDocMerged(PRONO_AUTO_COL, id, {
    stepIndex: (cur.stepIndex ?? 0) + 1, phase: 'idle', pronoIds: [],
    lastError: null, updatedAt: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────
// PROVIDER — configuration + correspondance session distante
// ─────────────────────────────────────────────────────────

/** Charge la config provider (championnat + meeting) ; null si incomplète/absente. */
export async function loadTimingConfig(championshipId, meetingId) {
  const [champ, meeting] = await Promise.all([
    championshipId ? getDocById('championships', championshipId) : Promise.resolve(null),
    meetingId ? getDocById('meetings', meetingId) : Promise.resolve(null),
  ]);
  const tp = champ?.timingProvider;
  const tpe = meeting?.timingProviderEvent;
  if (!tp?.id || !tpe) return null;
  const provider = getProvider(tp.id);
  if (!provider) return null;
  const config = { ...tp, ...tpe };
  delete config.id;
  return { provider, config };
}

async function loadRemoteSessions(provider, config) {
  const key = provider.id + '|' + JSON.stringify(config);
  const hit = _remoteSessionsCache.get(key);
  if (hit && (Date.now() - hit.at) < REMOTE_SESSIONS_TTL_MS) return hit.sessions;
  const sessions = await provider.listSessions(config);
  _remoteSessionsCache.set(key, { at: Date.now(), sessions });
  return sessions;
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false;
  const norm = x => String(x).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const na = norm(a), nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Cas réel rencontré : une catégorie RX Chrono abrégée ("D4") ne partage
// aucune sous-chaîne avec le nom complet côté ITS ("Division 4") — le
// simple fuzzyMatch (sous-chaîne) échoue alors qu'il s'agit bien de la
// même catégorie. On isole le numéro de division quand le motif "D<n>" /
// "Division <n>" est présent des deux côtés, pour les comparer sur cette
// seule base plutôt que sur le texte brut.
function normalizeCategoryKey(s) {
  const raw = String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const div = raw.match(/\bd(?:ivision)?\.?\s*(\d+)\b/);
  return div ? 'div' + div[1] : raw.replace(/[^a-z0-9]/g, '');
}
function categoryMatches(a, b) {
  if (!a || !b) return false;
  return normalizeCategoryKey(a) === normalizeCategoryKey(b) || fuzzyMatch(a, b);
}

/**
 * Retrouve LA session distante correspondant à une étape (catégorie + type
 * + numéro). Contrairement à l'assistant d'import manuel (qui laisse
 * choisir en cas d'ambiguïté), l'automatisation exige une correspondance
 * UNIQUE — sinon elle s'abstient plutôt que de risquer de suivre la
 * mauvaise session.
 */
async function matchRemoteSession(provider, config, step, catName) {
  const sessions = await loadRemoteSessions(provider, config);
  const matches = sessions.filter(s =>
    (!s.category || categoryMatches(s.category, catName)) &&
    s.type === step.type &&
    (s.num == null || step.num == null || s.num === step.num)
  );
  return matches.length === 1 ? matches[0] : null;
}

async function fetchItsRowCount(provider, config, step, catName) {
  const remote = await matchRemoteSession(provider, config, step, catName);
  if (!remote) throw new Error(`Session ITS introuvable/ambiguë pour ${step.type}${step.num || ''}`);
  const rows = await provider.getRanking({ ...config, session_id: remote.session_id });
  return rows.length;
}

// ─────────────────────────────────────────────────────────
// TICK — machine à états, un appel = un pas pour UNE catégorie.
// Sans effet (retour immédiat) si l'automatisation n'est pas activée ou
// si le throttle ITS (POLL_INTERVAL_MS) n'est pas encore écoulé.
// ─────────────────────────────────────────────────────────

export async function runAutoTick({ meetingId, category, championshipId, catName }) {
  const id = autoDocId(meetingId, category);
  let state;
  try { state = await getDocById(PRONO_AUTO_COL, id); } catch { return; }
  if (!state || !state.enabled) return;

  const sessions = await cachedSessions(meetingId, category);
  const chain = deriveChain(sessions);
  const stepIndex = state.stepIndex ?? 0;

  if (stepIndex >= chain.length) {
    if (state.phase !== 'done') await setDocMerged(PRONO_AUTO_COL, id, { phase: 'done', updatedAt: Date.now() });
    return;
  }
  const step = chain[stepIndex];
  const nbMQ = chain.filter(s => s.type === 'MQ').length;

  try {
    const phase = state.phase || 'idle';

    if (phase === 'idle') {
      // 1re étape de la chaîne : déclenchée par l'assignation des engagés
      // (aucun appel provider nécessaire). Étapes suivantes : déjà
      // déclenchées par l'étape précédente (awaiting_complete → idle),
      // on ouvre donc dès que possible.
      const participants = await cachedParticipants(step.id);
      const shouldOpen = stepIndex > 0 || participants.length > 0;
      if (!shouldOpen) return;
      if (participants.length < 2) {
        await setDocMerged(PRONO_AUTO_COL, id, {
          lastError: 'Moins de 2 engagés sur la session — ouverture manuelle nécessaire.',
          updatedAt: Date.now(), stepType: step.type, stepNum: step.num ?? null,
        });
        return;
      }

      const options = participants
        .slice()
        .sort((a, b) => (Number(a.carNumber) || 0) - (Number(b.carNumber) || 0))
        .map(p => ({ driverId: p.driverId, num: String(p.carNumber ?? ''), name: (p.lastName || '').trim() }));

      const targets = stepTargets(step, nbMQ, catName);
      const pronoIds = [];
      for (const t of targets) {
        const pid = await createPronostic({
          question: t.question, type: t.type,
          category, meetingId, championshipId,
          options, resultTarget: t.resultTarget,
        });
        await openPronostic(pid);
        pronoIds.push(pid);
      }
      await setDocMerged(PRONO_AUTO_COL, id, {
        phase: 'open', pronoIds, lastError: null, updatedAt: Date.now(),
        stepType: step.type, stepNum: step.num ?? null,
      });
      return;
    }

    if (phase === 'open' || phase === 'awaiting_complete') {
      // Appel provider throttlé — jamais plus d'une fois par POLL_INTERVAL_MS,
      // même si runAutoTick() est appelée plus souvent par le caller.
      if (state.lastPolledAt && (Date.now() - state.lastPolledAt) < POLL_INTERVAL_MS) return;

      const timing = await loadTimingConfig(championshipId, meetingId);
      if (!timing) {
        await setDocMerged(PRONO_AUTO_COL, id, {
          lastPolledAt: Date.now(),
          lastError: 'Provider de chronométrage non configuré pour ce championnat/meeting.',
          updatedAt: Date.now(),
        });
        return;
      }

      const rowCount = await fetchItsRowCount(timing.provider, timing.config, step, catName);
      const patch = {
        lastPolledAt: Date.now(), lastRowCount: rowCount, lastError: null, updatedAt: Date.now(),
        stepType: step.type, stepNum: step.num ?? null,
      };

      if (phase === 'open') {
        // Dès qu'AU MOINS UN temps existe (sans savoir lequel) → fermeture immédiate.
        if (rowCount > 0) {
          for (const pid of (state.pronoIds || [])) { try { await closePronostic(pid); } catch { /* déjà fermé */ } }
          patch.phase = 'awaiting_complete';
        }
        await setDocMerged(PRONO_AUTO_COL, id, patch);
        return;
      }

      // phase === 'awaiting_complete' : session « complète » dès que le
      // NOMBRE de temps ITS égale le nombre d'engagés prévus (sans lire les
      // temps eux-mêmes) → ouverture de l'étape suivante.
      const participants = await cachedParticipants(step.id);
      if (participants.length > 0 && rowCount >= participants.length) {
        const nextIndex = stepIndex + 1;
        const nextStep = chain[nextIndex] || null;
        patch.stepIndex = nextIndex;
        patch.phase = nextIndex >= chain.length ? 'done' : 'idle';
        patch.pronoIds = [];
        patch.stepType = nextStep ? nextStep.type : null;
        patch.stepNum = nextStep ? (nextStep.num ?? null) : null;
      }
      await setDocMerged(PRONO_AUTO_COL, id, patch);
    }
  } catch (err) {
    await setDocMerged(PRONO_AUTO_COL, id, {
      lastError: err.message || String(err), lastPolledAt: Date.now(), updatedAt: Date.now(),
    }).catch(() => {});
  }
}
