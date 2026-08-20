# Module « Projection de qualification » — analyse préalable

> Document d'analyse demandé **avant** implémentation.
> Aucun code applicatif n'a été modifié à ce stade.
> Les chiffres ci-dessous ne sont pas des estimations : ils proviennent d'une
> extraction réelle de la base Firestore de production, rejouable via
> `tools/qualification-audit/` (voir §9).

---

## 0. Méthode de l'audit

Les règles Firestore (`firestore.rules`) autorisent la lecture publique sur
`meetings`, `sessions`, `results`, `sessionParticipants`, `championships`.
L'audit a donc porté sur les **vraies données**, pas sur le schéma supposé :

| Collection            | Documents extraits |
|-----------------------|--------------------|
| `meetings`            | 12                 |
| `championships`       | 2                  |
| `sessions`            | 534                |
| `results`             | 4 075              |
| `sessionParticipants` | 5 680              |

La reconstruction des classements a été faite en important **le code réel de
`js/calc.js`** (`mqPoints`, `calcStatusPoints`, `ecBonusPoints`,
`compareInterimTiebreaker`) et en rejouant à l'identique la logique de
`calcMqStandings()` et `calcInterimStandings()`. Ce n'est donc pas une
ré-implémentation approximative : ce qui est mesuré ici est exactement ce que
l'application calculerait.

---

## 1. Réponse directe : peut-on reconstruire les classements après Q1, Q2, Q3 ?

**Q2, Q3, Q4 : oui, proprement. Q1 : non, en l'état — et c'est un bloqueur de code, pas un problème de données.**

| Checkpoint | Lignes pilote reconstruites | Verdict |
|------------|-----------------------------|---------|
| après Q1   | **0** sur 685               | ❌ bloqué |
| après Q2   | 668 sur 685                 | ⚠️ 17 lignes perdues |
| après Q3   | 685                         | ✅ |
| après Q4   | 685                         | ✅ |

### Cause : `calcInterimStandings()` exige 2 manches classées

`js/calc.js` filtre les pilotes ainsi :

```js
// Règle : au moins 2 MQ classées
const eligible = Object.values(driverMap).filter(d => d.mqCount >= 2);
```

Conséquence mesurée : sur les **40** groupes meeting × catégorie complets,
**40/40** produisent un classement **vide** au checkpoint Q1. Le seuil est
codé en dur, il ne vient pas du règlement.

Les 17 lignes manquantes au checkpoint Q2 relèvent de la même règle : un
pilote DNS/DSQ sur l'une des deux premières manches n'atteint pas `mqCount >= 2`.
Il réapparaît au checkpoint Q3.

**Correctif nécessaire (petit et non destructeur)** : paramétrer ce seuil,
`calcInterimStandings(db, sessions, regulation, { minClassifiedRaces })`, avec
la valeur par défaut `2` conservée pour tous les appelants actuels
(`standings.js`, `championship.js`, `stats.js`). La projection appelle avec
`minClassifiedRaces: 1`. Aucune valeur affichée aujourd'hui ne change.

À noter : cette règle est de toute façon **une règle d'attribution des points
intermédiaires**, pas une règle de classement. L'appliquer à un checkpoint
intermédiaire est un abus de sens ; la rendre configurable corrige aussi cette
confusion.

### Le reste est reconstructible sans rien ajouter

Tout le nécessaire existe déjà :

* `sessions` porte `type: 'MQ'` et `num: 1..4` → l'ordre des manches est explicite ;
* `results` a un id déterministe `${sessionId}_${driverId}`, donc **pas de doublons** ;
* `results` porte `ms`, `status` (`DNF`/`DNS`/`DSQ`/`DSQ_RACE`), `manualPosition`,
  `serie`, `couloir`, `meetingId`, `category`, `year`, `sessionType` ;
* `sessionParticipants` donne le nombre d'engagés par session, indispensable au
  calcul des points DNF (`mode: 'engaged_offset'`) ;
* couverture parfaite sur les meetings courus : **P = R** (autant de documents
  `results` que de participants) sur les 40 groupes complets, **0 document vide**.

La position en manche n'est pas stockée — elle est recalculée par tri sur `ms`
au sein de la session. C'est cohérent et suffisant, mais cela crée une
dépendance dure : sans `sessionParticipants`, pas de classement. Cette
dépendance est satisfaite partout dans les données actuelles.

---

