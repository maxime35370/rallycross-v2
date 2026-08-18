"""Banc d'essai OpenCV : perf + comportement en sortie de cadre / coupure / occlusion.

Séquence SYNTHÉTIQUE (donc BEAUCOUP plus facile que de la vidéo TV réelle :
pas de flou de mouvement, pas de poussière, contraste parfait).
Un échec ici est donc d'autant plus significatif.
"""
import time
import cv2
import numpy as np

W, H = 1920, 1080
rng = np.random.default_rng(12345)

# Fond texturé statique (grand, pour simuler un panoramique en le décalant)
BG = rng.integers(60, 120, size=(H, W * 2, 3), dtype=np.uint8)
BG = cv2.GaussianBlur(BG, (9, 9), 0)

CAR_COLORS = [(30, 60, 200), (200, 80, 30), (40, 180, 60),
              (200, 200, 40), (180, 40, 190), (60, 200, 200),
              (120, 120, 250), (250, 140, 60)]


def make_car(w=150, h=90, color=(30, 60, 200), seed=0):
    """Petit motif de voiture texturé (pour que le tracker ait de quoi accrocher)."""
    r = np.random.default_rng(seed)
    car = np.full((h, w, 3), color, dtype=np.uint8)
    car[int(h * .15):int(h * .45), int(w * .2):int(w * .8)] = (240, 240, 240)  # pare-brise
    car[int(h * .75):, :] = (25, 25, 25)                                        # bas / pneus
    noise = r.integers(-18, 18, size=(h, w, 3))
    return np.clip(car.astype(int) + noise, 0, 255).astype(np.uint8)


def render(frame_idx, positions, pan=0, cut=False, cars=None):
    """Compose une image : fond décalé (panoramique) + voitures aux positions données."""
    off = pan % W
    if cut:                              # changement de plan : fond radicalement différent
        img = np.full((H, W, 3), 200, dtype=np.uint8)
        img[::7, :] = 150
    else:
        img = BG[:, off:off + W].copy()
    for (x, y), car in zip(positions, cars):
        h, w = car.shape[:2]
        x, y = int(x), int(y)
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        if x1 <= x0 or y1 <= y0:
            continue                     # entièrement hors cadre
        img[y0:y1, x0:x1] = car[y0 - y:y1 - y, x0 - x:x1 - x]
    return img


def new_tracker(kind):
    return cv2.TrackerCSRT_create() if kind == 'CSRT' else cv2.TrackerKCF_create()


def iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    return inter / (aw * ah + bw * bh - inter)


# ─────────────────────────────────────────────────────────────
# TEST A — performance pure : N cibles, panoramique lent
# ─────────────────────────────────────────────────────────────
def test_perf(kind, n_targets, n_frames=150):
    cars = [make_car(color=CAR_COLORS[i], seed=i) for i in range(n_targets)]
    pos = [[200 + i * 190, 500 + (i % 2) * 60] for i in range(n_targets)]
    frame = render(0, pos, cars=cars)
    trackers = []
    for i in range(n_targets):
        t = new_tracker(kind)
        t.init(frame, (pos[i][0], pos[i][1], cars[i].shape[1], cars[i].shape[0]))
        trackers.append(t)
    t0 = time.perf_counter()
    ok_count = 0
    for f in range(1, n_frames):
        for i in range(n_targets):
            pos[i][0] += 6                    # voitures avancent
            pos[i][1] += 0.6 * np.sin(f / 12 + i)
        frame = render(f, pos, pan=f * 3, cars=cars)   # + panoramique caméra
        for t in trackers:
            ok, _ = t.update(frame)
            ok_count += ok
    dt = time.perf_counter() - t0
    per_frame = dt / (n_frames - 1) * 1000
    return per_frame, per_frame / n_targets, ok_count / ((n_frames - 1) * n_targets)


# ─────────────────────────────────────────────────────────────
# TEST B — la voiture sort complètement du cadre puis revient
# ─────────────────────────────────────────────────────────────
def test_exit_reentry(kind):
    car = make_car(color=CAR_COLORS[0], seed=0)
    cw, ch = car.shape[1], car.shape[0]
    frame = render(0, [(800, 500)], cars=[car])
    t = new_tracker(kind)
    t.init(frame, (800, 500, cw, ch))
    log = []
    for f in range(1, 121):
        if f < 40:       x = 800 + f * 30          # part vers la droite
        elif f < 80:     x = W + 300               # HORS CADRE (40 images ≈ 1,6 s à 25 fps)
        else:            x = 800 + (120 - f) * 30  # revient à sa place
        frame = render(f, [(x, 500)], cars=[car])
        ok, box = t.update(frame)
        truth_visible = -cw < x < W
        log.append((f, ok, tuple(int(v) for v in box), truth_visible,
                    iou(box, (x, 500, cw, ch)) if truth_visible else 0.0))
    return log


