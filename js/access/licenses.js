/* ═══════════════════════════════════════════════
   LICENSES.JS — Accès Firestore de la brique commerciale.

   Seul module du dossier à toucher Firestore, comme
   js/projection/qualificationData.js l'est pour la projection. Le calcul
   vit dans licenseCalc.js, le rendu dans accessAdmin.js.

   Deux usages, volontairement séparés :
     • CÔTÉ TEAM   — `subscribeMyAccess()` : mes teams, mes licences, en
                     temps réel. Une révocation prend effet sans rechargement.
     • CÔTÉ RÉGIE  — fonctions d'administration, appelées par l'écran admin.

   Rappel : ce module ne décide rien. Les règles Firestore refusent déjà
   toute écriture qui ne vient pas de la régie ; ce qui suit ne fait que
   présenter des erreurs lisibles au lieu d'un « permission denied » brut.
═══════════════════════════════════════════════ */

import { db } from '../firebase.js';
import { getUser, isAdmin } from '../auth.js';

const FS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────
// ÉTAT PARTAGÉ
// ─────────────────────────────────────────────────────────

/**
 * `ready` distingue « pas encore chargé » de « chargé, aucun droit ».
 * Sans cette distinction, l'interface afficherait « accès refusé » pendant
 * le chargement, c'est-à-dire un message faux à chaque ouverture de page.
 */
const state = {
  ready: false,
  uid: null,
  teamIds: [],
  licenses: [],
  error: null,
};

let _unsubMembers = null;
let _unsubLicenses = null;

export function getAccessState() {
  return { ...state, teamIds: [...state.teamIds], licenses: [...state.licenses] };
}

function emit() {
  document.dispatchEvent(new CustomEvent('accesschange', { detail: getAccessState() }));
}

function resetState(uid = null) {
  state.ready = false;
  state.uid = uid;
  state.teamIds = [];
  state.licenses = [];
  state.error = null;
}

function stopAll() {
  if (_unsubMembers) { _unsubMembers(); _unsubMembers = null; }
  if (_unsubLicenses) { _unsubLicenses(); _unsubLicenses = null; }
}

// ─────────────────────────────────────────────────────────
// CÔTÉ TEAM — mes droits, en temps réel
// ─────────────────────────────────────────────────────────

/**
 * S'abonne aux teams puis aux licences de l'utilisateur courant.
 *
 * En deux temps parce que Firestore ne sait pas joindre : on lit d'abord
 * les appartenances, puis les licences des teams obtenus. Le second
 * abonnement est recréé si la liste des teams change.
 */
export async function subscribeMyAccess(user) {
  stopAll();

  // Un visiteur non connecté, ou une session anonyme de pronostics, n'a
  // aucun droit — et surtout, aucune requête à lancer. Interroger
  // `teamMembers` avec une session anonyme échouerait par les règles, ce
  // qui remplirait la console d'erreurs sans rien apporter.
  if (!db || !user || user.isAnonymous) {
    resetState(user?.uid || null);
    state.ready = true;
    emit();
    return;
  }

  resetState(user.uid);
  emit();

  const { collection, query, where, onSnapshot } = await import(FS);

  _unsubMembers = onSnapshot(
    query(collection(db, 'teamMembers'), where('uid', '==', user.uid)),
    (snap) => {
      const ids = snap.docs.map(d => d.data().teamId).filter(Boolean);
      state.teamIds = [...new Set(ids)];
      subscribeLicenses(user.uid);
    },
    (err) => {
      // Un e-mail non vérifié tombe ici : les règles refusent la lecture.
      // Ce n'est pas une panne, c'est le comportement attendu.
      state.error = err?.code === 'permission-denied' ? 'denied' : 'error';
      state.teamIds = [];
      state.licenses = [];
      state.ready = true;
      emit();
    },
  );
}

