/* ═══════════════════════════════════════════════
   TRANSITION.MJS — Fondu enchaîné : mesurer son étendue, image par image

   `apparence.mjs` répond à « le plan a-t-il changé ? » en comparant des
   histogrammes. Il ne sait pas répondre à « SUR COMBIEN D'IMAGES ? », et il le
   dit : sur un fondu, la distance se répartit sur toute la transition au lieu
   de faire un pic.

   Ce module répond à la seconde question, et il travaille sur les PIXELS, pas
   sur des histogrammes — parce qu'un fondu enchaîné est une opération
   arithmétique exacte :

       I(t) = (1 − α) · A  +  α · B          α : 0 → 1

   D'où la mesure, qui n'est qu'une projection : pour chaque image, le α des
   moindres carrés sur le segment [A, B], et le RÉSIDU de cet ajustement.

   ── Pourquoi le résidu est indispensable ──────────────────────────────
   Sans lui, un simple panoramique serait pris pour un fondu : entre la
   première et la dernière image d'un panoramique, α progresse aussi de 0 à 1.
   Mais une image de panoramique n'est PAS la moyenne pondérée de la première
   et de la dernière — un objet à mi-course n'est pas la superposition de ses
   deux positions extrêmes. Le résidu le dit : petit sur un vrai mélange, grand
   sur un mouvement.

   ── Ce que le module ne fait pas ───────────────────────────────────────
   Il ne détecte pas la transition : on lui donne une fenêtre autour d'un
   candidat. Il ne distingue pas un fondu enchaîné d'un fondu au noir suivi
   d'une ouverture — dans les deux cas il rend l'étendue, ce qui suffit à
   savoir quelles images sont propres.
═══════════════════════════════════════════════ */

/**
 * Où se situe une image entre deux plans : α, estimé CANAL PAR CANAL.
 *
 * Un fondu enchaîné est une opération exacte, `I = (1−α)·A + α·B`. Chaque
 * canal de chaque pixel donne donc sa propre estimation de α :
 *
 *     α_i = (I_i − A_i) / (B_i − A_i)
 *
 * et il suffit d'en prendre la MÉDIANE. Deux versions plus savantes ont été
 * essayées et mesurées avant celle-ci :
 *
 *   · projection GLOBALE aux moindres carrés — sur un fondu accompagné d'un
 *     panoramique, α plafonne à 0,42 là où la vérité est 1,0. La raison est
 *     que l'image mélange le plan A *à cet instant* et le plan B *à cet
 *     instant*, pas les deux images de référence, dont le contenu mobile est
 *     ailleurs ;
 *   · médiane des projections PAR ZONES — juste quand le mouvement occupe peu
 *     de zones, instable dès qu'il en occupe la moitié, et sensible au choix
 *     de la fenêtre.
 *
 * La médiane par canal n'a aucun de ces défauts : elle rend la rampe exacte
 * (0 · 0,1 · 0,2 … 1) sur le même cas, et le même résultat quelle que soit la
 * fenêtre. Les pixels que le mouvement perturbe restent une minorité, et une
 * médiane les ignore.
 *
 * Les canaux où les deux plans se ressemblent ne portent aucune information —
 * leur α n'est que du bruit divisé par presque rien. Ils sont écartés sur un
 * critère RELATIF à l'écart entre les deux plans, jamais sur un seuil absolu.
 */
