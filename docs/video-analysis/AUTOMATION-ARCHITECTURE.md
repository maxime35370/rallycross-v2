# Automatisation visuelle intégrée : YOLO + tracking + ReID assistée

> Analyse technique. **Aucun code applicatif.** Réponse aux 15 questions posées.
>
> **Ta critique était fondée.** Mon évaluation précédente a testé *CSRT + ré-ancrage manuel* et en a
> conclu que « l'automatisation n'apporte pas assez ». Elle n'a **pas** testé
> *YOLO + ReID en ensemble fermé + validation humaine*, qui est une architecture différente et
> exploite un atout que je n'avais pas mis à profit : **nous connaissons les 3 à 8 voitures à
> l'avance**. J'ai donc mesuré le cœur de ta proposition, et le résultat change ma recommandation.

---

## Résumé exécutif

| Question | Réponse courte |
|---|---|
| Tracking visuel intégré dans Rallycross V2 ? | **Oui**, et sans quitter l'architecture statique actuelle |
| Bounding boxes en temps réel dans le lecteur ? | **Oui** — `<video>` + `<canvas>` en surimpression, analyse pré-calculée puis rejouée |
| Architecture recommandée | **A — navigateur seul** (ONNX Runtime Web), Tauri gardé en option future sans coût d'attente |
| ReID en ensemble fermé après coupure ? | **Oui, crédible** — mesuré : 86 % d'identifications correctes automatiques, **0 erreur silencieuse** |
| 100 % gratuit / local ? | **Oui** — voir §11–12, tout en Apache/MIT/BSD |
| Poids total | **~40–60 Mo** de modèles, chargés à la demande |
| Recommandation finale | **Manuel + outil visuel YOLO + ReID assistée**, construit par étapes, POC d'abord |

**Ce qui a changé mon avis** : le problème n'est pas « suivre des voitures », c'est **apparier N
détections avec N pilotes connus**. C'est un problème d'affectation en ensemble fermé, résoluble par
l'algorithme hongrois avec un coût combinant plusieurs signaux. C'est structurellement bien plus
robuste que du tracking par apparence, et c'est bien moins coûteux à développer que je ne le
pensais.

---

## 1. Peut-on construire le tracking visuel directement dans Rallycross V2 ?

**Oui.** Trois briques, toutes disponibles côté navigateur aujourd'hui :

| Besoin | Moyen | Disponible ? |
|---|---|---|
| Lire un fichier vidéo local | `<input type="file">` ou `showOpenFilePicker()` + `URL.createObjectURL` | ✅ |
| Accéder aux pixels image par image | `<video>` + `requestVideoFrameCallback` → `drawImage` sur canvas | ✅ |
| Inférence de réseau de neurones | **ONNX Runtime Web** (WebGPU ou WASM SIMD) | ✅ |
| Tracking (Kalman + association) | **~300 lignes de JS** — ByteTrack est un algorithme, pas une bibliothèque | ✅ |
| Descripteur de livrée + appariement | canvas + JS pur, coût négligeable (mesuré §10) | ✅ |
| Affichage des boîtes | `<canvas>` en surimpression | ✅ |

⚠️ **Correction d'une erreur de la révision 5.** J'avais écarté la voie navigateur en écrivant que
« l'écosystème de tracking en JS est pauvre ». C'était mal posé : **nous n'avons pas besoin d'une
bibliothèque de tracking JS.** Nous avons besoin de deux modèles ONNX (détection, éventuellement
ReID) et d'environ 300 lignes de code d'association — que l'on écrit soi-même, ce qui est d'ailleurs
préférable ici puisque le coût d'association doit intégrer nos signaux métier (§9).

**Contrainte réelle à traiter** : le poids des modèles face au service worker. `sw.js` maintient une
liste d'assets explicite ; y ajouter 40 Mo de modèles serait néfaste (pré-cache au premier
chargement pour tous les utilisateurs, dont le mode spectateur). Solution : les modèles sont
**chargés à la demande** au premier usage du module d'analyse et stockés dans **IndexedDB** ou via
l'API `Cache` sous une clé distincte — jamais dans `ASSET_PATHS`. Le mode spectateur et les overlays
OBS ne téléchargent donc rien.

