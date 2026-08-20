# LOT 6 — Accès et écran opérationnel

Faire de la stratégie un **outil de bord de piste**, distinct des statistiques
historiques.

---

## 1. Ce qui existait sur `main`

| Élément | État avant |
|---|---|
| Entrée de menu | **oui** — `📐 Projection de qualification`, dans le groupe Compétition, entre « Stats des départs » et « Mode Spectateur » |
| Tuile d'accueil | **non** — aucune tuile ne pointait vers cette vue |
| Vue | `#view-projection`, remplie par `js/projectionStats.js` |
| Onglet par défaut | `En situation` — sélecteurs, historique, Monte-Carlo, what-if, matrice, tout au même niveau |

Une seule entrée existait donc, et elle ne créait pas de doublon avec quoi que
ce soit. Elle a été **renommée**, pas dupliquée. La tuile d'accueil est
réellement nouvelle : il n'y en avait aucune.

---

## 2. Ce qui change

### Accès

- menu : `🎯 Stratégie Live`
- accueil : nouvelle tuile `🎯 Stratégie Live`, placée avant `Statistiques`
- titre de vue : `🎯 Stratégie Live`

Le nom dit quand ouvrir l'écran. Les statistiques historiques restent où elles
étaient, sous `📊 Statistiques` et `📈 Stats des départs`.

### Cinq onglets, un seul opérationnel

| Onglet | Rôle |
|---|---|
| **🎯 Stratégie** *(par défaut)* | la consigne, et rien d'autre |
| Analyse détaillée | Monte-Carlo, what-if, matrice, adversaires |
| Historique | courbes et taux comparables |
| Backtest | mesure de fiabilité du moteur |
| Qualité des données | couverture, divergences, anti-doublons |

L'écran opérationnel renvoie explicitement vers les trois autres par des boutons,
pour que le second niveau reste atteignable sans être imposé.

---

## 3. L'écran opérationnel

Deux sélecteurs seulement — meeting et pilote. Le checkpoint n'y figure pas :
il est **toujours** la dernière manche terminée, parce qu'en bord de piste il
n'y a pas d'autre question. Le sélecteur de checkpoint reste sur l'onglet
d'analyse, pour rejouer une situation passée.

L'objectif se calcule **automatiquement** à la sélection du pilote. Demander un
clic supplémentaire n'aurait aucun sens dans l'usage visé.

### Ordre de lecture

```
STRATÉGIE Q4 — #374 Guillerm
P16 intermédiaire · 84 pts · seuil P16 · au seuil · Q4 EN COURS — 15/30 résultats

  SENSIBLE

  OBJECTIF              🎯 P5 au provisoire ou mieux
  RÉFÉRENCE ACTUELLE    ⏱ battre 2:30.630          81,1 %  si l'objectif est atteint

  Sans cette cible : 47,1 %  ·  une place derrière : 75,6 %

  ⚠️ Faire mieux que 2:30.630 ne garantit pas cette place : 4 concurrents
     de votre série ont une probabilité importante de battre cette référence.

  ⚠️ DNF → 0,0 % de qualification

  CHEMINS POSSIBLES
    P5 au provisoire ou mieux — 81,1 %
    P3 au provisoire ou mieux — 92,4 %
    Si #316 Audau ne termine pas la manche — 76,1 %

  ▸ Série 4 — 4 coéquipiers encore à courir
  ▸ Pourquoi ? — échelle de cibles et concurrents directs

CERTITUDES — VRAI QUOI QU'IL ARRIVE DANS CETTE MANCHE
  Position provisoire · Meilleure position possible · Pire position théorique · Points

[ Analyse détaillée ]  [ Historique comparable ]  [ Qualité des données ]

Classement intermédiaire au checkpoint
```

Capture réelle : `tools/smoke/shots/strategie-haut.png`, produite par
`node tools/smoke/captureStrategie.mjs`. Les données sont réelles ; seule la
dernière manche est tronquée à la volée pour reproduire le direct.

### La logique s'inverse après le passage