## 2. Volume réel de l'historique — le vrai facteur limitant

C'est ici que se situe le risque du projet, pas dans le Monte-Carlo.

| Métrique | Valeur |
|---|---|
| Saisons | **1** (2026 uniquement) |
| Meetings avec Q1→Q4 complets | **8** (4 FFSA + 4 Euro RX) |
| Groupes meeting × catégorie complets | **40** |
| Cas pilote (lignes après Q4) | **685** |
| Cas **exploitables** (engagés > seuil de qualification) | **589** |
| dont qualifiés | 458 (77,8 %) |
| Meetings à venir, sans aucun résultat | 4 (Loheac, Mayenne, Dreux, France-Loheac) |

Meetings exploitables : Lessay, Faleyras, Tours, Kerlabo (FFSA) ;
Bikernieki, Nyirad, Höljes, Mondello Park (Euro RX).

Trois conséquences directes :

1. **Le filtre « toutes saisons » vs « saison actuelle » n'a aucun effet
   aujourd'hui.** Il faut le prévoir dans le modèle mais annoncer clairement
   « 1 saison disponible ».
2. **Le filtre « circuit uniquement » donne au mieux n = 1 meeting.** Il doit
   exister, mais il tombera systématiquement en confiance « faible ».
3. **La granularité fine (championnat × catégorie × tranche de points) est déjà
   au bord du décrochage** : voir §4.

Les 4 meetings futurs ont leurs `sessionParticipants` déjà chargés mais
**zéro** `results`. Le sélecteur d'historique doit filtrer sur la présence de
résultats, pas sur l'existence des sessions — sinon ils entrent dans les stats
comme 100 % de DNS.

---

## 3. Données présentes / manquantes

### 3.1 Présent et directement utilisable

| Donnée demandée | Source | État |
|---|---|---|
| saison | `meetings.year` | ✅ |
| championnat | `meetings.championshipId` → `championships` | ✅ |
| meeting | `meetings.id` / `date` | ✅ |
| circuit | `meetings.location` | ⚠️ texte libre (§4.6) |
| catégorie | `sessions.category` / `results.category` | ✅ |
| points après Q1/Q2/Q3 | recalcul `calcInterimStandings` borné à `num <= N` | ✅ (sauf Q1, §1) |
| classement après QN | idem, tri + `compareInterimTiebreaker` | ✅ |
| résultat Q4 (place ou statut) | `results.ms` / `results.status` | ✅ |
| points marqués en Q4 | `mqPoints()` / `calcStatusPoints()` | ✅ |
| points totaux après Q4 | idem | ✅ |
| classement final des qualifications | idem | ✅ |
| barèmes, statuts, départages | `championships.pointsScale`, `statusRules`, `interimTiebreaker` | ✅ |
| bonus essais chronométrés | session `EC` + `ecBonusPoints()` | ✅ FFSA / absent Euro RX (normal) |
| séries et couloirs de départ | `results.serie`, `results.couloir` | ✅ (utile plus tard pour le modèle de performance) |

### 3.2 Manquant — à dériver, pas à saisir

| Donnée manquante | Solution |
|---|---|
| **Flag « qualifié »** | Aucun document ne le stocke. À dériver : `rang après Q4 <= seuil`. Fiabilité mesurée : §4.2. |
| **Seuil de qualification effectif** | Non stocké. À dériver du règlement **et** du déroulé réel : §4.3. |
| **Nombre de manches prévues** | `meetings.nbMQ` existe (= 4 partout). Fiable. |
| **Identité de circuit stable** | Absente : §4.6. |
| **Historique multi-saisons** | N'existera qu'avec le temps. Rien à coder de plus. |

### 3.3 Aucune nouvelle collection n'est nécessaire pour les lots 1 à 5

Tout se recalcule. Une collection de **cache** (`qualificationHistoryCache`,
ou des résultats de backtest) pourra être ajoutée plus tard **uniquement**
pour la performance, jamais comme source de vérité. C'est aussi la doctrine
déjà appliquée dans le dépôt : `championship.js` a explicitement abandonné
`meetingStandings` au profit du recalcul direct. Ne pas revenir en arrière.

---

## 4. Problèmes réels du modèle de données

### 4.1 — BLOQUEUR — `mqCount >= 2` codé en dur
Voir §1. Sans correctif, le checkpoint Q1 (LOT 5) est impossible et le
checkpoint Q2 perd 2,5 % de ses lignes.