---

## 2. Peut-on afficher les bounding boxes en temps réel dans le lecteur ?

**Oui, et je recommande de ne pas le faire « en direct ».**

Deux approches :

| Approche | Fonctionnement | Fluidité | Verdict |
|---|---|---|---|
| Inférence pendant la lecture | analyse de chaque image à la volée | saccadée si l'inférence dépasse 1/fps | ❌ |
| **Analyse préalable puis rejeu** | analyse des ~250 images de la fenêtre, boîtes stockées en mémoire, puis lecture avec surimpression | **parfaitement fluide**, image par image, marche arrière possible | ✅ **Retenue** |

La fenêtre utile ne dure que 8–12 s (§4.9 de l'architecture). L'analyser d'un bloc prend quelques
secondes, puis **tout devient instantané** : lecture, pause, ralenti, image précédente/suivante,
va-et-vient — les boîtes sont déjà là, indexées par numéro d'image. C'est plus simple à développer,
plus fluide, et cela permet de **revenir en arrière**, ce qu'un traitement en direct interdit.

Rendu : un `<canvas>` superposé au `<video>`, redessiné dans `requestVideoFrameCallback`. Chaque
boîte porte pilote, numéro, état, confiance, et identité proposée — exactement ta maquette du §2 :

```
┌──────────────────────────────────────────────┐
│   ┌───────────┐                              │
│   │ N°12 🟢   │  ← vert : identité sûre      │
│   └───────────┘                              │
│                       ┌───────────┐          │
│                       │ N°44 🟢   │          │
│                       └───────────┘          │
│          ┌───────────┐                       │
│          │ N°7 🟡 67%│  ← à confirmer        │
│          └───────────┘                       │
└──────────────────────────────────────────────┘
```

Clic sur une boîte → menu d'attribution parmi **les pilotes de cette série uniquement** (3 à 8
choix, jamais une liste globale). C'est le ré-ancrage manuel, et il devient une opération d'un clic.

---

## 3. Navigateur vs Python local vs Tauri/Electron

### Comparaison

| Critère | **A — Navigateur** | **B — Service Python local** | **C — Tauri / Electron** |
|---|---|---|---|
| Installation utilisateur | **aucune** | Python + paquets + service | installer l'app (~10 Mo Tauri / ~150 Mo Electron) |
| Sensation « un seul logiciel » | ✅ **totale** | ⚠️ dépend du démarrage auto | ✅ totale |
| Changement d'architecture V2 | **aucun** (reste statique) | aucun côté web | **introduit une étape de build** |
| Accès au fichier vidéo | via sélecteur, handle en IndexedDB | par chemin, lu par le service | accès disque direct |
| Fragilité connue | modèles à charger une fois | **Private Network Access de Chrome** (voir plus bas) | signature/notarisation, 2 distributions |
| Performances | WebGPU proche du natif ; WASM 3–6× plus lent | natif, meilleur | natif |
| Écosystème IA | ONNX uniquement | **tout Python** (FastReID, torchreid…) | ONNX/Rust ou Python en sidecar |
| Réversibilité | — | — | **A → C sans réécriture** |

### Réponses précises sur l'option B (tes questions du §10)

- **Lancement** : `uvicorn` sur `127.0.0.1:8765`, via un raccourci ou un `.bat`.
- **Démarrage automatique** : possible (dossier Démarrage Windows / service), mais un processus
  résident permanent pour un usage occasionnel est disproportionné.
- **Détection de présence** : `fetch('http://127.0.0.1:8765/health')` avec timeout court → pastille
  « moteur détecté / absent ».
- **Transmission des boîtes** : réponse JSON unique après analyse du bloc (préférable au streaming,
  cf. §2), ou WebSocket si l'on veut une progression.
- **Temps réel dans le navigateur** : oui, mais inutile — l'analyse préalable est meilleure.
- **Accès à la vidéo** : le service lit le fichier **par son chemin**, donc aucun transfert.
- **Éviter l'import/export JSON manuel** : oui, l'échange est un appel HTTP, invisible.

