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

## Suivi temporel — `track.html`

Étape ② : relier les détections instantanées en **pistes persistantes**, pour répondre à une
question que six images isolées ne peuvent pas trancher — *peut-on tenir cinq trajectoires
distinctes du départ à la sortie du V1 malgré les ratés de YOLOX ?*

```powershell
node tools\yolox-poc\serve.mjs      # puis ouvrir /__suivi
```

Sélectionne **l'extrait `.mp4` et son `.json`** : la cadence vient du sidecar, jamais d'une
supposition. Règle la fenêtre (départ → sortie V1), le pas, et lance.

### Méthode

Logique **BoT-SORT réimplémentée en JS** — c'est-à-dire ByteTrack plus une compensation du
mouvement de caméra — conformément à `AUTOMATION-ARCHITECTURE.md` §5. **Aucune dépendance
ajoutée** : ce sont des algorithmes, pas des bibliothèques.

| Étape | Ce qui se passe |
|---|---|
| Prédiction | filtre alpha-bêta à vitesse constante sur (centre, taille) |
| Rattrapage en bloc | décalage global estimé par vote, adopté seulement s'il apparie mieux |
| Association, 1er temps | détections **fortes** (≥ seuil), affectation **hongroise** |
| Association, 2e temps | détections **faibles** (bande basse) contre les pistes orphelines |
| Occlusion / fusion | boîte trop large recouvrant plusieurs pistes → toutes gardées, occluses |
| États | `detected` · `predicted` · `occluded` · `tentative` · `lost` |

**La bande basse ne change pas le seuil du banc.** 0,30 reste ce qui *crée* une piste ; la bande
0,10–0,30 ne sert qu'à en *sauver* une déjà établie. C'est la trouvaille de ByteTrack, et c'est ce
qui permet de traverser une occlusion sans inventer de voiture.

**Une position prédite ne ressemble jamais à une mesure** : trait pointillé, état affiché, et le
score n'est montré que sur une détection réelle.

### Ce qui a été trouvé en construisant

- **L'association gloutonne échange les identités.** D'où l'affectation hongroise, qui minimise le
  coût total. Un cas de test le reproduit.
- **Une boîte fusionnée corrompt la piste qui l'absorbe.** Elle héritait des 230 px de la boîte
  commune et ne se raccrochait plus à sa voiture de 100 px après séparation. Les fusions sont donc
  repérées **avant** l'association et retirées du jeu : les pistes concernées restent occluses,
  simplement recalées sur le bloc.
- **Corriger la prédiction par le biais du pas précédent compte deux fois le même mouvement.**
  Mesuré : +33 px là où on attendait −90. Le biais s'applique désormais à la boîte d'association,
  jamais à l'état du filtre.
- **Le vrai danger d'un panoramique n'est pas l'absence d'appariement, c'est l'appariement
  plausible et faux.** Sur un balayage de 90 px par pas avec des voitures espacées de 150, chaque
  piste recouvre mieux sa voisine que sa propre voiture : quatre appariements sur cinq, tous
  décalés d'un cran, sans le moindre signe d'échec. D'où l'estimation en bloc, tentée à chaque pas.
- **Un détecteur de « saut » ne sert à rien** : la porte d'IoU interdit déjà à une piste de bondir.
  Les signatures utiles d'un échange d'identité sont ailleurs — inversion d'ordre, relais
  d'identifiant, changement de gabarit, sortie d'occlusion, association peu sûre.

### Diagnostic de fragmentation

Première mesure réelle sur Kerlabo : **5 voitures, 46 pistes à 4 Hz et 90 à 10 Hz**, aucune piste
tenant 70 % de la séquence. Augmenter la fréquence AGGRAVAIT le suivi — ce qui n'a aucun sens pour
un tracker et désignait des défauts de conception, pas un manque de données. Trois ont été trouvés :

**1. Les tolérances étaient comptées en PAS, pas en secondes.** Trois pas d'absence valent 0,75 s à
4 Hz mais 0,30 s à 10 Hz : monter en fréquence resserrait silencieusement tous les délais. C'est
l'explication principale des 219 pertes à 10 Hz contre 66 à 4 Hz. Tout est désormais en secondes.

