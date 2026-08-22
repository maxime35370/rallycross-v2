# Point ② — traverser un changement de plan : analyse avant implémentation

> **Statut : analyse + une sonde de mesure.** Aucune réattribution n'est
> implémentée, et le suivi est inchangé. Ce document dit ce que les données
> imposent, ce qu'elles ne permettent pas encore de décider, et dans quel ordre
> avancer avec le minimum d'hypothèses nouvelles.

---

## 1. Il y a UN changement de plan, pas deux

Le détecteur de ruptures livré au point précédent déduit la coupure du
**comportement du suivi** : beaucoup de pistes sans détection, plusieurs
identités neuves. Confronté aux journaux, il se trompe une fois sur deux.

Le test qui tranche ne demande aucune annotation : **un vrai changement de plan
ne peut pas laisser des pistes détectées en continu avec des trajectoires
lisses**, puisque le référentiel image a changé.

| | t ≈ 6,0 s | t ≈ 10,3 – 10,8 s |
|---|---|---|
| pistes détectées de part et d'autre (4 Hz) | **0** | 3, déplacées de 18 à 33 px |
| pistes détectées de part et d'autre (10 Hz) | **1**, déplacée de 152 px | 4, déplacées de 23 à 59 px |
| pistes détectées sans interruption sur ±0,6 s | **aucune**, aux deux cadences | #13 (4 Hz) · #1 #19 #20 #29 (10 Hz) |
| gabarit des boîtes | passe de ~2:1 (vue de profil) à ~1,3:1 | inchangé |

À 10 Hz, `#1 #19 #20 #29` sont **détectées sans interruption** de 9,7 s à 10,8 s,
avec des trajectoires régulières. Aucun montage ne produit cela.

### Ce qui se passe vraiment vers 10,3 s

Un **plan plus large**, qui découvre des véhicules **immobiles** au fond :

```
#31 (355,285) 71×32   identique de t=9,8 à t=10,7   — 0,9 s sans bouger d'un pixel
#32 (489,276) 66×35   identique de t=9,9 à t=10,8
#34 (863,239) 73×31   #35 (749,250) 73×35   #38 (949,228) 70×34   …
```

Petites boîtes, hautes dans l'image, strictement fixes. YOLOX les détecte par
intermittence autour du seuil : elles créent une piste, ne se ré-associent pas,
meurent au bout de 0,8 s, et renaissent. Elles gonflent le compte de « pistes
vivantes sans mesure » — exactement la signature que le détecteur prenait pour
une coupure.

### Conséquence sur la ventilation

En reclassant les créations (hors grille de départ) et en marquant comme
**parasites** les pistes quasi immobiles ou petites-et-hautes :

| | 4 Hz | 10 Hz |
|---|---|---|
| créations au **vrai cut** (~6 s) | **9** (31 %) | **9** (19 %) |
| créations sur le plan large (~10,3–10,8 s) | 10, dont **6 parasites** | 18, dont **11 parasites** |
| créations ailleurs | 10, dont 6 parasites | 20, dont 6 parasites |
| **parasites, tous instants confondus** | **14 / 29 (48 %)** | **18 / 47 (38 %)** |

Le « 65–69 % imputable aux changements de plan » comptait le second événement.
La part réellement imputable au cut est de **19 à 31 %**. En face, **38 à 48 %
des créations sont des détections parasites sur des objets immobiles**.

Cela ne retire rien au ② : un seul cut suffit à casser la chaîne d'identités,
et c'est précisément l'objectif. Mais cela déplace la priorité relative, et
surtout : **construire ② sur le détecteur actuel réinitialiserait le référentiel
vers 10,3 s, là où quatre pistes sont parfaitement continues.** On détruirait du
suivi correct.

---

## 2. Prérequis livré : détecter le plan dans l'IMAGE

Un changement de plan est un fait d'image. On le mesure donc sur les pixels,
sans regarder ni les pistes, ni les détections, ni un seul seuil du suivi :
`signatureImage()` + `detecterCoupures()` dans `lib/apparence.mjs`.

