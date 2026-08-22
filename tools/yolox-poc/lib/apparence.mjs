/* ═══════════════════════════════════════════════
   APPARENCE.MJS — Signatures couleur, et MESURE de ce qu'elles valent

   Deux usages du même histogramme, et deux seulement :
     · la signature d'une BOÎTE, pour savoir si les livrées sont séparables ;
     · la signature d'une IMAGE ENTIÈRE, pour repérer les changements de plan.

   Le second usage ne dépend d'aucune piste, d'aucune détection et d'aucun
   réglage du suivi — c'est précisément ce qu'on lui demande.

   ── Ce que ce module fait, et ne fait pas ──────────────────────────────
   Il CALCULE une signature d'apparence et MESURE sa pouvoir séparateur sur
   la séquence réelle. Il ne participe à AUCUNE association : rien dans
   `track.mjs` ne l'importe. C'est une sonde, posée pour répondre par des
   chiffres à la question « une signature couleur aurait-elle levé les
   ambiguïtés ? » — question à laquelle les rapports actuels ne permettent
   pas de répondre, faute de la moindre donnée colorimétrique.

   Tant que la sonde n'a pas montré que les cinq voitures sont réellement
   séparables sur CETTE vidéo, câbler l'apparence dans l'association serait
   remplacer une géométrie mesurée par une couleur supposée.

   ── Pourquoi HSV, et pas RGB ───────────────────────────────────────────
   La luminosité change d'une caméra à l'autre et d'un bord de piste à
   l'autre ; la teinte beaucoup moins. On sépare donc explicitement :

     · les pixels COLORÉS (S et V suffisants) → histogramme teinte × saturation ;
     · les pixels ACHROMATIQUES (blanc, gris, noir) → histogramme de valeur.

   Sans cette séparation, une livrée blanche et une livrée noire tombent dans
   le même seau « teinte indéfinie » — et en rallycross, blanc et noir sont
   deux livrées sur cinq.

   ── Pourquoi un zonage ─────────────────────────────────────────────────
   Une voiture n'est pas un aplat : toit, flancs et bas de caisse portent des
   couleurs différentes, et c'est leur AGENCEMENT qui distingue deux livrées
   qui partagent les mêmes couleurs. Trois bandes horizontales suffisent à
   capter cet agencement sans dépendre de l'orientation exacte de la voiture.
═══════════════════════════════════════════════ */

import { hungarian } from './track.mjs';

export const PROFIL = {
  zones: 3,            // bandes horizontales : toit / flancs / bas de caisse
  binsTeinte: 12,      // 30° par seau — plus fin serait du bruit sur 30 px
  binsSaturation: 3,
  binsValeur: 4,       // pour les pixels achromatiques seulement
  satMin: 0.25,        // en dessous : pixel considéré sans teinte fiable
  valMin: 0.15,        // en dessous : trop sombre pour que la teinte existe
  marge: 0.12,         // part de la boîte rognée sur chaque bord (fond parasite)
  minPixels: 40,       // en dessous, la signature n'est pas calculée
};

export const TAILLE_ZONE = PROFIL.binsTeinte * PROFIL.binsSaturation + PROFIL.binsValeur;
export const TAILLE_SIGNATURE = TAILLE_ZONE * PROFIL.zones;

/** RGB 0–255 → HSV, h dans [0,1[. */
export function rgbVersHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

/**
 * Signature d'une boîte lue dans une image RGBA complète.
 *
 * `rgba` est l'image entière (comme `getImageData().data`) : on n'extrait pas
 * de sous-canvas, on lit directement la fenêtre voulue. La boîte est rognée de
 * `marge` sur chaque bord — les coins d'une boîte englobante contiennent du
 * bitume et du public, pas de la voiture.
 *
 * Renvoie `null` si la boîte est trop petite pour que l'histogramme veuille
 * dire quelque chose : mieux vaut pas de signature qu'une signature de bruit.
 */
