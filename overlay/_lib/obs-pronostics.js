/* ═══════════════════════════════════════════════
   OBS-PRONOSTICS.JS — Pronostics spectateurs
   1 pronostic = 1 document `pronostics/{id}` (question + pilotes + statut).
   Les votes vivent en sous-collection `pronostics/{id}/votes/{uid}`
   (1 doc par spectateur → recharger la page ne recrée pas de vote).

   Confidentialité (cf. règles Firestore) :
   - lecture du doc pronostic : publique (question, pilotes, statut, et
     décompte agrégé `tally` écrit UNIQUEMENT à la fermeture) ;
   - lecture des votes individuels : régie (compte non-anonyme) seulement ;
   - un spectateur ne peut lire/écrire QUE son propre vote, et seulement
     tant que le pronostic est « open ».

   Même app Firebase que les overlays (init idempotente partagée).
═══════════════════════════════════════════════ */

import { db, initFirebase } from './obs-firebase.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
let _fs = null, _auth = null;

async function fs() { if (!_fs) _fs = await import(SDK + 'firebase-firestore.js'); return _fs; }
async function authMod() { if (!_auth) _auth = await import(SDK + 'firebase-auth.js'); return _auth; }

export const PRONO_COL = 'pronostics';

/** Statuts d'un pronostic. */
export const PRONO_STATUS = { DRAFT: 'draft', OPEN: 'open', CLOSED: 'closed', REVEALED: 'revealed' };

// ─────────────────────────────────────────────────────────
// LECTURE — publique (régie, overlay, spectateur)
// ─────────────────────────────────────────────────────────

/** Abonnement temps réel à la liste des pronostics (plus récents d'abord). */
export async function watchPronostics(cb, onErr) {
  await initFirebase();
  const { collection, query, orderBy, onSnapshot } = await fs();
  return onSnapshot(
    query(collection(db, PRONO_COL), orderBy('createdAt', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => { console.error('[prono] liste', err.code, err.message); onErr && onErr(err); }
  );
}

/** Abonnement temps réel à un pronostic unique (pour l'overlay à l'antenne). */
export async function watchPronostic(id, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, PRONO_COL, id),
    s => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    err => { console.error('[prono] doc', err.code, err.message); onErr && onErr(err); });
}

// ─────────────────────────────────────────────────────────
// RÉGIE — écriture (compte non-anonyme requis par les règles)
// ─────────────────────────────────────────────────────────

/**
 * Crée un pronostic (statut brouillon par défaut).
 * @param {{question,type,category,meetingId,championshipId,options,status?}} data
 * @returns {Promise<string>} id du nouveau doc
 */
export async function createPronostic(data, nowMs) {
  await initFirebase();
  const { collection, addDoc } = await fs();
  const ref = await addDoc(collection(db, PRONO_COL), {
    question:       data.question || '',
    type:           data.type || 'custom',
    category:       data.category || '',
    meetingId:      data.meetingId || '',
    championshipId: data.championshipId || '',
    options:        Array.isArray(data.options) ? data.options : [],
    resultTarget:   data.resultTarget || { kind: 'manual' },   // d'où vient le vrai gagnant
    status:         data.status || PRONO_STATUS.DRAFT,
    correctDriverId:'',
    tally:          {},
    totalVotes:     0,
    createdAt:      nowMs || Date.now(),
  });
  return ref.id;
}

/** Met à jour (merge) un pronostic. */
export async function updatePronostic(id, patch) {
  await initFirebase();
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, PRONO_COL, id), patch, { merge: true });
}

/** Supprime un pronostic (les votes en sous-collection restent orphelins côté Firestore ; sans impact d'affichage). */
export async function deletePronostic(id) {
  await initFirebase();
  const { doc, deleteDoc } = await fs();
  await deleteDoc(doc(db, PRONO_COL, id));
}

/** Ouvre les votes. */
export function openPronostic(id, nowMs) {
  return updatePronostic(id, { status: PRONO_STATUS.OPEN, openedAt: nowMs || Date.now(), correctDriverId: '' });
}

/**
 * Lit tous les votes et agrège le décompte par pilote.
 * @returns {Promise<{counts:Object,total:number}>}
 */
export async function tallyVotes(id) {
  await initFirebase();
  const { collection, getDocs } = await fs();
  const snap = await getDocs(collection(db, PRONO_COL, id, 'votes'));
  const counts = {}; let total = 0;
  snap.forEach(d => { const v = d.data().driverId; if (v) { counts[v] = (counts[v] || 0) + 1; total++; } });
  return { counts, total };
}

