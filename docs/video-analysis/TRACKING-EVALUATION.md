# Évaluation du moteur de tracking — verdict pour de la vidéo TV de rallycross

> Document d'évaluation technique. **Aucun code applicatif.** Les chiffres ci-dessous sont
> **mesurés**, pas estimés : banc d'essai exécuté avec OpenCV 5.0.0 sur CPU 4 cœurs, séquence
> synthétique 1920×1080.
>
> **Conclusion principale : ma recommandation antérieure (« OpenCV/CSRT avant YOLO ») était fondée
> sur une hypothèse fausse — une caméra relativement stable. Sur de la vidéo de retransmission,
> CSRT n'est pas adapté, et l'automatisation n'apporte pas le gain espéré.** Détail et chiffres
> ci-dessous.

---

## 0. Préalable : il n'y a pas d'« outil » ni de fournisseur

OpenCV est une **bibliothèque logicielle libre**, pas un service en ligne. Il n'existe ni compte,
ni abonnement, ni quota, ni interlocuteur commercial : le code est téléchargé une fois et exécuté
sur la machine. Il n'y a donc personne à qui demander ces informations — elles se vérifient, et
c'est ce que fait ce document.

---

## 1. Dépendances exactes

### 1.1 ⚠️ Correction : le paquet `opencv-python` ne suffit pas

Vérifié par installation réelle :

| Paquet | Version testée | `TrackerCSRT` | `TrackerKCF` | `cv2.legacy` |
|---|---|---|---|---|
| `opencv-python-headless` | 5.0.0.93 | ❌ **ABSENT** | ❌ **ABSENT** | ❌ absent |
| `opencv-contrib-python-headless` | 5.0.0.93 | ✅ présent | ✅ présent | ✅ présent |

**OpenCV 5.0 a retiré CSRT et KCF du module principal**, et le namespace `cv2.legacy` n'existe plus
dans le paquet de base. Un `pip install opencv-python` suivi de `cv2.TrackerCSRT_create()`
échouerait donc immédiatement. Le paquet requis est **`opencv-contrib-python`** (ou sa variante
`-headless`, sans dépendances graphiques — préférable pour un outil en ligne de commande).

Trackers effectivement disponibles dans `opencv-contrib-python-headless` 5.0.0 :

```
cv2.TrackerCSRT, cv2.TrackerKCF, cv2.TrackerMIL, cv2.TrackerVit, cv2.TrackerNano,
cv2.TrackerDaSiamRPN
cv2.legacy.{TrackerBoosting, TrackerCSRT, TrackerKCF, TrackerMIL, TrackerMOSSE,
            TrackerMedianFlow, TrackerTLD}
```

### 1.2 Modèle externe nécessaire ?

| Tracker | Modèle à télécharger |
|---|---|
| CSRT, KCF, MIL, MOSSE, MedianFlow | **Aucun** — algorithmes classiques, rien à télécharger |
| `TrackerVit`, `TrackerNano`, `TrackerDaSiamRPN` | **Oui** — fichiers ONNX externes ; vérifié : `create()` échoue sans eux |
| YOLO (si un jour) | Oui — poids `.pt` ou `.onnx` |

### 1.3 Liste complète des dépendances

```
opencv-contrib-python-headless == 5.0.0.93     # tracking + I/O vidéo
numpy                          == 2.4.6        # tiré automatiquement
```

**C'est tout.** Deux paquets, aucune autre dépendance Python.

### 1.4 Empreinte disque et matériel — mesuré

| Élément | Taille |
|---|---|
| `cv2` (bibliothèque + binaires) | **91 Mo** |
| `numpy` | 45 Mo |
| Environnement virtuel complet | **272 Mo** |
| Durée d'installation | ~5 s (hors débit réseau) |

- **Carte graphique : non nécessaire.** Les wheels PyPI sont compilées **sans CUDA** ; CSRT et KCF
  sont des algorithmes CPU et n'utiliseraient pas le GPU de toute façon.
- **Fonctionne intégralement sur CPU.** Un GPU n'apporterait rien à ces deux trackers.
- Version recommandée : **`opencv-contrib-python-headless` ≥ 4.10`, < 6`**. Sur 5.x, ne jamais
  utiliser `cv2.legacy` (déprécié) : les classes du namespace principal suffisent.

