# LOT 2 — Monte-Carlo : résultats du backtest et règles appliquées

> Point de décision convenu : le Monte-Carlo devait **prouver** qu'il apporte
> quelque chose face à la table historique du LOT 1, sans quoi l'historique
> restait l'estimateur principal.
>
> Tous les chiffres de ce document sont reproductibles :
> `node tools/qualification-audit/06-backtest.mjs [checkpoint]`
> `node tools/qualification-audit/07-exemples.mjs [meeting] [catégorie]`

---

## 1. Verdict

**Le Monte-Carlo fait mieux que l'historique, à chaque checkpoint, dans les deux
régimes de fuite temporelle.** L'écart est net et ne tient pas à un réglage
favorable : il subsiste sous le régime le plus sévère.

Brier score (plus bas = meilleur), 30 meetings × catégorie, ~600 cas pilote,
3 000 tirages par meeting, graine 20260101 :

| Checkpoint | Régime | Climatologie | Historique | Monte-Carlo | Verdict |
|---|---|---|---|---|---|
| après Q1 | meeting exclu | 0,1728 | 0,1249 | **0,0846** | MC −0,0403 |
| après Q1 | antérieurs seuls | 0,1728 | 0,1342 | **0,0913** | MC −0,0430 |
| après Q2 | meeting exclu | 0,1738 | 0,0887 | **0,0582** | MC −0,0305 |
| après Q2 | antérieurs seuls | 0,1738 | 0,1097 | **0,0601** | MC −0,0496 |
| après Q3 | meeting exclu | 0,1738 | 0,0646 | **0,0423** | MC −0,0223 |
| après Q3 | antérieurs seuls | 0,1738 | 0,0858 | **0,0420** | MC −0,0438 |

Justesse au seuil de décision 0,5, après Q3 : climatologie 77,6 %, historique
91,4 %, Monte-Carlo 95,0 %.

Deux lectures méritent d'être soulignées :

* **Les deux prédicteurs s'améliorent à mesure que le meeting avance**, ce qui
  est la sanity check attendue : après Q3 il reste moins d'incertitude
  qu'après Q1.
* **L'avantage du Monte-Carlo est le plus grand tôt dans le meeting** (−0,040
  après Q1 contre −0,022 après Q3). C'est cohérent : après Q3 le classement
  suffit presque à lui seul, alors qu'après Q1 il ne dit presque rien et le
  rythme observé apporte beaucoup.
* **Le Monte-Carlo est presque insensible au régime de fuite** (0,0423 contre
  0,0420 après Q3) alors que l'historique se dégrade nettement (0,0646 → 0,0858).
  Logique : le Monte-Carlo s'appuie surtout sur les manches déjà courues du
  meeting analysé, quand la table historique dépend entièrement des autres
  meetings.

## 2. Calibration après Q3 (meeting exclu)

| Tranche annoncée | Historique : n / annoncé → observé | Monte-Carlo : n / annoncé → observé |
|---|---|---|
| 0–10 % | 72 · 1,1 % → 2,8 % | 79 · 2,3 % → 2,5 % |
| 10–20 % | 14 · 11,1 % → 14,3 % | 16 · 15,2 % → 12,5 % |
| 20–30 % | 2 · 20,0 % → 50,0 % | 9 · 24,2 % → 44,4 % |
| 30–40 % | 12 · 36,1 % → 41,7 % | 15 · 35,3 % → 26,7 % |
| 40–50 % | 9 · 42,9 % → 33,3 % | 5 · 43,5 % → 20,0 % |
| 50–60 % | 17 · 52,7 % → 64,7 % | 11 · 54,7 % → 54,5 % |
| 60–70 % | 7 · 65,3 % → 28,6 % | 13 · 65,5 % → 61,5 % |
| 70–80 % | 40 · 74,4 % → 60,0 % | 9 · 73,5 % → 100,0 % |
| 80–90 % | 25 · 87,1 % → 92,0 % | 21 · 85,2 % → 90,5 % |
| 90–100 % | 405 · 99,2 % → 97,5 % | 417 · 99,5 % → 99,0 % |

Deux constats honnêtes :

* la calibration est bonne aux extrêmes, où se trouvent 80 % des cas ;
* **elle est fragile dans la zone médiane**, précisément là où la décision est
  intéressante — mais les effectifs y sont de 5 à 20 cas. Ces lignes ne
  permettent pas de conclure, et l'interface les affiche avec leur effectif
  pour cette raison. C'est le volume de données qui manque, pas le modèle.

## 3. Où le Monte-Carlo gagne, et où il ne gagne pas

Brier par écart au seuil après Q3 (meeting exclu) :

