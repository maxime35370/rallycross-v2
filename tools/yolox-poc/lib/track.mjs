/* ═══════════════════════════════════════════════
   TRACK.MJS — Suivi temporel des voitures, logique pure

   Transforme une suite de détections indépendantes en PISTES persistantes.
   Aucun accès au DOM, au réseau ni au modèle : entièrement testable hors
   navigateur (`tests/trackerCore.test.js`).

   ── Méthode ────────────────────────────────────────────────────────────
   Logique BoT-SORT réimplémentée en JS, comme le recommande
   AUTOMATION-ARCHITECTURE.md §5, c'est-à-dire ByteTrack augmenté d'une
   compensation du mouvement de caméra :

     1. prédiction  — filtre alpha-bêta à vitesse constante ;
     2. compensation caméra — décalage global estimé sur les pistes elles-mêmes ;
     3. association en DEUX TEMPS (le cœur de ByteTrack) :
          · les détections FORTES d'abord, qui peuvent créer des pistes ;
          · puis les détections FAIBLES contre les pistes restées orphelines,
            qui ne créent JAMAIS de piste mais peuvent en sauver une ;
     4. affectation optimale par l'algorithme hongrois, pas au plus proche ;
     5. gestion explicite des occlusions et des boîtes fusionnées.

   ── Ce que la bande basse change, et ne change pas ─────────────────────
   Le seuil de détection reste 0,30 : c'est lui qui décide de ce qui compte
   comme une détection, et les chiffres du banc restent comparables. La bande
   0,10–0,30 sert UNIQUEMENT à raccrocher une piste existante — jamais à en
   ouvrir une. C'est exactement la trouvaille de ByteTrack, et c'est ce qui
   permet de traverser une occlusion sans inventer de voiture.

   ── Ce qui n'est pas fait ici ──────────────────────────────────────────
   Aucune reconnaissance d'apparence (ReID). Après une occlusion longue entre
   deux voitures de taille voisine, la ré-association est incertaine : le code
   la MARQUE incertaine au lieu de trancher en silence.
═══════════════════════════════════════════════ */

import { iou } from './detect.mjs';
import { ajusterCamera, appliquerCamera, comparerModeles, MODELES_CAMERA } from './camera.mjs';

/** États d'une piste, du plus sûr au moins sûr. */
export const ETATS = {
  TENTATIVE: 'tentative',   // vue une fois, pas encore confirmée
  DETECTED: 'detected',     // associée à une détection à cet instant
  PREDICTED: 'predicted',   // non détectée, position extrapolée
  OCCLUDED: 'occluded',     // masquée par une autre piste identifiée
  LOST: 'lost',             // abandonnée
};

export const DEFAULTS = {
  dt: 0.25,                     // pas d'échantillonnage, en secondes
  highScore: 0.30,              // seuil de détection — identique au banc
  lowScore: 0.10,               // plancher de la bande basse (sauvetage seulement)
  iouMatch: 0.20,               // porte d'association, premier temps
  iouMatchLow: 0.15,            // porte d'association, second temps
  iouRecover: 0.10,             // porte élargie pour reprendre une piste occluse
  maxSizeRatio: 2.0,            // rapport de taille au-delà duquel on refuse

  // ── Durées, en SECONDES ──────────────────────────────────────────────
  // Elles étaient exprimées en PAS. Une tolérance de 3 pas vaut 0,75 s à 4 Hz
  // mais seulement 0,30 s à 10 Hz : augmenter la fréquence resserrait donc
  // silencieusement toutes les tolérances, ce qui explique l'essentiel de la
  // fragmentation observée à 10 Hz (219 pertes contre 66 à 4 Hz).
  dureeAvantAbandon: 0.80,      // sans détection, avant abandon
  dureeOcclusionMax: 2.00,      // idem, pour une occlusion identifiée
  dureeReactivation: 1.50,      // fenêtre de repêchage d'une piste abandonnée
  porteeReactivation: 1.5,      // distance de repêchage, en largeurs de boîte
  dureeConfirmation: 0.40,      // âge minimal d'une piste avant qu'elle compte
  detectionsConfirmation: 3,    // et nombre de détections exigées

  // ── Constantes de temps du filtre ────────────────────────────────────
  // Elles remplacent des gains fixes. Avec un gain fixe, `v += beta·r/dt`
  // amplifie le bruit de position quand `dt` diminue : à 10 Hz l'estimation de
  // vitesse était 2,5 fois plus bruitée qu'à 4 Hz, pour la même vidéo.
  tauPosition: 0.15,
  tauVitesse: 0.40,
  tauAmortissement: 0.50,

  // ── Bornes de la vitesse de TAILLE ───────────────────────────────────
  // `vw` et `vh` n'étaient bornées par rien. Comme `v += kv·r/dt`, un résidu
  // de 200 px — ce que produit exactement un changement de plan — injectait
  // des milliers de pixels par seconde dans la vitesse de taille, et la boîte
  // prédite du pas suivant devenait absurde : rapport de taille jusqu'à 497
  // au moment du refus, largeur variant d'un facteur 271 sur la vie d'une
  // piste. Une piste ainsi divergée ne peut plus s'apparier (porte à 2,0) ni
  // être repêchée (`_reactiver` exige le même rapport) — d'où les zéro
  // réactivations à 10 Hz.
  //
  // Les deux constantes sont MESURÉES sur la séquence Kerlabo, pas devinées,
  // et les deux fréquences donnent la même valeur — ce qui est attendu d'une
  // grandeur physique :
  //
  //   · taux vrai de changement de taille, mesuré sur une base d'UNE seconde
  //     (assez longue pour moyenner le bruit de boîte) : p99 = 0,92 s⁻¹ à
  //     4 Hz et 0,94 s⁻¹ à 10 Hz. Le plafond à 1,0 ne refuse donc rien de ce
  //     qui arrive réellement ;
  //   · rapport de taille entre deux mesures consécutives : p99 = 1,50 à 4 Hz
  //     et 1,54 à 10 Hz, avec 1,2 % au-dessus de 1,5 aux DEUX fréquences.
  //
  // Pourquoi ces bornes suffisent à empêcher la dérive : le plafond est
  // relatif à la taille COURANTE et se réapplique à chaque pas. Une boîte qui
  // rétrécit voit son plafond rétrécir avec elle — la décroissance devient
  // géométrique et converge, au lieu de filer linéairement vers zéro puis de
  // repartir.
  vitesseTailleMax: 1.0,        // |vw| ≤ 1,0 × largeur par seconde
  ratioTailleMax: 1.5,          // au-delà, le résidu ne devient pas une vitesse

  // ── Mémoire d'apparence ──────────────────────────────────────────────
  // Le suivi ne calcule AUCUNE signature : il ne voit jamais d'image. Le banc
  // en injecte une dans la détection, et la piste la range si l'observation
  // est propre. Rien ne lit cette mémoire — elle ne change aucun comportement.
  //
  // Pourquoi plusieurs observations plutôt qu'une : mesuré sur la coupure
  // Kerlabo, le seul crop de la dernière image donne 2 bonnes réponses sur 4,
  // et la voiture dont la réponse est la PIRE de sa ligne est justement celle
  // dont la détection est la plus faible (score 0,499, boîte 143×89). Une
  // identité ne doit pas dépendre d'une observation malchanceuse.
  memoireApparence: 8,          // 0 désactive
  largeurImage: null,           // pour écarter les boîtes tronquées par le bord
  hauteurImage: null,
  margeBord: 2,                 // px : au-delà, la boîte touche le cadre

  // ── Doublons ─────────────────────────────────────────────────────────
  // Une détection libre qui recouvre franchement une piste DÉJÀ associée à cet
  // instant n'est pas une nouvelle voiture : c'est la même, vue deux fois.
  iouDoublon: 0.50,
  recouvrementDoublon: 0.65,    // ou contenue à ce point dans une piste suivie

  mergeAreaRatio: 1.25,         // boîte « anormalement grande » = fusion probable
  ambiguityMargin: 0.08,        // écart de coût en dessous duquel un choix est douteux
  cameraCompensation: true,
  // Forme du modèle de mouvement caméra : 'aucune', 'globale', 'affineY',
  // 'locale', 'homographie', ou 'auto' (le plus simple qui gagne nettement).
  modeleCamera: 'globale',
  gainBiais: 0.5,
  gainFusion: 0.5,
};

/**
 * Pourquoi une association n'a pas eu lieu.
 *
 * Sans cette ventilation, corriger le suivi revient à tourner des seuils au
 * hasard : on voit qu'il se fragmente, jamais POURQUOI.
 */
export const REFUS = {
  AUCUNE_PISTE: 'aucune_piste',           // rien à quoi se raccrocher
  IOU_INSUFFISANT: 'iou_insuffisant',     // recouvrement sous la porte
  RATIO_TAILLE: 'ratio_taille',           // gabarits incompatibles
  DISTANCE: 'distance',                   // aucune piste dans le voisinage
  DEJA_ATTRIBUEE: 'piste_deja_attribuee', // la meilleure piste sert déjà
  COUT_HONGROIS: 'cout_hongrois',         // recevable, mais l'affectation a choisi autrement
  AUCUNE_DETECTION: 'aucune_detection',   // côté piste : rien à cet instant
};

/** Raisons de création et de suppression, tracées pour le diagnostic. */
export const RAISONS = {
  NOUVELLE: 'nouvelle',
  REPRISE: 'reprise_occlusion',
  REACTIVATION: 'reactivation',
  DOUBLON: 'doublon_ecarte',
  RECOUVRE: 'recouvre_piste_vivante',
  ABSENCE: 'absence_prolongee',
  OCCLUSION: 'occlusion_trop_longue',
  COUPURE: 'coupure_de_plan',
};

// ─────────────────────────────────────────────────────────
// GÉOMÉTRIE
// ─────────────────────────────────────────────────────────

export const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export const taille = (b) => [Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1])];
export const aire = (b) => { const [w, h] = taille(b); return w * h; };

