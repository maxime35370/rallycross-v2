/* ═══════════════════════════════════════════════
   REATTRIBUTION.MJS — Recoller les identités de part et d'autre d'une coupure

   Module PUR : il ne connaît ni pixels, ni DOM, ni tracker. Il reçoit deux
   groupes de points (les voitures juste avant la coupure, les voitures juste
   après) et rend un appariement — ou un refus.

   ── Le principe ────────────────────────────────────────────────────────
   Une voiture prise isolément ne dit presque rien après un changement de
   caméra : l'apparence seule plafonne à 3 bonnes réponses sur 4, avec une
   marge relative de 1,25 %. Trop serré pour décider.

   Le GROUPE, lui, dit beaucoup. Cinq voitures sur une piste forment une
   configuration — un agencement de positions relatives — que le changement de
   point de vue déforme mais ne détruit pas. Deux caméras fixes regardant la
   même scène donnent, au premier ordre, deux images liées par une SIMILITUDE :
   une échelle, une rotation, une translation. Éventuellement composée d'une
   RÉFLEXION, parce que deux caméras placées de part et d'autre de la piste
   voient l'ordre de course s'inverser dans l'image.

   Mesuré sur Kerlabo : dans le plan A les voitures vont vers la gauche
   (vx de −165 à −310 px/s), dans le plan B vers la droite (+130 à +193 px/s),
   et la vérité annotée est A1→B8, A2→B7, A3→B6, A4→B4 — l'ordre en x est
   exactement retourné. Sans réflexion, aucune similitude ne peut expliquer ça.

   ── Pourquoi une similitude et pas une homographie ─────────────────────
   Une homographie décrirait mieux deux vues d'un plan, mais elle a huit
   paramètres et exige quatre correspondances. Avec quatre ou cinq voitures,
   elle passerait par n'importe quoi : elle expliquerait aussi bien la bonne
   réponse que les 23 mauvaises. La similitude a quatre paramètres et se
   détermine avec DEUX points ; ce qui reste après ces deux points est une
   vérification, pas un ajustement. C'est cette rigidité qu'on cherche.

   ── Ce qui décide, dans l'ordre ────────────────────────────────────────
   1. le SENS DE MARCHE, en test de signe : une hypothèse qui envoie la
      direction du plan A dans le demi-plan opposé à celle du plan B est
      écartée, sans réglage ni pondération ;
   2. le COÛT géométrique, minimisé par affectation hongroise — l'unicité est
      donc globale, jamais « chacun son plus proche » ;
   3. la MARGE entre la meilleure hypothèse et la meilleure hypothèse
      d'affectation DIFFÉRENTE ; large, on accepte tout ;
   4. serrée, l'APPARENCE départage — en second seulement, jamais seule ;
   5. si l'apparence ne tranche pas non plus, on ne garde que les paires
      COMMUNES aux deux hypothèses. Trois justes et deux non décidées valent
      mieux que cinq dont deux fausses.
═══════════════════════════════════════════════ */

import { hungarian } from './track.mjs';
import { distanceMemoire, moyenner, tailler } from './apparence.mjs';

/** Identifiant de méthode. À vérifier dans tout rapport avant d'en conclure. */
export const METHODE_REATTRIBUTION = 'similitude-groupe/1';

export const REGLAGES = {
  // Marge relative en dessous de laquelle la géométrie ne tranche pas SEULE.
  // Ce n'est pas une constante de la nature : c'est le point de bascule d'un
  // compromis. `balayer()` existe pour qu'il soit choisi sur plusieurs cuts
  // mesurés, et non posé à partir d'un seul.
  margeMin: 0.15,
  // Écart relatif d'apparence exigé pour départager deux hypothèses proches.
  margeApparenceMin: 0.05,
  // Configuration retenue par la mesure du 22/08 : 3 bandes, agrégation des
  // VECTEURS, deux observations. Elle donnait 3/4 avec l'écart normalisé le
  // plus faible (3,6 %).
  observationsApparence: 2,
  agregationApparence: 'moyenne',
  // Poids du désaccord de TAILLE dans le coût d'une paire.
  //
  // Les centres seuls ne suffisent pas : sur la coupure Kerlabo, le nuage est
  // presque aligné, et une réflexion y est presque indiscernable d'une
  // rotation d'un demi-tour. La bonne réponse n'arrivait qu'en 3ᵉ position,
  // derrière deux appariements décalés d'un rang.
  //
  // La similitude prédit aussi comment les BOÎTES changent de taille : son
  // échelle. Le désaccord |log(taille_B / (échelle · taille_A))| est donc une
  // information gratuite, déjà contenue dans l'hypothèse, et indépendante des
  // centres. Ajoutée au coût, elle fait passer la vérité au rang 1.
  //
  // Le poids est un choix — les deux termes n'ont pas la même unité (rayons
  // du groupe d'un côté, log d'un rapport de l'autre). 1 est le choix neutre ;
  // ce qui compte est que le résultat n'en dépende pas : mesuré sur Kerlabo,
  // la vérité est première pour tout poids de 0,5 à 2.
  poidsTaille: 1,
  // Deux points suffisent à poser une similitude ; en dessous il n'y a pas
  // de configuration, seulement un point.
  tailleGroupeMin: 2,
};

