"""SUIVI DE RÉFÉRENCE — ByteTrack (supervision, MIT) sur NOS détections.

    python3 tools/yolox-poc/bytetrack.py <detections.json> <sortie.json> [pas]

Le but n'est pas d'avoir un second tracker : c'est d'avoir un TÉMOIN. Tant
qu'on ne compare qu'à soi-même, on ne sait pas si nos difficultés viennent du
problème ou de notre implémentation.

La comparaison n'a de sens que si l'entrée est la même. Le dump de détections
est produit par la même page, au même seuil (bande basse 0,10) et avec la même
fusion NMS (IoU 0,45) que le suivi : ByteTrack voit donc exactement les boîtes
que voit notre tracker, aux mêmes instants.

Les réglages sont mis en correspondance terme à terme, pas choisis :

    track_activation_threshold   0,30   <->  highScore
    minimum_matching_threshold   0,80   <->  iouMatch 0,20  (coût = 1 - IoU)
    lost_track_buffer               8   <->  dureeAvantAbandon 0,8 s à 10 Hz
    minimum_consecutive_frames      3   <->  detectionsConfirmation

ByteTrack ignore les coupures de plan : c'est son hypothèse de conception, pas
un défaut de réglage. On le mesure, on ne le lui reproche pas.
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import numpy as np  # noqa: E402
import supervision as sv  # noqa: E402
from supervision.tracker.byte_tracker.core import ByteTrack  # noqa: E402

METHODE = "bytetrack/supervision-0.30"

def main():
    if len(sys.argv) < 3:
        print("\n  usage : python3 tools/yolox-poc/bytetrack.py "
              "<detections.json> <sortie.json> [pas]\n", file=sys.stderr)
        return 1
    fDet, fOut = sys.argv[1], sys.argv[2]
    pas = float(sys.argv[3]) if len(sys.argv) > 3 else 0.1

    dump = json.load(open(fDet))
    images = dump["images"]
    tDebut, tFin = dump["fenetre"]["tDebut"], dump["fenetre"]["tFin"]

    # Les instants du suivi, et pour chacun l'image la plus proche du dump.
    # On ne rééchantillonne pas : on choisit, comme le fait la page.
    instants = []
    t = tDebut
    while t <= tFin + 1e-9:
        proche = min(images, key=lambda im: abs(im["t"] - t))
        if abs(proche["t"] - t) <= 1.0 / 120:
            instants.append((round(t, 3), proche))
        t += pas

    suivi = ByteTrack(
        track_activation_threshold=0.30,
        minimum_matching_threshold=0.80,
        lost_track_buffer=8,
        minimum_consecutive_frames=3,
        frame_rate=int(round(1 / pas)),
    )

    journal = []
    for tt, im in instants:
        dets = [d for d in im["detections"] if d["score"] >= 0.10]
        if dets:
            det = sv.Detections(
                xyxy=np.array([d["box"] for d in dets], dtype=float),
                confidence=np.array([d["score"] for d in dets], dtype=float),
                class_id=np.array([2] * len(dets)),
            )
        else:
            det = sv.Detections.empty()
        r = suivi.update_with_detections(det)

        tracks = []
        for k in range(len(r)):
            boite = [float(v) for v in r.xyxy[k]]
            ident = int(r.tracker_id[k])
            tracks.append({
                "id": ident,
                # Sans réattribution, l'identité logique EST l'identifiant :
                # ByteTrack ne prétend rien relier à travers une coupure.
                "identiteLogique": ident,
                "ancetre": None,
                "suspendue": False,
                "box": [round(v) for v in boite],
                "boiteAvant": None,
                "boiteCompensee": None,
                "boiteAssociee": [round(v) for v in boite],
                "state": "detected",
                "score": float(r.confidence[k]) if r.confidence is not None else None,
                "confirmee": True,
                "ambiguous": False,
                "occludedBy": None,
            })
        journal.append({
            "t": tt,
            "detections": {"total": len(dets),
                           "fortes": sum(1 for d in dets if d["score"] >= 0.30),
                           "faibles": sum(1 for d in dets if d["score"] < 0.30),
                           "fusions": 0, "doublons": 0},
            "counts": {"detected": len(tracks), "predicted": 0,
                       "occluded": 0, "tentative": 0},
            "association": None, "biais": {"dx": 0, "dy": 0, "n": 0},
            "rattrapage": None,
            "tracks": tracks,
        })

    sortie = {
        "schema": "rx-tracking/1",
        "modele": METHODE,
        "methodeReattribution": None,
        # ByteTrack ne connaît pas les coupures : on l'écrit, pour qu'aucune
        # lecture du rapport ne laisse croire qu'il en a tenu compte.
        "coupures": [],
        "reglages": {
            "pas": pas, "frequenceHz": round(1 / pas),
            "seuilConfiance": 0.30, "bandeBasse": 0.10, "iouFusion": 0.45,
            "compensationCamera": False,
            "tracker": {"provenance": METHODE,
                        "track_activation_threshold": 0.30,
                        "minimum_matching_threshold": 0.80,
                        "lost_track_buffer": 8,
                        "minimum_consecutive_frames": 3},
        },
        "extrait": dump.get("extrait"),
        "fenetre": {"debut": tDebut, "fin": tFin},
        "mesures": None,          # calculées par `comparer.mjs`, pas ici
        "refus": [], "signaux": None, "apparence": None, "plans": None,
        "journal": journal,
    }
    json.dump(sortie, open(fOut, "w"), ensure_ascii=False)
    tenues = len({t["id"] for t in journal[-1]["tracks"]}) if journal else 0
    print(f"  {METHODE} · {len(journal)} instants · "
          f"{len({tr['id'] for j in journal for tr in j['tracks']})} identités créées · "
          f"{tenues} présentes au dernier instant")
    print(f"  → {fOut}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