**Le point qui disqualifie B comme premier choix** : une page HTTPS publique appelant
`http://127.0.0.1` déclenche le contrôle *Private Network Access* de Chrome. Il faut renvoyer
`Access-Control-Allow-Private-Network: true` au préflight, et ce mécanisme **évolue vers une demande
de permission explicite** dans les versions récentes. C'est exactement le genre de dépendance qui se
casse à une mise à jour de navigateur et qui donne la sensation de « deux logiciels » — ce que tu
veux précisément éviter.

### Recommandation : **A maintenant, C plus tard si besoin, B jamais**

L'argument décisif : **choisir A ne ferme pas C.** Une enveloppe Tauri charge les mêmes fichiers
statiques sans une ligne de modification — l'application V2 telle quelle fonctionnerait dans Tauri.
Donc :

1. **Aujourd'hui : A.** Zéro installation, zéro service, aucune modification de l'architecture, et
   ça marche pour tout le monde sur l'hébergement Netlify actuel.
2. **Plus tard, si l'analyse vidéo devient centrale et que le navigateur bride** : enveloppe Tauri,
   qui donne accès disque direct, aucun souci CORS, modèles empaquetés, et éventuellement un moteur
   Python en sidecar. **Coût de l'attente : nul.**
3. **B est le pire des trois** : il impose une installation Python *et* garde la fragilité
   navigateur, sans l'avantage d'intégration de C.

Tauri plutôt qu'Electron le jour venu : ~10 Mo contre ~150 Mo, webview de l'OS, et le projet n'a
aucune dépendance npm à embarquer.

---

## 4. Quel détecteur ?

Le détecteur doit répondre à une question simple : « où sont les voitures sur cette image ? ». La
classe *car* de COCO suffit — pas besoin d'entraînement spécifique au rallycross pour commencer.

| Modèle | Licence | Taille ONNX | Remarque |
|---|---|---|---|
| **YOLOv8n / YOLO11n** (Ultralytics) | **AGPL-3.0** | ~12 Mo | Meilleur outillage, export ONNX trivial. AGPL compatible avec ton dépôt public |
| **YOLOX-tiny / -s** | **Apache 2.0** | ~15–35 Mo | Licence permissive, un peu plus ancien |
| **RT-DETR / D-FINE** | Apache 2.0 | ~60 Mo+ | Plus précis, plus lourd |
| RF-DETR | Apache 2.0 | variable | Récent, à évaluer au POC |

