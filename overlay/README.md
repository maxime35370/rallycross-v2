# Overlays OBS — RX Chrono

Habillage TV pour un live Twitch d'analyse rallycross. Les overlays sont des
pages web **statiques** qui lisent **ta base Firestore** (la même que l'app) en
temps réel. Aucun serveur Node, aucune nouvelle base : Firestore sert à la fois
de données **et** de canal temps réel.

## Architecture

```
Firestore (cloud)
  ├─ tes données (results, sessions, championships…)   ← LECTURE SEULE par les overlays
  └─ obsControl/live                                    ← écrit par /control, lu par l'overlay
        │
   ┌────┴───────────────┐
   │  /control (régie)   │  tu choisis scène / catégorie / phase / en-tête / grille
   └────┬───────────────┘
        ▼ (doc obsControl/live)
   overlay/live.html  ──►  OBS "Source navigateur" 1920×1080 (fond transparent)
```

- **`live.html`** : LA page à mettre dans OBS. Affiche la scène demandée par la régie.
- **`control.html`** : la régie (2ᵉ écran / tablette / téléphone). **Seule page qui écrit**,
  et uniquement le petit doc `obsControl/live` — jamais tes vraies données.

## Lancer en local

Les modules ES nécessitent un serveur HTTP (pas `file://`) :

```bash
cd rallycross-v2
python3 -m http.server 5500      # ou : npx serve -l 5500
```

- Overlay : `http://localhost:5500/overlay/live.html`
- Régie   : `http://localhost:5500/overlay/control.html`

## OBS

1. **+ Source → Source navigateur**, **Largeur 1920 / Hauteur 1080**.
2. URL = `http://localhost:5500/overlay/live.html`.
3. Le fond est transparent → l'overlay se pose sur ta vidéo.
4. Tu pilotes tout depuis `/control` : pas besoin de toucher OBS en direct.
   Le toggle « Overlay visible » masque l'overlay (fondu) **sans couper les
   données** — tu prépares en caché, puis tu réaffiches.

## Règle de sécurité Firestore (à coller dans la console Firebase)

Lecture publique du contrôle (pour l'overlay), écriture réservée à un compte connecté :

```
match /obsControl/{doc} {
  allow read: if true;
  allow write: if request.auth != null;
}
```

(Les overlays ne font que **lire** `results`, `sessions`, etc. — garde tes règles existantes pour ces collections.)

## Document de contrôle `obsControl/live`

```js
{
  scene: 'dashboard'|'studio'|'grid'|'next-heat'|'intro'|'intermission'|'ending'|'fiche',
  bgTheme: 'carbon'|'paddock'|'asphalt'|'ember'|'nitro'|'forest'|'chroma',
  studio: { boards:['manche'|'interim'|'meeting'|'champ'], rotate, rotateSec, active, bottom:'none'|'predict'|'wait'|'sponsors', showVideo },
  countdownEnd, countdownStart,
  visible: true,
  championshipId, meetingId, category,        // sélection
  sessionType: 'EC'|'MQ'|'QF'|'DF'|'FIN', sessionNum,
  standingsMode: 'interim'|'meeting'|'championship',
  headerText: '…',                            // en-tête éditable (infos circuit)
  gridOverride: null | { key, slots:[{pos,carNumber,lastName}] },  // AFFICHAGE seulement
  updatedAt
}
```

## Mode préparation (aperçu avant antenne)

Deux documents Firestore : `obsControl/live` (**ANTENNE**) et `obsControl/preview` (**PRÉPARATION**).

- **Désactivé** (défaut) : chaque réglage de la régie part directement à l'antenne.
- **Activé** : les réglages (scène, catégorie, phase, plateau, textes, fond, vidéo…) s'écrivent dans la préparation ;
  l'antenne ne bouge pas. Un 2ᵉ moniteur « PRÉPARATION » (`live.html?doc=preview`, toujours visible, sans lecteur
  vidéo ni caméra) montre le résultat. **▶ Mettre à l'antenne** copie la préparation vers l'antenne ;
  **↺ Recopier l'antenne** repart de l'antenne. L'indicateur liste ce qui sera envoyé.
- Restent **toujours directs** : « Overlay visible à l'antenne » (coupe tout l'overlay) et le **chrono**
  (instants absolus — un chrono préparé serait faux au moment de la prise d'antenne).
- Au premier passage en préparation (ou si la préparation date de plus de 12 h), elle repart d'une copie de l'antenne.
- Code : logique pure dans `_lib/obs-stage.js` (testée : `tests/obsStage.test.js`).

## Scènes, fond global et DA « Pit Lane »

Scènes pilotables depuis `/control` : 🎬 Intro · 📊 Dashboard · 📺 **Plateau 1/3·2/3** · 🏁 Grille ·
👤 Fiche / Duel · ⏭️ À suivre · ⏸️ Attente · 🔚 Fin de stream.

- **Fond global** (`bgTheme`) : Carbone (rendu d'origine), Paddock, Asphalte, Braise, Nitro, Sous-bois,
  ou **Fond vert #00FF00** (chroma). `?bg=<thème>` dans l'URL de la source l'emporte (ex. `?bg=chroma`).
  Avec `?transparent=1` (OBS) le fond est désactivé.
- **Plateau** (`studio`) : tiers gauche (592 px) = classement **affiché en entier** (aucune limite à 10 :
  la densité des lignes s'adapte à l'effectif) ; 2/3 droite = vidéo 16/9 (1240×697 px, source « Source vidéo »,
  ex. live YouTube) ; dessous, un bandeau au choix : Prédiction · Attente (message + compte à rebours) ·
  Sponsors/info · Aucun.
  - Classements : Manche (session sélectionnée) · Intermédiaire · Meeting · Championnat — mêmes calculs que le Dashboard,
    catégorie/phase = celles de la régie.
  - **Rotation** automatique entre les classements cochés (5 à 120 s, 15 s par défaut) ; les classements vides sont sautés.
    Rotation off : un seul classement affiché (au choix parmi les cochés).
- **Compte à rebours** (Intro, Attente, Fin, bandeau « Attente » du Plateau) : anneau de progression ; à 0 l'overlay
  affiche « ÇA REPREND ! » et la **régie affiche une alerte** (bannière + bip + titre d'onglet) avec
  « Compris », « +2 min » et « → Dashboard ».
- Code : logique pure dans `_lib/obs-studio.js` (testée : `tests/obsStudio.test.js`), styles dans `_lib/overlay-da.css`.

## Prévisualiser sans Firestore

- `overlay/demo/showcase.html?scene=dash|race|standings|grid|next|intermission` — maquettes.
- `overlay/demo/_render-test.html?scene=dashboard|grid|next-heat|intermission|intro|ending|studio` — **vrai** code
  de rendu alimenté en données fictives.