export function estimerMelange(a, b, k, { fractionMin = 0.5 } = {}) {
  if (!a || !b || !k || a.length !== b.length || a.length !== k.length) return null;

  let ecart2 = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) { const d = b[i + c] - a[i + c]; ecart2 += d * d; n += 1; }
  }
  if (!n || !(ecart2 > 0)) return null;
  const amplitude = Math.sqrt(ecart2 / n);
  const seuil = fractionMin * amplitude;

  const alphas = [];
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = b[i + c] - a[i + c];
      if (Math.abs(d) >= seuil) alphas.push((k[i + c] - a[i + c]) / d);
    }
  }
  if (!alphas.length) return null;
  alphas.sort((x, y) => x - y);
  const quantile = (p) => alphas[Math.min(alphas.length - 1, Math.floor((alphas.length - 1) * p))];
  const alpha = quantile(0.5);

  // Résidu du mélange sous CET α, sur les canaux retenus. Publié pour être lu,
  // jamais pour trancher : le mouvement le fait monter pendant un vrai fondu,
  // et il n'est pas plus bas pendant un simple mouvement. Le garde-fou contre
  // le panoramique est ailleurs — voir `analyserTransition`.
  let residu2 = 0, ecart2Retenu = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = b[i + c] - a[i + c];
      if (Math.abs(d) < seuil) continue;
      const e = k[i + c] - (a[i + c] + alpha * d);
      residu2 += e * e; ecart2Retenu += d * d;
    }
  }
  return {
    alpha: Number(alpha.toFixed(4)),
    residu: ecart2Retenu > 0 ? Number(Math.sqrt(residu2 / ecart2Retenu).toFixed(4)) : null,
    // Étalement des α entre canaux : bas, toute l'image s'accorde sur le même
    // mélange. Haut, une partie de l'image raconte autre chose.
    dispersion: Number((quantile(0.75) - quantile(0.25)).toFixed(4)),
    // Part des canaux exploitables : si elle est faible, les deux plans se
    // ressemblent trop pour que α veuille dire quoi que ce soit.
    partExploitable: Number((alphas.length / n).toFixed(3)),
    // Écart quadratique moyen entre les deux plans, en niveaux.
    amplitude: Number(amplitude.toFixed(2)),
  };
}

/**
 * Écart-type de la luminance.
 *
 * Il plonge au milieu d'un fondu : la moyenne de deux images décorrélées a
 * moins de contraste que chacune d'elles. Signal INDÉPENDANT de α, donc utile
 * pour corroborer — mais pas décisif : si l'un des deux plans est déjà plat en
 * luminance, le mélange peut ne pas descendre en dessous de lui. On le publie,
 * on ne s'en sert pas pour trancher.
 */
export function contraste(px) {
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    s += y; s2 += y * y; n += 1;
  }
  if (!n) return null;
  return Number(Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)).toFixed(2));
}

/**
 * Étendue d'une transition, dans une fenêtre d'images consécutives.
 *
 * `cadres` : [{ t, image, px }] à la cadence du fichier, du plus ancien au
 * plus récent, encadrant largement le candidat.
 *
 * ── Ce qui ne marche pas, et pourquoi ──────────────────────────────────
 * La première version cherchait les images où α touchait 0 ou 1 à `epsilon`
 * près. Mesuré sur un fondu de 6 images accompagné d'un panoramique, elle
 * rendait 25 images à ±0,20 s, 38 à ±0,30, 50 à ±0,40, 74 à ±0,60 — c'est-à-
 * dire à peu près la largeur de la fenêtre, donc rien.
 *
 * La cause : la caméra bouge À L'INTÉRIEUR de chaque plan. Une image encore
 * parfaitement pure diffère déjà de l'image de référence par le seul effet du
 * mouvement, donc son α n'est pas 0. Sur le cas mesuré, α oscille de ±0,12
 * dans le plan pur — deux fois et demie l'`epsilon` le plus généreux. Aucun
 * seuil ABSOLU sur α ne peut donc marquer la frontière.
 *
 * Rapprocher les références par contractions successives ne sauve rien : la
 * contamination par le mouvement décide seule du point fixe, qui se trouve où
 * elle passe sous le seuil — sans rapport avec le fondu. Mesuré : 71 images à
 * ±0,60 s au lieu de 74. Cette piste est abandonnée.
 *
 * ── Ce qui marche ──────────────────────────────────────────────────────
 * Le fondu n'est pas un NIVEAU de α, c'est une MONTÉE de α. Le mouvement, lui,
 * fait osciller α autour de son palier sans le déplacer. On cherche donc le
 * PLUS COURT intervalle qui capte l'essentiel de la montée totale, les deux
 * paliers étant estimés sur un quart de fenêtre de chaque côté — assez large
 * pour que l'oscillation s'y annule.
 *
 * Rien de tout cela ne dépend du choix des références, et c'est vérifiable.
 * Sur trois fondus de durées différentes, avec panoramique, demi-fenêtres de
 * 0,30 / 0,40 / 0,60 s :
 *
 *     vérité 3 images  →  2 · 2 · 2      (bornes exactes)
 *     vérité 6 images  →  5 · 4 · 5
 *     vérité 18 images → 15 · 10 · 13
 *
 * là où la version à seuil rendait 38 · 50 · 74 pour le cas à 6 images. La
 * mesure est redevenue une propriété locale de la coupure.
 *
 * `partMontee` à 0,98 plutôt que 0,90 : viser 90 % de la montée rogne les
 * queues d'un fondu long, et rogner va dans le MAUVAIS sens — on garderait des
 * images encore contaminées. Mesuré, 0,98 ne coûte aucune stabilité.
 *
 * Une demi-fenêtre de 0,20 s reste trop courte pour que les paliers soient
 * estimés proprement, et c'est le seul essai qui s'écarte des autres à chaque
 * durée testée. `verifierStabilite()` est là pour le voir plutôt que le
 * supposer.
 */
