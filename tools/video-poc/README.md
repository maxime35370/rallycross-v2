# POC — YOLOX sur images de rallycross

**Banc de mesure isolé.** Jamais importé par l'application, aucun accès Firestore, aucun réseau
hors téléchargement du modèle. Répond à **une seule question** :

> **YOLOX trouve-t-il assez de voitures sur NOS images pour justifier cinq jours de V1 ?**

Pas de tracking, pas de ReID, pas d'association aux pilotes, pas de sauvegarde.

---

## État

| | |
|---|---|
| Chaîne technique | ✅ **écrite, testée, validée de bout en bout** |
| Décodage YOLOX | ✅ 15 tests unitaires, alignement vérifié visuellement |
| Modèle | ✅ `yolox_tiny.onnx`, export officiel Megvii, **Apache 2.0** |
| **Corpus rallycross** | ❌ **absent — c'est le seul élément manquant** |
| Rappel / précision | ⏸ **non mesurés** : ils exigent le corpus |

---

## Ce que le banc fait

```
images/*.jpg ──► letterbox 416² ──► YOLOX ──► décodage ──► NMS ──► out/
                                                                   ├── report.html   ← l'outil de mesure
                                                                   ├── results.json
                                                                   └── annotated/*.png
```

**Le banc ne calcule ni rappel ni précision.** Il ne peut pas : il ne sait pas ce qu'est une
voiture ratée. C'est un humain qui, dans `report.html`, **pointe** les voitures manquées et les
fausses détections. Les taux se calculent alors à partir de ces clics, et chaque échec porte une
cause. C'est volontairement contraignant : un rappel compté de tête est un rappel qu'on arrondit
dans le sens qui arrange.

---

## Utilisation

```bash
cd tools/video-poc
npm install                 # onnxruntime-web, jpeg-js, pngjs — aucune brique native
node fetch-models.mjs       # yolox_tiny.onnx (~20 Mo), non versionné
npm test                    # 15 tests du module pur

# … déposer le corpus dans images/ …

npm run detect              # → out/yolox_tiny/report.html
```

Puis **ouvrir `out/yolox_tiny/report.html`** dans un navigateur et faire le relevé.

### Options

| Option | Défaut | Rôle |
|---|---|---|
| `--model <nom>` | `yolox_tiny` | `--model yolox_s --size 640` pour le second essai |
| `--size <n>` | `416` | taille d'entrée du modèle — **640 pour `yolox_s`** |
| `--score <n>` | `0.30` | seuil de confiance |
| `--iou <n>` | `0.45` | seuil de la NMS |
| `--rgb` | *(BGR)* | force RGB — voir « Ordre des canaux » |
| `--all-classes` | *(véhicules)* | ne filtre pas sur car/truck/bus |
| `--repeat <n>` | `3` | passes par image, on retient la médiane |

---

## Constituer le corpus — **c'est ici que se joue la validité du POC**

| Exigence | Valeur |
|---|---|
| Nombre d'images | **10 à 15** |
| Départs différents | **≥ 3** |
| Angles de caméra différents | **≥ 2** |
| Images difficiles (poussière, peloton serré, contre-jour) | **≥ 2** |
| Moment | **majoritairement le premier virage** |

> ### ⚠️ Ne mesure pas sur la ligne de départ
>
> Voitures alignées, écartées, caméra fixe, plein cadre : la détection y sera excellente et
> **ne prédira rien**. La V1 a besoin de l'image du premier virage — peloton compressé,
> poussière, flou de mouvement, occlusions. **Un POC mené sur une image facile est un POC qui
> ment.** Deux ou trois images de grille sont utiles comme point de comparaison, pas comme
> corpus.

### Extraire les images

```bash
# une image précise, qualité maximale
ffmpeg -ss 00:12:34.500 -i meeting.mp4 -frames:v 1 -q:v 2 images/01-loheac-mq2-s3-virage1.jpg
```

Choisir de préférence des départs **déjà analysés** : les 19 départs validés de `startAnalyses`
donnent le nombre exact de voitures réellement au départ, ce qui aide à ne pas se tromper en
comptant.

