# LOT 5 — Objectif stratégique en direct

Transformer l'état réel d'une manche en une **consigne transmissible au pilote**,
en quelques secondes, juste avant son départ.

---

## 1. L'erreur que ce module existe pour éviter

Le classement provisoire d'une manche en cours invite à une traduction
immédiate :

> P4 provisoire fait 2:45.988 → « battre 2:45.988 = être P4 ».

**C'est faux.** Les pilotes d'une même série partent ensemble. Notre pilote peut
faire 2:44.000, battre l'ancien P4, et ressortir P6 parce que deux membres de sa
propre série ont fait mieux encore.

Le raisonnement se fait donc toujours au niveau **série entière puis classement
global** : chaque hypothèse simule notre pilote **et** tous les autres pilotes
non encore passés, fusionne avec les chronos réels, et relit le classement
complet de la manche via `buildMqStandings`.

Le chrono n'est jamais qu'une **traduction** d'un objectif de rang.

### Mesuré sur données réelles

Kerlabo D3, manche 4, 4 séries courues, pilote #316 Audau (P15, 85 pts, seuil 16) :

```
CIBLE : être P10 au provisoire ou mieux → battre 2:31.488
MENACE DES COÉQUIPIERS DE SÉRIE sur cette cible :
  #311 Eveno        bat ce chrono dans 90 % des simulations
  #376 Le Ferrand   bat ce chrono dans 80 %
  #393 Coue         bat ce chrono dans 76 %
  #399 Crochard     bat ce chrono dans 62 %
```

Quatre coéquipiers sur quatre battent probablement la référence. Une lecture
naïve du classement provisoire aurait annoncé « P10 assuré ».

---

## 2. Composition des séries

L'appartenance à une série n'est enregistrée **que sur les résultats**, donc
seulement pour les pilotes déjà passés (`sessionParticipants` ne porte pas de
champ `serie` — vérifié : 0 / 5 680).

Trois régimes, du plus sûr au moins sûr :

| Régime | Quand | Fiabilité |
|---|---|---|
| **Lue** | pilote déjà passé | certaine |
| **Certaine par capacité** | tous les restants tiennent dans une seule série incomplète | certaine |
| **Déduite** | sinon | 98,9 % des pilotes, 91,7 % des manches |

La déduction reprend la règle de l'application : l'ordre de passage est
l'inverse du classement de la manche précédente, découpé par
`computeSeriesSizes()`. Les appartenances enregistrées sont placées **d'abord**
et ne sont jamais déplacées ; les pilotes restants remplissent les places encore
libres. Sans cette contrainte, un pilote déduit atterrissait dans une série déjà
complète et produisait des tailles impossibles.

Toute série déduite est marquée comme telle à l'écran.

### Les séries ne sont pas tirées au sort

| Série | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Rang moyen en Q3 de ses pilotes | 17,9 | 14,1 | 9,4 | 7,3 | 4,9 | 3,0 |

Les premiers passés sont **les plus lents du plateau, par construction** — sur
30 manches réelles. C'est ce qui rendait l'ancienne estimation d'échelle de temps
biaisée (voir LOT 4 §6) et ce qui justifie de ne jamais lire un rang provisoire
comme un quantile du plateau.

---

## 3. Forçage par chrono

Nouveau primitif : `forced: { manche: { pilote: { ms } } }`.

Pendant une manche en cours, **une place forcée est ambiguë** — une position n'a
de sens qu'une fois la manche finie — alors qu'un chrono ne l'est pas. Le chrono
imposé se comporte exactement comme un résultat réel : il ancre le classement et
n'est jamais déplacé.

Il reste refusé pour un pilote ayant déjà couru : une donnée acquise est
immuable, et le moteur lève plutôt que d'ignorer silencieusement le scénario.

Aucune prédiction de chrono n'est faite : le forçage sert uniquement à poser une
hypothèse (« si je fais 2:44.500 ») ou à traduire un objectif de rang.

---

## 4. Trois natures d'énoncé

| Nature | Condition | Formulation |
|---|---|---|
| **CERTAINE** | tous les chronos qui décident de la position sont connus | « Battre 2:45.988 garantit actuellement au moins P4. » |
| **MATHÉMATIQUE** | vrai quels que soient les résultats restants | « Battre 2:26.726 rend la qualification acquise. » |
| **PROBABILISTE** | d'autres pilotes doivent encore rouler | « Battre 2:45.988 donne 72 % d'être P4 ou mieux. » |

Une cible n'est annoncée **exacte** que si plus aucun autre pilote ne doit
rouler — coéquipiers de série compris.

### La cible mathématique

Sans aucune simulation. Si notre pilote a `k` pilotes réels devant lui, sa pire
position finale dans la manche est `k + 1 + (pilotes restants)`. On en déduit son
total minimum garanti, puis on compte les adversaires pouvant encore le dépasser
en créditant chacun de **son meilleur résultat possible**. Une conclusion
« acquis » est donc valide à coup sûr.

Le balayage va du **plus permissif au plus exigeant** : annoncer « bats tout le
monde » à un pilote déjà tranquille serait une consigne fausse. Ce point avait
été identifié comme piège avant l'implémentation, et il est couvert par un test.

---

## 5. Concurrents directs — mesurés, jamais supposés

Deux étapes, pour ne pas payer une simulation complète par adversaire :

1. **Crible, gratuit** — sur la passe de base déjà calculée : un adversaire qui
   finit *toujours* devant, ou *jamais*, ne fait basculer aucune qualification.
   On garde les 8 plus incertains.
2. **Mesure causale** sur ces 8 seulement — amplitude entre « il réussit au
   mieux » et « il abandonne », à tirages identiques. C'est un effet, pas une
   corrélation.