* **grille 4 × 4**, pas un histogramme global : deux plans d'une même course
  partagent bitume, herbe et ciel — c'est leur *répartition* dans le cadre qui
  change brutalement ;
* **seuil relatif** au niveau local des distances, jamais absolu : un
  panoramique rapide fait monter tout le voisinage, et seul un **pic isolé**
  au-dessus de son propre voisinage est une coupure. Les tests vérifient
  explicitement qu'un panoramique et une scène fixe qui frémit ne déclenchent
  rien ;
* aucun réglage nouveau à deviner : le facteur (×3) porte sur un rapport, et la
  série complète des distances est exportée pour être relue.

Ce que la méthode ne prétend pas faire : reconnaître un fondu enchaîné, ni dater
la coupure plus finement que le pas d'échantillonnage.

**À faire tourner en premier**, sur la page dédiée `/__plans` — qui ne charge
aucun modèle, le scan n'en ayant aucun besoin :

```powershell
node tools\yolox-poc\serve.mjs
# → http://127.0.0.1:8798/__plans
#   1. charger l'extrait ET son .json (la cadence vient du sidecar)
#   2. début 3,000 · fin 13,500 · pas 0,10 s
#   3. fenêtres de transition : 0.20,0.30,0.40,0.60 (comparées automatiquement)
#   4. « Scanner les plans », puis « Exporter le JSON »
```

La page donne les timestamps retenus, la courbe des distances avec le seuil
superposé, le score instant par instant (distance, médiane locale, seuil,
rapport, pic isolé, verdict), et pour chaque coupure la dernière image avant et
la première image après, datées à l'image près par un second passage à la
cadence du fichier.