/**
 * Bilan des votes d'une ÉPREUVE (meeting) : votants UNIQUES (un pilote qui vote sur
 * plusieurs pronostics ne compte qu'une fois), total de votes, et détail par pronostic.
 * Lit les sous-collections `votes` (réservé à la régie / compte non-anonyme).
 * @returns {Promise<{uniqueVoters:number,totalVotes:number,nbPronostics:number,pronostics:Array}>}
 */
export async function meetingVoteBilan(meetingId) {
  await initFirebase();
  const { collection, getDocs, query, where } = await fs();
  const psnap = await getDocs(query(collection(db, PRONO_COL), where('meetingId', '==', meetingId)));
  const uids = new Set();
  let totalVotes = 0;
  const pronostics = [];
  for (const pdoc of psnap.docs) {
    const vsnap = await getDocs(collection(db, PRONO_COL, pdoc.id, 'votes'));
    let n = 0;
    vsnap.forEach(v => { uids.add(v.id); n++; });   // v.id = UID du votant
    totalVotes += n;
    const d = pdoc.data();
    pronostics.push({ id: pdoc.id, question: d.question || '', category: d.category || '', status: d.status || '', votes: n });
  }
  pronostics.sort((a, b) => b.votes - a.votes);
  return { uniqueVoters: uids.size, totalVotes, nbPronostics: pronostics.length, pronostics };
}

// ─────────────────────────────────────────────────────────
// POINTS PRONOSTIQUEURS (par épreuve) — barème « à la cote »
// Plus le gagnant trouvé était un outsider (faible cote), plus ça rapporte. La cote
// (rang de force) combine la FORME DU MEETING (classement intermédiaire/essais, poids
// fort) et le CHAMPIONNAT (saison) — calculée par la régie et passée ici via strengthByCat.
// Calculé PAR LA RÉGIE (lecture des votes) → infalsifiable. Écrit dans
// pronoScores/{meetingId} (lecture publique). Remis à zéro par épreuve.
// ─────────────────────────────────────────────────────────

const SCORES_COL = 'pronoScores';

/** Barème 5→1 selon la cote du gagnant (rang de force : 1 = grand favori → 1 pt ;
 *  outsider ou non classé → 5 pts). */
export function cotePoints(pos) {
  if (pos == null) return 5;
  if (pos <= 1) return 1;
  if (pos <= 3) return 2;
  if (pos <= 6) return 3;
  if (pos <= 10) return 4;
  return 5;
}

/**
 * Recalcule les points « pronostiqueurs » d'une épreuve depuis zéro (idempotent) et
 * les écrit dans pronoScores/{meetingId}. À n'appeler QUE côté régie (lecture des votes).
 * @param {Object} strengthByCat  { [category]: { [driverId]: rangDeForce } } (1 = favori)
 * @returns {Promise<Object>} map uid -> points cumulés
 */
export async function updateMeetingScores(meetingId, strengthByCat = {}) {
  await initFirebase();
  const { collection, getDocs, query, where, doc, setDoc } = await fs();
  const psnap = await getDocs(query(collection(db, PRONO_COL), where('meetingId', '==', meetingId)));
  // uid anonyme -> uid Twitch canonique (lien créé au moment d'une connexion Twitch,
  // voir netlify/functions/twitch-auth.js). Un spectateur qui s'est connecté à Twitch
  // PENDANT le meeting a pu voter sous deux uid différents (l'ancien anonyme, puis le
  // nouveau uid Twitch) : sans cette résolution, ses points se répartiraient entre les
  // deux au lieu de compter pour le même joueur.
  const linksSnap = await getDocs(collection(db, 'uidLinks'));
  const canonicalOf = {};
  linksSnap.forEach(d => { canonicalOf[d.id] = d.data().canonicalUid; });

  const scores = {};
  for (const pdoc of psnap.docs) {
    const p = pdoc.data();
    if (p.status !== PRONO_STATUS.REVEALED || !p.correctDriverId) continue;   // seuls les révélés comptent
    const pos = (strengthByCat[p.category] || {})[p.correctDriverId];         // cote du gagnant
    const pts = cotePoints(pos);
    if (!pts) continue;
    const vsnap = await getDocs(collection(db, PRONO_COL, pdoc.id, 'votes'));
    // DÉDUPLICATION PAR QUESTION : si la même personne a voté juste sous
    // DEUX uid différents pour CETTE question (ex. une fois en anonyme,
    // une fois après connexion Twitch), les deux votes résolvent au même
    // uid canonique — un Set garantit qu'elle ne marque qu'UNE fois les
    // points de cette question, jamais deux.
    const correctCanonicalUids = new Set();
    vsnap.forEach(v => {
      if (v.data().driverId !== p.correctDriverId) return;
      correctCanonicalUids.add(resolveCanonicalUid(canonicalOf, v.id));
    });
    correctCanonicalUids.forEach(uid => { scores[uid] = (scores[uid] || 0) + pts; });
  }
  await setDoc(doc(db, SCORES_COL, meetingId), { meetingId, scores, updatedAt: Date.now() });
  return scores;
}

