/* ═══════════════════════════════════════════════
   STRUCTURE.MJS — Quel niveau de représentation le groupe supporte-t-il ?

   Module PUR. Il ne décide rien : il mesure ce que les données CONTIENNENT,
   pour qu'on choisisse une représentation sur des chiffres plutôt que sur une
   intuition.

   ── La question ────────────────────────────────────────────────────────
   On aimerait tenir un « état monde » du peloton, indépendant de la caméra,
   dont chaque image ne serait qu'une projection. Quatre niveaux sont
   possibles, du plus pauvre au plus riche :

     ① configuration 2D normalisée — le nuage à une similitude près ;
     ② structure 3D sous caméra affine — Tomasi-Kanade ;
     ③ homographie vers le plan de la piste ;
     ④ reconstruction 3D perspective complète.

   Chacun n'est identifiable que sous des conditions précises, et ces
   conditions se VÉRIFIENT.

   ── Ce que le comptage des inconnues dit déjà ──────────────────────────
   Avec N points suivis sur M vues, une reconstruction projective complète
   (④) demande 11 paramètres par vue et 3 par point, à 15 près pour la jauge
   projective, contre 2NM observations :

       2NM ≥ 11M + 3N − 15

   Pour N = 5, cela donne 10M ≥ 11M, faux pour tout M. **Le niveau ④ est
   hors d'atteinte avec cinq voitures, quel que soit le nombre d'images.**
   Ce n'est pas une question de bruit ou de qualité vidéo : le problème est
   sous-déterminé.

   Le niveau ② demande moins — une caméra affine coûte 8 paramètres par vue —
   et devient possible dès N ≥ 4 et M ≥ 3. Mais il repose sur une hypothèse
   qui, elle, n'est pas garantie : que le nuage soit RIGIDE.

   ── Le rang, et ce qu'il révèle ────────────────────────────────────────
   Empilons les positions observées dans une matrice de mesure W de taille
   2M × N, colonnes centrées. Sous caméra affine et objet rigide, W est de
   rang 3 au plus — c'est le théorème de factorisation de Tomasi-Kanade. Si
   le mouvement est purement plan, le rang tombe à 2.

   Les valeurs singulières de W disent donc directement quel niveau est
   soutenable :

     · décrochage net après σ₂ → le nuage se comporte comme une figure plane
       vue en similitude. Le niveau ① suffit, les autres n'ajoutent rien ;
     · décrochage net après σ₃ → il y a une vraie structure tridimensionnelle
       à extraire, le niveau ② a un sens ;
     · pas de décrochage → le nuage n'est pas rigide. Aucune factorisation ne
       le décrira, et prétendre le contraire reviendrait à ajuster du bruit.

   Cette dernière possibilité n'est pas théorique : des voitures qui se
   doublent ne forment pas un solide.
═══════════════════════════════════════════════ */

/** Identifiant de méthode, à retrouver dans les rapports. */
export const METHODE_STRUCTURE = 'rang-svd+homographie/1';

const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/**
 * Matrice de mesure de Tomasi-Kanade : 2M lignes (x puis y de chaque vue),
 * N colonnes (les points), colonnes centrées vue par vue.
 *
 * Le centrage retire la translation de la caméra, qui n'apporte rien sur la
 * forme. Ce qui reste est la structure.
 *
 * @param {number[][][]} vues — pour chaque vue, N points [x, y] dans le MÊME ordre
 * @returns {?{W:number[][], M:number, N:number, echelle:number}}
 */
export function matriceMesure(vues) {
  if (!vues.length) return null;
  const N = vues[0].length;
  if (N < 3 || vues.some(v => v.length !== N)) return null;
  const W = [];
  let echelle = 0;
  for (const v of vues) {
    const mx = v.reduce((s, p) => s + p[0], 0) / N;
    const my = v.reduce((s, p) => s + p[1], 0) / N;
    W.push(v.map(p => p[0] - mx));
    W.push(v.map(p => p[1] - my));
    echelle += Math.sqrt(v.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / N);
  }
  return { W, M: vues.length, N, echelle: echelle / vues.length };
}

/**
 * Valeurs singulières de W, par diagonalisation de WᵀW (N×N, donc petite)
 * avec la rotation de Jacobi.
 *
 * On passe par WᵀW plutôt que par une SVD complète parce que N vaut cinq :
 * une matrice 5×5 se diagonalise en quelques dizaines de rotations, sans
 * dépendance et sans subtilité numérique à cette taille.
 */
