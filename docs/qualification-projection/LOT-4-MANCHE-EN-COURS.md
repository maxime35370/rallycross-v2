# LOT 4 — Projection pendant une manche EN COURS

Mode hybride **réel + simulé** : les résultats déjà enregistrés sont repris tels
quels, seuls les pilotes non encore passés sont tirés.

---

## 1. Le défaut corrigé en priorité

Avant ce lot, `hasResults` (« au moins un résultat existe ») servait de test de
« manche terminée ». Une manche partiellement courue était donc traitée comme
finie, avec quatre conséquences, toutes **silencieuses** :

| Conséquence | Effet observé |
|---|---|
| Classement intermédiaire faux | totaux mélangeant 3 et 4 manches selon les pilotes |
| Historique pollué | le meeting en cours entrait dans la base du LOT 1 avec une manche incomplète |
| Baseline déplacée | les taux historiques servant à TOUS les meetings changeaient |
| Projection contredite | un pilote réellement P2 se voyait attribuer P3 par la simulation |

### Ce qui a changé

`buildMeetingContext()` distingue désormais trois états par manche :

```js
hasResults:   ranIds.size > 0,                  // au moins un pilote a couru
isComplete:   engagés > 0 && aucun en attente,  // TERMINÉE
isInProgress: ranIds.size > 0 && des pilotes restent,
```

Un pilote a couru **si et seulement si** son résultat porte un chrono ou un
statut. Critère vérifié sur les données de production : sur 2 755 résultats de
manche, **aucun** n'est dépourvu des deux.

`buildStateAfterRace()` et `buildAllStates()` filtrent sur `isComplete`.
`ctx.isComplete` exige que **toutes** les manches soient intégralement courues,
donc `buildObservations({ requireComplete: true })` écarte le meeting en cours.

### Vérification sur données réelles

```
groupes « complets » — ancienne définition : 40 · nouvelle définition : 40
✅ aucun groupe ne sort de l'historique : la base du LOT 1 est inchangée.
```

Le garde-fou n'écarte donc rien de ce qui était légitimement dans l'historique.

### Tests — `tests/raceInProgress.test.js` (19)

Meeting Q1–Q3 terminées, Q4 partiellement courue :

- la manche est `isInProgress`, pas `isComplete` ;
- `ctx.lastCompletedRace === 3`, `ctx.raceInProgress === 4` ;
- `buildObservations()` produit **0** observation ;
- la baseline historique est `toEqual`-identique avec et sans ce meeting ;
- `buildStateAfterRace(ctx, 4)` renvoie exactement l'état après Q3 ;
- tous les pilotes classés au checkpoint ont le même `mqCount` ;
- une fois la manche terminée, le meeting entre normalement dans l'historique ;
- identique pour Q1, Q2, Q3, Q4 en cours.

**Preuve que les tests mordent** : en rétablissant l'ancienne définition
(`isComplete: ranIds.size > 0`), **13 des 19 tests échouent**.

---

## 2. Mode hybride réel + simulé

### Principe

Le classement d'une manche est produit par `buildMqStandings`, qui **classe au
chrono**. Il suffit donc de conserver les chronos réels et de fabriquer des
chronos plausibles pour les pilotes restants : l'ordre relatif des résultats
acquis est alors mathématiquement invariant, sans aucune vérification à
exécuter.

`simulateRaceRows()` applique trois règles, dans cet ordre :

1. **Donnée acquise** — reprise telle quelle, jamais tirée, jamais forcée.
2. **Résultat imposé** par un scénario « et si ».
3. **Tirage** pour les pilotes encore à courir.

### Chronos ancrés

Les chronos réels sont des **ancres**. Les chronos simulés sont répartis dans
les intervalles laissés libres entre deux ancres (`assignChronos()`), ce qui
garantit :

- conservation exacte des chronos réels ;
- stricte croissance avec la position — aucun classement impossible ;
- aucun doublon de chrono.