**Recommandation** : commencer par **YOLO11n ou YOLOv8n en ONNX** pour le POC (le meilleur rapport
effort/résultat), avec cette précaution : **l'interface est un ONNX, donc le modèle est
interchangeable**. Si la licence AGPL devient gênante (redistribution d'un binaire), basculer sur
YOLOX-tiny ne change que le fichier de modèle et le post-traitement.

**Détection au ralenti** : les voitures de rallycross au départ sont grandes dans l'image et bien
contrastées — c'est un cas facile pour un détecteur. Le taux de détection sera la partie *fiable* du
système. À confirmer au POC, notamment dans la poussière.

---

## 5. Quel tracker ?

| Option | Nature | Adapté à une caméra mobile ? |
|---|---|---|
| **ByteTrack** | Kalman + IoU + association sur détections faibles | ⚠️ sensible au mouvement de caméra |
| **BoT-SORT** | ByteTrack + **compensation du mouvement de caméra (CMC)** + ReID | ✅ **la CMC est faite pour ça** |
| DeepSORT | plus ancien, ReID intégré | ⚠️ dépassé par les deux ci-dessus |

**Recommandation : logique BoT-SORT, réimplémentée en JS.** Le point clé pour ton cas est la
**compensation du mouvement de caméra** : estimer, entre deux images, la transformation globale
(panoramique/zoom) à partir de points du décor, puis l'appliquer aux prédictions de Kalman. Sans
elle, un panoramique fait « décrocher » toutes les boîtes ; avec elle, le tracking résiste.

Réalisable dans le navigateur via **OpenCV.js** (build WASM officiel, ~8–10 Mo) qui fournit
`goodFeaturesToTrack`, `calcOpticalFlowPyrLK` et `estimateAffinePartial2D` — exactement les briques
nécessaires. Ou en JS pur pour une version simplifiée (translation + échelle seulement), souvent
suffisante.

Les algorithmes ByteTrack et BoT-SORT sont publiés sous **MIT**. Ce sont des algorithmes : les
réimplémenter est licite et, ici, préférable — parce que le coût d'association doit intégrer nos
signaux métier (§9), ce qu'aucune implémentation générique ne fera.

---

## 6. Quelle solution de Vehicle ReID ?

### Ce que disent les briques existantes

| Brique | Licence | Poids | Pertinence ici |
|---|---|---|---|
| **OSNet** (torchreid) | Apache 2.0 (code) | **~9 Mo ONNX** | ✅ Léger, exportable ONNX, bon candidat |
| **FastReID** (Meta) | Apache 2.0 | 40–200 Mo | ✅ Configs *vehicle* (VeRi, VehicleID), mais lourd |
| Torchreid | permissive | — | ✅ Boîte à outils d'entraînement/export |
| Modèles Vehicle ReID (VeRi-776…) | code permissif, **poids entraînés sur jeux de données à usage recherche** | variable | ⚠️ Voir la nuance ci-dessous |
| **CLIP** (ViT-B/32) | MIT | ~85 Mo int8 / ~350 Mo fp32 | ❌ Trop lourd et **pas spécialisé** dans le fin |
| OCR du numéro (PaddleOCR, Tesseract) | Apache 2.0 / Apache 2.0 | 10–40 Mo | ⚠️ Signal **d'appoint** seulement (§7) |

⚠️ **Nuance de licence à connaître** : le *code* de ces bibliothèques est permissif, mais les
**poids pré-entraînés** le sont sur des jeux de données (Market-1501, VeRi-776…) dont les conditions
sont souvent « recherche uniquement ». Pour une analyse locale personnelle, aucun problème ; pour
redistribuer les poids, c'est à vérifier au cas par cas. Cela n'affecte pas ton usage.

### Le constat contre-intuitif : un descripteur simple peut battre un réseau ReID générique

Les réseaux de ReID sont entraînés à être **invariants** à la couleur d'éclairage, au point de vue,
à l'échelle… Or, en rallycross, **la livrée EST le signal discriminant**. Un modèle entraîné à
ignorer les variations chromatiques travaille contre nous.

J'ai donc mesuré une alternative délibérément simple : **histogramme HSV par cellules spatiales**
(3×2 cellules, 8×4×4 bins), normalisé L2 — c'est-à-dire « quelles couleurs, à quel endroit de la
voiture ». Résultats §7.

### Recommandation en deux temps

1. **Étape 1 — descripteur de livrée maison** (≈ 40 lignes, 0 Mo de modèle, 0,1 ms par voiture
   mesuré). Combiné aux signaux métier, il suffit peut-être déjà.
2. **Étape 2 — OSNet ONNX (~9 Mo)** *uniquement si* le POC démontre que l'étape 1 est insuffisante,
   et en le **mesurant** : le descripteur maison reste la référence à battre.

Ne pas commencer par FastReID/CLIP : lourds, et rien ne prouve qu'ils feront mieux sur ce problème
précis.

---

## 7. Peut-on proposer une identité après un changement de caméra ? — **mesuré**

C'est la question centrale, et je l'ai testée (`bench_reid.py`, exécutable).

### Formulation du problème

```
5 pilotes connus (n°12, 44, 7, 21, 5)
        ↓
ré-ancrage manuel initial → GALERIE : 1 descripteur par voiture
        ↓
──── COUPURE CAMÉRA ────
        ↓
YOLO détecte 5 voitures (échelle, luminosité, flou différents)
        ↓
matrice de coût 5×5 = apparence + a priori d'ordre
        ↓
APPARIEMENT GLOBAL (hongrois) — pas un argmax indépendant
        ↓
confiance = MARGE (coût du meilleur appariement interdisant cette paire − coût optimal)
        ↓
🟢 / 🟡 / 🔴 → validation humaine
```

**Deux choix de conception déterminants :**

- **Appariement global, jamais argmax indépendant.** Un argmax pourrait attribuer le n°12 à deux
  voitures. Le hongrois garantit une **bijection** : chaque pilote reçoit exactement une détection.
  Cette contrainte structurelle élimine à elle seule toute une famille d'erreurs.
- **Confiance = marge, pas score du modèle.** On recalcule le meilleur appariement en *interdisant*
  la paire retenue ; l'écart de coût mesure à quel point cette attribution est contrainte. C'est bien
  plus honnête qu'une probabilité de sortie de réseau.

### Résultats mesurés — 5 voitures, 7 scénarios de coupure, 35 identifications

Difficulté volontairement ajoutée : **le n°7 et le n°5 ont des livrées quasi identiques.**

| Scénario de coupure | Auto ✅ | Signalé ⚠️ | **Silencieux ❌** |
|---|---:|---:|---:|
| Coupure courte, cadrage proche | 5 | 0 | **0** |
| Coupure + zoom ×1,6 | 5 | 0 | **0** |
| Coupure + dézoom ×0,55 + flou | 5 | 0 | **0** |
| Coupure + contre-jour (luminosité 0,55) | 5 | 0 | **0** |
| Coupure + surexposition ×1,45 | 5 | 0 | **0** |
| Coupure longue 3 s, ordre remué | 3 | 2 | **0** |
| Cumul : luminosité + zoom + flou fort | 2 | 3 | **0** |
| **TOTAL** | **30 (86 %)** | **5 (14 %)** | **0 (0 %)** |

**Et la marge se comporte exactement comme voulu** : dans le scénario le plus dur, les marges du
n°7 et du n°5 tombent à 0,001–0,002 → 🔴, tandis que les voitures aux livrées distinctes gardent des
marges de 0,06 → 🟢. **Le système sait qu'il ne sait pas.** C'est précisément ton exigence du §5.

**Contre-épreuve — apparence seule, sans a priori d'ordre** : 25 automatiques au lieu de 30. Les
signaux métier apportent donc **+20 % d'identifications automatiques**, toujours sans erreur
silencieuse. Ce qui valide ton intuition du §7 : **la connaissance de la course est un vrai levier.**

### ⚠️ Ce que ce test ne prouve PAS — à lire avant de conclure

1. **Livrées synthétiques.** De vraies voitures sont plus difficiles.
2. **Le point de vue ne change pas dans mon test** — seulement l'échelle, la luminosité et le flou.
   **C'est la limite majeure** : une coupure réelle passe souvent d'un plan large latéral à un plan
   de face ou embarqué. Mon descripteur est *spatialement structuré* (cellules), donc un passage
   côté → arrière le dégraderait beaucoup. **C'est LA chose que le POC doit mesurer.**
3. **Je suppose 5 détections pour 5 voitures.** Une coupure réelle ne montre souvent que 3 des 5, et
   la garantie de bijection s'affaiblit alors.
4. **Les seuils de marge (0,06 / 0,015) sont les miens, non calibrés.** Sur données réelles ils
   doivent être **calibrés empiriquement** (§8).

**Conclusion honnête** : la *formulation* est validée — ensemble fermé, appariement global, marge
comme confiance, signaux métier. Le maillon incertain est le **descripteur d'apparence sous
changement de point de vue**, et c'est mesurable au POC.

Et donc, je révise l'affirmation que tu me demandais de réexaminer : « aucun outil libre ne résout
la continuité d'identité multi-caméras » reste vraie **pour une identification automatique
garantie**. Mais ce n'est pas ce que tu demandes. **Pour produire une proposition avec score de
confiance et validation humaine, des briques libres suffisent — et une bonne part du travail est
faite par la structure du problème, pas par un modèle.**

---

## 8. Comment calculer un score de confiance fiable ?

Trois niveaux, du plus important au moins :

**a) La marge d'appariement** (§7) — mesure de la contrainte réelle, pas une probabilité de modèle.

