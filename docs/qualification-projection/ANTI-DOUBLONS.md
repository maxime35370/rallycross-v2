# Inscriptions en double aux sessions — protection et déploiement

## Le problème, et pourquoi il n'est pas cosmétique

Des documents `sessionParticipants` inscrivent deux fois le même pilote à la
même manche :

```
2026-08-30  Loheac   / D4  — effectifs par manche : 38 / 24 / 24 / 24  → 14 doublons en Q1
2026-09-20  Mayenne  / D3  — effectifs par manche : 31 / 31 / 48 / 31  → 17 doublons en Q3
```

Le nombre d'engagés alimente `statusRules.DNF` en mode `engaged_offset`. Sur
Loheac D4, 38 engagés au lieu de 24 donneraient à un abandon les points de la
place 39 au lieu de la place 25. Un pilote en double apparaîtrait en outre deux
fois au classement de sa manche.

Les deux meetings concernés sont à venir : l'historique n'est pas pollué
aujourd'hui, mais il le serait dès qu'ils seront courus.

## Origine

`results` porte un identifiant déterministe `${sessionId}_${driverId}` : le
doublon y est structurellement impossible. `sessionParticipants` était créé par
`addDoc`, donc avec un identifiant aléatoire, précédé d'une vérification
d'existence non atomique : deux clics rapprochés, ou deux onglets ouverts,
créaient deux documents.

`sessions.js` écrit en identifiant déterministe depuis le 14 mai 2026 — c'est
la date du document à identifiant historique le plus récent, visible dans
l'écran « Qualité des données ». Les 3 104 documents restants sont antérieurs.

## Ce qui est en place

**À l'écriture — côté client.** `utils.sessionParticipantId()` centralise la
convention ; `sessions.js` l'utilise via `setDoc`. Un test vérifie qu'aucun
module n'inscrit un participant par `addDoc` et que la formule littérale n'est
pas recopiée ailleurs.

**À l'écriture — côté serveur.** `firestore.rules` impose le format à la
création. C'est la seule protection réelle : le client peut être contourné, la
règle non.

**À la lecture — défensif.** `utils.dedupeParticipants()` est appliqué par
`calc.js`, `standings.js`, `championship.js`, `timing.js` et le module de
projection. Les documents déjà en base ne disparaîtront pas d'eux-mêmes.

## Déploiement — action manuelle requise

Le dépôt n'a **aucun mécanisme de déploiement automatique** : conformément à
`docs/video-analysis/ARCHITECTURE.md`, les règles sont collées à la main dans
la console Firebase. La règle ci-dessous est versionnée mais **n'est pas encore
active tant qu'elle n'a pas été déployée**.

1. Console Firebase → projet `rallycross-1512f` → **Firestore Database** →
   onglet **Règles**.
2. Remplacer le bloc `match /sessionParticipants/{docId}` par celui de
   `firestore.rules` (reproduit ci-dessous).
3. **Publier**.

```
match /sessionParticipants/{docId} {
  allow read:   if true;
  allow delete: if isRegie();

  allow create: if isRegie() &&
    hasFields(request.resource.data, ['sessionId','driverId','carNumber']) &&
    docId == request.resource.data.sessionId + '_' + request.resource.data.driverId;

  allow update: if isRegie() &&
    hasFields(request.resource.data, ['sessionId','driverId','carNumber']) &&
    request.resource.data.sessionId == resource.data.sessionId &&
    request.resource.data.driverId  == resource.data.driverId;
}
```

`create` et `update` sont volontairement séparés : la mise à jour reste
possible sur les documents antérieurs, qui portent un identifiant aléatoire et
qu'il faut pouvoir corriger ou supprimer. Elle ne peut en revanche plus
repointer une inscription vers un autre pilote ou une autre session, ce qui
serait un moyen détourné de recréer un doublon.

**Vérification après déploiement.** Ouvrir Projection de qualification →
Qualité des données → « Protection contre les inscriptions en double ». La date
du document à identifiant historique le plus récent ne doit jamais devenir
postérieure au déploiement. Si elle le devient, la règle n'est pas active.

## Procédure de déploiement — à exécuter avant la mise en production

Le dépôt ne contient aucun mécanisme de déploiement des règles Firestore : elles
se collent à la main dans la console. La procédure tient en cinq étapes.

1. **Sauvegarder les règles actuelles.** Console Firebase → Firestore Database →
   Règles → copier le contenu affiché dans un fichier local daté. C'est le seul
   moyen de revenir en arrière.
2. **Coller le contenu de `firestore.rules`** (racine du dépôt), en entier.
3. **Publier**, puis attendre la confirmation de la console.
4. **Vérifier immédiatement que l'écriture normale fonctionne encore** : ouvrir
   une session en Chronométrage, ajouter puis retirer un participant de test.
   Une règle trop stricte se manifesterait ici, pas plus tard.
5. **Vérifier que la protection est active** : Projection de qualification →
   Qualité des données → « Protection contre les inscriptions en double ». La
   date du document à identifiant historique le plus récent doit rester
   antérieure au déploiement. Si un document postérieur apparaît, la règle
   n'est pas appliquée — revenir aux règles sauvegardées et investiguer.

En cas de doute, l'étape 1 suffit à tout annuler : republier le fichier
sauvegardé restaure exactement l'état antérieur.

**Cette procédure est indépendante du déploiement du code.** Le site fonctionne
sans elle ; elle empêche seulement la création de NOUVEAUX doublons. La déployer
avant le prochain meeting est ce qui compte, pas avant le prochain déploiement
du site.

## Ce qui n'est PAS fait, délibérément

**Aucune suppression automatique des documents existants.** Reprendre les
3 104 documents à identifiant historique, ou les 31 doublons, relève d'une
migration dédiée : il faut décider quel document conserver, vérifier qu'aucun
`results` n'y est rattaché indirectement, et pouvoir revenir en arrière.

**Un point à arbitrer :** `timing.js` supprime déjà, en arrière-plan et
silencieusement, les doublons d'une session lorsqu'on l'ouvre en Chronométrage
(comportement antérieur à ce travail, conservé tel quel). Il ne supprime que
les inscriptions redondantes d'un même pilote, en gardant celle à identifiant
déterministe ou, à défaut, la plus ancienne. Si cette suppression automatique
n'est pas souhaitée, c'est le seul endroit à modifier.