/**
 * Résout un uid jusqu'à son identité canonique finale, en suivant TOUTE la
 * chaîne de uidLinks (pas un seul niveau) : un ancien uid anonyme peut
 * pointer vers un uid Twitch synthétique, qui peut lui-même avoir été
 * rattaché plus tard à un compte réel. Le cap à 5 sauts est une garde-fou
 * contre une boucle si des données étaient corrompues — la chaîne normale
 * ne dépasse jamais 2 niveaux.
 */
function resolveCanonicalUid(canonicalOf, uid) {
  let current = uid, hops = 0;
  while (canonicalOf[current] && canonicalOf[current] !== current && hops < 5) {
    current = canonicalOf[current];
    hops++;
  }
  return current;
}

/** Abonnement au tableau des points d'une épreuve (lecture PUBLIQUE). cb reçoit la map uid->points. */
export async function watchMeetingScores(meetingId, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, SCORES_COL, meetingId),
    snap => cb(snap.exists() ? (snap.data().scores || {}) : {}),
    err => onErr && onErr(err));
}

// ─────────────────────────────────────────────────────────
// PSEUDOS PRONOSTIQUEURS
// A) auto : pseudo « fun » déterministe depuis l'UID (aucune donnée stockée, anonyme).
// B) perso (option) : le joueur peut choisir son pseudo → players/{uid}.pseudo
//    (écriture réservée au propriétaire ; lecture publique pour l'afficher au classement).
// ─────────────────────────────────────────────────────────

const PLAYERS_COL = 'players';
const _PS_EMO  = ['🦊','🦅','🐺','🐆','🦉','🐂','🦈','🐍','🦡','🐗','🦫','🐎','🐅','🦂'];
const _PS_ANIM = ['Renard','Aigle','Loup','Lynx','Faucon','Guépard','Taureau','Requin','Cobra','Bison','Panthère','Sanglier','Corbeau','Blaireau','Tigre','Scorpion'];

function _psHash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

/** Pseudo auto déterministe (ex. « 🦊 Renard 42 ») — aucune donnée stockée. */
export function autoPseudo(uid) {
  const h = _psHash(uid);
  return `${_PS_EMO[h % _PS_EMO.length]} ${_PS_ANIM[(h >>> 4) % _PS_ANIM.length]} ${(h >>> 9) % 90 + 10}`;
}

/** Pseudo personnalisé d'un joueur (ou null s'il n'en a pas choisi). Lecture publique. */
export async function getPlayerPseudo(uid) {
  await initFirebase();
  const { doc, getDoc } = await fs();
  try { const s = await getDoc(doc(db, PLAYERS_COL, uid)); return s.exists() ? (s.data().pseudo || null) : null; }
  catch { return null; }
}