/** Rapport de taille toujours ≥ 1, pour comparer sans se soucier du sens. */
export function rapportTaille(a, b) {
  const aa = aire(a), ab = aire(b);
  if (aa <= 0 || ab <= 0) return Infinity;
  return aa > ab ? aa / ab : ab / aa;
}

function boiteDepuis(cx, cy, w, h) {
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

// ─────────────────────────────────────────────────────────
// AFFECTATION OPTIMALE — ALGORITHME HONGROIS
// ─────────────────────────────────────────────────────────

/**
 * Affectation de coût minimal entre lignes et colonnes.
 *
 * Pourquoi pas « la boîte la plus proche » : au rallycross deux voitures se
 * touchent presque. Une association gloutonne donne à la première piste sa
 * meilleure détection, quitte à voler celle dont une autre piste avait un
 * besoin bien plus impérieux — c'est le mécanisme classique de l'échange
 * d'identité. L'affectation hongroise minimise le coût TOTAL et supprime ce
 * cas de figure.
 *
 * @param {number[][]} cout — matrice lignes × colonnes
 * @returns {number[]} pour chaque ligne, l'indice de colonne, ou -1
 */
export function hungarian(cout) {
  const n = cout.length;
  const m = n ? cout[0].length : 0;
  if (!n || !m) return new Array(n).fill(-1);

  // L'implémentation par chemins augmentants exige n ≤ m : on complète avec
  // des lignes fictives à coût nul, écartées à la fin.
  const k = Math.max(n, m);
  const GRAND = 1e9;
  const c = Array.from({ length: k }, (_, i) => Array.from({ length: k },
    (_, j) => (i < n && j < m ? cout[i][j] : GRAND)));

  const u = new Array(k + 1).fill(0);
  const v = new Array(k + 1).fill(0);
  const p = new Array(k + 1).fill(0);
  const way = new Array(k + 1).fill(0);

  for (let i = 1; i <= k; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(k + 1).fill(Infinity);
    const vu = new Array(k + 1).fill(false);
    do {
      vu[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= k; j++) {
        if (vu[j]) continue;
        const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= k; j++) {
        if (vu[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }

  const res = new Array(n).fill(-1);
  for (let j = 1; j <= k; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < n && j - 1 < m) res[i] = j - 1;
  }
  return res;
}

// ─────────────────────────────────────────────────────────
// PRÉDICTEUR
// ─────────────────────────────────────────────────────────

/**
 * Filtre alpha-bêta sur (centre, taille) — un Kalman à vitesse constante
 * dont on assume les gains au lieu de propager des covariances.
 *
 * Choix assumé : sans données annotées pour régler les matrices de bruit d'un
 * vrai Kalman, ses covariances seraient de toute façon devinées. Le filtre
 * alpha-bêta a deux constantes lisibles, tient en trente lignes, et se
 * remplace par un Kalman complet sans toucher au reste si le POC montre que
 * la prédiction est le facteur limitant.
 */
export class Predicteur {
  constructor(box, opts = {}) {
    const [cx, cy] = centre(box);
    const [w, h] = taille(box);
    this.s = { cx, cy, w, h, vx: 0, vy: 0, vw: 0, vh: 0 };
    this.tauP = opts.tauPosition ?? DEFAULTS.tauPosition;
    this.tauV = opts.tauVitesse ?? DEFAULTS.tauVitesse;
    this.tauA = opts.tauAmortissement ?? DEFAULTS.tauAmortissement;
    this.vTailleMax = opts.vitesseTailleMax ?? DEFAULTS.vitesseTailleMax;
    this.ratioTailleMax = opts.ratioTailleMax ?? DEFAULTS.ratioTailleMax;
    // Compteurs — sans eux on ne saurait pas si les bornes servent, ni à quel prix.
    this.vitesseBornee = 0;
    this.residusEcretes = 0;
  }

  /**
   * Ramène la vitesse de taille dans ce que la vidéo montre réellement.
   *
   * Le plafond est RELATIF à la taille courante et réappliqué à chaque pas :
   * c'est ce qui rend la dérive impossible plutôt que seulement plus lente.
   */
  _bornerTaille() {
    const s = this.s;
    const bw = this.vTailleMax * s.w, bh = this.vTailleMax * s.h;
    if (Math.abs(s.vw) > bw) { s.vw = Math.sign(s.vw) * bw; this.vitesseBornee += 1; }
    if (Math.abs(s.vh) > bh) { s.vh = Math.sign(s.vh) * bh; this.vitesseBornee += 1; }
  }

  /** Position attendue après `dt`, sans consommer de mesure. */
  predire(dt) {
    const s = this.s;
    return boiteDepuis(s.cx + s.vx * dt, s.cy + s.vy * dt,
      Math.max(1, s.w + s.vw * dt), Math.max(1, s.h + s.vh * dt));
  }

  /** Avance d'un pas sans mesure : la vitesse s'amortit sur `tauAmortissement`,
   *  faute de quoi une piste perdue filerait en ligne droite à l'infini. */
  avancerSansMesure(dt) {
    const s = this.s;
    s.cx += s.vx * dt; s.cy += s.vy * dt;
    s.w = Math.max(1, s.w + s.vw * dt); s.h = Math.max(1, s.h + s.vh * dt);
    const k = Math.exp(-dt / this.tauA);
    s.vx *= k; s.vy *= k; s.vw *= k; s.vh *= k;
    // La taille vient de changer : le plafond, qui lui est proportionnel, a
    // changé aussi. Sans ce rappel, une boîte qui rétrécit garderait le droit
    // de rétrécir à la vitesse de la boîte d'avant.
    this._bornerTaille();
  }

  /**
   * Intègre une mesure.
   *
   * `dt` est l'intervalle depuis la DERNIÈRE AVANCE de l'état, pas depuis la
   * dernière détection. L'état progresse à chaque pas — par correction ou par
   * `avancerSansMesure()` — et lui repasser le temps écoulé depuis la dernière
   * détection le faisait avancer deux fois : la position corrigée dépassait la
   * cible, l'IoU du pas suivant s'effondrait, et la piste se fragmentait.
   */
  corriger(box, dt) {
    const s = this.s;
    const [mx, my] = centre(box);
    const [mw, mh] = taille(box);
    const px = s.cx + s.vx * dt, py = s.cy + s.vy * dt;
    const pw = s.w + s.vw * dt, ph = s.h + s.vh * dt;
    const rx = mx - px, ry = my - py, rw = mw - pw, rh = mh - ph;

    const a = 1 - Math.exp(-dt / this.tauP);
    const kv = 1 - Math.exp(-dt / this.tauV);

    s.cx = px + a * rx; s.cy = py + a * ry;
    s.w = Math.max(1, pw + a * rw); s.h = Math.max(1, ph + a * rh);
    if (dt > 0) {
      s.vx += kv * (rx / dt); s.vy += kv * (ry / dt);
      // La TAILLE suit la mesure en entier (ligne au-dessus) : l'association
      // l'a déjà jugée recevable. La VITESSE, elle, n'intègre du résidu que
      // la part plausible — c'est l'intégration qui fabrique la dérive, pas
      // la correction.
      //
      // Écrêter plutôt qu'ignorer. Ignorer un résidu aberrant laisse intacte
      // une vitesse déjà fausse : mesuré, un prédicteur qui refusait
      // simplement la mise à jour gardait une vitesse de −48 px/s et
      // continuait de rétrécir. Écrêter garantit que la vitesse va TOUJOURS
      // vers la mesure, sans jamais bondir.
      // Écrêtage SYMÉTRIQUE en rapport, pas en pixels : la mesure est ramenée
      // dans [prévu ÷ ratioTailleMax, prévu × ratioTailleMax]. Un écrêtage
      // symétrique en pixels tolérerait une croissance de +50 % mais une
      // décroissance de −50 % — soit un rapport de 2 d'un côté et 1,5 de
      // l'autre — et fabriquerait un biais à la baisse.
      const ecreter = (r, prevu) => {
        const p = Math.max(1, prevu);
        const haut = (this.ratioTailleMax - 1) * p;
        const bas = (1 / this.ratioTailleMax - 1) * p;
        if (r <= haut && r >= bas) return r;
        this.residusEcretes += 1;
        return Math.min(haut, Math.max(bas, r));
      };
      s.vw += kv * (ecreter(rw, pw) / dt);
      s.vh += kv * (ecreter(rh, ph) / dt);
    }
    this._bornerTaille();
  }

  get boite() { return boiteDepuis(this.s.cx, this.s.cy, this.s.w, this.s.h); }
  get vitesse() { return [this.s.vx, this.s.vy]; }

  /** Applique un décalage global — la caméra a bougé, pas la voiture. */
  decaler(dx, dy) { this.s.cx += dx; this.s.cy += dy; }
}

/** Part de `petite` contenue dans `grande` — mesure d'inclusion, pas d'IoU. */
export function recouvrement(petite, grande) {
  const x1 = Math.max(petite[0], grande[0]), y1 = Math.max(petite[1], grande[1]);
  const x2 = Math.min(petite[2], grande[2]), y2 = Math.min(petite[3], grande[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const a = aire(petite);
  return a > 0 ? inter / a : 0;
}

// ─────────────────────────────────────────────────────────
// COMPENSATION DU MOUVEMENT DE CAMÉRA
// ─────────────────────────────────────────────────────────

/**
 * Décalage global estimé à partir des pistes déjà appariées.
 *
 * BoT-SORT estime une transformation affine par flot optique sur le décor.
 * Ici on l'estime sur les objets eux-mêmes : la MÉDIANE du déplacement des
 * boîtes appariées. Sur un panoramique, toutes les boîtes se déplacent du
 * même vecteur ; la médiane l'isole et résiste aux voitures qui, elles,
 * bougent vraiment. C'est la version « translation seule » que
 * AUTOMATION-ARCHITECTURE.md §5 juge souvent suffisante — et elle n'ajoute
 * aucune dépendance là où le flot optique exigerait OpenCV.js.
 *
 * Limite assumée : un ZOOM n'est pas compensé, seulement un panoramique.
 *
 * @param {Array<{avant:number[], apres:number[]}>} paires
 * @returns {{dx:number, dy:number, n:number}}
 */
export function decalageCamera(paires) {
  if (paires.length < 3) return { dx: 0, dy: 0, n: paires.length };
  const dxs = [], dys = [];
  for (const { avant, apres } of paires) {
    const a = centre(avant), b = centre(apres);
    dxs.push(b[0] - a[0]); dys.push(b[1] - a[1]);
  }
  const med = (arr) => {
    const t = [...arr].sort((x, y) => x - y);
    const i = Math.floor(t.length / 2);
    return t.length % 2 ? t[i] : (t[i - 1] + t[i]) / 2;
  };
  return { dx: med(dxs), dy: med(dys), n: paires.length };
}

/**
 * Décalage global estimé DANS le pas courant, par vote.
 *
 * `decalageCamera()` mesure un biais a posteriori : il ne peut rien au moment
 * précis où la caméra part en panoramique, puisqu'il vient du pas précédent.
 * Mesuré : sur un balayage de 90 px par pas avec des voitures espacées de
 * 150 px, chaque voiture recouvre mieux la piste de sa VOISINE que la sienne —
 * toutes les identités glissent d'un cran d'un seul coup.
 *
 * D'où ce second mécanisme, sans dépendance : on calcule les écarts de tous
 * les couples (piste, détection) et on retient la fenêtre la plus peuplée. Si
 * l'ensemble s'est déplacé en bloc, tous les bons couples votent pour le même
 * décalage et les mauvais se dispersent.
 *
 * @returns {{dx:number, dy:number, votes:number}|null}
 */
export function estimerDecalageGlobal(boitesA, boitesB) {
  if (boitesA.length < 2 || boitesB.length < 2) return null;
  const dxs = [], dys = [];
  for (const a of boitesA) {
    for (const b of boitesB) {
      const ca = centre(a), cb = centre(b);
      dxs.push(cb[0] - ca[0]);
      dys.push(cb[1] - ca[1]);
    }
  }
  // Largeur de fenêtre tirée de la MÉDIANE, jamais de la première boîte venue :
  // si celle-ci était une voiture lointaine de 50 px, la fenêtre tombait à
  // 25 px ; si c'était une voiture de premier plan de 300 px, elle montait à
  // 150 px et pouvait alors fusionner le pic « aucun décalage » avec celui du
  // voisin espacé de 150 px — le vote adoptait un décalage d'une demi-voiture.
  const largeurs = boitesA.map(b => taille(b)[0]).sort((a, b) => a - b);
  const largeur = Math.max(10, largeurs[Math.floor(largeurs.length / 2)] * 0.5);
  const mode = (vals) => {
    const tri = [...vals].sort((x, y) => x - y);
    let best = { n: 0, med: 0 };
    for (let i = 0; i < tri.length; i++) {
      let j = i;
      while (j < tri.length && tri[j] - tri[i] <= largeur) j++;
      if (j - i > best.n) best = { n: j - i, med: tri[Math.floor((i + j - 1) / 2)] };
    }
    return best;
  };
  const mx = mode(dxs), my = mode(dys);
  if (mx.n < 3 || my.n < 3) return null;
  return { dx: mx.med, dy: my.med, votes: Math.min(mx.n, my.n) };
}

// ─────────────────────────────────────────────────────────
// SUIVEUR
// ─────────────────────────────────────────────────────────

let _prochainId = 1;
export function reinitialiserIds() { _prochainId = 1; }

export class Suivi {
  constructor(options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    this.pistes = [];
    this.derniereCamera = { dx: 0, dy: 0, n: 0 };
    this.modeleCamera = null;          // ajusté au pas précédent
    this.comparaisonCamera = null;     // les modèles mis en concurrence (dernier pas)
    this.comparaisonsCamera = [];      // ... et la même mise en concurrence à CHAQUE pas
    this.residus = [];                 // { t, avant, apres, modele }
    this.dernierRattrapage = null;
    this.doublonsEcartes = 0;
    this.refus = [];
    this.journal = [];
    this.coupures = [];                // { t, suspendues: [id…] }
    reinitialiserIds();
  }

  get actives() { return this.pistes.filter(p => p.state !== ETATS.LOST); }
  /** Pistes qui ont franchi la phase de confirmation — les seules qui comptent. */
  get confirmees() { return this.pistes.filter(p => p.confirmee); }

  pas(t, detections) {
    const o = this.opt;
    const dt = this.journal.length ? t - this.journal[this.journal.length - 1].t : o.dt;

    const fortes = detections.filter(d => d.score >= o.highScore);
    const faibles = detections.filter(d => d.score < o.highScore && d.score >= o.lowScore);

    // 1 · prédiction, puis compensation du mouvement de caméra
    //
    // La boîte AVANT compensation est conservée : c'est elle qui permet de voir
    // si la correction pousse la piste dans la bonne direction, et de mesurer
    // le gain au lieu de le supposer.
    const modele = o.cameraCompensation ? this.modeleCamera : null;
    for (const p of this.pistes) {
      p.boiteAvant = p.pred.predire(dt);
      if (modele?.suffisant) {
        const [dx, dy] = modele.deplacement(p.boiteAvant);
        const g = o.gainBiais;
        p.boitePredite = Number.isFinite(dx) && Number.isFinite(dy)
          ? [p.boiteAvant[0] + dx * g, p.boiteAvant[1] + dy * g,
            p.boiteAvant[2] + dx * g, p.boiteAvant[3] + dy * g]
          : p.boiteAvant.slice();
      } else {
        p.boitePredite = p.boiteAvant.slice();
      }
    }

    // Une piste abandonnée continue d'être extrapolée pendant la fenêtre de
    // repêchage. Sans cela sa boîte restait figée à l'endroit de sa mort : une
    // voiture absente une seconde à 300 px/s se retrouvait 300 px plus loin,
    // l'IoU tombait à zéro, et le repêchage ne pouvait JAMAIS aboutir — d'où
    // les 0 et 1 réactivations observées pendant que des dizaines d'identités
    // se créaient.
    for (const p of this.pistes) {
      // Une piste SUSPENDUE n'est plus extrapolée : sa vitesse appartenait à un
      // référentiel qui n'existe plus.
      if (!p.suspendue && p.state === ETATS.LOST && p.confirmee && t - p.lastSeen <= o.dureeReactivation) {
        p.pred.avancerSansMesure(dt);
        p.boitePredite = p.pred.boite;
      }
    }

    const candidates = this.pistes.filter(p => p.state !== ETATS.LOST);

    // 2 · boîtes fusionnées, repérées avant toute association
    const fusions = this._reperersFusions(candidates, fortes);
    const utilisables = fortes.filter((_, i) => !fusions.has(i));

    // 3 · premier temps — détections fortes
    let assoc = this._associer(candidates, utilisables, o.iouMatch);

    // 3 bis · rattrapage d'un déplacement en bloc
    const possible = Math.min(candidates.length, utilisables.length);
    if (o.cameraCompensation && possible >= 3) {
      const d = estimerDecalageGlobal(candidates.map(p => p.boitePredite), utilisables.map(x => x.box));
      if (d && Math.hypot(d.dx, d.dy) > 1) {
        const bouger = (k) => {
          for (const p of candidates) {
            p.boitePredite = [p.boitePredite[0] + k * d.dx, p.boitePredite[1] + k * d.dy,
              p.boitePredite[2] + k * d.dx, p.boitePredite[3] + k * d.dy];
          }
        };
        bouger(1);
        const bis = this._associer(candidates, utilisables, o.iouMatch);
        // STRICTEMENT plus d'appariements, et rien d'autre. Accepter aussi un
        // coût total plus faible à nombre égal laissait le décalage RÉAFFECTER
        // les pistes entre elles pour économiser quelques centièmes d'IoU :
        // un échange d'identité silencieux, d'autant plus probable à 10 Hz que
        // le mouvement réel y est petit devant le bruit de détection.
        if (bis.paires.length > assoc.paires.length) { assoc = bis; this.dernierRattrapage = d; }
        else bouger(-1);
      }
    }
    const { paires, lignesLibres, colonnesLibres, ambigus } = assoc;

    const appariees = [];
    const associeesCeTour = [];
    for (const [iPiste, iDet] of paires) {
      const piste = candidates[iPiste];
      const det = utilisables[iDet];
      appariees.push({ avant: piste.boitePredite, apres: det.box, brut: piste.boiteAvant });
      this._confirmer(piste, t, det, ambigus.has(iPiste), dt);
      associeesCeTour.push(piste);
    }

    // 4 · second temps — détections faibles contre les pistes orphelines
    const orphelines = lignesLibres.map(i => candidates[i]);
    const r2 = this._associer(orphelines, faibles, o.iouMatchLow);
    const encoreOrphelines = new Set(r2.lignesLibres.map(i => orphelines[i]));
    for (const [iPiste, iDet] of r2.paires) {
      const piste = orphelines[iPiste];
      this._confirmer(piste, t, faibles[iDet], true, dt, 'faible');   // sauvetage = jamais certain
      piste.rescued += 1;
      associeesCeTour.push(piste);
    }

    // 5 · pistes toujours sans détection
    for (const piste of orphelines) {
      if (!encoreOrphelines.has(piste)) continue;
      const occulteur = piste._fusionAvec ?? this._chercherOccluseur(piste, utilisables, paires, candidates);
      this.refus.push(this._diagnostiquer(
        piste.boitePredite,
        utilisables.map((d, i) => ({ boite: d.box, id: i, ref: d })),
        new Set(paires.map(([, j]) => utilisables[j])),
        'piste', piste.id, t));
      this._sansMesure(piste, t, dt, occulteur);
      piste._fusionAvec = null;
    }

    // 6 · détections fortes non utilisées
    //
    // ORDRE VOULU : reprendre une piste occluse, puis repêcher une piste
    // abandonnée récemment, puis reconnaître un doublon — et seulement en
    // dernier recours créer une identité. C'est l'inverse de la version
    // précédente, où toute détection libre devenait une piste : sur la grille
    // de départ, 7 détections pour 5 voitures donnaient 7 identités.
    let doublonsCeTour = 0;
    let creationsCeTour = 0, reactivationsCeTour = 0, reprisesCeTour = 0;
    const reprises = new Set();
    // Les pistes CRÉÉES pendant ce même pas entrent aussi dans la comparaison :
    // au tout premier instant rien n'est encore apparié, et sans cela les sept
    // détections de la grille de départ devenaient sept identités.
    const servies = [...associeesCeTour];
    for (const iDet of colonnesLibres) {
      const det = utilisables[iDet];

      const occluse = this._reprendreOccluse(det, reprises);
      if (occluse) {
        reprises.add(occluse);
        this._confirmer(occluse, t, det, true, dt, 'reprise');
        occluse.recovered += 1;
        reprisesCeTour += 1;
        continue;
      }

      const abandonnee = this._reactiver(det, t, reprises);
      if (abandonnee) {
        reprises.add(abandonnee);
        abandonnee.state = ETATS.TENTATIVE;
        abandonnee.sansDetection = 0;
        abandonnee.raisonSuppression = null;
        this._confirmer(abandonnee, t, det, true, dt, 'reactivation');
        abandonnee.reactivated += 1;
        reactivationsCeTour += 1;
        continue;
      }

      const original = this._doublonDe(det, servies);
      if (original) {
        original.doublonsAbsorbes += 1;
        this.doublonsEcartes += 1;
        doublonsCeTour += 1;
        continue;
      }

      // Piste vivante mais non servie à cet instant, que cette boîte recouvre :
      // créer une identité par-dessus laisserait DEUX pistes vivantes pour la
      // même voiture, l'une prédite et l'autre détectée, sans que rien ne les
      // relie jamais.
      const recouverte = this._doublonDe(det, candidates.filter(p => p.confirmee && !servies.includes(p)));
      if (recouverte) {
        recouverte.doublonsAbsorbes += 1;
        this.doublonsEcartes += 1;
        doublonsCeTour += 1;
        this.refus.push({ t, cote: 'detection', id: null, cible: recouverte.id, raison: RAISONS.RECOUVRE });
        continue;
      }

      this.refus.push(this._diagnostiquer(
        det.box,
        candidates.map(p => ({ boite: p.boitePredite, id: p.id, ref: p })),
        new Set(associeesCeTour),
        'detection', null, t));
      servies.push(this._creer(t, det));
      creationsCeTour += 1;
    }

    // 7 · modèle de caméra pour le pas suivant, et mesure de son effet
    this.derniereCamera = o.cameraCompensation ? decalageCamera(appariees) : { dx: 0, dy: 0, n: 0 };
    if (o.cameraCompensation && appariees.length) {
      const ecart = (a, b) => {
        const [ax, ay] = centre(a), [bx, by] = centre(b);
        return Math.hypot(ax - bx, ay - by);
      };
      const med = (arr) => {
        if (!arr.length) return null;
        const tri = [...arr].sort((x, y) => x - y);
        const i = Math.floor(tri.length / 2);
        return Number((tri.length % 2 ? tri[i] : (tri[i - 1] + tri[i]) / 2).toFixed(2));
      };
      this.residus.push({
        t: Number(t.toFixed(3)),
        avant: med(appariees.map(a => ecart(a.brut ?? a.avant, a.apres))),
        apres: med(appariees.map(a => ecart(a.avant, a.apres))),
        modele: modele?.id ?? 'aucune',
        n: appariees.length,
      });

      this.comparaisonCamera = comparerModeles(appariees);
      // Accumulée, et pas seulement conservée : au DERNIER pas il ne reste
      // souvent qu'une paire appariée, et le rapport concluait alors que seul
      // le modèle « aucune » était applicable — sur un échantillon de un.
      this.comparaisonsCamera.push({
        t: Number(t.toFixed(3)), n: appariees.length,
        recommande: this.comparaisonCamera.recommande,
        erreurs: Object.fromEntries(Object.entries(this.comparaisonCamera.resultats)
          .map(([id, r]) => [id, r.applicable ? r.erreurLaisseeDeCote : null])),
      });
      const choix = o.modeleCamera === 'auto' ? this.comparaisonCamera.recommande : o.modeleCamera;
      this.modeleCamera = ajusterCamera(appariees, choix);
    } else {
      this.modeleCamera = null;
    }

    const instant = this._instantane(t, detections.length, fortes.length, faibles.length, fusions.size, doublonsCeTour, {
      candidates: candidates.length,
      appariees: paires.length + r2.paires.length,
      sansMesure: candidates.length - (paires.length + r2.paires.length),
      creees: creationsCeTour,
      reprises: reprisesCeTour,
      reactivees: reactivationsCeTour,
    });
    this.journal.push(instant);
    return instant;
  }

  // ── association générique ──────────────────────────────
  _associer(pistes, dets, porte) {
    if (!pistes.length || !dets.length) {
      return {
        paires: [], ambigus: new Set(), coutTotal: 0,
        lignesLibres: pistes.map((_, i) => i),
        colonnesLibres: dets.map((_, i) => i),
      };
    }
    const o = this.opt;
    const INTERDIT = 10;
    const cout = pistes.map((p) => dets.map((d) => {
      const recouvre = iou(p.boitePredite, d.box);
      if (recouvre < porte) return INTERDIT;
      if (rapportTaille(p.boitePredite, d.box) > o.maxSizeRatio) return INTERDIT;
      return 1 - recouvre;
    }));

    const aff = hungarian(cout);
    const paires = [];
    const ambigus = new Set();
    const prises = new Set();
    let coutTotal = 0;
    aff.forEach((j, i) => {
      if (j < 0 || cout[i][j] >= INTERDIT) return;
      paires.push([i, j]);
      prises.add(j);
      coutTotal += cout[i][j];
      const tries = [...cout[i]].filter(c => c < INTERDIT).sort((a, b) => a - b);
      if (tries.length > 1 && tries[1] - tries[0] < o.ambiguityMargin) ambigus.add(i);
    });
    return {
      paires, ambigus, coutTotal,
      lignesLibres: pistes.map((_, i) => i).filter(i => !paires.some(([a]) => a === i)),
      colonnesLibres: dets.map((_, j) => j).filter(j => !prises.has(j)),
    };
  }

  /**
   * COUPURE DE PLAN — le référentiel image est réinitialisé.
   *
   * À appeler AVANT le premier `pas()` du nouveau plan. Rien ne doit traverser :
   * une position, une vitesse ou une boîte du plan précédent ne décrit plus
   * rien. Les pistes ne sont pas tuées mais SUSPENDUES — elles gardent leur
   * dernière boîte observée, leur mémoire d'apparence et leur identité logique,
   * de quoi tenter plus tard une réattribution qui n'est pas géométrique.
   *
   * Ce qu'on évitait sans elle, mesuré : à t = 6,3 s le suivi portait 13 pistes
   * pour cinq voitures — cinq fantômes du plan précédent, extrapolés pendant
   * jusqu'à deux secondes, à côté de huit identités neuves.
   */
  couper(t, raison = RAISONS.COUPURE) {
    const suspendues = [];
    for (const p of this.pistes) {
      if (p.state === ETATS.LOST) continue;
      p.suspendue = true;
      p.state = ETATS.LOST;
      p.raisonSuppression = raison;
      p.suspendueA = Number(t.toFixed(3));
      suspendues.push(p.id);
    }
    // Un modèle de caméra ajusté sur le plan précédent ne décrit pas le
    // nouveau : le garder ferait dériver toutes les prédictions du plan neuf.
    this.modeleCamera = null;
    this.comparaisonCamera = null;
    this.derniereCamera = { dx: 0, dy: 0, n: 0 };
    this.dernierRattrapage = null;
    this.coupures.push({ t: Number(t.toFixed(3)), suspendues });
    return suspendues;
  }

  /** Piste suspendue qu'une réattribution pourra reprendre — pas encore utilisée. */
  get suspendues() { return this.pistes.filter(p => p.suspendue); }

  // ── mémoire d'apparence ────────────────────────────────
  /**
   * Range une signature si l'observation est PROPRE.
   *
   * Une seule mauvaise observation suffit à empoisonner une identité, et les
   * mauvaises sont reconnaissables sans rien deviner :
   *
   *   · une boîte PRÉDITE ne montre pas la voiture — d'où l'appel seulement
   *     depuis les voies où une détection existe vraiment ;
   *   · une boîte FUSIONNÉE montre deux voitures — elles sont déjà écartées de
   *     l'association forte, donc jamais mémorisées ;
   *   · une détection de la BANDE BASSE est en dessous du seuil du banc ;
   *   · une association jugée INCERTAINE l'a été parce que le deuxième choix
   *     valait presque le premier ;
   *   · une boîte qui touche le BORD de l'image est tronquée — c'est le défaut
   *     qui avait fait s'effondrer les largeurs au point ①, et une livrée
   *     coupée en deux n'est pas la livrée.
   */
  _memoriser(piste, t, det, source, incertain) {
    const o = this.opt;
    if (!o.memoireApparence || !det.sig) return;
    if (source !== 'forte' && source !== 'creation') return;
    if (incertain) return;
    if (o.largeurImage && o.hauteurImage) {
      const m = o.margeBord;
      const [x1, y1, x2, y2] = det.box;
      if (x1 <= m || y1 <= m || x2 >= o.largeurImage - m || y2 >= o.hauteurImage - m) return;
    }
    piste.apparences.push({
      t: Number(t.toFixed(3)), sig: det.sig, score: det.score, box: det.box.map(v => Math.round(v)),
    });
    // Anneau borné : la mémoire suit la voiture, elle ne l'archive pas.
    while (piste.apparences.length > o.memoireApparence) piste.apparences.shift();
  }

  // ── transitions ────────────────────────────────────────
  _confirmer(piste, t, det, incertain, dt, source = 'forte') {
    piste.pred.corriger(det.box, Math.max(1e-3, dt));
    piste.box = det.box.slice();
    // Posée ici, donc par TOUTES les voies d'association — bande basse,
    // reprise d'occlusion, réactivation. Elle ne l'était que par la voie
    // forte, et gardait sa valeur d'un pas à l'autre : une piste prédite
    // exportait la détection d'un instant précédent comme si elle venait
    // d'être associée.
    piste.boiteAssociee = det.box.slice();
    piste.score = det.score;
    piste.label = det.label || piste.label;
    piste.hits += 1;
    piste.misses = 0;
    piste.sansDetection = 0;
    piste.lastSeen = t;
    piste.occludedBy = null;
    piste.ambiguous = !!incertain;

    // Confirmation : un nombre de détections ET une durée. Exiger seulement des
    // détections rendait la barre deux fois et demie plus facile à 10 Hz qu'à
    // 4 Hz — un doublon persistant deux dixièmes de seconde devenait une
    // identité à part entière.
    if (!piste.confirmee
      && piste.hits >= this.opt.detectionsConfirmation
      && t - piste.firstSeen >= this.opt.dureeConfirmation - 1e-9) {
      piste.confirmee = true;
    }
    piste.state = piste.confirmee ? ETATS.DETECTED : ETATS.TENTATIVE;
    this._memoriser(piste, t, det, source, incertain);
    // `ambigu` et `source` rendent la QUALITÉ de chaque pas relisible après
    // coup : sans eux, impossible de savoir pourquoi une mémoire est vide.
    piste.history.push({
      t, box: piste.box.slice(), state: piste.state, score: det.score,
      ambigu: !!incertain, source,
    });
  }

  _sansMesure(piste, t, dt, occulteur) {
    piste.pred.avancerSansMesure(dt);
    piste.box = piste.pred.boite;
    piste.boiteAssociee = null;
    piste.misses += 1;
    piste.sansDetection += dt;
    piste.ambiguous = true;
    if (occulteur != null) {
      piste.occludedBy = occulteur;
      piste.state = piste.confirmee ? ETATS.OCCLUDED : ETATS.TENTATIVE;
      piste.occludedFor = (piste.occludedFor || 0) + 1;
    } else {
      piste.occludedBy = null;
      piste.state = piste.confirmee ? ETATS.PREDICTED : ETATS.TENTATIVE;
    }
    const limite = piste.occludedBy != null ? this.opt.dureeOcclusionMax : this.opt.dureeAvantAbandon;
    if (piste.sansDetection > limite + 1e-9) {
      piste.state = ETATS.LOST;
      piste.raisonSuppression = piste.occludedBy != null ? RAISONS.OCCLUSION : RAISONS.ABSENCE;
    }
    if (piste.misses === 1) piste.losses += 1;
    piste.history.push({
      t, box: piste.box.slice(), state: piste.state, score: null,
      ambigu: true, source: 'prediction',
    });
  }

  _creer(t, det) {
    const o = this.opt;
    const piste = {
      id: _prochainId++,
      pred: new Predicteur(det.box, o),
      box: det.box.slice(),
      boitePredite: det.box.slice(),
      boiteAssociee: det.box.slice(),
      score: det.score,
      label: det.label || null,
      state: ETATS.TENTATIVE,
      confirmee: false,
      hits: 1, misses: 0, sansDetection: 0,
      losses: 0, rescued: 0, recovered: 0, reactivated: 0,
      doublonsAbsorbes: 0, occludedFor: 0,
      firstSeen: t, lastSeen: t,
      occludedBy: null, ambiguous: false,
      raisonCreation: RAISONS.NOUVELLE, raisonSuppression: null,
      // FILIATION. `identiteLogique` est la racine de la chaîne : tant qu'aucune
      // réattribution n'a lieu, chaque piste est sa propre racine. C'est ce
      // champ, et lui seul, qui permettra de dire combien des identités du
      // départ atteignent le V1 — « cinq pistes actives » ne le dit pas.
      identiteLogique: _prochainId - 1,
      ancetre: null,
      suspendue: false,
      apparences: [],
      history: [{
        t, box: det.box.slice(), state: ETATS.TENTATIVE, score: det.score,
        ambigu: false, source: 'creation',
      }],
    };
    // Une création vient toujours d'une détection FORTE non fusionnée : c'est
    // une observation propre, et l'écarter priverait de mémoire les premiers
    // instants, ceux d'avant la confirmation.
    this._memoriser(piste, t, det, 'creation', false);
    this.pistes.push(piste);
    return piste;
  }

  _reperersFusions(candidates, fortes) {
    const o = this.opt;
    const fusions = new Set();
    fortes.forEach((det, i) => {
      const touchees = candidates.filter(p => p.confirmee && iou(p.boitePredite, det.box) > o.iouRecover);
      if (touchees.length < 2) return;
      const aires = touchees.map(p => aire(p.boitePredite)).sort((a, b) => a - b);
      const mediane = aires[Math.floor(aires.length / 2)];
      if (!mediane || aire(det.box) / mediane < o.mergeAreaRatio) return;

      fusions.add(i);
      const cBloc = centre(det.box);
      const cx = touchees.reduce((t, p) => t + centre(p.boitePredite)[0], 0) / touchees.length;
      const cy = touchees.reduce((t, p) => t + centre(p.boitePredite)[1], 0) / touchees.length;
      for (const p of touchees) {
        p.pred.decaler((cBloc[0] - cx) * o.gainFusion, (cBloc[1] - cy) * o.gainFusion);
        p._fusionAvec = 'fusion';
      }
    });
    return fusions;
  }

  _chercherOccluseur(piste, fortes, paires, candidates) {
    for (const [iPiste, iDet] of paires) {
      const det = fortes[iDet];
      if (iou(piste.boitePredite, det.box) < this.opt.iouRecover) continue;
      const autre = candidates[iPiste];
      const attendu = aire(autre.boitePredite);
      if (attendu > 0 && aire(det.box) / attendu >= this.opt.mergeAreaRatio) return autre.id;
      if (iou(piste.boitePredite, det.box) > 0.35) return autre.id;
    }
    return null;
  }

  _reprendreOccluse(det, deja) {
    let meilleure = null, meilleurIou = this.opt.iouRecover;
    for (const p of this.pistes) {
      if (p.suspendue || deja.has(p)) continue;
      if (p.state !== ETATS.OCCLUDED && p.state !== ETATS.PREDICTED) continue;
      const r = iou(p.boitePredite, det.box);
      if (r > meilleurIou && rapportTaille(p.boitePredite, det.box) <= this.opt.maxSizeRatio) {
        meilleurIou = r; meilleure = p;
      }
    }
    return meilleure;
  }

  /**
   * Repêche une piste abandonnée récemment.
   *
   * Sans ce mécanisme, toute voiture perdue plus d'une seconde revenait sous un
   * NOUVEL identifiant : c'est la principale source de fragmentation, et elle
   * est indiscernable d'un vrai échange d'identité dans les mesures.
   */
  _reactiver(det, t, deja) {
    // Critère de DISTANCE, pas d'IoU. Après une seconde d'absence, la position
    // extrapolée est forcément imprécise : exiger un recouvrement de boîtes
    // revenait à interdire le repêchage. On demande une proximité de l'ordre
    // d'une voiture et un gabarit compatible.
    const o = this.opt;
    const [dx, dy] = centre(det.box);
    let meilleure = null, meilleurEcart = Infinity;
    for (const p of this.pistes) {
      // Repêcher à travers une coupure serait fabriquer une continuité que
      // rien n'atteste : la position d'avant ne dit rien de celle d'après.
      if (p.suspendue || deja.has(p) || p.state !== ETATS.LOST || !p.confirmee) continue;
      const age = t - p.lastSeen;
      if (age > o.dureeReactivation) continue;
      if (rapportTaille(p.boitePredite, det.box) > o.maxSizeRatio) continue;
      const [px, py] = centre(p.boitePredite);
      const [w, h] = taille(p.boitePredite);
      const portee = Math.max(w, h) * o.porteeReactivation;
      const ecart = Math.hypot(dx - px, dy - py);
      if (ecart <= portee && ecart < meilleurEcart) { meilleurEcart = ecart; meilleure = p; }
    }
    return meilleure;
  }

  /**
   * La détection est-elle un doublon d'une piste déjà servie à cet instant ?
   *
   * Deux critères : un recouvrement franc (IoU), ou une boîte largement
   * CONTENUE dans celle d'une piste suivie — le cas typique du détecteur qui
   * pose une seconde boîte sur l'avant d'une voiture déjà détectée.
   */
  /**
   * Pourquoi cette boîte n'a-t-elle rejoint aucune piste ?
   *
   * Répond du point de vue de la DÉTECTION (`cote: 'detection'`) ou de la
   * PISTE (`cote: 'piste'`), avec les valeurs qui ont fait pencher la balance,
   * pour qu'une cause dominante se lise dans le rapport au lieu de se deviner.
   */
  _diagnostiquer(boite, autres, servies, cote, id = null, t = 0) {
    const o = this.opt;
    if (!autres.length) {
      return { t, cote, id, raison: cote === 'piste' ? REFUS.AUCUNE_DETECTION : REFUS.AUCUNE_PISTE };
    }
    let meilleur = null, meilleurIou = -1;
    for (const a of autres) {
      const r = iou(boite, a.boite);
      if (r > meilleurIou) { meilleurIou = r; meilleur = a; }
    }
    const ratio = rapportTaille(boite, meilleur.boite);
    const [ax, ay] = centre(boite), [bx, by] = centre(meilleur.boite);
    const [w, h] = taille(boite);
    const distance = Math.hypot(ax - bx, ay - by) / Math.max(1, Math.max(w, h));
    const base = {
      t, cote, id, cible: meilleur.id ?? null,
      iou: Number(meilleurIou.toFixed(3)),
      ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
      distance: Number(distance.toFixed(2)),
    };
    if (meilleurIou >= o.iouMatch) {
      return { ...base, raison: servies.has(meilleur.ref) ? REFUS.DEJA_ATTRIBUEE : REFUS.COUT_HONGROIS };
    }
    if (meilleurIou > 0 && ratio > o.maxSizeRatio) return { ...base, raison: REFUS.RATIO_TAILLE };
    if (meilleurIou > 0) return { ...base, raison: REFUS.IOU_INSUFFISANT };
    return { ...base, raison: REFUS.DISTANCE };
  }

  _doublonDe(det, servies) {
    for (const p of servies) {
      // Un doublon est TOUJOURS la vue la plus faible : exiger un score
      // inférieur évite de sacrifier une vraie voiture mieux détectée que sa
      // voisine, au départ où les cinq boîtes se chevauchent déjà.
      if (p.score != null && det.score > p.score) continue;
      if (iou(p.box, det.box) >= this.opt.iouDoublon) return p;
      if (recouvrement(det.box, p.box) >= this.opt.recouvrementDoublon) return p;
      if (recouvrement(p.box, det.box) >= this.opt.recouvrementDoublon) return p;
    }
    return null;
  }

  _instantane(t, nbTotal, nbFortes, nbFaibles, nbFusions = 0, nbDoublons = 0, bilan = null) {
    const vivantes = this.pistes.filter(p => p.state !== ETATS.LOST);
    return {
      t: Number(t.toFixed(3)),
      detections: { total: nbTotal, fortes: nbFortes, faibles: nbFaibles, fusions: nbFusions, doublons: nbDoublons },
      // Bilan d'association du pas — c'est lui qui rend une RUPTURE DE PLAN
      // lisible : à un changement de caméra, presque aucune piste ne trouve de
      // détection et plusieurs identités naissent dans le même souffle.
      association: bilan ? { ...bilan, doublons: nbDoublons } : null,
      biais: { ...this.derniereCamera },
      tracks: vivantes.map(p => ({
        id: p.id,
        identiteLogique: p.identiteLogique,
        box: p.box.map(v => Math.round(v)),
        // Les trois boîtes du diagnostic de compensation : prédiction brute,
        // prédiction compensée, détection finalement associée.
        boiteAvant: p.boiteAvant ? p.boiteAvant.map(v => Math.round(v)) : null,
        boiteCompensee: p.boitePredite ? p.boitePredite.map(v => Math.round(v)) : null,
        boiteAssociee: p.boiteAssociee ? p.boiteAssociee.map(v => Math.round(v)) : null,
        state: p.state,
        score: p.score,
        confirmee: p.confirmee,
        ambiguous: p.ambiguous,
        occludedBy: p.occludedBy,
        misses: p.misses,
        // Le COMPTE seulement : huit signatures de 120 réels par piste
        // pèseraient plus que tout le reste du rapport.
        apparences: p.apparences.length,
        // Vitesses de l'état interne, y compris celles de TAILLE. Sans elles,
        // une boîte prédite absurde ne se distingue pas d'une voiture qui
        // grossit vraiment : c'est la mesure qui manquait au diagnostic.
        vitesse: {
          vx: Math.round(p.pred.s.vx), vy: Math.round(p.pred.s.vy),
          vw: Math.round(p.pred.s.vw), vh: Math.round(p.pred.s.vh),
        },
        trail: p.history.slice(-5).map(h => centre(h.box).map(v => Math.round(v))),
      })),
      counts: {
        detected: vivantes.filter(p => p.state === ETATS.DETECTED).length,
        predicted: vivantes.filter(p => p.state === ETATS.PREDICTED).length,
        occluded: vivantes.filter(p => p.state === ETATS.OCCLUDED).length,
        tentative: vivantes.filter(p => p.state === ETATS.TENTATIVE).length,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// MESURES
// ─────────────────────────────────────────────────────────

/**
 * RUPTURES DE PLAN — repérées, jamais compensées.
 *
 * Un changement de caméra n'est pas un panoramique : le référentiel image est
 * réellement réinitialisé, et aucune transformation géométrique estimée sur
 * les pistes ne peut le rattraper. La seule chose honnête est de le REPÉRER,
 * pour pouvoir dire ce qui, dans la fragmentation, lui revient.
 *
 * La signature d'une rupture est double, et les deux moitiés sont nécessaires :
 *
 *   · presque aucune piste vivante ne retrouve de détection — une occlusion
 *     collective ou une perte de détection donnerait le même signal ;
 *   · plusieurs identités naissent au même instant — un simple flou de
 *     détection donnerait le même signal.
 *
 * Ensemble, elles ne se produisent que quand l'image entière a changé.
 *
 * Fonction PURE, calculée sur le journal exporté : elle s'applique aussi aux
 * rapports déjà produits, ce qui permet de la valider sur des mesures faites
 * avant qu'elle n'existe.
 */
export function detecterRuptures(journal, { refus = [], partMin = 0.6, creationsMin = 2, fenetre = 0.6 } = {}) {
  const parInstant = [];
  const vues = new Set();
  if (journal.length) journal[0].tracks.forEach(t => vues.add(t.id));

  // Refus côté PISTE par instant : c'est exactement le nombre de pistes
  // vivantes restées sans détection, et il figure dans les rapports déjà
  // exportés. Les états publiés ne suffisent pas — une piste non confirmée
  // reste `tentative` qu'elle ait été appariée ou non, et une rupture passait
  // alors sous le seuil alors que 69 % des pistes venaient d'être refusées.
  const orphelines = new Map();
  for (const r of refus) {
    if (r.cote !== 'piste') continue;
    orphelines.set(r.t, (orphelines.get(r.t) || 0) + 1);
  }

  for (let i = 1; i < journal.length; i++) {
    const j = journal[i];
    const vivantesAvant = journal[i - 1].tracks.length;
    const neufs = j.tracks.filter(t => !vues.has(t.id));
    neufs.forEach(t => vues.add(t.id));

    // Par ordre de fiabilité : le bilan d'association du pas, puis le compte
    // de refus, puis — faute de mieux — les états publiés.
    const a = j.association;
    const part = a && a.candidates ? a.sansMesure / a.candidates
      : (vivantesAvant && orphelines.size ? Math.min(1, (orphelines.get(j.t) || 0) / vivantesAvant)
        : (vivantesAvant ? (j.counts.predicted + j.counts.occluded) / vivantesAvant : 0));
    const creations = a ? a.creees : neufs.length;

    parInstant.push({
      t: j.t,
      partSansMesure: Number(part.toFixed(3)),
      creations,
      vivantes: vivantesAvant,
      score: Number((0.6 * Math.min(1, part) + 0.4 * Math.min(1, creations / Math.max(1, vivantesAvant))).toFixed(3)),
      rupture: part >= partMin && creations >= creationsMin,
    });
  }

  // Une coupure occupe plusieurs pas à 10 Hz : on regroupe les instants
  // signalés qui se suivent, et on retient le plus marqué. Compter cinq
  // coupures là où il y en a une fausserait toute ventilation.
  const cuts = [];
  for (const x of parInstant.filter(v => v.rupture)) {
    const dernier = cuts[cuts.length - 1];
    if (dernier && x.t - dernier.fin <= fenetre) {
      dernier.fin = x.t;
      dernier.instants.push(x.t);
      if (x.score > dernier.score) { dernier.t = x.t; dernier.score = x.score; }
      dernier.creations += x.creations;
    } else {
      cuts.push({ t: x.t, debut: x.t, fin: x.t, score: x.score, creations: x.creations, instants: [x.t] });
    }
  }
  return { parInstant, cuts };
}

/**
 * Ce que la fragmentation doit aux ruptures, et ce qu'elle leur doit PAS.
 *
 * `rayon` : demi-largeur de la zone considérée « autour » d'une coupure. Une
 * piste tuée par un cut ne renaît pas toujours au pas suivant — elle attend la
 * fin de sa fenêtre d'abandon.
 */
export function ventilerAutourDesRuptures(journal, refus, cuts, { rayon = 0.55 } = {}) {
  const pres = (t) => cuts.some(c => t >= c.debut - rayon && t <= c.fin + rayon);
  const vues = new Set();
  let creations = 0, creationsPres = 0;
  for (const [i, j] of journal.entries()) {
    for (const tr of j.tracks) {
      if (vues.has(tr.id)) continue;
      vues.add(tr.id);
      if (i === 0) continue;              // la grille de départ n'est pas une rupture
      creations += 1;
      if (pres(j.t)) creationsPres += 1;
    }
  }
  const compter = (liste) => liste.reduce((acc, r) => {
    acc[r.raison] = (acc[r.raison] || 0) + 1; return acc;
  }, {});
  const dedans = refus.filter(r => pres(r.t)), dehors = refus.filter(r => !pres(r.t));
  const instantsDedans = journal.filter(j => pres(j.t)).length;
  const instantsDehors = journal.length - instantsDedans;
  return {
    rayon,
    cuts: cuts.map(c => ({ t: c.t, debut: c.debut, fin: c.fin, score: c.score })),
    creations: {
      total: creations, pres: creationsPres, hors: creations - creationsPres,
      partPres: creations ? Number((creationsPres / creations).toFixed(3)) : null,
    },
    refus: {
      pres: { instants: instantsDedans, total: dedans.length, parRaison: compter(dedans), parInstant: instantsDedans ? Number((dedans.length / instantsDedans).toFixed(2)) : null },
      hors: { instants: instantsDehors, total: dehors.length, parRaison: compter(dehors), parInstant: instantsDehors ? Number((dehors.length / instantsDehors).toFixed(2)) : null },
    },
    // Refus où DEUX pistes se disputaient la même détection : c'est le seul
    // sous-ensemble qu'un coût de cohérence de groupe ou une signature
    // d'apparence pourrait trancher pendant une caméra continue. Le reste
    // relève de la géométrie ou de la détection, pas de l'arbitrage.
    competition: {
      total: refus.filter(r => r.raison === REFUS.DEJA_ATTRIBUEE || r.raison === REFUS.COUT_HONGROIS).length,
      hors: dehors.filter(r => r.raison === REFUS.DEJA_ATTRIBUEE || r.raison === REFUS.COUT_HONGROIS).length,
      part: refus.length ? Number((refus.filter(r => r.raison === REFUS.DEJA_ATTRIBUEE || r.raison === REFUS.COUT_HONGROIS).length / refus.length).toFixed(3)) : null,
    },
  };
}

/**
 * COHÉRENCE SPATIALE DU GROUPE — mesurée avant d'être utilisée.
 *
 * L'hypothèse à tester est qu'un peloton garde son ordre : si l'ordre
 * gauche-droite se conserve presque toujours, il porte de l'information et
 * peut devenir un COÛT supplémentaire quand plusieurs associations se valent.
 * S'il s'inverse souvent, en faire une contrainte interdirait les dépassements
 * — précisément ce qu'on cherche à observer au virage 1.
 *
 * `ecartVoisins` dit à quel point l'ordre est franc : un écart médian d'une
 * demi-largeur de boîte veut dire que l'ordre est souvent serré, et donc que
 * la cohérence doit rester un coût mou, jamais un interdit.
 */
export function coherenceSpatiale(journal) {
  let paires = 0, inversions = 0;
  const parInstant = [];
  for (let i = 1; i < journal.length; i++) {
    const A = new Map(journal[i - 1].tracks.filter(t => t.confirmee).map(t => [t.id, t.box]));
    const B = new Map(journal[i].tracks.filter(t => t.confirmee).map(t => [t.id, t.box]));
    const communs = [...A.keys()].filter(id => B.has(id));
    let inv = 0, np = 0;
    for (let a = 0; a < communs.length; a++) {
      for (let b = a + 1; b < communs.length; b++) {
        const s1 = Math.sign(centre(A.get(communs[a]))[0] - centre(A.get(communs[b]))[0]);
        const s2 = Math.sign(centre(B.get(communs[a]))[0] - centre(B.get(communs[b]))[0]);
        np += 1;
        if (s1 && s2 && s1 !== s2) inv += 1;
      }
    }
    paires += np; inversions += inv;
    if (inv) parInstant.push({ t: journal[i].t, inversions: inv, paires: np });
  }

  const ecarts = [];
  for (const j of journal) {
    const rang = j.tracks.filter(t => t.confirmee)
      .map(t => ({ x: centre(t.box)[0], w: taille(t.box)[0] }))
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < rang.length; i++) {
      const ref = (rang[i].w + rang[i - 1].w) / 2;
      if (ref > 0) ecarts.push((rang[i].x - rang[i - 1].x) / ref);
    }
  }
  const q = (arr, p) => {
    if (!arr.length) return null;
    const t = [...arr].sort((a, b) => a - b);
    return Number(t[Math.min(t.length - 1, Math.floor((t.length - 1) * p))].toFixed(2));
  };

  return {
    pairesSuivies: paires,
    inversions,
    tauxInversion: paires ? Number((inversions / paires).toFixed(4)) : null,
    instantsAvecInversion: parInstant,
    ecartVoisins: { n: ecarts.length, p10: q(ecarts, 0.1), median: q(ecarts, 0.5), p90: q(ecarts, 0.9) },
  };
}

/**
 * Mesures tirées du journal et des pistes.
 *
 * Aucune ne prétend dire si un `trackId` désigne toujours la MÊME voiture :
 * cela demande une vérité terrain, et c'est l'humain qui la fournit.
 *
 * Les compteurs de FRAGMENTATION sont les plus utiles au diagnostic : ils
 * disent combien d'identités ont été fabriquées pour combien de voitures, et
 * pourquoi.
 */
export function mesurer(suivi, { cible = 5, tV1 = null } = {}) {
  const journal = suivi.journal;
  const pistes = suivi.pistes;
  if (!journal.length) return null;

  const confirmees = pistes.filter(p => p.confirmee);
  const duree = journal[journal.length - 1].t - journal[0].t;

  const durees = confirmees.map(p => ({
    id: p.id,
    debut: p.firstSeen,
    fin: p.lastSeen,
    duree: Number((p.lastSeen - p.firstSeen).toFixed(3)),
    hits: p.hits,
    pertes: p.losses,
    sauvetages: p.rescued,
    reprises: p.recovered,
    reactivations: p.reactivated,
    doublonsAbsorbes: p.doublonsAbsorbes,
    pasOcclus: p.occludedFor || 0,
    raisonCreation: p.raisonCreation,
    raisonSuppression: p.raisonSuppression,
    etatFinal: p.state,
  })).sort((a, b) => b.duree - a.duree);

  const mediane = (arr) => {
    if (!arr.length) return null;
    const t = [...arr].sort((a, b) => a - b);
    const i = Math.floor(t.length / 2);
    return Number((t.length % 2 ? t[i] : (t[i - 1] + t[i]) / 2).toFixed(3));
  };

  const parInstant = journal.map(j => ({
    t: j.t,
    suivies: j.tracks.filter(x => x.confirmee).length,
    detectees: j.counts.detected,
    occluses: j.counts.occluded,
    predites: j.counts.predicted,
    tentatives: j.counts.tentative,
  }));

  const instantV1 = tV1 == null ? null
    : journal.reduce((best, j) => (Math.abs(j.t - tV1) < Math.abs(best.t - tV1) ? j : best), journal[0]);

  const longues = durees.filter(d => d.duree >= duree * 0.7);
  const compter = (champ) => pistes.reduce((acc, p) => {
    const v = p[champ];
    if (!v) return acc;
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {});

  return {
    instants: journal.length,
    duree: Number(duree.toFixed(3)),
    // ── fragmentation ───────────────────────────────────────────────────
    pistesCreees: pistes.length,
    pistesConfirmeesCreees: confirmees.length,
    pistesJamaisConfirmees: pistes.length - confirmees.length,
    dureeMedianePistes: mediane(durees.map(d => d.duree)),
    nouvellesPistesParSeconde: duree > 0 ? Number((confirmees.length / duree).toFixed(2)) : null,
    suppressions: pistes.filter(p => p.raisonSuppression).length,
    reactivations: pistes.reduce((t, p) => t + p.reactivated, 0),
    doublonsEcartes: suivi.doublonsEcartes,
    raisons: { creation: compter('raisonCreation'), suppression: compter('raisonSuppression') },
    // ── dérive de taille ────────────────────────────────────────────────
    // Amplitude de la boîte PUBLIÉE sur la vie d'une piste. Une voiture qui
    // s'approche grossit d'un facteur 1,4 en moyenne sur cette séquence ; au
    // delà de quelques unités, ce n'est plus la voiture, c'est la prédiction.
    // C'est la mesure qui juge le plafonnement de la vitesse de taille.
    deriveTaille: (() => {
      const amplitudes = confirmees.map(p => {
        const l = p.history.map(h => h.box[2] - h.box[0]).filter(v => v > 0);
        const h = p.history.map(x => x.box[3] - x.box[1]).filter(v => v > 0);
        if (l.length < 2 || h.length < 2) return null;
        return Math.max(Math.max(...l) / Math.min(...l), Math.max(...h) / Math.min(...h));
      }).filter(v => v != null);
      if (!amplitudes.length) return null;
      const tri = [...amplitudes].sort((a, b) => a - b);
      const p = (q) => Number(tri[Math.min(tri.length - 1, Math.floor((tri.length - 1) * q))].toFixed(2));
      return {
        pistes: amplitudes.length, median: p(0.5), p90: p(0.9), max: p(1),
        // Combien de fois les deux gardes ont réellement servi.
        vitesseBornee: pistes.reduce((t, x) => t + (x.pred?.vitesseBornee || 0), 0),
        residusEcretes: pistes.reduce((t, x) => t + (x.pred?.residusEcretes || 0), 0),
      };
    })(),
    // Effet mesuré de la compensation de caméra.
    camera: (() => {
      const r = suivi.residus;
      if (!r.length) return null;
      const med = (f) => mediane(r.map(f).filter(v => v != null));
      const avant = med(x => x.avant), apres = med(x => x.apres);
      return {
        modele: suivi.opt.modeleCamera,
        modeleApplique: r[r.length - 1]?.modele ?? null,
        residuMedianAvant: avant,
        residuMedianApres: apres,
        gain: avant != null && apres != null && avant > 0
          ? Number((1 - apres / avant).toFixed(3)) : null,
        comparaison: suivi.comparaisonCamera,
        // Le même arbitrage, agrégé sur TOUS les pas. Le champ `comparaison`
        // ci-dessus ne décrit que le dernier, où il ne reste souvent qu'une
        // paire : lu seul, il faisait croire qu'aucun modèle n'était applicable.
        comparaisonAgregee: (() => {
          const c = suivi.comparaisonsCamera || [];
          if (!c.length) return null;
          const ids = Object.keys(c[0].erreurs || {});
          const retenus = {};
          for (const x of c) retenus[x.recommande] = (retenus[x.recommande] || 0) + 1;
          return {
            pas: c.length,
            pairesMedianes: mediane(c.map(x => x.n)),
            retenusParInstant: retenus,
            erreurLaisseeDeCoteMediane: Object.fromEntries(ids.map(id => [
              id, mediane(c.map(x => x.erreurs[id]).filter(v => v != null)),
            ])),
            applicableParInstant: Object.fromEntries(ids.map(id => [
              id, c.filter(x => x.erreurs[id] != null).length,
            ])),
          };
        })(),
        parInstant: r,
      };
    })(),
    // ── identités logiques ──────────────────────────────────────────────
    //
    // « Cinq pistes actives au V1 » ne dit rien : ce sont peut-être cinq
    // identités nées après la coupure. La question posée est combien des
    // identités du DÉPART y arrivent, par une chaîne ininterrompue et non
    // bifurquée. Sans réattribution, chaque piste est sa propre racine, et ce
    // chiffre mesure exactement ce que coûte la coupure.
    identites: (() => {
      const t0 = journal[0].t;
      const racine = (p) => p.identiteLogique;
      const depart = [...new Set(pistes.filter(p => p.firstSeen === t0).map(racine))];
      const auV1Instant = instantV1;
      const presentesV1 = auV1Instant
        ? [...new Set(auV1Instant.tracks.filter(x => x.confirmee).map(x => x.identiteLogique ?? x.id))]
        : [];
      const survivantes = depart.filter(r => presentesV1.includes(r));

      // Bifurcation : deux pistes VIVANTES au même instant sous la même racine.
      // Sans réattribution c'est impossible ; avec, ce serait une erreur grave,
      // et le compteur existe pour qu'elle ne passe pas inaperçue.
      let bifurquees = 0;
      for (const inst of journal) {
        const vues = new Map();
        for (const x of inst.tracks) {
          const r = x.identiteLogique ?? x.id;
          vues.set(r, (vues.get(r) || 0) + 1);
        }
        bifurquees += [...vues.values()].filter(n => n > 1).length;
      }

      return {
        total: new Set(pistes.map(racine)).size,
        auDepart: depart.length,
        idsDepart: depart,
        auV1: presentesV1.length,
        idsV1: presentesV1,
        // LE chiffre de l'objectif.
        survivantesDepart: survivantes.length,
        idsSurvivantes: survivantes,
        instantsBifurques: bifurquees,
        coupures: suivi.coupures.map(c => ({ t: c.t, suspendues: c.suspendues.length })),
        // Ce que la coupure a coûté : les identités vivantes juste avant, dont
        // aucune ne traverse tant qu'il n'y a pas de réattribution.
        suspenduesTotal: suivi.coupures.reduce((t, c) => t + c.suspendues.length, 0),
        reattribuees: pistes.filter(p => p.ancetre != null).length,
      };
    })(),
    // ── ruptures de plan, cohérence spatiale ────────────────────────────
    ruptures: (() => {
      const r = detecterRuptures(journal, { refus: suivi.refus });
      return {
        cuts: r.cuts.map(c => ({ t: c.t, debut: c.debut, fin: c.fin, score: c.score, instants: c.instants })),
        parInstant: r.parInstant.filter(x => x.score >= 0.4),
        ventilation: ventilerAutourDesRuptures(journal, suivi.refus, r.cuts),
      };
    })(),
    coherenceSpatiale: coherenceSpatiale(journal),
    // Ventilation des associations refusées : la cause dominante se lit ici.
    refus: (() => {
      const parRaison = {}, parCote = { piste: 0, detection: 0 };
      const valeurs = { iou: [], ratio: [], distance: [] };
      for (const r of suivi.refus) {
        parRaison[r.raison] = (parRaison[r.raison] || 0) + 1;
        if (parCote[r.cote] != null) parCote[r.cote] += 1;
        for (const k of ['iou', 'ratio', 'distance']) if (r[k] != null) valeurs[k].push(r[k]);
      }
      const med = (a) => (a.length ? mediane(a) : null);
      const dominante = Object.entries(parRaison).sort((a, b) => b[1] - a[1])[0];
      return {
        total: suivi.refus.length,
        parRaison, parCote,
        dominante: dominante ? { raison: dominante[0], nombre: dominante[1] } : null,
        medianes: { iou: med(valeurs.iou), ratio: med(valeurs.ratio), distance: med(valeurs.distance) },
        parInstant: duree > 0 ? Number((suivi.refus.length / journal.length).toFixed(2)) : null,
      };
    })(),
    // ── suivi ───────────────────────────────────────────────────────────
    pistesLongues: longues.length,
    cible,
    pistesLonguesAtteintCible: longues.length >= cible,
    suiviesMin: Math.min(...parInstant.map(p => p.suivies)),
    suiviesMax: Math.max(...parInstant.map(p => p.suivies)),
    suiviesMoyenne: Number((parInstant.reduce((t, p) => t + p.suivies, 0) / parInstant.length).toFixed(2)),
    pertesTemporaires: pistes.reduce((t, p) => t + p.losses, 0),
    sauvetagesBandeBasse: pistes.reduce((t, p) => t + p.rescued, 0),
    reprisesApresOcclusion: pistes.reduce((t, p) => t + p.recovered, 0),
    auV1: instantV1 ? {
      t: instantV1.t,
      suivies: instantV1.tracks.filter(x => x.confirmee).length,
      detectees: instantV1.counts.detected,
      occluses: instantV1.counts.occluded,
      ids: instantV1.tracks.filter(x => x.confirmee).map(x => x.id),
    } : null,
    durees,
    parInstant,
  };
}

/**
 * Signale les instants à REGARDER — jamais les erreurs, qu'aucun calcul ne
 * peut établir sans vérité terrain. Ces signaux réduisent la relecture de
 * 43 instants à quelques-uns.
 *
 * Ce qu'on ne cherche PAS : un « saut » de position. La porte d'IoU de
 * l'association interdit déjà à une piste de bondir de plus des deux tiers de
 * sa largeur en un pas — un détecteur de saut ne se déclencherait jamais.
 * Les vraies signatures d'un échange d'identité sont ailleurs :
 *
 *   · `echange` — deux pistes inversent leur ordre horizontal. Ce peut être un
 *     vrai dépassement, et c'est justement ce qu'il faut regarder au V1 ;
 *   · `relais`  — une piste s'éteint et une nouvelle naît au même endroit :
 *     c'est presque toujours la même voiture qui a changé d'identifiant ;
 *   · `taille`  — la boîte change brutalement de gabarit sur deux détections ;
 *   · `reprise` — retour d'occlusion, donc ré-association non vérifiée ;
 *   · `ambigu`  — le deuxième meilleur choix d'association valait presque le
 *     premier : le tracker a tranché, sans grande conviction.
 */
export function signauxSuspects(suivi, { ratioTaille = 1.6, ecartMin = 10 } = {}) {
  const signaux = [];
  const j = suivi.journal;

  for (const p of suivi.pistes) {
    for (let i = 1; i < p.history.length; i++) {
      const a = p.history[i - 1], b = p.history[i];
      if (a.state === ETATS.DETECTED && b.state === ETATS.DETECTED
        && rapportTaille(a.box, b.box) > ratioTaille) {
        signaux.push({ type: 'taille', id: p.id, t: b.t, valeur: Number(rapportTaille(a.box, b.box).toFixed(2)) });
      }
      if (a.state === ETATS.OCCLUDED && b.state === ETATS.DETECTED) {
        signaux.push({ type: 'reprise', id: p.id, t: b.t, valeur: null });
      }
    }
  }

  // Inversion d'ordre horizontal, suivie sur toute la séquence.
  //
  // Comparer deux instants consécutifs ne suffit pas : au moment exact du
  // croisement les deux boîtes sont côte à côte, l'écart passe par zéro et
  // aucun produit de signes ne change. On suit donc le signe DÉCIDÉ — celui
  // des instants où l'écart dépasse `ecartMin` — et on signale quand il
  // s'inverse, quel que soit le temps passé au coude à coude.
  const positions = new Map();
  for (const inst of j) {
    for (const t of inst.tracks) {
      if (!positions.has(t.id)) positions.set(t.id, new Map());
      positions.get(t.id).set(inst.t, centre(t.box)[0]);
    }
  }
  const ids = [...positions.keys()];
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const pa = positions.get(ids[a]), pb = positions.get(ids[b]);
      let signe = 0;
      for (const inst of j) {
        if (!pa.has(inst.t) || !pb.has(inst.t)) continue;
        const d = pa.get(inst.t) - pb.get(inst.t);
        if (Math.abs(d) <= ecartMin) continue;
        const nouveau = Math.sign(d);
        if (signe !== 0 && nouveau !== signe) {
          signaux.push({ type: 'echange', id: ids[a], autre: ids[b], t: inst.t, valeur: null });
        }
        signe = nouveau;
      }
    }
  }

  for (const inst of j) {
    for (const t of inst.tracks) {
      if (t.ambiguous && t.state === ETATS.DETECTED) {
        signaux.push({ type: 'ambigu', id: t.id, t: inst.t, valeur: null });
      }
    }
  }

  // Relais : une piste s'éteint, une autre naît aussitôt au même endroit.
  const eteintes = suivi.pistes.filter(p => p.state === ETATS.LOST || p.history.at(-1)?.state === ETATS.LOST);
  for (const morte of eteintes) {
    const fin = morte.history.at(-1);
    for (const neuve of suivi.pistes) {
      if (neuve.id === morte.id || neuve.firstSeen < fin.t) continue;
      if (neuve.firstSeen - fin.t > 3 * (suivi.opt.dt || 0.25)) continue;
      if (iou(fin.box, neuve.history[0].box) > 0.1) {
        signaux.push({ type: 'relais', id: morte.id, autre: neuve.id, t: neuve.firstSeen, valeur: null });
      }
    }
  }

  return signaux.sort((a, b) => a.t - b.t);
}

/**
 * Compare deux exécutions à des fréquences différentes.
 *
 * Sans vérité terrain, c'est le seul signal OBJECTIF disponible : si le même
 * enchaînement analysé à 4 Hz et à 10 Hz ne produit pas les mêmes
 * trajectoires, au moins l'une des deux se trompe. La concordance ne prouve
 * pas la justesse, mais la discordance prouve l'erreur.
 */
export function concorder(mesureA, mesureB, { tolerance = 0.15 } = {}) {
  if (!mesureA || !mesureB) return null;
  const ecart = (a, b) => (a === 0 && b === 0 ? 0 : Math.abs(a - b) / Math.max(1, Math.max(a, b)));
  const dLongues = ecart(mesureA.pistesLongues, mesureB.pistesLongues);
  const dV1 = mesureA.auV1 && mesureB.auV1 ? ecart(mesureA.auV1.suivies, mesureB.auV1.suivies) : null;
  return {
    pistesLongues: [mesureA.pistesLongues, mesureB.pistesLongues],
    suiviesAuV1: mesureA.auV1 && mesureB.auV1 ? [mesureA.auV1.suivies, mesureB.auV1.suivies] : null,
    concordant: dLongues <= tolerance && (dV1 == null || dV1 <= tolerance),
  };
}