export function valeursSingulieres(W) {
  const M = W.length, N = W[0].length;
  // A = WᵀW
  const A = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => {
    let s = 0;
    for (let k = 0; k < M; k++) s += W[k][i] * W[k][j];
    return s;
  }));
  for (let balayage = 0; balayage < 100; balayage++) {
    let horsDiag = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) horsDiag += A[i][j] ** 2;
    if (horsDiag < 1e-12) break;
    for (let p = 0; p < N; p++) {
      for (let q = p + 1; q < N; q++) {
        if (Math.abs(A[p][q]) < 1e-14) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < N; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < N; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((r, i) => Math.sqrt(Math.max(0, r[i]))).sort((a, b) => b - a);
}

/**
 * Lecture du spectre : part d'énergie expliquée par les k premières valeurs,
 * et rang effectif au seuil demandé.
 *
 * L'énergie est en σ², parce que c'est elle qui s'additionne — la somme des
 * σ² vaut la somme des carrés des résidus expliqués.
 */
export function spectre(sv, { seuil = 0.98 } = {}) {
  const total = sv.reduce((s, v) => s + v * v, 0);
  if (total < 1e-12) return { sv, cumule: sv.map(() => 1), rang: 0, total: 0 };
  let acc = 0;
  const cumule = sv.map(v => { acc += v * v; return Number((acc / total).toFixed(5)); });
  const rang = cumule.findIndex(c => c >= seuil) + 1;
  // Le rang se lit au DÉCROCHAGE entre valeurs singulières, pas à l'énergie
  // cumulée. Un nuage volumique peu profond a bien un rang 3, mais sa
  // troisième composante ne pèse que quelques centièmes de pour cent de
  // l'énergie : la juger sur ce critère la ferait passer pour du bruit.
  const rapport = (i, j) => (sv[j] > 1e-9 ? Number((sv[i] / sv[j]).toFixed(2)) : Infinity);
  return {
    sv: sv.map(v => Number(v.toFixed(3))),
    cumule, rang, total: Number(Math.sqrt(total).toFixed(2)),
    residuApres2: Number((1 - (cumule[1] ?? 1)).toFixed(5)),
    residuApres3: Number((1 - (cumule[2] ?? 1)).toFixed(5)),
    // Ce qui distingue vraiment les trois régimes :
    //   σ₃/σ₁ ≈ 0            → figure plane, le niveau ① suffit ;
    //   σ₃ ≫ σ₄             → structure de rang 3, le niveau ② a un sens ;
    //   σ₄, σ₅ non nulles   → pas de structure rigide du tout.
    troisSurUn: sv[0] > 1e-9 ? Number((sv[2] / sv[0]).toFixed(5)) : 0,
    decrochage3: rapport(2, 3),
    quatreSurUn: sv[0] > 1e-9 ? Number(((sv[3] ?? 0) / sv[0]).toFixed(5)) : 0,
  };
}

/**
 * Homographie par DLT, à partir d'au moins 4 correspondances.
 *
 * Rend la matrice 3×3 (à un facteur près) ou `null` si le système est
 * dégénéré. Aucune normalisation de Hartley ici : les coordonnées d'entrée
 * sont attendues déjà centrées-réduites par `normaliser()`, sans quoi le
 * conditionnement est mauvais et le résultat ne veut rien dire.
 */
export function homographie(paires) {
  if (paires.length < 4) return null;
  const A = [];
  for (const [[x, y], [u, v]] of paires) {
    A.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    A.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  // Vecteur singulier de plus petite valeur de A : on diagonalise AᵀA (9×9).
  const n = 9;
  const B = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let s = 0;
    for (const r of A) s += r[i] * r[j];
    return s;
  }));
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let balayage = 0; balayage < 200; balayage++) {
    let horsDiag = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) horsDiag += B[i][j] ** 2;
    if (horsDiag < 1e-16) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(B[p][q]) < 1e-18) continue;
        const theta = (B[q][q] - B[p][p]) / (2 * B[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const bkp = B[k][p], bkq = B[k][q];
          B[k][p] = c * bkp - s * bkq; B[k][q] = s * bkp + c * bkq;
        }
        for (let k = 0; k < n; k++) {
          const bpk = B[p][k], bqk = B[q][k];
          B[p][k] = c * bpk - s * bqk; B[q][k] = s * bpk + c * bqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let iMin = 0;
  for (let i = 1; i < n; i++) if (B[i][i] < B[iMin][iMin]) iMin = i;
  const h = V.map(r => r[iMin]);
  if (!h.every(Number.isFinite) || Math.abs(h[8]) < 1e-12) return null;
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
}

/** Image d'un point par une homographie. */
export function appliquerH(H, [x, y]) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return null;
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}