**b) Des verrous durs, qui écrasent la marge :**

| Condition | Conséquence |
|---|---|
| nombre de détections ≠ nombre de partants | tout le départ plafonne à 🟡 |
| une coupure est survenue | 🟡 minimum après la coupure jusqu'à confirmation humaine |
| piste absente à l'image de mesure | 🔴 + `turn1Pos = null` |
| deux voitures à moins de ~30 ms / quasi côte à côte | 🟡 sur les deux |
| dérive du descripteur vs galerie au-delà d'un seuil | 🟡 |

**c) La calibration — l'étape que l'on oublie toujours.** Un seuil choisi à la main ne veut rien
dire. Protocole : sur les départs du POC déjà validés à la main, regrouper les marges par tranches,
mesurer le **taux réel d'exactitude** par tranche, et fixer le seuil 🟢 là où l'exactitude mesurée
atteint **≥ 99 %**. Le 🟢 devient alors une affirmation *vérifiée*, pas décrétée.

**Un risque humain à nommer, qu'aucun score ne résout** : si le système est presque toujours juste,
l'humain cesse de vérifier et valide machinalement. C'est le mode de défaillance le plus probable de
tout le dispositif. Atténuations : exiger une confirmation explicite du **podium** à chaque départ,
et demander aléatoirement une re-vérification sur ~5 % des départs 🟢 pour mesurer en continu le taux
d'erreur réel.

