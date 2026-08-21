# `extract-manche` — YouTube + 2 timecodes → petit MP4 local

Extrait **une seule manche** d'une retransmission de plusieurs heures, sans télécharger la
retransmission. Le fichier produit est directement lisible par le lecteur de Rallycross V2
(« Analyse des départs » → **📁 Fichier local**) et constitue l'entrée de la future analyse YOLOX.

```
URL YouTube + début + fin  →  Kerlabo_2026_D3_Q3_S4.mp4  +  Kerlabo_2026_D3_Q3_S4.json
```

Analyse complète et justification des choix : [`docs/video-analysis/EXTRACTION-YOUTUBE.md`](../../docs/video-analysis/EXTRACTION-YOUTUBE.md).
C'est l'**option A** de ce document : un script local, aucun service, aucune modification de
l'application. **La vidéo ne quitte jamais la machine.**

---

## Installation (Windows)

```powershell
winget install yt-dlp.yt-dlp     # l'exécutable embarque son Python : rien d'autre à installer
winget install Gyan.FFmpeg       # fournit ffmpeg ET ffprobe, tous deux obligatoires
```

Si yt-dlp a été installé **par pip** plutôt que par winget, il lui manque son moteur JavaScript :

```powershell
python -m pip install --upgrade yt-dlp-ejs
```

Sans lui, yt-dlp ne peut pas exécuter le script de signature de YouTube : la liste de formats revient
**tronquée** et le débit peut être bridé. Constaté sur la vidéo Kerlabo — aucun H.264 1080p60 n'était
proposé avant l'installation, et tous sont apparus après. L'outil passe de lui-même
`--js-runtimes node:<chemin>` : Node est forcément présent puisque c'est lui qui l'exécute.

Node.js 22 est déjà nécessaire au dépôt (Vitest). Rouvre le terminal après l'installation, puis :

```powershell
node tools\extract-manche\extract.mjs --verifier
```

Les trois outils doivent répondre. **`--download-sections` ne fonctionne pas sans FFmpeg.**

---

## Utilisation

```powershell
tools\extract-manche\extraire.cmd ^
  --url https://youtu.be/_SqxZQl5zzQ ^
  --start 05:42:26 --fin 05:43:10 ^
  --lieu Kerlabo --annee 2026 --categorie D3 --type MQ --num 3 --serie 4
```

Les timecodes se collent **tels qu'ils s'affichent sur YouTube** (`H:MM:SS`, `MM:SS`, ou un nombre
de secondes). `--aide` liste toutes les options.

Avant de lancer quoi que ce soit :

| Option | Effet |
|---|---|
| `--verifier` | contrôle seulement la présence et l'âge de yt-dlp / ffmpeg / ffprobe |
| `--dry-run` | affiche la commande yt-dlp exacte, sur une seule ligne, et s'arrête |
| `--plan-corpus` | affiche les images du corpus YOLOX que produirait `--v1` — n'en produit aucune |

`--format` impose un sélecteur yt-dlp (`299+140` par exemple) au lieu du choix automatique. Utile
pour comparer deux pistes sur exactement les mêmes images.

### Quel format est choisi

Par défaut, l'outil demande **de l'avc1 (H.264) servi en DASH sur HTTP**, avec des replis. Deux
raisons, mesurées sur la vidéo Kerlabo :

- laissé libre, yt-dlp choisit l'**AV1** (itag 399, 2681 kbit/s) parce qu'il est plus léger — mais il
  faut alors décoder de l'AV1 1080p60 avant de réencoder, et l'**avc1** (itag 299, 5040 kbit/s) est
  la piste au **plus haut débit**, donc la plus détaillée pour une analyse de détection ;
- les mêmes définitions existent en **m3u8** (HLS) et en **https** (DASH). Le seek par plages
  d'octets qu'exige `--download-sections` est immédiat sur les secondes.

Le mode précis se rabat sur n'importe quel codec si l'avc1 manque — il réencode de toute façon.

---

## Ce qui est produit

