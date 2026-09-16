/* ═══════════════════════════════════════════════
   CAMERA.MJS — Modèles de mouvement apparent de la caméra

   Estime où une boîte doit se retrouver au pas suivant du seul fait du
   mouvement de la caméra, AVANT toute association. Logique pure, testable
   hors navigateur (`tests/cameraModels.test.js`).

   ── L'objection de fond, à garder en tête ──────────────────────────────
   Ces modèles sont ajustés sur des objets QUI BOUGENT. La translation globale
   ne s'en sort que parce que la médiane est robuste : le mouvement commun —
   la caméra — domine, et les mouvements propres des voitures sont rejetés
   comme des valeurs aberrantes.

   Dès qu'on ajoute des paramètres, le modèle peut absorber le mouvement RÉEL
   des voitures. Sur un départ, l'étirement du peloton est fortement corrélé à
   la position dans l'image : un modèle en (x, y, taille) expliquera volontiers
   cet étirement par de la « perspective », puis le prédira — ce qui n'est plus
   de la compensation de caméra mais un modèle de mouvement déguisé.

   D'où le critère d'arbitrage : la validation LAISSÉE-DE-CÔTÉ (§loo). On ajuste
   sur n−1 appariements et on mesure l'erreur sur celui qu'on a retiré. Un
   modèle qui ne fait que mémoriser ses points d'ajustement se trahit là.
═══════════════════════════════════════════════ */

export const MODELES_CAMERA = {
  aucune: { id: 'aucune', label: 'aucune', params: 0, minPaires: 0 },
  globale: { id: 'globale', label: 'translation globale', params: 2, minPaires: 3 },
  affineY: { id: 'affineY', label: 'translation affine en y', params: 4, minPaires: 5 },
  // Translation + zoom + roulis : ce que produit RÉELLEMENT une caméra sur
  // trépied. Un panoramique pur déplace tous les points du même vecteur, quelle
  // que soit leur profondeur — c'est une rotation. Ce qui dépend de la position
  // dans l'image, c'est le ZOOM, et il dépend de x autant que de y : une affine
  // en y seul ne peut pas le représenter.
  similitude: { id: 'similitude', label: 'translation + zoom + roulis', params: 4, minPaires: 5 },
  locale: { id: 'locale', label: 'locale (x, y, taille)', params: 8, minPaires: 7 },
  homographie: { id: 'homographie', label: 'homographie', params: 8, minPaires: 7 },
};

export const ORDRE_MODELES = ['aucune', 'globale', 'affineY', 'similitude', 'locale', 'homographie'];

const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const largeur = (b) => Math.max(1, b[2] - b[0]);

function mediane(arr) {
  if (!arr.length) return 0;
  const t = [...arr].sort((a, b) => a - b);
  const i = Math.floor(t.length / 2);
  return t.length % 2 ? t[i] : (t[i - 1] + t[i]) / 2;
}

// ─────────────────────────────────────────────────────────
// MOINDRES CARRÉS PONDÉRÉS, RÉSISTANTS AUX ABERRANTS
// ─────────────────────────────────────────────────────────

/** Résout `A·x = b` par élimination de Gauss avec pivot partiel. */
function resoudre(A, b) {
  const n = A.length;
  const M = A.map((ligne, i) => [...ligne, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-12) return null;         // système dégénéré
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((ligne, i) => ligne[n] / ligne[i]);
}

/**
 * Régression linéaire robuste : moindres carrés repondérés (Huber).
 *
 * Trois passes suffisent. Sans repondération, une seule voiture qui accélère
 * franchement tirerait tout le modèle à elle — c'est exactement ce que la
 * médiane évitait dans le cas de la translation globale.
 */
function ajusterLineaire(X, y, passes = 3) {
  const n = X.length, p = X[0]?.length ?? 0;
  if (n < p || !p) return null;
  let poids = new Array(n).fill(1);
  let beta = null;

  for (let passe = 0; passe < passes; passe++) {
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const w = poids[i];
      for (let j = 0; j < p; j++) {
        b[j] += w * X[i][j] * y[i];
        for (let k = 0; k < p; k++) A[j][k] += w * X[i][j] * X[i][k];
      }
    }
    for (let j = 0; j < p; j++) A[j][j] += 1e-6;             // stabilisation
    beta = resoudre(A, b);
    if (!beta) return null;

    const residus = X.map((xi, i) => Math.abs(y[i] - xi.reduce((t, v, j) => t + v * beta[j], 0)));
    const echelle = Math.max(1, 1.4826 * mediane(residus));
    poids = residus.map(r => (r <= 1.345 * echelle ? 1 : (1.345 * echelle) / r));
  }
  return beta;
}