async function subscribeLicenses(uid) {
  if (_unsubLicenses) { _unsubLicenses(); _unsubLicenses = null; }

  // `where(... 'in', [])` lève une erreur : sans team, il n'y a rien à lire.
  if (!state.teamIds.length) {
    state.licenses = [];
    state.ready = true;
    emit();
    return;
  }

  const { collection, query, where, onSnapshot } = await import(FS);
  // `in` est plafonné à 30 valeurs. Un compte appartenant à plus de
  // 30 teams n'existe pas à cette échelle ; on tronque explicitement
  // plutôt que de laisser la requête échouer.
  const ids = state.teamIds.slice(0, 30);

  _unsubLicenses = onSnapshot(
    query(collection(db, 'licenses'), where('teamId', 'in', ids)),
    (snap) => {
      if (state.uid !== uid) return;          // déconnexion entre-temps
      state.licenses = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      state.ready = true;
      state.error = null;
      emit();
    },
    (err) => {
      state.error = err?.code === 'permission-denied' ? 'denied' : 'error';
      state.licenses = [];
      state.ready = true;
      emit();
    },
  );
}

/** Coupe tous les abonnements — à la déconnexion. */
export function unsubscribeMyAccess() {
  stopAll();
  resetState();
  state.ready = true;
  emit();
}

// ─────────────────────────────────────────────────────────
// CARTE INSCRIPTION → FICHE PILOTE
// ─────────────────────────────────────────────────────────

let _personByDriver = null;

/**
 * `driverId` → `personId`, pour toute la base.
 *
 * La collection `drivers` est publique et compte quelques centaines de
 * documents : une seule lecture, mise en cache pour la session. C'est la
 * traduction dont Stratégie Live a besoin, puisqu'elle raisonne en
 * inscriptions alors que le commerce raisonne en personnes.
 */
export async function loadPersonByDriver({ force = false } = {}) {
  if (_personByDriver && !force) return _personByDriver;
  if (!db) return new Map();
  const { collection, getDocs } = await import(FS);
  const snap = await getDocs(collection(db, 'drivers'));
  const map = new Map();
  snap.docs.forEach(d => {
    const pid = d.data().personId;
    if (pid) map.set(d.id, pid);
  });
  _personByDriver = map;
  return map;
}

export function clearPersonCache() { _personByDriver = null; }

// ─────────────────────────────────────────────────────────
// CÔTÉ RÉGIE — administration
// ─────────────────────────────────────────────────────────

/**
 * Garde-fou local. Il ne PROTÈGE rien — les règles Firestore le font —
 * mais il évite d'envoyer une écriture vouée à l'échec et de présenter à
 * l'utilisateur un « permission denied » incompréhensible.
 */
function assertAdmin() {
  if (!isAdmin()) throw new Error("Réservé à l'administrateur.");
  if (!db) throw new Error('Firebase non connecté.');
}

async function fs() { return import(FS); }

/*  Convention de lecture dans ce module : `{ ...d.data(), id: d.id }`, et non
    l'inverse. Si un document portait un champ `id` — cas rencontré avec un
    jeu de données de test —, l'écriture habituelle `{ id: d.id, ...d.data() }`
    le laisserait ECRASER l'identifiant réel du document, et toutes les
    correspondances suivantes échoueraient silencieusement. Aucun document de
    production n'est dans ce cas aujourd'hui ; l'ordre choisi fait que cela
    n'aura jamais d'importance.  */

