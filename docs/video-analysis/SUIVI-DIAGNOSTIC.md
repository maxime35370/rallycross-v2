# Suivi temporel — diagnostic de la fragmentation sur la séquence Kerlabo

> **Statut : analyse, pas correction.** Aucun des trois mécanismes envisagés
> (référentiel réinitialisé au cut, cohérence spatiale, signature d'apparence)
> n'est câblé dans l'association. Ce document dit ce que les mesures permettent
> de conclure, ce qu'elles ne permettent pas, et dans quel ordre corriger.

Séquence : `Kerlabo_2026_D3_Q3_S4.mp4`, fenêtre 3,00 → 13,50 s, YOLOX-s,
seuil 0,30, bande basse 0,10, compensation caméra active, modèle `globale`.
Cinq voitures.

| | 4 Hz | 10 Hz |
|---|---|---|
| instants | 43 | 106 |
| pistes créées / confirmées | 35 / 19 | 53 / 31 |
| durée médiane des pistes | 2,50 s | 1,00 s |
| pistes ≥ 5 s | 3 | 3 |
| réactivations | 2 | **0** |
| refus d'association | 204 | 568 |
| résidu médian de prédiction | 60,6 px | 44,2 px |

---

## 0. Ce qui manquait pour répondre, et qui a été ajouté

Les rapports existants ne permettaient pas de répondre objectivement. Quatre
manques, comblés par de l'**instrumentation seule** — aucun changement de
comportement du suivi :

| Manque | Ajout |
|---|---|
| aucune trace des changements de plan | `detecterRuptures()` — repère la coupure, ne la compense pas |
| pas de ventilation autour des coupures | `ventilerAutourDesRuptures()` |
| l'ordre du groupe n'était jamais mesuré | `coherenceSpatiale()` |
| aucune donnée colorimétrique | `lib/apparence.mjs` — sonde, jamais consultée par l'association |
| `boiteAvant` / `boiteCompensee` calculées mais pas exportées | ajoutées au journal exporté |
| vitesses de l'état interne invisibles | `vitesse: {vx, vy, vw, vh}` par piste |
| bilan d'association du pas absent | `association: {candidates, appariees, sansMesure, creees, …}` |
| comparaison des modèles de caméra limitée au **dernier** pas | `comparaisonAgregee` sur tous les pas |

`detecterRuptures()` est une fonction **pure sur le journal exporté** : elle a
donc pu être validée sur les deux rapports produits **avant qu'elle n'existe**.
C'est ce qui donne du poids aux chiffres ci-dessous.

### Comment une rupture est reconnue

Deux signaux, et il faut les **deux** :

* presque aucune piste vivante ne retrouve de détection ;
* plusieurs identités naissent au même instant.

Pris isolément, chacun ment. Une occlusion collective donne le premier ; un flou
de détection donne le second. Ensemble, ils ne se produisent que quand l'image
entière a changé. Les tests vérifient explicitement les deux faux positifs.

**Résultat sur la séquence réelle — les deux fréquences tombent d'accord :**

| | 4 Hz | 10 Hz |
|---|---|---|
| coupure 1 | t = 6,00 s (score 0,82) | t = 5,90 s (score 0,71) |
| coupure 2 | t = 10,75 s (score 0,43) | t = 10,30 → 10,70 s (score 0,51) |

Il y a donc **deux** changements de plan dans la fenêtre 3,0 – 13,5 s, pas un.

---

## 1. Quelle part de la fragmentation vient du cut ?

| | 4 Hz | 10 Hz |
|---|---|---|
| créations hors grille de départ | 29 | 47 |
| dont à ± 0,55 s d'une coupure | **19 (66 %)** | **27 (57 %)** |
| refus par instant près d'une coupure | 9,0 | 7,8 |
| refus par instant hors coupure | 3,5 | 4,6 |

**Environ 60 % des identités fabriquées le sont autour des deux coupures**, aux
deux fréquences. Une coupure coûte deux à trois fois plus de refus par instant
qu'un instant ordinaire.

C'est la cause **la plus concentrée** — mais elle laisse 40 % des créations
inexpliquées, et ces 40 % se produisent pendant une caméra parfaitement continue.

Un cut ne se compense pas comme un panoramique : le référentiel image est
réellement réinitialisé, il n'existe aucune transformation à estimer. Le seul
traitement possible est de **suspendre** la prédiction et la porte géométrique
le temps d'un pas, puis de rattacher les identités par autre chose que la
position — c'est-à-dire par l'apparence, dont §4 montre qu'elle n'est pas
encore mesurée.

---

## 2. Où les pistes se fragmentent-elles hors cut ?

Refus hors coupure, par cause :

| Cause | 4 Hz | 10 Hz |
|---|---|---|
| `distance` | 61 | 213 |
| `ratio_taille` | 8 | **61** |
| `piste_deja_attribuee` | 8 | 49 |
| `iou_insuffisant` | 8 | 16 |
| `aucune_detection` | 15 | 16 |

Et le rapport de taille **au moment du refus** :

| | 4 Hz | 10 Hz |
|---|---|---|
| médiane | 2,86 | 3,89 |
| p90 | 13,8 | 16,6 |
| **maximum** | 30,6 | **497** |
| amplitude de largeur sur la vie d'une piste (max/min), p90 | 4,4 | 5,2 |
| … maximum | 11,1 | **271** |

> Les rapports de taille des refus sont des rapports d'**aire** (`rapportTaille`
> compare des aires) ; les amplitudes de largeur sont **linéaires**. Un facteur
> 497 en aire vaut environ 22 en linéaire.