export function signature(rgba, largeurImage, hauteurImage, boite, profil = PROFIL) {
  const p = { ...PROFIL, ...profil };
  const [x1, y1, x2, y2] = boite;
  const w = x2 - x1, h = y2 - y1;
  if (!(w > 0 && h > 0)) return null;

  const mx = w * p.marge, my = h * p.marge;
  const gx1 = Math.max(0, Math.round(x1 + mx)), gx2 = Math.min(largeurImage, Math.round(x2 - mx));
  const gy1 = Math.max(0, Math.round(y1 + my)), gy2 = Math.min(hauteurImage, Math.round(y2 - my));
  if (gx2 - gx1 < 2 || gy2 - gy1 < 2) return null;
  if ((gx2 - gx1) * (gy2 - gy1) < p.minPixels) return null;

  const tailleZone = p.binsTeinte * p.binsSaturation + p.binsValeur;
  const sig = new Float64Array(tailleZone * p.zones);
  const comptes = new Array(p.zones).fill(0);
  const hauteurZone = (gy2 - gy1) / p.zones;

  for (let y = gy1; y < gy2; y++) {
    const z = Math.min(p.zones - 1, Math.floor((y - gy1) / hauteurZone));
    const base = z * tailleZone;
    for (let x = gx1; x < gx2; x++) {
      const i = (y * largeurImage + x) * 4;
      const [teinte, sat, val] = rgbVersHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (sat >= p.satMin && val >= p.valMin) {
        const bt = Math.min(p.binsTeinte - 1, Math.floor(teinte * p.binsTeinte));
        const bs = Math.min(p.binsSaturation - 1, Math.floor(sat * p.binsSaturation));
        sig[base + bs * p.binsTeinte + bt] += 1;
      } else {
        const bv = Math.min(p.binsValeur - 1, Math.floor(val * p.binsValeur));
        sig[base + p.binsTeinte * p.binsSaturation + bv] += 1;
      }
      comptes[z] += 1;
    }
  }

  // Chaque zone pèse autant : sinon la bande la plus haute, souvent tronquée,
  // ferait varier la signature selon le cadrage plutôt que selon la livrée.
  for (let z = 0; z < p.zones; z++) {
    const n = comptes[z];
    if (!n) continue;
    const base = z * tailleZone;
    for (let k = 0; k < tailleZone; k++) sig[base + k] /= n * p.zones;
  }
  return Array.from(sig, v => Number(v.toFixed(6)));
}

/**
 * Distance de Bhattacharyya entre deux signatures normalisées : 0 identique,
 * 1 disjoint. Choisie plutôt qu'une distance euclidienne parce qu'elle compare
 * des DISTRIBUTIONS — deux histogrammes décalés d'un seau restent proches.
 */
export function distance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let bc = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Math.max(0, a[i]), y = Math.max(0, b[i]);
    bc += Math.sqrt(x * y); sa += x; sb += y;
  }
  // Normalisation explicite par les masses : les signatures sont arrondies
  // pour l'export, et leur somme ne vaut donc pas exactement 1. Sans cela,
  // une signature comparée à ELLE-MÊME rendait 0,001 au lieu de 0 — un biais
  // constant qui se serait ajouté à toutes les distances.
  const norme = Math.sqrt(sa * sb);
  if (!(norme > 0)) return null;
  return Number(Math.sqrt(Math.max(0, 1 - Math.min(1, bc / norme))).toFixed(4));
}

/**
 * Signature moyenne d'une piste.
 *
 * Une seule observation, c'est un instant de lumière et d'orientation ; la
 * moyenne sur plusieurs observations est ce qui survit à une occlusion ou à
 * un changement de plan. Les observations les plus RÉCENTES pèsent davantage
 * (décroissance géométrique) : une voiture qui grossit à l'écran finit par ne
 * plus ressembler à sa première apparition.
 */
export function moyenner(signatures, { oubli = 0.85 } = {}) {
  const valides = signatures.filter(Boolean);
  if (!valides.length) return null;
  const n = valides[0].length;
  const acc = new Float64Array(n);
  let poidsTotal = 0;
  for (let i = 0; i < valides.length; i++) {
    const poids = Math.pow(oubli, valides.length - 1 - i);
    if (valides[i].length !== n) continue;
    for (let k = 0; k < n; k++) acc[k] += valides[i][k] * poids;
    poidsTotal += poids;
  }
  if (!poidsTotal) return null;
  return Array.from(acc, v => Number((v / poidsTotal).toFixed(6)));
}

const quantile = (arr, p) => {
  if (!arr.length) return null;
  const t = [...arr].sort((a, b) => a - b);
  return Number(t[Math.min(t.length - 1, Math.floor((t.length - 1) * p))].toFixed(4));
};