# ─────────────────────────────────────────────────────────────
# TEST C — changement de plan (cut) brutal
# ─────────────────────────────────────────────────────────────
def test_cut(kind):
    car = make_car(color=CAR_COLORS[1], seed=1)
    cw, ch = car.shape[1], car.shape[0]
    frame = render(0, [(700, 500)], cars=[car])
    t = new_tracker(kind)
    t.init(frame, (700, 500, cw, ch))
    out = []
    for f in range(1, 31):
        cut = f >= 15                              # cut à l'image 15
        x = 700 + f * 12
        y = 500 if not cut else 250                # nouvel angle => autre position
        frame = render(f, [(x, y)], cut=cut, cars=[car])
        ok, box = t.update(frame)
        out.append((f, cut, ok, iou(box, (x, y, cw, ch))))
    return out


# ─────────────────────────────────────────────────────────────
# TEST D — deux voitures se croisent (occultation) couleurs proches
# ─────────────────────────────────────────────────────────────
def test_occlusion(kind):
    c1 = make_car(color=(40, 70, 200), seed=10)
    c2 = make_car(color=(55, 85, 215), seed=11)     # livrée volontairement proche
    cw, ch = c1.shape[1], c1.shape[0]
    p1, p2 = [500, 480], [1200, 500]
    frame = render(0, [tuple(p1), tuple(p2)], cars=[c1, c2])
    t1, t2 = new_tracker(kind), new_tracker(kind)
    t1.init(frame, (p1[0], p1[1], cw, ch))
    t2.init(frame, (p2[0], p2[1], cw, ch))
    swap = False
    for f in range(1, 81):
        p1[0] += 9                                   # 1 rattrape et dépasse 2
        p2[0] += 1
        frame = render(f, [tuple(p1), tuple(p2)], cars=[c1, c2])
        ok1, b1 = t1.update(frame)
        ok2, b2 = t2.update(frame)
        # échange d'identité = le tracker 1 colle mieux à la cible 2 (et inversement)
        if iou(b1, (p2[0], p2[1], cw, ch)) > 0.5 and iou(b1, (p1[0], p1[1], cw, ch)) < 0.3:
            swap = True
        if iou(b2, (p1[0], p1[1], cw, ch)) > 0.5 and iou(b2, (p2[0], p2[1], cw, ch)) < 0.3:
            swap = True
    return dict(final_iou_1=round(iou(b1, (p1[0], p1[1], cw, ch)), 2),
                final_iou_2=round(iou(b2, (p2[0], p2[1], cw, ch)), 2),
                ok1=ok1, ok2=ok2, identity_swap=swap)


if __name__ == '__main__':
    print("OpenCV", cv2.__version__, "| 1920x1080 synthétique\n")
    print("═══ TEST A — PERFORMANCE (150 images, panoramique) ═══")
    print(f"{'tracker':8} {'cibles':>7} {'ms/image':>10} {'ms/cible':>10} {'fps':>7}  {'ok=true':>8}")
    for kind in ('KCF', 'CSRT'):
        for n in (3, 5, 8):
            pf, pt, okr = test_perf(kind, n)
            print(f"{kind:8} {n:>7} {pf:>10.1f} {pt:>10.1f} {1000/pf:>7.1f}  {okr*100:>7.0f}%")

    for kind in ('CSRT', 'KCF'):
        print(f"\n═══ TEST B — {kind} : sortie complète du cadre puis retour ═══")
        log = test_exit_reentry(kind)
        phases = [("avant sortie", [r for r in log if r[0] < 40]),
                  ("HORS CADRE  ", [r for r in log if 40 <= r[0] < 80]),
                  ("après retour", [r for r in log if r[0] >= 82])]
        for label, rows in phases:
            if not rows:
                continue
            ok_rate = sum(r[1] for r in rows) / len(rows)
            vis = [r[4] for r in rows if r[3]]
            miou = sum(vis) / len(vis) if vis else float('nan')
            print(f"  {label} : ok=true {ok_rate*100:5.0f}%   IoU moyen vs vérité "
                  f"{miou:.2f}" if vis else
                  f"  {label} : ok=true {ok_rate*100:5.0f}%   (cible invisible)")
        reacq = [r for r in log if r[0] >= 82 and r[4] > 0.5]
        print(f"  → ré-acquisition automatique après retour : "
              f"{'OUI' if len(reacq) > 15 else 'NON'} ({len(reacq)}/39 images correctes)")

    for kind in ('CSRT', 'KCF'):
        print(f"\n═══ TEST C — {kind} : changement de plan ═══")
        rows = test_cut(kind)
        after = [r for r in rows if r[1]]
        print(f"  ok=true après le cut : {sum(r[2] for r in after)}/{len(after)} images")
        print(f"  IoU moyen après cut  : {sum(r[3] for r in after)/len(after):.2f}")

    for kind in ('CSRT', 'KCF'):
        print(f"\n═══ TEST D — {kind} : croisement / occultation, livrées proches ═══")
        print("  ", test_occlusion(kind))
