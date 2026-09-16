# Vérification visuelle — application réelle, données de test

```bash
npx firebase emulators:exec --only firestore,auth \
    --project rallycross-1512f "node tools/dev/demo.mjs"
```

Amorce les émulateurs, sert le site **tel quel**, pilote un navigateur et
capture dans `shots/` ce qu'un administrateur, un team et un visiteur voient
réellement.

Sert à **vérifier** un écran plutôt qu'à l'affirmer. Trois défauts trouvés
par ce seul moyen pendant le lot A0 :

| Défaut | Pourquoi les tests ne l'ont pas vu |
|---|---|
| Erreur de syntaxe dans `accessAdmin.js` | aucun test ne chargeait ce module — corrigé depuis par `tests/moduleSyntax.test.js` |
| Règle `teamMembers` refusant la **requête** « mes teams » | les tests de règles ne couvraient que la lecture par identifiant, jamais une requête |
| Sélecteur de meeting masqué quand rien n'est autorisé | un team n'avait aucun moyen d'atteindre le meeting qu'il avait acheté |

## Prérequis et contournements du conteneur

| | |
|---|---|
| JVM | pour les émulateurs |
| `?emulator` sur `localhost` | seul moyen d'aiguiller l'application vers les émulateurs — double verrou dans `js/firebase.js`, inopérant en production |
| Proxy transmis au navigateur | Chromium n'hérite pas de `HTTPS_PROXY`, avec `bypass` sur `127.0.0.1` |
| SDK Firebase servi depuis `node_modules` | `gstatic.com` est injoignable depuis ce conteneur ; les bundles de `node_modules/firebase/` sont les mêmes fichiers |
| URL de version normalisées | l'application importe `10.12.0`, les bundles s'importent en `12.18.0` — deux URL = deux instances de module = « Service firestore is not available » |
| `domcontentloaded`, jamais `networkidle` | Firestore garde un flux Listen ouvert : le réseau n'est jamais au repos |

## Comptes du jeu de démonstration

| Adresse | Mot de passe | Rôle |
|---|---|---|
| `maxime.theard@gmail.com` | `demo1234` | régie |
| `alice@teamdupont.fr` | `demo1234` | Team Dupont — licence saison FFSA sur Fabien Pailler |
| `bob@teamdupont.fr` | `demo1234` | Team Dupont, second membre |
| `eric@nonverifie.fr` | `demo1234` | compte non vérifié |

Trois meetings, dont **deux à Lohéac le même jour** — un par championnat.
C'est le cas qui doit se voir : la licence FFSA ouvre l'un et pas l'autre.