### 4.2 — Le label « qualifié » est dérivé, pas observé
Comparaison entre *règle* (`rang <= seuil`) et *réalité* (présence effective
dans la phase suivante) :

```
concordance : 546 / 555 places  (98,4 %)
écarts      : 9 pilotes, sur 5 groupes / 40
```

Les 5 écarts sont des échanges 1-pour-1 (Tours D4, Faleyras Super1600/D3/D4) :
signature typique d'un **forfait remplacé par un suppléant**. Ce n'est pas une
erreur de données, c'est une information différente.

**Conséquence d'architecture** : le module doit produire **deux labels
distincts** et ne jamais les confondre :

* `qualifiedByRule` — ce que le modèle prédit, et donc ce contre quoi on
  calibre le backtest ;
* `qualifiedActual` — ce qui s'est réellement passé, affiché en diagnostic et
  utilisé pour signaler les cas de forfait/repêchage.

Prédire `qualifiedActual` serait prédire un forfait, ce que le modèle ne sait
pas faire — et le taux d'erreur irréductible qui en découlerait (~1,6 %)
polluerait la calibration.

### 4.3 — Le seuil de qualification varie et ne se lit pas seulement dans le règlement
Le règlement donne une intention (`DF.count × DF.gridSize`, ou
`QF.count × QF.gridSize` si QF activé). Le déroulé réel peut diverger :

* Euro RX **RX1** : 24 participants en QF → seuil 24 ;
* Euro RX **RX3 / RX5** : 0 participant en QF, 12 en DF → passage MQ→DF direct, seuil 12 ;
* Euro RX **RX4** (Nyirád, Mondello) : ni QF ni DF, 6 en finale → seuil 6 ;
* FFSA petites catégories : 7 à 11 participants en DF au lieu de 16.

Ce n'est pas une anomalie : `sessions.js` propose explicitement le mode
« MQ → DF direct » quand les QF sont vides. Le module doit donc résoudre le
seuil dans cet ordre : **phase suivante réellement peuplée → règlement →
nombre d'engagés**, et exposer la source retenue dans le panneau « Pourquoi ? ».

### 4.4 — Les points absolus ne sont pas comparables entre catégories
C'est le point de modélisation le plus important, et il est vérifiable sur les
données. Taux de qualification par tranche de points après Q3, **toutes
catégories confondues** :

```
 55-59 pts   n= 11   9,1 %
 60-64 pts   n= 12  41,7 %
 65-69 pts   n= 12  33,3 %     ← non monotone
 70-74 pts   n= 25  44,0 %
 75-79 pts   n= 26  23,1 %     ← non monotone
 80-84 pts   n= 37  40,5 %
 85-89 pts   n= 40  70,0 %
 90-94 pts   n= 60  76,7 %
 95-99 pts   n= 51  92,2 %
100-104 pts  n= 59  98,3 %
```

Les décrochages à 65-69 et 75-79 ne sont pas du bruit d'échantillonnage : ils
viennent du mélange de catégories à 7 engagés (seuil 16, tout le monde passe)
et à 31 engagés (seuil 16, la moitié sort). Le barème `44 - position` produit
en plus des points d'autant plus élevés que le plateau est grand.

Le même calcul, normalisé en **écart de rang au seuil après Q3** :

```
 -5 places  n= 29  100,0 %
 -4 places  n= 29  100,0 %
 -3 places  n= 29   93,1 %
 -2 places  n= 29   93,1 %
 -1 place   n= 29   82,8 %
  0 place   n= 29   69,0 %   ← pile sur la bulle
 +1 place   n= 29   44,8 %
 +2 places  n= 25   16,0 %
 +3 places  n= 24    0,0 %
```

Monotone, lisible, et directement interprétable par un team.

**Conséquence** : la courbe « points après Q3 » que tu décris reste faisable et
sera affichée — mais **elle n'est valable qu'à championnat + catégorie fixés**,
et l'indicateur robuste, celui qui doit piloter le modèle et la classification
VERT/ORANGE/ROUGE, est l'**écart au seuil** (en rang et en points). Les deux
axes seront proposés, avec l'axe normalisé par défaut.

Restreint à Super1600 seul (seuil constant 16), la courbe en points redevient
monotone — mais avec n = 12 par tranche de 10 points :

```
 70-79 pts  n=10  20,0 %
 80-89 pts  n=12  66,7 %
 90-99 pts  n=14  85,7 %
100-109 pts n=16 100,0 %
```

