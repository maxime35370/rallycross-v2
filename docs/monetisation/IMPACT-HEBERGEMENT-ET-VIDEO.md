# Impact du changement d'hébergement — et intégration de l'analyse vidéo

Document d'aide à la décision, suite de `ANALYSE-FAISABILITE.md`.
**Aucun code écrit, aucune modification de `main`.**
État audité : branche `main`, commit `c9f7dfe`.

---

## 0. Correction préalable, et elle change la conclusion

**Le site n'est pas hébergé sur GitHub Pages. Il est sur Netlify** — `rxchrono.netlify.app`.

Preuves dans le dépôt, que j'aurais dû aller chercher la première fois :

| Source | Contenu |
|---|---|
| `docs/video-analysis/ARCHITECTURE.md` §1.1 | « Hébergement : Netlify (`rxchrono.netlify.app`) + compatibilité GitHub Pages » |
| `overlay/_lib/obs-control.js:40` | `spectatorBaseUrl: 'https://rxchrono.netlify.app'` |
| `index.html:34` | instructions Cloudflare Analytics pour `rxchrono.netlify.app` |
| `index.html:342` | détection du sous-dossier `/rallycross-v2/` — **compatibilité** GitHub Pages, pas usage |

`ANALYSE-FAISABILITE.md` a été corrigé en conséquence. Ce que cela change :

> **La migration vers Firebase Hosting n'est pas obligatoire.** Je l'avais présentée comme
> une conséquence forcée du lot C, sur la base d'une contrainte GitHub Pages qui n'existe pas
> ici. Netlify sait parfaitement ne publier qu'un sous-dossier. La migration reste
> **souhaitable** — pour une raison plus simple, exposée en §2.3 — mais c'est un confort,
> pas un prérequis. Et elle n'est sur le chemin critique d'**aucun** autre lot.

Ton intuition était donc juste sur les deux points : la migration seule est simple, et le vrai
travail est le backend et la séparation des modules premium.

**Et une découverte au passage, qui vaut d'être signalée :** Netlify publie aujourd'hui la racine
du dépôt. Cela signifie que `https://rxchrono.netlify.app/docs/qualification-projection/ANALYSE.md`
et `/docs/video-analysis/AUTOMATION-ARCHITECTURE.md` sont **très probablement lisibles
publiquement** — soit l'intégralité de ta méthode, de tes mesures de backtest et de ton
architecture. À vérifier d'un simple `curl`. Ce n'est pas grave aujourd'hui ; ça le devient le
jour où tu vends l'outil. C'est corrigé gratuitement par n'importe laquelle des deux options du §2.

---

# PARTIE 1 — HÉBERGEMENT

## 1. Scénario A — migration Netlify → Firebase Hosting, **seule**

### 1.1 Difficulté : **simple**

Le front est 100 % statique, sans build, sans bundler, sans dépendance npm en runtime, et le
routage est **par hash** (`#spectator?meeting=…`). Ce sont exactement les trois propriétés qui
rendent une migration d'hébergeur triviale : il n'y a ni route serveur, ni réécriture, ni étape
de compilation à reproduire.

### 1.2 Fichiers et configurations concernés

| Fichier | Action | Pourquoi |
|---|---|---|
| `firebase.json` | **à créer** | déclare le dossier public, les `ignore`, les en-têtes de cache |
| `.firebaserc` | **à créer** | associe le dossier au projet `rallycross-1512f` |
| `.github/workflows/deploy.yml` | **à créer** | remplace le déclenchement automatique Netlify |
| `overlay/_lib/obs-control.js:40` | 1 ligne | `spectatorBaseUrl` par défaut |
| document Firestore `obsControl` | 1 champ | la valeur réellement utilisée à l'antenne |
| **OBS, sur ta machine** | sources navigateur à re-pointer | `overlay/live.html`, `control.html` |
| `index.html:342` | *rien* | la détection GitHub Pages devient inutile mais reste inoffensive |
| `manifest.json` | *rien* | `start_url: "/"` fonctionne à la racine des deux hébergeurs |
| `sw.js` | *rien* | voir §1.7 |
| `js/qrcode.js` | *rien* | `window.location.origin` → les QR suivent l'hôte automatiquement |

**C'est tout.** Aucun module applicatif, aucune vue, aucun calcul.

### 1.3 Ce qui change dans le déploiement