const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const norme = (v) => Math.hypot(v[0], v[1]);
/** Taille d'une boîte : sa diagonale. Une seule mesure, insensible au ratio. */
const taille = (b) => Math.hypot(b[2] - b[0], b[3] - b[1]);

/**
 * Décrit un groupe : positions, échelle propre, sens de marche.
 *
 * `rayon` est la dispersion RMS autour du centroïde. Il sert d'unité : sans
 * lui, un coût en pixels serait incomparable entre un plan large et un gros
 * plan, et la marge n'aurait aucun sens d'un cut à l'autre.
 *
 * @param {{id:number, box:number[], vitesse?:{vx:number,vy:number}, apparences?:object[]}[]} elements
 */
export function configuration(elements) {
  const points = elements.map(e => centre(e.box));
  const n = points.length;
  const centroide = n
    ? [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
    : [0, 0];
  const rayon = n
    ? Math.sqrt(points.reduce((s, p) => s + (p[0] - centroide[0]) ** 2 + (p[1] - centroide[1]) ** 2, 0) / n)
    : 0;

  // Sens de marche : somme des vitesses, normalisée. La SOMME et non la
  // moyenne des directions unitaires — une piste presque immobile, dont la
  // direction est du bruit, ne doit pas peser autant qu'une voiture lancée.
  let dx = 0, dy = 0;
  for (const e of elements) { dx += e.vitesse?.vx || 0; dy += e.vitesse?.vy || 0; }
  const l = Math.hypot(dx, dy);
  const direction = l > 1e-9 ? [dx / l, dy / l] : null;

  return {
    ids: elements.map(e => e.id), points, centroide, rayon, direction, elements,
    tailles: elements.map(e => taille(e.box)),
  };
}

/**
 * La similitude qui envoie a1→b1 et a2→b2.
 *
 * En complexes, une similitude directe s'écrit z ↦ m·z + t, et une similitude
 * indirecte (avec réflexion) z ↦ m·z̄ + t. Deux correspondances déterminent
 * m et t exactement — d'où l'énumération exhaustive des paires plus loin,
 * qui est un RANSAC complet plutôt qu'échantillonné : avec cinq voitures il y
 * a quelques centaines d'hypothèses, autant les essayer toutes.
 *
 * @returns {?{m:number[], t:number[], reflechie:boolean, echelle:number, angle:number}}
 */
export function similitude(a1, a2, b1, b2, reflechie = false) {
  // za = a2 − a1, éventuellement conjugué ; zb = b2 − b1.
  const ax = a2[0] - a1[0];
  const ay = reflechie ? -(a2[1] - a1[1]) : a2[1] - a1[1];
  const bx = b2[0] - b1[0], by = b2[1] - b1[1];
  const d = ax * ax + ay * ay;
  if (d < 1e-12) return null;                     // deux points confondus
  // m = zb / za
  const mr = (bx * ax + by * ay) / d;
  const mi = (by * ax - bx * ay) / d;
  if (!Number.isFinite(mr) || !Number.isFinite(mi)) return null;
  const echelle = Math.hypot(mr, mi);
  if (echelle < 1e-9) return null;
  // t = b1 − m·(a1 éventuellement conjugué)
  const px = a1[0], py = reflechie ? -a1[1] : a1[1];
  const t = [b1[0] - (mr * px - mi * py), b1[1] - (mi * px + mr * py)];
  return { m: [mr, mi], t, reflechie, echelle, angle: Math.atan2(mi, mr) };
}

/** Image d'un point par la similitude. */
export function appliquer(T, p) {
  const x = p[0], y = T.reflechie ? -p[1] : p[1];
  return [T.m[0] * x - T.m[1] * y + T.t[0], T.m[1] * x + T.m[0] * y + T.t[1]];
}

/** Image d'une DIRECTION : la partie linéaire seule, renormalisée. */
export function transformerDirection(T, d) {
  if (!d) return null;
  const x = d[0], y = T.reflechie ? -d[1] : d[1];
  const v = [T.m[0] * x - T.m[1] * y, T.m[1] * x + T.m[0] * y];
  const l = norme(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
}

/**
 * Affectation optimale entre T(A) et B, et son coût moyen.
 *
 * Le coût d'une paire est la distance résiduelle rapportée au rayon de B :
 * un nombre sans dimension, comparable d'un cut à l'autre. `cle` identifie
 * l'affectation elle-même — c'est par elle qu'on reconnaît deux hypothèses
 * géométriquement différentes qui aboutissent au MÊME appariement.
 */
export function coutAffectation(T, A, B, o = REGLAGES) {
  const echelle = B.rayon > 1e-9 ? B.rayon : 1;
  const w = o.poidsTaille ?? REGLAGES.poidsTaille;
  const dPos = [], dTaille = [];
  const cout = A.points.map((a, i) => {
    const ta = appliquer(T, a);
    dPos.push([]); dTaille.push([]);
    return B.points.map((b, j) => {
      const dp = Math.hypot(ta[0] - b[0], ta[1] - b[1]) / echelle;
      // Ce que la similitude PRÉDIT pour la taille, contre ce qu'on observe.
      // En log, pour qu'un doublement et une division par deux pèsent pareil.
      const attendue = T.echelle * A.tailles[i];
      const dt = attendue > 1e-9 && B.tailles[j] > 1e-9
        ? Math.abs(Math.log(B.tailles[j] / attendue)) : 0;
      dPos[i].push(dp); dTaille[i].push(dt);
      return dp + w * dt;
    });
  });
  const aff = hungarian(cout);
  const paires = [];
  for (let i = 0; i < aff.length; i++) {
    const j = aff[i];
    if (j >= 0) paires.push({ i, j, d: cout[i][j], dPos: dPos[i][j], dTaille: dTaille[i][j] });
  }
  const total = paires.length ? paires.reduce((s, p) => s + p.d, 0) / paires.length : Infinity;
  return {
    paires, cout: total,
    cle: paires.map(p => `${p.i}>${p.j}`).sort().join(','),
  };
}

/**
 * Coût d'apparence d'une affectation : distance moyenne entre la mémoire de
 * chaque piste de A et la signature moyenne de sa candidate dans B.
 *
 * Rend `null` dès qu'une paire n'a pas de quoi être jugée. Une moyenne
 * calculée sur la moitié des paires n'est pas comparable à une moyenne
 * calculée sur toutes — mieux vaut refuser de départager.
 */
export function coutApparence(paires, A, B, o = REGLAGES) {
  if (!paires.length) return null;
  const ds = [];
  for (const { i, j } of paires) {
    const memA = tailler(A.elements[i]?.apparences, { taille: o.observationsApparence });
    const memB = tailler(B.elements[j]?.apparences, { taille: o.observationsApparence });
    if (!memA.length || !memB.length) return null;
    const sigB = moyenner(memB.map(m => m.sig));
    const d = distanceMemoire(memA, sigB, o.agregationApparence);
    if (d == null) return null;
    ds.push(d);
  }
  return ds.reduce((s, d) => s + d, 0) / ds.length;
}

/**
 * Toutes les hypothèses de similitude, triées par coût croissant.
 *
 * Séparé de `decider()` pour que le balayage de seuils ne recalcule pas
 * l'énumération : la géométrie ne dépend d'aucun seuil, seule la décision en
 * dépend.
 */
export function hypotheses(A, B, options = {}) {
  const o = { ...REGLAGES, ...options };
  const nA = A.points.length, nB = B.points.length;
  const toutes = [];
  for (const reflechie of [false, true]) {
    for (let i = 0; i < nA; i++) for (let j = 0; j < nA; j++) {
      if (i === j) continue;
      for (let k = 0; k < nB; k++) for (let l = 0; l < nB; l++) {
        if (k === l) continue;
        const T = similitude(A.points[i], A.points[j], B.points[k], B.points[l], reflechie);
        if (!T) continue;
        const dirT = transformerDirection(T, A.direction);
        // Produit scalaire avec le sens de marche observé dans le plan B.
        // `null` quand l'un des deux groupes n'a pas de sens mesurable :
        // absence de contrôle, pas échec du contrôle.
        const sens = dirT && B.direction ? dirT[0] * B.direction[0] + dirT[1] * B.direction[1] : null;
        const r = coutAffectation(T, A, B, o);
        toutes.push({ ...r, T, reflechie, sens, appui: [i, j, k, l], echelle: T.echelle, angle: T.angle });
      }
    }
  }
  toutes.sort((x, y) => x.cout - y.cout);
  return toutes;
}

/**
 * Décide, à partir des hypothèses déjà calculées.
 *
 * @returns {{paires, decision, modele, meilleur, second, marge, margeRelative, ...}}
 */
export function decider(toutes, A, B, options = {}) {
  const o = { ...REGLAGES, ...options };
  const vide = (raison) => ({
    paires: [], decision: 'refus', raison, modele: null,
    meilleur: null, second: null, marge: null, margeRelative: null,
    ecarteesParSens: 0, apparence: null,
  });
  if (!toutes.length) return vide('aucune_hypothese');

  // 1 · le sens de marche, en test de SIGNE. Une hypothèse qui retourne le
  //     sens de la course ne décrit pas un changement de caméra, elle décrit
  //     une confusion tête/queue de peloton.
  const compatibles = toutes.filter(h => h.sens == null || h.sens > 0);
  const ecarteesParSens = toutes.length - compatibles.length;
  if (!compatibles.length) return { ...vide('sens_de_marche'), ecarteesParSens };

  const meilleur = compatibles[0];
  // Le second n'est pas la deuxième similitude : c'est la meilleure hypothèse
  // qui aboutit à un appariement DIFFÉRENT. Deux similitudes voisines qui
  // apparient pareil ne sont pas une ambiguïté.
  const second = compatibles.find(h => h.cle !== meilleur.cle) || null;

  const marge = second ? second.cout - meilleur.cout : null;
  const margeRelative = second && second.cout > 1e-12 ? marge / second.cout : null;

  /**
   * Paires communes à TOUTES les affectations que la marge ne sépare pas du
   * meilleur — pas seulement au meilleur et au second.
   *
   * Mesuré : à 4 Hz sur Kerlabo, le consensus à deux hypothèses retenait une
   * paire fausse. Elle était stable entre le meilleur et le second parce que
   * ces deux-là partageaient un point d'appui, pas parce qu'elle était sûre.
   * Une troisième hypothèse aussi bonne la contredisait. Exiger l'unanimité
   * sur toute la zone d'indécision est la seule lecture honnête de « cette
   * paire ne dépend pas du choix ».
   */
  const commun = () => {
    if (!second) return meilleur.paires;
    // Zone d'indécision : coût tel que la marge relative au meilleur reste
    // sous `margeMin`. margeRelative = (c − c*) / c < m  ⇔  c < c* / (1 − m).
    const plafond = o.margeMin >= 1 ? Infinity : meilleur.cout / (1 - o.margeMin);
    const vues = new Set();
    const zone = [];
    for (const h of toutes) {
      if (h.sens != null && h.sens <= 0) continue;
      if (h.cout > plafond + 1e-12) break;               // trié par coût
      if (vues.has(h.cle)) continue;
      vues.add(h.cle); zone.push(h);
    }
    if (zone.length < 2) return meilleur.paires;
    return meilleur.paires.filter(p => zone.every(h => h.paires.some(q => q.i === p.i && q.j === p.j)));
  };

  const base = {
    modele: meilleur.reflechie ? 'reflexion' : 'directe',
    meilleur: resumer(meilleur, A, B), second: second ? resumer(second, A, B) : null,
    marge, margeRelative, ecarteesParSens,
    // Ce qu'aurait donné le choix SANS le contrôle de sens : la mesure de ce
    // que ce contrôle apporte réellement, plutôt que sa simple présence.
    meilleurSansControle: resumer(toutes[0], A, B),
  };

  // 2 · marge large : la géométrie suffit.
  if (!second) return { ...base, paires: meilleur.paires, decision: 'unique', raison: null, apparence: null };
  if (margeRelative != null && margeRelative >= o.margeMin) {
    return { ...base, paires: meilleur.paires, decision: 'marge', raison: null, apparence: null };
  }

  // 3 · marge serrée : l'apparence départage — en SECOND, sur les deux
  //     hypothèses déjà retenues par la géométrie. Elle ne propose jamais un
  //     appariement de son cru.
  const appM = coutApparence(meilleur.paires, A, B, o);
  const appS = coutApparence(second.paires, A, B, o);
  const apparence = { meilleur: appM, second: appS, ecartRelatif: null, tranche: false };
  if (appM != null && appS != null) {
    const pire = Math.max(appM, appS);
    apparence.ecartRelatif = pire > 1e-12 ? Math.abs(appS - appM) / pire : 0;
    if (apparence.ecartRelatif >= o.margeApparenceMin) {
      apparence.tranche = true;
      const gagnante = appM <= appS ? meilleur : second;
      return {
        ...base, paires: gagnante.paires, decision: 'apparence',
        raison: null, apparence,
        // L'apparence a-t-elle confirmé la géométrie ou l'a-t-elle contredite ?
        concordante: gagnante === meilleur,
      };
    }
  }

  // 4 · personne ne tranche : on ne garde que ce qui ne dépend pas du choix.
  const paires = commun();
  return {
    ...base, paires,
    decision: paires.length ? 'consensus' : 'refus',
    raison: paires.length ? null : 'hypotheses_trop_proches',
    apparence,
    // Les pistes de A que le consensus laisse sans réponse : ce sont elles
    // qu'on préfère ne pas trancher plutôt que de trancher au hasard.
    nonDecidees: meilleur.paires.filter(p => !paires.some(q => q.i === p.i)).map(p => A.ids[p.i]),
  };
}

function resumer(h, A, B) {
  return {
    cout: Number(h.cout.toFixed(4)),
    reflechie: h.reflechie,
    echelle: Number(h.echelle.toFixed(4)),
    angleDeg: Number((h.angle * 180 / Math.PI).toFixed(2)),
    sens: h.sens == null ? null : Number(h.sens.toFixed(4)),
    paires: h.paires.map(p => ({
      a: A.ids[p.i], b: B.ids[p.j], d: Number(p.d.toFixed(4)),
      dPos: Number(p.dPos.toFixed(4)), dTaille: Number(p.dTaille.toFixed(4)),
    })),
  };
}

/**
 * Appariement complet : énumération puis décision.
 *
 * @param {object} A configuration du plan précédent
 * @param {object} B configuration du plan suivant
 */
export function apparier(A, B, options = {}) {
  const o = { ...REGLAGES, ...options };
  // Un refus doit avoir EXACTEMENT la forme d'une réussite : sans quoi
  // l'appelant qui parcourt `appariements` plante sur le cas dégénéré, celui
  // qui arrive le plus souvent en vrai.
  if (A.points.length < o.tailleGroupeMin || B.points.length < o.tailleGroupeMin) {
    return {
      paires: [], appariements: [], decision: 'refus', raison: 'groupe_trop_petit',
      modele: null, methode: METHODE_REATTRIBUTION,
      meilleur: null, second: null, meilleurSansControle: null,
      marge: null, margeRelative: null, ecarteesParSens: 0, apparence: null,
      hypothesesEvaluees: 0,
      tailles: { avant: A.points.length, apres: B.points.length },
    };
  }
  const toutes = hypotheses(A, B, o);
  const d = decider(toutes, A, B, o);
  return {
    ...d,
    methode: METHODE_REATTRIBUTION,
    tailles: { avant: A.points.length, apres: B.points.length },
    hypothesesEvaluees: toutes.length,
    // Les paires en identifiants de pistes, prêtes à poser la filiation.
    appariements: d.paires.map(p => ({ avant: A.ids[p.i], apres: B.ids[p.j], cout: Number(p.d.toFixed(4)) })),
  };
}

/**
 * Point d'entrée du tracker : deux listes d'éléments bruts, un rapport.
 *
 * Le suivi n'a pas à connaître les configurations ni les similitudes — il
 * fournit ce qu'il observe (une boîte, une vitesse, une mémoire d'apparence)
 * et reçoit un appariement. C'est aussi ce qui évite un cycle d'imports entre
 * les deux modules : la dépendance ne va que dans un sens.
 */
export function analyser(elementsAvant, elementsApres, options = {}) {
  const A = configuration(elementsAvant);
  const B = configuration(elementsApres);
  const r = apparier(A, B, options);
  return {
    ...r,
    // Ce qu'on a vraiment comparé, pour que le rapport soit relisible sans
    // avoir à rejouer le run.
    groupes: {
      avant: { ids: A.ids, direction: A.direction, rayon: Number(A.rayon.toFixed(1)) },
      apres: { ids: B.ids, direction: B.direction, rayon: Number(B.rayon.toFixed(1)) },
    },
    balayage: balayer(A, B, options),
  };
}

/**
 * Rejoue la décision à plusieurs seuils, sans recalculer la géométrie.
 *
 * Sert à CHOISIR `margeMin` et `margeApparenceMin` sur des mesures plutôt
 * qu'à les poser : le rapport publie la courbe, la valeur se décide ensuite,
 * sur plusieurs cuts.
 */
export function balayer(A, B, {
  marges = [0, 0.02, 0.05, 0.1, 0.15, 0.25, 0.4],
  margesApparence = [0.02, 0.05, 0.1],
  poidsTailles = [0, 0.5, 1, 2],
  ...options
} = {}) {
  if (A.points.length < REGLAGES.tailleGroupeMin || B.points.length < REGLAGES.tailleGroupeMin) return [];
  const lignes = [];
  for (const poidsTaille of poidsTailles) {
    // Le poids change la géométrie, donc les hypothèses : il faut recalculer.
    // Les marges, elles, ne changent que la décision — d'où les deux boucles
    // internes qui réutilisent le même jeu d'hypothèses.
    const toutes = hypotheses(A, B, { ...options, poidsTaille });
    for (const margeMin of marges) {
      for (const margeApparenceMin of margesApparence) {
        const d = decider(toutes, A, B, { ...options, poidsTaille, margeMin, margeApparenceMin });
        lignes.push({
          poidsTaille, margeMin, margeApparenceMin,
          decision: d.decision,
          retenues: d.paires.length,
          appariements: d.paires.map(p => ({ avant: A.ids[p.i], apres: B.ids[p.j] })),
        });
      }
    }
  }
  return lignes;
}

/**
 * Note un appariement contre la vérité terrain.
 *
 * `verite` : Map ou objet { idAvant: idApres }. Une entrée absente signifie
 * « pas de correspondance attendue » — la voiture n'existait pas dans l'autre
 * plan. Distinguer JUSTE, FAUX et NON DÉCIDÉ est tout l'enjeu : un appariement
 * qui ne se prononce pas ne vaut pas un appariement qui se trompe.
 */
export function noter(appariements, verite, idsAvant = []) {
  const attendu = verite instanceof Map ? verite : new Map(Object.entries(verite || {}).map(([k, v]) => [Number(k), v]));
  let justes = 0, fausses = 0, horsVerite = 0;
  const detail = [];
  for (const a of appariements) {
    if (!attendu.has(a.avant)) { horsVerite += 1; detail.push({ ...a, verdict: 'hors_verite' }); continue; }
    const ok = attendu.get(a.avant) === a.apres;
    if (ok) justes += 1; else fausses += 1;
    detail.push({ ...a, attendu: attendu.get(a.avant), verdict: ok ? 'juste' : 'faux' });
  }
  const traitees = new Set(appariements.map(a => a.avant));
  const nonDecidees = [...attendu.keys()].filter(k => !traitees.has(k));
  return {
    justes, fausses, horsVerite,
    nonDecidees: nonDecidees.length, idsNonDecidees: nonDecidees,
    attendues: attendu.size,
    // Ce que le suivi n'a même pas proposé comme candidat, faute de piste.
    absentes: [...attendu.keys()].filter(k => !idsAvant.includes(k)).length,
    detail,
  };
}