/**
 * Pouvoir séparateur mesuré sur la séquence.
 *
 * `observations` : [{ t, id, sig }] — une par piste et par instant où elle a
 * été RÉELLEMENT détectée (jamais sur une boîte prédite : on mesurerait la
 * couleur du bitume).
 *
 * Trois chiffres décident si l'apparence mérite d'entrer dans l'association :
 *
 *   · `intra`  — distance entre deux vues de la MÊME piste ;
 *   · `inter`  — distance entre deux pistes vues au MÊME instant ;
 *   · `tauxPlusProche` — part des observations dont la piste la plus proche
 *     (au sens de la signature moyenne des AUTRES observations, donc sans
 *     s'auto-reconnaître) est bien la sienne.
 *
 * Si `inter` ne domine pas franchement `intra`, l'apparence n'apporte rien et
 * ajouterait du bruit à un coût géométrique déjà mesuré.
 */
export function separabilite(observations) {
  const valides = observations.filter(o => o.sig);
  const parPiste = new Map();
  for (const o of valides) {
    if (!parPiste.has(o.id)) parPiste.set(o.id, []);
    parPiste.get(o.id).push(o);
  }

  const intra = [];
  for (const serie of parPiste.values()) {
    for (let i = 1; i < serie.length; i++) {
      const d = distance(serie[i - 1].sig, serie[i].sig);
      if (d != null) intra.push(d);
    }
  }

  const parInstant = new Map();
  for (const o of valides) {
    if (!parInstant.has(o.t)) parInstant.set(o.t, []);
    parInstant.get(o.t).push(o);
  }
  const inter = [];
  for (const groupe of parInstant.values()) {
    for (let i = 0; i < groupe.length; i++) {
      for (let j = i + 1; j < groupe.length; j++) {
        if (groupe[i].id === groupe[j].id) continue;
        const d = distance(groupe[i].sig, groupe[j].sig);
        if (d != null) inter.push(d);
      }
    }
  }

  // Reconnaissance « une contre toutes », sans qu'une observation participe à
  // sa propre référence : c'est la seule façon honnête de mesurer un taux.
  let bons = 0, total = 0;
  const marges = [];
  const ids = [...parPiste.keys()];
  for (const [id, serie] of parPiste) {
    if (serie.length < 2) continue;
    for (let i = 0; i < serie.length; i++) {
      const refs = new Map();
      for (const autre of ids) {
        const sansSoi = parPiste.get(autre).filter((_, k) => !(autre === id && k === i));
        if (sansSoi.length < 1) continue;
        refs.set(autre, moyenner(sansSoi.map(o => o.sig)));
      }
      const scores = [...refs.entries()]
        .map(([autre, ref]) => ({ autre, d: distance(serie[i].sig, ref) }))
        .filter(x => x.d != null)
        .sort((a, b) => a.d - b.d);
      if (scores.length < 2) continue;
      total += 1;
      if (scores[0].autre === id) bons += 1;
      marges.push(Number((scores[1].d - scores[0].d).toFixed(4)));
    }
  }

  return {
    observations: valides.length,
    pistes: parPiste.size,
    intra: { n: intra.length, p10: quantile(intra, 0.1), median: quantile(intra, 0.5), p90: quantile(intra, 0.9) },
    inter: { n: inter.length, p10: quantile(inter, 0.1), median: quantile(inter, 0.5), p90: quantile(inter, 0.9) },
    // > 1 : deux pistes différentes se ressemblent MOINS que deux vues d'une
    // même piste. C'est la condition minimale pour que l'apparence serve.
    // Le plancher évite de rendre `null` quand la distance intra est nulle —
    // le cas le PLUS favorable serait alors le seul sans chiffre.
    contraste: intra.length && inter.length
      ? Number((quantile(inter, 0.5) / Math.max(quantile(intra, 0.5), 0.01)).toFixed(2)) : null,
    ecartMedian: intra.length && inter.length
      ? Number((quantile(inter, 0.5) - quantile(intra, 0.5)).toFixed(4)) : null,
    tauxPlusProche: total ? Number((bons / total).toFixed(3)) : null,
    margeMediane: quantile(marges, 0.5),
    decisions: total,
  };
}