---

## 2. Gratuité et licences — vérifié dans les métadonnées installées

| Composant | Licence | Coût |
|---|---|---|
| OpenCV (`opencv-contrib-python-headless`) | **Apache 2.0** | 0 € |
| NumPy | BSD-3-Clause (+ 0BSD, MIT, Zlib, CC0 pour des parties) | 0 € |
| CSRT (algorithme Lukežič et al.) | implémentation Apache 2.0 | 0 €, aucune licence à acquérir |
| KCF (algorithme Henriques et al.) | implémentation Apache 2.0 | 0 €, aucune licence à acquérir |
| Bibliothèques tierces embarquées | 14× BSD, 13× Apache, 6× zlib, 3× MPL, 2× MIT | 0 € |
| **FFmpeg** (embarqué dans le wheel, pour lire les vidéos) | **LGPL 2.1** | 0 € |

Réponses point par point :

- **OpenCV entièrement gratuit pour cet usage ?** Oui. Apache 2.0, usage commercial inclus.
- **CSRT/KCF nécessitent-ils une licence ou un paiement ?** Non, ni l'un ni l'autre.
- **API externe payante nécessaire ?** Aucune.
- **Limite de nombre de vidéos ou d'analyses ?** Aucune — c'est du calcul local.
- **Coût par minute de vidéo ?** Aucun.
- **Service cloud obligatoire ?** Aucun.
- **Fonctionnement 100 % local ?** Oui. Réseau requis **une seule fois**, pour `pip install`.

**Deux nuances honnêtes, sans impact sur ton usage :**

1. **FFmpeg est en LGPL 2.1**, pas Apache. Sans conséquence pour un usage local ; cela n'imposerait
   des obligations (fournir les sources / permettre le remplacement de la bibliothèque) que si tu
   **redistribuais** un exécutable packagé. Un script Python que l'utilisateur installe lui-même via
   `pip` ne pose aucun problème.
2. Les wheels PyPI sont compilées **sans `OPENCV_ENABLE_NONFREE`** : les algorithmes brevetés
   historiques (SURF) sont donc absents. Nous ne les utilisons pas — mention pour complétude.

---

## 3. YouTube : la limitation est réelle, et voici pourquoi

### 3.1 Pourquoi OpenCV ne peut pas analyser le lecteur YouTube

Deux barrières indépendantes, toutes deux infranchissables proprement :

1. **Barrière technique navigateur.** Le lecteur YouTube est un `<iframe>` d'origine différente. Le
   navigateur interdit la lecture de ses pixels : impossible de le dessiner dans un `<canvas>`,
   donc impossible d'en extraire une image. Ce n'est pas une limite d'OpenCV mais du modèle de
   sécurité du Web (*same-origin policy*), et elle ne se contourne pas.
2. **Barrière côté OpenCV.** `cv2.VideoCapture` attend un fichier ou un flux média. Une URL
   `youtube.com/watch?v=…` renvoie une **page HTML**, pas un flux vidéo : l'ouverture échoue.

### 3.2 Ce que je ne développerai pas

**Je ne construirai pas de téléchargeur YouTube.** Les conditions d'utilisation de YouTube
interdisent d'accéder au contenu par un autre moyen que le lecteur fourni, et d'en télécharger des
copies hors des fonctions officielles. Ce n'est pas une question de faisabilité technique mais de
respect des conditions du service — et cela t'exposerait, pas moi.

### 3.3 Les voies réellement disponibles

| Voie | Utilisable pour l'analyse auto ? | Remarque |
|---|---|---|
| **Vidéo dont tu possèdes le fichier** (ta caméra, celle du club) | ✅ **Oui** | La voie propre, et la meilleure — voir §6 |
| **Fichier fourni par l'ayant droit** (organisateur, fédération, diffuseur) | ✅ Oui | Demande à faire ; c'est du cas par cas |
| Téléchargement YouTube par outil tiers | ❌ | Contraire aux CGU — écarté |
| Téléchargement hors ligne YouTube Premium | ❌ | Lecture dans l'application seulement, aucun fichier accessible |
| API YouTube Data | ❌ | Métadonnées uniquement, aucun accès aux images |
| Capture d'écran pendant la lecture (OBS…) | ⚠️ Techniquement possible | Contourne le mode d'accès prévu, donc problématique au regard des CGU ; qualité et cadence dégradées. Je ne le recommande pas — décision qui t'appartient |