`images/corpus.json` (facultatif, modèle dans `corpus.example.json`) permet d'afficher le contexte
de chaque image dans le rapport.

---

## Vérité terrain — la règle, à figer AVANT de compter

> **Une voiture compte comme *détectable* lorsque plus de la moitié de sa carrosserie est
> visible.**
>
> Une voiture noyée dans la poussière ou masquée à 90 % n'est **pas** un échec du détecteur et ne
> doit pas être pointée.

Sans cette convention, le taux de rappel dépend de l'humeur de celui qui compte.

### Dans le rapport

| Geste | Effet |
|---|---|
| **clic sur l'image** | marque une **voiture ratée** à cet endroit |
| **clic sur un rectangle** | fait tourner son état : correcte → **faux positif** → **doublon** → correcte |
| **clic sur une étiquette de cause** | attache la cause à l'échec |

Causes proposées : distance · poussière · partiellement cachée · chevauchement · angle caméra ·
flou/mouvement · trop petite · autre.

Le relevé est conservé dans le navigateur (`localStorage`) et exportable en JSON. On peut fermer
la page et reprendre plus tard.

Calculs :

```
détectables = correctes + ratées
rappel      = correctes / détectables
précision   = correctes / (correctes + faux positifs + doublons)
```

---

## Critères de décision — fixés à l'avance

| Rappel | Précision | Verdict |
|---|---|---|
| **≥ 90 %** | ≥ 70 % | ✅ **GO** — V1, puis V2/V3 restent ouverts |
| **80 – 90 %** | ≥ 70 % | 🟡 **GO ASSISTÉ** — V1 vaut le coup ; le tracking (V2) sera fragile |
| **< 80 %** | — | ↻ rejouer le **MÊME corpus** avec `yolox_s` |
| toute valeur | **< 50 %** | ❌ trop de fausses boîtes, l'écran devient illisible |
| **< 60 %** | — | ❌ **NO GO** |

**Pourquoi le rappel prime sur la précision** : en V1 l'association est faite **par clic**. Une
boîte en trop est ignorée par l'opérateur — coût quasi nul. Une voiture manquée doit être saisie
à la main, c'est-à-dire faire le travail que l'automatisation devait éviter.

**Pourquoi 80 % et non 95 %** : `docs/video-analysis/AUTOMATION-ARCHITECTURE.md` §15 fixe ≥ 95 %,
et c'est le bon seuil **pour la chaîne complète**, où une détection manquée casse une piste de
suivi et se propage. Pour le seul détecteur de V1, avec association manuelle, à 80 % de rappel sur
six voitures on en trouve cinq et on en clique une — au lieu d'en cliquer six.

**Pourquoi 60 % est éliminatoire** : en dessous, on retombe exactement sur le constat qui avait
fait abandonner l'approche en révision 5 — *« la voie semi-automatique coûte autant de clics
qu'elle en économise »*.

> **Le chiffre global ne suffit pas.** 92 % de rappel dont les 8 % manquants sont systématiquement
> les voitures de tête au premier virage vaut moins que 84 % répartis au hasard. C'est pourquoi
> chaque échec porte une cause, et pourquoi les images annotées sont produites : **les chiffres
> doivent être vérifiables à l'œil.**

### Ce que ce POC ne mesure PAS

| | Relève de |
|---|---|
| Taux d'**erreur silencieuse** (« 0 obligatoire ») | la ReID — **V3**. Un détecteur ne propose aucune identité |
| Continuité du **suivi** entre images | **V2** |
| **Temps humain** par départ | V1 complet |

---

## Décisions techniques, et pourquoi

### Export ONNX **simple**, pas `end2end`

L'export « end2end » embarque la NMS et aurait fait passer le POC bien plus vite — en laissant
précisément non écrit le code risqué que la V1 doit produire. Le POC aurait alors servi à se
rassurer, pas à décider.

Vérifié sur le fichier réel :

```
entrée   images   [1, 3, 416, 416]
sortie   output   [1, 3549, 85]        3549 = 52² + 26² + 13²   ·   85 = 4 + 1 + 80
```