Contrôle de bout en bout disponible : `node tools\smoke\plansPage.mjs`
fabrique une vidéo dont la vérité est connue (panoramique, coupure à 2,0 s, puis
plan qui s'élargit sur des objets immobiles) et vérifie que le scan trouve la
coupure et rien d'autre — mesuré : 1,98 s pour 2,00 s attendues, rapport ×9,35
contre un facteur 3, panoramique plafonnant à ×2,37.

### La rupture de Kerlabo est un FONDU, pas une coupure

Le scan a trouvé la rupture à t = 5,8333 s (image 350, rapport ×4,63), et
l'examen visuel a montré un **fondu enchaîné** : à cet instant, l'image contient
encore l'ancien et le nouveau plan en transparence.

Cela change la suite. Les images du fondu ne sont **d'aucun des deux plans** :
les boîtes qu'on y détecterait n'appartiennent ni à l'un ni à l'autre, et la
réattribution ne doit surtout pas être faite entre l'image 349 et l'image 350.
Elle doit l'être entre la **dernière image propre** de l'ancien plan et la
**première image propre** du nouveau, les images du fondu étant écartées.

#### L'étendue doit être une propriété locale de la coupure

Première mesure sur la vidéo réelle : **950 ms / 56 images** à ± 0,60 s, mais
**100 ms / 5 images** à ± 0,20 s. Une durée de transition qui dépend à ce point
de la fenêtre d'analyse ne mesure rien, et le défaut a été reproduit puis
corrigé avant d'aller plus loin.

**La cause.** La première version cherchait les images où α touchait 0 ou 1 à
`epsilon` près. Or la caméra bouge à l'intérieur de chaque plan : une image
encore parfaitement pure diffère déjà de l'image de référence par le seul effet
du mouvement, donc son α n'est pas 0. Sur un fondu de 6 images accompagné d'un
panoramique, α oscille de **± 0,12** dans le plan pur — deux fois et demie
l'`epsilon` le plus généreux. Le seuil est alors franchi presque immédiatement
après la référence, et l'étendue rendue vaut à peu près la largeur de la
fenêtre : 25 · 38 · 50 · 74 images pour des demi-fenêtres de 0,20 · 0,30 · 0,40
· 0,60 s. Les synthétiques précédents ne montraient rien parce qu'ils n'avaient
qu'un objet mobile — une minorité de pixels, que la médiane absorbait. Un
panoramique, lui, déplace **tous** les pixels.

Rapprocher les références de la transition par contractions successives, essayé
également, ne sauve rien : c'est la contamination par le mouvement qui décide
seule du point fixe, sans rapport avec le fondu (71 images au lieu de 74).

**Deuxième tentative, elle aussi fausse.** « Le plus court intervalle captant
98 % de la montée totale » : correct sur synthétique, faux sur la vidéo réelle
— **7 · 22 · 30 · 34 images**. La « montée totale » inclut la dérive. Sur la
coupure Kerlabo, α passe de 0,013 à 5,333 s à 0,31 à 5,80 s **sans qu'aucun
fondu ait commencé** : 0,64 par seconde de dérive pure, que la méthode absorbait.

**La correction : modéliser la dérive au lieu d'essayer de la franchir.**

```
α(t) = a + b·t + s · rampe(t ; début, fin)
```

`b` est la dérive imposée par le mouvement de caméra — avant, pendant et après.
`s·rampe` est le fondu. On essaie tous les couples (début, fin) et on garde
celui qui minimise l'erreur : **aucune pénalité, donc aucun seuil**, car élargir
la rampe force une montée lente là où les données en montrent une rapide, ce qui
augmente l'erreur.

Mesuré sur une série α calquée sur la coupure réelle — dérive 0,64/s, fondu de
0,08 s :

| demi-fenêtre | ± 0,20 | ± 0,30 | ± 0,40 | ± 0,60 |
|---|---|---|---|---|
| bornes trouvées | 5,8167 → 5,9000 | idem | idem | idem |
| dérive `b` reconstituée | 0,637 /s | 0,652 | 0,634 | 0,641 |

**Identiques aux quatre fenêtres**, et la dérive est retrouvée pour ce qu'elle
est. Sur la vidéo témoin encodée : 9 images aux quatre fenêtres, **dispersion
0 ms sur les deux bornes**.

**Le chiffre qui dit s'il y a un fondu** est la part de variance que la rampe
explique en plus de la dérive seule : **88 à 99,9 %** sur un fondu, **4,5 à 8 %**
sur un panoramique sans fondu, **98 %** sur une coupure franche (avec 0 image
intermédiaire). Aucun seuil n'est figé dessus tant que plusieurs vraies coupures
n'ont pas été mesurées.

> **La fenêtre doit être plusieurs fois plus large que la transition** — au
> moins trois fois. Sinon il ne reste pas assez de plan de part et d'autre pour
> estimer la dérive, et la fenêtre est déclarée non exploitable au lieu d'être
> devinée.

### Refus de conclure

Quand les fenêtres ne s'accordent pas, **aucune borne n'est produite** :
`fiable: false`, `bornes: null`, raisons écrites, et `bornesPropres` ne contient
que les ruptures concordantes. Le cas signalé — quatre fenêtres marquées
exploitables, bornes dispersées de 450 ms, et des bornes produites quand même —
ne peut plus se reproduire.

`lib/transition.mjs` mesure cette étendue. Un fondu étant une opération exacte,
`I = (1−α)·A + α·B`, chaque canal de chaque pixel donne son propre α et il
suffit d'en prendre la médiane — estimateur choisi après avoir mesuré l'échec
des deux autres (projection globale : α plafonne à 0,42 au lieu de 1,0 dès
qu'une caméra bouge pendant le fondu ; médiane par zones : instable dès que le
mouvement occupe la moitié des zones).

Le verdict « coupure franche ou transition étalée » ne repose sur aucun seuil :
il ne regarde que le nombre d'images intermédiaires.

> Cette marge — ×2,37 pour un panoramique contre un facteur 3 — est réelle mais
> pas immense. Sur une retransmission, un panoramique plus vif peut s'en
> approcher. C'est précisément pourquoi le tableau publie le seuil de chaque
> instant : si une coupure est manquée, on voit à quel rapport elle est passée,
> et on abaisse le facteur en connaissance de cause plutôt qu'au jugé.

---

## 3. Le problème que rien ne peut contourner : la vérité au cut

« Combien d'identités sont correctement reconnectées » ne se calcule pas. Aucun
critère interne ne peut dire si `#5 → #19` est juste : c'est justement la
question posée. Trois substituts existent, et deux ne valent rien :

| Substitut | Ce qu'il vaut |
|---|---|
| concordance 4 Hz / 10 Hz | corroboration seulement — deux erreurs identiques restent des erreurs |
| plausibilité de la suite (pas de re-fragmentation immédiate) | indice faible, satisfait aussi par une correspondance fausse mais stable |
| **annotation humaine au cut** | **la seule vérité** |

Et le coût de cette annotation est dérisoire : **un cut, cinq voitures, cinq
jugements**. Le banc affiche déjà les images ; il suffit de montrer la dernière
image avant et la première après, boîtes numérotées, et de cliquer les paires.

C'est le minimum d'hypothèses au sens strict : au lieu d'inventer un critère,
on va chercher les cinq étiquettes qui manquent.

---

## 4. Squelette commun aux trois variantes : la suspension

Aujourd'hui, au cut, les pistes d'avant ne meurent pas : elles survivent en
`predicted` / `occluded` pendant 0,8 à 2,0 s **à côté** des nouvelles. À
t = 6,3 s (10 Hz) le suivi porte 13 pistes pour ~5 voitures — cinq fantômes du
plan précédent et huit identités neuves.

La suspension remplace cela : à un cut confirmé, chaque piste vivante passe dans
un état **suspendu**. Son état cinématique est gelé et déclaré inutilisable ;
elle ne prédit plus, ne produit plus de refus, ne compte plus parmi les pistes
vivantes. Les détections du nouveau plan ouvrent des identités **provisoires**.
Aucune association géométrique ne traverse la frontière.

Hypothèse nouvelle : **une seule** — que l'instant du cut soit juste. D'où
l'ordre : le détecteur d'abord.

---

## 5. Les trois variantes, et ce que chacune suppose

### ① Reset géométrique simple

Suspension, puis rien. Chaque voiture repart sous une identité neuve.

* **hypothèses ajoutées** : aucune au-delà de l'instant du cut ;
* **ce qu'elle gagne** : plus de fantômes, moins de pistes simultanées, moins de
  refus au cut, compte au V1 lisible ;
* **ce qu'elle ne fait pas** : les identités ne traversent pas. Sur l'objectif
  final, elle vaut **zéro identité logique conservée** ;
* **son rôle** : c'est le **témoin**. Les variantes 2 et 3 doivent prouver leur
  gain contre elle, pas contre l'état actuel.

### ② Reset + cohérence de groupe

On cherche l'appariement entre les identités suspendues et les identités
provisoires, en supposant que **l'agencement relatif du groupe se conserve à une
similitude près** (translation, rotation, échelle). C'est le modèle le moins
exigeant qui survive à un changement de point de vue sur un groupe à peu près
plan et à peu près rigide vu de loin — et il contraint aussi les **tailles**,
gratuitement, ce qui réduit l'ambiguïté.

Mise en œuvre sans machinerie nouvelle : deux correspondances définissent une
similitude ; on énumère les paires (au plus quelques milliers avec ≤ 8 pistes de
chaque côté), on garde le meilleur consensus, et l'affectation finale est un
hongrois sur les distances transformées — l'algorithme est déjà là.

> **Attention à ne pas réutiliser le mauvais chiffre.** Les 94,5 % / 97,0 % de
> conservation de l'ordre gauche-droite sont mesurés **entre deux instants d'un
> même plan**. Ils ne disent rien de la conservation de l'ordre **à travers**
> une coupure — une caméra placée de l'autre côté de la piste inverse l'ordre
> apparent. C'est pour cela qu'on ajuste une transformation au lieu de postuler
> l'ordre : la similitude, elle, se vérifie sur les données du cut.

* **hypothèses ajoutées** : (a) l'agencement se conserve à une similitude près ;
  (b) au moins trois voitures sont visibles des deux côtés ;
* **règle de refus** : si le meilleur consensus ne dépasse pas le meilleur
  consensus incompatible d'une marge mesurée, ou si moins de trois
  correspondances s'accordent, l'identité reste **ouverte**. Rien n'est forcé ;
* **cas du miroir** : on ajuste aussi la similitude avec réflexion. Si les deux
  expliquent aussi bien, on refuse de trancher plutôt que de tirer à pile ou face.

### ③ Reset + cohérence de groupe + apparence

L'apparence entre uniquement comme **terme secondaire du coût**, avec un poids
borné qui ne peut jamais renverser un consensus géométrique franc : elle
départage des ex æquo, elle ne décide pas.

Les chiffres mesurés justifient exactement cette place, et pas davantage :
contraste **1,83 / 2,49** (les livrées se distinguent en moyenne) mais
reconnaissance **36 % / 37 %** (au-dessus du hasard à 20 %, très loin d'une
identification). Une signature qui se trompe deux fois sur trois n'a pas voix au
chapitre seule.

> **Une mesure à faire avant d'implémenter ③, et elle est gratuite.** Le taux de
> 36 % est calculé sur **toute** la séquence, coupure comprise : la même voiture
> vue avant et après le cut compte comme une distance « intra-piste », ce qui
> gonfle artificiellement l'intra et écrase le taux. Il faut recalculer
> `separabilite()` **à l'intérieur d'un même plan**, puis séparément **à travers
> la coupure**. Les deux nombres décident du sort de ③ :
>
> * intra-plan élevé, inter-plan faible → l'apparence sert au suivi continu,
>   pas au franchissement : ③ n'a pas lieu d'être *pour cet usage* ;
> * les deux corrects → ③ mérite d'être essayé ;
> * les deux faibles → la signature HSV est à revoir avant tout, pas à câbler.

---

## 6. Ce qu'il faut mesurer, et comment ne rien forcer

Par variante et par cut, trois nombres **toujours donnés ensemble** — un
mécanisme qui refuse tout obtient zéro faux, et paraîtrait excellent si on ne
lisait qu'une colonne :

| | signification |
|---|---|
| **reconnectées justes** | conformes aux cinq étiquettes |
| **reconnectées fausses** | contraires aux étiquettes — c'est un veto, pas un coût |
| **non décidées** | la règle de refus a joué : l'identité reste ouverte |

Et le critère qui compte vraiment, celui de l'objectif :

> **identités logiques au V1** — parmi les cinq identités nées de la grille de
> départ, combien atteignent le V1 par une chaîne de filiation **ininterrompue
> et non bifurquée**.

Ce n'est pas « 5 pistes actives ». Cela demande d'ajouter une **filiation** : une
piste réattribuée enregistre l'identité logique dont elle hérite, et
`identiteLogique` est la racine de la chaîne. Petit ajout, mais c'est lui qui
transforme l'objectif en mesure.

---

## 7. Ordre recommandé

| | Étape | Nature | Ce qu'elle décide |
|---|---|---|---|
| 0 | détecter les plans dans l'image | **livré**, mesure seule | combien de cuts réels — et si le détecteur actuel se trompe bien vers 10,3 s |
| 1 | annoter les 5 correspondances au cut réel | annotation, 5 clics | la vérité, sans laquelle rien n'est mesurable |
| 2 | suspension + filiation (variante ①) | comportement | le témoin, et la fin des fantômes |
| 3 | cohérence de groupe (variante ②) | comportement | si l'agencement traverse le cut |
| 4 | séparabilité intra-plan vs inter-plan | mesure seule, gratuite | si ③ a un sens |
| 5 | apparence en coût secondaire (variante ③) | comportement | conditionné à l'étape 4 |

Et une question qui n'est pas dans le ② mais que les chiffres poussent en avant :
**38 à 48 % des créations sont des parasites immobiles**. Aucune des trois
variantes ne les touche. Une fois ② mesuré, c'est probablement le meilleur
rapport gain / risque suivant.
