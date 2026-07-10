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
  nextText:      '',            // "à suivre" affiché sur l'écran d'attente
  countdownEnd:  0,             // timestamp ms de fin du compte à rebours (0 = aucun)
  graphMode:     'places',      // graphique d'évolution (manche terminée) : 'places' | 'points'
  // bandeau prédiction (scénario d'objectif d'un pilote, bas d'écran) :
  predict:       { enabled: false, driverId: '', objective: 'p1', cutoff: 6 },
  // objective : 'p1' | 'qualif' (manche) · 'champ_p1' | 'champ_top3' | 'champ_gap' (championnat)
  // source vidéo (caméra locale OU lien) composée DANS la page + placement piloté :
  videoLayout:   'none',        // 'none' | 'hg' | 'hd' | 'bg' | 'bd' (coins) | 'full' (plein écran)
  videoSource:   { type: 'camera', value: '' },  // 'camera' (deviceId, choisi côté overlay) | 'url' (YouTube / VDO.Ninja / iframe)
  videoVolume:   0,             // volume du son d'un lien (0-100 ; 0 = muet). Caméra : audio géré dans OBS.
  // scène fiche pilote / duel (1 pilote → fiche ; 2 → duel, même catégorie) :
  fiche:         { driverId1: '', driverId2: '' },
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