**Sans aucune ancre**, la formule retombe littéralement sur celle d'avant le mode
hybride. Vérifié par comparaison directe avec la version précédente du module :

```
projections comparées : 75 · différentes : 0
manches simulées comparées (classement + chronos) : 15 000 · différentes : 0
```

Une manche entièrement simulée est donc **rigoureusement inchangée**, chronos
compris — pas seulement « statistiquement équivalente ».

### Régimes de lecture du réel

| `liveResults` | Qui l'utilise | Ce qui est lu |
|---|---|---|
| `'inProgress'` (défaut) | simulation en direct | uniquement une manche commencée et non terminée |
| `'live'` | bloc CERTITUDES | toute manche ayant des résultats |
| `'none'` | **backtest** | rien — simulation pure |

Le backtest passe explicitement `'none'` : sur un meeting terminé, lire le
moindre résultat postérieur au checkpoint serait une fuite temporelle.

### Une donnée réelle est immuable

`simulateFromCheckpoint()` **lève** si un scénario vise un pilote ayant déjà
couru la manche concernée. Un what-if silencieusement ignoré afficherait une
probabilité conditionnelle sans condition — c'est-à-dire un chiffre faux.

L'interface affiche alors :

> Résultat Q4 déjà acquis — scénario What-if indisponible pour cette manche.

### Tests — `tests/hybridLiveRace.test.js` (22)

- chrono d'un pilote réel : **une seule valeur** sur 2 000 tirages ;
- ordre relatif des pilotes réels : identique sur 1 000 tirages ;
- un pilote réellement 3ᵉ ne descend jamais sous P3 (borne atteinte : exacte) ;
- un statut réel n'est jamais transformé en chrono ;
- chronos strictement croissants, positifs et distincts sur 4 configurations
  (0 %, 12 %, 37 %, 87 % de réel) ;
- 0 réel ⇒ résultat identique au mode `'none'`, distributions comprises ;
- 100 % réel ⇒ `deterministic: true`, `simulations: 0` ;
- refus du what-if, de la matrice, et garde côté interface ;
- comportement identique pour Q2, Q3, Q4 en cours ;
- recalculer ne modifie pas les données de départ.

---

## 3. Bloc CERTITUDES — `js/projection/raceCertainties.js`

**Règle absolue : rien n'y entre qui dépende d'un tirage.** Aucune version
approchée, aucun pourcentage. Une métrique voisine mais non déterministe reste
dans le bloc simulation, sous la forme « Dans X % des simulations… ».

### Bornes de position

Pour un pilote **ayant déjà couru** :

```
meilleure position possible = pilotes réels déjà devant + 1
pire position possible      = cette valeur + pilotes restant à courir
```

Les deux bornes sont **atteintes** par la simulation (vérifié sur 4 000
tirages) : c'est le meilleur encadrement possible, pas une marge de prudence.

### Verdict mathématique

Calculé **uniquement si la manche en cours est la dernière**. Tant qu'une manche
reste à disputer, on reste sur SIMULATION / PROBABILITÉ.

La méthode est délibérément **conservatrice** : chaque adversaire est crédité de
son meilleur résultat encore possible. Une conclusion « qualifié » est donc
valide à coup sûr ; l'absence de conclusion ne prouve rien.

Conséquence assumée, visible dans l'exemple réel ci-dessous : on peut lire
« 100 % des simulations » **sans** verdict de qualification. C'est exactement la
distinction recherchée — 100 % sur N tirages dit que le cas contraire n'est pas
apparu, pas qu'il est impossible.

### Séries

Le nombre de **pilotes** passés est toujours connu. Le nombre de **séries**
terminées n'est annoncé que si au moins une série est renseignée, et toujours
avec sa source :

> 4 / 6 séries terminées d'après les séries renseignées.

