# Module « Analyse des départs » — Analyse du projet et architecture d'intégration

> Document d'architecture. **Aucun code applicatif n'est écrit à ce stade.**
> Source de vérité : le dépôt `maxime35370/rallycross-v2` inspecté sur la branche `main`
> (commit `75d641d`).
>
> **Révision 2** — correction majeure de granularité : une manche qualificative contient
> **plusieurs départs physiques** (une série = un départ), alors qu'elle ne possède qu'un seul
> timecode vidéo, qui pointe le début de la **première** série. Sections refondues : §1.3, §1.4,
> **§1.5 (nouvelle)**, §2.2, §2.3, §4.7, §4.8, **§4.9 et §4.10 (nouvelles)**, §5 (phases 1–3),
> §6, §7. La sémantique de `videoTimecodes` n'est **plus** modifiée par cette proposition.
>
> **Révision 3** — conventions tranchées (§4.10 : couloirs physiques fixes, `laneZone` sur
> `trackLanes`, *renommé `gridLanes` en révision 4* ; abandon avant V1 → `turn1Pos = null` et
> départ conservé) et **correction de deux
> chiffres erronés** : le seuil de rentabilité de l'automatisation (§3.1, faux d'un facteur ~10) et
> le multiplicateur de volume (§4.8, « ×9 » annoncé sans dénominateur défini, et `S = 6` traité à
> tort comme une constante). Ajout de l'indicateur de couverture vidéo, facteur réellement
> limitant.
>
> **Révision 4** — distinction explicite entre **position sportive** (`gridPos`) et **position
> physique** (`gridRow` + `lane`), et clarification des sources de vérité : la géométrie de grille
> des phases finales appartient au **règlement du championnat**, pas au circuit. `trackLanes` est
> renommé `gridLanes` et n'est plus alimenté par `circuits`. Ajout de `gridLayoutKey` pour ne
> jamais comparer des couloirs de géométries différentes, des quatre axes statistiques
> indépendants (§4.8) et de l'algorithme exact de placement sur la grille (§4.7).
>
> **Révision 5** — **révision majeure des phases 3 à 6** après vérification empirique du moteur de
> tracking (voir `TRACKING-EVALUATION.md`, chiffres mesurés) : sur de la vidéo de retransmission,
> CSRT ne convient pas, la ligne virtuelle à coordonnées fixes est invalide dès que la caméra
> bouge, et la voie semi-automatique coûte autant de clics qu'elle en économise. La **saisie
> manuelle assistée devient le chemin principal et permanent**, la détection automatique est
> repoussée derrière un POC séparé et conditionnée à une source vidéo à caméra fixe. Les phases 1
> et 2 et le modèle de données sont **inchangés**.
>
> **Révision 6** — **l'automatisation est réhabilitée**, sous une architecture différente de celle
> écartée en révision 5 : **YOLO + tracking + ReID en ensemble fermé, intégrés dans l'application**
> (et non CSRT + ré-ancrage via un outil séparé). Mesuré : 86 % d'identifications automatiques
> correctes après coupure, **0 erreur silencieuse**. Architecture retenue : **tout dans le
> navigateur** (ONNX Runtime Web), l'application reste statique et sans build. Voir
> `AUTOMATION-ARCHITECTURE.md`. Le service Python local est **écarté**, l'enveloppe Tauri reste une
> option future sans coût d'attente. Les phases 1 à 3 et le modèle de données restent inchangés.
>
> **Révision 7** — `circuits.firstTurnSide` **retiré** : le sens du premier virage existe déjà en
> base sous `meeting.poleSide`, et `standings.js` établit que **le couloir 1 est toujours du côté du
> premier virage**, donc à l'intérieur. `laneZone(lane, gridLanes)` n'a besoin d'aucune orientation,
> et **n'est plus stocké** : seul le couloir brut l'est, le regroupement se fait à l'affichage.

---

## 1. Ce que le projet est réellement aujourd'hui

### 1.1 Architecture globale