/**
 * Normalisation de Hartley : centre le nuage et met sa distance moyenne à
 * l'origine à √2. Rend la transformation et son inverse.
 */
export function normaliser(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const d = points.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / n;
  const k = d > 1e-9 ? Math.SQRT2 / d : 1;
  return {
    points: points.map(p => [(p[0] - mx) * k, (p[1] - my) * k]),
    appliquer: (p) => [(p[0] - mx) * k, (p[1] - my) * k],
    inverse: (p) => [p[0] / k + mx, p[1] / k + my],
  };
}

/**
 * Compare, en VALIDATION CROISÉE, ce qu'une similitude et une homographie
 * expliquent réellement d'une correspondance entre deux vues.
 *
 * La validation croisée est indispensable ici : une homographie a huit
 * paramètres et quatre correspondances suffisent à l'ajuster exactement.
 * Mesurer son résidu sur les points qui ont servi à la poser reviendrait à
 * constater qu'elle passe par eux — ce qu'elle fait toujours. On la juge donc
 * sur les points LAISSÉS DE CÔTÉ, un à la fois.
 *
 * @param {number[][]} A points de la première vue
 * @param {number[][]} B points correspondants de la seconde
 */
export function comparerModelesGeometriques(A, B) {
  const n = A.length;
  if (n < 5) return null;                    // il faut au moins un point à laisser de côté
  const nA = normaliser(A), nB = normaliser(B);
  const rayonB = Math.max(1e-9, B.reduce((s, p, i) => {
    const c = B.reduce((a, q) => [a[0] + q[0] / n, a[1] + q[1] / n], [0, 0]);
    return s + Math.hypot(p[0] - c[0], p[1] - c[1]) ** 2;
  }, 0) / n) ** 0.5;

  const erreurs = { similitude: [], homographie: [] };
  for (let laisse = 0; laisse < n; laisse++) {
    const idx = [...Array(n).keys()].filter(i => i !== laisse);

    // — similitude au sens des moindres carrés (Umeyama), sur les points gardés
    const sim = similitudeMoindresCarres(idx.map(i => A[i]), idx.map(i => B[i]));
    if (sim) {
      const p = appliquerSim(sim, A[laisse]);
      erreurs.similitude.push(Math.hypot(p[0] - B[laisse][0], p[1] - B[laisse][1]) / rayonB);
    }

    // — homographie DLT, sur les mêmes points gardés, en coordonnées normalisées
    const H = homographie(idx.map(i => [nA.appliquer(A[i]), nB.appliquer(B[i])]));
    if (H) {
      const q = appliquerH(H, nA.appliquer(A[laisse]));
      if (q) {
        const p = nB.inverse(q);
        erreurs.homographie.push(Math.hypot(p[0] - B[laisse][0], p[1] - B[laisse][1]) / rayonB);
      }
    }
  }
  const med = (a) => {
    if (!a.length) return null;
    const t = [...a].sort((x, y) => x - y);
    return Number(t[Math.floor(t.length / 2)].toFixed(4));
  };
  return {
    n,
    similitude: { medianeHorsAjustement: med(erreurs.similitude), n: erreurs.similitude.length },
    homographie: { medianeHorsAjustement: med(erreurs.homographie), n: erreurs.homographie.length },
    // Positif = l'homographie fait MIEUX. Négatif = elle sur-ajuste.
    gainHomographie: med(erreurs.similitude) != null && med(erreurs.homographie) != null
      ? Number((med(erreurs.similitude) - med(erreurs.homographie)).toFixed(4)) : null,
  };
}

/** Similitude au sens des moindres carrés (rotation + échelle + translation). */
export function similitudeMoindresCarres(A, B) {
  const n = A.length;
  if (n < 2) return null;
  const ca = A.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const cb = B.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  let sxx = 0, sxy = 0, varA = 0;
  for (let i = 0; i < n; i++) {
    const ax = A[i][0] - ca[0], ay = A[i][1] - ca[1];
    const bx = B[i][0] - cb[0], by = B[i][1] - cb[1];
    sxx += ax * bx + ay * by;
    sxy += ax * by - ay * bx;
    varA += ax * ax + ay * ay;
  }
  if (varA < 1e-12) return null;
  const m = [sxx / varA, sxy / varA];          // échelle × e^{iθ}
  return { m, ca, cb };
}

