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

### Vérifier quel code a produit le rapport

La page affiche `derive+rampe/1` en tête, et le JSON exporté porte le même
identifiant sous `methode`. Le serveur envoie désormais `Cache-Control: no-store`.
Un rapport dont l'identifiant ne correspond pas au code attendu vient d'un module
en cache, et ses chiffres ne décrivent pas la méthode courante.

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

---

## 8. Témoin ① mesuré — le zéro à battre

Runs du 23/08 sur `Kerlabo_2026_D3_Q3_S4_depart`, fenêtre 3,000 → 13,500 s,
YOLOX-s, coupure `5,800 → 5,900 s` lue dans `rapport-plans-10hz.json`
(méthode `derive+rampe/1`, 5 images de transition, dispersion 17 / 0 ms,
4 fenêtres concordantes sur 4, aucune rupture rejetée).

| métrique | sans coupure, 4 Hz | témoin ① 4 Hz | témoin ① 10 Hz |
|---|---|---|---|
| identités nées au départ | 6 | 6 | 6 |
| **identités du DÉPART au V1** | **0** | **0** | **0** |
| identités logiques au V1 | 3 | 3 | 4 |
| pistes créées | 41 | 37 | 47 |
| pistes confirmées | 21 | 21 | 28 |
| durée médiane | 1,25 s | 2,00 s | 1,80 s |
| pistes gelées au cut | — | 12 | 17 |
| réattribuées | — | 0 | 0 |
| dérive de taille max | ×8,86 | ×8,86 | ×4,81 |

### Ce que la coupure change vraiment

Le tableau le dit mal ; le journal le dit bien. **Sans coupure**, à t = 6,00 s
le suivi porte encore les pistes 1, 4, 7, 8, 9, 10, 11 et 12 — huit identités
du plan A recollées sur des voitures du plan B, par simple proximité
géométrique. **Avec coupure**, à t = 5,90 s il n'y a plus que des identités
neuves, et aucune ne franchit.

La coupure ne fait donc pas gagner d'identités : elle empêche d'en gagner de
fausses. `survivantesDepart = 0` dans les deux cas, mais pour deux raisons
opposées — dans un cas les continuités existent et sont fausses, dans l'autre
elles n'existent pas. C'est cette seconde situation qu'une réattribution peut
réparer ; la première, non.

### Le trou que ce témoin a révélé

`couper()` épargnait les pistes déjà `LOST`, qui restaient donc réactivables
de l'autre côté du cut. Mesuré à 4 Hz : la piste 3, perdue à 5,50 s,
réapparaissait à 6,00 s et vivait jusqu'à 10,75 s comme continuité confirmée.
Une coupure qu'une piste peut contourner n'est pas une coupure. Corrigé, avec
un test qui tombe sans le correctif.

### Objectif chiffré de l'étape suivante

Cinq voitures sont visibles de part et d'autre du cut. La réattribution par
cohérence spatiale doit faire passer `survivantesDepart` de **0** à un nombre
non nul sans créer d'appariement faux — l'appariement optimal global mesuré
sur l'apparence seule plafonnait à 3/4, avec un écart normalisé de 3,6 % et
une marge relative de 1,25 %. C'est trop serré pour décider seul : l'apparence
reste un départage secondaire, pas le critère.

---

## 9. Réattribution par cohérence spatiale — mesurée

Méthode `similitude-groupe/1`. Runs du 23/08 sur `Kerlabo_2026_D3_Q3_S4_depart`,
fenêtre 3,000 → 13,500 s, coupure `5,800 → 5,900 s`, vérité annotée à la main
(`tools/extract-manche/extraits/verite-cut-5.9.json`, 4 correspondances).

### Verdict contre la vérité