Un adversaire déjà passé n'est plus une variable : son impact est nul par
construction, et il est affiché comme « résultat acquis ».

**La proximité au classement n'entre nulle part**, et ce n'est pas un détail —
sur Kerlabo D3 l'ordre d'impact est P12, P11, P7… alors que le pilote analysé est
P15. Une heuristique de voisinage aurait désigné les mauvais pilotes.

Seuil d'affichage : **2 points de probabilité**, valeur initiale configurable
(`STRATEGY.directRivalMinImpact`). L'impact réel de chaque adversaire reste
listé dans le détail, quel que soit ce seuil.

---

## 6. Quatre situations, quatre consignes

| Mode | Déclenché quand | Affiché |
|---|---|---|
| `settled` | verdict mathématique acquis | « QUALIFICATION MATHÉMATIQUEMENT ACQUISE — aucun objectif nécessaire » |
| `comfortable` | P ≥ 95 %, ou même le pire résultat suffit | « SITUATION CONFORTABLE — large plage de résultats compatible » |
| `dependent` | même le meilleur résultat donne < 90 % | « DÉPENDANCE AUX CONCURRENTS — aucun résultat ne suffit seul » |
| `target` | cas normal | une cible de rang, traduite en chrono |
| `afterRun` | notre pilote a déjà couru | la lecture s'inverse : que doivent faire les autres ? |

L'échelle de cibles est balayée sur **tout** le classement provisoire, puis
**affinée autour de la bascule**. Un balayage limité à la tête afficherait dix
fois « 100 % » et ne dirait rien ; l'affinage ne coûte que quelques évaluations
supplémentaires, sur le seul intervalle utile.

Exemple réel — la frontière est parfois d'une seule place :

```
P10  → battre 2:31.488 → 100 %   (total final médian 112 pts)
P11  → battre 2:31.538 →  42 %   (total final médian 111 pts)
```

50 millisecondes. Vérifié : le seuil de qualification médian est de 111 points,
la qualification se joue donc littéralement sur un point. Ce n'est pas un
artefact — c'est l'information que le team cherche.

---

## 7. Interface — trois niveaux séparés

1. **CERTITUDES** (vert) — démontré, aucun tirage.
2. **OBJECTIF PILOTE** (violet) — une cible, un chrono, un pourcentage. Lisible
   en quelques secondes, à la radio. Rien d'autre.
3. **ANALYSE** (bleu / orange) — Monte-Carlo, historique, matrice, distributions.

Le bandeau objectif affiche la probabilité **si l'objectif est atteint**, et
juste en dessous la comparaison utile : sans cette cible, et une place derrière.
Une consigne dont le manquement ne change rien n'en est pas une.

L'avertissement coéquipiers apparaît dès qu'un membre de la série a plus de 25 %
de chances de battre la référence.

---

## 8. Validation

`sh tools/valider.sh` enchaîne toute la passe et s'arrête au premier échec.

| Contrôle | Résultat |
|---|---|
| Tests unitaires | **824**, 24 fichiers |
| Non-régression Classements / Championnat / Chronométrage | **5 429 lignes pilote, 0 différence** |
| Statuts DNF / DNS / DSQ / DSQ_RACE | 72 comparaisons réel/simulé, **0 écart** |
| Replay de tous les meetings réels | 30 meetings, 100 étapes, 200 objectifs, **0 invariant violé** |
| Smoke application | 19/19 |
| Smoke projection | 44/44 |
| Smoke manche en cours + objectif | 20/20 |

### Les dix invariants du replay

Contrôlés à chaque étape de chaque manche, sur les 30 meetings terminés :

1. un meeting en cours n'est jamais considéré comme terminé ;
2. il ne produit aucune observation historique ;
3. la baseline historique est inchangée en sa présence ;
4. aucun point de la manche en cours n'entre au classement du checkpoint ;
5. les séries couvrent le plateau sans doublon ni dépassement de taille ;
6. la position finale **réelle** de chaque pilote tombe dans les bornes annoncées ;
7. aucun énoncé du bloc CERTITUDES ne contient de vocabulaire probabiliste ;
8. un verdict mathématique n'est jamais démenti par la simulation ;
9. un scénario visant un résultat acquis est refusé ;
10. la cible mathématique, vérifiée par simulation, donne bien 100 %.

> Un invariant a été corrigé en cours de route : comparer `mqCount` entre pilotes
> était faux, ce compteur n'étant pas incrémenté pour un DNS ou un DSQ. Le
> contrôle porte désormais sur la seule propriété qui compte — la manche en cours
> n'a distribué de points à personne.

---

## 9. Fichiers

**Nouveaux**
- `js/projection/liveStrategy.js`
- `tests/liveStrategy.test.js` (19)
- `tools/qualification-audit/14-objectif.mjs` — objectif sur un meeting réel
- `tools/qualification-audit/15-replay.mjs` — replay et invariants
- `tools/qualification-audit/16-non-regression.{sh,mjs}` — ancien vs nouveau code
- `tools/valider.sh` — passe de validation complète

**Modifiés**
- `js/projection/scenarioSimulator.js` — forçage par chrono, `trackRaceOutcome`, `aheadOfIds`
- `js/projection/projectionConfig.js` — bloc `STRATEGY`, messages de l'objectif
- `js/projectionStats.js`, `css/modules/projection.css` — bloc OBJECTIF PILOTE
- `tools/smoke/liveRaceSmoke.mjs` — 20 vérifications
- `sw.js` (cache `rx-chrono-v37`), `tests/moduleGraph.test.js`
- `docs/qualification-projection/ANTI-DOUBLONS.md` — procédure de déploiement