/** Enregistre le pseudo perso du joueur (le sien uniquement, cf. règles). Renvoie le pseudo nettoyé. */
export async function setPlayerPseudo(uid, pseudo) {
  await initFirebase();
  const { doc, setDoc } = await fs();
  const clean = String(pseudo || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  await setDoc(doc(db, PLAYERS_COL, uid), { pseudo: clean }, { merge: true });
  return clean;
}

/** Ferme les votes et fige le décompte agrégé dans le doc (lisible par le public). */
export async function closePronostic(id, nowMs) {
  const t = await tallyVotes(id);
  await updatePronostic(id, {
    status: PRONO_STATUS.CLOSED, tally: t.counts, totalVotes: t.total, closedAt: nowMs || Date.now(),
  });
  return t;
}

/** Révèle le gagnant (réel) et rafraîchit le décompte figé. */
export async function revealPronostic(id, correctDriverId, nowMs) {
  const t = await tallyVotes(id);
  await updatePronostic(id, {
    status: PRONO_STATUS.REVEALED, correctDriverId: correctDriverId || '',
    tally: t.counts, totalVotes: t.total, revealedAt: nowMs || Date.now(),
  });
  return t;
}

/** Abonnement temps réel aux votes bruts (VUE RÉGIE UNIQUEMENT — décompte live privé). */
export async function watchVotes(id, cb, onErr) {
  await initFirebase();
  const { collection, onSnapshot } = await fs();
  return onSnapshot(collection(db, PRONO_COL, id, 'votes'),
    snap => {
      const counts = {}; let total = 0;
      snap.forEach(d => { const v = d.data().driverId; if (v) { counts[v] = (counts[v] || 0) + 1; total++; } });
      cb({ counts, total });
    },
    err => { console.error('[prono] votes', err.code, err.message); onErr && onErr(err); });
}

// ─────────────────────────────────────────────────────────
// SPECTATEUR — auth anonyme + vote
// ─────────────────────────────────────────────────────────

/**
 * Garantit une session anonyme SANS écraser une session existante.
 * - Page spectateur : pas d'utilisateur → connexion anonyme.
 * - Page régie : déjà connecté (email/mot de passe) → ne fait rien, renvoie l'uid régie.
 * @returns {Promise<string>} uid
 */
let _anonPromise = null;
export function ensureAnon() {
  // Mémoïsé : deux appels concurrents (init en tâche de fond + 1er vote) doivent
  // partager LA MÊME connexion anonyme. Sinon deux signInAnonymously créent deux
  // comptes → le vote est écrit sous un uid, mais le jeton d'auth est l'autre uid
  // → la règle `request.auth.uid == uid` échoue → vote refusé/annulé.
  if (!_anonPromise) {
    _anonPromise = _doEnsureAnon().catch(err => { _anonPromise = null; throw err; });
  }
  return _anonPromise;
}

async function _doEnsureAnon() {
  await initFirebase();
  const { getAuth, signInAnonymously, onAuthStateChanged } = await authMod();
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser.uid;
  // attend l'état initial (persistance locale) avant de décider
  await new Promise(res => { const off = onAuthStateChanged(auth, () => { off(); res(); }); });
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}

/** uid courant (ou null). */
export async function currentUid() {
  await initFirebase();
  const { getAuth } = await authMod();
  return getAuth().currentUser?.uid || null;
}

/** Lit le vote du spectateur pour un pronostic (son propre doc). */
export async function myVote(id, uid) {
  await initFirebase();
  const { doc, getDoc } = await fs();
  const s = await getDoc(doc(db, PRONO_COL, id, 'votes', uid));
  return s.exists() ? (s.data().driverId || null) : null;
}

/** Abonnement temps réel au propre vote du spectateur (pour refléter un changement). */
export async function watchMyVote(id, uid, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, PRONO_COL, id, 'votes', uid),
    s => cb(s.exists() ? (s.data().driverId || null) : null),
    err => { onErr && onErr(err); });
}

/** Enregistre / modifie le vote du spectateur (autorisé tant que le pronostic est ouvert). */
export async function castVote(id, uid, driverId, nowMs) {
  await initFirebase();
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, PRONO_COL, id, 'votes', uid), { driverId, at: nowMs || Date.now() }, { merge: true });
}

// ─────────────────────────────────────────────────────────
// COMPTE TWITCH LIÉ (option, spectateur OU compte réel régie/client)
//
// Un compte anonyme peut se relier à un compte Twitch pour retrouver ses
// points sur n'importe quel appareil ; un compte réel (régie, ou futur
// client "Stratégie Live") peut faire de même sans jamais changer
// d'identité, Twitch n'étant alors qu'un ajout à son profil déjà stable
// (voir netlify/functions/twitch-auth.js pour le détail des deux cas).
// Dans les deux cas, apparaître au classement saison (réservé aux comptes
// Twitch — voir updateSeasonTwitchScores) devient possible. Le lien passe
// par netlify/functions/twitch-auth.js (Client Secret côté serveur
// uniquement) ; ce module ne fait que déclencher le flux et lire le
// résultat, jamais l'échange lui-même.
//
// Les documents twitchProfiles/{uid} et uidLinks/{uid} sont écrits QUE côté
// serveur (Admin SDK) — voir firestore.rules — donc rien ici ne les écrit.
// ─────────────────────────────────────────────────────────