export async function listTeams() {
  assertAdmin();
  const { collection, getDocs, query, orderBy } = await fs();
  const snap = await getDocs(query(collection(db, 'teams'), orderBy('name')));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function listAllUsers() {
  assertAdmin();
  const { collection, getDocs } = await fs();
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function listMembers(teamId) {
  assertAdmin();
  const { collection, getDocs, query, where } = await fs();
  const snap = await getDocs(query(collection(db, 'teamMembers'), where('teamId', '==', teamId)));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function listLicensesOfTeam(teamId) {
  assertAdmin();
  const { collection, getDocs, query, where } = await fs();
  const snap = await getDocs(query(collection(db, 'licenses'), where('teamId', '==', teamId)));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function createTeam({ name, contactEmail = '', note = '' }) {
  assertAdmin();
  const { collection, addDoc, serverTimestamp } = await fs();
  const ref = await addDoc(collection(db, 'teams'), {
    name: (name || '').trim(),
    contactEmail: (contactEmail || '').trim(),
    note: (note || '').trim(),
    createdAt: serverTimestamp(),
    createdBy: getUser()?.uid || '',
  });
  return ref.id;
}

/**
 * Rattache un compte EXISTANT à un team.
 *
 * Identifiant déterministe `${teamId}_${uid}`, imposé aussi par les règles :
 * deux ajouts concurrents visent le même document au lieu d'en créer deux.
 * Même convention que sessionParticipants et results.
 */
export async function addMember({ teamId, uid, role = 'member' }) {
  assertAdmin();
  const { doc, setDoc, serverTimestamp } = await fs();
  await setDoc(doc(db, 'teamMembers', `${teamId}_${uid}`), {
    teamId, uid, role,
    addedAt: serverTimestamp(),
    addedBy: getUser()?.uid || '',
  });
}

export async function removeMember({ teamId, uid }) {
  assertAdmin();
  const { doc, deleteDoc } = await fs();
  await deleteDoc(doc(db, 'teamMembers', `${teamId}_${uid}`));
}

/**
 * Attribue une licence.
 *
 * `championshipId` est TOUJOURS renseigné, y compris pour un pass meeting :
 * c'est lui qui sépare « Lohéac FFSA » de « Lohéac Euro RX », deux meetings
 * distincts à la même date. Les règles l'exigent, et le périmètre devient
 * immuable dès la création.
 */
export async function grantLicense({
  teamId, personId, scope, championshipId, year, meetingId = null,
  origin = 'admin_grant', validFrom = null, validUntil = null, note = '',
  personLabel = '', championshipLabel = '', meetingLabel = '',
}) {
  assertAdmin();
  const { collection, addDoc, serverTimestamp } = await fs();
  const ref = await addDoc(collection(db, 'licenses'), {
    // Libellés DÉNORMALISÉS, comme partout dans ce projet (engagements et
    // sessionParticipants portent déjà nom et numéro). Le bandeau affiché au
    // team doit dire « Fabien Pailler — Saison Championnat FFSA », pas
    // « person_pailler — Saison champ_ffsa_2026 ». Sans cette copie, il
    // faudrait lire `persons` et `championships` — deux collections que
    // Stratégie Live n'a aucune raison de charger pour afficher un bandeau.
    personLabel, championshipLabel, meetingLabel,
    teamId, personId, scope, championshipId,
    year: Number(year),
    meetingId: scope === 'meeting' ? meetingId : null,
    status: 'active',
    origin,
    validFrom: validFrom ? new Date(validFrom) : null,
    validUntil: validUntil ? new Date(validUntil) : null,
    note: (note || '').trim(),
    createdAt: serverTimestamp(),
    createdBy: getUser()?.uid || '',
  });
  return ref.id;
}

/**
 * Suspend, réactive ou révoque.
 *
 * Le PÉRIMÈTRE n'est jamais modifiable — ni ici, ni par les règles.
 * Réorienter une licence vers une autre personne ou un autre championnat
 * reviendrait à revendre le même droit sans laisser de trace. Pour changer
 * de périmètre : révoquer, puis attribuer une nouvelle licence.
 */
export async function setLicenseStatus({ licenseId, status, reason = '' }) {
  assertAdmin();
  const { doc, updateDoc, serverTimestamp } = await fs();
  const patch = { status };
  if (status === 'revoked') {
    patch.revokedAt = serverTimestamp();
    patch.revokedBy = getUser()?.uid || '';
    patch.revokeReason = reason;
  }
  await updateDoc(doc(db, 'licenses', licenseId), patch);
}

export async function deleteLicense(licenseId) {
  assertAdmin();
  const { doc, deleteDoc } = await fs();
  await deleteDoc(doc(db, 'licenses', licenseId));
}