### 3.4 Workflow réel

```
Course avec fichier local légitime          Course YouTube uniquement
              │                                        │
       fichier .mp4                          lecteur YouTube intégré
              │                                        │
        OpenCV / analyse                     lecture image par image
              │                                        │
    proposition d'ordre                    saisie humaine de l'ordre
              │                                        │
              └──────────► validation humaine ◄────────┘
                                   │
                            Firestore (validé)
```

**Conséquence architecturale majeure** : puisque tes vidéos sont « principalement YouTube », la voie
automatique ne concernera qu'une **minorité** de départs. La voie manuelle n'est donc pas un
repli provisoire en attendant l'automatisation : **c'est le chemin principal, définitivement.** Elle
doit être traitée comme telle — ergonomie soignée, raccourcis clavier, zéro friction.

---

## 4. Mesures : ce que CSRT et KCF font réellement

Banc d'essai : séquence synthétique 1920×1080, fond texturé, panoramique caméra simulé, voitures
texturées. **Attention à l'asymétrie d'interprétation** : le synthétique est *beaucoup plus facile*
que de la vidéo TV (aucun flou de mouvement, aucune poussière, contraste parfait, livrées
distinctes). Un échec observé ici sera donc **pire** en réel ; une réussite ici ne prouve **rien**
pour le réel.

### 4.1 Performance (mesurée, CPU 4 cœurs)

| Tracker | Cibles | ms / image | ms / cible | fps atteint |
|---|---:|---:|---:|---:|
| KCF | 3 | 13,8 | 4,6 | 72,6 |
| KCF | 5 | 22,9 | 4,6 | 43,6 |
| KCF | 8 | 32,2 | 4,0 | 31,0 |
| CSRT | 3 | 78,0 | 26,0 | 12,8 |
| CSRT | 5 | 131,3 | 26,3 | 7,6 |
| **CSRT** | **8** | **212,3** | 26,5 | **4,7** |

**CSRT est ~6× plus lent que KCF.** Traduction pour une fenêtre de 10 s autour d'un départ :

| Cadence source | Images | CSRT, 8 voitures | KCF, 8 voitures |
|---|---:|---:|---:|
| 25 fps | 250 | **~53 s** | ~8 s |
| 50 fps | 500 | **~106 s** | ~16 s |
| 60 fps | 600 | **~127 s** | ~19 s |

Sur un PC plus rapide que ce conteneur, compter 30–40 % de mieux — l'ordre de grandeur tient. Le
calcul n'est pas bloquant, mais CSRT n'est pas « temps réel » à 8 cibles.

### 4.2 Sortie complète du cadre, puis retour — **le test décisif**

Cible visible, puis **hors cadre pendant 40 images (≈ 1,6 s à 25 fps)**, puis retour à sa place.

| Tracker | Avant sortie | Pendant l'absence | Après retour | Ré-acquisition auto ? |
|---|---|---|---|---|
| **CSRT** | `ok=true` 95 %, IoU 0,87 | `ok=false` 100 % | `ok=false` 100 %, IoU **0,00** | **NON** — 0/39 images |
| KCF | `ok=true` 95 %, IoU 0,59 | `ok=false` 100 % | `ok=true` 97 %, IoU 0,64 | Apparemment oui — 35/39 |

**Réponse claire à ta question : non, CSRT ne sait pas retrouver une voiture après une sortie
complète du cadre.** Jamais. Une fois perdu, il reste perdu — mesuré : 0 image correcte sur 39
après le retour.

**Et le « oui » de KCF est un piège, pas un avantage.** Dans ce test il n'y a **qu'une seule**
cible, qui revient **exactement au même endroit**. KCF se ré-accroche à ce qui ressemble à sa cible
dans sa zone de recherche. Avec 8 voitures aux livrées proches, ce même mécanisme produit
précisément ce que tu veux éviter : **un échange d'identité silencieux**. Le comportement de KCF est
donc plus dangereux que celui de CSRT, pas meilleur.