const TWITCH_PROFILES_COL = 'twitchProfiles';
const UID_LINKS_COL       = 'uidLinks';
const SEASON_SCORES_COL   = 'pronoSeasonScores';

/** Profil Twitch lié à ce uid (ou null si ce compte n'est pas connecté via Twitch). Lecture publique. */
export async function getTwitchProfile(uid) {
  await initFirebase();
  const { doc, getDoc } = await fs();
  try { const s = await getDoc(doc(db, TWITCH_PROFILES_COL, uid)); return s.exists() ? s.data() : null; }
  catch { return null; }
}

/**
 * Démarre la connexion Twitch : pose un nonce anti-CSRF + le hash de retour
 * en sessionStorage, puis quitte la page vers Twitch. La suite se passe dans
 * la page pont de netlify/functions/twitch-auth.js (retour GET Twitch), qui
 * revient ensuite sur `returnHash` avec le résultat en sessionStorage
 * (voir consumeTwitchLinkResult).
 */
export async function beginTwitchLink(returnHash) {
  const r = await fetch('/.netlify/functions/twitch-config');
  const { clientId } = await r.json();
  if (!clientId) throw new Error('twitch_not_configured');
  const nonce = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  sessionStorage.setItem('rxTwitchNonce', nonce);
  sessionStorage.setItem('rxTwitchReturnHash', returnHash || '#spectator');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://rxchrono.netlify.app/.netlify/functions/twitch-auth',
    response_type: 'code',
    scope: '',
    state: nonce,
  });
  location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
}

/**
 * Lit (et efface) le résultat du dernier aller-retour Twitch, déposé en
 * sessionStorage par la page pont. 'ok' | 'error:<raison>' | null (aucun
 * retour Twitch récent — cas normal la plupart du temps).
 */
export function consumeTwitchLinkResult() {
  const v = sessionStorage.getItem('rxTwitchResult');
  if (v != null) sessionStorage.removeItem('rxTwitchResult');
  return v;
}

// ─────────────────────────────────────────────────────────
// CLASSEMENT SAISON — TWITCH UNIQUEMENT
//
// Un compte anonyme n'a pas d'identité stable d'un meeting à l'autre (il
// peut changer à tout moment de navigateur/appareil), donc il n'a pas sa
// place dans un classement qui doit tenir toute la saison. Seuls les uid
// présents dans twitchProfiles (donc reliés à un compte Twitch réel) sont
// retenus ici — par construction, jamais de nom généré dans ce classement.
//
// Calcul PAR LA RÉGIE (list sur uidLinks réservé régie), recalculé après
// chaque révélation aux côtés de updateMeetingScores. Idempotent : relit
// tout depuis pronoScores à chaque appel.
// ─────────────────────────────────────────────────────────

/**
 * Recalcule le classement saison (Twitch uniquement) d'un championnat depuis
 * pronoScores + uidLinks, et l'écrit dans pronoSeasonScores/{championshipId}.
 * À n'appeler QUE côté régie.
 * @returns {Promise<{scores:Object, breakdown:Object}>} scores : uidTwitch -> points cumulés saison ;
 *   breakdown : uidTwitch -> { meetingId: points } (détail par épreuve, jamais stocké — recalculé à la demande,
 *   pour vérifier d'où viennent les points d'un compte, ex. un meeting de test oublié).
 */
