/* ═══════════════════════════════════════════════
   OBS-CONTROL.JS — Pont régie ↔ overlays
   La page /control écrit le doc `obsControl/live`.
   Les overlays s'y abonnent (temps réel) et réagissent.
   Aucun serveur : Firestore fait office de canal live.
═══════════════════════════════════════════════ */

import { watchDoc, setDocMerged } from './obs-firebase.js';

export const CTRL_COL = 'obsControl';
export const CTRL_ID  = 'live';

/** État par défaut (si le doc n'existe pas encore). */
export const DEFAULT_CONTROL = {
  scene:         'dashboard',   // 'dashboard' | 'grid' | 'next-heat' | 'intermission'
  visible:       true,          // afficher / masquer l'overlay
  championshipId:'',
  meetingId:     '',
  category:      '',            // ex. 'Supercar'
  sessionType:   'MQ',          // 'EC' | 'MQ' | 'DF' | 'FIN'
  sessionNum:    1,             // num de manche (MQ 1..4) ou demi (DF 1..2)
  standingsMode: 'interim',     // 'interim' | 'meeting' | 'championship'
  headerText:    '',            // texte d'en-tête éditable (infos circuit…)
  // calque d'AFFICHAGE seulement — n'écrit jamais dans results/sessionParticipants :
  gridOverride:  null,          // { key, slots:[{pos, carNumber, lastName}] }
  updatedAt:     0,
};

/**
 * Abonnement temps réel à l'état de contrôle.
 * Fusionne toujours avec les valeurs par défaut.
 * @param {(state:object)=>void} cb
 * @returns {Promise<()=>void>} fonction d'arrêt
 */
export function watchControl(cb, onErr) {
  return watchDoc(CTRL_COL, CTRL_ID, doc => {
    cb({ ...DEFAULT_CONTROL, ...(doc || {}) });
  }, onErr);
}

/**
 * Met à jour (merge) l'état de contrôle. Nécessite d'être authentifié
 * (cf. règles de sécurité Firestore).
 * @param {object} patch
 */
export function setControl(patch) {
  return setDocMerged(CTRL_COL, CTRL_ID, { ...patch, updatedAt: Date.now() });
}

/**
 * Clé identifiant la session ciblée — sert à n'appliquer un gridOverride
 * que s'il correspond à la sélection courante.
 */
export function sessionKey(s) {
  return [s.meetingId, s.category, s.sessionType, s.sessionNum].join('|');
}