Sinon : « le nombre de séries terminées ne peut pas être établi ». Une série
n'est déclarée terminée que si ses membres connus atteignent la taille attendue
par le règlement — un pilote encore à courir ne peut donc pas lui appartenir, et
le compte est exact.

### Tests — `tests/raceCertainties.test.js` (19)

- bornes atteintes par la simulation ;
- aucun énoncé ne contient `%`, « probab », « estim », « simulation » ;
- aucun verdict tant qu'une manche suit ;
- **un verdict « qualifié » n'est jamais démenti** : sur toutes les combinaisons
  pilote × seuil où un verdict est rendu, la simulation donne exactement 1 ou 0 ;
- sortie strictement identique d'un appel à l'autre — aucune graine impliquée.

---

## 4. Interface

- bandeau **MANCHE EN COURS** clignotant, avec barre d'avancement réel/engagés ;
- compte des résultats réels, des pilotes restants (nommés) et des séries ;
- quatrième bande de couleur (vert « acquis ») pour le bloc CERTITUDES,
  volontairement éloignée de l'orange simulation et du violet interprétation ;
- cartes : position provisoire · meilleure position possible · pire position
  théorique · points de la manche ;
- refus explicite du what-if et de la matrice pour un pilote déjà passé ;
- nuance affichée quand la probabilité vaut 0 % ou 100 % : « le cas contraire
  n'est pas apparu — ce n'est pas une démonstration qu'il est impossible ».

Smoke navigateur : `node tools/smoke/liveRaceSmoke.mjs` — **15/15**.
Le meeting est mis « en direct » à la volée, en masquant les dernières séries
d'un meeting réel ; aucun fichier n'est modifié.

---

## 5. Exemple réel — Kerlabo D3, manche 4 rejouée en direct

`node tools/qualification-audit/09-manche-en-cours.mjs`

30 engagés · 16 places qualificatives · 6 séries · 6 000 tirages · graine 20260101
Pilote suivi : **#374 Denis Guillerm** — P16, 84 pts avant Q4, exactement sur la bulle.

| Étape | Réels | Position provisoire | Meilleure | Pire | P(qualif) | Certitudes |
|---|---|---|---|---|---|---|
| avant Q4 | 0/30 | — | — | — | **37,0 %** | aucune manche en cours |
| après série 1 | 5/30 | pas encore passé | P1 | P29 | **38,5 %** | places P1–P29 atteignables |
| après série 2 | 10/30 | pas encore passé | P1 | P29 | **35,8 %** | idem |
| après série 3 | 15/30 | pas encore passé | P1 | P29 | **46,8 %** | idem |
| après série 4 | 20/30 | **P10** | P10 | P20 | **69,0 %** | résultat acquis · 9 pilotes hors de portée · 24–34 pts |
| avant dernière série | 25/30 | **P14** | P14 | P19 | **100,0 %** | résultat acquis · 13 pilotes hors de portée · 25–30 pts |
| Q4 terminée | 30/30 | — | — | — | **fait établi, 0 tirage** | QUALIFIÉ |

Réalité : Q4 en P19 (25 pts) → **P16 avec 109 pts → QUALIFIÉ**.

> **Chiffres corrigés.** La première version de ce tableau affichait
> 37,0 → 20,5 → 4,3 → 100 %. Cet effondrement était un défaut d'échelle de
> temps, corrigé depuis (§7). La trajectoire réelle est bien plus sage : la
> probabilité reste autour de 36–39 % pendant que passent les séries de queue de
> peloton, puis monte quand les rivaux directs livrent leurs résultats.

Trois lectures à retenir :

1. **Les deux premières séries ne changent presque rien** (37,0 → 38,5 → 35,8 %).
   C'est attendu : les séries sont composées du plus lent au plus rapide, et les
   dix premiers passés sont tous classés derrière Guillerm au provisoire.
2. **La série 3 fait bondir la projection** (+11 points) : elle contient ses
   premiers concurrents directs, dont deux terminent moins bien que leur
   projection médiane.
