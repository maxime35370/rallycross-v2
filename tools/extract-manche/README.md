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

## Corpus YOLOX (préparé, pas encore construit)

`--v1 <timecode>` enregistre l'instant d'abord du premier virage dans le sidecar. Avec ce second
repère, `--plan-corpus` affiche les 6 instants du profil par défaut — départ, accélération, approche
V1, entrée V1, milieu V1, sortie V1 — chacun **calé sur un numéro d'image entier**, condition pour
comparer plus tard YOLOX-tiny et YOLOX-s sur exactement les mêmes images.

La découpe effective des PNG n'est **pas** implémentée : c'est le lot suivant
([§13 du document d'analyse](../../docs/video-analysis/EXTRACTION-YOUTUBE.md#13-extension--générer-automatiquement-les-images-du-corpus-yolox)).

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
