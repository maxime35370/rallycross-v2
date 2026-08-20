# Audit des données historiques — projection de qualification

Scripts d'audit **en lecture seule** utilisés pour rédiger
`docs/qualification-projection/ANALYSE.md`.

Ils répondent à une question précise : les meetings déjà courus permettent-ils
de reconstruire proprement l'état du classement après Q1, Q2 et Q3 ?

## Utilisation

```bash
node tools/qualification-audit/fetch.mjs \
     meetings championships sessions results sessionParticipants
node tools/qualification-audit/01-completude.mjs      # matrice meeting × catégorie
node tools/qualification-audit/02-reconstruction.mjs  # états après Q1..Q4
node tools/qualification-audit/03-courbes.mjs         # courbes et effectifs
node tools/qualification-audit/04-verite-terrain.mjs  # règle dérivée vs réalité
```

`fetch.mjs` lit la configuration Firebase dans `js/firebase.js` (aucune clé
dupliquée ici) et interroge l'API REST Firestore, autorisée en lecture publique
par `firestore.rules`. Les extractions sont écrites dans `data/`, non versionné.

`02-reconstruction.mjs` importe **le vrai code de `js/calc.js`**
(`mqPoints`, `calcStatusPoints`, `ecBonusPoints`, `compareInterimTiebreaker`)
et rejoue la logique de `calcMqStandings` / `calcInterimStandings` : ce qui est
mesuré est donc exactement ce que l'application calculerait, pas une
approximation.