`extraits/Kerlabo_2026_D3_Q3_S4.mp4` — MP4 / H.264 / AAC / `yuv420p` / cadence constante /
`start_time = 0`, c'est-à-dire le profil exigé par `videoPlayer.js`. Le fichier est **contrôlé par
`ffprobe` après extraction** : si le profil n'est pas respecté, le script le dit et sort en erreur
plutôt que de laisser découvrir le problème dans le navigateur.

`extraits/Kerlabo_2026_D3_Q3_S4.json` — sidecar `rx-extract/1`, qui porte trois choses distinctes :

1. **l'identité** de la manche (clés Firestore, catégorie, session, série) ;
2. **la recette** (`youtubeId`, `sourceStart`, `sourceEnd`, `padBefore`, `padAfter`, `v1At`) ;
3. **le constat** relevé par ffprobe (`fps`, dimensions, durée, nombre d'images).

> **Le MP4 est jetable, le sidecar ne l'est pas.** La recette tient en 200 octets, se partage, et
> permet à n'importe quelle machine de régénérer l'extrait à l'identique. C'est elle qui a vocation
> à rejoindre Firestore, jamais la vidéo.

Le champ `fps` est celui que `loadFile(file, startAt, { fps })` attend côté lecteur : il évite le
repli silencieux à 25 img/s sur un navigateur sans `requestVideoFrameCallback`.

### Ancrage temporel

`t = 0` de l'extrait correspond exactement à `clipStart` de la retransmission :

```
instant_youtube = clipStart + t_local
```

C'est ce qui permet de reporter dans Firestore un timecode mesuré sur l'extrait.

---

## Les deux modes de coupe

| | `--mode precise` (défaut) | `--mode fast` |
|---|---|---|
| Coupe | **à l'image demandée** | à l'image demandée *via l'edit list du MP4* |
| Images de pré-roll | **aucune** | jusqu'à un GOP (100 images mesurées sur un GOP de 5 s), à timestamps négatifs |
| Dépend du lecteur | non | **oui** : un lecteur qui ignore l'edit list décale tout d'un GOP, silencieusement |
| Vitesse | réencodage de la fenêtre (~5 s mesurées pour 53 s) | quasi instantané |
| Image | réencodée CRF 18 | intacte |

Le mode précis est le défaut parce que sa justesse ne dépend d'aucune interprétation par le
navigateur. Le mode rapide redevient intéressant si le POC montre que Chrome respecte l'edit list :
l'outil **compte les images de pré-roll et le signale**.

---

## Corpus d'images — `corpus.mjs`

À partir d'un extrait et de **deux repères relevés dans le lecteur**, produit les images des zones
du départ et leur manifeste.

```powershell
node tools\extract-manche\corpus.mjs extraits\Kerlabo_2026_D3_Q3_S4.mp4 --depart 43.000 --v1 51.000
```

Les repères se donnent en **temps local de l'extrait**, tel que le lecteur les affiche. La cadence
et l'ancrage absolu viennent du sidecar : rien n'est deviné.

| Zone | Instant | Ce qu'on y teste |
|---|---|---|
| `depart` | départ | voitures alignées, nettes — cas facile de référence |
| `acceleration` | départ + 1,5 s | écarts qui se creusent |
| `approche_v1` | V1 − 1,5 s | voitures plus petites, qui se rapprochent |
| `entree_v1` | V1 | **le cas qui compte** : chevauchements, occlusions |
| `milieu_v1` | V1 + 1,0 s | poussière, angle caméra, vues de côté |
| `sortie_v1` | V1 + 2,5 s | remise en file, éloignement |

Sortie : des **PNG en résolution native** (aucun redimensionnement : le pré-traitement appartient au
détecteur) nommés `<base>__<zone>__t<absolu>__f<image>.png`, plus un `corpus.json` (`rx-corpus/1`).

**L'outil refuse de produire un corpus incomplet.** Si une zone tombe hors de l'extrait, il le dit
et s'arrête : il faut ré-extraire une fenêtre mieux centrée, ou accepter explicitement le corpus
partiel avec `--partiel`. Produire 5 images sur 6 sans le signaler serait exactement le trou
silencieux qu'on cherche à éliminer.

`carsVisible`, `carsDetectable` et `carsOrderCritical` sortent **vides**, à annoter à la main. Le
troisième est délibérément séparé du deuxième : un bon rappel de détection peut masquer une erreur
sur l'ordre au V1, qui est le seul chiffre qui compte au bout.

Options : `--sortie`, `--profil <json>` (les circuits n'ont pas la même distance départ → V1),
`--fps`, `--partiel`, `--dry-run`. `FFMPEG_PATH` impose le chemin de ffmpeg s'il n'est pas dans le
PATH.

### Exactitude des images

```powershell
node tools\smoke\corpusFrames.mjs
```

Fabrique une vidéo dont **chaque image porte une couleur unique déduite de son numéro**, génère le
corpus, puis relit la couleur de chaque PNG pour vérifier qu'il s'agit bien de l'image demandée.
C'est le seul contrôle possible : sur une vraie vidéo, deux images consécutives se ressemblent trop
pour qu'un écart d'une image se voie. Ce test a d'ailleurs révélé un décalage systématique de
+1 image à la première exécution.

---

## Automatisation

Toutes les options peuvent venir d'un fichier JSON plutôt que de la ligne de commande :

```powershell
node tools\extract-manche\extract.mjs --recette manche.json
```

```jsonc
{
  "url": "https://youtu.be/_SqxZQl5zzQ",
  "sourceStart": 20546, "sourceEnd": 20590,
  "padBefore": 3, "padAfter": 6,
  "v1At": 20554,
  "location": "Kerlabo", "year": 2026, "category": "D3",
  "sessionType": "MQ", "sessionNum": 3, "serie": 4,
  "origin": "auto:startDetector@1.0"
}
```

Le contrat d'entrée est donc un **objet**, pas une saisie : qu'un timecode vienne d'un champ texte
ou d'un détecteur automatique ne change rien à l'outil. `origin` sert uniquement à tracer la
provenance, jamais à brancher un comportement différent.

---

## Vérifier la cadence dans le navigateur

Le lecteur mesurait la cadence avec `requestVideoFrameCallback`, qui rapporte la cadence de
**présentation** et non celle du fichier : sur un 1080p60 exigeant, un navigateur qui saute une image
sur deux fait mesurer 30 img/s, et les numéros d'image sont alors faux d'un facteur deux, sans le
moindre signal. C'est pour cela que le sidecar existe — et que le lecteur affiche désormais
« 60 img/s (sidecar) » ou « 30 img/s (mesurée) ».

Dans l'application, sélectionne **la vidéo et son `.json` ensemble** dans « 📁 Fichier local ».

Pour contrôler :

```powershell
node tools\smoke\videoPlayerFps.mjs --serve
```

Ouvre l'URL affichée dans **ton** navigateur, sélectionne les deux fichiers, et lis le tableau :
cadence mesurée contre cadence annoncée, pas image par image réellement appliqué, et numéros d'image
aux instants de ton choix. C'est le seul test qui dise ce que fait vraiment ta machine.

## Tests

La couche pure — fenêtre, marges, nommage, arguments yt-dlp, contrôle ffprobe, sidecar, plan du
corpus — est couverte par `tests/extractManche.test.js` (`npx vitest run`), sans yt-dlp, sans FFmpeg
et sans réseau. Ce qui reste à vérifier sur une vraie vidéo est le POC du §12 du document d'analyse.

---

## Limites et usage

- **yt-dlp doit rester à jour** : c'est le risque n° 1. `yt-dlp -U` avant chaque week-end de course.
  Le script prévient quand la version dépasse 30 jours.
- **Rediffusions seulement** : sur un direct en cours, `--download-sections` n'a pas de sens.
- **Rien n'est versionné** : `.gitignore` bloque les extraits et les images de corpus. Le dépôt est
  public.
- **Usage privé d'analyse.** Techniquement possible ne veut pas dire autorisé : les CGU de YouTube
  interdisent le téléchargement sans accord du titulaire des droits. Le chemin propre est de
  demander l'accord — ou les fichiers sources, souvent meilleurs. Aucun contournement de DRM, d'âge,
  de géo-blocage ou d'accès privé n'est possible ni souhaité ici. Voir §9 du document d'analyse.
