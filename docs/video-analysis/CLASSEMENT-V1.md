# Classement au premier virage — comment ça marche aujourd'hui

> État du chemin réellement en place, dans l'application. Pour les mesures qui
> ont conduit à ces choix, voir `AUTOMATION-ARCHITECTURE.md` et
> `SUIVI-DIAGNOSTIC.md`.

## Le geste complet

Tout se passe dans **🎥 Analyse des départs**. Il n'y a rien à ouvrir à côté.

1. Choisir la série.
2. Charger la retransmission YouTube, marquer le départ (`D`) et le premier
   virage (`V`).
3. **✂️ Préparer l'extrait** — le serveur local découpe (départ − 3 s → V1 + 2 s)
   et l'extrait se charge tout seul dans le lecteur, les deux marques reportées.
4. **🎬 Analyser la vidéo** — le panneau s'ouvre sous le lecteur.
5. Cliquer les voitures au virage dans l'ordre de passage.
6. **Reprendre ce classement** — les positions arrivent en propositions dans le
   tableau, à valider ou corriger.

Aucune proposition n'entre dans les statistiques sans validation : c'est la
règle absolue de l'application, et elle ne bouge pas ici.

## Ce qui ne peut pas vivre dans la page

Un seul geste : **télécharger la vidéo chez YouTube**. Ses serveurs de média ne
renvoient pas d'en-têtes CORS, donc le navigateur ne peut pas lire ces octets —
c'est un mur, pas un choix. Le serveur local lance `tools/extract-manche`, qui
existait déjà.

Tout le reste — détection, apparence, appariement, pointage — tourne dans
l'onglet. Aucune image ne quitte la machine.

## Pourquoi pas d'isolation d'origine

Le WebAssembly multi-thread exige les en-têtes COOP/COEP, incompatibles avec
l'iframe YouTube du lecteur. Mesuré sur l'extrait de Kerlabo, 24 inférences
YOLOX-s 640 px :

| | threads | durée |
|---|---|---|
| isolé | 4 | 40,8 s |
| non isolé | 1 | 42,8 s |

**×1,05.** Le temps part dans le décodage vidéo, pas dans le calcul. L'isolation
ne valait donc pas de casser le lecteur, et l'analyse est une vue ordinaire.

## Le raisonnement

`js/turn1AnalysisCalc.js`, pur et testé sans navigateur.

**Retirer les boîtes emboîtées.** Une boîte largement contenue dans une plus
grande n'est pas une voiture de plus : c'est un morceau de celle du dessous. Sur
la grille de Kerlabo, le détecteur pose un liseré de 131 × 52 px sur un pavillon.
Comptée comme une voiture, elle décale toute la numérotation de la grille.

**Apparier par affectation hongroise**, pas au plus ressemblant. Deux voitures
peuvent se disputer la même déco ; un choix glouton donnerait à la première venue
son meilleur candidat, quitte à priver une autre de celui dont elle avait un
besoin bien plus net. Le hongrois minimise le coût total.

**Se taire en cas de doute.** Si le second candidat est à moins de 6 % du
meilleur, la position ressort « non décidée ». Une case vide coûte moins cher
qu'une case fausse.

**Dire la bonne raison.** Quand aucun candidat n'est exploitable, tous les coûts
sont au maximum et l'écart vaut zéro — répondre « deux candidats trop proches »
enverrait chercher le mauvais problème. Le diagnostic distingue les deux cas.

## Ce que l'opérateur corrige à la main

- **Une boîte en trop au départ** (voiture d'arrière-plan, bout de stand) :
  cliquer dessus pour l'écarter, recliquer pour la reprendre.
- **Une voiture manquée au virage** : tracer sa boîte à la souris. C'est
  fréquent — de profil, derrière une glissière, dans la poussière — et c'est le
  point faible connu du détecteur à cet instant.
- **La grille lue à l'envers** : ⇄ Inverser, si la caméra filme de l'autre côté.

Le balayage ± 0,5 s autour de chaque marque sert à cela : il retient l'instant où
le détecteur voit le plus de voitures, plutôt que celui que le hasard du timecode
a désigné.

## Où sont les choses

| | |
|---|---|
| `js/turn1AnalysisCalc.js` | le raisonnement, pur et testé |
| `js/turn1Analysis.js` | le panneau : DOM, canvas, appel au détecteur |
| `js/vision/detect.js` | YOLOX : lettrage, décodage, fusion |
| `js/vision/apparence.js` | signature `hsv-zonee/1` et distance |
| `js/vision/hongrois.js` | affectation de coût minimal |
| `tools/yolox-poc/` | bancs de diagnostic, hors application |

ONNX Runtime (8 Mo) et le modèle (35 Mo) sont servis par le serveur local à
`/__ort/` et `/__modele/`, chargés au premier usage seulement. Sans serveur
local, le panneau le dit au lieu d'échouer en silence.