Les scores ont **déjà** reçu leur sigmoïde ; les coordonnées, non. Leur en appliquer une seconde
ne fait rien planter — cela écrase seulement toutes les confiances vers 0,5.

### Ordre des canaux : **BGR**

Le démonstrateur officiel lit ses images avec OpenCV, donc en BGR, et ne convertit jamais.
Mesuré sur les images de validation : BGR détecte davantage d'objets avec de meilleurs scores
(`zidane.jpg` : 5 objets contre 3). L'option `--rgb` permet de refaire la comparaison.

### `car`, `truck` et `bus` comptent tous comme « voiture »

Une voiture de rallycross, carrossée haut et large, sort régulièrement en `truck`. Les exclure
ferait chuter le rappel pour une raison lexicale, sans rapport avec la capacité du détecteur.

### NMS : les trois classes véhicule partagent **un seul couloir**

**Découvert pendant le POC** : sur l'image de référence de YOLOX, un même pick-up reçoit deux
boîtes quasi superposées — `car` 70 % **et** `truck` 51 %. Une NMS strictement par classe les
garde toutes les deux, car elles ne se concurrencent jamais.

En rallycross, cela produirait **un doublon par véhicule** : précision divisée par deux, et deux
rectangles à trier là où un seul suffit. Les trois classes partagent donc un couloir unique
(`vehicleGroupOf`). Les autres classes gardent le leur : une personne devant une voiture, ce sont
deux objets réels.

C'est exactement le genre de défaut qu'un POC doit trouver — il ne provoque aucune erreur, il
dégrade seulement le chiffre.

---

## Fichiers

| Fichier | Rôle | Réutilisable en V1 |
|---|---|---|
| **`decode.mjs`** | **module PUR** — letterbox, décodage, NMS, repère d'origine, format `renderBoxes()` | ✅ **tel quel, dans le navigateur** |
| `decode.test.mjs` | 15 tests : ordre des ancres, formule, NMS par groupe, bornage | ✅ |
| `image.mjs` | adaptateur Node : JPEG/PNG, letterbox bilinéaire, PNG annoté | ➖ remplacé par `canvas` côté navigateur |
| `run.mjs` | banc : parcours, chronométrage, écriture des sorties | ➖ |
| `report.mjs` | rapport HTML autonome et interactif | ➖ |
| `fetch-models.mjs` | téléchargement des poids officiels | ➖ |

`decode.mjs` est écrit selon la convention maison — calcul pur d'un côté, entrées/sorties de
l'autre, comme `js/calc.js` et `js/projection/*`. Il sort déjà des boîtes au format exact attendu
par `videoPlayer.renderBoxes()` : `{x, y, width, height, confidence, label, status}` en
coordonnées normalisées 0..1.

---

## Mesures déjà effectuées

**Validation de la chaîne** — sur les images de référence publiques de YOLOX/YOLOv5, dont le
contenu est connu :

| Image | Détections | Verdict |
|---|---|---|
| `dog.jpg` | bicycle 88 %, car 70 %, truck 51 %, dog 51 %, cat 58 % | ✅ résultat canonique, boîtes bien alignées |
| `bus.jpg` | bus 94 % + 3 personnes 85–88 % | ✅ |
| `zidane.jpg` | 2 personnes 85–89 %, tie 64 % | ✅ |

Ces images **valident la chaîne technique**. Elles ne disent **rien** de la performance en
rallycross : ce sont des objets nets, proches, en pleine lumière. Elles se re-téléchargent par
`images/_validation/`.

**Temps d'inférence** — `onnxruntime-web` (WASM), conteneur 4 cœurs, YOLOX-tiny 416² :

| Threads | Médiane |
|---|---|
| 1 | 330 ms |
| 2 | 321 ms |
| 4 | **246 ms** |

À lire comme une **borne haute** : un PC de bureau récent fait mieux, et surtout **WebGPU**
(non mesurable ici) est attendu 5 à 10× plus rapide. Une fenêtre de 10 s à 25 im/s reste donc
sous la minute même dans l'hypothèse pessimiste — conforme à l'estimation du §10 du document
d'architecture. **La vitesse n'est pas le facteur décisif ; la qualité de détection l'est.**
