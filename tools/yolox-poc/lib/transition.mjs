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
 * Identifiant de la MÉTHODE, affiché par la page et inscrit dans chaque rapport.
 *
 * Trois méthodes se sont succédé ici, et deux ont produit des chiffres qui se
 * ressemblaient assez pour qu'on ne sache pas, en lisant un rapport, laquelle
 * l'avait produit. Un rapport doit dire de quel code il vient.
 */
export const METHODE = 'derive+rampe/1';

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
 * Ajustement à DEUX RÉGIMES : une dérive, plus une rampe.
 *
 *     α(t) = a + b·t + s·rampe(t ; début, fin)
 *
 * `b` est la dérive que le mouvement de caméra impose à α — présente avant,
 * pendant et après la transition. `s·rampe` est le fondu. Les trois paramètres
 * linéaires s'ajustent par moindres carrés pour un couple (début, fin) donné ;
 * on essaie tous les couples et on garde celui qui minimise l'erreur.
 *
 * Aucune pénalité, donc aucun seuil : élargir la rampe force une montée lente
 * là où les données en montrent une rapide, ce qui AUGMENTE l'erreur. La
 * largeur se choisit toute seule — vérifié sur un fondu de 5 images, où les
 * bornes rendues sont identiques à ±0,20, ±0,30, ±0,40 et ±0,60 s.
 *
 * `reduction` est la part de variance que la rampe explique EN PLUS de la
 * dérive seule. C'est elle qui dit s'il y a un fondu du tout : mesuré, 88 à
 * 99,9 % sur un fondu, 4,5 à 8 % sur un panoramique sans fondu.
 */
export function ajusterDeuxRegimes(ts, alphas, { largeurMax = Infinity } = {}) {
  const n = ts.length;
  if (n < 5 || alphas.length !== n) return null;
  const t0 = ts[0];

  // Modèle de référence : la dérive seule, sans rampe.
  let S11 = 0, S1t = 0, Stt = 0, Y1 = 0, Yt = 0;
  for (let k = 0; k < n; k++) {
    const t = ts[k] - t0;
    S11 += 1; S1t += t; Stt += t * t; Y1 += alphas[k]; Yt += alphas[k] * t;
  }
  const D0 = S11 * Stt - S1t * S1t;
  if (!(Math.abs(D0) > 1e-12)) return null;
  const a0 = (Y1 * Stt - Yt * S1t) / D0, b0 = (S11 * Yt - S1t * Y1) / D0;
  let sse0 = 0;
  for (let k = 0; k < n; k++) {
    const e = alphas[k] - (a0 + b0 * (ts[k] - t0));
    sse0 += e * e;
  }

  let best = null;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (ts[j] - ts[i] > largeurMax) break;
      const largeur = ts[j] - ts[i];
      let s11 = 0, s1t = 0, s1r = 0, stt = 0, str = 0, srr = 0, y1 = 0, yt = 0, yr = 0;
      for (let k = 0; k < n; k++) {
        const t = ts[k] - t0;
        const r = ts[k] <= ts[i] ? 0 : ts[k] >= ts[j] ? 1 : (ts[k] - ts[i]) / largeur;
        const y = alphas[k];
        s11 += 1; s1t += t; s1r += r; stt += t * t; str += t * r; srr += r * r;
        y1 += y; yt += y * t; yr += y * r;
      }
      const M = [[s11, s1t, s1r], [s1t, stt, str], [s1r, str, srr]];
      const Y = [y1, yt, yr];
      const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const Dt = det(M);
      if (!(Math.abs(Dt) > 1e-12)) continue;
      const avec = (c) => M.map((ligne, li) => ligne.map((v, ci) => (ci === c ? Y[li] : v)));
      const a = det(avec(0)) / Dt, b = det(avec(1)) / Dt, sAmp = det(avec(2)) / Dt;
      let sse = 0;
      for (let k = 0; k < n; k++) {
        const t = ts[k] - t0;
        const r = ts[k] <= ts[i] ? 0 : ts[k] >= ts[j] ? 1 : (ts[k] - ts[i]) / largeur;
        const e = alphas[k] - (a + b * t + sAmp * r);
        sse += e * e;
      }
      if (!best || sse < best.sse) best = { i, j, a, b, s: sAmp, sse };
    }
  }
  if (!best) return null;
  return {
    ...best,
    sse0,
    derive: Number(best.b.toFixed(4)),
    amplitude: Number(best.s.toFixed(4)),
    pente: Number((best.s / Math.max(1e-9, ts[best.j] - ts[best.i])).toFixed(3)),
    reduction: sse0 > 0 ? Number((1 - best.sse / sse0).toFixed(4)) : null,
  };
}

