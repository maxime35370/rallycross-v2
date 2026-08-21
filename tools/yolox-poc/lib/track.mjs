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

/** États d'une piste, du plus sûr au moins sûr. */
export const ETATS = {
  TENTATIVE: 'tentative',   // vue une fois, pas encore confirmée
  DETECTED: 'detected',     // associée à une détection à cet instant
  PREDICTED: 'predicted',   // non détectée, position extrapolée
  OCCLUDED: 'occluded',     // masquée par une autre piste identifiée
  LOST: 'lost',             // abandonnée
};

export const DEFAULTS = {
  dt: 0.25,                 // pas d'échantillonnage, en secondes
  highScore: 0.30,          // seuil de détection — identique au banc
  lowScore: 0.10,           // plancher de la bande basse (sauvetage seulement)
  iouMatch: 0.20,           // porte d'association, premier temps
  iouMatchLow: 0.15,        // porte d'association, second temps
  iouRecover: 0.10,         // porte élargie pour récupérer une piste occluse
  maxSizeRatio: 2.0,        // rapport de taille au-delà duquel on refuse
  maxAge: 3,                // pas sans détection avant abandon
  maxOccludedAge: 8,        // idem, mais pour une piste explicitement occluse
  minHits: 2,               // détections avant confirmation
  mergeAreaRatio: 1.25,     // boîte « anormalement grande » = fusion probable
  ambiguityMargin: 0.08,    // écart de coût en dessous duquel un choix est douteux
  cameraCompensation: true,
  gainBiais: 0.5,           // amortit la correction de biais, pour ne pas osciller
  gainFusion: 0.5,          // recalage d'un groupe occlus sur le bloc qui l'avale
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
  constructor(box, { alpha = 0.7, beta = 0.35 } = {}) {
    const [cx, cy] = centre(box);
    const [w, h] = taille(box);
    this.s = { cx, cy, w, h, vx: 0, vy: 0, vw: 0, vh: 0 };
    this.alpha = alpha;
    this.beta = beta;
  }

  /** Position attendue après `dt`, sans consommer de mesure. */
  predire(dt) {
    const s = this.s;
    return boiteDepuis(s.cx + s.vx * dt, s.cy + s.vy * dt,
      Math.max(1, s.w + s.vw * dt), Math.max(1, s.h + s.vh * dt));
  }

  /** Avance l'état d'un pas sans mesure : la vitesse s'amortit, faute de quoi
   *  une piste perdue partirait à l'infini en ligne droite. */
  avancerSansMesure(dt, amortissement = 0.7) {
    const s = this.s;
    s.cx += s.vx * dt; s.cy += s.vy * dt;
    s.w = Math.max(1, s.w + s.vw * dt); s.h = Math.max(1, s.h + s.vh * dt);
    s.vx *= amortissement; s.vy *= amortissement;
    s.vw *= amortissement; s.vh *= amortissement;
  }

  /** Intègre une mesure. */
  corriger(box, dt) {
    const s = this.s;
    const [mx, my] = centre(box);
    const [mw, mh] = taille(box);
    const px = s.cx + s.vx * dt, py = s.cy + s.vy * dt;
    const pw = s.w + s.vw * dt, ph = s.h + s.vh * dt;
    const rx = mx - px, ry = my - py, rw = mw - pw, rh = mh - ph;

    s.cx = px + this.alpha * rx; s.cy = py + this.alpha * ry;
    s.w = Math.max(1, pw + this.alpha * rw); s.h = Math.max(1, ph + this.alpha * rh);
    if (dt > 0) {
      s.vx += (this.beta * rx) / dt; s.vy += (this.beta * ry) / dt;
      s.vw += (this.beta * rw) / dt; s.vh += (this.beta * rh) / dt;
    }
  }

  get boite() { return boiteDepuis(this.s.cx, this.s.cy, this.s.w, this.s.h); }
  get vitesse() { return [this.s.vx, this.s.vy]; }

  /** Applique un décalage global — la caméra a bougé, pas la voiture. */
  decaler(dx, dy) { this.s.cx += dx; this.s.cy += dy; }
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
  const largeur = Math.max(10, taille(boitesA[0])[0] * 0.5);
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
    this.perdues = [];
    this.derniereCamera = { dx: 0, dy: 0, n: 0 };
    this.dernierRattrapage = null;
    this.journal = [];
    reinitialiserIds();
  }

  /** Pistes vivantes, c'est-à-dire ni abandonnées ni encore à confirmer. */
  get actives() {
    return this.pistes.filter(p => p.state !== ETATS.LOST);
  }

  /**
   * Un pas d'analyse.
   *
   * @param {number} t — instant, en secondes dans l'extrait
   * @param {Array<{box:number[], score:number, label?:string}>} detections
   *        TOUTES les détections au-dessus de `lowScore`, bande basse comprise.
   * @returns {object} instantané de l'état, tel qu'il sera affiché et mesuré
   */
  pas(t, detections) {
    const o = this.opt;
    const dt = this.journal.length ? t - this.journal[this.journal.length - 1].t : o.dt;

    const fortes = detections.filter(d => d.score >= o.highScore);
    const faibles = detections.filter(d => d.score < o.highScore && d.score >= o.lowScore);

    // 1 · prédiction, décalée du biais observé au pas précédent
    //
    // Le biais est appliqué à la BOÎTE utilisée pour l'association, jamais à
    // l'état du prédicteur. Le muter reviendrait à compter deux fois le même
    // mouvement — la vitesse apprise par le filtre l'absorbe déjà — et faisait
    // osciller la correction (mesuré : +33 px là où on attendait −90).
    const biais = (o.cameraCompensation && this.derniereCamera.n >= 3)
      ? { dx: this.derniereCamera.dx * o.gainBiais, dy: this.derniereCamera.dy * o.gainBiais }
      : { dx: 0, dy: 0 };
    for (const p of this.pistes) {
      const b = p.pred.predire(dt);
      p.boitePredite = [b[0] + biais.dx, b[1] + biais.dy, b[2] + biais.dx, b[3] + biais.dy];
    }

    const candidates = this.pistes.filter(p => p.state !== ETATS.LOST);

    // 2 · boîtes FUSIONNÉES — repérées AVANT toute association
    //
    // Une détection anormalement large qui recouvre plusieurs pistes ne décrit
    // aucune des deux voitures : la donner à l'une corromprait sa taille (elle
    // hériterait des 230 px de la boîte commune) et supprimerait l'autre.
    // On l'écarte donc du jeu et on garde TOUTES les pistes concernées en
    // occlusion, simplement recalées sur le centre du bloc.
    const fusions = this._reperersFusions(candidates, fortes);
    const utilisables = fortes.filter((_, i) => !fusions.has(i));

    // 3 · premier temps — détections fortes
    let assoc = this._associer(candidates, utilisables, o.iouMatch);

    // 3 bis · rattrapage d'un déplacement en bloc
    //
    // Le piège n'est pas l'absence d'association, c'est l'association PLAUSIBLE
    // ET FAUSSE. Mesuré : sur un balayage de 90 px par pas avec des voitures
    // espacées de 150, chaque piste recouvre mieux la voisine que sa propre
    // voiture — quatre appariements sur cinq, tous décalés d'un cran, et pas
    // le moindre signe d'échec. On tente donc TOUJOURS l'estimation en bloc, et
    // on ne l'adopte que si elle apparie davantage, ou aussi bien mais mieux.
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
        const mieux = bis.paires.length > assoc.paires.length
          || (bis.paires.length === assoc.paires.length && bis.coutTotal < assoc.coutTotal - 1e-6);
        if (mieux) { assoc = bis; this.dernierRattrapage = d; }
        else bouger(-1);
      }
    }
    const { paires, lignesLibres, colonnesLibres, ambigus } = assoc;

    const appariees = [];
    for (const [iPiste, iDet] of paires) {
      const piste = candidates[iPiste];
      const det = utilisables[iDet];
      appariees.push({ avant: piste.boitePredite, apres: det.box });
      this._confirmer(piste, t, det, ambigus.has(iPiste));
    }

    // 3 · second temps — détections faibles, contre les pistes orphelines
    //     Elles SAUVENT une piste, elles n'en créent jamais.
    const orphelines = lignesLibres.map(i => candidates[i]);
    const r2 = this._associer(orphelines, faibles, o.iouMatchLow);
    const encoreOrphelines = new Set(r2.lignesLibres.map(i => orphelines[i]));
    for (const [iPiste, iDet] of r2.paires) {
      const piste = orphelines[iPiste];
      this._confirmer(piste, t, faibles[iDet], true);   // sauvetage = jamais certain
      piste.rescued += 1;
    }

    // 5 · pistes toujours sans détection : occluses ou simplement prédites
    for (const piste of orphelines) {
      if (!encoreOrphelines.has(piste)) continue;
      const occulteur = piste._fusionAvec ?? this._chercherOccluseur(piste, utilisables, paires, candidates);
      this._sansMesure(piste, t, dt, occulteur);
      piste._fusionAvec = null;
    }

    // 6 · détections fortes non utilisées : reprise d'une occluse, sinon création
    for (const iDet of colonnesLibres) {
      const det = utilisables[iDet];
      const reprise = this._reprendreOccluse(det);
      if (reprise) { this._confirmer(reprise, t, det, true); reprise.recovered += 1; continue; }
      this._creer(t, det);
    }

    // 7 · biais observé, pour le pas suivant
    this.derniereCamera = o.cameraCompensation
      ? decalageCamera(appariees)
      : { dx: 0, dy: 0, n: 0 };

    const instant = this._instantane(t, detections.length, fortes.length, faibles.length, fusions.size);
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
      const recouvrement = iou(p.boitePredite, d.box);
      if (recouvrement < porte) return INTERDIT;
      if (rapportTaille(p.boitePredite, d.box) > o.maxSizeRatio) return INTERDIT;
      return 1 - recouvrement;
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
      // Deuxième meilleur choix presque aussi bon : le choix est fragile,
      // c'est exactement là que naissent les échanges d'identité.
      const tries = [...cout[i]].filter(c => c < INTERDIT).sort((a, b) => a - b);
      if (tries.length > 1 && tries[1] - tries[0] < o.ambiguityMargin) ambigus.add(i);
    });
    return {
      paires, ambigus, coutTotal,
      lignesLibres: pistes.map((_, i) => i).filter(i => !paires.some(([a]) => a === i)),
      colonnesLibres: dets.map((_, j) => j).filter(j => !prises.has(j)),
    };
  }

  // ── transitions ────────────────────────────────────────
  _confirmer(piste, t, det, incertain) {
    const dt = piste.lastSeen == null ? this.opt.dt : t - piste.lastSeen;
    piste.pred.corriger(det.box, Math.max(1e-3, dt));
    piste.box = det.box.slice();
    piste.score = det.score;
    piste.label = det.label || piste.label;
    piste.hits += 1;
    piste.misses = 0;
    piste.lastSeen = t;
    piste.occludedBy = null;
    piste.ambiguous = !!incertain;
    piste.state = piste.hits >= this.opt.minHits ? ETATS.DETECTED : ETATS.TENTATIVE;
    piste.history.push({ t, box: piste.box.slice(), state: piste.state, score: det.score });
  }

  _sansMesure(piste, t, dt, occulteur) {
    piste.pred.avancerSansMesure(dt);
    piste.box = piste.pred.boite;
    piste.misses += 1;
    piste.ambiguous = true;
    if (occulteur != null) {
      piste.occludedBy = occulteur;
      piste.state = ETATS.OCCLUDED;
      piste.occludedFor = (piste.occludedFor || 0) + 1;
    } else {
      piste.occludedBy = null;
      piste.state = ETATS.PREDICTED;
    }
    const limite = piste.state === ETATS.OCCLUDED ? this.opt.maxOccludedAge : this.opt.maxAge;
    if (piste.misses > limite) piste.state = ETATS.LOST;
    if (piste.misses === 1) piste.losses += 1;
    piste.history.push({ t, box: piste.box.slice(), state: piste.state, score: null });
  }

  _creer(t, det) {
    const piste = {
      id: _prochainId++,
      pred: new Predicteur(det.box),
      box: det.box.slice(),
      boitePredite: det.box.slice(),
      score: det.score,
      label: det.label || null,
      state: ETATS.TENTATIVE,
      hits: 1, misses: 0, losses: 0, rescued: 0, recovered: 0, occludedFor: 0,
      firstSeen: t, lastSeen: t,
      occludedBy: null, ambiguous: false,
      history: [{ t, box: det.box.slice(), state: ETATS.TENTATIVE, score: det.score }],
    };
    this.pistes.push(piste);
    return piste;
  }

  /**
   * Repère les détections qui avalent plusieurs pistes à la fois.
   *
   * Deux conditions cumulées, pour ne pas confondre une fusion avec une simple
   * proximité : la détection recouvre au moins DEUX pistes prédites, et son
   * aire dépasse nettement celle attendue pour une seule voiture.
   *
   * Les pistes concernées sont recalées sur le centre du bloc — sans toucher à
   * leur taille — puis laissées en occlusion. C'est le cas `milieu_v1`.
   *
   * @returns {Set<number>} indices des détections écartées de l'association
   */
  _reperersFusions(candidates, fortes) {
    const o = this.opt;
    const fusions = new Set();
    fortes.forEach((det, i) => {
      const touchees = candidates.filter(p =>
        p.state !== ETATS.TENTATIVE && iou(p.boitePredite, det.box) > o.iouRecover);
      if (touchees.length < 2) return;
      const aires = touchees.map(p => aire(p.boitePredite)).sort((a, b) => a - b);
      const mediane = aires[Math.floor(aires.length / 2)];
      if (!mediane || aire(det.box) / mediane < o.mergeAreaRatio) return;

      fusions.add(i);
      // Recalage du groupe sur le bloc, sans prétendre savoir qui est où.
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

  /**
   * Cherche qui masque une piste orpheline.
   *
   * Signature d'une boîte FUSIONNÉE : une détection déjà attribuée à une autre
   * piste, qui recouvre aussi celle-ci, et dont l'aire dépasse nettement celle
   * attendue pour une seule voiture. C'est le cas observé sur `milieu_v1`.
   * On garde alors les DEUX pistes — l'une détectée, l'autre occluse — au lieu
   * de transformer deux voitures en une.
   */
  _chercherOccluseur(piste, fortes, paires, candidates) {
    for (const [iPiste, iDet] of paires) {
      const det = fortes[iDet];
      if (iou(piste.boitePredite, det.box) < this.opt.iouRecover) continue;
      const autre = candidates[iPiste];
      const attendu = aire(autre.boitePredite);
      if (attendu > 0 && aire(det.box) / attendu >= this.opt.mergeAreaRatio) return autre.id;
      // Recouvrement franc sans excès de taille : masquage simple.
      if (iou(piste.boitePredite, det.box) > 0.35) return autre.id;
    }
    return null;
  }

  /** Une détection libre correspond-elle à une piste occluse qui ressort ? */
  _reprendreOccluse(det) {
    let meilleure = null, meilleurIou = this.opt.iouRecover;
    for (const p of this.pistes) {
      if (p.state !== ETATS.OCCLUDED && p.state !== ETATS.PREDICTED) continue;
      const r = iou(p.boitePredite, det.box);
      if (r > meilleurIou && rapportTaille(p.boitePredite, det.box) <= this.opt.maxSizeRatio) {
        meilleurIou = r; meilleure = p;
      }
    }
    return meilleure;
  }

  _instantane(t, nbTotal, nbFortes, nbFaibles, nbFusions = 0) {
    const vivantes = this.pistes.filter(p => p.state !== ETATS.LOST);
    return {
      t: Number(t.toFixed(3)),
      detections: { total: nbTotal, fortes: nbFortes, faibles: nbFaibles, fusions: nbFusions },
      biais: { ...this.derniereCamera },
      tracks: vivantes.map(p => ({
        id: p.id,
        box: p.box.map(v => Math.round(v)),
        state: p.state,
        score: p.score,
        ambiguous: p.ambiguous,
        occludedBy: p.occludedBy,
        misses: p.misses,
        // Trajectoire récente : cinq derniers centres, pour l'affichage.
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
 * Mesures tirées du journal et des pistes.
 *
 * Aucune ne prétend dire si un `trackId` désigne toujours la MÊME voiture :
 * cela demande une vérité terrain, et c'est l'humain qui la fournit
 * (voir `signauxSuspects()` pour l'aide au repérage).
 */
export function mesurer(suivi, { cible = 5, tV1 = null } = {}) {
  const journal = suivi.journal;
  const pistes = suivi.pistes;
  if (!journal.length) return null;

  const durees = pistes.map(p => ({
    id: p.id,
    debut: p.firstSeen,
    fin: p.lastSeen,
    duree: Number((p.lastSeen - p.firstSeen).toFixed(3)),
    hits: p.hits,
    pertes: p.losses,
    sauvetages: p.rescued,
    reprises: p.recovered,
    pasOcclus: p.occludedFor || 0,
    etatFinal: p.state,
  })).sort((a, b) => b.duree - a.duree);

  const parInstant = journal.map(j => ({
    t: j.t,
    suivies: j.tracks.filter(x => x.state !== ETATS.TENTATIVE).length,
    detectees: j.counts.detected,
    occluses: j.counts.occluded,
    predites: j.counts.predicted,
  }));

  const instantV1 = tV1 == null ? null
    : journal.reduce((best, j) => (Math.abs(j.t - tV1) < Math.abs(best.t - tV1) ? j : best), journal[0]);

  const longues = durees.filter(d => d.duree >= (journal[journal.length - 1].t - journal[0].t) * 0.7);

  return {
    instants: journal.length,
    duree: Number((journal[journal.length - 1].t - journal[0].t).toFixed(3)),
    pistesCreees: pistes.length,
    // Une piste qui couvre au moins 70 % de la séquence : le candidat naturel
    // pour « une voiture suivie du départ au V1 ».
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
      suivies: instantV1.tracks.filter(x => x.state !== ETATS.TENTATIVE).length,
      detectees: instantV1.counts.detected,
      occluses: instantV1.counts.occluded,
      ids: instantV1.tracks.filter(x => x.state !== ETATS.TENTATIVE).map(x => x.id),
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
