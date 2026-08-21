# `yolox-poc` — banc de détection YOLOX-tiny

Répond à **une seule question** : sur une image de départ de rallycross, combien de voitures
YOLOX-tiny voit-il, et lesquelles rate-t-il ?

Le modèle propose, **tu tranches**. Rappel et précision ne sont calculés qu'à partir de tes
annotations : rien ici ne suppose que le modèle connaît la vérité terrain.

```
6 PNG + corpus.json  →  détections + boîtes  →  ton annotation  →  rappel / précision / verdict
```

---

## Ce que c'est, et ce que ce n'est pas

| | |
|---|---|
| Modèles | **YOLOX-tiny** (416 px, ~20 Mo) et **YOLOX-s** (640 px, ~35 Mo), ONNX, **Apache 2.0** |
| Exécution | **ONNX Runtime Web** (WebAssembly), dans ton navigateur |
| Où vont les images | **nulle part.** Le navigateur les ouvre depuis le disque, l'inférence est locale |
| Classes | `car`, `truck`, `bus` uniquement — voir plus bas |
| Étape couverte | **① détection.** Ni suivi, ni association voiture ↔ pilote, ni ordre au V1 |

C'est aussi le chemin d'exécution retenu par
[`AUTOMATION-ARCHITECTURE.md`](../../docs/video-analysis/AUTOMATION-ARCHITECTURE.md) §3 :
navigateur seul, application statique inchangée, aucun service à installer.

---

## Utilisation

```powershell
npm install                              # une fois : installe onnxruntime-web
node tools\yolox-poc\serve.mjs           # télécharge le modèle au premier lancement
```

Ouvre l'URL affichée, puis sélectionne **les images du corpus et son `corpus.json`** — le manifeste
donne la zone de chaque image et l'ordre départ → sortie V1, au lieu de l'ordre alphabétique.

### Comparer YOLOX-tiny et YOLOX-s

Le sélecteur **Modèle** relance les mêmes images avec l'autre modèle. Le pré-traitement, le
décodage, la NMS et les seuils sont rigoureusement identiques — c'est la condition pour que la
comparaison ait un sens. Seule la taille d'entrée suit le modèle, parce qu'elle lui appartient :

| | entrée | ancres | poids |
|---|---|---|---|
| YOLOX-tiny | 416 × 416 | 3 549 | ~20 Mo |
| YOLOX-s | 640 × 640 | 8 400 | ~35 Mo |

Décoder les 8 400 ancres de `s` avec les grilles de `tiny` ne lèverait aucune erreur : cela
produirait des boîtes fausses. `assertAnchorCount()` vérifie donc la correspondance avant tout
décodage, et `tests/yoloxDetect.test.js` couvre les deux sens de l'incompatibilité.

**Ce qui est conservé au changement de modèle** : `carsVisible`, `carsDetectable` et
`carsOrderCritical` — la vérité terrain appartient à l'image, pas au modèle, et la ré-annoter
ferait porter les deux passes sur des références différentes.
**Ce qui repart à zéro** : `missed` et les verdicts par détection, qui dépendent de ce que le
modèle a trouvé.

Chaque export porte le modèle utilisé et un nom de fichier distinct —
`rapport-detection-tiny.json`, `rapport-detection-s.json` — pour qu'un rapport n'écrase jamais
l'autre.

Les modèles sont téléchargés à la demande dans `tools/yolox-poc/modele/` (dossier ignoré par git).
`--precharger` les récupère tous d'avance.

Pour chaque image : les boîtes et leurs scores, la liste des détections, et tes champs d'annotation.

| Ton annotation | Ce que c'est |
|---|---|
| voitures visibles | tout ce qu'on distingue, même un bout d'aileron |
| **détectables** | plus de la moitié de la carrosserie visible — **dénominateur du rappel** |
| critiques pour l'ordre V1 | voitures dont l'absence fausserait le classement au premier virage |
| ratées | détectables non détectées |
| ratées critiques | parmi elles, celles critiques pour l'ordre |