/**
 * Étendue d'une transition, dans une fenêtre d'images consécutives.
 *
 * `cadres` : [{ t, image, px }] à la cadence du fichier, du plus ancien au
 * plus récent, encadrant largement le candidat.
 *
 * ── Deux méthodes écartées, et pourquoi ────────────────────────────────
 *
 * 1. SEUIL SUR α — chercher les images où α touche 0 ou 1 à `epsilon` près.
 *    La caméra bouge à l'intérieur de chaque plan : une image encore pure
 *    diffère déjà de la référence par le seul effet du mouvement, donc son α
 *    n'est pas 0. Mesuré sur un fondu de 6 images avec panoramique, l'étendue
 *    rendue valait à peu près la largeur de la fenêtre — 25 · 38 · 50 · 74
 *    images pour ±0,20 · 0,30 · 0,40 · 0,60 s.
 *
 * 2. FRACTION DE LA MONTÉE TOTALE — le plus court intervalle captant 98 % de
 *    la montée. Meilleur sur synthétique, mais faux sur la vidéo réelle :
 *    7 · 22 · 30 · 34 images, parce que la « montée totale » inclut la DÉRIVE.
 *    Sur la coupure Kerlabo, α passe de 0,013 à 5,333 s à 0,31 à 5,80 s sans
 *    qu'aucun fondu ait commencé — la dérive à elle seule vaut 0,64 par
 *    seconde, et la méthode en absorbait l'essentiel dans la montée.
 *
 * ── La méthode retenue ─────────────────────────────────────────────────
 * On MODÉLISE la dérive au lieu d'essayer de la franchir : `α = a + b·t + s·rampe`.
 * Le fondu est ce que la rampe explique en plus de la dérive, et sa largeur se
 * choisit sans aucune pénalité ni seuil (voir `ajusterDeuxRegimes`).
 */
export function analyserTransition(cadres, { fractionMin = 0.5, largeurMaxRelative = 0.5 } = {}) {
  if (!cadres || cadres.length < 7) return null;

  const iA = 0, iB = cadres.length - 1;
  const images = cadres.map(c => ({
    t: c.t, image: c.image,
    ...(estimerMelange(cadres[iA].px, cadres[iB].px, c.px, { fractionMin }) || {}),
    contraste: contraste(c.px),
  }));
  if (images.some(m => m.alpha == null)) return null;

  const ts = images.map(m => m.t);
  const alphas = images.map(m => m.alpha);
  const span = ts[ts.length - 1] - ts[0];
  const fit = ajusterDeuxRegimes(ts, alphas, { largeurMax: span * largeurMaxRelative });
  if (!fit) return null;

  const av = fit.i, ap = fit.j;
  const entre = images.slice(av + 1, ap);
  for (let k = 0; k < images.length; k++) {
    images[k].classe = k <= av ? 'avant' : k >= ap ? 'apres' : 'transition';
  }
  const med = (arr) => {
    if (!arr.length) return null;
    const t = [...arr].sort((x, y) => x - y);
    return Number(t[Math.floor(t.length / 2)].toFixed(4));
  };

  return {
    reglages: { fractionMin, largeurMaxRelative },
    references: { avant: cadres[iA].image, apres: cadres[iB].image, amplitude: images[iA].amplitude },
    images,
    // Ce que le modèle a séparé : la dérive due au mouvement, et le fondu.
    modele: {
      derive: fit.derive,               // en α par seconde
      amplitude: fit.amplitude,         // hauteur de la rampe
      pente: fit.pente,                 // en α par seconde, pendant le fondu
      // Part de variance que la RAMPE explique en plus de la dérive seule.
      // C'est le seul chiffre qui dit s'il y a un fondu — mesuré : 88 à 99,9 %
      // sur un fondu, 4,5 à 8 % sur un panoramique sans fondu. Aucun seuil
      // n'est figé ici : le chiffre est publié, la décision se prend sur un
      // corpus de vraies coupures.
      reduction: fit.reduction,
      // Combien de fois la pente du fondu dépasse la dérive du plan.
      rapportPente: fit.derive !== 0 ? Number(Math.abs(fit.pente / fit.derive).toFixed(2)) : null,
    },
    contrasteMin: Math.min(...images.map(x => x.contraste ?? Infinity)),
    contrastePlans: [images[iA].contraste, images[iB].contraste],
    derniereImagePropreAvant: images[av],
    premiereImagePropreApres: images[ap],
    imagesDeTransition: entre.length,
    nature: entre.length === 0 ? 'coupure franche' : `transition étalée sur ${entre.length} image(s)`,
    duree: Number((ts[ap] - ts[av]).toFixed(4)),
    residuMedianEntre: med(entre.map(x => x.residu)),
    dispersionMedianeEntre: med(entre.map(x => x.dispersion)),
    // La transition doit tenir DANS la fenêtre, avec de quoi estimer la dérive
    // de part et d'autre. Deux images de marge au minimum : sans elles, la
    // pente du plan n'est pas mesurable et la rampe absorbe tout.
    fenetreSuffisante: av >= 2 && ap <= images.length - 3
      && (ts[ap] - ts[av]) < span * largeurMaxRelative - 1e-9,
    pas: Number((ts[1] - ts[0]).toFixed(5)),
  };
}

