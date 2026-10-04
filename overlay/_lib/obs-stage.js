/* ═══════════════════════════════════════════════
   OBS-STAGE.JS — Logique PURE du mode « préparation » de la régie.
   Deux documents Firestore : `obsControl/live` (ANTENNE) et `obsControl/preview` (PRÉPARATION).
   En mode préparation, les réglages s'écrivent dans « preview » ; « ▶ Mettre à l'antenne »
   copie la préparation vers « live ». Aucune dépendance Firebase / DOM → testable.
═══════════════════════════════════════════════ */

export const LIVE_ID    = 'live';
export const PREVIEW_ID = 'preview';

/**
 * Réglages qui s'appliquent TOUJOURS en direct (jamais préparés) :
 *  • visible : couper / rétablir tout l'overlay à l'antenne ;
 *  • categoryThemes : réglage de configuration (couleur par catégorie) — la catégorie, elle, reste préparée ;
 *  • countdownEnd / countdownStart : instants ABSOLUS — un chrono « préparé » serait faux au moment de la prise d'antenne.
 * Ils sont aussi écrits dans la préparation pour que le moniteur de préparation les montre.
 */
export const LIVE_KEYS = ['visible', 'countdownEnd', 'countdownStart', 'categoryThemes'];

/** Champs jamais copiés (métadonnées). */
const META_KEYS = ['id', 'updatedAt'];

/** Découpe un changement de réglages selon le mode.
 *  @returns {{ stage: object|null, live: object|null }} ce qu'il faut écrire dans chaque document */
export function splitPatch(patch, prep) {
  if (!prep) return { stage: null, live: { ...patch } };
  const live = {};
  Object.keys(patch).forEach(k => { if (LIVE_KEYS.includes(k)) live[k] = patch[k]; });
  return { stage: { ...patch }, live: Object.keys(live).length ? live : null };
}

/** Ce que « Mettre à l'antenne » écrit dans le document live : toute la préparation,
 *  sauf les réglages toujours directs et les métadonnées. */
export function stageToLivePatch(stage) {
  const out = {};
  Object.keys(stage || {}).forEach(k => {
    if (LIVE_KEYS.includes(k) || META_KEYS.includes(k)) return;
    out[k] = stage[k];
  });
  return out;
}

/** Copie de l'antenne servant de point de départ à la préparation. */
export function liveToStagePatch(live) {
  const out = {};
  Object.keys(live || {}).forEach(k => { if (!META_KEYS.includes(k)) out[k] = live[k]; });
  return out;
}

/** Noms des réglages qui diffèrent entre préparation et antenne (hors réglages directs). */
export function stageDiff(stage, live) {
  const s = stageToLivePatch(stage), l = stageToLivePatch(live);
  // le championnat est renseigné par la régie elle-même (un doc vide d'un côté n'est pas un changement voulu)
  if (!s.championshipId || !l.championshipId) { s.championshipId = l.championshipId = s.championshipId || l.championshipId || ''; }
  const keys = [...new Set([...Object.keys(s), ...Object.keys(l)])];
  return keys.filter(k => JSON.stringify(s[k] ?? null) !== JSON.stringify(l[k] ?? null)).sort();
}

/** La préparation d'une autre époque est-elle périmée (document ancien) ? → on repart de l'antenne. */
export const STAGE_MAX_AGE_MS = 12 * 3600 * 1000;
export function stageIsStale(stageDoc, exists, now = Date.now()) {
  if (!exists) return true;
  const t = Number(stageDoc && stageDoc.updatedAt) || 0;
  return !t || now - t > STAGE_MAX_AGE_MS;
}

/** Libellés lisibles des réglages pour l'indicateur « ce qui change ». */
export const DIFF_LABEL = {
  scene: 'scène', championshipId: 'championnat', meetingId: 'meeting', category: 'catégorie',
  sessionType: 'phase', sessionNum: 'n° de phase', standingsMode: 'classement', headerText: 'en-tête',
  nextText: 'texte « à suivre »', graphMode: 'graphique', predict: 'prédiction', videoLayout: 'placement vidéo',
  videoSource: 'source vidéo', videoVolume: 'volume', fiche: 'fiche / duel', pronosticId: 'pronostic',
  spectatorBaseUrl: 'lien spectateur', infoBand: 'bandeau info', gridOverride: 'grille', bgTheme: 'fond par défaut', studio: 'plateau',
};
export const diffLabels = keys => keys.map(k => DIFF_LABEL[k] || k);