Une voiture ne change pas de largeur d'un facteur 271 en dix secondes. Ce n'est
pas la voiture qui diverge, c'est **la boîte prédite**.

### La cause structurelle : la vitesse de taille n'est bornée par rien

Le filtre alpha-bêta corrige quatre vitesses, dont deux de **taille** :

```js
s.vw += kv * (rw / dt);   s.vh += kv * (rh / dt);   // rien ne borne vw
```

Deux pistes du rapport 10 Hz montrent le mécanisme exact — et il ne s'agit pas
d'une explosion, mais d'un **effondrement** :

```
piste #18   largeur mesurée   271 → 257 → 183 → 120 → 110   (hauteur : 167 → 160, constante)
            puis extrapolée    80 →  46 →  19 →   1 →   1   ← plancher de Math.max(1, …)
piste #10   largeur mesurée   211 → 211 → 211 → 129 → 110
            puis extrapolée   104 →  81 →  63 →  48 → 36 → 25 → 17 → 10
```

Rejouer ces largeurs dans le prédicteur reproduit le journal **au pixel près**
(`tests/trackerCore.test.js`) : la cause est établie, pas supposée.

Ce qui déclenche l'effondrement n'est pas la coupure, mais deux artefacts de
détection :

* **la boîte tronquée par le bord de l'image.** Piste #18 : la voiture sort du
  cadre par la droite, son bord droit reste collé à x = 1919, la largeur
  mesurée s'effondre — alors que la hauteur, elle, ne bouge pas. La voiture n'a
  pas changé de taille, seule la boîte a été rognée ;
* **une boîte fusionnée qui se sépare.** Piste #10 : 211 px puis 110 px.

Et ce qui transforme l'artefact en dérive, c'est l'absence de borne :

1. **`vw` encaisse le rétrécissement** et le transforme en vitesse ;
2. **la porte d'association ne l'arrête pas**, parce qu'elle compare la
   détection à la boîte **prédite**, pas à la précédente mesure. La boîte
   prédite suivant l'effondrement, chaque pas reste sous le rapport de 2 : la
   descente se fait par petits pas tous licites, jamais par un bond unique ;
3. **puis la piste extrapole seule** — jusqu'à 0,8 s d'abandon, 2,0 s
   d'occlusion, 1,5 s de fenêtre de repêchage — et la largeur atteint le
   plancher de 1 px.

D'où les deux conséquences mesurées : les 61 refus `ratio_taille` hors coupure
à 10 Hz, et surtout l'impossibilité du repêchage — `_reactiver()` exige
`rapportTaille(boitePredite, detection) ≤ 2,0`, et une boîte de 1 px de large
ne peut plus jamais y satisfaire.

C'est la réponse à la deuxième moitié de la question 5 : **les réactivations ne
tombent pas à 0 par malchance, elles sont géométriquement impossibles.**

---

## 3. La cohérence spatiale aurait-elle conservé l'identité ?

L'ordre gauche-droite du groupe est **remarquablement stable** :

| | 4 Hz | 10 Hz |
|---|---|---|
| paires suivies d'un instant au suivant | 452 | 2 049 |
| inversions | 25 | 49 |
| **ordre conservé** | **94,5 %** | **97,6 %** |
| écart entre voisins (largeurs de boîte) p10 / médian / p90 | 0,17 / 0,73 / 1,37 | 0,11 / 0,63 / 1,58 |

L'hypothèse est donc **fondée** : l'ordre porte de l'information réelle.

Mais il faut regarder ce qu'elle pourrait corriger. Un coût de cohérence de
groupe n'intervient que lorsque **plusieurs associations se disputent la même
détection** — les refus `piste_deja_attribuee` et `cout_hongrois` :

| | 4 Hz | 10 Hz |
|---|---|---|
| refus de compétition | 24 / 204 (**11,8 %**) | 69 / 568 (**12,1 %**) |
| … dont hors coupure | 13 | 53 |