**2. Le gain de vitesse du filtre dépendait du pas.** `v += β·r/dt` amplifie le bruit de position
quand `dt` diminue : à 10 Hz l'estimation de vitesse était 2,5 fois plus bruitée qu'à 4 Hz, sur la
même vidéo. Les gains dérivent maintenant de **constantes de temps**, donc du temps réel.

**3. La correction consommait le temps écoulé depuis la dernière DÉTECTION**, alors que l'état du
filtre avait déjà été avancé à chaque pas. Après une absence, la position corrigée dépassait la
cible, l'IoU s'effondrait au pas suivant, et la piste se fragmentait d'elle-même.

Et la cause que tu avais repérée à l'œil : **toute détection libre devenait une identité**. Sur la
grille de départ, 7 détections pour 5 voitures donnaient 7 pistes. Une détection libre est
maintenant confrontée, dans cet ordre, à quatre questions :

| Ordre | Question | Résultat |
|---|---|---|
| 1 | reprend-elle une piste occluse ? | `reprise_occlusion` |
| 2 | repêche-t-elle une piste abandonnée récemment ? | `reactivation` |
| 3 | est-ce un doublon d'une piste déjà servie ? | `doublon_ecarte` |
| 4 | sinon | `nouvelle` |

Le doublon se reconnaît à l'**inclusion** autant qu'à l'IoU : les parasites de la grille de départ
sont des boîtes plus petites posées SUR une voiture, décalées, donc invisibles à une fusion à
IoU 0,45. Un doublon est toujours la vue la plus faible — une détection **mieux** notée que la piste
qu'elle recouvre n'est jamais écartée, sans quoi une vraie voiture disparaîtrait au départ.

Enfin, une piste ne compte qu'après une **phase de confirmation** : trois détections **et** 0,4 s
d'existence. Exiger seulement des détections rendait la barre deux fois et demie plus facile à
10 Hz. Avant confirmation, la boîte est dessinée en fil, sans étiquette, et n'entre dans aucune
mesure.

### Mesures

Nombre de voitures suivies à chaque instant, durée des pistes, pertes temporaires, sauvetages par
la bande basse, reprises après occlusion, et l'état au V1. Côté fragmentation : pistes créées
contre **pistes confirmées**, jamais confirmées, durée médiane, nouvelles pistes par seconde,
suppressions, réactivations, doublons écartés, et la **raison** de chaque création et de chaque
suppression. **Aucune ne dit qu'un `trackId` désigne
toujours la même voiture** — cela demande une vérité terrain. Le panneau « à regarder » ramène la
relecture de 43 instants à quelques-uns, chacun cliquable.

### Fréquence

0,50 s (2 Hz) · 0,25 s (4 Hz) · 0,10 s (10 Hz). Comparer deux fréquences donne le seul signal
objectif disponible sans annotation : **si la même séquence ne donne pas les mêmes trajectoires à
4 Hz et à 10 Hz, au moins l'une des deux se trompe.** La concordance ne prouve rien, la discordance
prouve l'erreur.

Ordre de grandeur mesuré en conteneur, YOLOX-s en WebAssembly mono-thread : ~1,7 s par instant,
soit ~75 s pour 43 instants. Sur une machine réelle avec le multi-thread actif, comptez nettement
moins.

### Contrôles

```powershell
node tools\smoke\videoSeek.mjs     # quelle image le navigateur affiche à currentTime = t
npx vitest run tests/trackerCore.test.js
```

`videoSeek.mjs` fabrique une vidéo dont chaque image porte une couleur unique et vérifie le calage.
La règle du navigateur est **l'inverse de celle de ffmpeg** : `<video>` affiche l'image dont
l'intervalle contient `currentTime`, quand `ffmpeg -ss` prend la première dont le PTS lui est
supérieur ou égal.

## Licences

- **YOLOX** (code et poids `tiny` et `s`) : Apache 2.0 — Megvii.
- **ONNX Runtime Web** : MIT — Microsoft.
- Le modèle est téléchargé depuis la page des versions du projet YOLOX, dans
  `tools/yolox-poc/modele/`, dossier ignoré par git.

Les images de corpus sont des extraits de retransmission : elles restent locales, ne sont pas
versionnées, et ne doivent pas être publiées (voir §9 de `EXTRACTION-YOUTUBE.md`).