3. **Le what-if bascule** de « disponible » à « indisponible » au moment exact
   où le pilote passe — son résultat n'est plus une hypothèse.

### Pourquoi la probabilité bouge — décomposition

`node tools/qualification-audit/11-pourquoi.mjs`

L'attribution n'est pas une corrélation : pour chaque pilote ayant couru, la
probabilité est **recalculée dans un monde où ce seul résultat serait encore
inconnu**, à tirages identiques. L'écart mesure l'effet propre de ce résultat.

Exemple, série 3 (+9,7 points au total) :

| Pilote | Avant Q4 | Chrono Q4 | Q4 provisoire | Q4 finale projetée | Effet propre |
|---|---|---|---|---|---|
| #325 Delaunay | P8 · 106 pts | 2:28.628 | P1 | P1 · 50 pts | ≈ 0 (hors zone) |
| #369 Sordet | P11 · 98 pts | 2:29.090 | P3 | P2 · 45 pts | ≈ 0 (hors zone) |
| #329 Bothorel | P20 · 72 pts | 2:30.630 | P5 | P7 · 37 pts | défavorable |
| #333 Lefevre | P18 · 76 pts | 2:33.839 | P8 | P14 · 30 pts | défavorable |
| #309 Jacquinet | P19 · 75 pts | 2:34.627 | P10 | P17 · 27 pts | favorable |

La somme des effets propres et la variation observée ne coïncident pas
exactement — deux résultats interagissent. Le **résidu non attribuable est
affiché tel quel** plutôt que réparti arbitrairement entre les pilotes.

---

## 6. Défaut d'échelle de temps découvert et corrigé

### Le symptôme

La première version affichait 37,0 % → 20,5 % → 4,3 % en deux séries. La
mécanique invoquée — « les résultats réels des rivaux remontent le score de
coupure » — était fausse : les rivaux en question étaient tous classés
**derrière** Guillerm.

### La cause

`timeScaleOf()` estimait la dispersion des chronos à partir de deux points, en
lisant le rang d'un finisseur **parmi les engagés**. Sur une manche
partiellement courue, cinq pilotes déjà passés occupent les positions
provisoires P1 à P5 d'un plateau de 30 : leur étendue de chronos réelle
(11,4 s) était donc rapportée à l'intervalle de quantiles des cinq premières
places, minuscule. La pente explosait.

Mesuré sur Kerlabo D3 :

| Séries révélées | Étendue simulée du plateau | Pilote médian simulé |
|---|---|---|
| 0 (Q3 complète) | 18,4 s | 2:39.7 |
| **1** | **51,7 s** | **2:54.7** |
| 2 | 31,1 s | 2:44.4 |
| 6 (Q4 complète) | 15,9 s | 2:34.1 |
| *manche 4 réelle* | *14,1 s* | *2:30.3* |

Le pilote médian simulé se retrouvait 14 s derrière le **dernier** pilote réel.
Les cinq pilotes déjà passés étaient donc quasi certains de finir P1–P5 du
classement final, avec 50/45/42/40/39 points — d'où l'effondrement.

### Deuxième cause : les séries ne sont pas tirées au sort

Mesuré sur les 30 manches finales de la base :

| Série | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Rang moyen en Q3 des pilotes | 17,9 | 14,1 | 9,4 | 7,3 | 4,9 | 3,0 |

Les premiers passés sont **les plus lents du plateau, par construction**. Lire
leur rang comme un quantile reste donc faux même avec un ajustement correct.

### Le correctif

L'ajustement porte désormais sur la **force estimée de chaque pilote** (le µ de
son modèle de performance) et non sur son rang : on compare chaque chrono à ce
qu'on attendait de *ce* pilote, ce qui est insensible à la composition des
séries. La pente est ramenée vers celle de la dernière manche complète, d'autant
plus fortement que les finisseurs observés sont peu nombreux ; le niveau, lui,
vient toujours des chronos réels de la manche en cours, ce qui capte l'évolution
de la piste.