Le même écran, sans réglage, bascule sur l'autre question :

```
  RÉSULTAT ACQUIS

  ✅ Résultat Q4 acquis — P10 provisoire
  ⏱ 2:31.488                              69,1 %  qualification projetée

  10 pilotes restent à courir. La question n'est plus « que dois-je faire ? »
  mais « que doivent faire les autres ? ».

  QUI PEUT ENCORE LE FAIRE BASCULER
    #393 Coue Cyril        97,3 %
    #399 Crochard Aurelien 61,0 %
    #316 Audau Mathis      51,3 %
```

Et quand c'est démontrable, une phrase de certitude s'ajoute :

> Il faudrait qu'au moins 6 des 10 pilotes restants battent son chrono pour que
> sa qualification ne soit plus acquise.

ou, à l'autre extrême :

> Même si tous les 10 pilotes restants battent son chrono, il reste dans la zone
> qualificative.

Quand aucune des deux ne se démontre, l'écran le dit — plutôt que d'afficher une
approximation dans un bloc qui promet des certitudes.

---

## 4. Hors direct : préparer la manche suivante

La même entrée sert après Q1, Q2 ou Q3. Sans chrono réel, aucune référence
n'existe : l'échelle porte alors sur des **places**, pas sur un chrono.

```
STRATÉGIE Q4 — #374 Guillerm
P16 intermédiaire · 84 pts · seuil P16 · Q4 à venir

  SENSIBLE
  OBJECTIF   🎯 P14 de la manche ou mieux        81,7 %
  Sans cette cible : 37,3 %  ·  une place derrière : 74,7 %
  ⚠️ DNF → 0,0 % de qualification
```

Proposer « battre 2:30.630 » ici serait inventer une référence qui n'existe pas.

---

## 5. Ce qui n'a pas bougé

Les moteurs validés au LOT 5 sont inchangés dans leur logique. Trois ajouts,
tous nécessaires à l'affichage demandé et couverts par des tests :

- `candidateTargets` produit une échelle de **places** quand la manche n'a pas
  commencé — sans quoi l'écran serait vide hors direct ;
- `resilienceAfterRun()` — « combien de pilotes restants devraient le battre »,
  un encadrement, sans aucun tirage ;
- le risque d'incident (`DNF`) est chiffré dans l'objectif, souvent la seule
  chose utile à transmettre à un pilote confortable.

La règle validée au LOT 5 reste entière : **une cible chrono ne vaut jamais une
position acquise tant que des pilotes de la même série doivent rouler.**
L'avertissement s'affiche dès qu'un coéquipier a plus de 25 % de chances de
battre la référence, et l'objectif continue d'être calculé sur la série
complète puis le classement global.

---

## 6. Corrections de lisibilité relevées à la capture

Quatre défauts que seul un rendu réel révèle :

1. **Double titre** — la bande « Interprétation stratégique » précédait un titre
   « Objectif pilote » disant presque la même chose. L'objectif a désormais sa
   bande propre.
2. **Titre répété** dans le bloc CERTITUDES, bande et titre étant identiques.
3. **Classement courant étiqueté « données historiques »** — il s'agit de l'état
   du meeting en cours. Bande neutre désormais.
4. **Situation absente après le passage du pilote** — le mot qualifiant la
   situation ne s'affichait qu'avant. Il est maintenant présent dans les deux
   cas, avec le même vocabulaire.

---

## 7. Validation

| Contrôle | Résultat |
|---|---|
| Tests unitaires | **829** |
| Smoke application | 19/19 |
| Smoke projection | 46/46 |
| Smoke manche en cours + objectif | 23/23 |
| Non-régression cœur applicatif | 5 429 lignes, 0 différence |
| Replay 30 meetings | 0 invariant violé |

Deux vérifications d'accès ont été ajoutées au smoke : l'entrée de menu porte
bien le nouveau nom, et la tuile d'accueil existe **en un seul exemplaire** —
c'est ce qui empêchera un doublon d'apparaître plus tard.

Cache service worker : `rx-chrono-v38`.