| | 4 Hz | 10 Hz |
|---|---|---|
| décision | refus | consensus |
| **justes** | 0 | **3** |
| **fausses** | **0** | **0** |
| non décidées | 4 | 1 |
| modèle gagnant | directe (−162,5°) | directe (−173,9°) |
| coût meilleur / second | 0,4226 / 0,4290 | 0,4063 / 0,4462 |
| marge relative | 1,5 % | 8,9 % |
| hypothèses écartées par le sens | 600 / 1200 | 600 / 1200 |
| apparence | indisponible | 0,5411 vs 0,5624, écart 3,8 % — ne tranche pas |
| identités du départ au V1 | 0 | 0 |
| **portée max d'une identité du départ** | 5,75 s | **11,6 s** (était 5,8 s) |

Le lien entre les boîtes annotées et les pistes est parfait à 10 Hz (IoU = 1
sur les neuf voitures), donc le verdict porte bien sur la vérité et non sur un
alignement approximatif.

### Ce que la mesure a démenti

**Les centres seuls ne suffisent pas.** Le nuage de voitures est presque
aligné : une réflexion y est presque indiscernable d'une rotation d'un
demi-tour. La bonne réponse n'arrivait qu'en **troisième** position, derrière
deux appariements décalés d'un rang. Le désaccord de TAILLE — la similitude
prédit son échelle, donc de combien les boîtes doivent grossir — la met au
rang 1, pour tout poids de 0,75 à 5. C'est une information déjà contenue dans
l'hypothèse, indépendante des centres, et elle ne coûte rien.

**Le modèle gagnant n'est pas la réflexion.** L'ordre en x s'inverse bien
entre les deux plans, mais une rotation de 174° l'explique mieux qu'un miroir.
Les deux restent en concurrence — la réflexion est le second — et c'est
justement pourquoi il fallait les essayer toutes plutôt que d'en supposer une.

**Le consensus à deux hypothèses est trop faible.** À 4 Hz il retenait une
paire fausse : elle était stable entre le meilleur et le second parce que ces
deux-là partageaient un point d'appui, pas parce qu'elle était sûre. Une
troisième hypothèse aussi bonne la contredisait. Le consensus exige désormais
l'unanimité sur TOUTES les hypothèses que la marge ne sépare pas du meilleur ;
à 4 Hz cela donne un refus complet, ce qui est la bonne réponse.

**La mémoire d'apparence était vide.** La page calculait les signatures APRÈS
le pas, pour la sonde, sans jamais les injecter dans les détections. Le
départage par apparence n'aurait jamais pu s'exercer : il aurait refusé faute
de matière, silencieusement, et on aurait conclu que l'apparence ne sert à
rien. Corrigé — à 10 Hz elle s'exerce (3,8 % d'écart) sans trancher.

### Pourquoi 4 Hz échoue là où 10 Hz réussit

La coupure est à 5,900 s. Sur la grille 4 Hz, le premier instant du plan neuf
est 6,000 s : cent millisecondes plus tard, pendant lesquelles la voiture de
tête a parcouru une vingtaine de pixels et sort du cadre par la droite. Sa
boîte est tronquée, donc jamais mémorisée — d'où l'apparence indisponible — et
la configuration du groupe est mesurée sur un nuage déjà déformé. La marge
tombe à 1,5 % et plus rien ne tranche.

Ce n'est pas un défaut de la méthode : c'est le prix de l'échantillonnage. À
4 Hz, une coupure ne tombe presque jamais sur la grille.

### Le blocage s'est déplacé

`survivantesDepart` reste à 0, mais plus pour la même raison. À 10 Hz, les
identités du départ 2 et 5 sont maintenant suivies de **3,0 s à 11,6 s** au
lieu de s'arrêter à 5,8 s : elles traversent le changement de caméra. Elles
meurent deux secondes avant le V1, parce que YOLOX cesse de les détecter —
l'une sort du cadre par la droite, l'autre reste extrapolée puis expire.

D'où `porteeDepart` : jusqu'où chaque identité du départ est suivie.
`survivantesDepart` est un tout-ou-rien à 13,5 s qui vaut 0 aussi bien quand
une identité meurt au cut que deux dixièmes avant l'arrivée. La portée sépare
les deux, et c'est elle qui montre le progrès quand le compte final ne bouge
pas encore.

