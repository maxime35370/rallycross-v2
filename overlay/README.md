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
  scene: 'dashboard'|'grid'|'next-heat'|'intermission',
  visible: true,
  championshipId, meetingId, category,        // sélection
  sessionType: 'EC'|'MQ'|'QF'|'DF'|'FIN', sessionNum,
  standingsMode: 'interim'|'meeting'|'championship',
  headerText: '…',                            // en-tête éditable (infos circuit)
  gridOverride: null | { key, slots:[{pos,carNumber,lastName}] },  // AFFICHAGE seulement
  updatedAt
}
```

## Prévisualiser sans Firestore

- `overlay/demo/showcase.html?scene=dash|race|standings|grid|next|intermission` — maquettes.
- `overlay/demo/_render-test.html?scene=dashboard|grid|next-heat|intermission` — **vrai** code
  de rendu alimenté en données fictives.
