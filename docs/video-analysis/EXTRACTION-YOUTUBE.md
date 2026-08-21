# Extraction d'une manche depuis une retransmission YouTube — analyse de faisabilité

> Document d'analyse. **Aucun code applicatif n'est écrit à ce stade**, conformément à la demande.
> Il complète `ARCHITECTURE.md` (module Analyse des départs) et `AUTOMATION-ARCHITECTURE.md`
> (YOLO + tracking dans le navigateur) en traitant la brique manquante **en amont** de l'analyse :
>
> ```
> URL YouTube + début + fin  →  extraction locale  →  manche.mp4  →  lecteur V0  →  YOLOX
> ```
>
> **Statut des chiffres.** Deux catégories, jamais mélangées dans ce document :
> - ✅ **vérifié** — constaté dans le code source de yt-dlp `2026.08.19` installé et lu pendant
>   cette analyse, ou dans le code de `js/videoPlayer.js` / `js/videoPlayerCalc.js` du dépôt ;
> - 📐 **estimé** — calcul ou comportement documenté, **non mesuré**.
>
> **Limite honnête de cette analyse : l'extraction n'a pas pu être exécutée sur YouTube.**
> L'environnement d'analyse n'a pas d'accès sortant vers YouTube (la politique réseau répond `403`
> au `CONNECT` vers `www.youtube.com:443`). Les mécanismes ont donc été vérifiés **dans le code de
> yt-dlp**, puis **mesurés hors YouTube** — sur un fichier de contrôle servi en HTTP `Range` depuis
> la machine, avec exactement les arguments que yt-dlp construit (§2.4). Ce qui reste non vérifié,
> c'est le comportement des formats servis par `googlevideo.com`. Le §12 décrit le POC de
> 30 minutes qui le tranche, sur ta machine.

---

## Résumé exécutif