export function analyserTransition(cadres, { partMontee = 0.98, amplitudeMin = 0.5, fractionMin = 0.5 } = {}) {
  if (!cadres || cadres.length < 5) return null;

  const iA = 0, iB = cadres.length - 1;
  const mesures = cadres.map(c => ({
    t: c.t, image: c.image,
    ...(estimerMelange(cadres[iA].px, cadres[iB].px, c.px, { fractionMin }) || {}),
    contraste: contraste(c.px),
  }));
  if (mesures.some(m => m.alpha == null)) return null;

  const med = (arr) => {
    if (!arr.length) return null;
    const t = [...arr].sort((x, y) => x - y);
    return t[Math.floor(t.length / 2)];
  };
  const n = mesures.length;
  const quart = Math.max(3, Math.floor(n / 4));
  const alphas = mesures.map(m => m.alpha);
  const palierAvant = med(alphas.slice(0, quart));
  const palierApres = med(alphas.slice(n - quart));
  const amplitude = palierApres - palierAvant;

  // Le plus court intervalle qui capte `partMontee` de la montée. Prendre le
  // PLUS COURT est ce qui rend la mesure insensible à l'oscillation : un
  // intervalle plus large capterait la même montée, mais en incluant des
  // images parfaitement propres.
  const cible = Math.abs(amplitude) * partMontee;
  const signe = amplitude >= 0 ? 1 : -1;
  let av = -1, ap = -1;
  if (Math.abs(amplitude) >= amplitudeMin) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (signe * (alphas[j] - alphas[i]) >= cible) {
          if (av < 0 || j - i < ap - av) { av = i; ap = j; }
          break;
        }
      }
    }
  }

  const classer = (i) => (av < 0 ? 'indetermine' : i <= av ? 'avant' : i >= ap ? 'apres' : 'transition');
  const images = mesures.map((m, i) => ({ ...m, classe: classer(i) }));
  const entre = av >= 0 && ap > av ? images.slice(av + 1, ap) : [];
  const medArr = (arr) => (arr.length ? Number(med(arr).toFixed(4)) : null);

  // Un vrai fondu progresse : α ne redescend pas. Mesuré, pas supposé.
  let croissants = 0;
  for (let i = av + 1; av >= 0 && i <= ap; i++) {
    if (signe * (alphas[i] - alphas[i - 1]) >= -0.02) croissants += 1;
  }

  return {
    reglages: { partMontee, amplitudeMin, fractionMin },
    references: { avant: cadres[iA].image, apres: cadres[iB].image, amplitude: mesures[iA]?.amplitude ?? null },
    // Les deux paliers et l'écart entre eux : si l'écart est faible, la fenêtre
    // n'enjambe pas deux plans et rien de ce qui suit n'a de sens.
    paliers: {
      avant: Number(palierAvant.toFixed(4)),
      apres: Number(palierApres.toFixed(4)),
      montee: Number(amplitude.toFixed(4)),
    },
    images,
    contrasteMin: images.length ? Math.min(...images.map(x => x.contraste ?? Infinity)) : null,
    contrastePlans: [mesures[iA].contraste, mesures[iB].contraste],
    // Les deux images que la réattribution doit utiliser.
    derniereImagePropreAvant: av >= 0 ? images[av] : null,
    premiereImagePropreApres: ap >= 0 ? images[ap] : null,
    imagesDeTransition: entre.length,
    // Verdict sans seuil réglable : une coupure franche se traverse d'une image
    // à la suivante, un fondu s'étale.
    nature: av < 0 ? 'indéterminée'
      : entre.length === 0 ? 'coupure franche' : `transition étalée sur ${entre.length} image(s)`,
    duree: av >= 0 && ap > av ? Number((images[ap].t - images[av].t).toFixed(4)) : null,
    residuMedianEntre: medArr(entre.map(x => x.residu)),
    dispersionMedianeEntre: medArr(entre.map(x => x.dispersion)),
    monotone: av >= 0 && ap > av ? Number((croissants / (ap - av)).toFixed(2)) : null,
    // La fenêtre doit enjamber deux paliers ET laisser de la marge des deux
    // côtés : sinon elle commence ou finit à l'intérieur de la transition.
    fenetreSuffisante: Math.abs(amplitude) >= amplitudeMin && av > 0 && ap < n - 1,
    pas: n > 1 ? Number((mesures[1].t - mesures[0].t).toFixed(5)) : null,
  };
}

