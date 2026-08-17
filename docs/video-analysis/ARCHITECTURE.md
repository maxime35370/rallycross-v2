# Module « Analyse des départs » — Analyse du projet et architecture d'intégration

> Document d'architecture. **Aucun code applicatif n'est écrit à ce stade.**
> Source de vérité : le dépôt `maxime35370/rallycross-v2` inspecté sur la branche `main`
> (commit `75d641d`).

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
(`renderMqCouloirGraph`). Le champ `couloir` est borné par la taille de la série
(`validateMeta`) : une manche = **une seule ligne** de N voitures côte à côte, donc pour les MQ
`position de grille ≡ couloir`.

### 1.4 État des données : qu'est-ce qui manque vraiment ?

| Donnée voulue | Déjà disponible ? | Où / comment |
|---|---|---|
| Championnat | ✅ | `championships` + `meeting.championshipId` |
| Saison | ✅ | `year`, dénormalisé sur presque tous les documents |
| Circuit | ⚠️ | `meeting.location` — **texte libre, à normaliser** |
| Catégorie | ✅ | `category`, dénormalisé partout |
| Session / course | ✅ | `sessions` (`type` + `num`) |
| Format / règlement | ✅ | `championships.sessionConfig` + `competitionPhases` |
| Pilotes engagés | ✅ | `engagements`, `sessionParticipants` |
| Grille MQ + couloir | ✅ | `results.serie` + `results.couloir` |
| Géométrie de grille (lignes × couloirs) | ✅ | `sessionConfig.{QF,DF,FIN}.gridLayout` |
| Grille QF/DF/FIN par pilote | ⚠️ | **calculée à la volée** dans `sessions.js` depuis la cascade de qualification, **jamais persistée** |
| Position finale | ✅ | **calculée à la volée** par `calcPhaseStandings()` (`standings.js`) : tri par `ms` croissant, puis DNF classés via `manualPosition`, puis DSQ/DNS |
| Vidéo + timecode de départ par (session × catégorie) | ✅ | `meeting.videos[]` + `meeting.videoTimecodes{}` |
| **Position à la sortie du premier virage** | ❌ | **c'est la seule donnée réellement absente** |

Il ne manque donc que **trois** choses, et une seule est difficile :

1. **L'ordre à la sortie du virage 1** → nouvelle donnée à produire (§4).
2. **La grille QF/DF/FIN persistée** → aujourd'hui affichée puis perdue ; il faut la figer au
   moment de l'analyse pour que la statistique soit reproductible.
3. **La normalisation des circuits** → `location` est du texte libre ; « Lohéac », «Loheac»,
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
| Granularité ? | Une entrée par (type de session, numéro, catégorie) → **exactement la granularité d'une course** |
| Sémantique du timecode ? | **Le début de la course** — donc déjà le point d'ancrage dont l'analyse a besoin |
| Données stockées | Sur le document `meetings` : `videos[]` et `videoTimecodes{}` |
| Interface réutilisable ? | **Le modèle de données : oui, à 100 %. L'interface : non.** |

### 2.3 Recommandation : **étendre le modèle, séparer l'interface**

**Étendre le modèle de données** — c'est le bon ancrage, il serait absurde d'en créer un second :

```js
// meeting.videoTimecodes[key] — champs existants conservés, ajouts optionnels
{
  videoId:       "u17",   // existant — inchangé
  seconds:       4521,    // existant — début de course, inchangé
  turn1Seconds:  4528.4,  // AJOUT : sortie du virage 1 (optionnel)
  localVideoId:  "lv3"    // AJOUT : réf. vers un fichier local (optionnel)
}

// meeting.localVideos[] — AJOUT : descripteurs de fichiers locaux, JAMAIS le fichier
[{ id:"lv3", label:"Finale Supercar", fileName:"loheac-2026-fin-sc.mp4",
   size:184320512, durationMs:612000, fps:50, fingerprint:"a91c…" }]
```