// ─────────────────────────────────────────────────────────
// MODÈLES
// ─────────────────────────────────────────────────────────

/** Descripteurs d'un appariement : ce dont chaque modèle a le droit de dépendre. */
function traits(boite, modele) {
  const [x, y] = centre(boite);
  const s = largeur(boite);
  if (modele === 'globale') return [1];
  if (modele === 'affineY') return [1, y];
  return [1, x, y, s];                                       // locale
}

/** Homographie par transformation linéaire directe, sur points normalisés. */
function ajusterHomographie(paires) {
  const src = paires.map(p => centre(p.avant));
  const dst = paires.map(p => centre(p.apres));
  const normaliser = (pts) => {
    const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
    const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    const d = pts.reduce((t, p) => t + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
    const e = Math.SQRT2 / d;
    return { T: [e, 0, -e * cx, 0, e, -e * cy], pts: pts.map(p => [(p[0] - cx) * e, (p[1] - cy) * e]) };
  };
  const A = normaliser(src), B = normaliser(dst);

  const M = [], v = [];
  for (let i = 0; i < paires.length; i++) {
    const [x, y] = A.pts[i], [u, w] = B.pts[i];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); v.push(u);
    M.push([0, 0, 0, x, y, 1, -w * x, -w * y]); v.push(w);
  }
  const N = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < 8; j++) {
      b[j] += M[i][j] * v[i];
      for (let k = 0; k < 8; k++) N[j][k] += M[i][j] * M[i][k];
    }
  }
  for (let j = 0; j < 8; j++) N[j][j] += 1e-9;
  const h = resoudre(N, b);
  if (!h) return null;

  // H = T_dst⁻¹ · Ĥ · T_src, appliqué point par point.
  return (boite) => {
    const [x0, y0] = centre(boite);
    const x = (x0 - (-A.T[2] / A.T[0])) * A.T[0];
    const y = (y0 - (-A.T[5] / A.T[4])) * A.T[4];
    const d = h[6] * x + h[7] * y + 1;
    if (Math.abs(d) < 1e-9) return [0, 0];
    const u = (h[0] * x + h[1] * y + h[2]) / d;
    const w = (h[3] * x + h[4] * y + h[5]) / d;
    return [u / B.T[0] + (-B.T[2] / B.T[0]) - x0, w / B.T[4] + (-B.T[5] / B.T[4]) - y0];
  };
}

/**
 * Ajuste un modèle de mouvement caméra sur des appariements.
 *
 * @param {Array<{avant:number[], apres:number[]}>} paires
 * @param {string} id — clé de `MODELES_CAMERA`
 * @returns {{id:string, deplacement:(b:number[])=>number[], n:number,
 *            residuMedian:number, suffisant:boolean}|null}
 */
