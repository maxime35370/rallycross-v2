"""Test du COEUR de l'architecture proposée : ré-identification en ENSEMBLE FERMÉ après coupure.

On ne teste PAS un réseau de neurones. On teste la formulation du problème :
  - N voitures connues à l'avance (galerie construite au ré-ancrage initial)
  - après une coupure : N détections, viewpoint/échelle/luminosité différents
  - descripteur de livrée simple (HSV par cellules spatiales)
  - + a priori d'ordre (l'ordre ne peut pas beaucoup changer en 0,4 s)
  - appariement global par Hongrois (et non argmax indépendant)
  - score de confiance = MARGE d'appariement (coût si on interdit cette paire)

Question : cette formulation suffit-elle à proposer des identités correctes,
et la marge signale-t-elle correctement les cas ambigus ?
"""
import itertools
import cv2
import numpy as np

rng = np.random.default_rng(7)

# ── 5 livrées : 4 bien distinctes, 2 volontairement TRÈS proches (cas dur) ──
LIVERIES = {
    12: dict(base=(200, 40, 40),  stripe=(255, 255, 255), pattern='stripe'),
    44: dict(base=(40, 160, 60),  stripe=(20, 20, 20),    pattern='half'),
    7:  dict(base=(40, 80, 210),  stripe=(250, 210, 40),  pattern='stripe'),
    21: dict(base=(230, 190, 40), stripe=(40, 40, 40),    pattern='half'),
    5:  dict(base=(48, 88, 205),  stripe=(245, 205, 45),  pattern='stripe'),  # ≈ n°7 !
}


def render_car(num, w=140, h=90, brightness=1.0, seed=0, blur=0):
    """Rend une voiture avec sa livrée, sous une luminosité/échelle/flou donnés."""
    spec = LIVERIES[num]
    img = np.full((h, w, 3), spec['base'], dtype=np.uint8)
    if spec['pattern'] == 'stripe':
        img[:, int(w * .40):int(w * .60)] = spec['stripe']
    else:
        img[:, int(w * .5):] = spec['stripe']
    img[int(h * .12):int(h * .40), int(w * .18):int(w * .82)] = (235, 240, 245)  # pare-brise
    img[int(h * .78):, :] = (28, 28, 28)                                         # bas/pneus
    r = np.random.default_rng(seed)
    img = np.clip(img.astype(float) * brightness + r.integers(-12, 12, img.shape), 0, 255).astype(np.uint8)
    if blur:
        img = cv2.GaussianBlur(img, (blur | 1, blur | 1), 0)
    return img


def descriptor(patch, cells=(3, 2), bins=(8, 4, 4)):
    """Descripteur de livrée : histogramme HSV par cellule spatiale, normalisé L2.

    Choix délibéré : PAS d'invariance à la couleur — ici la couleur EST le signal.
    (Les réseaux ReID génériques sont entraînés à être invariants à ce qui nous sert.)
    """
    patch = cv2.resize(patch, (96, 96))
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    ch, cw = 96 // cells[0], 96 // cells[1]
    feats = []
    for i in range(cells[0]):
        for j in range(cells[1]):
            cell = hsv[i * ch:(i + 1) * ch, j * cw:(j + 1) * cw]
            hist = cv2.calcHist([cell], [0, 1, 2], None, bins, [0, 180, 0, 256, 0, 256])
            feats.append(cv2.normalize(hist, None).flatten())
    v = np.concatenate(feats)
    return v / (np.linalg.norm(v) + 1e-9)


def hungarian(cost):
    """Appariement optimal (petit N → énumération exacte, pas besoin de scipy)."""
    n = cost.shape[0]
    best, best_perm = np.inf, None
    for perm in itertools.permutations(range(n)):
        c = sum(cost[i, perm[i]] for i in range(n))
        if c < best:
            best, best_perm = c, perm
    return best_perm, best


def hungarian_forbidding(cost, i0, j0):
    """Meilleur appariement qui INTERDIT la paire (i0,j0) → sert à calculer la marge."""
    n = cost.shape[0]
    best = np.inf
    for perm in itertools.permutations(range(n)):
        if perm[i0] == j0:
            continue
        best = min(best, sum(cost[i, perm[i]] for i in range(n)))
    return best


def order_prior(rank_before, rank_after, n, dt_s, max_change_per_s=2.5):
    """Coût lié à l'a priori d'ordre : en dt secondes, l'ordre change peu."""
    tolerance = max(0.5, max_change_per_s * dt_s)
    d = abs(rank_before - rank_after)
    return 0.0 if d <= tolerance else (d - tolerance) ** 2 / n