/**
 * Même mesure à plusieurs largeurs de fenêtre — et REFUS de conclure quand
 * elles ne s'accordent pas.
 *
 * Une durée de transition est une propriété locale de la coupure. Si les
 * fenêtres divergent, la mesure ne décrit pas la coupure mais l'analyse, et
 * aucune borne ne doit en sortir : c'est le sens de `fiable`.
 *
 * `toleranceImages` n'est pas une constante physique mais une EXIGENCE : pour
 * découper le suivi à l'image près, les fenêtres doivent s'accorder à ce
 * nombre d'images près. À défaut, la mesure est publiée mais déclarée non
 * fiable, et `bornes` vaut `null`.
 */
export function verifierStabilite(parDemiFenetre, { toleranceImages = 2, ...options } = {}) {
  const essais = [];
  for (const [demi, cadres] of Object.entries(parDemiFenetre)) {
    const r = analyserTransition(cadres, options);
    essais.push({
      demiFenetre: Number(demi),
      images: r?.imagesDeTransition ?? null,
      duree: r?.duree ?? null,
      avant: r?.derniereImagePropreAvant?.t ?? null,
      apres: r?.premiereImagePropreApres?.t ?? null,
      reduction: r?.modele?.reduction ?? null,
      derive: r?.modele?.derive ?? null,
      pente: r?.modele?.pente ?? null,
      suffisante: r?.fenetreSuffisante ?? false,
      pas: r?.pas ?? null,
    });
  }
  essais.sort((a, b) => a.demiFenetre - b.demiFenetre);
  const retenus = essais.filter(e => e.suffisante && e.avant != null);
  const etendue = (vals) => (vals.length ? Number((Math.max(...vals) - Math.min(...vals)).toFixed(4)) : null);
  const dispersionAvant = etendue(retenus.map(e => e.avant));
  const dispersionApres = etendue(retenus.map(e => e.apres));
  const pas = retenus.find(e => e.pas)?.pas ?? null;
  const tolerance = pas ? toleranceImages * pas : null;

  const raisons = [];
  if (retenus.length < 2) raisons.push('moins de deux fenêtres exploitables');
  if (tolerance != null && dispersionAvant != null && dispersionAvant > tolerance + 1e-9) {
    raisons.push(`bornes AVANT dispersées de ${Math.round(dispersionAvant * 1000)} ms`);
  }
  if (tolerance != null && dispersionApres != null && dispersionApres > tolerance + 1e-9) {
    raisons.push(`bornes APRÈS dispersées de ${Math.round(dispersionApres * 1000)} ms`);
  }
  const fiable = raisons.length === 0;
  const median = (vals) => {
    const t = [...vals].sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)];
  };

  return {
    essais,
    retenus: retenus.length,
    dispersionAvant,
    dispersionApres,
    toleranceImages,
    tolerance,
    fiable,
    raisons,
    // Rien ne sort tant que les fenêtres ne s'accordent pas : une borne fausse
    // découperait le suivi au mauvais endroit, ce qui est pire que pas de borne.
    bornes: fiable ? { avant: median(retenus.map(e => e.avant)), apres: median(retenus.map(e => e.apres)) } : null,
  };
}