Chaque détection se juge d'un clic : **validée → faux positif → doublon**. « Télécharger l'image
annotée » produit le PNG avec les boîtes, pour juger les ratés à l'œil.

---

## Deux décisions qui changent les chiffres

### Une NMS commune aux classes véhicule

Une voiture de rallycross n'existe pas dans COCO. Selon l'angle et la carrosserie, le modèle la
range tantôt en `car`, tantôt en `truck`, parfois en `bus`. **Mesuré sur l'image de référence de
YOLOX** : le même véhicule ressort en `car` à 0,770 **et** en `truck` à 0,465.

Une suppression des non-maxima classe par classe garderait les deux et compterait **deux véhicules
là où il n'y en a qu'un** — rappel gonflé, précision ruinée. La fusion est donc commune aux trois
classes. La détection conservée garde la trace des étiquettes concurrentes dans `alsoDetectedAs` :
l'hésitation du modèle est une information, pas un déchet.

### Le seuil de confiance est explicite, et il n'est pas là pour flatter le résultat

Défaut **0,30**. Sous 0,25 la page affiche un avertissement : on gagne toujours du rappel en
abaissant le seuil, mais on le paie en faux positifs, et le chiffre cesse d'être comparable. Le seuil
retenu est écrit dans le rapport exporté.

---

## Mesures

Calculées **uniquement** à partir de l'annotation :

```
rappel            = (détectables − ratées) / détectables
précision         = validées / (validées + rejetées)
rappel critique   = (critiques − ratées critiques) / critiques
```

L'agrégat **somme les comptes** au lieu de moyenner les taux : une image à 6 voitures ne doit pas
peser autant qu'une image à 2. La page signale une annotation qui se contredit — si
`détectables − ratées` ne vaut pas le nombre de détections validées, le chiffre ne veut rien dire.

Règle de décision, **sur l'étape ① seulement** :

| Rappel | Suite |
|---|---|
| ≥ 90 % | GO |
| 80–90 % | GO assisté |
| < 80 % | tester YOLOX-s sur **exactement** ces images |

Un bon rappel de détection ne garantit pas un ordre V1 juste : les erreurs des étapes ② suivi,
③ association et ④ ordonnancement s'y ajoutent. C'est pourquoi le rappel critique est compté à part.

---

## Validation du portage

Le pré-traitement, le décodage et la fusion sont en JavaScript pur
([`lib/detect.mjs`](lib/detect.mjs)), couverts par `tests/yoloxDetect.test.js` (26 assertions).

L'inférence elle-même a été vérifiée **par comparaison avec l'implémentation de référence YOLOX**
(numpy + onnxruntime), sur l'image de contrôle du projet :

| | référence Python | ce portage JS |
|---|---|---|
| YOLOX-tiny, image en 416×416 | `truck 0.619 [255.1, 55.6, 375.1, 122.0]` | `truck 0.619 [255, 56, 375, 122]` |
| YOLOX-s, image en 640×640 | `truck 0.764 [384.3, 82.4, 579.6, 190.7]` | `truck 0.764 [384, 82, 580, 191]` |

**Identique.** Sur une image qui doit être réduite, les scores diffèrent de quelques centièmes : le
filtre de redimensionnement du canvas n'est pas celui de PIL. L'écart est constant d'un modèle à
l'autre, donc une comparaison YOLOX-tiny / YOLOX-s sur les mêmes images reste valide.

```powershell
node tools\yolox-poc\serve.mjs --check <image.jpg> --modele s    # contrôle automatique en Chromium
```

---

## Licences

- **YOLOX** (code et poids `tiny` et `s`) : Apache 2.0 — Megvii.
- **ONNX Runtime Web** : MIT — Microsoft.
- Le modèle est téléchargé depuis la page des versions du projet YOLOX, dans
  `tools/yolox-poc/modele/`, dossier ignoré par git.

Les images de corpus sont des extraits de retransmission : elles restent locales, ne sont pas
versionnées, et ne doivent pas être publiées (voir §9 de `EXTRACTION-YOUTUBE.md`).