Point positif tout de même : **les deux signalent correctement la perte** (`ok=false` à 100 %
pendant l'absence). Le système peut donc détecter la perte de façon fiable et demander un
ré-ancrage — ce qui rend ton workflow du §6 de ta question tout à fait réalisable.

### 4.3 Changement de plan

Coupure franche à l'image 15, la cible réapparaît ailleurs dans le nouveau plan.

| Tracker | `ok=true` après la coupure | IoU moyen après |
|---|---|---|
| CSRT | **0 / 16** | 0,00 |
| KCF | **0 / 16** | 0,00 |

**Aucun tracker par apparence ne survit à un changement de caméra.** C'était attendu, c'est
maintenant mesuré. Les deux le signalent correctement (`ok=false`), ce qui permet au moins de
déclencher un ré-ancrage plutôt que de produire des données fausses.

### 4.4 Croisement et occultation partielle

Deux voitures aux **livrées volontairement proches**, l'une rattrapant et chevauchant l'autre :

| Tracker | IoU finale cible 1 | IoU finale cible 2 | Échange d'identité |
|---|---:|---:|---|
| CSRT | 0,93 | 0,73 | Non |
| KCF | 0,79 | 0,97 | Non |

**À ne pas surinterpréter** : mon test ne produit qu'un **chevauchement partiel** (décalage
vertical de 20 px sur des voitures de 90 px), jamais une occultation totale, et sans poussière ni
flou. Il ne démontre donc **pas** que CSRT résiste à une occultation réelle. Le cas « deux voitures
se croisent complètement derrière une troisième, dans la poussière » n'est pas couvert par cette
mesure et restera, en pratique, un cas humain.

### 4.5 Synthèse par cas de figure

| Situation | CSRT | KCF | Détecté ? |
|---|---|---|---|
| Caméra fixe | ✅ bon | ✅ bon | — |
| Panoramique lent | ✅ bon (100 % à 3–5 cibles) | ✅ bon | — |
| Panoramique rapide | ⚠️ perte probable | ⚠️ perte probable | ✅ `ok=false` |
| Zoom modéré | ⚠️ dégradé | ⚠️ dégradé | partiellement |
| Zoom agressif | ❌ perte | ❌ perte | ✅ |
| Voiture sort du cadre | ❌ **perte définitive** | ❌ perte, ré-accrochage hasardeux | ✅ |
| Voiture réapparaît | ❌ **jamais retrouvée** | ⚠️ ré-accrochage **non fiable** en peloton | — |
| Occultation brève | ⚠️ parfois | ⚠️ parfois | partiellement |
| Occultation longue | ❌ dérive | ❌ dérive | mal |
| Contact entre voitures | ❌ risque d'échange | ❌ risque d'échange | **non** |
| Poussière | ❌ | ❌ | mal |
| **Changement de caméra** | ❌ **échec total** | ❌ **échec total** | ✅ |

---

## 5. La ligne virtuelle V1 : tu as raison, il faut abandonner l'idée

### 5.1 Le problème

Une ligne `A(x₁,y₁) → B(x₂,y₂)` en coordonnées d'image ne désigne un lieu **physique** de la piste
que si le cadrage est figé. Dès que la caméra pivote, zoome ou suit les voitures, la même ligne
image correspond à un autre endroit de la piste. Sur de la retransmission, une ligne fixe est donc
**invalide dès la première seconde**.

### 5.2 Les options, classées honnêtement

| Option | Robustesse | Coût de dev | Verdict |
|---|---|---|---|
| **Ordre à une image choisie manuellement** | ★★★★★ | très faible | ✅ **Retenue** |
| Ligne placée sur l'image de sortie V1 uniquement | ★★★★☆ | faible | ✅ Complément visuel utile |
| Ligne + suivi de points fixes du décor (homographie image à image) | ★★☆☆☆ | ~2–3 j | ❌ Fragile : poussière, flou, peu de décor statique dans le cadre |
| Homographie vers un modèle de piste calibré | ★★★☆☆ | élevé | ❌ Disproportionné |
| Renoncer au franchissement auto sur les plans instables | — | — | Conséquence des lignes ci-dessus |

### 5.3 Décision : « ordre à une image choisie », pas « franchissement de ligne »