**Plafond : 12 % des refus, environ 6 % hors coupure.** Le reste — 88 % — n'est
pas un problème d'arbitrage entre candidats plausibles : il n'y a pas deux
candidats, il n'y en a aucun, parce que la boîte prédite est fausse.

Deuxième réserve, chiffrée : le p10 de l'écart entre voisins vaut 0,11 largeur
de boîte. Une fois sur dix, deux voitures sont pratiquement superposées en x —
et c'est précisément la configuration d'un dépassement au virage 1. Une
contrainte rigide sur l'ordre y ferait exactement l'erreur qu'on cherche à
observer. **Coût mou, jamais interdit** — la mesure confirme l'intuition.

---

## 4. Une signature d'apparence aurait-elle levé des ambiguïtés ?

**Aucune réponse honnête n'est possible à partir des rapports existants : ils ne
contiennent pas un seul pixel de donnée colorimétrique.** Prétendre le contraire
serait remplacer une géométrie mesurée par une couleur supposée.

D'où la sonde `lib/apparence.mjs`, ajoutée pour **mesurer**, pas pour décider.
Rien dans `track.mjs` ne l'importe.

* signature HSV zonée : trois bandes horizontales — toit, flancs, bas de caisse
  — parce que c'est l'**agencement** des couleurs qui distingue deux livrées qui
  partagent les mêmes teintes ;
* canal achromatique séparé, sans quoi une livrée blanche et une livrée noire
  tomberaient dans le même seau « teinte indéfinie » — deux livrées sur cinq en
  rallycross ;
* calculée uniquement sur la boîte **réellement détectée**, jamais sur une boîte
  prédite : on y mesurerait la couleur du bitume ;
* moyennée sur les observations, les plus récentes pesant plus lourd.

Trois chiffres décideront, au prochain passage sur la même vidéo :