| Écart | n | Observé | Historique | Monte-Carlo | Meilleur |
|---|---|---|---|---|---|
| −3 places | 30 | 93,3 % | 0,0639 | 0,0624 | MC |
| −2 places | 30 | 93,3 % | 0,0726 | 0,0637 | MC |
| −1 place | 30 | 83,3 % | 0,2033 | 0,1188 | **MC** |
| au seuil | 30 | 70,0 % | 0,2571 | 0,1432 | **MC** |
| +1 place | 30 | 43,3 % | 0,2685 | 0,2005 | **MC** |
| +2 places | 25 | 16,0 % | 0,1010 | 0,1207 | hist |
| +3 places | 24 | 0,0 % | 0,0000 | 0,0206 | hist |

L'avantage se concentre **dans la zone de bulle** (−1 à +1 place), celle qui
intéresse un team. Loin du seuil, l'historique est parfait par construction
(tout le monde passe, ou personne) et le Monte-Carlo perd un peu en gardant une
incertitude résiduelle — c'est le prix d'un modèle qui ne s'autorise pas la
certitude absolue, et c'est un prix acceptable.

Par catégorie, le Monte-Carlo l'emporte sur **les 7 catégories** ayant au moins
30 cas.

## 4. Absence de fuite temporelle

Quatre vecteurs ont été identifiés et traités ; deux ne l'avaient pas été dans
la première version du backtest et ont été corrigés après mesure.

| Vecteur | Traitement |
|---|---|
| Manches suivantes du meeting analysé | Jamais lues : le modèle ne voit que Q1…Q(checkpoint). |
| Résultat final du meeting analysé | Sert uniquement de vérité terrain, jamais d'entrée. |
| **Liste des partants d'une manche future** | Sur 8 des 30 groupes, le plateau de Q4 est plus petit que celui d'après Q3 : le lire reviendrait à connaître des forfaits à l'avance. Le backtest reconduit donc le plateau du checkpoint. **Effet mesuré : le Brier du Monte-Carlo après Q3 passe de 0,0377 à 0,0423.** |
| Historique des autres meetings | Deux régimes proposés, tous deux mesurés (tableau §1). |

**Résidu assumé.** Le nombre de places qualificatives n'est stocké nulle part :
il est retrouvé en comptant les partants de la phase suivante. Sur 9 des 30
groupes il diffère du règlement — surtout en Euro RX, où des catégories à 15
engagés passent en demi-finales directes (12 places) au lieu des 24 places de
quarts prévues au règlement. Le nombre de places est une donnée de **format**,
connue avant le meeting, pas un résultat : l'utiliser est légitime, et lui
substituer la valeur du règlement serait faux plutôt que prudent. Le résidu
tient au cas où un qualifié déclare forfait : le comptage des partants reflète
alors ce forfait, sur une place.

## 5. Le modèle de performance

Une place n'est pas additionnable : être 5e sur 30 et 5e sur 8 ne dit pas la
même chose. Chaque résultat est donc converti en **force latente** :

```
u = (place − 0,5) / engagés          z = Φ⁻¹(u)
```

`z` vaut 0 au milieu du plateau et reste comparable d'une manche à l'autre.
Une manche simulée tire `z ~ Normale(μ, σ)` ; le classement est l'ordre des `z`.

**Sources**, pondérées par `poids × nombre d'observations` — une source
prioritaire mais vide ne prend donc pas le pas sur une source fournie :
meeting en cours (0,50) > saison en cours (0,30) > même circuit (0,15) >
historique général (0,05).

**Contraction.** Avec huit meetings, une moyenne brute sur trois manches
produirait des distributions bien trop confiantes. Trois contractions
bayésiennes standard sont appliquées, toutes paramétrées dans
`projectionConfig.PERFORMANCE_MODEL` :

* la force : `μ = μ_observé × nEff / (nEff + priorStrength)` ;
* la dispersion : mélange de la dispersion propre et de celle du plateau ;
* le taux d'incident : mélange du taux propre et du taux de plateau.

L'incertitude sur `μ` est **ajoutée** à la variance de tirage : un pilote vu
deux fois reçoit une distribution plus large, pas plus étroite. C'est le
garde-fou demandé contre les distributions trop certaines.

**Chronos.** Chaque manche simulée produit une position ET un chrono, dérivé du
rang final et de l'échelle de temps réellement observée sur la dernière manche
courue. Sans cela, `compareInterimTiebreaker` ne pourrait pas départager les
ex aequo en mode FIA. Les chronos sont strictement croissants avec la position :
aucun classement impossible ne peut sortir du simulateur.