| | Aujourd'hui | Après |
|---|---|---|
| Déclencheur | push sur `main` → Netlify construit (configuré dans l'interface Netlify, **aucun `netlify.toml` au dépôt**) | push sur `main` → GitHub Action → `firebase deploy --only hosting` |
| Étape de build | aucune | aucune |
| Durée | ~30 s | ~40–60 s |
| Aperçu des PR | Deploy Previews Netlify | *preview channels* Firebase (équivalent) |
| Rollback | 1 clic, historique conservé | 1 clic, ou `firebase hosting:rollback` |

**Oui, GitHub reste le dépôt principal, et oui, GitHub Actions remplace intégralement le
déclenchement Netlify.** L'action officielle `FirebaseExtended/action-hosting-deploy` fait le
travail ; il faut un secret `FIREBASE_SERVICE_ACCOUNT` (compte de service, généré depuis la
console Firebase). C'est le seul élément nouveau à sécuriser.

Conseil : **déployer l'hébergement depuis GitHub Actions, mais les Cloud Functions à la main**
(`firebase deploy --only functions`) au moins au début. Moins de droits dans le CI, moins de
surface de casse, et une fonction se déploie rarement.

### 1.4 Firebase Hosting peut-il servir l'application actuelle sans réécriture ?

**Oui, à l'identique.** C'est un serveur de fichiers statiques sur CDN, comme Netlify. Les modules
ES, les `import()` dynamiques vers `gstatic.com`, l'iframe YouTube, le SDK Firebase : tout est
inchangé.

**Deux pièges à connaître, et ils sont réels :**

1. **Ne PAS ajouter la réécriture SPA.** Le réflexe est d'écrire
   `"rewrites": [{ "source": "**", "destination": "/index.html" }]`. **Ici, c'est nuisible** :
   l'application route par hash, donc elle n'en a aucun besoin, et cette règle transformerait
   toute URL erronée en page d'accueil silencieuse — y compris une faute de frappe dans une
   source navigateur OBS, qui afficherait l'app au lieu d'une erreur visible. Laisse le 404.
2. **Les en-têtes de cache par défaut diffèrent.** Firebase Hosting sert les fichiers statiques
   avec `Cache-Control: max-age=3600` par défaut, là où Netlify sert le HTML en
   `max-age=0, must-revalidate`. Comme `sw.js` est en **network-first**, un JS mis en cache une
   heure par le navigateur produirait exactement le symptôme que ton commentaire dans `sw.js`
   dit vouloir éviter (« fini le JS servi périmé après un merge »). **Il faut donc déclarer
   explicitement** `Cache-Control: no-cache` pour `index.html`, `sw.js` et `manifest.json`.
   C'est trois lignes de `firebase.json`, mais l'oublier crée un bug fantôme pénible.

### 1.5 URLs et routes qui changent

| | Change ? |
|---|---|
| **Origine** (`rxchrono.netlify.app` → `xxx.web.app`) | **oui** |
| Chemins (`/overlay/live.html`, `/index.html`) | non |
| Routes applicatives (`#spectator?meeting=…&category=…`) | non |
| QR codes **générés** par l'app | non — `js/qrcode.js` utilise `window.location.origin` |
| QR codes **déjà imprimés / partagés** | **oui, ils deviennent obsolètes** |
| URL du QR dans les overlays OBS | **oui** — `obsControl.spectatorBaseUrl` |

**Recommandation forte : prends un nom de domaine maintenant** (~12 €/an). Un domaine à toi
rend cette migration invisible pour les spectateurs et te rend définitivement libre de changer
d'hébergeur à l'avenir. C'est le seul vrai coût de cette opération, et il ne se paie qu'une fois.

### 1.6 Conséquences du changement d'origine (à ne pas sous-estimer)

Un navigateur cloisonne tout par origine. Changer d'origine remet à zéro, **pour chaque
utilisateur et sur chaque appareil** :

- le **service worker** (ré-enregistrement, re-téléchargement du pré-cache) ;
- le **cache** de la PWA, et la PWA installée (à réinstaller depuis la nouvelle URL) ;
- **`localStorage`** — donc `rx_firebase_config`, `rx_active_championship`, `rx_anthropic_key`
  (**ta clé API Anthropic est à ressaisir**), `rx_mq_agg_mode` ;
- **IndexedDB**, donc le cache Firestore hors ligne (`persistentLocalCache`), reconstruit au
  premier chargement.

Aucune donnée métier n'est perdue — tout est dans Firestore. Mais **fais-le en semaine, pas la
veille d'un meeting**, et prévois de ressaisir la clé Anthropic et de re-pointer OBS.

### 1.7 Service worker : compatible sans modification

`sw.js` est **déjà écrit pour être indépendant de l'hôte** :

```js
const base = self.registration.scope;
const urls = ASSET_PATHS.map((p) => new URL(p, base).href);
```

Les chemins sont relatifs au scope, jamais absolus. Le fichier fonctionne à la racine comme dans
un sous-dossier — le commentaire d'en-tête le dit explicitement. **Rien à changer.**

La seule discipline à conserver : **incrémenter `CACHE_NAME`** (`rx-chrono-v38` aujourd'hui) au
déploiement de bascule, pour purger proprement l'ancien cache.

### 1.8 Cache et mode hors ligne : conservés à l'identique

La stratégie actuelle est préservée telle quelle :

- pré-cache explicite de ~70 assets à l'installation ;
- **network-first** sur les assets locaux → les mises à jour sont prises immédiatement ;
- repli sur le cache hors ligne ;
- Firestore et `gstatic.com` **jamais interceptés** (choix délibéré, documenté dans le fichier) ;
- overlays en network-first.

Un point technique à surveiller : le SW ne remet en cache que les réponses
`response.type === 'basic'`, c'est-à-dire **même origine**. Sur Firebase Hosting comme sur
Netlify, le site reste servi depuis une seule origine → comportement identique. Aucun risque.

### 1.9 Fichiers statiques : aussi simples, et un gain concret

Aussi simples — c'est le même modèle. Avec **un vrai bénéfice** : la liste `ignore` de
`firebase.json` permet d'exclure du déploiement ce qui n'a rien à y faire :

```
"ignore": ["firebase.json", "**/.*", "**/node_modules/**",
           "docs/**", "tests/**", "tools/**", "overlay/demo/**"]
```

Aujourd'hui Netlify publie la racine, donc `docs/` (300 ko de tes analyses), `tests/`, `tools/`
et `overlay/demo/` (**6,1 Mo de captures PNG**) sont déployés et probablement accessibles. Cette
seule ligne règle le point signalé au §0 et allège le déploiement de plus de 6 Mo.

### 1.10 Performances : équivalentes, avec un gain marginal si backend

Les deux sont des CDN mondiaux avec HTTP/2 et compression Brotli. Pour un site de ce poids,
**l'écart est imperceptible**.

Un seul gain mesurable, et seulement dans le scénario B : si le backend tourne sur Cloud
Functions, Firebase Hosting permet une réécriture `/api/**` vers la fonction, donc un appel
**en même origine** — plus de résolution DNS supplémentaire, plus de négociation TLS séparée,
plus de préflight CORS. Sur une 4G saturée de paddock, cela retire de l'ordre de **100 à 300 ms
au premier appel**. Modeste, mais dans le bon sens, et précisément au moment qui compte.

### 1.11 Coûts supplémentaires réels

| Poste | Netlify aujourd'hui | Firebase Hosting |
|---|---|---|
| Hébergement statique | gratuit (100 Go/mois) | gratuit — Spark : 10 Go stockés, **360 Mo/jour** de transfert |
| Au-delà | payant | Blaze : **0,026 $/Go** stocké, ~0,15 $/Go transféré |
| Domaine | ~12 €/an | ~12 €/an |
| Certificat TLS | inclus | inclus |

⚠️ **Le plafond Spark de 360 Mo/jour est réel.** L'application pèse environ 1,5 Mo la première
visite → ~240 chargements complets par jour. Un dimanche de meeting avec beaucoup de
spectateurs peut s'en approcher. Le passage en Blaze (imposé de toute façon dès qu'il y a des
Cloud Functions) supprime le plafond, et le coût correspondant reste de l'ordre de **quelques
centimes par mois**.

**Coût réel de la migration seule : ~12 €/an de domaine, et rien d'autre.**

### 1.12 Risques de régression

| Risque | Gravité | Traitement |
|---|---|---|
| En-têtes de cache par défaut → JS périmé après un merge | **moyenne** | déclarer `no-cache` sur `index.html`/`sw.js` (§1.4) |
| Réécriture SPA ajoutée par réflexe | moyenne | ne pas en mettre |
| Overlays OBS pointant l'ancienne URL en plein direct | **élevée si mal calé** | migrer hors week-end de meeting, tester OBS avant |
| QR imprimés obsolètes | moyenne | domaine personnalisé → problème inexistant |
| `localStorage` vidé, clé Anthropic perdue | faible | la noter avant |
| Plafond de transfert Spark | faible | passer en Blaze |
| PWA installée à réinstaller | faible | la prévenir |

### 1.13 Rollback

**Simple, à trois niveaux :**

1. **Sans DNS** : `firebase hosting:rollback` ou un clic dans la console → version précédente
   restaurée en secondes, l'historique des versions est conservé.
2. **Avec domaine personnalisé** : repointer l'enregistrement DNS vers Netlify. Effet en quelques
   minutes à quelques heures selon le TTL — **abaisse le TTL à 300 s deux jours avant la
   bascule**, c'est la seule précaution qui compte.
3. **Filet de sécurité** : **ne supprime pas le site Netlify** pendant au moins un mois. Il
   continue de se déployer depuis `main` sans rien coûter, et reste une adresse de repli
   immédiatement fonctionnelle.

Point rassurant : le service worker étant **network-first**, un retour en arrière est pris en
compte au premier chargement en ligne. Aucun utilisateur ne reste bloqué sur une version morte.

### 1.14 Estimation

| Étape | Durée |
|---|---|
| `firebase.json` + `.firebaserc` + en-têtes | 1 h |
| GitHub Action de déploiement | 1 h |
| Domaine personnalisé + DNS + TLS | 1 h (+ propagation) |
| Re-pointage OBS, `obsControl`, tests overlays | 1 h |
| Vérification (spectateur, PWA, hors ligne, QR, overlays) | 1–2 h |

> ### **Scénario A : SIMPLE — une demi-journée à une journée. Risque faible. ~12 €/an.**

---

## 2. Scénario B — migration **+ backend sécurisé** pour Stratégie Live

### 2.1 Le point essentiel : les deux décisions sont indépendantes

C'est la correction la plus utile de ce document.

|  | Migration d'hébergement | Backend Cloud Functions |
|---|---|---|
| Nécessaire à l'autre ? | **non** | **non** |
| Peut se faire seul ? | **oui** | **oui** |

Le SDK Firebase appelle une fonction `onCall` **depuis n'importe quelle origine** : `httpsCallable`
gère le CORS et l'envoi du jeton d'authentification tout seul. Tu peux donc garder Netlify et
avoir un backend Firebase. Cela fonctionne, et c'est même la voie la moins perturbante.

### 2.2 La vraie contrainte n'est pas l'hébergeur, c'est « ne pas publier le moteur »

Rappel de `ANALYSE-FAISABILITE.md` §2 : tant que `js/projection/*.js` est servi publiquement,
tout verrou est décoratif. Il faut que ces fichiers **cessent d'être déployés**. Trois façons :

| Voie | Comment | Verdict |
|---|---|---|
| **Netlify, sous-dossier publié** | `netlify.toml` : `publish = "public"`, puis déplacer *tout le site* dans `public/` et laisser le moteur dehors | fonctionne, **aucun build** — mais gros déplacement de fichiers |
| **Netlify, redirection forcée** | `/js/projection/* /404 404!` dans `_redirects` | **à écarter** : le fichier est toujours déployé, seule une règle le masque. Une erreur de configuration le rouvre |
| **Firebase Hosting, `ignore`** | `"ignore": [..., "js/projection/**"]` | **une ligne, aucun fichier déplacé** |

### 2.3 D'où la vraie raison de migrer

Ce n'est ni la performance, ni le prix, ni une impossibilité technique de Netlify. C'est que
`firebase.json` sait dire « ne déploie pas ces fichiers » en une ligne, là où Netlify demande de
restructurer le dépôt.

Dit autrement : **le jour où tu fais le lot C, migrer coûte moins cher que ne pas migrer.**
Tant que tu ne fais pas le lot C, migrer n'apporte rien d'indispensable.

### 2.4 Où mettre le backend

| | Cloud Functions (Firebase) | Netlify Functions |
|---|---|---|
| Vérification du jeton Firebase Auth | **automatique** (`onCall`) | à écrire, avec `firebase-admin` |
| Clé de compte de service Firebase | inutile | **à confier à Netlify** en variable d'environnement |
| **Déclencheurs Firestore** (`onWrite` sur `results`) | **oui** | **non — impossible** |
| Délai maximal | 60 s (configurable jusqu'à 60 min en gen 2) | 10 s en synchrone |
| Instances chaudes (`minInstances`) | oui | non |
| Dépendances npm | dans `functions/`, sans toucher au site | idem |

Le déclencheur Firestore est **éliminatoire** : le cache `strategyContexts` (`ANALYSE-FAISABILITE.md`
§11), qui fait passer un appel stratégique de ~8 000 lectures à 1–3, en dépend directement. Sans
lui, le modèle économique du backend s'effondre.

> **Cloud Functions, quel que soit l'hébergeur du front.**

### 2.5 Ce que le lot C ajoute, concrètement

| Élément | Nature |
|---|---|
| `functions/` + `package.json` + `firebase-admin` | **première dépendance npm en runtime du projet** |
| Déplacement de 7 modules vers `functions/engine/` | mécanique — ils tournent déjà sous Node (`tools/qualification-audit/`) |
| Contrat JSON entre la fonction et `projectionStats.js` | **le vrai travail** |
| Retrait des mêmes fichiers de `ASSET_PATHS` dans `sw.js` | 13 lignes — **à ne surtout pas oublier** |
| `strategyContexts` + déclencheur `onWrite` | nouveau |
| Mode dégradé hors ligne (§1.8 devient un sujet) | nouveau — voir §2.6 |

**Le point dur reste le même** : `projectionStats.js` appelle une quinzaine de fonctions pures en
leur passant des objets riches. Geler cela en un contrat JSON stable sans appauvrir l'écran
opérationnel, c'est là que se trouvent les 5 à 8 jours, pas dans le déplacement des fichiers.

⚠️ **Le lot C introduit une étape de build** — pas pour le site, mais pour `functions/`
(`node_modules`, déploiement packagé). La propriété « aucun build » du front est préservée ; celle
du dépôt ne l'est plus tout à fait. C'est le prix, il est modeste, mais il est réel.

### 2.6 Le lot C casse partiellement le mode hors ligne, et il faut l'accepter

Aujourd'hui, Stratégie Live fonctionne **entièrement hors ligne** après un premier chargement :
moteur pré-caché, données dans le cache persistant Firestore. C'est une propriété que tu utilises
peut-être sans y penser en bord de piste.

Après le lot C, l'objectif stratégique **exige le réseau**. Le reste de l'application (saisie,
classements, spectateur, historique) reste hors ligne.

Atténuations, à intégrer dès la conception et non après coup :

- réponse de quelques kilo-octets → passe sur un réseau très dégradé ;
- **mise en cache locale de la dernière réponse**, réaffichée avec son horodatage et une mention
  explicite « figé à HH:MM » ;
- nouvelle tentative automatique, jamais d'écran blanc ;
- `minInstances: 1` les week-ends de meeting contre les démarrages à froid.

C'est le coût réel de la sécurisation. Il se paie en fiabilité de terrain, et il n'y a pas de
version de cette architecture qui l'évite.

### 2.7 Estimation

| Étape | Durée | Difficulté |
|---|---|---|
| A — migration hébergement | 0,5–1 j | simple |
| Mise en place `functions/`, premier `onCall`, secrets, CI | 1 j | simple |
| Portage du moteur + contrat JSON + adaptation de la vue | **4–6 j** | **élevée** |
| `strategyContexts` + déclencheur + invalidation | 1–2 j | moyenne |
| Retrait du site publié + `sw.js` + vérification (« le moteur est-il encore téléchargeable ? ») | 0,5 j | simple mais **critique** |
| Mode dégradé hors ligne | 1 j | moyenne |

> ### **Scénario B : COMPLEXE — 8 à 11 jours au total, dont A représente moins d'une journée.**

---

# PARTIE 2 — ANALYSE VIDÉO DES DÉPARTS

## 3. Ce qui existe déjà — et c'est beaucoup plus que tu ne le dis

L'audit donne un résultat inattendu : **le lecteur vidéo intégré est déjà construit, et le point
d'accroche pour YOLO est déjà écrit.**

`js/videoPlayer.js`, en-tête du fichier :

> Deux sources, une seule interface : **YouTube** → iframe officielle ; **fichier local** →
> `<video>`, *l'octet ne quitte jamais la machine*. Le canvas d'overlay est superposé à l'image
> **dès maintenant**, alimenté par `renderBoxes()`. V0 ne lui envoie rien : **c'est le futur
> module YOLO qui l'utilisera, sans qu'il faille reconstruire le lecteur.**

Concrètement, sont **déjà en place** :

| Brique | Où | État |
|---|---|---|
| Sélection d'un fichier local, jamais téléversé | `videoPlayer.js:275` — `URL.createObjectURL(file)` | ✅ |
| Lecture image par image, vitesses variables | `videoPlayerCalc.js` — `stepTime`, `ratesFor` | ✅ |
| Mesure réelle de la cadence | `videoPlayer.js:307` — `requestVideoFrameCallback` | ✅ |
| Canvas de surimpression aligné sur l'image | `computeVideoRect`, `projectBox` | ✅ |
| **API de boîtes** en coordonnées normalisées 0..1, avec `driverId`, `carNumber`, `confidence`, `status` ∈ `confirmed\|probable\|unknown\|lost` | `videoPlayer.js:408` — `renderBoxes()` | ✅ |
| Vue « Analyse des départs » branchée dessus | `startAnalysis.js` | ✅ |
| Enregistrement des résultats sans vidéo | `startAnalyses`, id `${sessionId}_s${startIndex}` | ✅ |

C'est le **V0** du plan `AUTOMATION-ARCHITECTURE.md` §14 : il est fait. Ce qui manque est V1
(détection) et au-delà.

## 4. Réponses à tes dix questions

**1. Peut-on intégrer une page « Analyse vidéo » dans Rallycross V2 ?**
Elle **existe déjà** — c'est la vue « 🎥 Analyse des départs ». Il n'y a pas de page à créer :
il y a un moteur à brancher sur un lecteur qui l'attend.

**2. Fichier local, sans envoi sur un serveur ?**
**Oui, déjà implémenté.** `URL.createObjectURL(file)` produit une URL `blob:` valable uniquement
dans l'onglet ; aucun octet ne part. La contrainte YouTube que tu cites reste vraie et
insurmontable : une iframe cross-origin ne donne pas ses pixels. D'où la double source déjà
prévue — YouTube pour se repérer et saisir, fichier local pour analyser.

**3. Réutiliser le moteur actuel quasiment tel quel ?**
**Attention à une confusion :** il n'y a pas de moteur vidéo aujourd'hui. `bench_reid.py` et
`bench_trackers.py` sont des **bancs de mesure** qui ont servi à décider (86 % d'identifications
correctes après coupure, 0 erreur silencieuse) — ce n'est pas du code d'exécution, et il ne sera
pas réutilisé tel quel. Ce qui est réutilisé, et c'est l'essentiel : **le lecteur, le canvas, le
contrat de boîtes, et les conclusions mesurées**. Le moteur JS reste à écrire (~300 lignes
d'association + 2 modèles ONNX).

**4. Bibliothèques et modèles à charger**

| Composant | Rôle | Licence | Poids |
|---|---|---|---|
| ONNX Runtime Web | inférence | MIT | ~10–15 Mo |
| YOLO11n / YOLOv8n ONNX | détection | **AGPL-3.0** | ~12 Mo |
| *ou* YOLOX-tiny ONNX | détection | **Apache 2.0** | ~15 Mo |
| OpenCV.js *(option)* | compensation de mouvement caméra | Apache 2.0 | ~8–10 Mo |
| OSNet ONNX *(option)* | ReID | Apache 2.0 | ~9 Mo |
| Tracking + descripteur + hongrois | ton code | — | 0 |

> ⚠️ **Conséquence directe de la monétisation, non signalée jusqu'ici.** L'AGPL-3.0 d'Ultralytics
> est sans conséquence tant que le projet est un dépôt public gratuit. **Dès que tu vends
> l'accès**, l'AGPL impose de publier le code source de l'ensemble du service à tout utilisateur.
> **Si tu monétises, prends YOLOX-tiny (Apache 2.0) dès le départ.** Changer de détecteur plus
> tard signifie recalibrer tous les seuils.

**5. Impact sur la taille de l'application et le service worker**
Sur l'application : **nul**, à condition de respecter la règle déjà écrite dans
`AUTOMATION-ARCHITECTURE.md` §1 — les modèles ne vont **jamais** dans `ASSET_PATHS`. Ils sont
téléchargés au premier usage du module et rangés dans IndexedDB ou dans un cache dédié.

> **Mais `sw.js` doit être adapté, et ce point n'est pas dans le document existant.** Le gestionnaire
> `fetch` actuel intercepte **toutes** les requêtes GET de même origine et les remet en cache sous
> `CACHE_NAME`. Un modèle de 12 Mo servi depuis ton origine y atterrirait, et serait **purgé à
> chaque incrément de `CACHE_NAME`** — donc re-téléchargé à chaque déploiement. Deux corrections
> possibles : exclure `/models/` du gestionnaire générique (comme `gstatic.com` l'est déjà), ou
> servir les modèles depuis un autre hôte. **Petite modification, mais nécessaire.**

**6. Chargement uniquement à l'ouverture de la page ?**
**Oui, et c'est déjà le patron du projet.** `loadApp()` et le SDK Firebase utilisent partout
`await import()`. Un `await import('./video/detector.js')` au premier clic sur « analyser »
n'ajoute rien au reste du site. Le mode spectateur et les overlays OBS ne téléchargent rien.

**7. Le fichier vidéo peut-il rester strictement local ?**
**Oui, sans réserve.** Rien dans la chaîne ne le transmet. Amélioration possible :
`showOpenFilePicker()` renvoie un `FileSystemFileHandle` **stockable dans IndexedDB**, ce qui
permet de rouvrir le même fichier d'une session à l'autre sans le re-sélectionner (Chrome/Edge ;
repli sur `<input type="file">` ailleurs).

**8. Enregistrer les résultats dans Firestore sans la vidéo ?**
**Oui — c'est déjà exactement ce que fait le module.** `startAnalyses` stocke `rows` (≤ 16 par
les règles), `sessionId`, `startIndex`, `status: draft|validated`, avec un identifiant
déterministe. Ce qui est enregistré, ce sont des positions et des couloirs, jamais une image.
**Aucune modification du modèle de données.**

**9. Web Worker ?**
**Oui, et c'est recommandé.** Le patron : le thread principal reste maître du `<video>` (un
Worker n'y a pas accès), capte l'image via `requestVideoFrameCallback` → `createImageBitmap`, et
la transfère au worker en *transferable* (copie zéro). Le worker exécute ONNX Runtime Web —
supporté en worker, WebGPU compris sur Chrome récent — et renvoie les boîtes, que le thread
principal passe à `renderBoxes()`.

Nuance utile : l'analyse est **préalable** sur une fenêtre d'environ 10 s (`AUTOMATION-ARCHITECTURE.md`
§2), pas en temps réel pendant la lecture. Le worker sert donc surtout à garder une barre de
progression fluide, pas à sauver le produit.

**10. WebGPU / WebGL / ONNX Runtime Web / TensorFlow.js ?**
Le projet n'utilise **aucune** de ces technologies aujourd'hui — zéro dépendance npm en runtime,
aucun code d'apprentissage automatique. Le choix du document existant est le bon :

- **ONNX Runtime Web** : format visé par les bancs de mesure, licence MIT, se charge en module ES
  **sans npm et sans build** — exactement comme le SDK Firebase aujourd'hui ;
- **WebGPU** en premier (~10–30 ms/image estimées), **repli automatique WASM SIMD** (~80–250 ms),
  et **afficher lequel est actif** ;
- **TensorFlow.js** imposerait une conversion de modèles et un runtime plus lourd, sans bénéfice ;
- **le backend WebGL d'ORT Web** est en voie d'abandon au profit de WebGPU : ne pas le viser.

Même dans l'hypothèse la plus pessimiste, une fenêtre de 10 s à 25 im/s reste **sous la minute**
par départ.

## 5. La nouvelle architecture aide-t-elle ? — réponse honnête : **très peu**

**Tout ce qui précède fonctionne aujourd'hui, sur Netlify, sans rien changer.** Ton intuition est
exacte : le changement d'hébergement n'est pas nécessaire à l'analyse vidéo.

Ce qu'il apporte réellement, et c'est limité à trois choses :

1. **Les en-têtes COOP/COEP.** `SharedArrayBuffer` — donc le **WASM multi-thread** d'ORT Web,
   2 à 4× plus rapide quand WebGPU n'est pas disponible — exige
   `Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp`.
   C'est une configuration d'en-têtes, faisable **sur les deux hébergeurs**.
   > ⚠️ **Piège majeur** : COEP `require-corp` **casse l'iframe YouTube**. Il faut donc appliquer
   > ces en-têtes **uniquement au chemin de la page d'analyse**, ou utiliser
   > `credentialless` (Chrome seulement). C'est faisable des deux côtés, mais c'est le genre de
   > détail qui fait perdre une journée quand on le découvre en cours de route.
2. **L'authentification et les licences** autour de la fonctionnalité — le vrai lien, traité au §7.
3. **Servir les modèles depuis ton propre domaine** plutôt qu'un CDN tiers, ce qui rend le
   fonctionnement hors ligne complet et prévisible.

En résumé : **fais V1 quand tu veux, indépendamment de tout le reste.**

---

# PARTIE 3 — VARIANTE SERVEUR DE L'ANALYSE VIDÉO

## 6. Comparaison locale vs serveur

| Critère | **Analyse locale (navigateur)** | **Analyse serveur** |
|---|---|---|
| **Coût** | **0 €.** Le CPU/GPU est celui de l'utilisateur | Cloud Run CPU ≈ 0,006 $/départ ; **avec GPU 0,60–2 $/h**. Stockage 0,026 $/Go/mois, egress 0,12 $/Go |
| **Complexité** | moyenne — ORT Web + ~300 lignes. **Aucune infrastructure** | **élevée** — téléversement repris, file d'attente, workers, cycle de vie du stockage, reprise sur erreur, purge |
| **Vitesse** | WebGPU ~3–8 s / départ ; WASM 20–60 s | inférence plus rapide, mais **dominée par le téléversement** |
| **Confidentialité** | **totale** — l'octet ne quitte pas la machine | tu héberges de la vidéo de retransmission appartenant à des tiers |
| **Taille des fichiers** | indifférente : on ne lit que la fenêtre utile | **le facteur bloquant** — 1 à 4 Go par vidéo de meeting |
| **Limites Firebase** | aucune | Functions gen 2 : 60 min, **pas de GPU** → il faut Cloud Run. Storage : 5 Go gratuits |
| **Stockage** | néant | à gérer : durée de conservation, purge, coût qui court |
| **Bande passante** | néant | montante saturée côté utilisateur, egress facturé côté serveur |
| **Expérience** | résultat immédiat, hors ligne possible | téléverser, attendre, revenir |
| **Longues vidéos** | **sans problème** — voir ci-dessous | **le pire cas** |

## 7. L'argument qui tranche le débat

Il tient en une phrase, et il est structurel :

> **Tu n'analyses qu'environ 10 secondes de vidéo par départ.**

- **En local**, le navigateur se positionne directement sur ces 10 secondes du fichier de 3 Go et
  ne lit rien d'autre. Le reste du fichier ne coûte rien — ni temps, ni mémoire, ni réseau.
- **Sur un serveur**, il faut **transférer les 3 Go entiers** pour atteindre ces 10 secondes. Sur
  une connexion montante domestique à 10 Mb/s, c'est **40 minutes** — pour 10 secondes utiles.

La seule façon d'éviter ce transfert serait de découper le clip localement avant de l'envoyer…
ce qui suppose de traiter la vidéo en local. **On revient au point de départ.**

Il faut ajouter un argument non technique mais sérieux : héberger des extraits de retransmission
télévisée sur tes serveurs te place dans une position de **rediffusion** vis-à-vis du détenteur
des droits. Tant que le fichier reste sur le disque de l'utilisateur, la question ne se pose pas.

> **Verdict : ta préférence est la bonne architecture, et pas de peu.**
> Vidéo locale → analyse locale → seuls les résultats partent dans Firestore.
> Ce n'est pas un compromis budgétaire : c'est le meilleur choix sur presque tous les critères.

**Le seul cas où le serveur garde un sens** : ré-analyser en lot une archive que tu possèdes déjà,
sans interaction. Et même là, la bonne réponse n'est pas le cloud — c'est ta propre machine, ou
l'enveloppe Tauri déjà évoquée en `AUTOMATION-ARCHITECTURE.md` §3, qui donne l'accès disque direct
et un moteur natif sans rien téléverser.

---

# PARTIE 4 — MONÉTISER AUSSI L'ANALYSE VIDÉO ?

## 8. La réponse franche : non, pas de la même façon

Et pour une raison structurelle qu'il faut comprendre avant de bâtir dessus.

Pour Stratégie Live, la solution était de déplacer le calcul là où l'utilisateur ne peut pas
l'atteindre. **Pour la vidéo, c'est impossible** : le calcul doit se faire là où sont les pixels,
et les pixels sont sur le disque de l'utilisateur. Les déplacer, c'est retomber sur la §7 qui
vient de démontrer que ça ne marche pas.

**Donc : si l'analyse est locale, le moteur est chez l'utilisateur, point final.**

## 9. Ce qui est réellement protégeable — et ce qui ne l'est pas

| Élément | Protégeable ? | Pourquoi |
|---|---|---|
| ONNX Runtime Web | **non** | MIT, public, sur tous les CDN |
| Poids YOLO / YOLOX | **non** | modèles publics, librement téléchargeables. En restreindre l'accès est du théâtre |
| Descripteur de livrée + hongrois (~300 lignes) | **non** | s'exécute dans le navigateur, donc lisible. Et re-dérivable |
| **Seuils calibrés** (V4 : marges, coûts, a priori d'ordre) | **partiellement** | quelques dizaines de nombres, mais ce sont eux qui font passer de 60 % à 86 % — et ils **peuvent** vivre côté serveur |
| **Statistiques de couloir/grille agrégées** | **oui** | même nature que Stratégie Live : de l'agrégat sur un corpus |
| **Le corpus `startAnalyses` validé** | **oui, à condition de le fermer** | c'est ton actif réel |

Le raisonnement à retenir : **la valeur de l'analyse vidéo n'est pas le détecteur, c'est le
corpus validé qu'elle produit et les statistiques qu'on en tire.** Le détecteur trouve des
rectangles — n'importe qui peut en télécharger un. Ce que personne d'autre ne possède, c'est
« 400 départs annotés, validés, sur ce championnat, avec le couloir et la position au premier
virage ».

⚠️ **Une réserve importante** : `startAnalyses` est aujourd'hui en `allow read: if true`. Le
corpus est donc **public**, et l'agrégat reproductible. Le fermer casserait la vue publique
« 📈 Stats des départs ». C'est **exactement le même arbitrage** qu'au §2.1 de
`ANALYSE-FAISABILITE.md`, et il se tranche de la même manière : garder le descriptif public,
mettre côté serveur ce qui est réellement décisionnel.

## 10. Les options, classées par rapport valeur/effort

| Option | Effet réel | Effort | Recommandation |
|---|---|---|---|
| **Interface verrouillée** | dissuade le curieux, rien d'autre | ~0 | acceptable ici, contrairement à Stratégie Live |
| **Modèle derrière un jeton de licence** (URL signée, courte durée, après vérification serveur) | fait passer le contournement de « aucun effort » à « ouvrir les outils de développement » | ~0,5 j | **utile en complément**, jamais comme argument de vente |
| **Seuils calibrés servis par une fonction** | le moteur nu marche mal sans eux ; c'est le seul élément vraiment discriminant qu'on puisse retenir | ~0,5 j | **oui, si tu monétises la vidéo** |
| **Statistiques agrégées côté serveur** | protège la valeur réelle | inclus dans le lot C | **oui** |
| **Moteur d'inférence serveur** | protège tout | — | **non** : §7 le démontre infaisable |
| **Enveloppe Tauri signée** | protège un peu mieux, offre l'accès disque | ~3–5 j | plus tard, et pour d'autres raisons |

## 11. Recommandation commerciale

**Vends l'ensemble, pas la brique.** Une licence team pour le Pilote X donnerait :

| Fonction | Protection réelle |
|---|---|
| Stratégie Live | **forte** (calcul serveur) |
| Projection de qualification | **forte** (calcul serveur) |
| Statistiques de couloir/grille sur corpus validé | **forte** (agrégat serveur) |
| Historique du pilote | moyenne (données publiques) |
| **Outil d'analyse vidéo** | **faible — et c'est acceptable** |

L'outil vidéo est un **outil de production**, pas un produit. Il fait gagner du temps à celui qui
annote. Ce que le team achète, c'est l'objectif stratégique et les statistiques — et ceux-là sont
réellement protégés. Vouloir verrouiller le détecteur reviendrait à dépenser des jours pour
protéger une brique publique.

**Et surtout : ne fais pas dépendre ton prix de la protection de la vidéo.** Si demain quelqu'un
extrait ton moteur d'annotation, il obtient un outil qui dessine des rectangles — sans ton corpus,
sans tes seuils, sans tes statistiques.

---

# PARTIE 5 — CONCLUSION

## 12. Les dix réponses demandées

| # | Question | Réponse |
|---|---|---|
| 1 | **Difficulté migration Hosting seule** | **SIMPLE.** ½ à 1 journée. Créer `firebase.json`, `.firebaserc`, une GitHub Action ; re-pointer OBS et `obsControl`. Aucun code applicatif. Deux pièges : en-têtes de cache, réécriture SPA à ne pas ajouter. |
| 2 | **Difficulté Hosting + backend** | **COMPLEXE.** 8 à 11 jours, dont la migration représente **moins d'une journée**. Le coût est dans le portage du moteur et le contrat JSON, pas dans l'hébergement. |
| 3 | **Risques** | Migration : OBS en direct sur l'ancienne URL, en-têtes de cache, `localStorage` vidé (clé Anthropic). Backend : perte du mode hors ligne pour la stratégie, oubli du retrait des fichiers publiés, contrat JSON qui appauvrit l'écran. |
| 4 | **Coût** | Migration : **~12 €/an** (domaine). Backend : **~0 €/mois** aux trois échelles, +1–10 €/mois si instance chaude permanente. |
| 5 | **Compatibilité** | **Totale.** Site statique, routage par hash, `sw.js` relatif au scope, `qrcode.js` fondé sur `window.location.origin`. Aucune réécriture. Seule l'origine change. |
| 6 | **Analyse vidéo intégrée ?** | **Déjà commencée.** V0 est en place : lecteur, fichier local, image par image, canvas et `renderBoxes()` attendent le moteur. Reste V1 : ORT Web + YOLOX + ~300 lignes, ~2–3 jours. |
| 7 | **Meilleure architecture vidéo** | **La tienne.** Fichier local → analyse locale (WebGPU, repli WASM, Web Worker) → seuls les résultats dans `startAnalyses`. Le serveur perd sur tous les critères sauf la vitesse brute d'inférence, elle-même annulée par le téléversement. |
| 8 | **Impact sur le hors ligne** | Migration : **aucun** — `sw.js` est déjà indépendant de l'hôte. Vidéo : **aucun**, à condition que les modèles n'entrent jamais dans `ASSET_PATHS` (et une petite adaptation du gestionnaire `fetch`). Backend : **la stratégie perd le hors ligne**, c'est le prix à payer. |
| 9 | **Monétiser la vidéo ?** | **Dans un lot, oui. Isolément, non.** Le moteur ne peut pas être protégé — les pixels sont chez l'utilisateur. Ce qui se protège, c'est le corpus validé, les seuils calibrés et les statistiques agrégées. |
| 10 | **Ordre recommandé** | Voir §13. |

## 13. Ordre d'implémentation recommandé

| Rang | Étape | Durée | Dépend de | Pourquoi ici |
|---|---|---|---|---|
| **1** | **Audit `personId`** (script en lecture seule) | 1 h | rien | Conditionne l'estimation de tout le lot licences. Une heure qui peut faire économiser une semaine. |
| **2** | **Lots A + B** — comptes, teams, licences, écran admin, licence offerte | ~1 sem. | rien | **Permet de vendre à la main avant Lohéac.** Aucun backend, aucun Stripe, aucune migration. |
| **3** | **Vidéo V1** — détection ORT Web + YOLOX | 2–3 j | rien | **Totalement indépendant.** À glisser quand tu veux. Le lecteur l'attend. |
| **4** | **Migration Hosting** (scénario A) | ½–1 j | rien | À faire **juste avant** le lot C : c'est là qu'elle devient rentable. Hors week-end de meeting. |
| **5** | **Lot C** — moteur serveur | 5–8 j | 2 et 4 | Le vrai verrou. **À ne lancer qu'avec un client payant en vue.** |
| **6** | **Lot D** — paiement Stripe | 2–3 j | 2, 5 | Automatise ce que tu faisais à la main. |
| **7** | **Vidéo V2–V4** — tracking, ReID, calibration | 7–8 j | 3 | Au rythme des besoins. Chaque lot est utile seul. |

**Trois remarques sur cet ordre :**

- **Rien n'est bloqué par l'hébergement.** Il n'apparaît qu'au rang 4, et uniquement parce qu'il
  facilite le rang 5.
- **Les rangs 2 et 3 peuvent se faire en parallèle** : ils ne touchent aucun fichier commun.
- **Le rang 5 est le seul engagement lourd.** Tout ce qui le précède garde sa valeur même si tu
  décides de ne jamais monétiser.

## 14. Ce que je ferais à ta place, dans l'ordre

1. Un `curl https://rxchrono.netlify.app/docs/qualification-projection/ANALYSE.md` — pour savoir
   si ta méthode est publique. Trente secondes.
2. L'audit `personId`. Une heure.
3. Les lots A + B avant Lohéac, pour pouvoir offrir un accès en trois clics.
4. Lohéac : montrer l'outil, offrir deux ou trois accès, écouter.
5. **Ensuite seulement** décider de la migration, du backend et du paiement — avec des retours
   réels plutôt que des hypothèses.

Et si l'envie te prend de coder pendant l'attente : **la vidéo V1**. C'est indépendant de tout,
le lecteur l'attend, et c'est la partie la plus agréable du projet.
