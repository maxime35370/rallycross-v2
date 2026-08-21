# Tests des règles Firestore

```bash
npm run test:rules
```

Démarre l'émulateur Firestore, exécute `tests/rules/`, l'arrête. Rien à
lancer à la main.

**Prérequis** : une JVM (Java 11+). L'émulateur télécharge son JAR au premier
lancement. C'est pourquoi ces tests ne font PAS partie de `npm test` : la
suite ordinaire ne doit pas dépendre de Java.

## Bruit résiduel dans les journaux

L'émulateur affiche `evaluation error at L339` / `L425` sur les deux règles
`allow update` de `/users` et `/licenses`, lors d'un `set()` visant un
document **inexistant**. Le moteur évalue alors aussi la branche `update`,
où `resource` est nul.

Vérifié : **le refus est correct dans les 56 cas**, toutes les opérations
légitimes passent, et tous les accès de propriété du fichier utilisent
`get(clé, défaut)`. Ni le garde `resource != null`, ni les accès sûrs ne
suppriment ce message : le moteur le produit avant le court-circuit. C'est
un diagnostic d'évaluation spéculative, pas un défaut de règle.

En revanche l'erreur qui vivait sur le chemin chaud — `drivers.personId`,
déclenchée à **chaque enregistrement de pilote** — est corrigée.