## 6. La règle du « résultat cible », énoncée

Soit `P(k)` la probabilité de qualification quand on impose la place `k` au
pilote, les autres restant simulés. Le gain marginal moyen depuis la victoire :

```
G(k) = ( P(1) − P(k) ) / (k − 1)          pour k ≥ 2
```

Le résultat cible est :

```
T = max { k ≥ 1 : pour tout j de 2 à k, G(j) < τ }
```

`τ` = `TARGET.diminishingReturnPctPerPosition`, **configurable**, 1,0 point de
pourcentage par place par défaut.

* **Pourquoi une moyenne depuis P(1) et non le gain d'une seule place ?** Un
  gain place-à-place issu d'un Monte-Carlo porte du bruit : deux places voisines
  peuvent s'inverser par hasard et la cible sauterait d'une exécution à l'autre.
  Les gains place-à-place restent affichés séparément — c'est cette lecture-là
  que le team veut voir — mais ils ne pilotent pas la cible.
* **Pourquoi une condition sur tout le préfixe ?** Sans elle, un creux
  accidentel loin dans la courbe pourrait satisfaire la condition alors que la
  zone intermédiaire, elle, rapporte beaucoup.

Vérification sur l'exemple de référence : P1 98 %, P5 97,5 %, P6 97 %, P7 96 %,
P8 95 %. `G(8) = (98 − 95)/7 = 0,43 < 1` → **cible P8**.

Trois régimes de formulation, parce que « au-delà de P30 » n'a pas de sens
quand P30 est la dernière place :

* `normal` → « Au-delà de P12, le gain estimé devient faible. »
* `flat` → « La probabilité reste stable quelle que soit la place obtenue. »
* `sensitive` → « La probabilité varie dès la première place gagnée. »

Aucune de ces formulations ne prescrit une conduite de course ; un test vérifie
l'absence des formulations interdites dans toutes les sorties du module.

## 7. Reproductibilité

Toute simulation est reproductible : le générateur est un mulberry32 à graine
explicite, `Math.random` est proscrit dans tout le module (test dédié), et la
graine est remontée dans chaque sortie et affichée dans le panneau « Pourquoi ? ».
Elle est modifiable dans l'interface.

Les scénarios « et si » partagent tous la même graine : les autres pilotes
vivent exactement les mêmes courses d'un scénario à l'autre, si bien que
l'écart entre « P8 » et « P7 » mesure la différence de scénario et non le bruit
de tirage. Sans cela, le calcul du résultat cible réagirait au hasard.

## 8. Ce que le Monte-Carlo apporte concrètement

Exemple réel, Kerlabo / D3, après Q3, seuil à 16 places :

| | #374 Guillerm | #399 Crochard |
|---|---|---|
| Après Q3 | **P16**, 84 pts — au seuil | **P17**, 82 pts — +1 place |
| Table historique (LOT 1) | 75,0 % (12 cas) | 50,0 % (12 cas) |
| Monte-Carlo | **37,4 %** | **65,0 %** |
| Q4 réel | P19 | P7 |
| Classement final | P16 — qualifié de justesse | P15 — qualifié |

La table historique ne connaît que l'écart au seuil : elle place forcément
Guillerm devant Crochard. Le Monte-Carlo les inverse, et il a raison — non par
hasard, mais parce qu'à Kerlabo les deux sont équivalents sur Q1–Q3 (force 0,05
contre 0,09) tandis que leurs saisons les séparent nettement :

```
Crochard, saison : P13 P12 P4 P2 P7 P8 P22 P8 P14 P4 P10 P3   → force −0,30
Guillerm,  saison : P8 P14 P19 P16 P15 P18 P18 P16 P20 P19 P20 P19 → force +0,73
```

C'est exactement ce qu'une table indexée sur le seul classement ne peut pas
voir, et c'est ce que mesure le gain de Brier score du §1.

## 9. Limites à garder en tête

* **Une seule saison.** Le modèle s'appuie sur 8 meetings. La contraction
  compense, mais aucun réglage ne remplace du volume.
* **Calibration médiane fragile.** Voir §2 : les tranches 20–70 % comptent 5 à
  20 cas. Une probabilité affichée à 45 % est à prendre comme un ordre de
  grandeur.
* **Les poids de sources ne sont pas calibrés**, seulement explicables. Ils
  sont isolés dans `projectionConfig` pour être optimisés par backtesting —
  le harnais est en place, l'optimisation ne l'est pas.
* **Le modèle ne prédit pas les forfaits.** C'est délibéré : `qualifiedActual`
  reste un diagnostic, la calibration se fait sur `qualifiedByRule`.