Le mécanisme retenu devient donc :

1. tu navigues jusqu'à **l'image de sortie du virage 1** ;
2. **cette image** est l'instant de mesure — enregistré dans `video.turn1Seconds` ;
3. l'ordre est lu **sur cette image**, par clic sur les voitures ou par glisser-déposer ;
4. une **ligne facultative**, tracée sur cette image seule, sert de **repère visuel** pour que le
   jugement reste cohérent d'un départ à l'autre. Elle n'est plus un détecteur, elle est une aide à
   la décision — et à ce titre elle garde toute son utilité, notamment via les presets par circuit.

**Ce que cette décision fait disparaître** : l'interpolation sous-image, le calcul de produit
vectoriel, la gestion des franchissements quasi simultanés, et toute la classe d'erreurs liée au
mouvement de caméra. La phase 3 devient nettement plus simple **et** plus fiable.

**Ce que l'on perd** : la résolution des franchissements à 40 ms d'écart, qui était l'un des trois
arguments de qualité en faveur de l'automatisation. Sur une image unique, deux voitures côte à côte
resteront un jugement humain — à marquer 🟡.

---

## 6. Comparaison A / B / C

| Critère | **A — Manuel** (YouTube, ordre à l'image) | **B — Semi-auto** (fichier local, CSRT/KCF amorcé par clics) | **C — Auto avancé** (YOLO + ByteTrack) |
|---|---|---|---|
| Vidéos utilisables | **Toutes**, YouTube compris | Fichiers locaux légitimes seulement | Idem B |
| Précision réaliste | **Élevée** — l'œil humain lit un ordre de façon fiable | Bonne **si** plan continu et toutes les voitures visibles | Bonne détection ; **identité** toujours incertaine |
| Sortie de champ | Sans objet | ❌ perte définitive (CSRT), ré-ancrage obligatoire | ⚠️ ré-détectée mais **nouvelle identité** |
| Changement de caméra | Sans objet | ❌ **échec total** → ré-ancrage complet | ❌ identité perdue → ré-ancrage complet |
| Occultation | Sans objet (on regarde après) | ⚠️ risque d'échange silencieux | ⚠️ risque d'échange |
| Caméra mobile / zoom | Sans objet | ⚠️ dégradé | ✅ peu sensible |
| Temps humain / départ | **15–30 s** | 10–15 s **sans coupure** ; **≥ 25–40 s avec coupure** | idem B |
| Complexité de dev | ~2 j | ~3 j + POC | ~8–10 j |
| Dépendances | **aucune** | 272 Mo, 2 paquets | ~2,5 Go (`torch`) ou ~250 Mo (ONNX) |
| Coût | 0 € | 0 € | 0 € |
| Intérêt réel dans notre cas | ✅ **élevé** | ⚠️ **faible** (voir ci-dessous) | ⚠️ conditionnel |

### 6.1 Pourquoi B n'apporte probablement pas assez — le calcul décisif

Sur une retransmission, la séquence « feux verts → sortie du virage 1 » contient très souvent **au
moins une coupure** (plan large, embarqué, plan du virage…). Or :

- après une coupure, il faut **ré-ancrer les N voitures** = **N clics** ;
- la méthode manuelle consiste à… **cliquer les N voitures dans l'ordre**, une seule fois.

**Donc dès qu'il y a une seule coupure entre le départ et la sortie du virage 1, la voie
semi-automatique demande autant ou plus de travail humain que la saisie manuelle** — tout en
ajoutant une installation de 272 Mo, un aller-retour par fichier JSON, et un risque d'erreur
silencieuse. B ne gagne que dans le cas « plan unique, continu, toutes les voitures visibles,
cadrage stable », qui est justement le cas où A est déjà trivial.

**Conclusion : A doit être le chemin principal et permanent. B n'est pas à construire pour de la
vidéo TV.**

### 6.2 Le vrai levier n'est pas le logiciel, c'est la source vidéo

Si l'automatisation t'intéresse vraiment, le facteur déterminant n'est pas le choix du tracker mais
**la façon dont la vidéo est filmée**. Une **caméra fixe sur trépied**, cadrant en plan large le
départ et la sortie du virage 1, supprime d'un coup :

- les changements de plan (un seul plan) ;
- les panoramiques et zooms (cadrage figé) ;
- les sorties de champ (toutes les voitures dans le cadre) ;
- l'invalidation de la ligne virtuelle (le cadrage ne bouge pas → une ligne fixe redevient valable,
  et le franchissement avec interpolation sous-image redevient pertinent).