def run_case(label, dt_s, brightness, scale, blur, shuffle, w_app=1.0, w_ord=0.6):
    nums = [12, 44, 7, 21, 5]
    # ── Galerie : construite au ré-ancrage initial (caméra 1) ──
    gallery = {n: descriptor(render_car(n, brightness=1.0, seed=n)) for n in nums}
    rank_before = {n: i for i, n in enumerate(nums)}          # ordre connu avant la coupure

    # ── Après la coupure : autre échelle, autre luminosité, flou, ordre légèrement permuté ──
    order_after = list(nums)
    for a, b in shuffle:
        order_after[a], order_after[b] = order_after[b], order_after[a]
    w = int(140 * scale)
    h = int(90 * scale)
    detections = [(n, descriptor(render_car(n, w=w, h=h, brightness=brightness,
                                            seed=n + 100, blur=blur)))
                  for n in order_after]

    # ── Matrice de coût : apparence + a priori d'ordre ──
    cost = np.zeros((len(nums), len(detections)))
    for i, gnum in enumerate(nums):
        for j, (dnum, dfeat) in enumerate(detections):
            app = 1.0 - float(np.dot(gallery[gnum], dfeat))     # distance cosinus
            ordc = order_prior(rank_before[gnum], j, len(nums), dt_s)
            cost[i, j] = w_app * app + w_ord * ordc

    perm, total = hungarian(cost)
    rows, n_ok, n_flag, n_silent = [], 0, 0, 0
    for i, gnum in enumerate(nums):
        j = perm[i]
        truth = detections[j][0]
        margin = hungarian_forbidding(cost, i, j) - total       # ↑ marge = ↑ certitude
        conf = 'green' if margin > 0.06 else ('yellow' if margin > 0.015 else 'red')
        correct = (truth == gnum)
        if correct and conf == 'green':
            n_ok += 1
        elif not correct and conf == 'green':
            n_silent += 1                                       # ❌ ERREUR SILENCIEUSE
        else:
            n_flag += 1
        rows.append((gnum, truth, correct, round(margin, 4), conf))
    return label, rows, dict(auto_ok=n_ok, flagged=n_flag, silent_error=n_silent)


CASES = [
    # label,                              dt,   lum,  échelle, flou, permutations
    ("coupure courte, cadrage proche",    0.4,  1.00, 1.00,  0,  []),
    ("coupure + zoom (x1,6)",             0.4,  1.00, 1.60,  0,  [(1, 2)]),
    ("coupure + dézoom (x0,55) + flou",   0.6,  1.00, 0.55,  5,  [(1, 2)]),
    ("coupure + contre-jour (lum 0,55)",  0.5,  0.55, 1.00,  3,  [(0, 1)]),
    ("coupure + surexposition (1,45)",    0.5,  1.45, 1.20,  3,  [(2, 3)]),
    ("coupure longue 3 s, ordre remué",   3.0,  1.00, 1.10,  3,  [(0, 2), (3, 4)]),
    ("cumul difficile : lum+zoom+flou",   0.8,  0.60, 1.70,  7,  [(1, 3)]),
]

if __name__ == '__main__':
    print("Ensemble fermé de 5 voitures — n°7 et n°5 ont des livrées quasi identiques (cas dur)\n")
    tot = dict(auto_ok=0, flagged=0, silent_error=0)
    for args in CASES:
        label, rows, st = run_case(*args)
        for k in tot:
            tot[k] += st[k]
        print(f"── {label}")
        for gnum, truth, ok, margin, conf in rows:
            mark = {'green': '🟢', 'yellow': '🟡', 'red': '🔴'}[conf]
            verdict = "OK" if ok else "FAUX"
            flag = "  ❌ ERREUR SILENCIEUSE" if (not ok and conf == 'green') else ""
            print(f"   n°{gnum:<3} → détection n°{truth:<3} {verdict:<4} "
                  f"marge={margin:6.3f} {mark}{flag}")
        print(f"   → auto ✅ {st['auto_ok']}  signalé ⚠️ {st['flagged']}  "
              f"silencieux ❌ {st['silent_error']}\n")
    n = sum(tot.values())
    print("═══ TOTAL sur", n, "identifications ═══")
    print(f"  ✅ correctes et 🟢          : {tot['auto_ok']:3}  ({tot['auto_ok']/n*100:.0f} %)")
    print(f"  ⚠️  signalées (🟡/🔴)        : {tot['flagged']:3}  ({tot['flagged']/n*100:.0f} %)")
    print(f"  ❌ ERREURS SILENCIEUSES     : {tot['silent_error']:3}  "
          f"({tot['silent_error']/n*100:.0f} %)   ← doit être 0")

    # ── Contre-épreuve : que se passe-t-il SANS l'a priori d'ordre ? ──
    print("\n═══ CONTRE-ÉPREUVE : apparence seule, sans a priori d'ordre ═══")
    tot2 = dict(auto_ok=0, flagged=0, silent_error=0)
    for args in CASES:
        _, _, st = run_case(*args, w_ord=0.0)
        for k in tot2:
            tot2[k] += st[k]
    n2 = sum(tot2.values())
    print(f"  ✅ {tot2['auto_ok']}  ⚠️ {tot2['flagged']}  ❌ silencieuses {tot2['silent_error']}"
          f"  ({tot2['silent_error']/n2*100:.0f} %)")