### Les seuils ne sont pas figés

`margeMin` et `margeApparenceMin` sont des points de bascule d'un compromis,
pas des constantes. `balayer()` rejoue la décision sur toute la grille
(poids de taille × marge × marge d'apparence) et le rapport la publie.

⚠ Une première lecture de cette table, faite sur le MODULE et ses cinq boîtes
annotées, laissait croire qu'un `margeMin ≤ 0,10` donnerait 4 justes sur 4.
C'est faux sur le RUN, et la nuance compte : le module reçoit les cinq
voitures détectées aux deux images propres, le run ne lui donne que les pistes
CONFIRMÉES. Or la piste qui correspond à B4 n'est jamais confirmée dans la
fenêtre de décision — elle n'entre donc pas dans le groupe candidat, et aucun
réglage de marge ne peut l'apparier. Le plafond atteignable sur ce run est
3 justes sur 4, et la configuration retenue l'atteint.

Le facteur limitant à 10 Hz n'est donc pas la marge : c'est la confirmation
des pistes du plan neuf. Voir §10 pour ce que deux cuts de plus en disent.

---

## 10. Deux cuts de plus — ce que le second cas a tranché

L'extrait de 17 s contient **trois** transitions, pas une. Scan complet
(0,2 → 16,8 s, `derive+rampe/1`, pas 0,1 s), toutes fiables, 4 fenêtres
concordantes sur 4, dispersion 17 ms :

| rupture | bornes propres | images de transition |
|---|---|---|
| 2,800 s | 2,7333 → 2,8333 | 5 |
| 5,900 s | 5,800 → 5,900 | 5 |
| 14,300 s | 14,1667 → 14,250 | 4 |

Aucune rejetée. Ces deux transitions supplémentaires servent de second et
troisième cas, sans rien télécharger de plus.

### Le trou que le second cas a révélé

Au cut 14,3 s en 4 Hz, deux pistes d'un côté, deux de l'autre : une seule
affectation survit au contrôle de sens, donc aucune concurrente, donc aucune
marge à franchir. Une similitude d'**échelle 10,2** et de **coût 2,85** — un
résidu moyen de près de trois fois le rayon du groupe entier — était acceptée
sans le moindre examen, et la filiation posée.

Le filtre de marge est RELATIF : il compare deux hypothèses entre elles et ne
dit rien de leur qualité. Il fallait un plafond ABSOLU. `coutMax = 1` : au-delà
d'un rayon de dispersion, la prédiction ne vaut pas mieux que « quelque part
dans le peloton ». Ce n'est pas un compromis à régler comme `margeMin`, c'est
une échelle intrinsèque. Avec lui, ce cas devient un refus.

### Ce que les trois cuts disent des questions ouvertes

**Le modèle gagnant varie.** Directe au cut 5,9 s (−174°), réflexion au cut
14,3 s (−177°), et au cut 2,8 s réflexion en 10 Hz mais directe en 4 Hz —
là où la marge vaut 0,0 %, c'est-à-dire là où le modèle gagnant n'a aucun
sens. Supposer l'un ou l'autre aurait été faux ; il faut les essayer tous les
deux.

**Les marges sont très dispersées** : 44,8 % (14,3 s, 10 Hz), 8,9 % (5,9 s,
10 Hz), 1,5 % (5,9 s, 4 Hz), 0,1 % et 0,0 % (2,8 s). Un seuil unique se
comporte donc très différemment d'une transition à l'autre.

**Le poids de taille ne nuit jamais, et ne sert que parfois.** Sur les cuts
2,8 s et 14,3 s, la décision est identique de `poidsTaille = 0` à `2`. Il ne
joue que sur le cut 5,9 s, où il est décisif. Garder 1 ne coûte rien ailleurs.

**L'apparence n'a jamais tranché** : 3,3 %, 3,5 % et 3,8 % d'écart relatif,
tous sous le seuil de 5 %, et indisponible dans deux cas (une voiture tronquée
par le bord de l'image, donc jamais mémorisée). Elle reste strictement
secondaire, comme prévu.

**10 Hz reste nettement meilleur autour des cuts.** À 14,3 s, 10 Hz décide
avec 44,8 % de marge et 4 Hz refuse ; à 5,9 s, 10 Hz décide et 4 Hz refuse.
La raison est structurelle : une coupure ne tombe presque jamais sur une
grille à 4 Hz, et les cent millisecondes de décalage suffisent à déformer la
configuration et à tronquer une voiture au bord.

### `margeMin` : 0,15 se confirme, 0,10 est écarté

Le balayage croisé avec la vérité, sur les six runs :

| run | `margeMin` = 0,10 | `margeMin` = 0,15 |
|---|---|---|
| 5,9 s · 10 Hz | 3 justes, 0 fausse | **identique** |
| 5,9 s · 4 Hz | 0 juste, **1 FAUSSE** | 0 juste, 0 fausse (refus) |
| 2,8 s · 10 Hz | identique | identique |
| 2,8 s · 4 Hz | identique | identique |
| 14,3 s · 10 Hz | identique | identique |
| 14,3 s · 4 Hz | refus | refus |

Sur trois cuts réels et deux fréquences, descendre à 0,10 **n'ajoute aucun
appariement juste et introduit un appariement faux**. C'est exactement ce que
le second cas devait établir, et il conclut contre l'intuition qu'un seul cut
donnait. `margeMin` reste à 0,15.

### Le nouveau facteur limitant

Sur le cut 5,9 s en 10 Hz, la piste qui correspond à B4 reste `tentative` de
5,9 à 6,3 s : jamais confirmée, donc jamais candidate. Aucun réglage de la
réattribution ne peut la rattraper. Le facteur limitant s'est déplacé de la
marge vers la CONFIRMATION des pistes du plan neuf — même famille de problème
que les identités qui meurent vers 11,6 s faute de détection.

---

## 11. Deux gardes ajoutées, et leur sensibilité

### L'apparence n'intervient que si la géométrie est muette

Le cut 2,8 s l'a imposé. Les deux meilleures hypothèses y sont séparées de
**0,0001** : c'est un quasi-tirage au sort qui désigne la « meilleure », et le
tirage tombe sur la mauvaise en 10 Hz, sur la bonne en 4 Hz. L'apparence,
elle, désigne la bonne aux DEUX fréquences. Elle était bloquée par un seuil de
5 % que les écarts réels (3,3 %, 3,5 %, 3,8 %) ne franchissent jamais.

Deux changements, tous deux nécessaires : `margeApparenceMin` passe à 0,03, et
l'apparence n'est consultée que si la marge géométrique est sous
`seuilGeometrieMuette`. Le second est le plus important — sans lui, au cut
5,9 s où la géométrie a une vraie préférence (8,9 %), l'apparence renverserait
la décision et ajouterait une erreur.

### Le sens de marche n'est lu que s'il est cohérent

Avant le départ, les vitesses estimées pointent dans des sens opposés — +226,
+100, +27, −112, −244 px/s. On pourrait croire à du bruit ; c'en est le
contraire exact.

Ces vitesses sont **parfaitement ordonnées avec la position** (centres à
x = 671, 803, 939, 1079, 1210) et changent de signe exactement au centre de
l'image. C'est un flux convergent, signature d'une homothétie : zoom arrière
ou éloignement d'ensemble. Confirmation : sur ce plan, le rayon du groupe
passe de 313 à 192 px (÷1,63) pendant que le côté des boîtes passe de 160 à
92 px (÷1,74) — le même facteur.

Le signe de `vx` ne dit donc rien du sens de la course ici : il dit de quel
côté du centre optique se trouve la voiture. Le contrôle de sens écartait la
moitié des hypothèses là-dessus.

`coherence = |Σv| / Σ|v|` sépare franchement les deux régimes :

| situation | cohérence | nature du mouvement |
|---|---|---|
| grille de départ | **0,109 – 0,127** | homothétie (zoom / éloignement) |
| voitures lancées | **0,572 – 0,973** | translation |

La cohérence ne mesure donc pas « signal contre bruit » mais **la part de
translation** dans le mouvement du groupe. Ce que le mouvement raconte quand
elle est faible n'est pas perdu, seulement pas encore exploité : le facteur
d'échelle dit si la caméra s'éloigne ou se rapproche, donc si le peloton est
vu de dos ou de face.

Le contrôle ne s'exerce que si les deux groupes dépassent `coherenceSensMin`.
La cohérence est publiée dans chaque rapport, avec la mention explicite
« exploité » ou « ignoré ».

### Caméra arrière puis caméra avant

Au cut 2,8 s, la réalisation passe de derrière la grille à devant elle.
**L'ordre gauche-droite s'inverse alors nécessairement** — c'est une propriété
du point de vue, pas un hasard de cadrage. La vérité annotée le confirme :
A1→B5, A2→B4, A3→B3, A4→B2, A5→B1.

Rien dans la méthode ne traite l'ordre en x comme un invariant, et c'est
délibéré : une réflexion comme une rotation d'un demi-tour l'expliquent, les
deux concourent, et le sens de marche — quand il est lisible — départage.
Cinq tests figent ce cas avec les boîtes et la vérité réelles.

### Résultats après les deux gardes

| cut | fréq. | décision | justes | fausses | non décidées | marge | sens |
|---|---|---|---|---|---|---|---|
| 2,8 s | 10 Hz | **apparence** | **5** | 0 | 0 | 0,2 % | ignoré |
| 2,8 s | 4 Hz | consensus | 1 | 0 | 4 | 2,1 % | ignoré |
| 5,9 s | 10 Hz | consensus | 3 | 0 | 1 | 8,9 % | exploité |
| 5,9 s | 4 Hz | refus | 0 | 0 | 4 | 1,5 % | exploité |
| 14,3 s | 10 Hz | marge | *non vérifiable* | | | 44,8 % | exploité |
| 14,3 s | 4 Hz | refus | — | | | — | exploité |

**9 justes, 0 fausse**, contre 5 justes, 0 fausse avant. Toujours aucune erreur
d'identité.

### Sensibilité des deux nouveaux seuils

Total sur les quatre runs vérifiables, à `poidsTaille = 1` et
`margeMin = 0,15` :

| | `muette` = 0,01 | 0,02 | 0,05 |
|---|---|---|---|
| `coherenceSensMin` = 0,4 | 9J 0F 9ND | 9J 0F 9ND | 13J 0F 5ND |
| 0,5 | 9J 0F 9ND | 9J 0F 9ND | 13J 0F 5ND |
| 0,6 | 9J 0F 9ND | 9J 0F 9ND | 13J 0F 5ND |

**`coherenceSensMin` n'a aucun effet entre 0,4 et 0,6.** Les résultats sont
strictement identiques, y compris sur le cas limite du cut 5,9 s en 4 Hz dont
la cohérence vaut 0,572. Le seuil n'est donc pas ajusté sur ces données : la
séparation mesurée est trop franche pour que sa valeur exacte compte.

**`seuilGeometrieMuette` en a un**, entre 0,02 et 0,05 : quatre justes de plus,
aucune fausse. Le seul cas qui bascule est le cut 2,8 s en 4 Hz, dont la marge
vaut 2,1 % — à peine au-dessus du seuil livré.

C'est un argument pour 0,05 qui ne tient pas à la performance mais à la
ROBUSTESSE : les marges observées se répartissent en deux paquets, l'indécis
(0,2 % et 2,1 %) et le décidé (8,9 % et 44,8 %). Un seuil à 0,05 tombe au
milieu de l'intervalle vide entre les deux ; 0,02 est collé contre la plus
haute valeur du paquet indécis. La valeur livrée reste 0,02 — celle choisie
avant de voir ces chiffres — précisément pour que le lecteur puisse juger du
changement plutôt que de le trouver déjà fait.
