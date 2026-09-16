/* ═══════════════════════════════════════════════
   ANALYSISLINK.JS — Passerelle entre l'écran d'analyse et l'outil vidéo

   L'outil d'analyse vit dans un document séparé : il lui faut les en-têtes
   d'isolation d'origine (COOP/COEP) que l'application ne peut pas poser, sous
   peine de casser l'iframe YouTube du lecteur.

   Séparer les DOCUMENTS n'oblige pourtant pas à passer par des FICHIERS.
   Exporter une grille, la retrouver dans son dossier, la recharger, refaire le
   chemin inverse pour quelques secondes de vidéo : c'est plus long que la
   mesure elle-même.

   Deux documents de même origine peuvent se parler. On n'utilise PAS le lien
   `opener` entre fenêtres : COOP `same-origin` le coupe précisément. Un
   `BroadcastChannel`, lui, traverse — et il transporte les objets clonables,
   donc le FICHIER vidéo lui-même. L'outil s'ouvre avec la grille ET la vidéo
   déjà chargées ; le classement revient tout seul.

   Module pur : aucune dépendance, aucun accès Firebase. Le DOM n'est touché
   que par `BroadcastChannel`, absent en test — d'où l'injection.
═══════════════════════════════════════════════ */

export const CANAL_ANALYSE = 'rx-analyse-video';

export const MSG_GRILLE = 'grille';
export const MSG_CLASSEMENT = 'classement';
export const MSG_PRET = 'pret';

/**
 * Message envoyé par l'application vers l'outil : tout ce qu'il faut pour
 * travailler, et rien de plus.
 *
 * Le fichier vidéo voyage par clonage structuré : aucun octet ne transite par
 * le réseau, et l'utilisateur n'a pas à le re-désigner.
 */
export function messageGrille({
  grid, file = null, sidecar = null, startAt = null, turn1At = null, startId = null,
} = {}) {
  return {
    type: MSG_GRILLE,
    envoi: Date.now(),
    startId: startId ?? grid?.startId ?? null,
    grid: grid ?? null,
    file,
    // Le sidecar porte la cadence relevée à l'extraction. La transmettre évite
    // que l'outil la devine : `requestVideoFrameCallback` mesure la cadence de
    // PRÉSENTATION, qui tombe à 30 dès que le navigateur saute une image sur
    // deux — ce qui arrive sur du 1080p60.
    sidecar,
    startAt: seconde(startAt),
    turn1At: seconde(turn1At),
  };
}

/**
 * Un timecode, ou rien.
 *
 * `Number(null)` vaut 0 et `Number('')` aussi : un champ vide passerait pour
 * un départ à l'instant 0. On écarte donc l'absence AVANT de convertir, et on
 * garde 0 quand il est réellement demandé.
 */
function seconde(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Message renvoyé par l'outil : le classement, au format déjà connu. */
export function messageClassement({ doc, startId = null } = {}) {
  return { type: MSG_CLASSEMENT, envoi: Date.now(), startId, doc: doc ?? null };
}

/**
 * Ce message nous concerne-t-il ?
 *
 * On vérifie le TYPE et, quand on l'attend, le départ : deux onglets ouverts
 * sur deux départs différents ne doivent pas se remplir l'un l'autre.
 */
export function messagePour(msg, type, startId = null) {
  if (!msg || msg.type !== type) return false;
  if (startId == null || msg.startId == null) return true;
  return String(msg.startId) === String(startId);
}

/**
 * Ouvre un canal, en tolérant l'absence de `BroadcastChannel`.
 *
 * @param {Function} [fabrique] — injectable pour les tests
 * @returns {{poster:Function, ecouter:Function, fermer:Function}|null}
 */
export function ouvrirCanal(fabrique = null) {
  const F = fabrique ?? (typeof BroadcastChannel !== 'undefined' ? (n) => new BroadcastChannel(n) : null);
  if (!F) return null;
  const canal = F(CANAL_ANALYSE);
  const abonnes = new Set();
  canal.onmessage = (ev) => { for (const f of abonnes) f(ev?.data); };
  return {
    poster: (msg) => canal.postMessage(msg),
    ecouter: (f) => { abonnes.add(f); return () => abonnes.delete(f); },
    fermer: () => { abonnes.clear(); try { canal.close(); } catch { /* déjà fermé */ } },
  };
}