export async function updateSeasonTwitchScores(championshipId) {
  if (!championshipId) return { scores: {}, breakdown: {} };
  await initFirebase();
  const { collection, getDocs, query, where, doc, getDoc, setDoc } = await fs();

  // 1) uid anonyme -> uid Twitch canonique.
  const linksSnap = await getDocs(collection(db, UID_LINKS_COL));
  const canonicalOf = {};
  linksSnap.forEach(d => { canonicalOf[d.id] = d.data().canonicalUid; });

  // 2) uid Twitch valides (le classement saison n'en contient QUE ceux-là).
  const profilesSnap = await getDocs(collection(db, TWITCH_PROFILES_COL));
  const twitchUids = new Set(profilesSnap.docs.map(d => d.id));

  // 3) toutes les épreuves de ce championnat (via les pronostics qui le portent).
  const pronoSnap = await getDocs(query(collection(db, PRONO_COL), where('championshipId', '==', championshipId)));
  const candidateMeetingIds = new Set(pronoSnap.docs.map(d => d.data().meetingId).filter(Boolean));

  // 3b) le championshipId d'un pronostic n'est qu'une ÉTIQUETTE posée à sa
  // création : rien n'empêche qu'elle diverge du championnat RÉEL de son
  // propre meeting (rattachement erroné, meeting déplacé depuis). On ne
  // retient donc que les meetings dont le championnat déclaré CORRESPOND
  // vraiment — un meeting absent (supprimé) est écarté aussi, faute de
  // pouvoir vérifier. Un meeting sans championshipId (données anciennes)
  // reste accepté, même convention que côté site (js/spectator.js).
  const meetingIds = new Set();
  for (const meetingId of candidateMeetingIds) {
    const m = await getDoc(doc(db, 'meetings', meetingId));
    if (!m.exists()) continue;
    const mChamp = m.data().championshipId;
    if (!mChamp || mChamp === championshipId) meetingIds.add(meetingId);
  }

  // 4) cumul, uid résolu au compte Twitch canonique — additionné sur TOUTES les
  // épreuves du championnat, pas seulement celle qu'on regarde (d'où le détail
  // par épreuve ci-dessous : un total saison peut sembler élevé si des points
  // dorment sur d'autres meetings, y compris d'anciens tests oubliés).
  const scores = {};
  const breakdown = {};
  for (const meetingId of meetingIds) {
    const s = await getDoc(doc(db, SCORES_COL, meetingId));
    if (!s.exists()) continue;
    const meetingScores = s.data().scores || {};
    for (const [uid, pts] of Object.entries(meetingScores)) {
      const canonical = resolveCanonicalUid(canonicalOf, uid);
      if (!twitchUids.has(canonical)) continue;   // pas (encore) un compte Twitch → hors classement saison
      scores[canonical] = (scores[canonical] || 0) + pts;
      if (!breakdown[canonical]) breakdown[canonical] = {};
      breakdown[canonical][meetingId] = (breakdown[canonical][meetingId] || 0) + pts;
    }
  }

  await setDoc(doc(db, SEASON_SCORES_COL, championshipId), { championshipId, scores, updatedAt: Date.now() });
  return { scores, breakdown };
}

/** Abonnement au classement saison Twitch d'un championnat (lecture PUBLIQUE). cb reçoit la map uidTwitch->points. */
export async function watchSeasonScores(championshipId, cb, onErr) {
  await initFirebase();
  const { doc, onSnapshot } = await fs();
  return onSnapshot(doc(db, SEASON_SCORES_COL, championshipId),
    snap => cb(snap.exists() ? (snap.data().scores || {}) : {}),
    err => onErr && onErr(err));
}

// ─────────────────────────────────────────────────────────
// ARCHIVES DE SAISON (palmarès)
//
// pronoSeasonScores/{championshipId} est un instantané VIVANT, recalculé à
// chaque fois (voir updateSeasonTwitchScores) — rien n'y distingue "saison
// en cours" de "saison terminée". Clôturer une saison fige son classement
// final dans pronoSeasonArchives/{championshipId}, pour qu'un futur calcul
// (nouveaux liens de comptes, données corrigées) ne puisse plus réécrire
// discrètement l'Histoire une fois la saison officiellement close.
// ─────────────────────────────────────────────────────────

const SEASON_ARCHIVES_COL = 'pronoSeasonArchives';

/**
 * Fige le classement saison ACTUEL (recalculé au préalable pour être à jour)
 * dans pronoSeasonArchives/{championshipId}. À n'appeler QUE côté régie, une
 * fois la saison terminée. Idempotent : ré-archiver la même saison remplace
 * l'instantané précédent (utile pour corriger une erreur avant publication).
 * @param {string} championshipId
 * @param {string} label  intitulé affiché (ex. "FFSA Rallycross 2026")
 * @returns {Promise<Object>} le classement figé (uidTwitch -> points)
 */
export async function archiveSeasonTwitchScores(championshipId, label) {
  if (!championshipId) return {};
  const { scores } = await updateSeasonTwitchScores(championshipId);
  await initFirebase();
  const { doc, setDoc } = await fs();
  await setDoc(doc(db, SEASON_ARCHIVES_COL, championshipId), {
    championshipId, label: label || championshipId, scores, archivedAt: Date.now(),
  });
  return scores;
}

/** Liste toutes les saisons archivées (lecture PUBLIQUE), plus récentes d'abord. */
export async function listSeasonArchives() {
  await initFirebase();
  const { collection, getDocs, query, orderBy } = await fs();
  const snap = await getDocs(query(collection(db, SEASON_ARCHIVES_COL), orderBy('archivedAt', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