---

## 9. Comment intégrer les connaissances de la course ?

C'est la partie la plus rentable, et elle ne coûte presque rien. Chaque signal devient un terme du
coût d'appariement :

| Signal | Ce qu'il apporte | Coût de dev |
|---|---|---|
| **Ensemble fermé des partants** | 3–8 candidats au lieu du monde entier ; bijection garantie | trivial (déjà en base) |
| **A priori d'ordre** — en Δt secondes, l'ordre change peu | **+20 % d'auto, mesuré** | ~20 lignes |
| **Ordre spatial après coupure** | position latérale/longitudinale cohérente | faible |
| **Impossibilité physique** — P5 ne devient pas P1 en 0,4 s | élimine des permutations absurdes | faible (borne dure) |
| **Livrée / couleur** | discrimination principale | ~40 lignes |
| **OCR du numéro** | quand lisible, **quasi décisif** | modéré |
| **Grille de départ à t₀** | attribution initiale par géométrie, sans clic | déjà spécifié (§4.5 archi) |

**Sur l'OCR, position nuancée** : comme source principale il est inutilisable (numéros petits, flous,
poussiéreux — 20–40 % de lecture). Mais comme **terme du coût**, une lecture même rare est très
utile : un « 12 » lu avec confiance suffit à verrouiller une paire et, par effet de bijection, à
contraindre toutes les autres. À garder pour une étape ultérieure, jamais en source de vérité.

**Formulation retenue :**

```
coût(pilote i, détection j) = w_app · d_apparence(i,j)
                            + w_ord · pénalité_ordre(i,j,Δt)
                            + w_spa · pénalité_spatiale(i,j)
                            + w_ocr · désaccord_OCR(i,j)
                            + ∞      si physiquement impossible
```

Les poids `w_*` se calibrent sur le POC. Les termes sont **additifs et indépendants**, donc on peut
en ajouter ou en retirer un sans rien casser — et surtout **mesurer la contribution de chacun**,
comme je l'ai fait pour l'a priori d'ordre.

---

## 10. Quelles performances attendre sur un PC normal ?

### Mesuré ici (CPU 4 cœurs, conteneur)

| Étage | Coût | Fréquence |
|---|---|---|
| Descripteur de livrée, 8 voitures | **0,85 ms** (0,106 ms/voiture) | aux coupures + image de mesure |
| Appariement 8×8 par hongrois | **< 0,1 ms** | idem |

La partie ReID/appariement est donc **négligeable** : elle ne tourne pas à chaque image.

### Estimé — détection YOLO ⚠️ *non mesuré ici*

Le proxy de cet environnement bloque les hébergeurs de modèles ; je n'ai pas pu télécharger de poids
YOLO, et je ne présenterai donc pas d'estimation comme une mesure. Ordres de grandeur attendus pour
un YOLO nano à 640 px :

