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
  const scores = {};
  for (const pdoc of psnap.docs) {
    const p = pdoc.data();
    if (p.status !== PRONO_STATUS.REVEALED || !p.correctDriverId) continue;   // seuls les révélés comptent
    const pos = (strengthByCat[p.category] || {})[p.correctDriverId];         // cote du gagnant
    const pts = cotePoints(pos);
    if (!pts) continue;
    const vsnap = await getDocs(collection(db, PRONO_COL, pdoc.id, 'votes'));
    vsnap.forEach(v => { if (v.data().driverId === p.correctDriverId) scores[v.id] = (scores[v.id] || 0) + pts; });
  }
  await setDoc(doc(db, SCORES_COL, meetingId), { meetingId, scores, updatedAt: Date.now() });
  return scores;
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
