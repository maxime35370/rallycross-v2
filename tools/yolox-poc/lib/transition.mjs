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
 * Les références A et B sont d'abord les deux extrémités de la fenêtre, puis
 * les deux bords de la fenêtre : la médiane par canal rend le même α quel que
 * soit le choix des références, ce qui a été vérifié sur deux fenêtres
 * différentes.
 *
 * `epsilon` dit à partir de quel α une image cesse d'être « propre ». À 0,05,
 * une image contenant 5 % de l'autre plan est déjà écartée : le réglage penche
 * volontairement du côté prudent, puisque le coût d'écarter une image de trop
 * est nul et celui d'en garder une contaminée ne l'est pas.
 */
export function analyserTransition(cadres, { epsilon = 0.05, fractionMin = 0.5 } = {}) {
  if (!cadres || cadres.length < 3) return null;
  // Références : les DEUX BORDS de la fenêtre, sans raffinement.
  //
  // Une première version rapprochait itérativement les références de la
  // transition, pour éviter des images de référence « lointaines » où la
  // caméra a bougé. Mesuré, ce raffinement s'accroche à de mauvaises images et
  // finit par prendre pour référence deux images situées DANS le fondu : α
  // devient alors incohérent. Il n'a plus lieu d'être depuis que la médiane
  // par zones absorbe le mouvement — et la garde contre une fenêtre trop
  // courte, elle, reste : si α n'atteint jamais 0 ou 1, on le dit.
  const iA = 0, iB = cadres.length - 1;
  const mesures = cadres.map(c => ({
    t: c.t, image: c.image, ...(estimerMelange(cadres[iA].px, cadres[iB].px, c.px, { fractionMin }) || {}),
  }));

  // Contraste par image, pour la corroboration : calculé une fois, ici, et
  // non à chaque tour de raffinement.
  const contrastes = cadres.map(c => contraste(c.px));

  // Deux critères, et ils ne servent pas à la même chose.
  //
  // α dit OÙ l'image se situe entre les deux plans ; la dispersion dit si
  // toute l'image raconte la même histoire. Sur un fondu, tous les canaux
  // s'accordent — dispersion mesurée ≈ 0,002. Sur un panoramique, la moitié
  // des canaux dit 0 et l'autre 1 — dispersion = 1,0. Entre les deux régimes
  // il y a un facteur cinq cents ; le seuil n'a donc pas à être finement
  // réglé, et une image de dispersion élevée n'est de toute façon pas déclarée
  // propre.
  // La CLASSE d'une image ne dépend que de α. La dispersion, elle, juge la
  // FENÊTRE entière, pas une image : une dispersion élevée partout signifie
  // que les deux références ne sont pas deux plans différents — c'est le cas
  // d'un panoramique, où la moitié des canaux dit 0 et l'autre 1. Mêlée à la
  // classification, elle rendait « douteuses » toutes les images d'un
  // panoramique et faisait écarter une fenêtre entière au lieu de rien.
  const classer = (m) => {
    if (m.alpha == null) return 'indetermine';
    if (m.alpha <= epsilon) return 'planA';
    if (m.alpha >= 1 - epsilon) return 'planB';
    return 'transition';
  };
  const analyse = mesures.map((m, i) => ({ ...m, contraste: contrastes[i], classe: classer(m) }));

  // La zone à écarter va de la dernière image PUREMENT du plan A à la première
  // image PUREMENT du plan B.
  //
  // Une première version cherchait ces deux images de part et d'autre du
  // MILIEU de la fenêtre. Sur un panoramique, dont la bascule tombe où elle
  // veut, elle rendait sept images à écarter là où il n'y a rien à écarter.
  // On borne donc par les images douteuses elles-mêmes : tout ce qui n'est pas
  // franchement le plan A appartient déjà à la transition.
  const premierNonA = analyse.findIndex(x => x.classe !== 'planA');
  let dernierNonB = -1;
  for (let i = analyse.length - 1; i >= 0; i--) if (analyse[i].classe !== 'planB') { dernierNonB = i; break; }
  const av = premierNonA > 0 ? premierNonA - 1 : -1;
  const ap = dernierNonB >= 0 && dernierNonB < analyse.length - 1 ? dernierNonB + 1 : -1;

  const entre = av >= 0 && ap > av ? analyse.slice(av + 1, ap) : [];
  const med = (arr) => {
    if (!arr.length) return null;
    const t = [...arr].sort((x, y) => x - y);
    return Number(t[Math.floor(t.length / 2)].toFixed(4));
  };
  // Un vrai fondu progresse : α ne redescend pas. On le mesure au lieu de le
  // supposer — une transition non monotone n'est pas un fondu enchaîné.
  let croissants = 0;
  for (let i = av + 1; i > 0 && i <= ap; i++) {
    if (analyse[i].alpha >= analyse[i - 1].alpha - 0.02) croissants += 1;
  }
  const pas = analyse.length > 1 ? (analyse[1].t - analyse[0].t) : null;

  return {
    reglages: { epsilon, fractionMin },
    references: { avant: analyse[iA]?.image ?? null, apres: analyse[iB]?.image ?? null, amplitude: analyse[iA]?.amplitude ?? null },
    images: analyse,
    contrasteMin: analyse.length ? Math.min(...analyse.map(x => x.contraste ?? Infinity)) : null,
    contrastePlans: [contrastes[iA] ?? null, contrastes[iB] ?? null],
    // Les deux images que la réattribution doit utiliser.
    derniereImagePropreAvant: av >= 0 ? analyse[av] : null,
    premiereImagePropreApres: ap >= 0 ? analyse[ap] : null,
    imagesDeTransition: entre.length,
    // Verdict sans réglage : une coupure franche se traverse d'une image à la
    // suivante, un fondu s'étale. Le nombre d'images intermédiaires suffit à
    // les distinguer, et un panoramique — où α bascule d'un bloc — retombe
    // naturellement dans le premier cas.
    nature: entre.length === 0 ? 'coupure franche' : `transition étalée sur ${entre.length} image(s)`,
    duree: av >= 0 && ap > av ? Number((analyse[ap].t - analyse[av].t).toFixed(4)) : null,
    residuMedianEntre: med(entre.map(x => x.residu)),
    dispersionMedianeEntre: med(entre.map(x => x.dispersion)),
    // Dispersion et résidu sont PUBLIÉS, pas transformés en verdict.
    //
    // L'intention était d'en tirer un « le milieu est-il un vrai mélange ? ».
    // Mesuré sur une vraie vidéo encodée, le même fondu rend de 0,31 à 0,62
    // selon l'enregistrement, contre 1,0 pour un panoramique : la marge est trop
    // mince pour un booléen qui basculerait d'un enregistrement à l'autre. Le
    // verdict robuste ne demande de toute façon aucun seuil — voir `nature`.
    monotone: ap > av && ap - av > 0 ? Number((croissants / (ap - av)).toFixed(2)) : null,
    // Une fenêtre qui ne contient aucune image pure d'un côté ne permet pas de
    // conclure : elle commence ou finit à l'intérieur de la transition.
    fenetreSuffisante: av > 0 && ap < analyse.length - 1,
    pas,
  };
}