| Contexte | ms / image (estimation) | 250 images (10 s à 25 fps) |
|---|---|---|
| ONNX Runtime Web, **WebGPU** (GPU intégré récent) | ~10–30 | **3–8 s** |
| ONNX Runtime Web, **WASM SIMD** (CPU seul) | ~80–250 | 20–60 s |
| ONNX Runtime natif, CPU de bureau | ~30–60 | 8–15 s |

**Conclusion robuste malgré l'incertitude** : la fenêtre analysée ne fait que ~10 s. Même dans
l'hypothèse la plus pessimiste (WASM sur CPU modeste), on reste sous la minute par départ, et
l'analyse est **préalable** (§2), donc elle ne dégrade jamais la fluidité de la lecture. **La
performance n'est pas le facteur décisif** — c'est la qualité de la ReID qui décide. La mesure
réelle est un livrable du POC.

Note : WebGPU est disponible dans Chrome/Edge stables depuis 2023 ; prévoir un repli WASM
automatique et l'afficher (« moteur : WebGPU » / « moteur : CPU »).

---

## 11 et 12. Gratuité, dépendances, licences

| Composant | Rôle | Licence | Poids |
|---|---|---|---|
| **ONNX Runtime Web** | inférence navigateur | **MIT** | ~10–15 Mo (wasm/webgpu) |
| **YOLO11n / YOLOv8n ONNX** | détection | AGPL-3.0 (Ultralytics) | ~12 Mo |
| *alternative* YOLOX-tiny ONNX | détection | **Apache 2.0** | ~15 Mo |
| **OpenCV.js** (optionnel, CMC) | flux optique, affine | **Apache 2.0** | ~8–10 Mo |
| **OSNet ONNX** (optionnel, étape 2) | ReID | Apache 2.0 (code) | ~9 Mo |
| Descripteur de livrée, ByteTrack/BoT-SORT en JS | tracking, appariement | **notre code** | 0 |

- **Aucune API externe, aucun cloud, aucun compte, aucun quota, aucun coût par minute.**
- **Aucune dépendance npm** : ONNX Runtime Web se charge en module ES, comme le SDK Firebase
  aujourd'hui. **L'architecture statique sans build est préservée.**
- **Aucun Python**, aucun service, aucune installation utilisateur.
- Fonctionnement **hors ligne** après le premier chargement des modèles (mis en cache).

Deux nuances honnêtes : l'AGPL d'Ultralytics (sans conséquence pour un dépôt public, contournable en
passant à YOLOX), et les conditions « recherche » de certains **poids** ReID pré-entraînés (sans
effet en usage local).

---

## 13. Poids total

| Configuration | Poids des modèles |
|---|---|
| Minimale (détection seule + descripteur maison) | **~25 Mo** (ORT Web + YOLO nano) |
| Recommandée (+ OpenCV.js pour la CMC) | **~35 Mo** |
| Complète (+ OSNet ReID) | **~45 Mo** |
| Avec OCR plus tard | +10 à 40 Mo |

Chargé **une seule fois**, à la demande, et **jamais** dans `ASSET_PATHS` de `sw.js` — donc invisible
pour le mode spectateur et les overlays.

---

## 14. Complexité de développement

| Lot | Contenu | Effort |
|---|---|---|
| **V0 — lecteur + surimpression** | `<video>` + canvas, image par image, ralenti, boîtes **saisies à la main**, validation | ~2 j |
| **V1 — détection** | ORT Web + YOLO ONNX, boîtes automatiques, attribution manuelle par clic | ~2–3 j |
| **V2 — tracking** | Kalman + IoU + CMC, identités propagées, états 🟢🟡🔴 | ~3 j |
| **V3 — ReID en ensemble fermé** | galerie, descripteur, coût multi-signaux, hongrois, marge | ~2–3 j |
| **V4 — calibration + signaux métier** | calibration des seuils, a priori d'ordre, contraintes physiques | ~2 j |
| *V5 — OCR (facultatif)* | appoint, jamais décisif | ~2–3 j |

