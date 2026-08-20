# LOT 3 — Projection après Q2, what-if Q3 et matrice croisée

> Reproductible :
> `node tools/qualification-audit/06-backtest.mjs 2`
> `node tools/qualification-audit/08-exemples-q2.mjs [meeting] [catégorie]`

---

## 1. Intégrité des manches simulées — vérification demandée

**La propriété était déjà garantie par la construction du LOT 2.** Aucune
modification d'architecture n'a été nécessaire ; des tests explicites ont été
ajoutés, parce qu'une propriété non testée finit toujours par se perdre.

### Pourquoi elle est garantie

`simulateRaceRows()` ne tire jamais une position par pilote. Il construit **un
seul tableau ordonné** :

1. chaque pilote entre dans exactement une catégorie — classé, incident, ou
   résultat forcé — grâce à un `continue` après chaque branche ;
2. les classés sont triés par force latente tirée, ce qui donne un ordre
   total : `order` ;
3. les résultats forcés sont **insérés** dans ce même tableau par `splice`, ce
   qui décale les autres exactement comme dans une vraie course ;
4. les chronos sont dérivés du **rang final** dans `order`, avec un terme
   `+ index` qui garantit la stricte croissance même en cas d'arrondi
   identique ;
5. `buildMqStandings()` retrouve cet ordre en triant par chrono et attribue
   1, 2, … k.

Il n'existe donc aucun chemin par lequel deux pilotes pourraient recevoir la
même place classée : ils occupent des index distincts d'un même tableau.

### Ce que les tests prouvent

`tests/simulationIntegrity.test.js` — 19 tests, plusieurs dizaines de milliers
de manches simulées :

| Propriété | Couverture |
|---|---|
| Aucune position classée dupliquée | 5 000 manches |
| Places contiguës de 1 à N, sans trou | 2 000 manches |
| Chaque pilote apparaît une fois et une seule | 2 000 manches |
| Vrai sur plusieurs graines | 7 graines × 500 manches |
| Vrai en présence d'abandons | 3 000 manches à 25 % d'incident |
| Pilote forcé P1 → unique P1 | 3 000 manches |
| Pilote forcé P5 → unique P5, exactement 4 devant | 3 000 manches |
| Deux pilotes forcés sur des places distinctes | 500 manches |
| Q3 **et** Q4 après Q2, chacune une permutation | 300 graines |
| Forçage simultané P6 en Q3 et P8 en Q4 | 200 graines, contraintes vérifiées séparément |
| Chronos strictement croissants avec la place | 3 000 manches, avec et sans forçage |
| Aucun chrono en doublon | 2 000 manches |
| Abandons sans chrono | 500 manches |

Les DNF / DNS / DSQ ne participent pas à la permutation — ce ne sont pas des
places. Leur placement suit exactement la convention de l'application : DNF à
`engagés + 1`, DSQ_RACE à `engagés + 3`, DNS et DSQ hors classement. Un test
le vérifie explicitement.

### Un cas limite, assumé et testé

Si l'on force P5 alors que seuls deux pilotes terminent la manche, il est
physiquement impossible d'avoir quatre pilotes devant. Le pilote prend alors la
meilleure place atteignable — la dernière du classement — et l'exclusivité
reste entière. Le comportement est testé plutôt que laissé au hasard.

---

## 2. Le coût de la matrice, mesuré avant d'être implémenté

Mesures sur un plateau réel de 30 pilotes (Kerlabo / D3) :

| Configuration | Coût |
|---|---|
| 1 manche restante | 0,117 ms par tirage |
| 2 manches restantes | 0,170 ms par tirage |
| **Matrice complète 30 × 30 × 10 000** | **26 minutes** |
| Matrice réduite 10 × 10 × 1 500, sans mutualisation | 18 s |
| Matrice réduite 10 × 10 × 1 500, **mutualisée** | 14,4 s |

Trois leviers ont été retenus :

1. **Mutualisation de la ligne.** Pour une hypothèse de ligne donnée, la manche
   de ligne n'est simulée **qu'une fois par tirage**, puis réutilisée pour
   toutes les colonnes. Le coût passe de (lignes × colonnes) simulations
   complètes à (lignes) simulations plus (lignes × colonnes) recalculs de
   classement.