/**
 * Ce que l'apparence dirait au moment d'un changement de plan.
 *
 * On prend la signature moyenne de chaque piste vivante AVANT la coupure et
 * celle de chaque piste vue APRÈS, et on demande l'appariement optimal. C'est
 * exactement la question posée : « #1..#5 → CUT → #1..#5 » ou « → #20..#24 ».
 *
 * `margeMin` n'est pas un seuil de décision — rien n'est décidé ici — mais la
 * mesure de la confiance : écart entre le meilleur choix et le deuxième.
 */
export function traverseeDeCoupure(observations, tCoupure, { fenetre = 1.0 } = {}) {
  const avant = new Map(), apres = new Map();
  for (const o of observations) {
    if (!o.sig) continue;
    if (o.t < tCoupure && o.t >= tCoupure - fenetre) {
      if (!avant.has(o.id)) avant.set(o.id, []);
      avant.get(o.id).push(o.sig);
    } else if (o.t >= tCoupure && o.t <= tCoupure + fenetre) {
      if (!apres.has(o.id)) apres.set(o.id, []);
      apres.get(o.id).push(o.sig);
    }
  }
  const A = [...avant.entries()].map(([id, s]) => ({ id, sig: moyenner(s) })).filter(x => x.sig);
  const B = [...apres.entries()].map(([id, s]) => ({ id, sig: moyenner(s) })).filter(x => x.sig);
  if (!A.length || !B.length) return { t: tCoupure, avant: A.map(x => x.id), apres: B.map(x => x.id), paires: [] };

  const cout = A.map(a => B.map(b => distance(a.sig, b.sig) ?? 1));
  // `hungarian` rend, pour chaque LIGNE, l'indice de colonne retenu (ou -1).
  const paires = hungarian(cout).flatMap((j, i) => {
    if (j < 0) return [];
    const ligne = [...cout[i]].sort((x, y) => x - y);
    return [{
      avant: A[i].id, apres: B[j].id,
      d: Number(cout[i][j].toFixed(4)),
      marge: ligne.length > 1 ? Number((ligne[1] - ligne[0]).toFixed(4)) : null,
      meilleur: cout[i][j] <= ligne[0] + 1e-9,
    }];
  });
  return {
    t: tCoupure,
    avant: A.map(x => x.id), apres: B.map(x => x.id),
    paires,
    // Part des pistes d'avant dont la plus proche d'après est bien celle que
    // l'appariement optimal retient : mesure la cohérence de la décision.
    coherence: paires.length ? Number((paires.filter(p => p.meilleur).length / paires.length).toFixed(3)) : null,
  };
}


// ═══════════════════════════════════════════════
// CHANGEMENTS DE PLAN — mesurés sur les pixels, pas sur les pistes
//
// Le premier détecteur de rupture déduisait la coupure du COMPORTEMENT DU
// SUIVI : beaucoup de pistes sans détection, plusieurs identités neuves.
// Vérifié sur la séquence réelle, il se trompe une fois sur deux — un plan
// large qui découvre des véhicules immobiles au fond produit exactement la
// même signature, sans qu'aucun plan n'ait changé.
//
// Un changement de plan est un fait d'IMAGE. On le mesure donc sur l'image :
// distance entre les histogrammes de deux images successives, comparée au
// niveau LOCAL de cette distance. Le seuil est relatif, jamais absolu — un
// panoramique rapide fait monter tout le voisinage, et seul un pic isolé
// au-dessus de son propre voisinage est une coupure.
//
// Ce que la méthode ne prétend pas faire : reconnaître un fondu enchaîné, ni
// dater la coupure plus finement que le pas d'échantillonnage.
// ═══════════════════════════════════════════════

/**
 * Signature d'une image entière, en grille.
 *
 * La grille est indispensable : deux plans d'une même course partagent le
 * bitume, l'herbe et le ciel, donc l'histogramme GLOBAL bouge peu d'un plan à
 * l'autre. C'est leur RÉPARTITION dans le cadre qui change brutalement.
 *
 * `pas` sous-échantillonne : pour un histogramme, lire un pixel sur deux dans
 * chaque direction ne change pas la distribution et divise le coût par quatre.
 */