Tous les ajouts sont **optionnels** : un meeting existant reste valide, `videoTimecodes.js`
continue de fonctionner sans modification. Il faudra juste que sa fonction `saveAll()` préserve
les nouvelles clés au lieu de les écraser (elle reconstruit aujourd'hui un objet propre en ne
gardant que `{videoId, seconds}` — **c'est le seul vrai point de vigilance de non-régression du
projet**).

**Ne pas réutiliser l'interface**, en revanche : `videoTimecodes.js` est un *éditeur de masse*
(remplir 60 timecodes vite), alors que l'analyse de départ est un *poste de travail sur une
course* (lecteur, ligne virtuelle, tableau de validation). Deux usages, deux ergonomies. Les
fusionner rendrait les deux moins bons.

**Facteur commun à extraire** : un petit module pur `js/videoRefs.js` avec
`getRaceVideoRef(meeting, sessionType, num, category)` / `setRaceVideoRef(...)`, utilisé par
`videoTimecodes.js` **et** par le nouveau module. Une seule source de vérité sur la forme des
clés, testable dans `tests/`.

---

## 3. La question centrale : a-t-on besoin d'une IA complexe ?

**Non. Et le §1.4 le démontre chiffres en main.**

Le raisonnement :

- La grille est connue (stockée pour les MQ, calculable pour QF/DF/FIN).
- Le couloir est déductible de la grille par arithmétique sur `gridLayout`.
- Le résultat final est déjà calculé par `calcPhaseStandings()`.
- Le timecode de début de course est déjà saisi pour les courses déjà « timecodées ».

Il ne reste donc à produire **qu'une seule donnée par course : l'ordre de ~8 voitures à un seul
instant.** Ce n'est pas un problème de vision par ordinateur, c'est **une lecture ordinale
unique**.

### 3.1 Le calcul de rentabilité qu'il faut faire avant de coder du YOLO

| Approche | Travail humain / course | Coût de développement | Dépendances |
|---|---|---|---|
| Lecture manuelle avec un bon scrubber | **15–30 s** | ~2 jours | aucune |
| OpenCV multi-tracker amorcé par clics | 10–15 s | ~3 jours | `opencv-contrib-python` (~50 Mo) |
| YOLO + ByteTrack + ré-identification | 5–15 s (+ vérification) | ~8–10 jours | `ultralytics` + `torch` (**~2,5 Go**) |

L'automatisation complète fait gagner ~20 s par course. À 8–10 jours de développement, le
seuil de rentabilité est de l'ordre de **1 000 à 1 500 courses analysées**. Tu n'y seras pas
avant plusieurs saisons.

**Conclusion : la valeur est dans les phases 1 à 3, pas dans le YOLO.** Un bon lecteur avec
avance image par image et saisie d'ordre par clic te donne une base statistique réelle en
quelques soirées. 200 courses × 25 s ≈ **1 h 20 de saisie** pour un échantillon déjà
statistiquement exploitable.

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

Pour ce problème précis, un **multi-tracker OpenCV amorcé par clics** (`TrackerCSRT`, ou
`TrackerKCF` si la vitesse compte) est meilleur que YOLO + ByteTrack :

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
│    ├─ js/videoPlayer.js        ← NOUVEAU  YouTube + fichier │
│    └─ js/videoRefs.js          ← NOUVEAU  partagé avec      │
│                                            videoTimecodes.js│
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