2. **Nombres aléatoires communs.** Toute la matrice partage la même graine :
   les autres pilotes vivent exactement les mêmes courses dans chaque cellule.
   Les **écarts** entre cellules sont donc bien mieux estimés que les valeurs
   absolues — or c'est la comparaison qui intéresse le lecteur.
3. **Hypothèses sélectionnées.** P1, P3, P5, P8, P10, P12, P15, P20, dernière
   place, plus l'abandon — pas tout le plateau.

Une quatrième piste a été essayée et **abandonnée** : mutualiser le tableau de
manches passé à `buildInterimStandings` pour éviter les allocations. Gain
mesuré : nul. Le coût est dominé par la construction du classement lui-même,
pas par les allocations de tableaux. La simplification a été conservée parce
qu'elle est plus lisible, pas parce qu'elle accélère.

Le calcul est découpé **ligne par ligne** dans l'interface, avec progression
affichée et rendu de la main au navigateur entre chaque ligne. À 1 500 tirages,
chaque cellule porte environ **± 1,3 point** d'incertitude, valeur affichée dans
le panneau « Pourquoi ? » plutôt que passée sous silence.

### Exemple réel — Kerlabo / D3, après Q2, pilote au seuil

```
Q3 ＼ Q4      P1    P3    P5    P8   P10   P12   P15   P20   P30   DNF   médiane après Q3
P1          100%  100%  100%  100%  100%  100%  100%  100%   99%   93%   P9
P3          100%  100%  100%  100%  100%  100%  100%   99%   59%   28%   P12
P5          100%  100%  100%  100%  100%  100%  100%   93%   30%   10%   P13
P8          100%  100%  100%  100%  100%  100%   98%   77%   12%    1%   P14
P10         100%  100%  100%  100%  100%   99%   94%   60%    4%    0%   P15
P12         100%  100%  100%  100%   99%   96%   84%   38%    1%    0%   P16
P15         100%  100%  100%   99%   95%   86%   62%   16%    0%    0%   P17
P20         100%   99%   96%   81%   65%   44%   17%    1%    0%    0%   P19
P30          99%   69%   39%   15%    6%    2%    0%    0%    0%    0%   P23
DNF          96%   37%   15%    3%    0%    0%    0%    0%    0%    0%   P24
```

La lecture est immédiate : une Q3 correcte laisse presque toute latitude en Q4,
une Q3 manquée rend Q4 décisive, et un abandon en Q3 ne laisse qu'un podium en
Q4 comme issue.

---

## 3. Risque d'incident — données conservées séparément

Comme demandé, aucune recommandation n'est tirée de ces chiffres : ils sont
mesurés, présentés côte à côte, et rien de plus. Les résultats classés et les
manches non terminées vivent dans **deux tableaux distincts** de l'interface :
les mélanger dans la même colonne laisserait croire à un continuum entre « finir
20e » et « ne pas finir », ce qui n'en est pas un.

Kerlabo / D3, après Q2 — probabilité de qualification finale :

| Pilote | Situation après Q2 | TARGET Q3 | DNF en Q3 |
|---|---|---|---|
| #302 Fretin | P8, −8 places | P30 (courbe plate) → 95,5 % | **92,3 %** |
| #356 Le Guerneve | P16, au seuil | P1 → 99,7 % | **2,5 %** |
| #333 Lefevre | P18, +2 places | P1 → 99,3 % | **0,5 %** |
| #329 Bothorel | P22, +6 places | P1 → 85,6 % | **1,1 %** |

L'écart entre un pilote confortable (un abandon coûte 7 points de probabilité)
et un pilote à la bulle (un abandon coûte 97 points) est la donnée brute que
le module produit désormais.

À noter : sous le règlement actuel, **DNS et DSQ sont équivalents** — tous deux
valent 0 point et sortent du classement de la manche (`statusRules`). Leurs
lignes sont donc identiques ; c'est le règlement qui le dit, pas un défaut du
modèle.

---

## 4. Backtest après Q2

| Régime | Climatologie | Historique | Monte-Carlo | Verdict |
|---|---|---|---|---|
| meeting exclu | 0,1738 | 0,0887 | **0,0593** | MC −0,0294 |

Justesse au seuil 0,5 : 77,6 % / 87,9 % / **92,2 %**.