export function signatureImage(rgba, largeur, hauteur, { grille = 4, pas = 2, profil = PROFIL } = {}) {
  const p = { ...PROFIL, ...profil };
  if (!(largeur > 0 && hauteur > 0)) return null;
  const tailleZone = p.binsTeinte * p.binsSaturation + p.binsValeur;
  const zones = grille * grille;
  const sig = new Float64Array(tailleZone * zones);
  const comptes = new Array(zones).fill(0);

  for (let y = 0; y < hauteur; y += pas) {
    const zy = Math.min(grille - 1, Math.floor(y * grille / hauteur));
    for (let x = 0; x < largeur; x += pas) {
      const zx = Math.min(grille - 1, Math.floor(x * grille / largeur));
      const base = (zy * grille + zx) * tailleZone;
      const i = (y * largeur + x) * 4;
      const [teinte, sat, val] = rgbVersHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (sat >= p.satMin && val >= p.valMin) {
        const bt = Math.min(p.binsTeinte - 1, Math.floor(teinte * p.binsTeinte));
        const bs = Math.min(p.binsSaturation - 1, Math.floor(sat * p.binsSaturation));
        sig[base + bs * p.binsTeinte + bt] += 1;
      } else {
        sig[base + p.binsTeinte * p.binsSaturation + Math.min(p.binsValeur - 1, Math.floor(val * p.binsValeur))] += 1;
      }
      comptes[zy * grille + zx] += 1;
    }
  }
  for (let z = 0; z < zones; z++) {
    if (!comptes[z]) continue;
    const base = z * tailleZone;
    for (let k = 0; k < tailleZone; k++) sig[base + k] /= comptes[z] * zones;
  }
  return Array.from(sig);
}

/**
 * Coupures dans une suite de signatures d'image.
 *
 * `serie` : [{ t, sig }] dans l'ordre du temps.
 *
 * Le juge est le rapport entre la distance d'un pas et la MÉDIANE des
 * distances de son voisinage, celle-ci exclue. Un seuil absolu ne peut pas
 * marcher : la distance de référence dépend du mouvement de caméra, de la
 * cadence d'échantillonnage et de la scène. Le rapport, lui, ne dépend que du
 * caractère isolé du pic.
 *
 * `minAbsolu` n'est pas un second seuil de décision mais un plancher de bruit :
 * sur un plan parfaitement fixe la médiane locale tend vers zéro, et tout
 * frémissement deviendrait un rapport infini.
 */
export function detecterCoupures(serie, { facteur = 3.0, fenetre = 9, minAbsolu = 0.06 } = {}) {
  const distances = [];
  for (let i = 1; i < serie.length; i++) {
    distances.push({ t: serie[i].t, d: distance(serie[i - 1].sig, serie[i].sig) ?? 0 });
  }
  if (distances.length < 3) return { distances, coupures: [] };

  const demi = Math.max(1, Math.floor(fenetre / 2));
  const coupures = [];
  for (let i = 0; i < distances.length; i++) {
    const voisins = [];
    for (let j = Math.max(0, i - demi); j <= Math.min(distances.length - 1, i + demi); j++) {
      if (j !== i) voisins.push(distances[j].d);
    }
    if (!voisins.length) continue;
    const tri = voisins.sort((a, b) => a - b);
    const med = tri[Math.floor(tri.length / 2)];
    const reference = Math.max(med, minAbsolu);
    const rapport = distances[i].d / reference;
    // Pic ISOLÉ : strictement au-dessus de ses deux voisins immédiats. Un
    // panoramique produit un plateau de distances élevées, pas un pic.
    const pic = (i === 0 || distances[i].d > distances[i - 1].d)
      && (i === distances.length - 1 || distances[i].d >= distances[i + 1].d);
    distances[i].rapport = Number(rapport.toFixed(2));
    // Le seuil est publié PAR INSTANT : il n'y en a pas d'autre, et le lire
    // est le seul moyen de vérifier qu'aucune constante magique ne traîne.
    distances[i].reference = Number(reference.toFixed(4));
    distances[i].seuil = Number((facteur * reference).toFixed(4));
    distances[i].pic = pic;
    if (rapport >= facteur && pic) {
      coupures.push({
        t: distances[i].t,
        d: Number(distances[i].d.toFixed(4)),
        seuil: distances[i].seuil,
        rapport: Number(rapport.toFixed(2)),
      });
    }
  }
  return {
    reglages: { facteur, fenetre, minAbsolu },
    distances: distances.map(x => ({
      t: x.t, d: Number(x.d.toFixed(4)),
      reference: x.reference ?? null, seuil: x.seuil ?? null,
      rapport: x.rapport ?? null, pic: x.pic ?? null,
    })),
    coupures,
  };
}