Dans ce contexte, B **et** C deviennent réellement efficaces, et l'automatisation prend tout son
sens. Un téléphone sur trépied à un endroit bien choisi suffit pour commencer.

**C'est, de loin, la recommandation la plus utile de ce document : ne cherche pas un meilleur
algorithme pour une vidéo inadaptée — change la vidéo.** Une caméra fixe par meeting produirait un
jeu de données propre pour toutes les catégories et toutes les séries, y compris celles que la
retransmission ne montre jamais (§4.8 de l'architecture : la couverture vidéo est le facteur
limitant).

### 6.3 Si un jour automatisation, alors YOLO plutôt que CSRT

⚠️ **Renversement de ma recommandation antérieure.** J'avais proposé CSRT *avant* YOLO en
avançant que « l'échec de CSRT est visible alors que l'échange d'identité de ByteTrack est
silencieux ». Les mesures corrigent ce raisonnement :

- CSRT est **6× plus lent** que KCF et ~40× plus lent qu'un YOLO nano en ONNX ;
- CSRT **ne se rétablit jamais** après une sortie de champ, très fréquente ici ;
- la détection **par image** (YOLO) est structurellement plus robuste à la sortie de champ et à
  l'occultation, puisqu'elle recommence de zéro à chaque image.

Il reste vrai qu'aucun des deux ne résout l'identité à travers une coupure. Mais à conditions de
tournage favorables (§6.2), YOLO + ByteTrack est le meilleur choix — et CSRT n'a plus de créneau.

**Aucun outil libre ne résout aujourd'hui la continuité d'identité sur un flux de retransmission
multi-caméras.** C'est un problème de recherche ouvert : les systèmes professionnels de suivi
sportif utilisent des caméras fixes calibrées, précisément parce que le signal de diffusion est
inexploitable pour cela.

---

## 7. Comportements à garantir (réponses à tes §5 à §8)

Confirmations formelles, à implémenter si l'automatisation est un jour retenue :

**§5 — sortie de champ.** Perte détectée (`ok=false`, mesuré fiable à 100 %) → la voiture passe en
🔴 « identité à confirmer ». **Jamais** de ré-attribution automatique.

**§6 — ré-ancrage manuel.** Exactement le workflow que tu décris, et il est réalisable :

```
tracking voiture 12  →  perte détectée  →  ⛔ « voiture 12 perdue »
                                              ↓
                          tu cliques sur la 12 quand elle réapparaît
                                              ↓
                          nouveau tracker initialisé, identité 12 conservée
```

Le système dira toujours « voiture 12 perdue — ré-identification nécessaire » plutôt que d'attribuer
silencieusement l'identité 12 à une autre voiture. C'est possible parce que la détection de perte
est fiable ; c'est le ré-accrochage automatique qui ne l'est pas.