/**
 * Même mesure à plusieurs largeurs de fenêtre, pour vérifier qu'elle ne dépend
 * pas de la fenêtre.
 *
 * `parDemiFenetre` : { 0.2: [cadres…], 0.3: […] } — les cadres déjà lus, une
 * série par demi-fenêtre. La fonction ne lit rien elle-même.
 *
 * L'écart-type des bornes entre largeurs est le chiffre à regarder : c'est lui
 * qui dit si l'étendue mesurée est une propriété de la coupure ou un artefact
 * de l'analyse.
 */
export function verifierStabilite(parDemiFenetre, options = {}) {
  const essais = [];
  for (const [demi, cadres] of Object.entries(parDemiFenetre)) {
    const r = analyserTransition(cadres, options);
    essais.push({
      demiFenetre: Number(demi),
      images: r?.imagesDeTransition ?? null,
      duree: r?.duree ?? null,
      avant: r?.derniereImagePropreAvant?.t ?? null,
      apres: r?.premiereImagePropreApres?.t ?? null,
      montee: r?.paliers?.montee ?? null,
      suffisante: r?.fenetreSuffisante ?? false,
    });
  }
  const retenus = essais.filter(e => e.suffisante && e.avant != null);
  const ecartType = (vals) => {
    if (vals.length < 2) return null;
    const m = vals.reduce((t, v) => t + v, 0) / vals.length;
    return Number(Math.sqrt(vals.reduce((t, v) => t + (v - m) ** 2, 0) / vals.length).toFixed(4));
  };
  const etendue = (vals) => (vals.length ? Number((Math.max(...vals) - Math.min(...vals)).toFixed(4)) : null);
  return {
    essais,
    retenus: retenus.length,
    ecartTypeAvant: ecartType(retenus.map(e => e.avant)),
    ecartTypeApres: ecartType(retenus.map(e => e.apres)),
    dispersionAvant: etendue(retenus.map(e => e.avant)),
    dispersionApres: etendue(retenus.map(e => e.apres)),
    dispersionDuree: etendue(retenus.map(e => e.duree)),
    // Bornes conseillées : la MÉDIANE des essais retenus, plus robuste qu'un
    // essai unique, et bornée par les images réellement lues.
    avantRetenu: retenus.length ? med2(retenus.map(e => e.avant)) : null,
    apresRetenu: retenus.length ? med2(retenus.map(e => e.apres)) : null,
  };
}

function med2(arr) {
  const t = [...arr].sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}