| Aspect | Réalité constatée |
|---|---|
| Type | **PWA 100 % statique** — aucun backend, aucun serveur applicatif |
| Frontend | HTML + CSS + **JavaScript vanilla en modules ES**, sans framework |
| Build | **Aucun** (pas de bundler, pas de transpilation, pas d'étape de build) |
| Backend | **Firestore uniquement**, SDK chargé en `import()` dynamique depuis `gstatic.com` |
| Auth | Firebase Auth (email/mot de passe + anonyme pour les pronostics spectateurs) |
| Hébergement | Netlify (`rxchrono.netlify.app`) + compatibilité GitHub Pages (`.nojekyll`, détection du sous-dossier `/rallycross-v2/`) |
| Offline | `sw.js` — service worker avec **liste d'assets explicite** (`CACHE_NAME = 'rx-chrono-v26'`) |
| Cloud Functions | **Aucune** (pas de `functions/`, pas de `firebase.json`, pas de `.firebaserc`) |
| Règles Firestore | `firestore.rules` versionné, collé manuellement dans la console |
| Index Firestore | **Aucun fichier d'index** → le code évite volontairement les index composites |
| Tests | **Vitest**, environnement `node`, 164 assertions sur 3 fichiers (`calc`, `utils`, `itsLive`) |
| Dépendances npm | **Aucune en runtime.** `vitest` en `devDependency`, c'est tout. |

Deux conséquences structurantes pour la suite :

1. **Il n'y a pas d'endroit « serveur » où faire tourner du Python.** L'application est un
   paquet de fichiers statiques. Tout moteur d'analyse sera nécessairement **local à ta
   machine**, jamais dans le chemin d'exécution de l'application.
2. **Le coût d'ajout d'une vue est très faible et parfaitement balisé** (voir §1.2). On peut
   greffer le module sans toucher une ligne de l'existant.

### 1.2 Organisation des modules JS et pattern de vue

`js/app.js` est le routeur. Ajouter une vue = 6 points d'insertion, tous additifs :

1. une entrée dans `VIEW_TITLES` (`js/app.js`) ;
2. un `<li><a class="menu-item" data-view="…">` dans le drawer (`index.html`) ;
3. un `<div class="view" id="view-…">` dans `<main>` (`index.html`) ;
4. un module `js/monModule.js` exportant `initX()` qui s'abonne à l'événement `viewchange` ;
5. un `safeInit(initX, 'x')` dans `loadApp()` (`js/app.js`) ;
6. un `css/modules/monModule.css` + son `<link>` + son entrée dans `ASSET_PATHS` de `sw.js`.

Conventions maison à respecter :

- **Séparation calcul / rendu.** La logique métier pure vit dans `js/calc.js` et est testée
  (`tests/calc.test.js`). Les modules de vue font le DOM et Firestore. → Toute la statistique
  du nouveau module doit aller dans un module **pur et testé**.
- **Pas d'index composite.** `js/stats.js` le dit explicitement : on requête sur 1–2 champs
  puis on filtre côté client (`// Filtrer par championnat cote client (evite un index composite Firestore)`).
- **IDs déterministes.** `sessionParticipants` et `results` utilisent `${sessionId}_${driverId}`
  avec `setDoc(..., {merge:true})` — un choix explicite contre les doublons en cas de
  concurrence. À reproduire.
- **Dénormalisation systématique.** Chaque document porte `meetingId`, `category`, `year`,
  parfois `championshipId` — précisément pour permettre des requêtes plates sans jointure.
- **Écriture protégée** par `requireAuth()` côté client + `isRegie()` côté règles, et journalisée
  via `logAudit()`.

### 1.3 Schéma Firestore existant

| Collection | Champs utiles pour nous |
|---|---|
| `championships` | `name`, `year`, `regulation`, `isActive`, `categories[]`, **`sessionConfig`**, `pointsScale`, `statusRules`, `competitionPhases`, `meetingClassificationMode` |
| `meetings` | `date`, **`location`** (circuit, texte libre), `year`, `categories[]`, `nbMQ`, `championshipId`, **`videos[]`**, **`videoTimecodes{}`** |
| `sessions` | `meetingId`, `category`, `year`, `type` ∈ `EC\|MQ\|QF\|DF\|FIN`, `num` |
| `engagements` | `meetingId`, `driverId`, `category`, `year`, `carNumber` |
| `sessionParticipants` | id `${sessionId}_${driverId}` · `sessionId`, `meetingId`, `category`, `year`, `driverId`, `carNumber`, `firstName`, `lastName` |
| `results` | id `${sessionId}_${driverId}` · `sessionId`, `meetingId`, `category`, `year`, `sessionType`, `driverId`, `carNumber`, `ms`, `status`, `manualPosition`, **`serie`**, **`couloir`** |
| `drivers`, `persons` | identité pilote (dissociée : `persons` = personne, `drivers` = engagement d'une personne dans une catégorie/année) |
| `interimStandings`, `meetingStandings`, `championshipStandings`, `championshipPenalties` | classements calculés |
| `auditLog`, `reglements`, `obsControl`, `pronostics`, `pronoScores`, `players` | annexes |

**Le point le plus important de toute cette analyse** — la géométrie de grille existe déjà,
dans le règlement du championnat :

```js
// js/settings.js — DEFAULT_CHAMP.sessionConfig
DF: { count: 2, laps: 6, gridSize: 8,
      gridLayout: { lanes: 5, rows: 3,
                    positions: { '0-0':1, '0-2':2, '0-4':3,
                                 '1-1':4, '1-3':5,
                                 '2-0':6, '2-2':7, '2-4':8 } } }
```

`positions` mappe `"ligne-colonne"` → numéro de position sur la grille. Donc **le couloir est
déductible de la position de grille par pure arithmétique**, par championnat et par type de
session, sans rien saisir. Il y a même un éditeur de grille visuel dans `settings.js`
(`renderGridEditor`, lignes × couloirs libres).

Et pour les manches qualificatives, `results.serie` / `results.couloir` sont **déjà stockés et
déjà exploités** : `js/importTimes.js` les pré-remplit depuis les grilles officielles importées,
et `js/standings.js` trace déjà un nuage de points « temps par couloir / série »
(`renderMqCouloirGraph`).

**Une série = une seule ligne de N voitures côte à côte**, donc au sein d'une série
`position de grille ≡ couloir`. Mais une **manche** contient plusieurs séries — voir §1.5, qui
est le point le plus structurant du modèle de données.

### 1.5 ⚠️ Un « départ physique » n'est pas une « session »

C'est **la** subtilité du modèle, et elle change la granularité de tout le module.

**Manches qualificatives.** Une session MQ contient *tous* les pilotes de la catégorie, répartis
en séries. La structure des séries n'est **stockée nulle part** : elle est recalculée à la volée
par `getSeriesStructure(nbParticipants)` (`js/timing.js`) via `computeSeriesSizes()`, en fonction
de `maxPerSeries` de la catégorie et de `seriesDistributionMode` du championnat. L'affectation
réelle, elle, vit **par pilote** dans `results.serie` + `results.couloir`.

Conséquence : **les séries n'ont pas toutes la même taille.** En mode `ffsa`, 26 pilotes avec
`maxPerSeries: 5` donnent `[3, 3, 5, 5, 5, 5]` — six départs physiques, dont deux à 3 voitures.
Le `couloir` est borné par la taille de *sa* série (`validateMeta`).

**Phases finales.** Vérification faite dans `sessions.js` / `competition.js` : QF1…QF4 et DF1…DF2
sont des **documents `sessions` distincts** (`type` + `num`), chacun avec ses propres
`sessionParticipants` (`distributeIntoQF`, `distributeIntoDF`, `gridSize`). Pour QF / DF / FIN,
**1 session = 1 grille = 1 départ physique**. Seules les MQ sont multi-départs.

| Phase | Représentation V2 | Départs physiques par session |
|---|---|---|
| EC | 1 session | *aucun* (essais chronométrés, pas de départ en grille) |
| **MQ** | 1 session / (manche × catégorie), séries dans `results.serie` | **N séries → N départs** |
| QF | 1 session par QF (`num` 1..4) | 1 |
| DF | 1 session par DF (`num` 1..2) | 1 |
| FIN | 1 session | 1 |

**Principe directeur retenu : une `startAnalysis` = un départ physique réel**, jamais une
session. L'identifiant, la récupération des pilotes, le timecode, la géométrie de grille et
l'unité statistique en découlent tous (§4.7, §4.8).

Ordre de grandeur, et c'est une excellente nouvelle : 4 manches × 6 séries = **24 départs
exploitables par catégorie et par meeting**, contre 3 seulement (2 DF + 1 FIN) si l'on
raisonnait par session. Les MQ sont donc, et de loin, la principale source de données — et ce
sont aussi celles dont les couloirs sont attribués par tirage réglementaire (§4.8).

### 1.4 État des données : qu'est-ce qui manque vraiment ?

| Donnée voulue | Déjà disponible ? | Où / comment |
|---|---|---|
| Championnat | ✅ | `championships` + `meeting.championshipId` |
| Saison | ✅ | `year`, dénormalisé sur presque tous les documents |
| Circuit | ⚠️ | `meeting.location` — **texte libre, à normaliser** |
| Catégorie | ✅ | `category`, dénormalisé partout |
| Session | ✅ | `sessions` (`type` + `num`) |
| **Départ physique** | ⚠️ | déductible, mais **n'est pas une entité** : pour les MQ il faut regrouper `results` par `serie` (§1.5) |
| Format / règlement | ✅ | `championships.sessionConfig` + `competitionPhases` |
| Pilotes engagés | ✅ | `engagements`, `sessionParticipants` |
| Composition d'une série MQ | ✅ | `results` filtrés sur `sessionId` + `serie` |
| Couloir MQ | ✅ | `results.couloir` (borné par la taille de *sa* série) |
| Taille / nb de séries d'une manche | ⚠️ | **recalculé à la volée** (`getSeriesStructure`), jamais persisté |
| Géométrie de grille (lignes × couloirs) | ✅ | `sessionConfig.{QF,DF,FIN}.gridLayout` |
| Grille QF/DF/FIN par pilote | ⚠️ | **calculée à la volée** dans `sessions.js` depuis la cascade de qualification, **jamais persistée** |
| Position finale QF/DF/FIN | ✅ | **calculée à la volée** par `calcPhaseStandings()` (`standings.js`) : tri par `ms` croissant, puis DNF classés via `manualPosition`, puis DSQ/DNS |
| Position finale MQ | ⚠️ | `calcMqStandings()` classe **toute la manche** (1..30), pas la série → le rang *au sein du départ* est à recalculer (§4.7) |
| Vidéo + timecode | ⚠️ | `meeting.videos[]` + `meeting.videoTimecodes{}`, mais **1 seul timecode par (session × catégorie)** = début de la **1ʳᵉ série** seulement (§2.2) |
| **Position à la sortie du premier virage** | ❌ | donnée réellement absente |
| **Timecode de départ des séries 2..N** | ❌ | donnée réellement absente |

Il manque donc **cinq** choses, dont une seule est difficile :

1. **L'ordre à la sortie du virage 1** → nouvelle donnée à produire (§4). *La seule difficile.*
2. **Les timecodes de départ des séries 2..N d'une manche** → saisie humaine pendant la
   navigation vidéo, très rapide (§2.3, §4.9).
3. **La grille QF/DF/FIN persistée** → aujourd'hui affichée puis perdue ; à figer au moment de
   l'analyse pour que la statistique soit reproductible.
4. **Le rang d'arrivée au sein d'un départ MQ** → recalculable depuis `results.ms` des seuls
   pilotes de la série, à figer lui aussi.
5. **La normalisation des circuits** → `location` est du texte libre ; « Lohéac », «Loheac»,
   « LOHÉAC » scinderaient les statistiques en trois. Indispensable dès la phase 1 puisque tu
   veux comparer les circuits.

---

## 2. `videoTimecodes.js` — analyse détaillée

Tu demandes explicitement s'il faut l'étendre ou faire un second système. Voici le détail.

### 2.1 Ce qu'il fait aujourd'hui

Une **modale d'édition en masse**, ouverte depuis la vue Meetings, qui gère deux choses au
niveau du **meeting** :

1. **Une liste de vidéos YouTube** : `meeting.videos = [{ id, label, url }]` — typiquement une
   par jour de meeting (« Samedi », « Dimanche »). `id` est un `uid()` interne, l'ID YouTube
   réel étant extrait de l'URL par `extractYoutubeId()`.
2. **Un timecode par case (session × catégorie)** :
   `meeting.videoTimecodes[key] = { videoId, seconds }`, où
   `key = timecodeKey(sessionType, sessionNum, category)` (`js/utils.js`).

L'UI est un **tableau catégories × sessions** (EC, MQ1…MQn, QF1…, DF1…, FIN), construit
dynamiquement depuis `sessionConfig` du championnat actif, avec un select vidéo + un champ
timecode par case, plus deux facilités bien pensées : coller une URL YouTube `?t=` remplit
automatiquement le timecode **et** sélectionne la bonne vidéo (`extractYoutubeTimecode`), et un
bouton « appliquer aux cases vides ».

Ces timecodes alimentent le bouton « ▶ Voir la course » de la vue Chronométrage.

### 2.2 Réponses à tes questions

| Question | Réponse |
|---|---|
| Notion de vidéo existante ? | **Oui**, mais **YouTube uniquement**, au niveau **meeting** |
| Granularité ? | Une entrée par (type de session, numéro, catégorie). **Ce n'est PAS la granularité d'un départ** : pour une MQ à 6 séries, il n'y a qu'une seule case pour 6 départs physiques |
| Sémantique du timecode ? | **Le début de la 1ʳᵉ série de la catégorie pour cette manche** — donc l'ancrage de la *première* grille, et un point d'entrée pour retrouver les suivantes |
| Timecodes des séries 2..N ? | **Inexistants** dans le système actuel |
| Données stockées | Sur le document `meetings` : `videos[]` et `videoTimecodes{}` |
| Interface réutilisable ? | **Non**, mais le modèle reste le bon point d'entrée |

⚠️ **Correction d'une erreur d'une version antérieure de ce document**, qui affirmait que
`videoTimecodes` avait « exactement la granularité d'une course ». C'est vrai pour QF / DF / FIN
(1 session = 1 grille), **faux pour les MQ** (1 session = N séries = N départs, 1 seul timecode).
Toute la §4.7 et la §4.8 découlent de cette correction.

### 2.3 Recommandation : **ne pas toucher à la sémantique existante**

Tu demandes explicitement que `videoTimecodes` conserve son sens actuel — c'est aussi la bonne
décision technique, et elle est plus propre que ce que proposait la version précédente :

- **`videoTimecodes[key].seconds` garde exactement son sens** : début du bloc de séries de la
  catégorie pour cette manche. Zéro modification de `videoTimecodes.js`, zéro risque de
  régression sur le bouton « ▶ Voir la course ».
- **Les repères fins du module d'analyse vivent dans `startAnalyses`**, un par départ physique
  (`video.startSeconds`, `video.turn1Seconds`). Ils sont *utilisés par* le nouveau module, pas
  partagés avec l'ancien.
- **Le timecode existant sert d'amorce** : pour la série 1, `startSeconds` est pré-rempli depuis
  `videoTimecodes[MQn|catégorie].seconds`. Pour les séries suivantes, voir la stratégie de
  pré-remplissage progressif en §4.9.

Un seul ajout au document `meetings`, indépendant de `videoTimecodes` :

```js
// meeting.localVideos[] — AJOUT : descripteurs de fichiers locaux, JAMAIS le fichier
[{ id:"lv3", label:"Finale Supercar", fileName:"loheac-2026-fin-sc.mp4",
   size:184320512, durationMs:612000, fps:50, fingerprint:"a91c…" }]
```

**Bénéfice de ce choix** : le point de vigilance de non-régression identifié précédemment
(`saveAll()` qui reconstruit `videoTimecodes` en ne gardant que `{videoId, seconds}` et
effacerait donc des clés ajoutées) **disparaît complètement**. `videoTimecodes.js` n'est pas
modifié du tout.

**Ne pas réutiliser l'interface** non plus : `videoTimecodes.js` est un *éditeur de masse*
(remplir 60 timecodes vite), alors que l'analyse de départ est un *poste de travail sur un
départ* (lecteur, ligne virtuelle, tableau de validation, enchaînement des séries). Deux usages,
deux ergonomies. Les fusionner rendrait les deux moins bons.

**Seul point de contact** : la lecture du timecode d'amorce. Le nouveau module réutilise
`timecodeKey(sessionType, sessionNum, category)` déjà exporté par `js/utils.js` — donc aucun
module partagé supplémentaire à créer, et aucune écriture dans `videoTimecodes`. Le
rapprochement `videos[].id → ID YouTube` passe par `extractYoutubeId()`, également déjà exporté.

---

## 3. La question centrale : a-t-on besoin d'une IA complexe ?

**Non. Et le §1.4 le démontre chiffres en main.**

Le raisonnement :

- La grille est connue (stockée pour les MQ, calculable pour QF/DF/FIN).
- Le couloir est déductible de la grille par arithmétique sur `gridLayout`.
- Le résultat final est déjà calculé par `calcPhaseStandings()`.
- Le timecode d'entrée dans le bloc de séries est déjà saisi pour les manches déjà « timecodées ».

Il ne reste donc à produire **qu'une seule donnée par départ : l'ordre de 3 à 8 voitures à un
seul instant** (plus le timecode du départ pour les séries 2..N d'une manche). Ce n'est pas un problème de vision par ordinateur, c'est **une lecture ordinale
unique**.

### 3.1 Le calcul de rentabilité qu'il faut faire avant de coder du YOLO

| Approche | Travail humain / départ | Coût de développement | Dépendances |
|---|---|---|---|
| Lecture manuelle avec un bon scrubber | **15–30 s** | ~2 jours | aucune |
| OpenCV multi-tracker amorcé par clics | 10–15 s | ~3 jours | `opencv-contrib-python` (~50 Mo) |
| YOLO + ByteTrack + ré-identification | 5–15 s (+ vérification) | ~8–10 jours | `ultralytics` + `torch` (**~2,5 Go**) |

L'automatisation complète fait gagner ~20 s par départ. Le seuil de rentabilité **en temps pur**
se calcule directement :

```
seuil (départs) = heures de développement × 3600 / 20
```

| Développement | Seuil de rentabilité |
|---|---:|
| 1 jour (8 h) | ~1 400 départs |
| 3 jours (24 h) | ~4 300 départs |
| 8–10 jours (64–80 h) | **~11 500 – 14 400 départs** |

⚠️ **Correction (révision 3)** : une version antérieure de ce document annonçait 1 000 à 1 500
départs pour 8–10 jours de développement. C'était faux d'un facteur ~10 — ce chiffre correspond en
réalité à **une seule journée**.

**Conséquence, qui change la conclusion : l'automatisation ne se justifie pas par le gain de temps
de saisie.** À ~14 000 départs, ce seuil ne sera pas atteint (§4.8 : ~216 départs par catégorie et
par saison dans le meilleur cas). Les phases 4–6 doivent donc être justifiées **uniquement** par
les arguments de qualité du §3.2 — objectivité, reproductibilité, mesure de l'erreur humaine — et
jamais par la vitesse.

**Nuance sur la valorisation du temps.** Ce calcul compte une heure de développement au même prix
qu'une heure de saisie. Si le développement est largement délégué et ne coûte que quelques heures
de revue et de test, le seuil retombe vers **~700 départs**, donc atteignable en une saison. Le
seuil dépend donc entièrement de la façon dont le temps de développement est valorisé : il n'y a
pas de chiffre unique, et c'est un arbitrage à faire explicitement avant d'engager les phases 4–6.

**Conclusion : la valeur immédiate est dans les phases 1 à 3, pas dans le YOLO.** Un bon lecteur
avec avance image par image et saisie d'ordre par clic donne une base statistique réelle en
quelques soirées : 200 départs × 25 s ≈ **1 h 20 de saisie**, et un meeting d'une catégorie bien
remplie en fournit déjà 27 (§4.8).

### 3.2 Ce que l'automatisation apporte quand même

Trois choses que le manuel ne donne pas, et qui justifient les phases 4–6 **plus tard** :

1. **La résolution des franchissements quasi simultanés.** Deux voitures à 40 ms d'écart :
   l'œil hésite, l'interpolation sous-image tranche objectivement.
2. **La reproductibilité.** Un algorithme ne fatigue pas et ne « voit » pas ce qu'il attend
   après 150 courses saisies.
3. **La mesure de ta propre erreur.** Faire tourner l'automatique sur un échantillon déjà saisi
   à la main donne un taux de désaccord — donc une barre d'erreur honnête sur toute la base.

### 3.3 Proposition qui remplace YOLO en phase 4 (recommandation forte)

Le problème n'est **pas** « détecter des voitures dans une vidéo » (monde ouvert), c'est
**« suivre ces 8 boîtes que je viens de désigner, pendant 200 images »** (monde fermé, identité
initiale connue à 100 %, fenêtre de 4–8 s).

⚠️ **Cette section est en partie invalidée par la révision 5** — voir
`TRACKING-EVALUATION.md`. Le raisonnement ci-dessous reste juste *en soi*, mais il suppose un
**cadrage stable et toutes les voitures dans le champ**. Sur de la vidéo de retransmission
(panoramiques, zooms, coupures, voitures hors cadre), les mesures montrent que CSRT ne tient pas :
il ne se rétablit **jamais** après une sortie de champ (0/39 images) et échoue totalement à chaque
changement de plan (0/16). **La recommandation « CSRT avant YOLO » est retirée.** Conservé ici pour
la traçabilité du raisonnement.

Pour ce problème précis, un **multi-tracker OpenCV amorcé par clics** (`TrackerCSRT`, ou
`TrackerKCF` si la vitesse compte) serait meilleur que YOLO + ByteTrack :

| Critère | OpenCV CSRT amorcé | YOLO + ByteTrack |
|---|---|---|
| Identité initiale | **exacte** (tu as cliqué) | à inférer, puis à confirmer |
| Dépendances | ~50 Mo | ~2,5 Go (torch) |
| Modèle à télécharger | aucun | oui |
| Mode de défaillance | **visible** — la boîte décroche à l'écran | **invisible** — l'ID switch est silencieux |
| Boîtes | moins précises | plus précises |
| Occlusion longue | mauvais | moyen |

Le critère décisif pour ton exigence « ne jamais contaminer les statistiques » est la
**visibilité de l'échec**. Un tracker qui décroche visiblement est plus sûr qu'un tracker
performant qui échange deux identités sans le dire.

YOLO + ByteTrack reste pertinent **plus tard** et pour un usage précis : proposer
automatiquement les 8 boîtes initiales pour t'éviter les 8 clics d'amorçage, et servir de
second avis sur les cas litigieux. C'est une optimisation, pas une fondation.

### 3.4 OCR des numéros : à écarter pour l'instant

Honnêtement : au départ, les voitures sont vues de face ou de trois-quarts arrière, les numéros
sont sur les portières et le toit, petits, flous de mouvement et empoussiérés. Un taux de lecture
de 20–40 % est réaliste — inutilisable comme source d'identité, et le développement (crop →
super-résolution → PaddleOCR/Tesseract → rapprochement avec les engagés) est loin d'être
trivial. Le clic manuel à t₀ coûte 10 secondes et est fiable à 100 %.

Si l'OCR arrive un jour, ce sera en **suggestion uniquement**, jamais en source de vérité.

---

## 4. Architecture d'intégration proposée

### 4.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────┐
│  RALLYCROSS V2  (statique, inchangé dans son fonctionnement)│
│                                                             │
│  index.html ─ app.js (routeur)                              │
│    ├─ vues existantes ............................. intactes│
│    ├─ js/startAnalysis.js      ← NOUVEAU  poste d'analyse   │
│    ├─ js/startAnalysisCalc.js  ← NOUVEAU  pur + testé       │
│    ├─ js/startStats.js         ← NOUVEAU  vue statistiques  │
│    ├─ js/startStatsCalc.js     ← NOUVEAU  pur + testé       │
│    └─ js/videoPlayer.js        ← NOUVEAU  YouTube + fichier │
│                                                             │
│    videoTimecodes.js ...... INCHANGÉ (lu seulement, §2.3)   │
│                    │                                        │
│                    ▼                                        │
│  Firestore : collections existantes (lecture)               │
│            + startAnalyses  ← NOUVEAU                       │
│            + circuits       ← NOUVEAU (petit)               │
└─────────────────────────────────────────────────────────────┘
              ▲                             │
              │ import JSON (glisser-déposer)│ export JSON de config
              │                             ▼
┌─────────────────────────────────────────────────────────────┐
│  tools/rxstart/   MOTEUR LOCAL AUXILIAIRE (Python, optionnel)│
│  CLI : rxstart analyse video.mp4 --config c.json -o r.json  │
│  OpenCV → tracking → franchissement de ligne → confiance    │
│  N'est JAMAIS requis pour que l'application fonctionne.     │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Python : écarté — voir `AUTOMATION-ARCHITECTURE.md` (révision 6)

> ⚠️ **Section dépassée.** L'exigence d'expérience utilisateur est désormais explicite : **toute
> l'analyse doit se faire dans Rallycross V2**, sans ouvrir d'outil séparé ni échanger de fichier
> JSON à la main. L'architecture retenue est donc **l'exécution dans le navigateur** (ONNX Runtime
> Web + modèles ONNX + code d'association en JS), qui préserve l'application statique sans build.
>
> Le service Python local est **écarté** : il impose une installation Python *et* conserve la
> fragilité du contrôle *Private Network Access* de Chrome. L'enveloppe **Tauri** reste une option
> pour plus tard — elle chargerait les mêmes fichiers statiques sans modification, donc attendre ne
> coûte rien.
>
> Section conservée ci-dessous pour la traçabilité du raisonnement.

#### (historique) Python : moteur auxiliaire, contrat par fichier JSON

Ta proposition est la bonne, je la précise sur un point : **le mode d'échange**.

Trois options envisageables :

1. **Fichier JSON** — la CLI produit un `*.rxstart.json`, tu le glisses dans l'application.
2. **Service local** FastAPI sur `127.0.0.1:8765`, appelé en `fetch()` depuis la page.
3. Détection dans le navigateur (ONNX Runtime Web / WebGPU) — pas de Python du tout.

**Je recommande l'option 1 pour commencer**, pour des raisons concrètes :

- **Zéro problème de sécurité navigateur.** L'option 2 déclenche le contrôle *Private Network
  Access* de Chrome (page HTTPS publique → `127.0.0.1`) : il faut renvoyer
  `Access-Control-Allow-Private-Network: true` au préflight, plus un CORS complet. C'est
  résoluble, mais c'est une source de pannes obscures pour un gain d'ergonomie modeste.
- **Aucun démon à lancer** ni port à gérer.
- **L'application reste 100 % statique** et déployable sur Netlify sans condition.
- **Le contrat JSON est testable des deux côtés** — schéma versionné, jeux de données de
  référence dans `tests/`.

L'option 2 devient intéressante seulement si la boucle « analyser → corriger → relancer » te
paraît trop lourde à l'usage ; le code métier Python étant le même, ce n'est qu'un habillage
ajouté plus tard. L'option 3 est séduisante (plus de Python) mais l'écosystème de tracking en
JS est pauvre et le débogage bien plus difficile : à écarter.

Schéma d'échange proposé :

```json
{
  "schemaVersion": 1,
  "start":  { "docId": "aBc123_s3", "label": "MQ1 · Série 3", "starters": 5 },
  "video":  { "fileName": "loheac-2026-mq1-sc.mp4", "fps": 50,
              "width": 1920, "height": 1080, "fingerprint": "a91c…" },
  "window": { "startSeconds": 4521.0, "endSeconds": 4530.0 },
  "line":   { "a": [0.21, 0.62], "b": [0.78, 0.55] },
  "engine": { "name": "opencv-csrt", "version": "0.1.0" },
  "cuts":   [4526.3],
  "tracks": [
    { "trackId": 4, "carNumber": 12,
      "crossSeconds": 4528.42,
      "quality": { "framesTracked": 198, "framesExpected": 200, "maxGapFrames": 2,
                   "contacts": 1, "colorDrift": 0.09, "aliveAtCrossing": true },
      "confidence": "green" }
  ],
  "order":    [12, 3, 7, 21, 5, 18, 44, 9],
  "warnings": ["changement de plan détecté à 4526,3 s"]
}
```

Coordonnées **normalisées 0..1** partout : la ligne survit à un changement de résolution.

### 4.3 Vidéo : YouTube ou fichier local ? Les deux, mais pas pour la même chose

Contrainte technique qu'il faut connaître avant de concevoir l'UI :

| | YouTube (iframe API) | Fichier local (`<video>`) |
|---|---|---|
| Déjà en base | ✅ `meeting.videos` + timecodes | ❌ |
| Navigation précise | `seekTo()`, `playbackRate` 0.25 → ~±0,1 s | **image par image exacte** via `requestVideoFrameCallback` |
| Accès aux pixels | **impossible** (cross-origin) | ✅ complet (canvas) |
| Clic sur une voiture | approximatif | ✅ précis |
| Analyse automatique | **impossible** | ✅ |
| Stockage | aucun | aucun (le fichier reste chez toi) |

Donc, sans ambiguïté :

- **Phases 1–3 (lecture humaine de l'ordre) → YouTube**, qui a l'immense avantage d'être déjà
  renseigné dans la base avec le timecode de départ. Tu peux commencer à produire de la donnée
  sur les courses déjà timecodées **sans manipuler un seul fichier**.
- **Phases 4–6 (analyse automatique) → fichier local obligatoire.**

Pour les fichiers locaux : `showOpenFilePicker()` (File System Access API, Chrome/Edge) permet
de **conserver un handle dans IndexedDB** et de réouvrir le même fichier plus tard sans le
re-sélectionner. Firestore ne stocke qu'un **descripteur** (nom, taille, durée, fps,
empreinte) — jamais la vidéo, conformément à ta contrainte.

### 4.4 Définition du virage 1 : ordre à une image choisie (révision 5)

⚠️ **Changement de mécanisme.** Les révisions antérieures proposaient une **ligne virtuelle** et un
calcul de franchissement avec interpolation sous-image. Ce mécanisme est **abandonné comme
détecteur** : une ligne `A(x₁,y₁) → B(x₂,y₂)` en coordonnées d'image ne désigne un lieu physique de
la piste que si le cadrage est figé. Sur de la retransmission — panoramique, zoom, suivi des
voitures — elle devient invalide en une seconde. Analyse détaillée des alternatives (suivi de points
du décor, homographie…) dans `TRACKING-EVALUATION.md` §5.

**Mécanisme retenu — « ordre à une image choisie » :**

1. navigation jusqu'à **l'image de sortie du virage 1** ;
2. **cette image est l'instant de mesure**, enregistré dans `video.turn1Seconds` ;
3. l'ordre est lu sur cette image, par clic sur les voitures ou par glisser-déposer des lignes ;
4. une **ligne facultative**, tracée sur cette seule image, sert de **repère visuel** pour garder un
   jugement cohérent d'un départ à l'autre.

La ligne conserve donc son intérêt — et les **presets par circuit** aussi, puisque les 6 séries
d'une manche partagent le même plan de caméra — mais comme **aide à la décision humaine**, plus
comme détecteur automatique.

**Ce que ce choix élimine** : l'interpolation sous-image, le calcul de produit vectoriel, la gestion
des franchissements quasi simultanés, et toute la classe d'erreurs liée au mouvement de caméra. La
phase 3 devient plus simple **et** plus fiable.

**Ce que l'on perd, honnêtement** : la résolution objective de deux franchissements à 40 ms d'écart,
qui était l'un des trois arguments de qualité en faveur de l'automatisation. Sur une image unique,
deux voitures côte à côte restent un jugement humain — à marquer 🟡.

**Cas particulier à tracer explicitement** (voir `TRACKING-EVALUATION.md` §7) : quand toutes les
voitures ne sont pas visibles sur l'image de mesure, il ne suffit pas de laisser `turn1Pos = null`
pour les absentes — il faut aussi savoir si les voitures **visibles** sont réellement les premières.
D'où un champ au niveau du départ :

```js
orderCompleteness: 'complete'      // toutes vues, ordre total fiable
                 | 'leaders_only'  // les visibles sont certifiées être les premières
                 | 'partial'       // ordre relatif non garanti → aucune ligne validée
```

Sans lui, un ordre partiel pourrait contaminer les statistiques par le haut du classement, et pas
seulement par le bas.

### 4.5 Identification des voitures : par la géométrie, pas par l'IA

Par ordre de fiabilité décroissante :

1. **La vérité de grille à t₀ (gratuite, 100 %).** L'application sait exactement quels pilotes
   sont sur la grille et dans quel emplacement. À l'image du départ, il y a donc N voitures dont
   l'ordre à l'écran (tri par `y` décroissant = ligne, puis par `x` = couloir) correspond au
   `gridLayout`. → **proposition d'attribution automatique par pure géométrie**, sans modèle.
2. **Confirmation / correction par clic** (~10 s) : clic sur une boîte → sélection du pilote.
   C'est l'ancrage de vérité, et il reste toujours disponible.
3. **Le tracking** propage l'identité sur les ~200 images.
4. **Signature couleur** comme garde-fou peu coûteux : histogramme HSV de la boîte à t₀
   (en ignorant le bas de la boîte — ombre et poussière), recomparé au franchissement. Une
   dérive forte signale un échange d'identité probable → 🟡 ou 🔴. Cela attrape une bonne part
   des ID switches sans modèle de ré-identification.
5. **OCR** : suggestion facultative, un jour, jamais prescriptive (§3.4).

### 4.6 Pertes de tracking et score de confiance

Le moteur émet par voiture des métriques brutes, jamais un simple booléen :
`framesTracked / framesExpected`, `maxGapFrames`, nombre de contacts (IoU > 0,5 avec une autre
piste), dérive de couleur, `aliveAtCrossing`.

Règles proposées :

| Niveau | Conditions |
|---|---|
| 🟢 **fiable** | piste continue de t₀ au franchissement, aucun trou > 3 images, aucun contact fort, dérive couleur faible |
| 🟡 **à vérifier** | trous ≤ 10 images ré-associés, ou 1 contact fort, ou dérive couleur moyenne, ou franchissement à < 100 ms d'une autre voiture |
| 🔴 **incertain** | piste perdue > 10 images, ou absente au franchissement, ou signature couleur incohérente, ou deux pistes ayant permuté pendant une occlusion |

**Garde-fous globaux, qui implémentent directement ton exigence de non-contamination :**

- Si une seule ligne est 🔴, ou si le nombre de pistes vivantes au franchissement est inférieur
  à la taille de la grille, l'analyse **reste `draft`** et ne peut pas être validée sans
  intervention humaine.
- Le moteur automatique n'écrit **jamais** `status: 'validated'`. Seul un clic humain le fait.
- **La statistique ne lit que `status === 'validated'`.** Une seule condition, vérifiable.

**Changement de plan** : à détecter *avant* le tracking (différence d'histogramme entre images
consécutives — quelques lignes d'OpenCV, très rapide). Si une coupure tombe dans la fenêtre, le
moteur **s'arrête et le signale** plutôt que de deviner ; tu ré-ancres les identités après la
coupure en quelques clics. Détecter les coupures d'abord permet d'annoncer d'emblée
« ce plan contient 2 coupures, prévois un ré-ancrage ».

### 4.7 Nouveau schéma Firestore (minimal, sans duplication)

**Nouvelle collection `startAnalyses` — un document par DÉPART PHYSIQUE**, jamais par session
(§1.5). Les lignes sont **imbriquées** : un départ = 3 à 8 lignes, très loin de la limite de
1 Mio, et surtout **1 seule lecture par départ** pour la statistique.

#### Stratégie d'identifiant déterministe

`sessionId` seul ne suffit pas : une MQ contient N départs. Convention retenue, uniforme sur
toutes les phases :

```
startAnalyses/${sessionId}_s${startIndex}
```

où `startIndex` = **numéro de série** pour les MQ (`results.serie`, 1..N), et **`1`** pour
QF / DF / FIN qui n'ont qu'une grille. Exemples :

```
startAnalyses/aBc123_s1   ← MQ1 Supercar, série 1
startAnalyses/aBc123_s6   ← MQ1 Supercar, série 6
startAnalyses/xYz789_s1   ← DF2 Supercar (grille unique)
```

Pourquoi cette forme :

- **Déterministe et idempotente** — `setDoc(..., {merge:true})` comme `results` et
  `sessionParticipants` : impossible de créer un doublon, même en cas de double clic ou
  d'onglets multiples. C'est la convention maison.
- **Uniforme** : un seul chemin de code pour toutes les phases, `startIndex` valant simplement 1
  quand il n'y a qu'un départ. Pas de branche `if (type === 'MQ')` dans la couche d'accès.
- **Le préfixe `s`** évite toute ambiguïté de lecture et rend l'id lisible dans la console
  Firestore.
- **Requêtable** : `where('sessionId','==',id)` retourne les N départs d'une manche, triables par
  `startIndex`.

#### Schéma

```js
startAnalyses/${sessionId}_s${startIndex} = {
  // ── rattachement — dénormalisé comme partout ailleurs dans la V2 ──
  sessionId, meetingId, championshipId, year, category,
  sessionType,            // 'MQ' | 'QF' | 'DF' | 'FIN'
  sessionNum,             // n° de manche pour MQ, n° de QF/DF sinon
  startIndex,             // n° de série (MQ) ou 1
  startLabel,             // libellé lisible : « MQ1 · Série 3 », « DF2 »
  circuitKey,
  regulationKey,

  // ── géométrie effective de CE départ — source : LE RÈGLEMENT (§4.10 A) ──
  gridLanes,              // nb de couloirs que définit la géométrie de grille
                          //   QF/DF/FIN : sessionConfig[type].gridLayout.lanes
                          //   MQ        : maxPerSeries de la catégorie
  gridRowsTotal,          // nb de lignes de la géométrie (1 pour une MQ)
  lanesUsed,              // nb de couloirs réellement occupés (3 pour une série de 3)
  starters,               // nb de voitures au départ = rows.length
  gridSource: 'mq_couloir' | 'grid_layout' | 'manual',
                          // détermine aussi la SÉMANTIQUE de rows[].gridPos (voir ci-dessous)
  gridLayoutKey,          // empreinte de la géométrie (lanes, rows, positions)
                          //   → deux départs ne sont comparables au couloir près
                          //     que s'ils partagent ce même gridLayoutKey (§4.8)

  status: 'draft' | 'validated',
  validatedAt, validatedBy,

  video: { kind: 'youtube' | 'local', videoId | localVideoId,
           startSeconds,        // départ de CE départ (≠ videoTimecodes pour les séries 2..N)
           turn1Seconds,        // image de mesure de l'ordre V1 (§4.4)
           startSecondsSource: 'videoTimecodes' | 'manual' | 'suggested' },

  // toutes les voitures étaient-elles visibles à l'instant de mesure ? (§4.4)
  orderCompleteness: 'complete' | 'leaders_only' | 'partial',

  analysis: { engine: 'manual' | 'opencv-csrt' | 'yolo-bytetrack',
              version, ranAt, warnings: [] },

  rows: [{
    driverId, carNumber,      // clés vers l'existant (pas de recopie d'identité)

    // ── position SPORTIVE ──
    gridPos,                  // MQ    : ≡ couloir (aucune hiérarchie sportive)
                              // finales : rang de qualification (P1 = meilleur qualifié)
    // ── position PHYSIQUE, déduite de gridPos via le gridLayout du règlement ──
    gridRow,                  // ligne physique, 1-based
    lane,                     // couloir physique, 1-based
    // NB : laneZone n'est PAS stocké — regroupement à l'affichage (§4.10 A)
    turn1Pos,                 // 1..starters — valeur validée par l'humain
    autoTurn1Pos,             // ce que le moteur avait proposé (traçabilité)
    finishPosInStart,         // rang parmi les partants de CE départ  ← comparable
    finishPosInSession,       // rang dans la manche entière (MQ) ou la session
    finishStatus,             // null | 'DNF' | 'DNS' | 'DSQ' | 'DSQ_RACE'
    confidence: 'green' | 'yellow' | 'red',
    corrected: false,
    note
  }],

  integrity: { seriesFingerprint },   // voir ci-dessous

  createdAt, updatedAt
}
```

#### Choix de conception, et pourquoi

- **`finishPosInStart` ET `finishPosInSession`.** C'est une conséquence directe de la correction
  MQ. `calcMqStandings()` classe **toute la manche** (1..30) : ce rang n'est pas comparable à une
  grille de 5. Pour la matrice de transition et le gain/perte de positions, la seule grandeur
  homogène est **le rang au sein du départ**, recalculé en triant par `ms` les seuls pilotes de
  la série. Le rang manche-entière est conservé à côté parce qu'il reste l'information
  réglementaire (c'est lui qui donne les points) et qu'il permettra des analyses secondaires.
  Pour QF / DF / FIN, les deux valeurs coïncident.
- **`gridPos` (sportif) ET `gridRow` + `lane` (physique) — jamais l'un à la place de l'autre.**
  Ce sont deux informations différentes qui répondent à des questions statistiques différentes
  (§4.8). Sur une grille en quinconce, P4 est en **ligne 2**, pas dans le couloir 4 :

  ```
  Ligne 1 :   P1        P2        P3        →  gridRow 1, lanes 1 / 3 / 5
  Ligne 2 :        P4        P5             →  gridRow 2, lanes 2 / 4
  Ligne 3 :   P6        P7        P8        →  gridRow 3, lanes 1 / 3 / 5
  ```

- **⚠️ `gridPos` n'a pas la même signification selon la phase**, et `gridSource` sert à le savoir :
  - `gridSource: 'mq_couloir'` → `gridPos ≡ lane`, c'est un **index de couloir** ; l'application ne
    modélise aucune hiérarchie de mérite pour les couloirs de MQ ;
  - `gridSource: 'grid_layout'` → `gridPos` est un **rang de qualification** (P1 = meilleur
    qualifié de la cascade).

  Conséquence directe pour la statistique : **agréger « P1 » à travers les MQ et les finales
  mélangerait deux concepts distincts.** Toute métrique indexée sur `gridPos` doit être filtrée ou
  ventilée par `gridSource` (§4.8).
- **`gridLanes` (réglementaire) ET `lanesUsed` (réel).** `gridLanes` définit le repère dans lequel
  `lane` est exprimé et sert de dénominateur à `laneZone` ; `lanesUsed` décrit le remplissage réel
  du départ (3 voitures sur une géométrie à 5 couloirs) et sert aux contrôles de cohérence et à la
  comparabilité des matrices.
- **Tout est figé à la validation** (`finishPos*`, `lanesUsed`, `laneZone`) plutôt que recalculé à
  l'affichage : les règlements et les compositions de séries évoluent, une statistique historique
  doit être stable.
- **`integrity.seriesFingerprint`** = hachage court de la liste triée des `driverId` du départ, au
  moment de la validation. La composition des séries n'est **pas** persistée par la V2 : elle vit
  dans `results.serie`, que la régie peut modifier (correction de saisie, nouveau tirage). Si la
  série 3 contient demain d'autres pilotes qu'à la validation, l'empreinte ne correspondra plus →
  le module affiche « cette analyse a été validée sur une composition différente » au lieu de
  laisser une statistique silencieusement fausse. C'est peu de code pour un vrai risque.
- **Aucune recopie de nom de pilote** au-delà de `carNumber` (nécessaire au rapprochement vidéo).
  `driverId` suffit pour rejoindre `drivers` / `persons`.

#### Reconstruction automatique d'un départ depuis l'existant

Aucune saisie de grille n'est nécessaire — tout se déduit :

#### Tableau des sources de vérité

Chaque champ a **une seule** origine, et il est important de ne pas les mélanger :

| Champ | Source de vérité | MQ | QF / DF / FIN |
|---|---|---|---|
| `gridPos` | `results.couloir` (MQ) / cascade de qualification (finales) | ≡ `couloir` | rang de qualification |
| `gridRow` | **règlement** — `sessionConfig[type].gridLayout` | toujours `1` | déduit du `gridLayout` |
| `lane` | **règlement** — `gridLayout` (finales) / `results.couloir` (MQ) | ≡ `couloir` | déduit du `gridLayout` |
| `gridLanes` | **règlement** — `gridLayout.lanes` / `maxPerSeries` | `maxPerSeries` de la catégorie | `gridLayout.lanes` |
| `gridRowsTotal` | **règlement** — `gridLayout.rows` | `1` | `gridLayout.rows` |
| `laneZone` | **non stocké** — calculé à l'affichage depuis `lane` + `gridLanes` | — | — |
| orientation (affichage) | **`meeting.poleSide`**, déjà en base | — | — |
| ligne V1, presets vidéo | **circuit** — `circuits/{key}.presets` | — | — |

**Règle à ne jamais enfreindre : la géométrie de la grille appartient au règlement du
championnat, le circuit ne fournit que des informations physiques et vidéo.** Deux championnats
peuvent définir des demi-finales différemment sur le même circuit ; l'analyse doit alors utiliser
le `gridLayout` du championnat concerné, résolu via `meeting.championshipId`.

#### MQ (`sessionId` + `startIndex`)

1. `results` où `sessionId == X` → filtrer `serie == startIndex` ;
2. chaque pilote apporte son `couloir` → `gridPos = couloir`, `lane = couloir`, `gridRow = 1` ;
3. `gridLanes = maxPerSeries` de la catégorie (`getCategoryMaxPerSeries()`), `gridRowsTotal = 1` ;
4. `lanesUsed` = nombre de pilotes de la série (croisé avec
   `getSeriesStructure().sizes[startIndex-1]` comme contrôle de cohérence) ;
5. `finishPosInStart` = tri par `ms` des seuls pilotes de la série ;
6. `finishPosInSession` = position issue de `calcMqStandings()`.

#### QF / DF / FIN (`sessionId`, `startIndex = 1`)

```
gridPos  →  gridLayout du règlement du championnat  →  gridRow + lane  →  laneZone
```

1. résoudre le championnat : `meeting.championshipId` → `championships/{id}.sessionConfig[type]` ;
2. `sessionParticipants` où `sessionId == X` → les partants ;
3. `gridPos` = rang dans la cascade de qualification, telle que `sessions.js` la calcule déjà ;
4. **placement physique** — reproduire exactement l'algorithme de `sessions.js` (voir ci-dessous) ;
5. `gridLanes = gridLayout.lanes`, `gridRowsTotal = gridLayout.rows` ;
6. `finishPosInStart = finishPosInSession` via `calcPhaseStandings()`.

**Détail d'implémentation vérifié dans le code, et qui n'est pas une simple inversion de la
map.** Les clés de `gridLayout.positions` sont `"ligne-colonne"` en **base 0**
(`defaultGridLayout` : `positions[r + '-' + c] = pos++`), donc `gridRow = r + 1` et
`lane = c + 1`. Mais l'éditeur de grille de `settings.js` est **entièrement libre**
(`readGridLayout` ramasse toute cellule portant un nombre) : les numéros de position peuvent être
non contigus, comporter des trous, voire des doublons. `sessions.js` ne fait donc **pas** une
recherche par valeur — il trie les cellules par numéro puis distribue les pilotes dans l'ordre du
classement :

```js
const cells = Object.entries(positions).sort((a, b) => a[1] - b[1]);
const cell  = cells[gridPos - 1];            // gridPos = rang sportif, 1-based
const [r, c] = cell[0].split('-').map(Number);
// gridRow = r + 1 ; lane = c + 1
```

`startAnalysisCalc.js` doit reproduire **cette** logique, et non inverser `positions` par valeur :
c'est la seule façon de garantir que la grille reconstruite corresponde à celle affichée dans la
vue Sessions, y compris sur une configuration exotique. Cas à couvrir par des tests :

- numéros de position **non contigus** (`{1,2,3,5,8}`) → le n-ième qualifié occupe la n-ième
  cellule, et le numéro affiché dans la grille **diffère** alors du rang sportif → émettre un
  avertissement plutôt que de laisser l'ambiguïté ;
- **doublons** de numéros → configuration invalide, refuser et le signaler ;
- **plus de partants que de cellules** → les partants surnuméraires n'ont pas de position physique
  (`gridRow = lane = null`), le départ reste analysable pour les autres ;
- `gridLayout` **absent** du règlement → `gridSource: 'manual'`, saisie assistée, jamais de valeur
  inventée.

**Cas dégradé à gérer explicitement** : `results.serie` / `results.couloir` sont **nullables**
(remplis par `importTimes.js` ou à la main dans `timing.js`, mais pas garantis). Si la série n'est
pas renseignée, le module doit le dire clairement et proposer un regroupement manuel, jamais
inventer une composition. À prévoir dès la phase 1 : c'est le cas le plus fréquent sur les
meetings anciens.

**Nouvelle collection `circuits`** (petite, ~20 documents) :

```js
circuits/{circuitKey} = {
  name: "Lohéac",
  aliases: ["Loheac", "LOHÉAC", "Lohéac-Bretagne"],
  medianSeriesGap: 320,              // intervalle médian entre 2 séries, en s (§4.9)
  presets: [{ label: "Plan tribune", videoHint: "…",
              lineA: {x:0.21,y:0.62}, lineB: {x:0.78,y:0.55} }]
}
```

⚠️ **Correction (révision 7) — `firstTurnSide` retiré, il était redondant.** Le sens du premier
virage **existe déjà en base** : `meeting.poleSide` (`'droite'` | `'gauche'`), saisi à la création
du meeting (`js/meetings.js`, boutons `.mtg-pole-btn`) et déjà exploité par `js/standings.js`.

Et surtout, `standings.js` documente la convention de numérotation :

> « 1er virage à droite — couloir 1 à droite » / « 1er virage à gauche — couloir 1 à gauche »

**⇒ le couloir 1 est TOUJOURS du côté du premier virage, donc toujours à l'intérieur.** La zone
latérale ne dépend donc que de `(lane, gridLanes)` : **aucune orientation n'est nécessaire pour la
calculer**, et le champ `laneNumberingFrom` un temps envisagé n'a pas lieu d'être.

`meeting.poleSide` reste utile pour l'**affichage** (orienter la grille, placer le repère visuel V1),
jamais pour le calcul de zone.

**Pourquoi l'orientation compte quand même (pour l'affichage).**
« Intérieur » et « extérieur » n'ont de sens que **relativement au sens du premier virage** : sur
un circuit dont le virage 1 tourne à droite, l'intérieur est le côté droit de la grille ; à
gauche, c'est l'inverse. Sans ce champ, agréger « couloir intérieur » sur plusieurs circuits
mélangerait des situations opposées et le résultat serait faux. Avec lui, `laneZone` se calcule
proprement :

```
laneZone(lane, gridLanes) → 'inside' | 'middle' | 'outside'
```

Le couloir 1 étant toujours à l'intérieur (convention vérifiée dans `standings.js`, voir §4.7),
aucune orientation n'entre dans ce calcul.

**Décision complémentaire : `laneZone` n'est PAS stocké.** Seuls `lane` (brut) et `gridLanes` le
sont ; le regroupement intérieur / milieu / extérieur se fait **à l'affichage**, dans la vue
statistiques. `laneZone()` reste donc un simple utilitaire de présentation, ce qui permet de changer
de découpage plus tard sans migration de données.

à placer dans `startAnalysisCalc.js`, en fonction pure et testée. Le dénominateur est `gridLanes`
— le nombre de couloirs défini par **le règlement**, et non le nombre de voitures présentes au
départ ni une propriété du circuit. Voir §4.10 A.

**Champs additifs sur `sessionParticipants`** : `gridPos`, `lane` — écrits au moment où la grille
QF/DF/FIN est générée, pour cesser de perdre une information déjà calculée. Purement additif :
les règles actuelles (`allow update: if isRegie()` + `hasFields([...])`) acceptent déjà des
champs supplémentaires.

**Règles Firestore** : deux blocs à ajouter, aucun bloc existant à modifier.

```
match /startAnalyses/{docId} {
  allow read:   if true;
  allow delete: if isRegie();
  allow create, update: if isRegie()
    && hasFields(request.resource.data,
         ['sessionId','meetingId','year','category','sessionType','startIndex','status'])
    && request.resource.data.status in ['draft','validated']
    && request.resource.data.startIndex is int
    && request.resource.data.startIndex >= 1
    && request.resource.data.rows is list
    && request.resource.data.rows.size() <= 12;   // un départ physique : 3 à 8 voitures
}
match /circuits/{docId} {
  allow read:  if true;
  allow write: if isRegie();
}
```

**Index** : aucun. Conformément à la convention de `stats.js`, on requête sur `year`
(éventuellement + `status`) et on filtre championnat / circuit / catégorie côté client. Le volume
reste modeste même avec la granularité par départ : ~24 départs × 6 catégories × 8 meetings ≈
**1 150 documents par saison** dans le pire cas, tous à ~2 Ko. Une saison complète se charge en
une requête et se filtre côté client sans difficulté.

**Migration** : aucune. Tout est additif, rien n'est renommé, aucune donnée existante n'est
touchée. `videoTimecodes` n'est pas modifié (§2.3).

### 4.8 Intégration dans les statistiques

`js/stats.js` est **orienté pilote** : lignes = pilotes, colonnes = meetings, filtré par
`year` + `category` + championnat actif. L'analyse des départs est **orientée position** : lignes
= positions de grille, agrégées sur des centaines de départs, et surtout **transversale aux
saisons et aux championnats** (tu veux comparer 2025 vs 2026, France vs Europe).

Ce sont deux axes d'agrégation incompatibles : forcer l'un dans l'autre produirait une vue
confuse. → **Vue dédiée `startStats`**, placée sous « Statistiques » dans le menu, mais qui
**réutilise** les conventions existantes : barre de filtres du même type, classes CSS `sta-*`,
`table-wrap`, tri par en-tête `data-sort`.

Filtres : Championnat → Saison → Circuit → Catégorie → Type de session → Position de grille →
Couloir, chacun avec « Tous ». Le règlement/format se déduit de `regulationKey`.

#### L'unité d'observation est le départ, pas la manche

Point corrigé et central : **`n` compte des départs physiques.** Une MQ à 6 séries contribue 6
observations, pas 1. Concrètement, `n` doit toujours être le nombre de documents `startAnalyses`
validés qui entrent dans la case affichée — et il faut afficher **deux compteurs distincts** pour
éviter toute ambiguïté :

- **`n` départs** : nombre de départs physiques analysés (l'unité statistique) ;
- **`n` observations pilote** : nombre de lignes, c'est-à-dire de couples (pilote × départ) — c'est
  le `n` pertinent pour les statistiques par couloir, puisqu'un départ de 5 voitures fournit 5
  observations de couloir.

Confondre les deux gonflerait artificiellement les intervalles de confiance. Exemple d'affichage
attendu : « Lohéac — Supercar — 2026 · **84 départs** · 412 observations pilote ».

#### Volumétrie : le calcul exact

```
départs par (meeting × catégorie) = nbMQ × S + nbDF + nbFIN
```

| Terme | Valeur | Origine |
|---|---|---|
| `nbMQ` | 4 | `meeting.nbMQ`, borné 1..4 par `firestore.rules` ; défaut `sessionConfig.MQ.count` |
| `S` | **variable** | `computeSeriesSizes(nbParticipants, maxPerSeries, mode)`, `js/timing.js` |
| `nbDF` | 2 | `sessionConfig.DF.count` |
| `nbFIN` | 1 | — |

**`S` n'est pas une constante** : il dépend du nombre d'engagés du jour. Valeurs obtenues en
exécutant la fonction réelle (`maxPerSeries = 5`, mode `ffsa`) :

| Engagés | Répartition | S | Départs / meeting | Observations pilote |
|---:|---|---:|---:|---:|
| 15 | `[5,5,5]` | 3 | **15** | ~75 |
| 20 | `[5,5,5,5]` | 4 | **19** | ~95 |
| 25 | `[5,5,5,5,5]` | 5 | **23** | ~115 |
| 26 | `[3,3,5,5,5,5]` | 6 | **27** | ~131 |
| 30 | `[5,5,5,5,5,5]` | 6 | **27** | ~135 |

⚠️ **Correction (révision 3)** : une version antérieure annonçait « 27 départs, soit ×9 » sans
définir le dénominateur, et traitait `S = 6` comme acquis. Les deux points sont corrigés :

| Base de comparaison | « Avant » | Rapport (30 engagés) |
|---|---:|---:|
| Sessions comportant un départ en grille (4 MQ + 2 DF + 1 FIN) | 7 | **×3,9** |
| Sessions qui auraient produit une donnée *valide* (2 DF + 1 FIN seulement) | 3 | ×9 |

**Le chiffre de référence est ×3,9**, et il tombe à ×2,1 pour une catégorie à 15 engagés. Le ×9
n'est vrai que si l'on considère que les sessions MQ ne produisaient aucune donnée exploitable sous
l'ancien modèle — défendable, mais ce n'est pas un ratio de volume.

Pour une saison : `nbMeetings × (nbMQ × S + 3)`. Le nombre de meetings n'est pas une donnée de
configuration (il découle des documents `meetings` créés) — avec 8 meetings et S = 6, on obtient
~216 départs par catégorie et par saison, mais c'est une hypothèse de calendrier, pas une constante
du projet.

#### ⚠️ Le facteur réellement limitant : la couverture vidéo

Les chiffres ci-dessus sont un **maximum théorique**. En pratique, seuls les départs **filmés et
retrouvables** sont analysables : la diffusion couvre rarement les 6 séries de toutes les
catégories, et les séries des catégories secondaires sont souvent absentes du montage.

**C'est la couverture vidéo, et non le modèle de données, qui déterminera le volume réel.** À
suivre dès la phase 1 sous forme d'un indicateur explicite : *départs analysés / départs
théoriques* par meeting et par catégorie. Sans lui, on ne saura pas distinguer « ce circuit a peu
d'observations » de « ce circuit est mal filmé » — deux causes qui appellent des actions
opposées.

#### Comparabilité entre départs de tailles différentes

Conséquence des séries de tailles inégales (`[3,3,5,5,5,5]`) : une matrice de transition
grille → V1 mélangeant des grilles de 3 et de 5 voitures n'a pas de sens brut. Trois mesures :

- **la matrice est calculée par taille de grille** (`starters`), et l'UI affiche soit une taille
  choisie, soit une version normalisée ;
- **le gain/perte de positions** (`gridPos − turn1Pos`) reste comparable entre tailles, c'est donc
  l'indicateur transversal privilégié ;
- **la position relative** (`(pos − 1) / (starters − 1)`, sur 0..1) permet une comparaison honnête
  entre formats quand on agrège volontairement des tailles différentes.

#### Quatre axes d'analyse indépendants

La distinction sportif / physique (§4.7) existe précisément pour permettre quatre familles de
questions **différentes**, qu'il ne faut pas confondre :

| Axe | Champ | Exemple de résultat | Comparable entre championnats ? |
|---|---|---|---|
| Position sportive | `gridPos` | « P1 ressort en tête du V1 dans 62 % des départs » | ✅ oui, mais **jamais entre MQ et finales** (sémantique différente) |
| Ligne de départ | `gridRow` | « la ligne 2 perd en moyenne 0,4 position au V1 » | ✅ oui, si le nombre de lignes est comparable |
| Couloir physique | `lane` | « le couloir 4 gagne en moyenne 0,25 position » | ❌ **seulement à `gridLayoutKey` identique** |
| Côté du virage 1 | `laneZone` | « côté intérieur : +0,31 position en moyenne » | ✅ oui — c'est l'axe le plus robuste |

Trois règles qui en découlent, à implémenter comme garde-fous dans `startStatsCalc.js` :

1. **`gridPos` ne s'agrège jamais entre MQ et finales.** En MQ c'est un index de couloir sans
   hiérarchie ; en finale, un rang de mérite. Les métriques indexées sur `gridPos` sont donc
   toujours ventilées par `gridSource`, et l'UI l'indique explicitement.
2. **`lane` ne s'agrège qu'à géométrie identique.** « Couloir 3 du championnat A » et « couloir 3 du
   championnat B » ne désignent pas la même place si les `gridLayout` diffèrent. D'où
   `gridLayoutKey` (§4.7) : les statistiques par couloir groupent sur cette empreinte, et l'UI
   refuse de mélanger deux géométries au lieu de produire une moyenne trompeuse.
3. **`laneZone` et la position relative sont les seuls axes vraiment transversaux.** Ce sont donc
   eux qu'il faut privilégier pour les comparaisons entre championnats et entre formats.

Un filtre **« configuration de grille »** (dérivé de `gridLayoutKey`, présenté sous forme lisible :
« 5 couloirs × 3 lignes, quinconce ») complète les filtres Championnat → Saison → Circuit →
Catégorie.

#### Indicateurs

Tous dans `js/startStatsCalc.js` (pur, testé) :

- matrice de transition `gridPos` → V1, et `gridPos` → arrivée, **par taille de grille** et **par
  `gridSource`** ;
- % de conservation de la tête, % de prise de tête par position de départ ;
- gain/perte moyen (et **médian** — la moyenne est sensible aux abandons), déclinable sur les
  quatre axes ci-dessus ;
- position moyenne en V1 et à l'arrivée par position de départ ;
- effet de la **ligne** (`gridRow`) — question distincte de celle du couloir ;
- effet du **couloir** (`lane`), groupé par `gridLayoutKey` ;
- effet du **côté** (`laneZone`, calculé à l'affichage depuis `lane` + `gridLanes`, §4.10 A) ;
- corrélation V1 ↔ arrivée (Spearman plutôt que Pearson : ce sont des rangs), calculée sur
  `finishPosInStart` ;
- comparaisons circuit / catégorie / championnat / saison / format ;
- **`n` affiché systématiquement** (les deux compteurs), et **intervalle de confiance de Wilson**
  sur chaque pourcentage. C'est peu de code et ça évite d'interpréter 3/4 = 75 % comme un
  résultat. Un pourcentage sous un seuil (`n < 10`) doit s'afficher en `n=4` grisé, sans
  pourcentage.

**Deux avertissements méthodologiques à intégrer dans l'UI**, sinon les chiffres seront
sur-interprétés :

1. **La position de grille n'est pas tirée au hasard** en QF/DF/FIN : P1 est le meilleur
   qualifié. « P1 conserve la tête dans 63 % des cas » mélange donc l'avantage de la position
   et le niveau du pilote. Pour isoler l'effet du couloir, il faut comparer un même pilote dans
   des couloirs différents, ou normaliser par son rang au classement intermédiaire — que
   l'application possède déjà (`interimStandings`).
2. **Les couloirs de MQ, eux, sont attribués par tirage réglementaire** : c'est la véritable
   expérience naturelle propre pour mesurer l'effet du couloir. Et ces données
   (`results.couloir`) **sont déjà dans ta base**.

### 4.9 Workflow vidéo : enchaîner Série 1 → Série 2 → Série 3

C'est l'ergonomie qui détermine le volume de données collecté, donc elle mérite d'être conçue
précisément.

**Écran « Analyse des départs » — colonne de gauche : la liste des départs à analyser.**
On choisit Championnat → Meeting → Catégorie, et le module **énumère tous les départs physiques
du meeting** pour cette catégorie, avec leur état :

```
MQ1  ├─ Série 1  (5 pilotes)  ✅ validée
     ├─ Série 2  (5 pilotes)  🟡 brouillon
     ├─ Série 3  (5 pilotes)  ⚪ à faire   ← sélectionné
     ├─ Série 4  (5 pilotes)  ⚪ à faire
     ├─ Série 5  (3 pilotes)  ⚪ à faire
     └─ Série 6  (3 pilotes)  ⚪ à faire
MQ2  ├─ Série 1  …
DF1  └─ grille unique         ⚪ à faire
FIN  └─ grille unique         ⚪ à faire
```

Tu ne « reviens » donc jamais chercher session + catégorie : tu descends la liste. Raccourcis
clavier `N` (départ suivant) / `P` (précédent) pour enchaîner sans souris.

**Pré-remplissage progressif du timecode de départ** — la partie qui fait vraiment gagner du
temps :

| Départ | `startSeconds` proposé | `startSecondsSource` |
|---|---|---|
| Série 1 | `videoTimecodes[MQn\|catégorie].seconds` — **déjà en base** | `videoTimecodes` |
| Série 2 | série 1 + intervalle par défaut du circuit | `suggested` |
| Série 3+ | série précédente + **médiane des intervalles déjà mesurés** sur ce meeting | `suggested` |

Une suggestion n'est jamais une donnée : elle positionne le lecteur *à peu près* au bon endroit,
tu ajustes de quelques secondes et tu confirmes — ce qui passe la source à `manual`. Après deux
ou trois séries mesurées, la médiane devient bonne et le lecteur tombe quasiment sur le départ.
L'intervalle médian observé par circuit peut être mémorisé dans `circuits/{key}.medianSeriesGap`
pour amorcer les meetings suivants.

**Boucle de travail par départ** (~20–30 s) :

1. le lecteur se positionne sur `startSeconds` (proposé ou saisi) ;
2. la grille reconstruite depuis `results.serie`/`couloir` s'affiche à côté de l'image ;
3. tu avances jusqu'à la sortie du virage 1, tu marques `turn1Seconds` ;
4. tu saisis l'ordre V1 (clic sur les voitures, ou glisser-déposer des lignes) ;
5. `finishPosInStart` et `finishPosInSession` sont déjà remplis depuis `results` ;
6. **Valider → départ suivant** en un seul bouton.

**Sécurité vidéo** : `startSeconds` et `turn1Seconds` sont stockés **par départ** dans
`startAnalyses`, jamais dans `videoTimecodes` — donc aucune interaction avec la modale existante,
et un timecode de série mal saisi n'affecte que son propre départ.

### 4.10 Conventions tranchées

Deux points de réalité terrain, décidés avant la phase 1. Ils sont notés ici parce qu'ils
déterminent directement le corps de deux fonctions pures et leurs tests.

#### A. Couloirs physiques fixes — `laneZone` se calcule sur `gridLanes` (réglementaire)

**Décision : les voitures remplissent les couloirs à partir du couloir 1, sans redistribution sur
la largeur.** 3 pilotes → couloirs 1, 2, 3 ; 4 pilotes → 1, 2, 3, 4 ; les couloirs restants sont
vides.

Conséquence : le couloir 3 reste **physiquement le couloir central** d'une géométrie à 5 couloirs,
que la série compte 3 ou 5 voitures. Le dénominateur de `laneZone` est donc le nombre de couloirs
**de la géométrie**, jamais le nombre de voitures présentes :

```
laneZone(lane, gridLanes) → 'inside' | 'middle' | 'outside'
```

⚠️ **Correction (révision 4) — `trackLanes` renommé en `gridLanes`, et la source de vérité
change.** La révision 3 faisait de `circuits/{circuitKey}.trackLanes` la source prioritaire, avec
repli sur le règlement. **C'était une erreur de conception** : elle laissait une propriété du
circuit écraser la géométrie réglementaire des phases finales, alors que celle-ci est configurable
par championnat dans la V2. Le nom `trackLanes` entretenait lui-même la confusion.

**Résolution de `gridLanes` — le règlement est l'unique source de vérité** :

| Phase | `gridLanes` | `gridRowsTotal` |
|---|---|---|
| QF / DF / FIN | `championships/{id}.sessionConfig[type].gridLayout.lanes` | `…gridLayout.rows` |
| MQ | `maxPerSeries` de la catégorie (`getCategoryMaxPerSeries()`) | `1` |

Le championnat est résolu via `meeting.championshipId`, jamais via le championnat *actif* de
l'interface — sinon une analyse rejouée plus tard, avec un autre championnat sélectionné,
reconstruirait une géométrie fausse. Les valeurs retenues sont **figées dans le document
d'analyse** pour rester stables si un règlement évolue.

**Ce que le circuit fournit, et rien de plus** : les presets de ligne V1 et `medianSeriesGap`.
L'orientation vient de `meeting.poleSide`, déjà en base (§4.7).

`lanesUsed` reste stocké (§4.7) : il documente le remplissage réel du départ et sert aux contrôles
de cohérence et à la comparabilité des matrices (§4.8).

**Conséquence statistique à assumer** : une série incomplète ne fournit **aucune observation** pour
les couloirs extérieurs. Les couloirs 1–3 auront donc systématiquement plus d'observations que les
couloirs 4–5. Ce n'est pas un biais en soi — chaque observation reste valide — mais deux
précautions s'imposent : afficher `n` **par couloir** et non seulement `n` global, et proposer un
filtre « séries complètes uniquement » pour les comparaisons entre couloirs, puisque les séries
incomplètes ne sont pas réparties au hasard dans une manche (en mode `ffsa`, elles sont placées en
début).

#### B. Abandon avant la sortie du virage 1 — `turn1Pos = null`, départ conservé

**Décision : un pilote sans position V1 mesurable garde sa ligne avec `turn1Pos = null`** et son
`finishStatus` (`DNF`, `DSQ_RACE`…). Le départ reste valide et validable.

Règles qui en découlent, à implémenter dans `startStatsCalc.js` :

- une ligne à `turn1Pos = null` est **exclue** des matrices de transition, du gain/perte de
  positions et des corrélations — elle n'a pas de valeur mesurée, on ne l'invente pas ;
- le **départ** reste compté dans « nb de départs analysés » : les autres pilotes de ce départ sont
  parfaitement exploitables ;
- les positions V1 des autres pilotes ne sont **pas renumérotées** pour combler le trou : si le
  pilote parti P2 disparaît, les positions mesurées restent celles observées à la ligne. Le champ
  `starters` permet de savoir combien de voitures étaient au départ et
  `rows.filter(r => r.turn1Pos != null).length` combien ont été mesurées ;
- ces lignes deviennent une **donnée en soi** : le taux d'incident avant V1 par position de grille
  et par couloir est une statistique intéressante, obtenue gratuitement puisque l'information est
  conservée. À exposer en phase 8.

C'est la convention la plus riche des trois envisagées : classer d'office le pilote dernier aurait
confondu « a perdu 4 places » et « a été accroché », ce qui aurait tiré le gain moyen vers le bas
précisément pour les positions les plus exposées ; écarter le départ entier aurait coûté une part
notable de l'échantillon, le rallycross ayant beaucoup de contacts au premier virage.

### 4.11 Emplacement dans l'interface

Deux activités distinctes, donc deux points d'entrée — mais **une seule tuile** sur l'accueil.

**1. Le poste de saisie/analyse → nouvelle entrée + nouvelle tuile.** C'est une activité de
saisie, où l'on navigue meeting → catégorie → liste de départs et où l'on passe du temps. Placée
dans la section **« Gestion »** du menu, près de Sessions et Chronométrage :

```html
<li><a class="menu-item" data-view="startAnalysis" href="#">🎥 Analyse des départs</a></li>
```

plus une `home-card` correspondante. Un bouton contextuel « 🎥 Analyser les départs » depuis la vue
Chronométrage évite de repasser par la sélection quand on vient de saisir les temps.

**2. Les statistiques → entrée de menu sous « 📊 Statistiques », sans tuile d'accueil.** La grille
d'accueil compte déjà 11 tuiles ; en ajouter deux la dilue, et les statistiques restent accessibles
par le menu et depuis le poste d'analyse.

Deux façons de réaliser la navigation « Statistiques → Analyse des départs » demandée :

| Option | Avantage | Risque |
|---|---|---|
| **Vue séparée `startStats`** + entrée de menu placée juste après 📊 Statistiques | **`stats.js` (722 lignes) n'est pas touché** | navigation un peu moins intégrée |
| Barre d'onglets **dans** `view-stats` | correspond littéralement à la formulation souhaitée | impose de modifier `renderView()` de `stats.js` |

**Recommandation : vue séparée en phase 1**, au nom de la contrainte « ne pas casser l'existant ».
La fusion en onglets à l'intérieur de `view-stats` devient un changement cosmétique en phase 8,
une fois le module éprouvé — alors que la faire maintenant mettrait `stats.js` en risque pour un
gain nul.

Rappel des points d'insertion (§1.2), tous additifs : `VIEW_TITLES`, menu, `<div class="view">`,
`safeInit()`, CSS, et **`ASSET_PATHS` de `sw.js` avec `CACHE_NAME` incrémenté**.

---

### 4.12 Lecteur V0 livré — contrat exact (révision 8)

Le lot « lecteur vidéo V0 » est en place. Il ne contient **aucune IA** : ni YOLO, ni ReID, ni
tracking. Son rôle est d'être un bon outil de lecture et de saisie, et de figer dès maintenant
l'interface que le futur module de détection utilisera.

**Modules**

| Fichier | Rôle | Pur ? |
|---|---|---|
| `js/videoPlayerCalc.js` | temps, cadence, vitesses, géométrie de l'overlay, clavier | oui, testé |
| `js/videoPlayer.js` | composant lecteur + canvas, YouTube et fichier local | non (DOM) |
| `css/modules/videoPlayer.css` | mise en forme, superposition stricte du canvas | — |

**Repères enregistrés** — dans le document `startAnalyses/{sessionId}_s{n}`, sous la clé `video` :

```js
video: {
  kind:      'youtube' | 'file',
  youtubeId: string | null,   // jamais l'id LOCAL de meeting.videos[]
  fileName:  string | null,   // NOM seul : aucun octet n'est téléversé
  startAt:   number | null,   // instant du départ, en secondes (3 décimales)
  turn1At:   number | null,   // image de mesure du 1er virage
  fps:       number | null,   // cadence mesurée, fichier local uniquement
}
```

`meeting.videoTimecodes` n'est **pas modifié** : il reste lu comme amorce, et l'interface signale
explicitement qu'un timecode de meeting vise la première série de la session, pas celle qu'on
analyse. Dès qu'un `startAt` propre au départ existe, c'est lui qui prime.

**Contrat de l'overlay** — le point d'entrée du futur module de détection :

```js
player.renderBoxes([
  { driverId, carNumber, label, x, y, width, height, confidence, status },
]);
```

- coordonnées **normalisées 0..1 dans le repère de l'image**, jamais en pixels ;
- `status` ∈ `confirmed` (vert, trait plein) · `probable` (jaune, tirets, `confidence` affichée) ·
  `unknown` (gris) · `lost` (rouge) ;
- une boîte invalide ou entièrement hors image est **écartée**, pas dessinée au hasard — même
  règle que pour les positions : on n'invente rien ;
- `computeVideoRect()` reproduit `object-fit: contain`, donc les boîtes tombent dans l'image et
  jamais dans les bandes noires, à toute taille de lecteur, en plein écran et à tout ratio.

**Limites assumées de V0**

- **YouTube ne donne pas accès aux images.** Pas de vrai image par image : le pas fin retombe sur
  0,2 s, et les vitesses sont bornées à celles que l'API accepte (0,25 minimum). C'est une limite
  de la plateforme, pas du lecteur.
- Un **fichier local** donne tout : cadence mesurée par `requestVideoFrameCallback`, pas d'exactement
  une image, ralenti jusqu'à 0,1×, timecode à la milliseconde et numéro d'image.
- Le fichier local **n'est pas réattaché automatiquement** d'une session à l'autre : le navigateur
  interdit de rouvrir un chemin disque sans geste de l'utilisateur. Seul le nom est mémorisé, pour
  savoir quel fichier reprendre.

---

## 5. Plan de développement par phases

L'objectif : quelque chose d'utilisable dès la phase 1, l'automatisation seulement si elle prouve
son gain.

### Phase 1 — Statistiques + saisie manuelle · *fondation*

- `circuits` + normalisation de `meeting.location` (avec écran de rapprochement des alias).
- **`startAnalysisCalc.js` pur + tests**, cœur de la phase :
  - `enumerateStarts(session, results, participants, championship)` → la liste des départs
    physiques d'une session (N séries pour une MQ, 1 sinon) — **la fonction la plus importante du
    module** ;
  - `resolveGridGeometry(championship, sessionType, category)` → `{ gridLanes, gridRowsTotal,
    gridLayout, gridLayoutKey }` — **le règlement est l'unique source de vérité** (§4.10 A) ;
  - `placeOnGrid(gridPos, gridLayout)` → `{ gridRow, lane }` en reproduisant l'algorithme de
    `sessions.js` (tri des cellules par numéro, puis n-ième cellule), **pas** une inversion par
    valeur ;
  - `buildStartGrid(...)` → assemblage : MQ depuis `serie`/`couloir` ; QF/DF/FIN depuis la cascade
    puis `placeOnGrid` ;
  - `laneZone(lane, gridLanes)` → utilitaire d'affichage, dénominateur `gridLanes` (§4.10 A) ;
  - `normalizePoleSide(meeting.poleSide)` → orientation pour l'affichage ;
  - `finishPosInStart(rowsOfStart)` → rang par `ms` **au sein du départ** ;
  - `startDocId(sessionId, startIndex)`, `gridLayoutKey(gridLayout)` et
    `seriesFingerprint(driverIds)`.

  Cas de test à couvrir explicitement (§4.7) : grille en quinconce (vérifier que **P4 tombe en
  ligne 2**, et non dans le couloir 4), numéros de position non contigus, doublons de numéros,
  partants surnuméraires, `gridLayout` absent, série incomplète, et **deux championnats aux
  `gridLayout` différents sur le même type de session** — c'est le test qui garantit qu'on lit bien
  le règlement du championnat du meeting.
- Collection `startAnalyses` + règles (`rows.size() <= 12`).
- Vue « Analyse des départs » : Championnat → Meeting → Catégorie → **liste des départs
  physiques** (§4.9), grille et résultats pré-remplis, une seule colonne à saisir : V1.
  Validation explicite, départ par départ.
- Gestion explicite du cas `results.serie` non renseigné (regroupement manuel, jamais deviné).
- Persistance de `gridPos` / `lane` sur `sessionParticipants` pour les phases finales.

*Gain immédiat* : ~20–30 s par départ, sans vidéo, avec **15 à 27 départs disponibles par meeting
et par catégorie** selon le nombre d'engagés (§4.8). **Et surtout : les couloirs de MQ déjà en base
permettent de produire une première statistique d'effet de couloir dès la fin de cette phase, avec
zéro saisie nouvelle.**

### Phase 2 — Intégration vidéo · *lecteur + enchaînement des séries*

- **`videoTimecodes.js` n'est pas modifié** (§2.3) — il est seulement *lu*, comme amorce du
  timecode de la série 1.
- `videoPlayer.js` : lecteur YouTube (IFrame API, vitesse 0,25×) **et** lecteur de fichier local
  (`requestVideoFrameCallback`, image par image).
- **Marquage de `startSeconds` par départ** + suggestion progressive pour les séries suivantes
  (médiane des intervalles mesurés, §4.9) et mémorisation de `medianSeriesGap` par circuit.
- Enchaînement clavier Série 1 → Série 2 → … sans repasser par la sélection.
- Saisie de l'ordre V1 par clic dans l'image ou glisser-déposer ; enregistrement de
  `turn1Seconds`.

*Gain* : c'est ici que le volume arrive vraiment. La série 1 part d'un timecode déjà en base, les
suivantes d'une suggestion de plus en plus juste.

### Phase 3 — Repère visuel de sortie du virage 1

- Choix de **l'image de mesure** (`turn1Seconds`) et saisie de l'ordre sur cette image (§4.4).
- Ligne facultative en coordonnées normalisées, **repère visuel** et non détecteur.
- **Préréglages par circuit** réutilisables — d'autant plus rentables que les 6 séries d'une manche
  partagent le même plan de caméra.
- Saisie de `orderCompleteness` et blocage de la validation si `partial`.

*Gain* : cohérence de la mesure entre départs et entre opérateurs — condition d'une base comparable.
**Fin du chemin nécessaire : à l'issue de la phase 3, le module est complet et exploitable pour
toutes les courses, y compris celles disponibles uniquement sur YouTube.**

---

## 5 bis. Automatisation : conditionnelle, et hors du chemin principal

Les phases 4 à 6 ci-dessous **ne sont plus recommandées en l'état** pour de la vidéo de
retransmission. Justification mesurée dans `TRACKING-EVALUATION.md` ; en résumé :

- une séquence « feux verts → sortie V1 » de retransmission contient presque toujours **au moins une
  coupure**, et aucun tracker par apparence n'y survit (mesuré : 0/16 images) ;
- après une coupure, il faut **ré-ancrer les N voitures**, soit **N clics** — exactement le travail
  de la saisie manuelle, qui consiste à cliquer les N voitures dans l'ordre **une seule fois** ;
- une voiture sortie du cadre n'est **jamais** retrouvée par CSRT (mesuré : 0/39 images) ;
- les vidéos étant principalement sur YouTube, la voie automatique ne concernerait de toute façon
  qu'une **minorité** de départs (§4.3 et `TRACKING-EVALUATION.md` §3).

### Phase 4 (conditionnelle) — POC séparé, hors application

**Préalable indispensable** : disposer de fichiers vidéo locaux légitimes, et de préférence d'une
**source à caméra fixe** (`TRACKING-EVALUATION.md` §6.2 — c'est le levier déterminant, bien plus que
le choix de l'algorithme).

- `tools/rxstart-poc/`, dossier totalement séparé, jamais importé par l'application.
- Corpus couvrant les 10 scénarios réels, avec 3 / 5 / 8 voitures.
- Mesures : pertes, ré-ancrages, **échanges d'identité**, exactitude de l'ordre, temps humain — et
  comparaison au temps de la saisie manuelle sur les mêmes départs.
- **Critères de décision fixés à l'avance** (`TRACKING-EVALUATION.md` §8.3) : zéro échange
  d'identité non signalé, ≥ 70 % de départs sans ré-ancrage, < 10 s de temps humain, ≥ 90 % d'ordres
  exacts.

*Résultat le plus probable : « ne pas intégrer » — ce qui serait un succès du POC, pas un échec.*

### Phases 5 et 6 (conditionnelles) — intégration si et seulement si le POC valide

- Si le POC est concluant, l'outil retenu sera **YOLO + ByteTrack**, pas CSRT
  (`TRACKING-EVALUATION.md` §6.3) : la détection par image est structurellement plus robuste à la
  sortie de champ et à l'occultation.
- Association voiture ↔ pilote par géométrie de grille à t₀ puis confirmation par clic (§4.5).
- Ré-ancrage manuel après perte ou coupure, avec message explicite « voiture 12 perdue —
  ré-identification nécessaire », **jamais** de ré-attribution silencieuse.
- Mode lot produisant **exclusivement des `draft`**, et mesure du taux de désaccord avec les départs
  déjà validés à la main.

---

### Phase 7 — Validation et confiance

- Tableau de validation : pilote · grille · couloir · V1 détecté (avec 🟢/🟡/🔴) · arrivée ·
  correction.
- Signalement « voiture non détectée », correction d'un échange d'identité, note libre.
- Blocage de la validation tant qu'une ligne est 🔴 non traitée.
- Journalisation via `logAudit()`, comme le reste de l'application.

### Phase 8 — Statistiques avancées

- Vue `startStats` complète : matrices de transition, filtres croisés, comparaisons
  circuits / catégories / championnats / saisons / formats.
- Graphiques en **SVG inline**, comme `standings.js` le fait déjà — aucune bibliothèque de
  graphiques à ajouter.
- `n` et intervalles de Wilson partout ; normalisation par le rang intermédiaire pour isoler
  l'effet réel du couloir (§4.8).

---

## 6. Limites techniques anticipées

**Sur l'analyse vidéo** — désormais *mesurées*, voir `TRACKING-EVALUATION.md`

0. **Les vidéos étant principalement sur YouTube, l'analyse automatique ne concerne qu'une
   minorité de départs** : le lecteur YouTube n'expose pas ses pixels (origine croisée) et aucun
   téléchargement n'est envisagé (CGU). La saisie manuelle est donc le chemin **principal et
   permanent**, pas un repli.
1. **Les changements de plan sont la limite dure.** Aucun modèle d'apparence ne survit à un
   changement de point de vue sur une voiture large de 5 m. Détecter et demander un ré-ancrage
   est la seule réponse honnête.
2. **L'ordre image ≠ l'ordre piste** en sortie de virage si la ligne est mal orientée (§4.4).
3. **Poussière et projections** dégradent le tracking là où on en a le plus besoin — donc la
   confiance 🟡/🔴 servira réellement, ce n'est pas un ornement.
4. **Occlusion mutuelle dans le peloton** : le cas des deux voitures qui se croisent derrière une
   troisième restera un cas humain.
5. **Un abandon dans le virage 1** n'a pas de « position V1 » bien définie. Convention tranchée
   en §4.10 B : `turn1Pos = null`, départ conservé, ligne exclue des matrices.

**Sur les performances** (PC classique, 8 cœurs, sans GPU) — le calcul n'est jamais le goulot,
car on analyse ~10 s de vidéo par départ :

| Étape | Coût |
|---|---|
| Décodage 1080p | ~5 ms / image |
| CSRT, 8 pistes, 200 images | **15–40 s** par départ |
| YOLO11n ONNX, 640 px, CPU | ~10–15 ms / image → 3–5 s par départ |
| YOLO11s, CPU | ~60–150 ms / image → 15–40 s par départ |
| Détection de coupures | négligeable |

Le vrai coût n'est pas le temps de calcul, c'est **le poids d'installation** (50 Mo en CSRT,
~250 Mo en ONNX, ~2,5 Go avec `torch`) et **le nombre de clics humains**. D'où l'ordre des
phases.

**Licences** : OpenCV = Apache-2.0, ByteTrack d'origine = MIT, `supervision` = MIT — sans
problème. **`ultralytics` (YOLOv8/YOLO11) est en AGPL-3.0** : compatible avec ton usage local, et
compatible avec un dépôt public comme le tien, mais c'est une raison supplémentaire de ne
l'introduire qu'en phase 5, en connaissance de cause.

**Sur les statistiques**

6. **La position de grille est corrélée au niveau du pilote** en QF/DF/FIN (§4.8) — le biais le
   plus important, et il ne se corrige pas par plus de données, seulement par un meilleur modèle.
7. **Les tailles d'échantillon par circuit seront longtemps faibles** — nettement moins toutefois
   qu'avec un raisonnement par session (×3,9 à volume comparable, §4.8). D'où `n` et Wilson
   obligatoires, et le seuil d'affichage.
8. **Les formats diffèrent** entre championnats (nombre de couloirs, 3 lignes vs 2). Comparer
   « P4 » entre deux formats n'a pas toujours de sens ; la position **relative** (rang / taille de
   grille) est parfois la seule comparaison légitime.
9. **Les tailles de séries MQ sont inégales** (`[3,3,5,5,5,5]`) : les matrices de transition
   doivent être ventilées par `starters`, et les couloirs extérieurs reçoivent moins
   d'observations que les couloirs intérieurs (§4.10 A) — d'où le `n` par couloir et le filtre
   « séries complètes ».
10. **La composition des séries n'est pas persistée** par la V2 : elle vit dans `results.serie`,
    modifiable après coup. D'où `integrity.seriesFingerprint` (§4.7) — sans lui, une correction de
    saisie ultérieure rendrait une analyse validée silencieusement fausse.

**Non-régression**

11. `sw.js` maintient une liste d'assets explicite : tout nouveau fichier JS/CSS doit y être
    ajouté et `CACHE_NAME` incrémenté, sinon incohérences de cache après déploiement.
12. `videoTimecodes.js` **n'est pas modifié** (§2.3) : le risque de perte de clés par `saveAll()`,
    identifié dans une version antérieure de ce document, n'existe plus. Corollaire à respecter :
    **ne jamais ajouter de champ dans `meeting.videoTimecodes`** sans corriger d'abord `saveAll()`.
13. Le nombre de départs par manche dépend de `getSeriesStructure(nbParticipants)`, donc du nombre
    de **participants du jour**. Si un participant est ajouté ou retiré après une analyse, la
    structure des séries peut changer → c'est exactement ce que `seriesFingerprint` détecte.

---

## 7. Récapitulatif des décisions proposées

| Question posée | Réponse proposée |
|---|---|
| **Unité du modèle** | **le départ physique**, jamais la session : MQ = N séries = N départs ; QF/DF/FIN = 1 grille = 1 départ |
| **ID déterministe** | `startAnalyses/${sessionId}_s${startIndex}` — `startIndex` = n° de série (MQ) ou 1 |
| **Pilotes d'une série MQ** | `results` filtrés sur `sessionId` + `serie`, avec leur `couloir` ; cas « série non renseignée » traité explicitement |
| **Granularité de `videoTimecodes`** | 1 case par (session × catégorie) = **début de la 1ʳᵉ série seulement**. Sémantique **inchangée**, module non modifié |
| **Timecodes des séries 2..N** | dans `startAnalyses.video.startSeconds`, saisis pendant la navigation, pré-remplis par médiane des intervalles |
| **Arrivée d'un départ MQ** | `finishPosInStart` (rang dans la série, comparable) **et** `finishPosInSession` (rang manche entière, réglementaire) |
| **Unité statistique** | le départ ; deux compteurs affichés : `n` départs et `n` observations pilote |
| Technologies d'analyse vidéo | **aucune** sur le chemin principal (phases 1–3). Automatisation : **YOLO ONNX + tracking JS + ReID en ensemble fermé, dans le navigateur** (`AUTOMATION-ARCHITECTURE.md`) |
| YOLO + ByteTrack pertinent ? | **Oui**, en ensemble fermé avec ReID assistée : mesuré 86 % d'identifications correctes après coupure, 0 erreur silencieuse. La caméra fixe reste un atout, plus une condition |
| Réellement automatisable | grille, couloir, résultat final (**déjà en base**), détection, tracking sur fenêtre courte sans coupure, franchissement, confiance, statistiques |
| À garder semi-manuel | choix des instants, association voiture→pilote, placement de la ligne, **validation finale** |
| Identification des voitures | géométrie de grille à t₀ + clic de confirmation ; signature couleur en garde-fou ; OCR écarté |
| Pertes de tracking | métriques brutes → 🟢/🟡/🔴 ; un 🔴 bloque la validation ; le moteur n'écrit jamais `validated` |
| Définition du virage 1 | **ordre lu sur une image choisie** ; la ligne devient un repère visuel, stockée par circuit (§4.4, révision 5) |
| Ordre de passage | saisi par l'humain sur l'image de mesure ; `orderCompleteness` trace la visibilité réelle des voitures |
| Modifications de base | 1 collection `startAnalyses` (**par départ**), 1 collection `circuits`, 2 champs additifs sur `sessionParticipants`, 1 champ `localVideos` sur `meetings`, 2 blocs de règles. **Aucune migration, `videoTimecodes` intact.** |
| Intégration de Python | **aucune** — analyse **dans le navigateur** (ONNX Runtime Web), application toujours statique et sans build (révision 6) |
| Service séparé ou intégré ? | **Intégré**, tout dans Rallycross V2. Service Python écarté (installation + fragilité *Private Network Access*). Tauri = option future sans coût d'attente |
| Performances **mesurées** | CSRT 8 voitures 1080p : 212 ms/image → ~53 s pour 10 s à 25 fps. KCF : ~8 s. Le calcul n'est jamais le facteur limitant |
| Vue statistiques | vue dédiée `startStats` (axe d'agrégation différent de `stats.js`), conventions UI réutilisées |
| **Emplacement UI** | **1 tuile** d'accueil + entrée « Gestion » pour la saisie ; entrée de menu sous 📊 Statistiques pour les stats, **sans modifier `stats.js`** en phase 1 (§4.11) |
| **Position sportive vs physique** | `gridPos` (sportif) **et** `gridRow` + `lane` (physique) sont conservés séparément ; sur une grille en quinconce, P4 est en ligne 2 (§4.7) |
| **Source de vérité de la géométrie** | **le règlement du championnat** (`sessionConfig[type].gridLayout`), résolu via `meeting.championshipId`. Le circuit ne fournit que les presets vidéo et `medianSeriesGap` ; l'orientation vient de `meeting.poleSide`, déjà en base (§4.10 A) |
| **Sémantique de `gridPos`** | MQ : index de couloir, aucune hiérarchie. Finales : rang de qualification. **Jamais agrégés ensemble** — ventilation par `gridSource` (§4.8) |
| **Comparaison des couloirs** | uniquement à `gridLayoutKey` identique ; `laneZone` et la position relative sont les seuls axes transversaux (§4.8) |
| **Couloirs d'une série incomplète** | **couloirs physiques fixes** : remplissage depuis le couloir 1, `laneZone` calculé sur `gridLanes` (réglementaire, §4.10 A) |
| **Abandon avant V1** | `turn1Pos = null`, départ conservé et validable, ligne exclue des matrices mais comptée dans le taux d'incident (§4.10 B) |
| **Seuil de rentabilité de l'automatisation** | ~11 500–14 400 départs en temps pur → **ne pas justifier les phases 4–6 par la vitesse**, mais par la qualité (§3.1) |
| **Facteur limitant réel** | la **couverture vidéo**, pas le modèle de données — à suivre comme indicateur dès la phase 1 (§4.8) |
| **Dépendances de l'automatisation** | `opencv-contrib-python-headless` (⚠️ pas `opencv-python` : OpenCV 5 a retiré CSRT/KCF du module de base) + `numpy` = **272 Mo**, Apache 2.0 + BSD, 0 € |
| **Sortie de champ / coupure** | CSRT ne récupère **jamais** (mesuré 0/39 et 0/16). Perte **détectée de façon fiable** → ré-ancrage manuel, jamais de ré-attribution silencieuse |
| **Levier réel pour automatiser** | l'**ensemble fermé** (3–8 pilotes connus) + les signaux métier : +20 % d'automatisation mesurés pour quelques dizaines de lignes. Une caméra fixe reste un atout complémentaire |
| **Confiance** | **marge d'appariement** (hongrois), calibrée empiriquement pour que 🟢 signifie ≥ 99 % d'exactitude mesurée — jamais un score brut de modèle |
| **Poids des modèles** | ~25 à 45 Mo, chargés à la demande et **jamais** dans `ASSET_PATHS` de `sw.js` |