**§7 — changement de caméra.** Oui, c'est bien le workflow proposé : détection de la coupure
(différence d'histogramme, très fiable et peu coûteuse) → arrêt → ré-ancrage par clics → reprise.
**Mais** — et c'est le point du §6.1 — ce ré-ancrage coûte N clics, soit autant que la saisie
manuelle complète. Donc oui c'est faisable, et non ce n'est pas intéressant par rapport à A.

**§8 — voitures jamais visibles à la sortie V1.** Confirmé, et c'est déjà la convention §4.10 B de
l'architecture :

```
P1 → voiture 12  🟢
P2 → voiture 44  🟢
P3 → voiture 7   🟢
P4 / P5 → indéterminé  🔴     ← turn1Pos = null, jamais inventé
```

L'analyse **reste non validable** tant qu'une ligne 🔴 n'a pas été traitée par un humain.

**Raffinement nécessaire que ton exemple met en lumière** : savoir que 3 voitures sont visibles ne
suffit pas à affirmer qu'elles sont les 3 premières — une voiture hors cadre pourrait être devant.
Il faut donc un champ explicite :

```js
orderCompleteness: 'complete'      // toutes les voitures vues, ordre total fiable
                 | 'leaders_only'  // je certifie que les visibles sont bien les premières
                 | 'partial'       // je ne peux pas garantir l'ordre relatif → aucune ligne validée
```

Sans ce champ, un ordre partiel risquerait de contaminer les statistiques par le haut du
classement, pas seulement par le bas. À ajouter au schéma `startAnalyses`.

---

## 8. POC avant toute intégration — approuvé, et voici le protocole

Ton idée de POC séparé est la bonne, et **son résultat le plus probable est « ne pas intégrer »** —
ce qui serait un succès du POC, pas un échec.

**Précondition indispensable** : disposer de quelques **fichiers vidéo locaux légitimes** (§3.3).
Sans eux, le POC ne peut pas être mené, et la réponse est automatiquement « rester manuel ».

### 8.1 Corpus de test

Tes 10 scénarios, à couvrir sur des départs réels, avec 3 / 5 / 8 voitures : caméra quasi fixe,
caméra qui suit, zoom, sortie de cadre, réapparition, occultation, poussière, coupure avant V1,
coupure pendant V1.

### 8.2 Mesures

Par départ : voitures correctement suivies jusqu'à l'instant de mesure, nombre de pertes, nombre de
ré-ancrages, **échanges d'identité** (le plus important), exactitude de l'ordre proposé vs ordre
vérifié à l'œil, temps humain total. Et en comparaison : temps humain de la **méthode A** sur le
même départ.

### 8.3 Critère de décision, fixé à l'avance

L'automatisation ne sera intégrée que si, sur le corpus :

- **zéro** échange d'identité non signalé — un seul cas suffit à disqualifier, c'est l'exigence de
  non-contamination ;
- **≥ 70 %** des départs traités avec **0 ré-ancrage** ;
- temps humain moyen **< 10 s** par départ, contre 15–30 s en méthode A ;
- ordre proposé exact sur **≥ 90 %** des départs.

Fixer ces seuils **avant** de voir les résultats est ce qui empêche de se convaincre après coup
qu'un résultat médiocre est acceptable.

### 8.4 Périmètre

`tools/rxstart-poc/` — dossier **totalement séparé**, jamais importé par l'application, un script et
un rapport CSV. Aucune écriture dans Firestore, aucune modification de la V2.

---

## 9. Conclusion

**Ce qu'OpenCV/CSRT saura faire** sur nos vidéos : suivre des voitures sur un plan continu et
stable, signaler de façon fiable qu'il a perdu une cible, et fournir un ordre correct dans le cas
favorable « plan unique, toutes les voitures visibles ».

**Ce qu'il ne saura pas faire** : retrouver une voiture sortie du cadre (mesuré : 0/39), survivre à
un changement de caméra (mesuré : 0/16), garantir l'absence d'échange d'identité lors d'un contact
ou d'une occultation dans la poussière, et rester valide quand le cadrage bouge — ce qui invalide
au passage la ligne virtuelle à coordonnées fixes.

**Workflow recommandé :**

1. **Chemin principal et permanent — méthode A.** Lecteur YouTube, navigation jusqu'à la sortie du
   virage 1, ordre saisi par clic sur l'image, ligne facultative comme repère visuel. Fonctionne
   pour **toutes** les courses, sans aucune dépendance. C'est là qu'il faut investir l'effort
   d'ergonomie.
2. **Ne pas construire la phase 4 semi-automatique en l'état.** Sur de la vidéo TV, elle coûte
   autant de clics qu'elle en économise.
3. **Si automatisation souhaitée : commencer par la source vidéo**, pas par l'algorithme. Une caméra
   fixe sur trépied change complètement l'équation — et donne accès aux séries que la
   retransmission ne montre pas.
4. **POC séparé obligatoire** avant toute intégration, avec les critères chiffrés du §8.3, et si
   c'est un jour retenu : **YOLO + ByteTrack**, pas CSRT.

Cela ne remet en cause **aucune** des phases 1 à 3, ni le modèle de données : `turn1Pos` reste
saisi et validé par un humain, la statistique ne lit que les analyses validées, et l'architecture
est déjà conçue pour que l'automatisation soit un accélérateur optionnel et non un prérequis.