### Validation sur données réelles

`node tools/qualification-audit/12-calibration-live.mjs [séries]`

On masque les séries d'une manche terminée, on simule, et on compare la position
finale **réelle** de chaque pilote déjà passé à la distribution simulée.

| Séries révélées | Biais moyen (ancienne) | Biais moyen (corrigée) | Couverture 80 % (ancienne → corrigée) |
|---|---|---|---|
| 1 | −8,03 places | **−0,81** | 6,8 % → **62,6 %** |
| 2 | −6,06 | **+0,01** | 19,2 % → **63,7 %** |
| 3 | −4,46 | **+0,17** | 20,7 % → **68,8 %** |
| 4 | −3,06 | **+0,08** | 28,3 % → **82,0 %** |

Un biais de −8 places signifiait que le moteur classait chaque pilote déjà passé
huit places trop haut. Le biais est désormais nul à moins d'une place près.

La couverture reste sous les 80 % attendus quand peu de séries sont connues :
les distributions sont alors **un peu trop étroites**. C'est une
sur-confiance résiduelle, pas un biais, et elle est signalée ici plutôt que
corrigée par un facteur arbitraire.

### Le conditionnement lui-même est correct

`node tools/qualification-audit/13-conditionnement.mjs`

Test des espérances itérées : la moyenne des probabilités conditionnelles, prise
sur les déroulements possibles d'une série que le moteur tire lui-même, doit
retomber sur la probabilité d'avant la manche.

| Meeting / catégorie | Avant | Moyenne conditionnelle | Écart |
|---|---|---|---|
| Kerlabo / D3 | 37,6 % | 37,7 % | +0,14 pt (0,9 σ) |
| Kerlabo / D4 | 35,9 % | 36,9 % | +0,97 pt (1,6 σ) |
| Kerlabo / Super1600 | 68,2 % | 68,2 % | +0,01 pt |
| Kerlabo / Féminines | 58,2 % | 58,5 % | +0,34 pt (2,8 σ) |

Le conditionnement ne dérive pas. Il reste un léger biais positif, inférieur à
un point, attribuable à la ré-estimation de l'échelle sur peu d'observations ;
il est signalé, pas masqué.

Et l'amplitude n'est pas anormale en soi : sur Kerlabo D3, **une seule série
peut légitimement déplacer la probabilité de 34,1 % à 41,2 %**. C'est la
moyenne qui doit être stable, pas chaque trajectoire.

### Aucun résultat des lots précédents n'est modifié

En simulation **pure**, l'échelle de temps n'a aucun effet : les positions
viennent de l'ordre des forces tirées, et les chronos émis sont une fonction
croissante du rang. Multiplier l'échelle par cent ne déplace pas un pilote.

Vérifié de deux façons :

- test unitaire — deux meetings au classement identique mais aux chronos dix
  fois plus étalés donnent **la même probabilité** ;
- backtest complet ré-exécuté : les six lignes du tableau du LOT 2 sont
  **inchangées au dix-millième près** (après Q3, meeting exclu : climatologie
  0,1738 · historique 0,0646 · Monte-Carlo 0,0420).

---

## 7. Statuts DNF / DNS / DSQ — audit

Un simulateur qui poserait « DNF = 0 point » serait faux dans les deux
règlements réellement utilisés.

### Ce que disent les règlements présents en base

Barème MQ commun : `44 − position`, avec P1 = 50, P2 = 45, P3 = 42.

| Statut | FFSA Rallycross 2026 | Euro RX |
|---|---|---|
| DNF | barème à (engagés + 1) | barème à (engagés + 1) |
| DNS | **fixe : 0 pt** | barème à (engagés + 5) |
| DSQ | fixe : 0 pt | fixe : 0 pt |
| DSQ_RACE | barème à (engagés + 3) | barème à (engagés + 10) |