| Mesure | Ce qu'elle tranche |
|---|---|
| `contraste` = distance inter-pistes / distance intra-piste | < 1,5 → l'apparence n'apporte rien et ajoute du bruit |
| `tauxPlusProche` (une observation contre toutes, sans s'auto-reconnaître) | < 80 % → inutilisable pour rattacher après un cut |
| `traversees[]` — l'appariement que l'apparence proposerait à chaque coupure | dit directement si on obtient `#1..#5 → #1..#5` ou `#20..#24` |

Tant que ces trois chiffres ne sont pas connus **sur cette vidéo**, câbler
l'apparence serait un pari.

---

## 5. Pourquoi 10 Hz reste-t-il plus fragmenté que 4 Hz ?

Pas parce que le pas est plus court : parce que **la vitesse de taille est
alimentée par du bruit divisé par `dt`**.

Le bruit de boîte du détecteur ne diminue pas quand `dt` diminue — il est
indépendant du pas. Mais il est divisé par `dt` avant d'entrer dans `vw` :

* à 4 Hz, un résidu de 10 px injecte ≈ 19 px/s dans `vw` ;
* à 10 Hz, le même résidu en injecte ≈ 22 px/s — **et 2,5 fois plus souvent.**

L'amortissement (`tauAmortissement`) ne s'applique **que** lorsqu'il n'y a pas
de mesure. Tant que la piste est détectée, `vw` fait une marche aléatoire sans
rappel, avec 2,5 fois plus de pas par seconde. Les chiffres suivent : à 10 Hz,
61 refus `ratio_taille` hors coupure contre 8 à 4 Hz, un rapport maximal de 497
contre 30, et une amplitude de largeur allant jusqu'à 271 contre 11.

C'est aussi pourquoi la fenêtre 3,0 – 5,3 s — **avant toute coupure** — compte
122 refus en 24 instants à 10 Hz contre 33 en 10 instants à 4 Hz.

Et les réactivations : voir §2, point 3. À 4 Hz la divergence reste assez faible
pour que deux repêchages passent la porte de gabarit ; à 10 Hz, aucun.

> Ce que cela invalide au passage : mes scénarios synthétiques donnaient un
> résidu de prédiction de 0 à 4 px là où la vidéo réelle en donne 60,6. Un
> facteur 15. Ils restent utiles pour vérifier des invariants de logique, ils ne
> valent rien comme approximation de la séquence.

---

## 6. Modification minimale recommandée, et dans quel ordre

**Une seule chose d'abord : borner la vitesse de taille du prédicteur.**
*(implémenté — voir « Le point ① » plus bas)*

Concrètement : plafonner `vw`/`vh` à une fraction de la dimension courante par
seconde, et écrêter le résidu de taille avant d'en faire une vitesse. Rien
d'autre ne change — ni seuil, ni porte, ni YOLOX.

Pourquoi celle-là en premier :

* elle traite la cause **structurelle** dominante hors coupure (`ratio_taille`
  à 10 Hz, et une bonne part des refus `distance`, dont le rapport de taille
  médian atteint déjà 3,8) ;
* elle **débloque mécaniquement le repêchage**, aujourd'hui impossible ;
* elle explique et devrait résorber l'essentiel de l'écart 4 Hz / 10 Hz ;
* elle est **locale à `Predicteur`**, donc mesurable seule ;
* elle ne peut pas créer d'échange d'identité : elle rend les boîtes prédites
  plus proches du réel, jamais plus permissives.

Ensuite, **une amélioration à la fois**, chacune mesurée à 4 Hz et 10 Hz sur la
même vidéo :

| Ordre | Changement | Ce qu'il doit améliorer | Ce qui l'invaliderait |
|---|---|---|---|
| 1 | borner `vw`/`vh` — **fait** | `ratio_taille`, réactivations, écart 4/10 Hz | plus d'échanges d'identité |
| 2 | suspendre la géométrie sur un pas de rupture | créations près des coupures (60 % du total) | des créations en hausse hors coupure |
| 3 | coût mou de cohérence de groupe | refus de compétition (plafond 12 %) | un dépassement au V1 manqué |
| 4 | apparence dans l'association | rattachement après coupure | contraste mesuré < 1,5 (§4) |

L'étape 4 n'est **conditionnée** qu'aux chiffres de la sonde, pas à une intuition.

### Ce qu'il ne faut pas faire

* **Élargir la porte de gabarit.** Mesuré : seuls 13 des 23 refus `ratio_taille`
  à 4 Hz et **15 des 70** à 10 Hz passeraient une porte élargie à 3,0. On
  gagnerait peu et on ouvrirait la porte aux échanges d'identité.
* **Allonger les délais d'abandon.** Cela masque la fragmentation sans toucher
  à sa cause : les pistes survivraient avec des boîtes fausses.
* **Compenser géométriquement un cut.** Il n'y a rien à estimer : le référentiel
  est réinitialisé, pas transformé.

---

## Le point ① — bornes de la vitesse de taille

Deux constantes, **lues dans les données** et non devinées. Les deux fréquences
donnent la même valeur, ce qui est attendu d'une grandeur physique :

| Constante | Valeur | Justification mesurée |
|---|---|---|
| `vitesseTailleMax` | **1,0 s⁻¹** | taux vrai de changement de taille sur une base d'une seconde : p99 = 0,92 s⁻¹ à 4 Hz, 0,94 s⁻¹ à 10 Hz |
| `ratioTailleMax` | **1,5** | rapport entre deux mesures consécutives : p99 = 1,50 à 4 Hz, 1,54 à 10 Hz — 1,2 % au-dessus aux deux fréquences |

Le plafond est **relatif à la taille courante** et réappliqué à chaque pas :
une boîte qui rétrécit voit son plafond rétrécir avec elle, la décroissance
devient géométrique et n'atteint jamais le plancher. C'est ce qui rend la
dérive *impossible* plutôt que seulement plus lente.

Le résidu est **écrêté, pas ignoré**. Ignorer laisse intacte une vitesse déjà
fausse — mesuré : un prédicteur qui refusait la mise à jour gardait une vitesse
de −48 px/s et continuait de rétrécir. Écrêter garantit que la vitesse va
toujours *vers* la mesure, sans jamais bondir. L'écrêtage est symétrique en
**rapport** et non en pixels, sans quoi il tolérerait +50 % mais −50 %, soit un
rapport de 2 d'un côté et 1,5 de l'autre.

**Ce que la mesure a corrigé dans mon diagnostic :** j'avais annoncé une
explosion de la boîte alimentée par les résidus de coupure. Le rejeu des
largeurs réelles montre un **effondrement**, alimenté par des boîtes tronquées
au bord de l'image et par des fusions qui se séparent. La correction est la
même — c'est la borne qui manquait — mais la cause première est ailleurs, et
elle désigne un candidat naturel pour plus tard : **une boîte dont un bord
touche le bord de l'image a une taille non fiable**, et devrait être traitée
comme telle. Hors périmètre du point ①.

Ce que le rapport donne maintenant pour juger l'effet :
`mesures.deriveTaille` — amplitude médiane / p90 / max de la boîte publiée sur
la vie d'une piste, plus le nombre de fois où chacune des deux gardes a servi.

## Reproduire ces chiffres

```powershell
node tools\yolox-poc\serve.mjs
# track.html → charger l'extrait + le sidecar → 3,000 / 13,500 → 4 Hz puis 10 Hz
npx vitest run tests/trackerCore.test.js tests/apparenceSignature.test.js
```

Le rapport exporté contient désormais `mesures.ruptures`,
`mesures.coherenceSpatiale`, `mesures.camera.comparaisonAgregee`, `apparence`,
et un journal complet (`boiteAvant`, `boiteCompensee`, `boiteAssociee`,
`vitesse`, `association`).