export function ajusterCamera(paires, id = 'globale') {
  const modele = MODELES_CAMERA[id];
  if (!modele) return null;
  const zero = { id, deplacement: () => [0, 0], n: paires.length, residuMedian: null, suffisant: false };
  if (id === 'aucune') return { ...zero, suffisant: true };
  if (paires.length < modele.minPaires) return zero;

  let deplacement = null;
  if (id === 'homographie') {
    const f = ajusterHomographie(paires);
    if (!f) return zero;
    deplacement = f;
  } else if (id === 'similitude') {
    // dx = a + k·x − r·y ; dy = b + k·y + r·x — un seul système à quatre
    // inconnues, car le zoom et le roulis sont COMMUNS aux deux axes.
    const A = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const v = new Array(4).fill(0);
    for (const paire of paires) {
      const [x, y] = centre(paire.avant);
      const [u, w] = centre(paire.apres);
      for (const [ligne, cible] of [[[1, 0, x, -y], u - x], [[0, 1, y, x], w - y]]) {
        for (let j = 0; j < 4; j++) {
          v[j] += ligne[j] * cible;
          for (let k = 0; k < 4; k++) A[j][k] += ligne[j] * ligne[k];
        }
      }
    }
    for (let j = 0; j < 4; j++) A[j][j] += 1e-6;
    const beta = resoudre(A, v);
    if (!beta) return zero;
    const [a, b, k, r] = beta;
    deplacement = (boite) => {
      const [x, y] = centre(boite);
      return [a + k * x - r * y, b + k * y + r * x];
    };
  } else if (id === 'globale') {
    const dx = mediane(paires.map(p => centre(p.apres)[0] - centre(p.avant)[0]));
    const dy = mediane(paires.map(p => centre(p.apres)[1] - centre(p.avant)[1]));
    deplacement = () => [dx, dy];
  } else {
    const X = paires.map(p => traits(p.avant, id));
    const bx = ajusterLineaire(X, paires.map(p => centre(p.apres)[0] - centre(p.avant)[0]));
    const by = ajusterLineaire(X, paires.map(p => centre(p.apres)[1] - centre(p.avant)[1]));
    if (!bx || !by) return zero;
    deplacement = (boite) => {
      const t = traits(boite, id);
      return [
        t.reduce((s, v, j) => s + v * bx[j], 0),
        t.reduce((s, v, j) => s + v * by[j], 0),
      ];
    };
  }

  const residus = paires.map((p) => {
    const [dx, dy] = deplacement(p.avant);
    const [ax, ay] = centre(p.avant), [bx2, by2] = centre(p.apres);
    return Math.hypot(ax + dx - bx2, ay + dy - by2);
  });
  return { id, deplacement, n: paires.length, residuMedian: Number(mediane(residus).toFixed(2)), suffisant: true };
}

/** Décale une boîte du déplacement prédit par le modèle. */
export function appliquerCamera(modele, boite) {
  if (!modele || !modele.suffisant) return boite;
  const [dx, dy] = modele.deplacement(boite);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return boite;
  return [boite[0] + dx, boite[1] + dy, boite[2] + dx, boite[3] + dy];
}

/**
 * Erreur LAISSÉE-DE-CÔTÉ : ajuste sur n−1 appariements, mesure sur celui
 * qu'on a retiré.
 *
 * C'est le seul juge honnête entre ces modèles. Le résidu d'ajustement décroît
 * toujours quand on ajoute des paramètres — un modèle à huit inconnues pour
 * cinq voitures passerait exactement par tous les points sans rien avoir
 * compris. L'erreur laissée-de-côté, elle, remonte dès que le modèle mémorise
 * au lieu de généraliser.
 *
 * @returns {number|null} médiane des erreurs, ou null si trop peu de données
 */
export function erreurLaisseeDeCote(paires, id) {
  const modele = MODELES_CAMERA[id];
  if (!modele || paires.length <= modele.minPaires) return null;
  const erreurs = [];
  for (let i = 0; i < paires.length; i++) {
    const reste = paires.filter((_, j) => j !== i);
    const ajuste = ajusterCamera(reste, id);
    if (!ajuste?.suffisant) return null;
    const [dx, dy] = ajuste.deplacement(paires[i].avant);
    const [ax, ay] = centre(paires[i].avant), [bx, by] = centre(paires[i].apres);
    erreurs.push(Math.hypot(ax + dx - bx, ay + dy - by));
  }
  return Number(mediane(erreurs).toFixed(2));
}

/**
 * Compare tous les modèles sur les mêmes appariements.
 *
 * Le modèle retenu est le PLUS SIMPLE qui gagne une marge nette. Un gain de
 * quelques pour cent ne justifie pas des paramètres supplémentaires : il ne
 * survivra pas au prochain plan.
 */
export function comparerModeles(paires, { marge = 0.15 } = {}) {
  const resultats = {};
  for (const id of ORDRE_MODELES) {
    const ajuste = ajusterCamera(paires, id);
    resultats[id] = {
      params: MODELES_CAMERA[id].params,
      applicable: !!ajuste?.suffisant,
      residuAjustement: ajuste?.residuMedian ?? null,
      erreurLaisseeDeCote: erreurLaisseeDeCote(paires, id),
    };
  }
  let meilleur = 'aucune', reference = resultats.aucune.erreurLaisseeDeCote ?? Infinity;
  for (const id of ORDRE_MODELES) {
    const e = resultats[id].erreurLaisseeDeCote;
    if (!resultats[id].applicable || e == null) continue;
    if (e < reference * (1 - marge)) { meilleur = id; reference = e; }
  }
  return { resultats, recommande: meilleur };
}