### 4.2 Python : moteur auxiliaire, contrat par fichier JSON

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
  "video":  { "fileName": "loheac-2026-fin-sc.mp4", "fps": 50,
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

### 4.4 Définition du virage 1 : un préréglage par circuit, pas par course

Tu cliques deux points sur l'image → segment `A`–`B` en coordonnées normalisées. Mais le stocker
**par course** serait une erreur : tu le ressaisirais 30 fois pour Lohéac. Il faut le stocker
**par circuit** (`circuits/{circuitKey}.presets[]`), avec un libellé et un indice de plan de
caméra. Après la première course de Lohéac, la ligne est déjà là pour les 30 suivantes.

**Calcul du franchissement** : signe du produit vectoriel (B−A) × (P−A), où `P` est le
**centre-bas de la boîte** (la zone de contact au sol, la plus stable en perspective). Le
changement de signe entre deux images encadre l'instant ; une **interpolation linéaire** donne
un temps de franchissement bien plus fin qu'une image, ce qui compte quand deux voitures passent
à 40 ms d'écart. L'ordre est le tri par temps interpolé.

**Limite honnête à connaître** : l'ordre de franchissement d'une ligne *dans l'image* n'égale
l'ordre réel de course que si la ligne est à peu près perpendiculaire à la trajectoire et si les
voitures suivent des trajectoires comparables. En sortie de virage, une voiture à l'extérieur
peut couper une ligne image plus tôt tout en étant derrière. Trois mitigations :

1. placer la ligne **le plus loin possible après la corde**, là où le peloton s'est réaligné ;
2. préférer un plan de caméra à peu près perpendiculaire à la piste ;
3. **marquer 🟡 automatiquement** deux franchissements séparés de moins de ~100 ms alors que les
   voitures sont latéralement éloignées — le placement de la ligne y devient l'erreur dominante.

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

**Nouvelle collection `startAnalyses`** — un document par course, id déterministe = `sessionId`
(convention maison). Les lignes sont **imbriquées** : une course ≈ 8 lignes, largement sous la
limite de 1 Mio, et surtout **1 seule lecture par course** pour la statistique (une saison d'une
catégorie ≈ 30–60 documents).

```js
startAnalyses/{sessionId} = {
  // rattachement — dénormalisé comme partout ailleurs dans la V2
  sessionId, meetingId, championshipId, year, category,
  sessionType,            // 'MQ' | 'QF' | 'DF' | 'FIN'
  sessionNum,
  circuitKey,             // slug normalisé de meeting.location
  regulationKey,          // pour comparer les formats (ex. 'FFSA 2026')

  // géométrie effective de la grille pour cette course
  lanes, gridRows, gridSize,
  gridSource: 'mq_couloir' | 'grid_layout' | 'manual',

  status: 'draft' | 'validated',
  validatedAt, validatedBy,

  video: { kind: 'youtube' | 'local', videoId | localVideoId,
           startSeconds, turn1Seconds },

  analysis: { engine: 'manual' | 'opencv-csrt' | 'yolo-bytetrack',
              version, ranAt, warnings: [] },

  rows: [{
    driverId, carNumber,          // clés vers l'existant (pas de recopie d'identité)
    gridPos, lane, laneZone, gridRow,
    turn1Pos,                     // valeur validée par l'humain
    autoTurn1Pos,                 // ce que le moteur avait proposé (traçabilité)
    finishPos, finishStatus,      // figés à la validation, depuis calcPhaseStandings()
    confidence: 'green' | 'yellow' | 'red',
    corrected: false,
    note
  }],

  createdAt, updatedAt
}
```

Choix de conception à noter :

- **`finishPos` est figé à la validation**, pas recalculé à chaque affichage. Raison : le
  classement final dépend du règlement actif, qui peut évoluer ; une statistique historique doit
  être stable. `autoTurn1Pos` conservé à côté de `turn1Pos` permet de mesurer a posteriori le
  taux de correction humaine — donc la qualité réelle du moteur.
- **Aucune recopie de nom de pilote** au-delà de `carNumber` (nécessaire au rapprochement
  vidéo). `driverId` suffit pour rejoindre `drivers` / `persons`.

**Nouvelle collection `circuits`** (petite, ~20 documents) :

```js
circuits/{circuitKey} = {
  name: "Lohéac",
  aliases: ["Loheac", "LOHÉAC", "Lohéac-Bretagne"],
  firstTurnSide: 'left' | 'right',   // ← voir ci-dessous, c'est important
  presets: [{ label: "Plan tribune", videoHint: "…",
              lineA: {x:0.21,y:0.62}, lineB: {x:0.78,y:0.55} }]
}
```

**`firstTurnSide` est un point que personne n'anticipe et qui invaliderait tes comparaisons.**
« Intérieur » et « extérieur » n'ont de sens que **relativement au sens du premier virage** : sur
un circuit dont le virage 1 tourne à droite, l'intérieur est le côté droit de la grille ; à
gauche, c'est l'inverse. Sans ce champ, agréger « couloir intérieur » sur plusieurs circuits
mélangerait des situations opposées et le résultat serait faux. Avec lui, `laneZone` se calcule
proprement :

```
lane (1..lanes) + firstTurnSide + lanes  →  'inside' | 'middle' | 'outside'
```

à placer dans `startAnalysisCalc.js`, en fonction pure et testée.

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
    && hasFields(request.resource.data, ['sessionId','meetingId','year','category','status'])
    && request.resource.data.status in ['draft','validated']
    && request.resource.data.rows is list
    && request.resource.data.rows.size() <= 40;
}
match /circuits/{docId} {
  allow read:  if true;
  allow write: if isRegie();
}
```

**Index** : aucun. Conformément à la convention de `stats.js`, on requête sur `year`
(éventuellement + `status`) et on filtre championnat / circuit / catégorie côté client. Le volume
(quelques centaines de documents) le permet largement.

**Migration** : aucune. Tout est additif, rien n'est renommé, aucune donnée existante n'est
touchée.

### 4.8 Intégration dans les statistiques

`js/stats.js` est **orienté pilote** : lignes = pilotes, colonnes = meetings, filtré par
`year` + `category` + championnat actif. L'analyse des départs est **orientée position** : lignes
= positions de grille, agrégées sur des centaines de courses, et surtout **transversale aux
saisons et aux championnats** (tu veux comparer 2025 vs 2026, France vs Europe).

Ce sont deux axes d'agrégation incompatibles : forcer l'un dans l'autre produirait une vue
confuse. → **Vue dédiée `startStats`**, placée sous « Statistiques » dans le menu, mais qui
**réutilise** les conventions existantes : barre de filtres du même type, classes CSS `sta-*`,
`table-wrap`, tri par en-tête `data-sort`.

Filtres : Championnat → Saison → Circuit → Catégorie → Type de session → Position de grille →
Couloir, chacun avec « Tous ». Le règlement/format se déduit de `regulationKey`.

Indicateurs, tous dans `js/startStatsCalc.js` (pur, testé) :

- matrice de transition grille → V1, et grille → arrivée ;
- % de conservation de la tête, % de prise de tête par position de départ ;
- gain/perte moyen (et **médian** — la moyenne est sensible aux abandons) ;
- position moyenne en V1 et à l'arrivée par position de départ ;
- effet du couloir (intérieur / milieu / extérieur), avec `firstTurnSide` appliqué ;
- corrélation V1 ↔ arrivée (Spearman plutôt que Pearson : ce sont des rangs) ;
- comparaisons circuit / catégorie / championnat / saison / format ;
- **`n` affiché systématiquement**, et **intervalle de confiance de Wilson** sur chaque
  pourcentage. C'est peu de code et ça évite d'interpréter 3/4 = 75 % comme un résultat. Un
  pourcentage sous un seuil (`n < 10`) doit s'afficher en `n=4` grisé, sans pourcentage.

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

---

## 5. Plan de développement par phases

L'objectif : quelque chose d'utilisable dès la phase 1, l'automatisation seulement si elle prouve
son gain.

### Phase 1 — Statistiques + saisie manuelle · *fondation*

- `circuits` + normalisation de `meeting.location` (avec écran de rapprochement des alias).
- `startAnalysisCalc.js` pur + tests : `gridPos` → `(ligne, couloir)` via `gridLayout`,
  `lane` → `laneZone` via `firstTurnSide`, extraction de `finishPos` depuis la logique de
  `calcPhaseStandings()`.
- Collection `startAnalyses` + règles.
- Vue « Analyse des départs » : sélection Championnat → Meeting → Session, **grille et résultat
  final pré-remplis automatiquement**, une seule colonne à saisir : V1. Validation explicite.
- Persistance de `gridPos` / `lane` sur `sessionParticipants`.

*Gain immédiat* : chaque course saisie en ~20 s, sans vidéo. **Et surtout : les couloirs de MQ
déjà en base permettent de produire une première statistique d'effet de couloir dès la fin de
cette phase, avec zéro saisie nouvelle.**

### Phase 2 — Intégration vidéo · *extension de `videoTimecodes.js`*

- `videoRefs.js` partagé ; `videoTimecodes.js` mis à jour pour **préserver** les nouvelles clés.
- `videoPlayer.js` : lecteur YouTube (IFrame API, positionné sur le timecode déjà en base,
  vitesse 0,25×) **et** lecteur de fichier local (`requestVideoFrameCallback`, image par image).
- Bouton « ▶ Analyser le départ » depuis la vue Chronométrage, en réutilisant le timecode
  existant.
- Saisie de l'ordre V1 **par clic sur les voitures dans l'image**, ou par glisser-déposer des
  lignes ; enregistrement de `turn1Seconds`.

*Gain* : c'est ici que le volume de données arrive vraiment. Avec les courses déjà timecodées,
la saisie devient quasi immédiate.

### Phase 3 — Ligne virtuelle du virage 1

- Placement de la ligne par deux clics, en coordonnées normalisées.
- **Préréglages par circuit** réutilisables d'une course à l'autre.
- Superposition de la ligne sur le lecteur, pour lire l'ordre à l'œil de façon cohérente d'une
  course à l'autre. Toujours sans aucun code Python.

*Gain* : cohérence de la mesure entre courses et entre opérateurs — condition d'une base
comparable.

### Phase 4 — Détection / suivi assisté · *`tools/rxstart`, sans YOLO*

- CLI Python : `opencv-contrib-python` + `numpy` uniquement.
- Détection des changements de plan, extraction de la fenêtre, **multi-tracker CSRT amorcé par
  les boîtes cliquées**, franchissement de ligne avec interpolation sous-image, métriques de
  qualité, sortie JSON versionnée.
- Import du JSON par glisser-déposer dans l'application, pré-remplissage du tableau.
- Vidéo d'annotation en sortie (boîtes + ligne + numéros) pour vérifier d'un coup d'œil.

*Gain* : l'ordre est proposé et objectivé. Coût : ~50 Mo de dépendances, pas de modèle.

### Phase 5 — Association voiture ↔ pilote assistée

- Proposition automatique par géométrie à t₀ (§4.5) ; confirmation/correction par clic.
- Signature couleur et détection des permutations d'identité.
- **Décision d'ajouter YOLO ici, et seulement ici**, si l'amorçage manuel des boîtes s'avère être
  le vrai goulot d'étranglement — et alors uniquement pour proposer les boîtes initiales. Chemin
  léger recommandé : YOLO11n exporté en ONNX + `onnxruntime` (~250 Mo), plutôt que
  `ultralytics` + `torch` (~2,5 Go).

### Phase 6 — Proposition automatique de l'ordre V1

- Chaînage complet : fenêtre → tracking → franchissement → ordre proposé, avec ses confiances.
- Mode lot sur plusieurs courses, produisant **exclusivement des `draft`**.
- **Mesure du taux de désaccord** entre l'automatique et les courses déjà validées à la main :
  c'est le chiffre qui dira si les phases 4–6 valaient le coup, et il faut le mesurer, pas le
  supposer.

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

**Sur l'analyse vidéo**

1. **Les changements de plan sont la limite dure.** Aucun modèle d'apparence ne survit à un
   changement de point de vue sur une voiture large de 5 m. Détecter et demander un ré-ancrage
   est la seule réponse honnête.
2. **L'ordre image ≠ l'ordre piste** en sortie de virage si la ligne est mal orientée (§4.4).
3. **Poussière et projections** dégradent le tracking là où on en a le plus besoin — donc la
   confiance 🟡/🔴 servira réellement, ce n'est pas un ornement.
4. **Occlusion mutuelle dans le peloton** : le cas des deux voitures qui se croisent derrière une
   troisième restera un cas humain.
5. **Un abandon dans le virage 1** n'a pas de « position V1 » bien définie ; il faut une
   convention explicite (classer en dernier ? exclure ? — à trancher en phase 1, et à figer).

**Sur les performances** (PC classique, 8 cœurs, sans GPU) — le calcul n'est jamais le goulot,
car on analyse ~10 s de vidéo par course :

| Étape | Coût |
|---|---|
| Décodage 1080p | ~5 ms / image |
| CSRT, 8 pistes, 200 images | **15–40 s** par course |
| YOLO11n ONNX, 640 px, CPU | ~10–15 ms / image → 3–5 s par course |
| YOLO11s, CPU | ~60–150 ms / image → 15–40 s par course |
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
7. **Les tailles d'échantillon par circuit seront longtemps faibles.** D'où `n` et Wilson
   obligatoires, et le seuil d'affichage.
8. **Les formats diffèrent** entre championnats (nombre de couloirs, 3 lignes vs 2). Comparer
   « P4 » entre deux formats n'a pas toujours de sens ; la position **relative** (rang / taille de
   grille) est parfois la seule comparaison légitime.

**Non-régression**

9. Le seul risque réel identifié dans tout le projet : `videoTimecodes.js → saveAll()` reconstruit
   `videoTimecodes` en ne conservant que `{videoId, seconds}`. Sans correctif, ouvrir puis
   enregistrer cette modale **effacerait** les `turn1Seconds`. À traiter en phase 2, avec un test.
10. `sw.js` maintient une liste d'assets explicite : tout nouveau fichier JS/CSS doit y être
    ajouté et `CACHE_NAME` incrémenté, sinon incohérences de cache après déploiement.

---

## 7. Récapitulatif des décisions proposées

| Question posée | Réponse proposée |
|---|---|
| Technologies d'analyse vidéo | OpenCV en phase 4 ; YOLO **seulement** en phase 5 si le besoin est mesuré |
| YOLO + ByteTrack pertinent ? | Pas comme fondation : l'identité initiale est déjà connue à 100 %. Utile plus tard pour amorcer les boîtes |
| Réellement automatisable | grille, couloir, résultat final (**déjà en base**), détection, tracking sur fenêtre courte sans coupure, franchissement, confiance, statistiques |
| À garder semi-manuel | choix des instants, association voiture→pilote, placement de la ligne, **validation finale** |
| Identification des voitures | géométrie de grille à t₀ + clic de confirmation ; signature couleur en garde-fou ; OCR écarté |
| Pertes de tracking | métriques brutes → 🟢/🟡/🔴 ; un 🔴 bloque la validation ; le moteur n'écrit jamais `validated` |
| Définition du virage 1 | 2 clics → ligne normalisée, **stockée par circuit** et réutilisée |
| Ordre de passage | signe du produit vectoriel sur le centre-bas de boîte + interpolation sous-image |
| Modifications de base | 1 collection `startAnalyses`, 1 collection `circuits`, 2 champs additifs sur `sessionParticipants`, 2 blocs de règles. **Aucune migration.** |
| Intégration de Python | moteur **local auxiliaire**, échange par **fichier JSON**. L'application reste 100 % statique |
| Service séparé ou intégré ? | **Séparé et optionnel** — l'application doit fonctionner entièrement sans Python |
| Performances | 15–40 s par course en CSRT, 3–5 s avec YOLO ONNX. Le calcul n'est jamais le facteur limitant |
| Vue statistiques | vue dédiée `startStats` (axe d'agrégation différent de `stats.js`), conventions UI réutilisées |