| Question posée | Réponse courte |
|---|---|
| 1. yt-dlp + FFmpeg convient-il ? | **Oui.** C'est l'outil exact pour ce besoin, sans détournement |
| 2. Peut-on ne récupérer que la plage utile ? | **Oui** ✅ — `--download-sections` bascule sur le téléchargeur ffmpeg, qui pose `-ss`/`-t` **avant** `-i` (seek HTTP par plages d'octets) |
| 3. Précision réellement obtenue | **À l'image** avec `--force-keyframes-at-cuts` — ✅ mesuré : 2650 images pour 53 s à 50 img/s, `start_time = 0`, **aucune image de pré-roll**. Sans lui : 100 images de pré-roll à timestamps négatifs, masquées par une edit list (§2.2) |
| 4. Quantité téléchargée | ✅ mesuré hors YouTube : **25,8 Mo sur 124 Mo** pour 53 s sur 400 s, en 2 requêtes `Range`. Transposé à une VOD de 6 h : 📐 **~0,3 %** |
| 5. Meilleure architecture | **Option A — script local**, avec passerelle *File System Access* en option A+. **Option B écartée** (Private Network Access), **Option C écartée** (déjà tranché en rév. 6) |
| 6. Compatibilité `videoPlayer.js` | **Totale** via `loadFile()`, à condition d'imposer **MP4 / H.264 / AAC / yuv420p / CFR / start_time = 0** |
| 7. Lien avec YOLOX | **Direct** : l'extrait est exactement l'entrée que `AUTOMATION-ARCHITECTURE.md` attend, et il fait *baisser* le coût d'analyse |
| 8. Difficulté | **Faible** : POC 30 min, outil utilisable ~1/2 journée, version intégrée ~1 journée |
| 9. Dépendances Windows | **2** : `yt-dlp` et `ffmpeg` (+ Node 22, déjà présent). **Pas de Python** |
| 10. Expérience visée | Coller URL + 2 timecodes → un fichier de ~30 Mo en **&lt; 1 min**, ouvert dans le lecteur |
| 11. Risque principal | **Opérationnel** (yt-dlp casse quand YouTube change → mise à jour régulière) et **juridique** (CGU YouTube) |
| 12. Verdict | ✅ **La brique est viable et vaut le POC.** Elle est même *plus simple* que ce que le workflow actuel impose |
| 13. Corpus YOLOX | **Le même outil peut produire les 5–6 images par départ** (départ → sortie V1), sans octet réseau supplémentaire — §13 |

**Le point le plus important de ce document** : le fichier vidéo n'est **pas** l'artefact à
conserver. L'artefact durable, c'est la **recette** (`youtubeId` + début + fin + identité de la
manche), qui tient en 200 octets, vit déjà pour partie dans Firestore (`meeting.videos`,
`meeting.videoTimecodes`), se partage, et permet à n'importe quelle machine de **régénérer**
l'extrait à l'identique. Le `.mp4` est un fichier de travail local, jetable. Cette inversion règle
d'un coup le stockage, la synchronisation, le partage et la conformité.

---

## 1. Ce que fait réellement `--download-sections` — vérifié dans le code

Trois affirmations souvent répétées à tort circulent sur cette option. Voici ce que dit le code de
yt-dlp `2026.08.19`, lu pendant cette analyse.

### 1.1 L'option force le téléchargeur ffmpeg ✅

`yt_dlp/downloader/__init__.py`, `_get_suitable_downloader()` :

```python
if (info_dict.get('section_start') or info_dict.get('section_end')) and FFmpegFD.can_download(info_dict):
    return FFmpegFD
```

Dès qu'une section est demandée, **le téléchargeur natif est court-circuité** au profit de
`FFmpegFD`. C'est aussi pour ça que l'aide indique `Needs ffmpeg` : sans ffmpeg dans le `PATH`,
l'option ne fonctionne pas.

### 1.2 Le seek est posé **avant** `-i`, donc côté entrée ✅

`yt_dlp/downloader/external.py`, construction de la ligne de commande :

```python
if start_time:
    args += ['-ss', str(start_time)]
if end_time:
    args += ['-t', str(end_time - start_time)]
...
args += [*self._configuration_args((f'_i{i + 1}', '_i')), '-i', url]
```

`-ss` / `-t` **précèdent** `-i <url googlevideo>`. C'est le point décisif : ffmpeg exécute alors un
*seek d'entrée*, et sur une URL HTTP il le fait par **requêtes `Range`**. Il lit l'index du
conteneur (`moov` / `sidx`, en tête de fichier), calcule l'octet correspondant à l'instant demandé,
et **ne télécharge que la fenêtre utile**. Il ne parcourt pas les 5 heures 42 précédentes.

> ⚠️ Ce mécanisme suppose un flux **seekable**. Sur les formats adaptatifs YouTube (DASH servi en
> `Range` sur `googlevideo.com`), il l'est. Sur un vrai HLS live sans index, il ne le serait pas —
> voir §3.3.

### 1.3 La copie sans réencodage n'est **pas** précise ✅ / 📐

Toujours dans `external.py` :

```python
if not (start_time or end_time) or not self.params.get('force_keyframes_at_cuts'):
    args += ['-c', 'copy']
```

Traduction :

| Mode | Ligne ffmpeg produite | Conséquence |
|---|---|---|
| `--download-sections` **seul** | `-ss T0 -t D -i URL -c copy` | ✅ ultra rapide, ❌ **le fichier commence à l'image-clé précédant T0** |
| `--download-sections` **+ `--force-keyframes-at-cuts`** | `-ss T0 -t D -i URL` (pas de `-c copy` → réencodage) | 📐 quelques secondes de CPU, ✅ **coupe à l'image exacte** |

La raison du second cas : depuis ffmpeg 2.1, un `-ss` d'entrée **suivi d'un réencodage** effectue
un *accurate seek* — ffmpeg se cale sur l'image-clé précédente, **décode puis jette** les images
jusqu'à l'instant demandé, et n'écrit la première image de sortie qu'à `T0`. On garde donc
l'économie de bande passante (`-ss` reste côté entrée) **et** on obtient la précision.

### 1.4 Le format des timestamps accepte directement `05:42:26` ✅

Vérifié en exécutant le parseur de yt-dlp hors ligne (`yt_dlp.utils.parse_duration`, appelé par
`parse_chapters` sur les plages `*début-fin`) :

| Saisie | Secondes |
|---|---|
| `05:42:26` | `20546` |
| `5:42:23` | `20543` |
| `5:43:13` | `20593` |

**Aucune conversion à faire côté outil** : les timecodes lus sur YouTube se passent tels quels.
La syntaxe complète est `--download-sections "*05:42:26-05:43:10"` (l'astérisque = plage de temps
et non chapitre ; les deux bornes acceptent `H:MM:SS`, `MM:SS` ou un nombre de secondes).

### 1.5 Vidéo et audio séparés : un seul appel ffmpeg ✅

Sur YouTube, un format 1080p est *adaptatif* : piste vidéo et piste audio ont des URL distinctes.
`FFmpegFD` boucle sur `selected_formats`, applique `-ss`/`-t` **à chaque entrée**, puis ajoute les
`-map` correspondants. Le téléchargement des deux plages **et** le multiplexage se font donc en une
seule commande, sans fichier intermédiaire et sans dérive de synchronisation.

---

## 2. Précision : ce qu'on obtient vraiment

### 2.1 Les trois notions à ne pas confondre

1. **Précision de la borne** — l'extrait commence-t-il exactement à `05:42:26` ?
2. **Précision de l'origine** — l'instant `t = 0` du fichier local correspond-il à un instant
   *connu* de la vidéo source ? C'est ce qui permet de convertir « image 37 de l'extrait » en
   « 05:42:27,480 de la retransmission », donc de réécrire un timecode dans Firestore.
3. **Précision interne** — une fois le fichier ouvert, le pas image par image est-il exact ?

Le point 3 est déjà acquis par `videoPlayer.js` (`requestVideoFrameCallback` + `estimateFps`). Les
points 1 et 2 sont ceux que l'extraction doit garantir.

### 2.2 Effet des images-clés (GOP)

Une retransmission YouTube est encodée avec un **GOP** (intervalle entre images-clés) typique de
**2 à 10 secondes** — souvent 5 s sur un flux issu d'un direct. En copie brute (`-c copy`), ffmpeg
ne peut commencer qu'à une image-clé : le fichier obtenu démarre donc **jusqu'à un GOP avant**
l'instant demandé.

**Correction de la révision 1 de ce document.** J'y écrivais que « cet écart n'est pas connu » et
que l'origine était perdue. ✅ **C'est faux, et c'est maintenant mesuré** (§2.5) : ffmpeg conserve
les images de pré-roll avec des **timestamps négatifs** (−2,000 s à −0,020 s dans l'essai) et un
drapeau *discard*, et une **edit list** MP4 fait démarrer la présentation exactement à l'instant
demandé. `ffprobe` annonce alors `start_time = 0` et la bonne durée.

Le risque réel n'est donc pas la perte de l'origine, mais un **déplacement du risque vers le
lecteur** : les images en trop sont physiquement dans le fichier, et un lecteur qui ignore l'edit
list ou les drapeaux *discard* les affiche — toute la chronologie glisse alors d'un GOP, sans que
rien ne le signale. C'est le pire mode de défaillance : silencieux.

### 2.3 Les deux stratégies, et celle qu'on retient

Mesuré sur un fichier de contrôle de 400 s à 50 img/s avec un GOP de 5 s, coupe demandée à 27,000 s
(entre deux images-clés) :

| Stratégie | Commande | Paquets écrits | Présentation | Origine | Coût CPU | Qualité |
|---|---|---|---|---|---|---|
| **Rapide** | `--download-sections` seul | ✅ mesuré **2750** (100 de pré-roll) | 53,000 s, `start_time = 0` | ⚠️ portée par l'edit list | ✅ **~0 s** | intacte (copie) |
| **Précise** ✅ **retenue** | `+ --force-keyframes-at-cuts` | ✅ mesuré **2650** = 53 s × 50 exactement | 53,000 s, `start_time = 0` | ✅ dans le fichier lui-même | ✅ mesuré **5,4 s** | réencodage CRF 18 |
| Deux passes maison | plage large en copie, puis recoupe locale | — | — | ✅ | 2 × | idem |

**Recommandation inchangée, pour une meilleure raison : la stratégie précise.** Non plus parce que
la copie perdrait l'origine — elle ne la perd pas — mais parce qu'elle produit un fichier **sans
aucune image de pré-roll et sans timestamp négatif** : sa justesse ne dépend d'aucune interprétation
d'edit list par le navigateur. Le réencodage porte sur 53 secondes, pas sur 6 heures.

Le mode rapide reste disponible (`--mode fast`) et redevient intéressant si le POC montre que Chrome
respecte correctement l'edit list : il est ~10× plus rapide et sans perte. L'outil **compte les
images de pré-roll et le signale** au lieu de laisser deviner.

### 2.4 Ce qui a pu être mesuré sans YouTube ✅

L'accès à YouTube reste bloqué dans l'environnement d'analyse, mais le mécanisme a pu être vérifié
de bout en bout **hors YouTube**, en servant un fichier de 400 s (124 Mo) depuis un serveur HTTP
local gérant les requêtes `Range`, et en pointant ffmpeg dessus avec exactement les arguments que
construit `FFmpegFD` :

| Mesure | Résultat |
|---|---|
| Requêtes HTTP émises | **2** : `bytes=0-` (3,38 Mo, en-tête et index) puis `bytes=8400703-` (21,13 Mo) |
| Octets réellement transférés | **25,8 Mo sur 124 Mo**, pour une fenêtre de 53 s sur 400 s |
| Seek | ✅ ffmpeg saute directement à l'octet correspondant : **le début du fichier n'est pas parcouru** |
| Durée | 5,4 s, réencodage compris |
| Sortie | h264 / yuv420p / 50 img/s CFR / `start_time = 0` / 2650 images |

Le surcoût fixe est la lecture d'en-tête (3,4 Mo ici). Sur une VOD de 6 h, la fenêtre utile pèse le
même ordre de grandeur qu'ici en valeur absolue, mais rapportée à ~12 Go elle représente **~0,3 %**.

⚠️ Ce que cet essai **ne prouve pas** : que les formats servis par `googlevideo.com` se comportent
pareil. Le code de yt-dlp indique que `FFmpegFD` accepte les protocoles `http`, `https` et
`http_dash_segments` — ceux qu'utilise YouTube — mais **pas** `file`, ce qui a été constaté en
essayant (« This format cannot be partially downloaded »). Seul le POC du §12 tranche.

### 2.5 Et la marge « départ − 3 s → fin + 3 s » ?

Elle reste **fortement recommandée**, mais pour une autre raison que celle imaginée. Elle ne sert
plus à compenser l'imprécision de la coupe (résolue au §2.3) : elle sert à **absorber l'imprécision
du repérage humain ou automatique**. Un départ mal visé de 2 s sur un extrait sans marge, c'est une
ré-extraction ; avec 3 s de marge, c'est un simple `seek`.

Conséquence de conception importante : **la marge doit être un champ explicite de la recette**
(`padBefore` / `padAfter`), jamais un ajustement silencieux des timecodes. Sinon on ne sait plus,
trois mois après, si `05:42:23` est le départ ou le départ moins 3 secondes.

Fenêtre proposée par défaut : **−3 s / +6 s** autour de la plage demandée. Le `+6` couvre le
franchissement du premier virage, qui est la donnée réellement recherchée par l'analyse.

---

## 3. Quantité de données téléchargée

### 3.1 Ordre de grandeur 📐

Sur une retransmission sportive 1080p, YouTube sert typiquement 3–6 Mbit/s en vidéo (H.264 itag
137, ou VP9 itag 248) et ~128 kbit/s en audio.

| Élément | Calcul | Volume |
|---|---|---|
| Retransmission complète, 6 h | 4,5 Mbit/s × 21 600 s | 📐 **~12 Go** |
| Fenêtre utile, 50 s (44 s + marges) | 4,5 Mbit/s × 50 s | 📐 **~28 Mo** |
| Audio de la même fenêtre | 128 kbit/s × 50 s | 📐 ~0,8 Mo |
| Index du conteneur (`moov`/`sidx`) lu pour se positionner | fragmenté, ~12 o/segment | 📐 &lt; 1 Mo |
| Alignement sur l'image-clé + surlecture ffmpeg | ≤ 1 GOP de chaque côté | 📐 ~5 Mo |
| **Total réellement téléchargé** | | 📐 **~35 Mo, soit ~0,3 %** |

Le fichier **produit** sera plus petit encore (réencodage CRF 18 preset rapide → 📐 15–30 Mo).

### 3.2 Comment le vérifier plutôt que le croire

Deux mesures suffisent, décrites au §12 : le **temps écoulé** (un téléchargement de 12 Go ne peut
pas tenir en 30 s) et le **compteur d'octets** du Moniteur de ressources Windows. Si les 6 heures
étaient téléchargées, cela se verrait immédiatement.

### 3.3 Comportement DASH / HLS

| Cas | Comportement attendu |
|---|---|
| **VOD YouTube classique** (le cas Kerlabo) | Formats adaptatifs servis en HTTP `Range` sur `googlevideo.com`. Index en tête, seek d'entrée efficace. 📐 **c'est le cas favorable** |
| **VOD d'un ancien direct** (probable ici : 6 h de retransmission) | Après traitement, YouTube expose la même chose qu'une VOD normale. 📐 identique — **à confirmer au POC**, c'est la seule vraie inconnue |
| **Direct en cours** (`is_live`) | HLS/DASH glissant, pas d'index complet : `--download-sections` n'a pas de sens. Il faut `--live-from-start` (qui lui télécharge tout depuis le début) |
| Format progressif (itag 18/22, ≤ 720p) | MP4 non fragmenté avec `faststart` : le seek marche aussi, mais la qualité plafonne |

**Contrainte pratique à retenir : cette brique s'applique aux rediffusions, pas au direct.** Pour
le direct, le chemin reste le lecteur YouTube intégré déjà présent dans `videoPlayer.js`.

---

## 4. Architecture : A, B ou C

### 4.1 Le contexte contraint fortement le choix

`ARCHITECTURE.md` §1.1 l'établit : Rallycross V2 est une **PWA 100 % statique**, sans backend, sans
build, sans dépendance npm en runtime, hébergée sur Netlify. **Il n'existe aucun endroit « serveur »
où faire tourner yt-dlp.** Toute exécution sera locale. La seule question est donc : *comment le
navigateur et le programme local se parlent-ils — ou évitent-ils d'avoir à se parler ?*

### 4.2 Comparaison

| Critère | **A — script local** | **A+ — script + dossier partagé** | **B — service localhost** | **C — desktop (Tauri)** |
|---|---|---|---|---|
| Bouton « EXTRAIRE » dans V2 | ❌ (copier-coller d'une commande) | ⚠️ V2 prépare la commande, l'outil l'exécute | ✅ | ✅ |
| Récupération du fichier | manuelle (`📁 Fichier local`) | ✅ automatique (handle de dossier) | ✅ automatique | ✅ automatique |
| Nouvelle fragilité navigateur | **aucune** | aucune (API standard, permission unique) | ❌ **Private Network Access** | aucune |
| Compatibilité navigateurs | tous | Chrome / Edge (Firefox : repli sur A) | tous, tant que Chrome l'autorise | — |
| Processus résident | non | non | ⚠️ oui | oui |
| Installation | yt-dlp + ffmpeg | idem | idem + service | idem + app signée |
| Cohérence avec la rév. 6 | ✅ | ✅ | ❌ « B jamais » | ⚠️ « plus tard si besoin » |
| Effort | **~1/2 journée** | ~1 journée | ~2 journées | ≥ 1 semaine |

### 4.3 Pourquoi B est écartée — le même argument qu'en révision 6

`AUTOMATION-ARCHITECTURE.md` §3 a déjà tranché ce point exact, pour le service Python d'inférence :

> Une page HTTPS publique appelant `http://127.0.0.1` déclenche le contrôle *Private Network Access*
> de Chrome. Il faut renvoyer `Access-Control-Allow-Private-Network: true` au préflight, et ce
> mécanisme évolue vers une demande de permission explicite dans les versions récentes.

Rien ne change ici, et le détail des contraintes demandées est le suivant :

- **Mixed content** : `https://rxchrono.netlify.app` → `http://127.0.0.1:8765` n'est *pas* bloqué
  comme contenu mixte, car `127.0.0.1` est un *potentially trustworthy origin* au sens de la
  spécification W3C. Ce n'est **pas** le problème.
- **CORS** : gérable trivialement — le service renvoie
  `Access-Control-Allow-Origin: https://rxchrono.netlify.app`. Ce n'est **pas** le problème non plus.
- **Private Network Access / Local Network Access** : *c'est* le problème. Chrome exige un préflight
  spécifique pour toute requête d'une origine publique vers le réseau local, et durcit
  progressivement vers une **permission utilisateur explicite**. Une brique qui dépend d'un
  mécanisme en cours de durcissement se cassera à une mise à jour de navigateur, un samedi de
  course.
- **Sécurité** : un service localhost qui accepte une URL et exécute `yt-dlp` est une surface
  d'exécution de commande ouverte à **toute page web ouverte dans le navigateur**. Il faudrait
  vérifier l'`Origin`, un jeton partagé, n'écrire que dans un dossier autorisé, et ne jamais
  construire la commande via un shell. Faisable, mais c'est du travail de sécurité pour un gain
  d'ergonomie que A+ offre presque gratuitement.

**Une variante de B échapperait à tout cela** : que l'outil local **serve lui-même** les fichiers
statiques de V2 sur `http://localhost:8765`. Même origine → ni CORS, ni PNA, ni contenu mixte. Mais
cela crée un « V2 local » distinct du V2 Netlify, avec deux modes à maintenir. À garder en réserve,
pas à construire maintenant.

### 4.4 Recommandation : **A maintenant, A+ ensuite, B jamais, C hors sujet**

1. **Aujourd'hui — A.** Un script local (`tools/extract-manche/`, dans la lignée des `tools/*.mjs`
   existants) qui prend URL + début + fin + identité de manche et produit `manche.mp4` + son
   sidecar JSON. Le fichier se charge ensuite dans le lecteur via le bouton **📁 Fichier local**
   qui existe déjà (`js/startAnalysis.js:639`). **Zéro modification de l'application.**
2. **Ensuite — A+, si le copier-coller agace.** Deux ajouts indépendants :
   - côté V2 : un panneau qui **compose la recette** (il connaît déjà meeting, catégorie, session,
     série et le timecode via `resolveStartTime()`) et affiche la commande prête à coller, ou écrit
     un fichier `.job.json` ;
   - côté navigateur : `showDirectoryPicker()` sur un dossier `Extraits/`, handle conservé en
     IndexedDB. V2 y **retrouve tout seul** l'extrait correspondant à la manche sélectionnée, par
     son nom et son sidecar.

   C'est exactement le mécanisme d'accès disque que `AUTOMATION-ARCHITECTURE.md` §1 prévoit déjà
   pour la vidéo d'analyse (`showOpenFilePicker()` + handle en IndexedDB). **Aucune fragilité
   nouvelle n'est introduite** : une seule permission, accordée une fois.
3. **C** reste ce qu'en dit la rév. 6 : une enveloppe possible plus tard, qui chargerait les mêmes
   fichiers statiques sans réécriture. Lancer yt-dlp ne justifie pas de la construire.

---

## 5. Compatibilité avec `videoPlayer.js`

### 5.1 Ce que le lecteur fait aujourd'hui ✅ (lu dans le dépôt)

- `loadFile(file, startAt)` crée une `URL.createObjectURL(file)` sur un `<video>` — **le fichier ne
  quitte jamais la machine** (`js/videoPlayer.js:268`).
- La cadence est **devinée**, pas lue : `requestVideoFrameCallback` accumule 8 à 40 écarts
  `meta.mediaTime`, dont `estimateFps()` prend la **médiane**, recalée sur `COMMON_FPS`
  (23.976, 24, 25, 29.97, 30, 50, 59.94, 60) si l'écart est &lt; 5 %.
- Le pas image par image vaut `1 / fps`, avec **`DEFAULT_FPS = 25` en repli**
  (`js/videoPlayerCalc.js:120`).

### 5.2 Le profil de sortie à imposer

| Paramètre | Valeur | Pourquoi |
|---|---|---|
| Conteneur | **MP4** | Lu partout ; WebM ne l'est pas sur Safari |
| Codec vidéo | **H.264 (avc1), profil High, niveau ≤ 4.2** | Décodage matériel garanti, pas à pas fluide. **Éviter AV1** (décodage logiciel possible → saccades au pas à pas) |
| Format de pixels | **`yuv420p`** | Un flux YouTube VP9 profil 2 (10 bits) réencodé sans `-pix_fmt yuv420p` donne un `<video>` **noir** |
| Codec audio | **AAC-LC** | Universel. L'audio est accessoire ici, mais un flux illisible peut faire échouer tout le fichier |
| Cadence | **CFR, identique à la source** (`-fps_mode cfr -r <r_frame_rate source>`) | ⚠️ **Point critique**, voir §5.3 |
| `start_time` | **0** | Un `start_time` non nul décale `video.currentTime` et fausse `frameOf()` |
| GOP | **court (`-g 10` à `-g 25`)** | Le navigateur décode depuis l'image-clé précédente à chaque `seek` : un GOP court rend le pas à pas instantané |
| `-movflags` | **`+faststart`** | Sans effet sur un blob local, utile si le fichier est un jour servi |

### 5.3 Le piège de la cadence — et l'occasion de le supprimer

Une retransmission de rallycross est probablement en **50 fps** (norme européenne). Or :

- si le réencodage produit du **VFR** (fréquence variable), `estimateFps()` prend la médiane des
  écarts et peut se caler sur une valeur fausse ;
- **Firefox n'implémente pas `requestVideoFrameCallback`.** Le code teste
  `typeof video.requestVideoFrameCallback === 'function'` et, s'il est absent, `state.fps` reste
  `null` → le pas image par image utilise **25 fps sur une vidéo à 50 fps**, soit **deux images
  d'avance à chaque clic**, silencieusement.

Ce défaut existe déjà aujourd'hui, indépendamment de cette brique. Mais l'extraction offre la
correction naturelle : **l'outil connaît la cadence exacte** (`ffprobe -show_entries
stream=r_frame_rate`) et peut l'écrire dans le sidecar JSON. Le lecteur n'aurait plus à deviner —
`estimateFps()` deviendrait un simple filet de sécurité.

→ ✅ **Fait, et le défaut était pire que prévu.** Constaté sur le premier extrait réel : le lecteur
numérotait les images à **30 img/s sur un fichier à 60**, sans rien signaler. Le départ marqué à
43,000 s affichait `#1290` au lieu de `#2580`, et « image suivante » avançait de 33 ms au lieu de
16,7 ms.

La cause n'est pas Firefox : `requestVideoFrameCallback` mesure la cadence de **présentation**, pas
celle du fichier. Quand le navigateur ne suit pas — du 1080p60 à 12 Mbit/s avec une image-clé toutes
les 10 images, c'est exigeant — il présente une image sur deux, et `estimateFps()` mesurait
scrupuleusement 30. Pire : 30 appartient à `COMMON_FPS`, donc le recalage sur une valeur standard
transformait une mesure fausse en valeur d'apparence légitime.

Trois corrections, dans cet ordre d'importance :

1. **Le sidecar fait autorité.** Le sélecteur de fichiers accepte désormais la vidéo **et** son
   `.json` ; `parseExtractSidecar()` valide le schéma `rx-extract/1` et la cadence est *annoncée* au
   lecteur (`loadFile(file, startAt, { fps })`) au lieu d'être devinée.
2. **La mesure est durcie.** `estimateFps()` prend le **quartile bas** des écarts et non la médiane :
   la présentation ne peut que perdre des images, jamais en inventer, donc le vrai pas est du côté
   des plus petits écarts. Sur des pertes intermittentes elle retrouve 60 là où la médiane donnait
   30. La mesure est aussi suspendue hors vitesse ×1, où `mediaTime` avance de plusieurs images
   entre deux présentations.
3. **La provenance est affichée** : « 60 img/s (sidecar) » ou « 30 img/s (mesurée) ». Une cadence
   devinée ne doit plus jamais avoir l'air d'un fait.

Vérifié dans un vrai navigateur par `tools/smoke/videoPlayerFps.mjs` (voir §5.5).

### 5.4 Contrôle navigateur de la cadence

`tools/smoke/videoPlayerFps.mjs` charge un fichier dans le **vrai** lecteur, dans un **vrai**
navigateur, et vérifie six points : vidéo réellement décodée, cadence retenue, provenance, pas
théorique, **pas réellement appliqué par `step('frame')`**, et numéros d'image à deux instants.

```
node tools/smoke/videoPlayerFps.mjs <extrait.mp4>   # automatique, Chromium de Playwright
node tools/smoke/videoPlayerFps.mjs --serve         # sert la page : à ouvrir dans SON navigateur
```

Résultat sur un fichier de contrôle à 60 img/s, décodé : les six contrôles passent, `frameOf(43)`
vaut **2580**, `frameOf(51)` vaut **3060**, et le pas mesuré est de **16,666 ms**.

⚠️ **Limite du mode automatique** : le Chromium livré avec Playwright est une compilation sans
codecs propriétaires — `canPlayType('avc1')` y renvoie une chaîne vide. Il ne peut donc pas décoder
un extrait H.264, et le contrôle « vidéo réellement décodée » échoue franchement au lieu de laisser
passer un faux vert. Pour un test complet sur un extrait réel, c'est `--serve` et son propre Chrome
qu'il faut utiliser — d'autant que la cadence de présentation dépend de la machine, de l'écran et du
décodeur, jamais du seul fichier.

### 5.5 Ce que l'extrait apporte au lecteur, en plus

Un fichier de 50 secondes est **entièrement en mémoire**. Le `seek` est instantané, le pas à pas
arrière aussi — alors qu'aujourd'hui, sur l'iframe YouTube, `step()` retombe sur un pas de 0,2 s
(`js/videoPlayer.js:376`) parce que **YouTube ne donne pas accès aux images**. L'extraction ne fait
donc pas que rendre l'analyse possible : elle **débloque le pas image par image**, qui est
littéralement impossible sur la source YouTube.

---

## 6. Lien avec l'analyse YOLOX

### 6.1 L'extrait est exactement l'entrée attendue

`AUTOMATION-ARCHITECTURE.md` §2 retient l'**analyse préalable puis rejeu** : on analyse les ~250
images de la fenêtre, on garde les boîtes en mémoire, puis on relit avec surimpression. Cela suppose
une **fenêtre courte et délimitée** — c'est précisément ce que produit l'extraction.

Bénéfices directs, sans une ligne de code supplémentaire :

| Avant (source YouTube) | Après (extrait local) |
|---|---|
| Pixels inaccessibles depuis l'iframe (le `<canvas>` ne peut pas `drawImage()` une iframe) → **YOLOX impossible** | `<video>` local → `drawImage()` → tenseur ONNX ✅ |
| Cadence devinée | Cadence connue et écrite dans le sidecar |
| Pas à pas limité à 0,2 s | Pas à pas réel |
| Fenêtre d'analyse à délimiter à la main | Bornée par construction |

### 6.2 Le point d'ancrage temporel

Avec la stratégie précise (§2.3), `t = 0` du fichier ≡ `sourceStart` de la recette. Toute mesure
faite par YOLOX se convertit donc en timecode absolu de la retransmission :

```
instant_youtube = sourceStart + t_local
```

C'est ce qui permet de **réécrire dans Firestore** un timecode de départ affiné par l'analyse
automatique, dans le même format que `meeting.videoTimecodes` aujourd'hui. Sans cet ancrage, les
mesures resteraient prisonnières du fichier.

### 6.3 La brique accepte des timecodes automatiques sans rien changer

C'est la contrainte que tu as posée, et elle est structurellement respectée : le contrat d'entrée de
l'outil est un **objet recette**, pas une saisie.

```jsonc
{
  "youtubeId": "_SqxZQl5zzQ",
  "sourceStart": 20546,        // 05:42:26 — d'où qu'il vienne
  "sourceEnd":   20590,        // 05:43:10
  "padBefore": 3, "padAfter": 6,
  "origin": "manual"           // ou "auto:startDetector@1.2"
}
```

Que `sourceStart` vienne d'un champ texte, d'un détecteur de feux de départ ou d'une transcription
du commentaire ne change **rien** à l'outil. Le champ `origin` sert uniquement à tracer la
provenance, jamais à brancher un comportement différent.

**Bonus d'architecture** : un futur détecteur automatique de départs peut utiliser *la même brique*
pour se financer — extraire une fenêtre large en **360p** (`-f "wv*[height<=360]"`, 📐 ~10× moins de
données), y chercher les départs, puis ne ré-extraire en 1080p que les fenêtres retenues. Le
repérage automatique devient alors quasi gratuit en bande passante.

---

## 7. Nommage et rattachement aux données Rallycross

### 7.1 Le nom de fichier : lisible, mais jamais la source de vérité

`Kerlabo_2026_D3_Q3_Serie4.mp4` est une bonne convention **pour l'humain**. Elle ne doit pas devenir
le canal de données : un nom se renomme, se tronque, perd ses accents, et ne peut pas porter
`meetingId` ni `sessionId`.

Convention proposée, alignée sur `timecodeKey()` (`js/utils.js:341`, qui produit déjà `Q3__D3`) :

```
<lieu>_<année>_<catégorie>_<type><num>_S<série>.mp4
Kerlabo_2026_D3_Q3_S4.mp4
```

### 7.2 Le sidecar JSON : la vraie liaison

Un `Kerlabo_2026_D3_Q3_S4.json` écrit à côté du `.mp4`, portant la recette **et** les identifiants
Firestore déjà existants :

```jsonc
{
  "schema": "rx-extract/1",
  "meetingId": "…", "sessionId": "…",          // clés Firestore réelles
  "location": "Kerlabo", "year": 2026,
  "championshipId": "…", "category": "D3",
  "sessionType": "MQ", "sessionNum": 3, "serie": 4,
  "timecodeKey": "MQ3__D3",                     // = timecodeKey() du dépôt
  "youtubeId": "_SqxZQl5zzQ",
  "sourceStart": 20546, "sourceEnd": 20590,
  "padBefore": 3, "padAfter": 6,
  "clipStart": 20543, "clipDuration": 53,       // ce que contient réellement le fichier
  "fps": 50, "width": 1920, "height": 1080,
  "codec": "avc1", "startTime": 0,              // relevés par ffprobe après coup
  "origin": "manual",
  "tool": "yt-dlp 2026.08.19 + ffmpeg 7.x",
  "createdAt": "2026-08-21T09:00:00Z"
}
```

Trois reconnaissances possibles côté V2, par ordre de fiabilité :

1. **Sidecar lu** (sélection multiple, ou dossier via `showDirectoryPicker()`) → rattachement exact
   par `sessionId` + `serie`. ✅ à privilégier ;
2. **Nom de fichier analysé** → rattachement probable, à confirmer par l'utilisateur ;
3. **Rien** → comportement actuel, le fichier est chargé « nu ». Toujours conserver ce repli.

### 7.3 Ce qui va dans Firestore, et ce qui n'y va pas

| Donnée | Firestore ? |
|---|---|
| `youtubeId`, `sourceStart`, `sourceEnd`, `pad`, `origin` | ✅ **oui** — c'est la recette, ~200 octets, déjà proche de `meeting.videoTimecodes` |
| `fps`, dimensions | ✅ oui, utile au lecteur et à YOLOX |
| Boîtes, positions, temps mesurés | ✅ oui — ce sont **des données factuelles**, pas du contenu protégé |
| **Le fichier `.mp4`** | ❌ **jamais.** Ni Firestore, ni Storage, ni Netlify |
| Vignettes ou images extraites | ❌ éviter — ce sont des extraits de l'œuvre |

Cette ligne est nette et elle satisfait à la fois la contrainte technique (aucun Go n'est téléversé),
la contrainte économique (quota Firebase intact) et la contrainte juridique (§9).

---

## 8. Difficulté, dépendances, expérience utilisateur

### 8.1 Dépendances Windows — deux, et pas de Python

| Composant | Installation | Taille | Note |
|---|---|---|---|
| **yt-dlp** | `winget install yt-dlp.yt-dlp` — ou `yt-dlp.exe` posé dans un dossier du `PATH` | ~17 Mo | L'exécutable embarque son Python : **rien d'autre à installer** |
| **ffmpeg + ffprobe** | `winget install Gyan.FFmpeg` | ~150 Mo | **Obligatoire** : `--download-sections` en dépend (§1.1) |
| Node 22 | déjà présent (le dépôt utilise Vitest) | — | Seulement si le script d'orchestration est en `.mjs` |

Vérification d'installation : `yt-dlp --version` et `ffmpeg -version` doivent tous deux répondre.
**Mise à jour** : `yt-dlp -U` (ou `winget upgrade`) — à faire **avant chaque week-end de course**,
voir §10.

### 8.2 Effort d'implémentation

| Étape | Contenu | Effort |
|---|---|---|
| **POC** (§12) | deux commandes à la main, mesures, ouverture dans le lecteur | **30 min** |
| **Outil A** | `tools/extract-manche/extract.mjs` : recette → commande → `.mp4` + `.json` + contrôle `ffprobe`. Sans dépendance npm, comme les autres `tools/*.mjs` | **~1/2 journée** |
| **A+ côté V2** | panneau « Extraire la manche » qui compose la recette + dossier `Extraits/` reconnu | **~1 journée** |
| **fps explicite** dans le lecteur | `loadFile(file, startAt, { fps })` + tests | **~1 h** |

> ✅ **Réalisé depuis** : l'outil A existe — `tools/extract-manche/` (script, lanceur Windows,
> sidecar `rx-extract/1`, contrôle ffprobe, plan du corpus), couvert par `tests/extractManche.test.js`.
> Le correctif `loadFile(file, startAt, { fps })` du §5.3 est également en place.

Aucune de ces étapes ne touche à l'existant : ce sont des ajouts, conformément au pattern en 6
points d'insertion décrit dans `ARCHITECTURE.md` §1.2.

### 8.3 Expérience utilisateur visée

**Étape A (dès le POC)** — 4 gestes :

1. dans V2, sélectionner la manche → V2 affiche la commande prête, avec le nom de fichier déjà
   construit ;
2. coller dans un terminal ;
3. 📐 attendre ~30–60 s ;
4. `📁 Fichier local` → le fichier.

**Étape A+ (cible)** — 2 gestes :

1. `URL` (pré-remplie depuis `meeting.videos`) + `Début` + `Fin` → **`[ EXTRAIRE LA MANCHE ]`** ;
2. V2 surveille le dossier `Extraits/` et charge le fichier dès qu'il apparaît.

Le bouton ne « fait » pas l'extraction : il écrit un `.job.json` dans le dossier surveillé, qu'un
petit veilleur local traite. Même ergonomie que B, sans son mécanisme fragile.

---

## 9. YouTube : ce qui est possible, ce qui est autorisé

*Distinction demandée explicitement. Ce qui suit décrit un état de fait et n'est pas un avis
juridique.*

### 9.1 Techniquement possible

Les flux YouTube standards **ne sont pas protégés par DRM** : yt-dlp lit les mêmes URL
`googlevideo.com` que le lecteur web. Aucune mesure technique de protection n'est contournée par
l'usage décrit ici. **Rien dans ce document ne propose de contournement de DRM, de restriction
d'âge, de contenu réservé aux membres ou de blocage géographique — et rien ne doit en proposer.**

### 9.2 Autorisé, c'est autre chose

- **CGU de YouTube** : le téléchargement de contenu est interdit **sauf** via une fonctionnalité
  offerte par le service (téléchargement hors ligne dans l'application) ou **avec l'autorisation
  préalable du titulaire des droits**. Utiliser yt-dlp sur une vidéo tierce est donc, en soi, un
  **manquement aux CGU**, indépendamment de toute question de droit d'auteur.
- **Droit d'auteur (France)** : l'exception de copie privée (art. L122-5 CPI) suppose une **source
  licite** et un usage **strictement privé**, sans diffusion. Son application à la capture de flux
  est discutée. Elle ne couvre en aucun cas une rediffusion, même partielle.
- **Le chemin propre, et il est à ta portée** : la retransmission d'un meeting de rallycross
  appartient à l'organisateur ou au média qui l'a produite. Un accord explicite — voire simplement
  **les fichiers sources**, souvent de meilleure qualité que le réencodage YouTube — règle la
  question et améliore l'analyse. Si la chaîne est celle d'une structure dans laquelle tu es
  impliqué, `YouTube Studio` permet le téléchargement direct par le propriétaire.

### 9.3 Règles d'usage à graver dans l'outil

| Règle | Raison |
|---|---|
| Extraits **strictement locaux**, jamais téléversés | ta contrainte, et la seule position défendable |
| Jamais de rediffusion, de publication d'images ni de vignettes | c'est le contenu protégé |
| Ne conserver durablement que **la recette** et **les données mesurées** | positions et temps sont des **faits**, non protégeables |
| Aucune extraction en masse, aucun parallélisme agressif | respect de l'infrastructure tierce |
| Aucun contournement d'âge, de géo-blocage ou d'accès privé | ligne rouge, sans exception |
| Demander l'autorisation dès que l'usage dépasse l'analyse privée | la seule solution durable |

Une phrase dans l'aide de l'outil (« usage privé d'analyse ; assure-toi d'avoir le droit
d'extraire cette vidéo ») coûte une ligne et clarifie l'intention.

---

## 10. Limites et risques

| Risque | Gravité | Atténuation |
|---|---|---|
| **yt-dlp cesse de fonctionner** quand YouTube change son extracteur | 🔴 élevée — c'est *le* risque | `yt-dlp -U` avant chaque week-end de course ; l'outil affiche la version et prévient si elle date de &gt; 30 jours |
| **Vérification anti-robot / limitation** selon l'IP ou le débit | 🟠 moyenne | Une extraction à la fois, pas de rafale. Le cas échéant, `--cookies-from-browser` — **uniquement** pour du contenu auquel tu as normalement accès |
| **Aucun format H.264** proposé (VP9/AV1 seulement) | 🟢 faible | Le réencodage de la passe précise (§2.3) impose déjà H.264 : cas couvert par construction |
| **VOD d'ancien direct au timing irrégulier** (discontinuités, cadence variable) | 🟠 moyenne | `-fps_mode cfr` ; le POC le détectera via `ffprobe` (§12, étape 3) |
| **Décalage entre le timecode lu sur YouTube et celui du fichier source** | 🟠 moyenne | Contrôle visuel au POC : l'image de départ doit être la bonne à ± 1 image |
| **Firefox : pas de `requestVideoFrameCallback`** → 25 fps supposés sur du 50 fps | 🟠 moyenne, **déjà présente** | Chrome/Edge pour l'analyse, et à terme `fps` explicite issu du sidecar (§5.3) |
| **Juridique** (§9) | 🟠 moyenne | Usage privé, aucune rediffusion, autorisation demandée pour tout le reste |
| Dérive : l'outil local devient un second logiciel à maintenir | 🟢 faible | ~200 lignes, sans dépendance, dans `tools/` comme les autres utilitaires du dépôt |

**Ce que cette brique ne fera pas** : elle ne traite pas le direct (§3.3), ne détecte pas les
départs (autre chantier), et ne dispense pas de vérifier une fois l'extrait à l'œil.

---

## 11. Verdict

✅ **Oui, la brique `URL YouTube + 2 timecodes → fichier local → analyse` est viable, et c'est la
plus simple des briques restantes.**

Trois raisons de la construire avant le reste :

1. **Elle est peu coûteuse** : deux dépendances, ~200 lignes, aucune modification de l'application.
2. **Elle débloque ce qui est aujourd'hui impossible.** YOLOX ne peut pas lire les pixels d'une
   iframe YouTube, et le pas image par image n'existe pas sur cette source. Sans extraction locale,
   `AUTOMATION-ARCHITECTURE.md` n'a **aucune entrée**. Cette brique n'est pas un confort, c'est le
   chaînon manquant.
3. **Elle ne parie sur rien.** Elle n'ajoute aucune fragilité navigateur, ne touche pas à
   l'architecture statique, ne préjuge pas du détecteur automatique de départs, et fonctionne
   identiquement que les timecodes soient tapés ou calculés.

Le seul vrai risque est **opérationnel** (yt-dlp doit rester à jour), et il se gère par une commande
avant chaque week-end de course.

---

## 12. POC proposé sur la vidéo Kerlabo

**Critère de réussite, en une phrase** : partir de `05:42:26`, demander ~45 secondes, et obtenir en
**moins d'une minute** un fichier de **moins de 60 Mo** qui s'ouvre dans le lecteur V0, se navigue
image par image, et dont **la première image est bien celle attendue**.

> ⚠️ Rappel : ces commandes **n'ont pas pu être exécutées** pendant cette analyse (accès YouTube
> bloqué par la politique réseau de l'environnement). Elles découlent de la lecture du code de
> yt-dlp, pas d'un essai. C'est ce POC qui les valide.

### Étape 0 — Vérifier l'outillage

```powershell
yt-dlp --version      # attendu : 2026.08.19 ou plus récent
ffmpeg -version       # attendu : 7.x
ffprobe -version
```

### Étape 1 — Reconnaissance, sans rien télécharger ✅ **faite**

Résultat réel sur `_SqxZQl5zzQ` :

| Mesure | Valeur |
|---|---|
| Durée | **21 605 s = 6 h 00 min 05** |
| Définition / cadence | 1920×1080 à **60 img/s** (et non 50) |
| `was_live` | **True** — c'est une rediffusion de direct, l'inconnue du §3.3 |
| Poids total | **7,5 Go** pour la piste retenue automatiquement |
| Formats 1080p60 | `299` avc1 **5040 kbit/s** · `303` vp9 3112 kbit/s · `399` av01 2681 kbit/s · `312` avc1 8019 kbit/s en m3u8 |

Deux enseignements qui ont modifié l'outil :

1. **Un moteur JavaScript est indispensable.** Sans lui, yt-dlp ne peut pas exécuter le script de
   signature de YouTube : la liste revenait **tronquée** — aucun avc1 1080p60 — et le débit risquait
   d'être bridé. Corrigé par `pip install yt-dlp-ejs` et `--js-runtimes node:<chemin>`, que l'outil
   passe désormais tout seul (Node est forcément présent, c'est lui qui l'exécute).
2. **Il faut demander l'avc1 explicitement.** Laissé libre, yt-dlp prenait l'AV1 (399) : plus léger,
   mais plus coûteux à décoder et moins bien doté en débit que le 299. Le sélecteur préfère
   maintenant l'avc1 en DASH `https`, avec repli sur n'importe quel codec en mode précis.

À 7,5 Go pour 21 605 s, la fenêtre de 53 s pèse 📐 **~33 Mo en avc1** (5040 kbit/s), soit **~0,3 %**.

### Étape 1 bis — commandes de reconnaissance

```powershell
yt-dlp -F "https://youtu.be/_SqxZQl5zzQ"
yt-dlp --skip-download --print "%(duration)s %(fps)s %(is_live)s %(was_live)s" "https://youtu.be/_SqxZQl5zzQ"
```

**À noter** : durée totale (≈ 6 h ?), cadence annoncée (50 ?), présence d'un itag **avc1** en 1080p,
et si la vidéo est un ancien direct (`was_live`) — c'est la seule vraie inconnue du §3.3.

### Étape 2 — Extraction réelle ✅ **faite**

Commande : `node tools\extract-manche\extract.mjs --url https://youtu.be/_SqxZQl5zzQ --start 05:42:26
--fin 05:43:10 --lieu Kerlabo --annee 2026 --categorie D3 --type MQ --num 3 --serie 4`

| Critère du POC | Attendu | **Mesuré** | |
|---|---|---|---|
| Format choisi | avc1 + AAC | **`299+140`** | ✅ le sélecteur fait ce qu'on lui demande |
| Plage demandée | 20543 → 20596 | **20543.0-20596.0** | ✅ |
| Images | 53 × 60 = 3180 | **3180** | ✅ **coupe exacte, aucun pré-roll** |
| `start_time` | 0 | **0** | ✅ |
| Cadence | celle de la source | **60 img/s**, CFR | ✅ |
| Codec / pixels | h264 High / yuv420p | **h264 High / yuv420p** | ✅ |
| Durée totale | < 1 min | **33,8 s** | ✅ |
| Poids du fichier | 📐 15–30 Mo | **79,5 Mo** | ❌ estimation fausse, voir ci-dessous |

**Ce qui n'était pas prévu : la taille de sortie.** J'avais estimé 15–30 Mo en confondant deux
choses. Le **téléchargement** est bien conforme — la piste 299 fait 5040 kbit/s, donc ~33 Mo pour
53 s, soit **0,25 %** des 12,7 Go de la piste complète. Mais la **sortie** est réencodée en CRF 18,
c'est-à-dire quasiment sans perte : sur du 1080p60 de rallycross, plein de poussière et de détail en
mouvement, cela coûte ~12 Mbit/s, soit **2,4 fois le débit de la source**. Un CRF proche de 18 sur une
source déjà compressée dépense l'essentiel de ses bits à reproduire fidèlement les artefacts de
YouTube.

Ce n'est pas un problème de fonctionnement — 80 Mo pour un fichier local de travail reste
confortable — mais si le volume devenait gênant, `-crf 20` ou `-crf 22` diviserait la taille par
deux environ. À ne faire qu'après avoir vérifié que YOLOX ne perd rien : c'est justement sur les
détails compressés que se joue la détection.

### Étape 2 bis — variante rapide (mesure du volume et du temps)

```powershell
Measure-Command {
  yt-dlp "https://youtu.be/_SqxZQl5zzQ" `
    --no-playlist `
    -f "bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4]" `
    --download-sections "*05:42:23-05:43:16" `
    -o "rough.%(ext)s"
}
Get-Item rough.mp4 | Select-Object Length
```

**Mesures à relever** : ⏱ temps écoulé, 💾 taille, et surtout le compteur **octets reçus** du
Moniteur de ressources Windows pendant l'exécution. **Si ce compteur reste sous ~100 Mo, la question
n° 2 est tranchée définitivement** : `--download-sections` ne télécharge pas les 6 heures.

### Étape 3 — Diagnostiquer la coupe brute (c'est l'étape la plus instructive)

```powershell
ffprobe -v error -select_streams v:0 `
  -show_entries stream=r_frame_rate,avg_frame_rate,codec_name,pix_fmt,width,height,start_time `
  -show_entries format=duration,start_time -of default=noprint_wrappers=1 rough.mp4

ffprobe -v error -select_streams v:0 -show_entries frame=pts_time,key_frame `
  -read_intervals "%+12" -of csv=p=0 rough.mp4 | Select-String "^.*,1$"
```

**Ce qu'on cherche** :
- l'écart entre les images-clés → **le GOP réel** (2 s ? 5 s ?), donc l'ampleur exacte du problème
  décrit au §2.2 ;
- `r_frame_rate` = `avg_frame_rate` → la source est bien **CFR** ;
- `start_time` = 0 ;
- `pix_fmt` = `yuv420p`.

### Étape 4 — Extraction précise (la version qu'on garderait)

```powershell
Measure-Command {
  yt-dlp "https://youtu.be/_SqxZQl5zzQ" `
    --no-playlist `
    -f "bv*[height<=1080]+ba/b" `
    --download-sections "*05:42:23-05:43:16" `
    --force-keyframes-at-cuts `
    --downloader-args "ffmpeg_o:-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -g 10 -c:a aac -b:a 128k -movflags +faststart" `
    -o "Kerlabo_2026_D3_Q3_S4.%(ext)s"
}
```

Puis le **contrôle qui compte** : rejouer l'étape 3 sur ce fichier (`start_time` = 0, cadence
préservée), et **comparer visuellement la première image avec la vidéo YouTube mise en pause à
05:42:23**. C'est la vérification de précision : elles doivent coïncider à une image près.

> Note technique (§1.3) : `--force-keyframes-at-cuts` supprime le `-c copy` de la commande générée,
> ce qui rend les options `ffmpeg_o:` réellement effectives. Sans ce drapeau, `-c copy` étant ajouté
> **avant** elles, elles seraient sans effet.

### Étape 5 — Le test qui décide vraiment : le lecteur V0

Dans Rallycross V2 → Analyse des départs → **`📁 Fichier local`** → `Kerlabo_2026_D3_Q3_S4.mp4`.

| Vérification | Attendu |
|---|---|
| Lecture | immédiate, sans mise en tampon |
| Cadence affichée | **50** (ou la valeur de `r_frame_rate`), pas 25 |
| `⏮ img` / `img ⏭` | avance d'**exactement une image**, dans les deux sens |
| Position affichée | cohérente, part de `0:00.000` |
| Plein écran + surimpression canvas | alignement conservé |
| Marqueurs `⏱ Départ ici` / `🎯 Image V1` | fonctionnels |

### Étape 6 — Comparaison honnête

| Indicateur | Aujourd'hui (iframe YouTube) | Avec l'extrait | Objectif |
|---|---|---|---|
| Temps avant analyse | quelques secondes | 📐 30–60 s | &lt; 1 min ✅ |
| Données téléchargées | streaming à la demande | 📐 ~35 Mo | &lt; 100 Mo ✅ |
| Pas image par image | **0,2 s** (impossible plus fin) | 1/50 s | ✅ |
| Accès aux pixels (YOLOX) | **impossible** | ✅ | ✅ |
| Navigation dans 6 h de vidéo | pénible | sans objet | ✅ |

### Décision au vu du POC

| Résultat | Suite |
|---|---|
| Étapes 2 à 5 conformes | ✅ Construire l'outil A (§8.2), puis A+ |
| Volume correct mais coupe imprécise | Passer à la stratégie « deux passes » du §2.3 |
| Volume énorme (~Go) ou très lent | Vérifier `was_live` / le type de flux, essayer un autre itag, et **seulement alors** reconsidérer |
| yt-dlp en échec sur cette vidéo | `yt-dlp -U`, puis relever le message exact — presque toujours un extracteur à mettre à jour |

---

## 13. Extension : générer automatiquement les images du corpus YOLOX

> Ajout demandé après la validation du POC de détection. **Rien n'est construit ici non plus** :
> cette section fixe le contrat, pour que l'outil d'extraction produise directement le corpus au
> lieu de captures ffmpeg faites à la main.

### 13.1 Pourquoi c'est le bon endroit pour le faire

L'extrait local contient déjà tout : les pixels, la cadence exacte, et l'ancrage temporel absolu
(§6.2). Découper des images à partir de lui ne coûte **aucun octet réseau supplémentaire** et se
fait en une fraction de seconde — alors que les capturer depuis YouTube demanderait de re-télécharger.
La brique d'extraction est donc naturellement l'endroit où produire le corpus.

### 13.2 Le contrat : deux repères, pas cinq timecodes

Demander cinq timecodes par départ ruinerait l'ergonomie. Il en faut **deux** :

| Repère | Ce que c'est | Origine |
|---|---|---|
| `startAt` | l'instant du départ (extinction des feux) | déjà `sourceStart` de la recette |
| `v1At` | l'instant où le peloton **aborde le premier virage** | nouveau champ, saisi une fois — ou, plus tard, calculé |

Les cinq à six instants du corpus s'en déduisent par un **profil** paramétrable, pas par une saisie :

| Étiquette de zone | Instant | Ce qu'on y teste |
|---|---|---|
| `depart` | `startAt + 0,0 s` | voitures alignées, nettes, grosses — cas facile de référence |
| `acceleration` | `startAt + 1,5 s` | premières accélérations, écarts qui se creusent |
| `approche_v1` | `v1At − 1,5 s` | voitures qui se rapprochent, plus petites |
| `entree_v1` | `v1At + 0,0 s` | **le cas qui compte** : chevauchements, occlusions |
| `milieu_v1` | `v1At + 1,0 s` | poussière, angle caméra changé, vues de côté |
| `sortie_v1` | `v1At + 2,5 s` | remise en file, éloignement |

Le profil doit être **une donnée, pas du code** : les rallycross n'ont pas tous la même distance
départ → V1 (à Kerlabo elle diffère de Lohéac). Un profil par circuit, ou simplement des décalages
ajustables, suffit.

### 13.3 Règles de production des images

| Règle | Raison |
|---|---|
| **PNG**, pas JPEG | ne pas ajouter une seconde compression à celle de YouTube. On veut mesurer YOLOX sur les artefacts *de la retransmission*, pas sur les nôtres |
| **Résolution native** (1920×1080), aucun redimensionnement | le pré-traitement (letterbox 416/640) appartient au pipeline YOLOX, pas à l'extraction |
| Instant **calé sur un numéro d'image** (`round(t × fps)`), pas sur une durée flottante | reproductibilité exacte : même commande → même image, indispensable pour comparer tiny et -s « sur exactement les mêmes images » |
| **Seek précis** (décodage depuis l'image-clé précédente) | sur un fichier local de 50 s, le coût est négligeable et la précision totale |
| Nom porteur de la **zone** et du **timecode absolu** | voir 13.4 |

Nommage proposé, qui rend le rapport par zone immédiat :

```
Kerlabo_2026_D3_Q3_S4__entree_v1__t20551.480__f1027.png
                       ▲ zone      ▲ instant   ▲ n° d'image
                                     YouTube      dans l'extrait
```

### 13.4 Le corpus est une donnée annotable, donc il lui faut un manifeste

Un `corpus.json` accompagnant les images, une entrée par image :

```jsonc
{
  "file": "Kerlabo_2026_D3_Q3_S4__entree_v1__t20551.480__f1027.png",
  "zone": "entree_v1",
  "sessionId": "…", "serie": 4,
  "youtubeId": "_SqxZQl5zzQ", "absoluteTime": 20551.48,
  "clipFrame": 1027, "fps": 50,
  "carsVisible": null,        // à annoter à la main
  "carsDetectable": null,     // « plus de la moitié de la carrosserie visible »
  "carsOrderCritical": null   // voitures dont l'absence fausserait l'ordre V1
}
```

Les trois derniers champs sont **volontairement vides à la production**. Ce sont eux qui portent la
distinction que tu as posée :

> *Détectable pour YOLO ≠ nécessaire pour déterminer le classement V1.*

`carsDetectable` sert à calculer rappel et précision de l'**étape 1** (détection). `carsOrderCritical`
prépare l'**étape 4** (ordre V1) : rater une voiture qui se dispute P1 n'a pas le même poids que
rater une voiture nettement sixième. Ces deux compteurs doivent rester **séparés** dans le rapport,
faute de quoi un bon rappel masquera une erreur silencieuse sur l'ordre.

### 13.5 Deux pièges à éviter dès la constitution du corpus

1. **Les quasi-doublons gonflent artificiellement le score.** Deux images distantes de 40 ms ne sont
   pas deux mesures indépendantes. Un corpus de 15 images doit couvrir **15 situations**, donc
   plutôt 3 départs × 5 zones que 1 départ × 15 instants. Le profil du §13.2 est construit pour ça.
2. **Le corpus n'a pas sa place dans le dépôt.** `.gitignore` couvre déjà `*.mp4`, **mais pas les
   PNG** — et le dépôt est public. Les images de retransmission doivent aller dans un dossier
   explicitement ignoré (`docs/video-analysis/corpus/`, à ajouter au `.gitignore`), au même titre que
   les extraits. Seuls le **manifeste sans les images** et les **résultats chiffrés** peuvent être
   versionnés : ce sont des faits mesurés, pas du contenu protégé (§7.3, §9.3).

### 13.6 Ce que cette extension ne change pas

Elle ne déplace pas le KPI. La chaîne reste :

```
① détection (ce POC)  →  ② continuité/tracking  →  ③ association voiture↔pilote  →  ④ ordre V1
```

Un rappel de 95 % à l'étape ① **ne signifie pas** 95 % de fiabilité sur l'ordre V1 : les erreurs se
composent, et seule l'étape ④ mesure le besoin réel — *sur combien de départs l'ordre V1 est-il
déterminé sans erreur silencieuse ?* La règle de décision (≥ 90 % → GO, 80–90 % → GO assisté,
< 80 % → essai de YOLOX-s sur les mêmes images) s'applique à l'étape ①, comme porte d'entrée, pas
comme conclusion.

---

## 14. Ce qui n'est pas décidé ici

- Le détecteur automatique de timecodes de départ (chantier distinct ; §6.3 garantit seulement que
  cette brique l'acceptera sans modification).
- Le choix définitif du modèle de détection — `AUTOMATION-ARCHITECTURE.md` §4 en discute.
- L'écriture du panneau « Extraire la manche » dans V2 : conditionnée au succès du POC.
- Le passage du `fps` explicite au lecteur : amélioration utile mais indépendante (§5.3).
- Le profil de capture du corpus (§13.2) : les décalages proposés sont un point de départ, à ajuster
  sur les premières vraies images de Kerlabo.
