# Optimisation des lectures Firestore — lot 1

Branche de travail : `claude/admiring-ptolemy-yr2nfi` (aucune écriture de chrono modifiée,
aucune donnée modifiée : uniquement la façon de **lire**).

## Ce qui change

| Où | Avant | Après |
|---|---|---|
| `js/spectator.js` — classement intermédiaire | recalculé **toutes les 30 s par visiteur** en relisant résultats + participants de l'EC et des 4 MQ (≈ 10×N documents à chaque tour), même onglet caché | calculé **en mémoire** à partir d'écoutes temps réel des EC/MQ (1 lecture à l'ouverture, puis 1 par chrono modifié) ; participants relus au plus toutes les 10 min, et seulement si l'onglet est visible |
| `js/spectator.js` — ouverture | résultats de chaque session lus **deux fois**, + 1 écoute en plus sur la session courante | une seule lecture par session |
| `js/driverProfile.js` | relit toutes les manches du meeting, puis `calcInterimStandings` les **relit** | le classement intermédiaire est calculé depuis les données déjà lues |
| `js/championship.js`, `overlay/_lib/obs-data.js` — `getMeetingPoints` | participants des phases QF/DF/FIN lus **deux fois** | lus une fois, partagés |
| `js/calc.js` | `calcInterimStandings` mélange lecture et calcul | calcul extrait dans `buildInterimFromData` (pure) ; `calcInterimStandings` l'appelle, donc **une seule logique** |

## Ordres de grandeur (estimation, à confirmer en console)

Hypothèses : meeting EC + 4 MQ + 2 DF + FIN, ~10 pilotes par phase finale, N pilotes par catégorie.

| | N=15 | N=20 | N=30 |
|---|---|---|---|
| Spectateur, par heure ouverte — avant | 9 000 à 18 000 | 12 000 à 24 000 | 18 000 à 36 000 |
| Spectateur, par heure ouverte — après (hors saisies) | ≈ 450 | ≈ 600 | ≈ 900 |
| Spectateur, ouverture : lectures évitées | ≈ 195 | ≈ 250 | ≈ 360 |
| Profil pilote (6 meetings) : lectures évitées | ≈ 900 | ≈ 1 200 | ≈ 1 800 |
| `getMeetingPoints` : lectures évitées par appel | ≈ 30 | ≈ 30 | ≈ 30 |

Ajouter, côté spectateur, ~1 lecture par chrono saisi (écoute temps réel).

## Comment comparer avant / après

1. **Console Firebase → Firestore → Utilisation** : courbe « Lectures » du dernier meeting
   (avant) puis du meeting où cette branche aura été déployée (après), à nombre de spectateurs
   comparable.
2. **Tests** : `npx vitest run tests/lecturesFirestore.test.js` — un faux Firestore en mémoire
   compte les documents lus et vérifie que le calcul en mémoire donne **exactement** le même
   classement que la lecture complète (15, 20 et 30 pilotes).

## Limites connues

- Le comportement temps réel de la page spectateur n'a pas pu être exercé dans un navigateur ici
  (les SDK Firebase sont chargés depuis gstatic.com, injoignable depuis le conteneur). Le smoke
  test vérifie que les modules se chargent ; la logique de calcul est couverte par les tests.
  À vérifier à la main sur un meeting de test avant mise en production.
- Un autre onglet spectateur reste libre de s'abonner : le coût par visiteur diminue, il ne
  disparaît pas.
- Non traité dans ce lot : overlay OBS (recalculs à chaque saisie), projection de
  qualification, tri EC de la régie (`timing.js`), `loadChampionshipData` du spectateur.