L'exemple que tu donnais (« 115-119 pts → 42 cas ») n'est donc pas atteignable
par catégorie aujourd'hui : le maximum observé est 16 cas par tranche.
Les tranches devront être **adaptatives** (largeur variable pour atteindre un
effectif cible) plutôt que fixes à 5 points.

### 4.5 — Cas triviaux : 96 sur 685
Quand le nombre d'engagés est inférieur ou égal au seuil, tout le monde est
qualifié mécaniquement (Division 5 à 7 engagés pour 16 places, par exemple).
Ces cas gonflent artificiellement tous les taux. Ils doivent être **exclus par
défaut** de l'historique et de la calibration, tout en restant affichables, et
le moteur doit court-circuiter la simulation en renvoyant 100 % avec la mention
« qualification mécanique : 7 engagés pour 16 places ».

### 4.6 — `meetings.location` est du texte libre
« Loheac » (FFSA) et « France - Loheac » (Euro RX) désignent le même circuit et
ne se regroupent pas. Il existe déjà une collection `circuits` (utilisée par
l'analyse des départs) et `startAnalysis.js` fabrique son `circuitLabel` à
partir de `meeting.location`. Pour le filtre « circuit », la seule option
raisonnable à court terme est une **normalisation de libellé** partagée, sans
migration de données. À reprendre plus tard si un vrai `circuitId` est ajouté
aux meetings.

### 4.7 — `worstResultDrop` est déclaré mais non implémenté
Le champ existe dans le règlement (valeur `0` sur les deux championnats) et est
persisté, mais `calcInterimStandings()` somme toutes les manches sans jamais
retirer la plus mauvaise. Tant que la valeur est `0` c'est sans effet. Si elle
passe à `1` un jour, l'historique et la simulation divergeraient silencieusement
du classement affiché. Le module de projection doit **lire** ce champ et
**refuser de projeter** (message explicite) tant que le cas n'est pas traité,
plutôt que de produire un chiffre faux.

### 4.8 — Le départage a besoin de chronos, pas seulement de positions
`compareInterimTiebreaker` utilise `mqPos` **et** `mqMs`. Une simulation qui ne
tirerait que des positions ne saurait pas départager deux pilotes à égalité de
points et de positions. Le simulateur doit donc produire, pour chaque manche
simulée, **une position et un chrono plausible cohérent avec elle** — sinon la
règle `last_manche_time` (FFSA) et le fallback FIA sont inapplicables.

### 4.9 — Points d'attention mineurs
* `results.status` est limité à `DNS | DNF | DSQ | DSQ_RACE` par les règles
  Firestore. Le « What if » couvre donc DNF / DNS / DSQ / DSQ_RACE ; il n'existe
  pas de notion de **pénalité en temps ou en places** au niveau manche. La
  demande « pénalité si le modèle de données le permet » : il ne le permet pas
  aujourd'hui pour les manches. Les pénalités existantes (`championshipPenalties`)
  sont au niveau saison et hors sujet ici.
* `calcMqStandings` place les DNF en `position = engagés + 1` et les DSQ_RACE en
  `engagés + 3`, **tous à la même position** (pas de départage entre eux). La
  simulation doit reproduire exactement ce comportement, pas l'améliorer, sinon
  historique et projection ne seront pas comparables.
* Un DNS/DSQ donne `position: null` : ces pilotes disparaissent du classement
  d'une manche mais restent dans `driverMap`. À gérer explicitement.

---

## 5. Fichiers existants réutilisables

### À réutiliser tel quel — aucune duplication de logique

| Fichier | Ce qu'on reprend |
|---|---|
| `js/calc.js` | `mqPoints`, `qfPoints`, `dfPoints`, `finPoints`, `calcStatusPoints`, `calcPointsFromScale`, `ecBonusPoints`, `interimPoints`, `compareInterimTiebreaker`, `computeSeriesSizes` |
| `js/settings.js` | `getChampionshipConfig(champId)` — chargement du règlement |
| `js/context.js` | `getActiveChampionship`, `getActiveChampionshipId`, `getAllChampionships` |
| `js/competition.js` | `distributeIntoQF`, `getReserves` — répartition et suppléants |
| `js/utils.js` | `escHtml`, `msToDisplay` |

### À modifier — une seule modification, minimale et rétrocompatible

| Fichier | Modification |
|---|---|
| `js/calc.js` | `calcInterimStandings(db, sessions, regulation, opts)` : `opts.minClassifiedRaces` (défaut `2`, comportement actuel inchangé) et extraction de la partie pure du calcul dans une fonction sans Firestore, réutilisable par la simulation. |

### À prendre comme modèle d'architecture

Le couple `startStatsCalc.js` (pur, testé, 563 lignes de tests) /
`startStats.js` (UI, chargement Firestore) est exactement le patron demandé.
Il est repris tel quel. À noter aussi les conventions maison qu'il respecte et
qu'il faudra respecter :

* requêtes Firestore sur **un seul champ**, filtrage du reste côté client
  (pas d'index composite) ;
* tout nouveau module `js/` doit être déclaré dans `ASSET_PATHS` de `sw.js` —
  `tests/moduleGraph.test.js` échoue sinon ;
* les modules purs sont listés dans `moduleGraph.test.js` et il est vérifié
  qu'ils **n'importent ni Firebase ni `app.js`/`context.js`/`auth.js`** et ne
  touchent **ni `document` ni `window`**. Les nouveaux modules de calcul
  devront être ajoutés à cette liste.

---

## 6. Où intégrer le module

`stats.js` est orienté **pilote × meeting** sur une saison ; `startStats.js`
est orienté **position de départ**, transversal. Le nouveau module est orienté
**scénario de qualification**, encore autre chose. Le mélanger à `stats.js`
ferait grossir un fichier déjà à 722 lignes sans bénéfice, exactement le motif
qui avait justifié la séparation de `startStats.js`.

→ **Nouvelle vue dédiée `view-projection`**, à côté de « Statistiques » et
« Stats des départs » :

* `index.html` : entrée de menu `data-view="projection"` (📐 Projection de qualification)
  + `<div class="view" id="view-projection">` ;
* `js/app.js` : `VIEW_TITLES` + `safeInit(initProjection, 'projection')` ;
* `sw.js` : nouveaux modules et `css/modules/projection.css` dans `ASSET_PATHS` ;
* deux entrées croisées, sans duplication de code : un lien depuis
  « Statistiques » et un bouton « Projeter » depuis l'onglet *Intermédiaire*
  de « Classements », qui ouvre la vue pré-remplie avec le meeting, la
  catégorie et la dernière manche courue.

Séparation visuelle imposée dans toute la vue, comme demandé : un bandeau
**DONNÉES HISTORIQUES** (fond neutre, « observé sur N cas ») et un bandeau
**SIMULATION** (fond distinct, « projection statistique, N tirages »), jamais
mélangés dans le même tableau, jamais additionnés.

---

## 7. Architecture proposée — générique dès le départ

Le cœur ne connaît ni « Q3 » ni « Q4 » : il connaît une **liste ordonnée de
manches**, un **index de dernière manche terminée**, et en déduit les manches
restantes. Après la dernière manche, la liste des manches à simuler est vide et
le moteur renvoie un résultat déterministe — même code, même API, aucun cas
particulier.

### Modules purs (testables, sans Firestore ni DOM)

| Module | Responsabilité |
|---|---|
| `js/projection/projectionConfig.js` | Toutes les constantes centralisées : seuils VERT/ORANGE/ROUGE, seuil de rendement décroissant (défaut : gain < 1 pt de % par place), effectifs minimaux de confiance faible/moyenne/élevée, nombre de tirages par profil (10 000 / 50 000 / 100 000), poids des sources de performance. **Zéro constante ailleurs.** |
| `js/projection/qualificationRules.js` | Résolution du seuil (§4.3), calcul de `qualifiedByRule` / `qualifiedActual`, détection des cas triviaux (§4.5), garde `worstResultDrop` (§4.7). |
| `js/projection/qualificationState.js` | Reconstruction pure de l'état à un checkpoint : `buildStateAfterRace(sessions, results, participants, regulation, raceIndex)` → points, rang, `mqPos`, `mqMs` par pilote. Le seul endroit qui sait recomposer un classement. |
| `js/projection/qualificationHistory.js` | Agrégations historiques pour **tous** les checkpoints (après Q1/Q2/Q3), par tranche de points **et** par écart au seuil, tranches adaptatives (§4.4), distribution des résultats de la manche suivante, taux conditionnel au résultat obtenu, indicateur de confiance. |
| `js/projection/driverPerformanceModel.js` | Construit la distribution de résultat d'un pilote à partir des sources hiérarchisées (meeting courant → saison → circuit → général). Les poids viennent de `projectionConfig`, sont **exposés dans la sortie**, et sont remplaçables par un jeu calibré : `buildModel(sources, weights)`. |
| `js/projection/monteCarloEngine.js` | Tirage seul, RNG **à graine explicite** (déterminisme reproductible, exigé par les tests et par le « Pourquoi ? »). Produit position **et** chrono cohérent (§4.8). |
| `js/projection/scenarioSimulator.js` | Boucle séquentielle manche par manche : simule la manche N+1 pour tous les pilotes, applique le barème réel via `calc.js`, recalcule le classement, passe à la manche suivante, applique les départages, produit le classement final et le verdict. Accepte des **résultats forcés** (`forced[raceNum][driverId]`). Aucune indépendance supposée entre manches : l'état est repris de l'étape précédente. |
| `js/projection/strategyTargetCalculator.js` | Target dynamique (TARGET Q2 / Q3 / Q4 selon le checkpoint), détection du rendement décroissant, classification VERT/ORANGE/ROUGE, matrice de scénarios croisés à N dimensions (donc Q3 × Q4 comme cas particulier d'une grille générique). |
| `js/projection/qualificationBacktest.js` | Backtest multi-checkpoints : masque les manches ≥ N+1, projette, révèle, compare. Calibration par tranche de probabilité, Brier score, accuracy à seuil configurable, effectifs. Comparaison APRÈS Q1 / Q2 / Q3 côte à côte. |

### Modules non purs

| Module | Responsabilité |
|---|---|
| `js/projection/qualificationData.js` | Chargement Firestore (une seule requête par champ, filtrage client), mise en forme des entrées des modules purs, cache mémoire. |
| `js/projectionStats.js` | Vue : filtres, courbes, matrice, panneaux « Pourquoi ? », séparation visuelle historique / simulation. |

### API du moteur

```js
projectQualification({
  regulation,          // règlement du championnat (barèmes, statuts, départages, seuils)
  meetingState,        // état reconstruit : pilotes, points, mqPos, mqMs, engagés
  races,               // [{ num: 1, done: true }, … ] — le moteur en déduit ce qui reste
  lastCompletedRace,   // 1 | 2 | 3 | 4
  focusDriverId,       // pilote analysé (optionnel)
  forced,              // { 3: { driverX: { position: 8 } }, 4: { driverX: 'DNF' } }
  simulations,         // 10000 par défaut
  seed,                // déterminisme
})
// → { probability, rankDistribution, pointsStats, thresholdDistribution,
//     confidence, explain: { … }, historical: { … } }
```

`lastCompletedRace === 4` → `races` restantes vides → résultat purement factuel,
`simulations: 0`, aucun encart SIMULATION affiché. Même moteur, même API.

### Contraintes de rédaction imposées au module

Le module ne produit **jamais** d'énoncé d'intention ou d'injonction. Les seules
formulations autorisées sont descriptives et centralisées dans
`projectionConfig` :

* ✅ « Les pilotes dans cette situation se qualifiaient généralement même avec
  un résultat moyen en Q4 (31 cas sur 42). »
* ✅ « Au-delà de P8, le gain estimé de probabilité de qualification devient faible. »
* ❌ « Le pilote doit lever le pied. » / « Il a levé le pied. »

Ces libellés seront centralisés et couverts par un test qui vérifie l'absence
des formulations interdites dans les sorties du module.

---

## 8. Plan d'implémentation par lots

Ordre volontairement conforme à ta consigne : **l'historique et sa vérification
d'abord**, la simulation ensuite, pour pouvoir mesurer si le Monte-Carlo
apporte réellement quelque chose plutôt que de la complexité.

| Lot | Contenu | Vérifiable par |
|---|---|---|
| **LOT 0** *(préalable technique, petit)* | `minClassifiedRaces` dans `calc.js` (rétrocompatible) ; `qualificationRules.js` ; `qualificationState.js` ; `qualificationData.js` ; écran « Qualité des données » reprenant l'audit du §2 dans l'app. | Tests unitaires + non-régression des vues existantes |
| **LOT 1** | `qualificationHistory.js` + vue historique : courbes après Q1/Q2/Q3 → qualification après Q4, en points **et** en écart au seuil, filtres championnat/catégorie/saison/circuit, effectifs affichés partout, indicateur de confiance, panneau « Pourquoi ? » côté historique. | Tests + lecture directe des chiffres du §4.4 |
| **LOT 2** | `monteCarloEngine.js` + `driverPerformanceModel.js` + `scenarioSimulator.js` ; projection après Q3 ; « What if Q4 » (P1…Pn, DNF, DNS, DSQ) ; TARGET Q4 ; classification. | Tests + **comparaison directe à la courbe du LOT 1** |
| **LOT 3** | Checkpoint après Q2 : simulation séquentielle Q3 puis Q4, « What if Q3 », TARGET Q3. Aucune ligne de moteur nouvelle attendue — seulement `lastCompletedRace = 2`. | Tests |
| **LOT 4** | Matrice de scénarios croisés Q3 × Q4 (grille générique N×M), les autres pilotes restant simulés dans chaque case. | Tests |
| **LOT 5** | Checkpoint après Q1 (dépend du LOT 0). | Tests |
| **LOT 6** | `qualificationBacktest.js` complet : calibration et Brier par checkpoint Q1/Q2/Q3, accuracy à seuil configurable, effectifs, vue de comparaison. | Backtest sur les 589 cas exploitables |

**Point de décision explicite à la fin du LOT 2** : si le Monte-Carlo n'améliore
pas le Brier score par rapport à la simple table historique du LOT 1, on le dit
et on garde l'historique comme estimateur principal. Le LOT 1 doit donc être
autonome et utilisable seul.

### Tests unitaires prévus (conformes à ta liste)

`tests/qualificationRules.test.js`, `tests/qualificationState.test.js`,
`tests/qualificationHistory.test.js`, `tests/scenarioSimulator.test.js`,
`tests/strategyTargetCalculator.test.js`, `tests/qualificationBacktest.test.js` :

* calcul des points après Q1 / Q2 / Q3 (y compris DNF, DNS, DSQ, DSQ_RACE) ;
* qualification après Q4 selon les deux règlements présents (FFSA seuil 16,
  Euro RX seuils 24 / 12 / 6) ;
* règles de départage (`last_manche_time` et `best_positions_then_time`),
  y compris le fallback chrono ;
* simulation avec position forcée : le pilote ciblé obtient exactement la
  position imposée, les autres restent tirés ;
* déterminisme : deux exécutions à graine identique donnent le même résultat ;
* calcul de probabilité et convergence (10 000 vs 100 000 tirages) ;
* résultat cible et seuil de rendement décroissant ;
* petits échantillons : n < seuil → confiance « faible » et message explicite ;
* cas trivial (engagés ≤ seuil) → 100 % sans simulation ;
* backtesting : calibration, Brier, accuracy ;
* absence des formulations interdites dans les sorties.

---

## 9. Rejouer l'audit

```bash
node tools/qualification-audit/fetch.mjs \
     meetings championships sessions results sessionParticipants
node tools/qualification-audit/01-completude.mjs      # matrice meeting × catégorie
node tools/qualification-audit/02-reconstruction.mjs  # états après Q1..Q4
node tools/qualification-audit/03-courbes.mjs         # courbes et effectifs
node tools/qualification-audit/04-verite-terrain.mjs  # règle vs réalité observée
```

Lecture seule. La configuration du projet est lue dans `js/firebase.js`,
les extractions sont écrites dans `tools/qualification-audit/data/`
(non versionné).

---

## 10. Synthèse

**Ce qui marche déjà** : Q2, Q3 et Q4 sont reconstructibles proprement avec le
code existant, sur 8 meetings et 589 cas exploitables. La règle de
qualification dérivée est correcte à 98,4 %. Aucune nouvelle collection n'est
nécessaire.

**Le seul vrai bloqueur** : `mqCount >= 2` dans `calc.js`, qui rend le
checkpoint Q1 impossible. Correctif petit et rétrocompatible.

**Le vrai risque, et il n'est pas dans le Monte-Carlo** : le volume. Une seule
saison, et surtout des points absolus non comparables entre catégories — ce qui
rend la courbe « points après Q3 » non monotone tant qu'on ne la restreint pas à
une catégorie, où il ne reste alors que ~12 cas par tranche. D'où deux décisions
prises dès la conception : **tranches adaptatives** et **axe normalisé par
l'écart au seuil**, l'axe en points absolus restant disponible mais secondaire.
