/* ═══════════════════════════════════════════════
   TURN1ANALYSISCALC.JS — Le raisonnement du classement au premier virage

   Deux instants, deux gestes. L'opérateur désigne les voitures dans l'ordre de
   passage au virage — c'est ce que l'œil fait bien. La machine dit LAQUELLE est
   laquelle, en ensemble fermé sur la grille annoncée — c'est ce qu'elle fait
   mieux que lui. Quand elle doute, elle le dit.

   Module pur : ni DOM, ni Firebase, ni ONNX. Tout ce qui décide est ici, donc
   testable sans navigateur ; l'affichage et la détection sont ailleurs.
═══════════════════════════════════════════════ */

import { distance } from './vision/apparence.js';
import { hungarian } from './vision/hongrois.js';

/** Écart relatif minimal entre le meilleur candidat et le second. */
export const MARGE_MIN = 0.06;

/** Coût d'une paire impossible : au-dessus de toute distance réelle. */
const INTERDIT = 9;

const aire = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * Retire les boîtes largement contenues dans une plus grande.
 *
 * Ce n'est pas une voiture de plus, c'est un morceau de celle du dessous. Sur
 * la grille de Kerlabo le détecteur pose un liseré de 131 × 52 px sur le
 * pavillon d'une voiture — mesuré. Compté comme une voiture, il décale toute
 * la numérotation de la grille.
 */
export function retirerEmboitees(dets = [], seuil = 0.5) {
  const contenue = (p, g) => {
    const i = Math.max(0, Math.min(p[2], g[2]) - Math.max(p[0], g[0]))
      * Math.max(0, Math.min(p[3], g[3]) - Math.max(p[1], g[1]));
    return aire(p) > 0 && i / aire(p) > seuil;
  };
  return dets.filter(d => !dets.some(u => u !== d
    && aire(u.box) > aire(d.box) && contenue(d.box, u.box)));
}

/** Range les boîtes de gauche à droite, comme on lit une grille. */
export function deGaucheADroite(dets = []) {
  return [...dets].sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2]));
}

/**
 * Qui est qui ? Affectation hongroise entre les voitures pointées au virage et
 * celles de la grille, sur la seule apparence.
 *
 * Pourquoi pas « la plus ressemblante » pour chacune : deux voitures peuvent se
 * disputer la même déco. Un choix glouton donnerait à la première venue son
 * meilleur candidat, quitte à priver une autre de celui dont elle avait un
 * besoin bien plus net. Le hongrois minimise le coût TOTAL.
 *
 * Une paire dont le second candidat est presque aussi bon n'est PAS posée :
 * elle ressort « non décidée ». Une case vide coûte moins cher qu'une case
 * fausse — c'est la règle de toute l'application.
 *
 * @param {object} p
 * @param {Array} p.signaturesDepart — une par voiture de la grille, dans son ordre
 * @param {Array} p.signaturesV1 — une par voiture pointée, dans l'ordre de passage
 * @param {Array} p.numeros — numéros de course, dans l'ordre de la grille
 * @returns {Array<{position:number, carNumber:*, confiance:number,
 *                  distance:number|null, ecart:number, raison:string|null}>}
 */
export function apparierVoitures({
  signaturesDepart = [], signaturesV1 = [], numeros = [], margeMin = MARGE_MIN,
} = {}) {
  if (!signaturesV1.length || !signaturesDepart.length) return [];

  const cout = signaturesV1.map(sv => signaturesDepart.map(
    sd => (sv && sd ? (distance(sv, sd) ?? INTERDIT) : INTERDIT)));
  const aff = hungarian(cout);

  return signaturesV1.map((_, rang) => {
    const j = aff[rang];
    const ligne = cout[rang];
    const tries = [...ligne].sort((a, b) => a - b);
    const meilleur = tries[0], second = tries[1];
    // Sans second candidat, il n'y a rien à confondre : l'écart est total.
    const ecart = second === undefined ? 1
      : (meilleur > 0 ? (second - meilleur) / meilleur : (second > 0 ? 1 : 0));
    // L'ordre du diagnostic compte : quand AUCUN candidat n'est exploitable,
    // tous les coûts valent INTERDIT, donc l'écart vaut zéro — et la réponse
    // « deux candidats trop proches » enverrait chercher le mauvais problème.
    const exploitable = j >= 0 && j < signaturesDepart.length && ligne[j] < INTERDIT;
    const decidable = exploitable && ecart >= margeMin;
    return {
      position: rang + 1,
      carNumber: decidable ? (numeros[j] ?? null) : null,
      confiance: decidable ? Math.max(0, Math.min(1, ecart)) : 0,
      distance: exploitable ? ligne[j] : null,
      ecart,
      raison: decidable ? null
        : (exploitable ? 'deux candidats trop proches' : 'aucun candidat exploitable'),
    };
  });
}

/**
 * Le classement, au format que « Analyse des départs » sait déjà relire.
 *
 * On reprend `rx-v1-order/1` plutôt que d'inventer : la couche qui applique une
 * proposition, la contrôle et la rapporte existe déjà et est éprouvée.
 */
export function buildV1Proposal({
  appariement = [], numeros = [], noms = new Map(),
  startAt = null, turn1At = null, startId = null, extrait = null,
} = {}) {
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    schema: 'rx-v1-order/1',
    startId,
    extrait,
    startAt: num(startAt),
    turn1At: num(turn1At),
    methode: 'hsv-zonee/1 + hongrois, ensemble fermé sur la grille annoncée',
    grille: numeros,
    positions: appariement.map(r => ({
      carNumber: r.carNumber,
      turn1Pos: r.carNumber != null ? r.position : null,
      pilote: r.carNumber != null ? (noms.get(Number(r.carNumber)) ?? null) : null,
      confiance: Number((r.confiance ?? 0).toFixed(3)),
      raison: r.raison,
    })).filter(p => p.carNumber != null || p.raison),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Les numéros de la grille dans l'ordre où la caméra les voit.
 *
 * Le couloir 1 est toujours du côté du premier virage. Vu de la caméra, l'ordre
 * gauche → droite est donc l'un des deux sens : on propose, l'opérateur inverse
 * si la caméra filme de l'autre côté.
 */
export function grilleVueCamera(drivers = [], poleSide = null, inverse = false) {
  const parCouloir = [...drivers].sort((a, b) => (a.lane ?? 99) - (b.lane ?? 99));
  const droite = String(poleSide || '').toLowerCase().startsWith('r')
    || String(poleSide || '').toLowerCase().startsWith('d');
  const ordre = droite ? parCouloir.reverse() : parCouloir;
  return inverse ? ordre.reverse() : ordre;
}