**Point important : chaque lot est utilisable seul.** V0 apporte déjà l'essentiel de la valeur
(lecteur intégré, image par image, validation) et fonctionne **aussi avec YouTube**. V1 apporte les
rectangles. Il n'y a **jamais** de « tout ou rien ».

---

## 15. POC minimal pour décider objectivement

**Le POC doit tenir dans le navigateur, pas dans un outil séparé** — une page HTML autonome dans
`tools/poc-vision/`, jamais importée par l'application. Cela permet de tester la vraie chaîne
technique (ORT Web, WebGPU, canvas) telle qu'elle sera utilisée.

**Précondition** : quelques fichiers vidéo locaux légitimes couvrant tes 10 scénarios.

**Mesures, avec la classification en trois catégories que tu proposes** — et tu as raison, ma
formulation précédente les confondait :

| Catégorie | Définition | Objectif |
|---|---|---|
| ✅ **Identification automatique correcte** | proposée 🟢 et juste | à maximiser |
| ⚠️ **Proposition incertaine signalée** | 🟡/🔴, juste ou fausse | **acceptable**, à garder raisonnable |
| ❌ **Erreur silencieuse** | proposée 🟢 et **fausse** | **doit être 0** |

À mesurer aussi : taux de détection des voitures, continuité du tracking entre coupures, taux de
bonne proposition après coupure, nombre d'interventions humaines, **temps humain par départ** — et en
comparaison, le temps de la saisie purement manuelle sur les mêmes départs.

**Critères de décision, fixés à l'avance :**

| Critère | Seuil |
|---|---|
| Erreurs silencieuses | **0** — un seul cas disqualifie |
| Détection des voitures visibles | ≥ 95 % |
| Propositions 🟢 correctes après coupure | ≥ 90 % |
| Départs traités sans intervention | ≥ 60 % |
| Temps humain moyen | < 12 s (contre 15–30 s en manuel) |
| Scénario « point de vue très différent » | mesuré séparément — c'est le maillon faible identifié (§7) |

---

## Recommandation finale

**Manuel + outil visuel YOLO + ReID assistée** — construit dans cet ordre, chaque étape livrant de
la valeur seule.

Justification du changement d'avis par rapport à la révision 5 :

1. **La formulation en ensemble fermé change la nature du problème.** Mesuré : 86 % d'identifications
   automatiques correctes et **0 erreur silencieuse** sur 7 scénarios de coupure, avec un descripteur
   volontairement simple et deux livrées quasi identiques.
2. **La confiance par marge d'appariement fonctionne** : elle s'effondre exactement dans les cas
   ambigus. C'est ce qui rend le « jamais inventer une identité » réellement implémentable.
3. **Les signaux métier apportent +20 % d'automatisation**, mesuré, pour quelques dizaines de lignes.
4. **La voie navigateur est viable** et j'avais tort de l'écarter : il ne faut pas une bibliothèque
   de tracking JS, mais deux ONNX et ~300 lignes d'association.
5. **La valeur ne se limite pas au temps gagné.** Le lecteur avec rectangles est un **outil de
   contrôle** : il rend visible ce que fait le système, ce qui est exactement ton objectif du §2 —
   et ce que la saisie manuelle seule n'offre pas.

**Ce que je ne révise pas :**

- YouTube reste en **saisie manuelle** — pas d'accès aux pixels, pas de téléchargement.
- L'instant de mesure V1 reste **choisi manuellement**, la ligne reste un repère visuel.
- **Aucune donnée non validée n'alimente les statistiques.**
- **Le POC reste obligatoire** avant l'intégration des lots V1+, et son maillon faible connu est le
  changement de point de vue.
- Les **phases 1 à 3** de l'architecture restent le socle : elles couvrent 100 % des courses, y
  compris celles qui n'existent que sur YouTube.

**Ordre de marche proposé** : phases 1–3 (socle, toutes les courses) → **V0** (lecteur intégré avec
surimpression, utile aussi sur YouTube) → POC navigateur sur fichiers locaux → V1/V2/V3 selon les
résultats mesurés.