Sur un plateau de 30, en FFSA : **DNF = 13 points**, soit **un seul point de
moins que la dernière place classée** (14 pts). Un abandon coûte cher au
classement de la manche, pas au score. En Euro RX, un DNS rapporte 9 points là
où il en rapporte 0 en FFSA.

Les points dépendent du nombre d'engagés : DNF vaut 35 pts à 8 engagés et 3 pts
à 40.

### Le simulateur applique-t-il ces règles ?

Oui, et par construction : il n'a aucun barème propre. Il fabrique des documents
de résultat portant un statut, puis les passe à `buildMqStandings()` — la
fonction de l'application, qui appelle `calcStatusPoints(status, 'MQ',
totalEngaged, regulation)`.

`node tools/qualification-audit/10-statuts.mjs` compare les deux chemins :

```
72 comparaisons (2 règlements × 9 tailles de plateau × 4 statuts)
écarts : 0
```

Tests permanents — `tests/statusPoints.test.js` (21) : chaque statut, chaque
règlement, dix tailles de plateau, position **et** points. Plus un test que le
DNF tiré au hasard pendant la simulation et le DNF imposé par un scénario
donnent exactement le même résultat.

### Deux défauts corrigés à cette occasion

1. **`raceCertainties` recodait le placement des statuts** (`engagés + 1`,
   `engagés + 3`). Valeurs correctes, mais dupliquées — et deux
   implémentations d'une même règle finissent par diverger. La position et les
   points sont désormais **lus** dans le classement produit par
   `buildMqStandings`.
2. **La liste des statuts était figée** à `['DNF','DNS','DSQ']`, ce qui excluait
   `DSQ_RACE` — pourtant présent 9 fois dans les données réelles — des scénarios
   « et si » et des bornes de points. Elle est désormais lue dans
   `regulation.statusRules`.

### Effet sur les lots précédents

Aucun effet numérique : les points de statut passaient déjà par le règlement.
Backtest ré-exécuté, six lignes identiques. Le seul changement visible est
qu'un scénario `DSQ_RACE` est désormais proposé quand le règlement le définit.

### Vérification demandée : « DNF Q3 → 2,5 % »

Ce chiffre du LOT 3 était bien calculé avec **13 points** (Kerlabo D3, 30
engagés), pas avec 0. Le faible pourcentage vient de la position — un DNF est
classé 31ᵉ sur 30 — et non d'un score nul.

---

## 8. Fichiers

**Nouveaux**
- `js/projection/raceCertainties.js`
- `tests/raceInProgress.test.js`, `tests/hybridLiveRace.test.js`, `tests/raceCertainties.test.js`
- `tools/smoke/liveRaceSmoke.mjs`
- `tests/statusPoints.test.js`, `tests/timeScale.test.js`
- `tools/qualification-audit/09-manche-en-cours.mjs` — progression en direct
- `tools/qualification-audit/10-statuts.mjs` — audit DNF / DNS / DSQ
- `tools/qualification-audit/11-pourquoi.mjs` — décomposition des variations
- `tools/qualification-audit/12-calibration-live.mjs` — biais et couverture
- `tools/qualification-audit/13-conditionnement.mjs` — espérances itérées

**Modifiés**
- `js/projection/qualificationState.js` — états de manche, `seriesStateOf()`
- `js/projection/scenarioSimulator.js` — mode hybride, `assignChronos()`, refus des scénarios contradictoires
- `js/projection/qualificationBacktest.js` — `liveResults: 'none'`
- `js/projection/projectionConfig.js` — messages du direct et des certitudes
- `js/projectionStats.js`, `css/modules/projection.css` — bandeau, bloc CERTITUDES, refus
- `tests/helpers/projectionFixtures.js` — sentinelle `PENDING`, champ `serie`
- `sw.js` (cache `rx-chrono-v36`), `tests/moduleGraph.test.js`

**Total : 805 tests · 44/44 smoke projection · 15/15 smoke direct.**
