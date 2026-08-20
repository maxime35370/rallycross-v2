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
| après série 1 | 5/30 | pas encore passé | P1 | P29 | **20,5 %** | places P1–P29 atteignables |
| après série 2 | 10/30 | pas encore passé | P1 | P29 | **4,3 %** | idem |
| après série 3 | 15/30 | pas encore passé | P1 | P29 | **2,2 %** | idem |
| après série 4 | 20/30 | **P10** | P10 | P20 | **100,0 %** | résultat acquis · 9 pilotes hors de portée · 24–34 pts |
| avant dernière série | 25/30 | **P14** | P14 | P19 | **100,0 %** | résultat acquis · 13 pilotes hors de portée · 25–30 pts |
| Q4 terminée | 30/30 | — | — | — | **fait établi, 0 tirage** | QUALIFIÉ |

Réalité : Q4 en P19 (25 pts) → **P16 avec 109 pts → QUALIFIÉ**.

Trois lectures à retenir :

1. **La probabilité bouge fortement pendant la manche** (37 % → 4,3 % → 100 %) :
   ce ne sont pas des révisions arbitraires, mais l'effet des résultats réels des
   rivaux, qui déplacent le score de coupure.
2. **Le what-if bascule** de « disponible » à « INDISPONIBLE (résultat déjà
   acquis) » au moment exact où le pilote passe.
3. **100 % de simulations n'est pas une certitude** : aux étapes 5 et 6, aucun
   verdict mathématique n'est prononcé, parce que la borne conservatrice ne
   permet pas de le démontrer. Le chiffre est affiché comme probabilité, jamais
   dans le bloc CERTITUDES.

---

## 6. Fichiers

**Nouveaux**
- `js/projection/raceCertainties.js`
- `tests/raceInProgress.test.js`, `tests/hybridLiveRace.test.js`, `tests/raceCertainties.test.js`
- `tools/smoke/liveRaceSmoke.mjs`
- `tools/qualification-audit/09-manche-en-cours.mjs`

**Modifiés**
- `js/projection/qualificationState.js` — états de manche, `seriesStateOf()`
- `js/projection/scenarioSimulator.js` — mode hybride, `assignChronos()`, refus des scénarios contradictoires
- `js/projection/qualificationBacktest.js` — `liveResults: 'none'`
- `js/projection/projectionConfig.js` — messages du direct et des certitudes
- `js/projectionStats.js`, `css/modules/projection.css` — bandeau, bloc CERTITUDES, refus
- `tests/helpers/projectionFixtures.js` — sentinelle `PENDING`, champ `serie`
- `sw.js` (cache `rx-chrono-v36`), `tests/moduleGraph.test.js`

**Total : 775 tests · 44/44 smoke projection · 15/15 smoke direct.**