export function appliquerSim({ m, ca, cb }, p) {
  const x = p[0] - ca[0], y = p[1] - ca[1];
  return [m[0] * x - m[1] * y + cb[0], m[1] * x + m[0] * y + cb[1]];
}

/**
 * RIGIDITÉ du groupe : de combien les distances entre voitures varient-elles,
 * une fois l'échelle globale retirée ?
 *
 * C'est la question qui décide de tout. Une figure rigide vue par une caméra
 * qui bouge garde ses rapports de distances ; un peloton où l'on se double
 * les change. Si la variation est forte, aucun « état monde » rigide n'existe
 * à reconstruire, et les niveaux ② et ④ tombent — quelle que soit la qualité
 * du reste.
 */
export function rigidite(vues) {
  if (vues.length < 2) return null;
  const N = vues[0].length;
  const paires = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) paires.push([i, j]);
  // Rapports de distances, normalisés par la distance médiane de la vue.
  const series = paires.map(() => []);
  for (const v of vues) {
    const d = paires.map(([i, j]) => Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1]));
    const tri = [...d].sort((a, b) => a - b);
    const ref = tri[Math.floor(tri.length / 2)] || 1;
    d.forEach((x, k) => series[k].push(x / ref));
  }
  const cv = series.map((s) => {
    const m = s.reduce((a, b) => a + b, 0) / s.length;
    const v = s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length;
    return m > 1e-9 ? Math.sqrt(v) / m : 0;
  });
  const tri = [...cv].sort((a, b) => a - b);
  return {
    paires: paires.length, vues: vues.length,
    // Coefficient de variation des rapports de distance : 0 = rigide.
    cvMedian: Number(tri[Math.floor(tri.length / 2)].toFixed(4)),
    cvMax: Number(Math.max(...cv).toFixed(4)),
  };
}

/**
 * REPÈRE DU GROUPE — l'« état monde » au niveau ①.
 *
 * À chaque instant, on cherche la similitude qui envoie la configuration
 * observée sur une configuration de RÉFÉRENCE, choisie une fois pour toutes.
 * Ce qui reste après cet alignement est la position de chaque voiture dans un
 * repère qui ne dépend plus de la caméra : ni de son cadrage, ni de son zoom,
 * ni de son orientation.
 *
 * C'est exactement ce que le niveau ① permet, et c'est tout ce que les
 * données autorisent — mesuré sur Kerlabo, le rang de la structure vaut 2 sur
 * 28 fenêtres sur 28, et une homographie y sur-ajuste.
 *
 * L'inverse de la similitude est aussi rendu : c'est lui la « caméra », au
 * sens où il projette le monde vers l'image. Une voiture hors champ garde
 * donc une position dans le repère, et sa position ATTENDUE dans l'image se
 * calcule en la reprojetant.
 *
 * @param {Map<number, number[]>} reference identité → position de référence
 * @param {{id:number, point:number[]}[]} observees ce qu'on voit à cet instant
 */
export function repereGroupe(reference, observees) {
  const communs = observees.filter(o => reference.has(o.id));
  if (communs.length < 2) return null;
  const A = communs.map(o => o.point);                 // image
  const R = communs.map(o => reference.get(o.id));     // repère du groupe
  const versRepere = similitudeMoindresCarres(A, R);
  const versImage = similitudeMoindresCarres(R, A);
  if (!versRepere || !versImage) return null;

  const positions = new Map();
  let residu = 0;
  for (const o of observees) {
    const p = appliquerSim(versRepere, o.point);
    positions.set(o.id, p);
    if (reference.has(o.id)) {
      const r = reference.get(o.id);
      residu += Math.hypot(p[0] - r[0], p[1] - r[1]);
    }
  }
  return {
    positions, versRepere, versImage,
    // La « caméra » telle qu'on peut l'estimer à ce niveau : trois nombres.
    camera: {
      echelle: Number(Math.hypot(versImage.m[0], versImage.m[1]).toFixed(4)),
      angleDeg: Number((Math.atan2(versImage.m[1], versImage.m[0]) * 180 / Math.PI).toFixed(2)),
      centre: versImage.cb.map(v => Number(v.toFixed(1))),
    },
    appuis: communs.length,
    residuMoyen: Number((residu / Math.max(1, communs.length)).toFixed(4)),
  };
}