La couverture du Monte-Carlo passe de 584 à **603 cas sur 603** : le simulateur
héritait du défaut de `calc.js` (2 manches classées exigées), ce qui écartait
silencieusement les pilotes n'ayant qu'une manche classée au checkpoint — et
vidait complètement le classement de départ au checkpoint après Q1. Corrigé et
couvert par un test de non-régression.

### Absence de fuite — prouvée, pas déclarée

`tests/backtestLeakage.test.js` construit **deux jeux de données identiques
jusqu'au checkpoint et divergents après**, puis vérifie que les prédictions sont
rigoureusement identiques. Si une seule donnée postérieure entrait dans le
modèle, les probabilités différeraient.

Le test couvre les checkpoints Q1, Q2 et Q3, et vérifie aussi que :

* les **résultats réels** diffèrent bien entre les deux jeux — sans quoi le
  test ne prouverait rien ;
* retirer des inscrits de Q3 et Q4 ne change pas la projection faite après Q2
  (la liste des partants d'une manche future n'est pas lue) ;
* le régime strict n'utilise que les meetings antérieurs en date ;
* deux exécutions de même graine donnent les mêmes probabilités, et une graine
  différente ne change que le Monte-Carlo, jamais l'historique.

La première version de ce test échouait au checkpoint Q3 — à juste titre : la
fixture faisait varier la manche Q3 elle-même, qui est **légitimement** visible
à ce checkpoint. C'est la distinction entre une fuite et une lecture autorisée,
et elle est maintenant explicite dans le test.

---

## 5. Quatre exemples réels — Kerlabo / D3, après Q2

Seuil à 16 places, 30 engagés. Le résultat réel n'était pas connu du modèle.

### Pilote confortable — #302 Fretin, P8, 75 pts

Probabilité globale **99,8 %**, classement final médian P6. TARGET Q3 : courbe
plate, aucune place ne change sensiblement la donne. Un abandon en Q3 laisse
encore 92,3 %. Classification VERT.
*Réel : P11 en Q3, P3 en Q4 → P6 final, qualifié.*

### Pilote autour de la bulle — #356 Le Guerneve, P16, 52 pts

Probabilité globale **43,6 %** (historique comparable : 41,7 % sur 12 cas — les
deux estimateurs concordent). La courbe Q3 est régulière et sans plateau : P1 →
99,7 %, P8 → 75,3 %, P12 → 59,1 %, P15 → 46,3 %, P20 → 27,0 %, soit environ
4 points de probabilité par place. TARGET Q3 = P1, régime « sensible » : chaque
place compte sur toute la courbe. Un abandon fait tomber à 2,5 %.
*Réel : DNF en Q3, P10 en Q4 → P20 final, non qualifié. Le scénario DNF avait
été chiffré à 2,5 %.*

### Pilote en difficulté — #333 Lefevre, P18, 51 pts

Probabilité globale **20,4 %**. Il lui faut un gros résultat : P1 → 99,3 %,
P5 → 76,2 %, P10 → 51,5 %, P15 → 28,1 %. Classification ROUGE.
*Réel : P19 en Q3, P23 en Q4 → P21 final, non qualifié.*

### Pilote très en retrait — #329 Bothorel, P22, 46 pts

Probabilité globale **28,7 %**, alors que la table historique annonce 0,0 % sur
5 cas seulement — écart instructif : à cet écart au seuil, l'historique n'a
presque aucun cas et sa confiance est explicitement « faible », tandis que le
Monte-Carlo tient compte du rythme réel du pilote. P1 → 85,6 %, P8 → 50,5 %.
*Réel : P18 en Q3, P16 en Q4 → P19 final, non qualifié.*

### Colonne la plus utile

La colonne « situation avant Q4 » répond directement à la question posée :
pour #356, finir P8 en Q3 le placerait médian **P14 avec 88 points, soit
2 places dans la zone qualificative** avant d'aborder Q4 ; finir P15 le
laisserait **P17, une place dehors**. C'est cette projection intermédiaire,
plus que la probabilité finale, qui dit si Q3 est critique.

---

## 6. Limites inchangées

Celles du LOT 2 restent valables : une seule saison d'historique, calibration
solide aux extrêmes mais fragile entre 20 et 70 %, poids de sources explicables
mais non calibrés. La matrice ajoute la sienne : **± 1,3 point par cellule**, et
des hypothèses échantillonnées plutôt qu'exhaustives.
