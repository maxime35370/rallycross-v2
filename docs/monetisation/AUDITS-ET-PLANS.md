# Audits de terrain et deux mini-plans

Suite de `ANALYSE-FAISABILITE.md` et `IMPACT-HEBERGEMENT-ET-VIDEO.md`.
**Aucun code applicatif écrit, aucune modification de `main`.**
Audits exécutés le 2026-08-21 sur la base de production `rallycross-1512f`, en **lecture seule**,
via l'API REST Firestore.

---

# AUDIT 1 — `/docs/` est-il public sur Netlify ?

## 1.1 Ce que je n'ai pas pu vérifier, et pourquoi

**Je n'ai pas pu le tester.** L'environnement d'exécution où je tourne bloque `rxchrono.netlify.app`
au niveau du proxy réseau (`gateway answered 403 to CONNECT`). Ce n'est pas un problème de ton
site : le même environnement joint sans difficulté `firestore.googleapis.com`, ce qui m'a permis
de faire l'audit 2. C'est une restriction de mon côté, pas du tien.

**La commande à lancer toi-même, dix secondes :**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rxchrono.netlify.app/docs/qualification-projection/ANALYSE.md
curl -s -o /dev/null -w "%{http_code}\n" https://rxchrono.netlify.app/package.json
curl -s -o /dev/null -w "%{http_code}\n" https://rxchrono.netlify.app/firestore.rules
```

`200` = public. `404` = déjà exclu.

## 1.2 Ce que l'on sait avec certitude

Le dépôt **ne contient aucun `netlify.toml`, aucun `_redirects`, aucun `_headers`**. La
configuration vit donc entièrement dans l'interface Netlify. Or le comportement par défaut de
Netlify, sans commande de build, est de **publier la racine du dépôt telle quelle**.

Sauf réglage manuel dans l'interface que je ne peux pas voir, il faut donc considérer comme
**publics** :

| Chemin | Contenu | Poids |
|---|---|---|
| `/docs/qualification-projection/` | ANALYSE, LOT-2 à LOT-6, ANTI-DOUBLONS — **toute ta méthode et tes backtests** | ~130 ko |
| `/docs/video-analysis/` | ARCHITECTURE, AUTOMATION-ARCHITECTURE, TRACKING-EVALUATION — **tes mesures et ta stratégie** | ~150 ko |
| `/firestore.rules` | tes règles de sécurité complètes | 9 ko |
| `/tools/qualification-audit/` | **le script qui aspire ta base**, prêt à l'emploi | ~90 ko |
| `/tests/` | 15 fichiers de tests | 436 ko |
| `/overlay/demo/*.png` | 20 captures d'écran | **6,0 Mo** |
| `/package.json`, `/vitest.config.js` | — | — |

Ce n'est pas grave aujourd'hui — tout est déjà sur un dépôt GitHub public. **Ça le devient le jour
où tu vends**, pour trois raisons : ta méthode devient un argument commercial, `firestore.rules`
publié à côté d'un produit payant est une invitation à en chercher les trous, et
`tools/qualification-audit/fetch.mjs` livre l'outil d'extraction avec le mode d'emploi.

## 1.3 La façon la plus simple d'exclure, sans rien casser

**Créer un `netlify.toml` à la racine, trois lignes :**

```toml
[build]
  command = "rm -rf docs tests tools overlay/demo/*.png"
  publish = "."
```

Pourquoi c'est la bonne réponse :

- Netlify clone le dépôt dans un conteneur jetable, exécute `command`, puis publie `publish`.
  **Le `rm -rf` ne touche que la copie de build** — ton dépôt et ta machine ne bougent pas.
- **Aucune restructuration**, aucun fichier déplacé, aucun chemin à changer dans le code.
- Ce n'est pas un build au sens habituel : pas de bundler, pas de `npm install`, pas de
  transpilation. La propriété « aucun build » du projet est conservée dans l'esprit.
- Les fichiers ne sont **pas déployés du tout** — pas simplement masqués.

**Vérifications faites pour ne rien casser :**

| Point vérifié | Résultat |
|---|---|
| Un module JS charge-t-il un fichier de `docs/`, `tests/` ou `tools/` ? | **non** — seulement des mentions en commentaires et une référence textuelle affichée dans `projectionStats.js:1942` (du texte, pas un lien) |
| `overlay/index.html` référence-t-il `demo/` ? | **oui** — 7 liens vers `demo/showcase.html` |
| `showcase.html` charge-t-il les PNG ? | **non** — aucune référence à un `.png` dans les fichiers HTML de `demo/` |

D'où le `overlay/demo/*.png` plutôt que `overlay/demo` : **les 20 captures pèsent 6,0 Mo à elles
seules**, les pages HTML de démo n'en font que 120 ko et restent liées depuis `overlay/index.html`.
Les supprimer toutes casserait ces sept liens.

> **Gain : ~6,6 Mo de déploiement en moins, et ta méthode n'est plus servie à côté du produit.**

⚠️ **Un seul point d'attention** : renseigner `command` dans `netlify.toml` **prend le pas sur les
réglages de l'interface Netlify**. Vérifie d'abord la valeur actuelle de « Publish directory » dans
l'interface et reporte-la dans `publish` — si elle vaut autre chose que `.`, adapte.

**À éviter** : la solution par redirection forcée (`/docs/* /404.html 404!` dans `_redirects`).
Elle *masque* sans *retirer* : le fichier reste déployé, et une variante de chemin non prévue le
rouvre. Acceptable en dépannage d'une heure, pas comme solution.

---

# AUDIT 2 — `personId`

Exécuté en lecture seule sur la base de production. **272 fiches personne, 284 inscriptions
sportives, 1 093 engagements, 12 meetings, 2 championnats.**

## 2.1 Résultat principal : c'est propre

| Contrôle | Résultat | Verdict |
|---|---|---|
| `drivers` **sans** `personId` | **0 / 284 (0,0 %)** | ✅ **couverture totale** |
| `personId` pointant une fiche inexistante | **0** | ✅ aucun orphelin |
| Fiches personne sans aucune inscription | **0** | ✅ aucun résidu |
| Dérive de dénormalisation (`driver.nom` ≠ `person.nom`) | **0 / 284** | ✅ la cascade de `drivers.js` fonctionne |
| Doublons exacts (prénom + nom normalisés) | **1 groupe / 272** | ⚠️ voir §2.2 |
| Quasi-doublons (distance ≤ 2) | **2 paires** | ⚠️ voir §2.2 |
| Inversions prénom/nom | **0** | ✅ |

**C'était le risque que j'avais classé « élevé » dans la première analyse. Il ne l'est pas.**
La reprise de données que j'avais estimée à plusieurs jours n'existe pas : il y a **trois fiches à
regarder**, pas trois cents. L'estimation du lot licences s'en trouve allégée.

## 2.2 Les trois cas à trancher — et ils tiennent en cinq minutes

**a) Doublon exact — Maxime Morin (probablement un test à toi)**

| Fiche | Licence | Inscription |
|---|---|---|
| `W69FOpcPwt2zDCBuZJIz` | `123456` | #411 D4 2026 |
| `a99NpcuKjiMmP0ssGxd7` | `654321` | #461 D4 2026 |

Ce sont **les deux seules fiches de toute la base à porter un numéro de licence**, et ces numéros
sont `123456` et `654321`. Tout indique un test délibéré du parcours « homonyme » de
`js/persons.js:63`. **À confirmer par toi** : si ce sont des données de test, supprime-les ; si
Maxime Morin est un vrai pilote avec deux voitures en D4, les deux fiches doivent fusionner.

**b) Quasi-doublon sérieux — Mickael / Michael Leonard**

| Fiche | Orthographe | Nationalité | Inscription |
|---|---|---|---|
| `bpRUyFz1hZCrSs5mXyry` | **Mick**ael Leonard | Irlande | #97 Supercar — Championnat FFSA |
| `qlTgFXpjzR40IiB5FvVG` | **Mich**ael Leonard | Irlande | #117 RX1 — Euro RX |

Même patronyme, même nationalité, une lettre d'écart, et une inscription dans **chacun** des deux
championnats — c'est exactement le profil des onze autres pilotes qui courent les deux. **Candidat
très probable à la fusion**, mais c'est ton appel : je ne vais pas décider à ta place qu'un pilote
existe ou non.

**c) Faux positif — Nine / Noé Foulfoin**

Prénoms **différents**, l'une en Féminines (#297), l'autre en D4 (#497). Ce sont deux personnes
distinctes. **Ne pas fusionner.** Ce cas est utile : il montre qu'un rapprochement automatique par
distance orthographique se tromperait, et qu'une fusion doit rester une décision humaine.

## 2.3 Le cas que la licence doit couvrir : **12 pilotes concernés**

12 fiches personne portent 2 inscriptions. Et le résultat est plus intéressant que prévu :

> **Onze des douze cas sont des pilotes qui courent dans les DEUX championnats**, pas dans deux
> catégories du même championnat.

| Pilote | Inscription 1 | Inscription 2 |
|---|---|---|
| Fabien Pailler | #7 Supercar — FFSA | #29 RX1 — Euro RX |
| Julien Febreau | #16 Supercar — FFSA | #16 RX1 — Euro RX |
| Derek Tohill | #77 Supercar — FFSA | #177 RX1 — Euro RX |
| John McCluskey | #62 Supercar — FFSA | #59 RX1 — Euro RX |
| Jeremy Lambec | #166 Super1600 — FFSA | #66 RX3 — Euro RX |
| Julien Meunier | #115 Super1600 — FFSA | #15 RX3 — Euro RX |
| Tom Le Jossec | #135 Super1600 — FFSA | #35 RX3 — Euro RX |
| Dylan Dufas | #189 Super1600 — FFSA | #9 RX3 — Euro RX |
| Thomas Quince | #225 Division 5 — FFSA | #25 RX4 — Euro RX |
| Marin Le Jossec | #315 D3 — FFSA | #15 RX5 — Euro RX |
| **Adrien Le Quere** | **#313 D3 — FFSA** | **#98 Supercar — FFSA** |
| Andrea Benezet | #57 RX1 — Euro RX | #12 RX4 — Euro RX |

**Ta description initiale décrivait le cas d'Adrien Le Quere** (deux catégories du même
championnat) — il existe, mais c'est **un cas sur douze**. Le cas dominant est le pilote qui fait la
saison française *et* la saison européenne.

Cela ne remet pas en cause la licence par fiche pilote — au contraire, elle reste indispensable :
sans elle, Fabien Pailler serait deux clients. Mais **cela déplace la question du périmètre**, qui
est traitée au §2.5.

## 2.4 Les champs de `persons` : présents mais vides

| Champ | Renseigné |
|---|---|
| `firstName`, `lastName`, `createdAt` | 272 / 272 |
| `nationality`, `team`, `notes`, `licenseNumber`, `birthDate` | **présents** sur 270 / 272 — mais **vides** |
| `licenseNumber` avec une valeur réelle | **2 / 272** (et ce sont les deux valeurs de test du §2.2) |
| `birthDate` avec une valeur | **0 / 272** |

Le schéma prévoit donc déjà la bonne clé naturelle — **le numéro de licence FFSA** — mais elle
n'est pas alimentée. Ce n'est pas urgent : avec un seul doublon réel sur 272 fiches, le
rapprochement par nom suffit largement à ton échelle. Ça le deviendra vers 1 000 fiches, ou le jour
où deux homonymes courent la même catégorie. **Recommandation : renseigner `licenseNumber` au fil
de l'eau pour les pilotes sous licence commerciale**, pas de reprise de masse.

## 2.5 La découverte qui demande une décision commerciale : **Lohéac existe deux fois**

| championnat | meetings 2026 |
|---|---|
| `champ_1775737455330` — **Championnat FFSA Rallycross 2026** (actif) | Lessay 03/05, Faleyras 17/05, **Kerlabo 26/07**, Tours 12/07, **Lohéac 30/08**, Mayenne 20/09, Dreux 11/10 — **7 meetings** |
| `champ_1775771412329` — **Euro RX** | Bikernieki 10/05, Nyirad 31/05, Höljes 16/06, Mondello Park 08/07, **France – Lohéac 30/08** — **5 meetings** |

> **Deux documents `meetings` distincts portent la date du 30/08/2026 à Lohéac.**

C'est la réalité du terrain — Lohéac accueille l'épreuve européenne et le championnat de France le
même week-end — mais cela a **trois conséquences directes sur le modèle de licence** :

1. **Un « PASS MEETING Lohéac » est ambigu.** Il faut choisir *lequel*. Le modèle
   `licenses.meetingId` gère cela nativement, mais **l'écran d'achat/attribution doit afficher le
   championnat à côté de la date et du lieu**, sinon tu vendras le mauvais.
2. **Un pilote présent dans les deux épreuves (Fabien Pailler, Derek Tohill, Julien Febreau…)
   aurait besoin de deux PASS MEETING pour le même week-end.** À trancher : est-ce acceptable
   commercialement, ou faut-il un « pass week-end » couvrant tous les meetings d'une même date ?
   Mon avis : **laisse deux passes**. Ce sont deux courses différentes, deux plateaux différents,
   deux analyses différentes — et un team qui fait les deux a les moyens des deux.
3. **Mon hypothèse de « 10 meetings par saison » est fausse : c'est 7 côté FFSA et 5 côté Euro.**
   Ta règle « saison = meeting × N × 0,85 » doit donc utiliser le **N réel du championnat**, pas
   une constante. C'est déjà ce que prévoit le champ `pricing.meetingsPerSeason`, mais il faut le
   renseigner **par championnat** :
   - FFSA : 7 meetings → saison = prix × 7 × 0,85 = **prix × 5,95**
   - Euro RX : 5 meetings → saison = prix × 5 × 0,85 = **prix × 4,25**

   Une remise de 15 % sur 5 meetings est beaucoup moins attractive que sur 10. **Tu voudras
   probablement une remise différente par championnat** — le modèle le permet déjà, il suffit de ne
   pas coder la valeur en dur.

## 2.6 Conclusion de l'audit 2

**Le risque « appariement `personId` » que j'avais classé élevé n'existe pas.** Trois fiches à
regarder, cinq minutes de travail, aucune reprise de masse. La licence par fiche pilote est
confirmée comme le bon modèle, et elle est **immédiatement utilisable**.

En revanche, deux choses que je n'avais pas vues sont apparues :

- le cas dominant est le **multi-championnat**, pas le multi-catégorie ;
- **Lohéac est deux meetings distincts** le même jour, ce qui impose de désambiguïser dans
  l'interface et de repenser la remise saison par championnat.

---

# PLAN A — Comptes + licences

**Objectif** : pouvoir créer quelques comptes team et leur attribuer **à la main** un accès à une
fiche pilote, pour tester commercialement l'outil à Lohéac. **Ni Stripe, ni backend.**

## 3.1 Le principe, et sa limite assumée

| Ce que le plan A protège **réellement** | Ce qu'il **ne** protège **pas** |
|---|---|
| **Personne ne peut se fabriquer une licence.** `licenses` est en écriture admin exclusive, côté règles Firestore. Un utilisateur qui trafique son JavaScript ou tape dans la console **ne peut rien écrire**. | **L'accès à la fonctionnalité reste cosmétique.** Le moteur est toujours servi au navigateur, les données sont toujours publiques. Quelqu'un de motivé contourne l'écran. |

C'est exactement le compromis que tu as validé : acceptable face à deux ou trois teams à qui tu
parles en personne, plus du tout à la première vente à un inconnu. **Le lot C ferme cette porte ;
le plan A ne le prétend pas.**

## 3.2 Simplification majeure permise par l'échelle

> **L'administrateur crée les teams et y ajoute les membres. Il n'y a ni inscription à une équipe,
> ni invitation, ni recherche d'utilisateur.**

Raison technique, pas seulement pratique : sans backend, ajouter un membre à un team suppose de
retrouver son `uid` à partir de son e-mail — donc de rendre la collection `users` interrogeable
depuis le navigateur, ce qui expose la liste de tes clients. **Faire faire les trois clics par
l'admin supprime toute cette classe de problèmes.** Les invitations arriveront avec le backend.

Deuxième simplification : **garder l'allowlist e-mail pour l'admin**, ne pas passer aux *custom
claims* maintenant. Les poser exige l'Admin SDK, donc un environnement Node et une clé de compte de
service — tout ce que le lot C apportera de toute façon. **Économie : une demi-journée, et une
dépendance en moins avant l'heure.**

## 3.3 Collections nécessaires — quatre

```
users/{uid}                       créé par l'utilisateur à sa première connexion
  email          string
  displayName    string
  createdAt      timestamp

teams/{teamId}                    créé par l'admin
  name           string
  contactEmail   string
  createdAt      timestamp
  createdBy      string

teamMembers/{teamId}_{uid}        créé par l'admin — id déterministe (convention maison)
  teamId, uid    string
  role           'owner' | 'member'
  addedAt        timestamp
  addedBy        string

licenses/{licenseId}              créé par l'admin UNIQUEMENT
  teamId         string
  personId       string           ← LA FICHE PILOTE
  scope          'meeting' | 'season'
  meetingId      string | null    ← si scope = 'meeting' — DÉSAMBIGUÏSE Lohéac (§2.5)
  championshipId string           ← toujours
  year           number           ← toujours
  status         'active' | 'suspended' | 'revoked'
  origin         'admin_grant' | 'trial'     ← 'purchase' viendra avec Stripe
  validFrom      timestamp
  validUntil     timestamp | null
  note           string           ← « démo Lohéac », « offert »…
  createdAt / createdBy / revokedAt / revokedBy
```

`pricing` n'est **pas** nécessaire au plan A : sans paiement, il n'y a pas de prix à calculer.
À ajouter avec Stripe.

Aucune modification des collections existantes.

## 3.4 Règles Firestore

Esquisse ; la fonction `isRegie()` existante est réutilisée telle quelle.

```
function isRealUser() {
  return request.auth != null
      && request.auth.token.firebase.sign_in_provider != 'anonymous'
      && request.auth.token.email_verified == true;
}
function isTeamMember(teamId) {
  return isRealUser()
      && exists(/databases/$(database)/documents/teamMembers/$(teamId + '_' + request.auth.uid));
}

match /users/{uid} {
  allow read:   if isRegie() || (isRealUser() && request.auth.uid == uid);
  allow create: if isRealUser() && request.auth.uid == uid
                && request.resource.data.keys().hasOnly(['email','displayName','createdAt'])
                && request.resource.data.email == request.auth.token.email;
  allow update: if isRegie() || (isRealUser() && request.auth.uid == uid
                && request.resource.data.keys().hasOnly(['email','displayName','createdAt'])
                && request.resource.data.email == resource.data.email);
  allow delete: if isRegie();
}

match /teams/{teamId} {
  allow read:  if isRegie() || isTeamMember(teamId);
  allow write: if isRegie();
}

match /teamMembers/{docId} {
  allow read:  if isRegie() || (isRealUser() && resource.data.uid == request.auth.uid);
  allow write: if isRegie()
               && docId == request.resource.data.teamId + '_' + request.resource.data.uid;
}

// ── LE POINT CRITIQUE ──────────────────────────────────────
match /licenses/{licenseId} {
  allow read:  if isRegie() || isTeamMember(resource.data.teamId);
  allow write: if isRegie();
}
```

**Trois points sur lesquels il ne faut pas transiger :**

1. `licenses` en `write: if isRegie()` — **rien d'autre, jamais**. C'est la seule ligne qui rend le
   plan A honnête.
2. `isRealUser()` exclut explicitement l'auth anonyme. **Elle est déjà utilisée par les pronostics
   (`js/auth.js`)**, donc `request.auth != null` serait un trou béant : n'importe quel spectateur
   ayant voté est authentifié.
3. `users.email == request.auth.token.email` à la création : sinon on peut se déclarer sous
   l'e-mail d'un autre et brouiller ton écran d'administration.

⚠️ Note sur `isTeamMember()` : chaque `exists()` compte comme une lecture facturée. À ton échelle,
sans importance — mais il faut le savoir avant de le mettre dans une règle appelée souvent.

## 3.5 Écrans — trois nouveaux, une modification

| # | Écran | Contenu | Public |
|---|---|---|---|
| 1 | **Connexion / inscription** — étend l'UI existante de `js/auth.js` | création de compte, connexion, **mot de passe oublié**, **vérification d'e-mail**, déconnexion. Retirer la condition `?login` qui masque aujourd'hui le formulaire | tous |
| 2 | **Mon compte** — vue `account` | mon team, mes licences actives, **les pilotes auxquels j'ai accès**, dates de validité | connecté |
| 3 | **Licences** — vue `licenses`, à ajouter à `PROTECTED_VIEWS` | liste filtrable ; création de team ; ajout d'un membre par son e-mail (choisi dans `users`) ; **attribution d'une licence** : fiche pilote → périmètre meeting/saison → dates → origine ; suspendre / révoquer / prolonger | admin |
| — | **`projectionStats.js`** — modification | filtrer le sélecteur de pilote sur les fiches autorisées ; message d'invitation à la place du calcul si aucune licence ; **court-circuit total si `isAdmin()`** | — |

**Exigences d'interface issues de l'audit :**

- l'écran d'attribution doit afficher **date + lieu + championnat** pour chaque meeting — sinon
  Lohéac est indiscernable (§2.5) ;
- le sélecteur de fiche pilote doit montrer les **inscriptions rattachées** (« Fabien Pailler —
  #7 Supercar FFSA, #29 RX1 Euro RX ») : c'est ce qui rend visible, au moment de vendre, ce que la
  licence couvre réellement.

## 3.6 Comment la restriction par `personId` fonctionne concrètement

Une seule fonction, et elle est courte :

```
autorisé(driverId, meetingId) :
    si isAdmin()                            → OUI, toujours
    personId  ← drivers[driverId].personId
    meeting   ← meetings[meetingId]
    pour chaque licence L de mes teams :
        si L.personId == personId
        et L.status == 'active'
        et maintenant ∈ [L.validFrom, L.validUntil]
        et (  L.scope == 'meeting' et L.meetingId == meetingId
           ou L.scope == 'season'  et L.championshipId == meeting.championshipId
                                   et L.year == meeting.year )       → OUI
    → NON
```

**Ce que la restriction ne touche pas** — et c'est le point que tu avais soulevé dès le départ :
`loadSeason()` continue de charger **tous** les pilotes, tous les résultats, tous les participants.
Les adversaires restent complets dans les simulations. **Seul le sélecteur du pilote analysé est
filtré.** Aucune ligne du moteur n'est modifiée.

Un pilote engagé dans deux catégories du même meeting (Adrien Le Quere) est couvert par une seule
licence, puisque le contrôle porte sur `personId` et non sur `driverId`. C'est bien l'effet voulu.

## 3.7 Estimation

| Tâche | Durée |
|---|---|
| Inscription + mot de passe oublié + vérification e-mail (l'UI d'auth existe, on l'étend) | 0,5 j |
| `users` / `teams` / `teamMembers` : modèle + écriture + règles | 1 j |
| `licenses` : modèle + règles | 0,5 j |
| Écran admin « Licences » (liste, création, suspension, révocation) | 1,5 j |
| Écran « Mon compte » | 0,5 j |
| Filtre `personId` dans `projectionStats.js` + réaction à `authchange` | 0,5 j |
| Tests de règles avec l'émulateur Firebase (Vitest est déjà là) | 1 j |
| Câblage : `VIEW_TITLES`, menu, `safeInit`, `PROTECTED_VIEWS`, `ASSET_PATHS`, CSS | 0,25 j |
| Nettoyage des trois fiches du §2.2 | 5 min |

> ### **PLAN A : 5,5 à 6 jours. Difficulté moyenne. Aucun backend, aucune dépendance nouvelle.**

Le poste le plus facile à sous-estimer est l'écran d'administration : c'est du CRUD, mais c'est
**l'écran que tu utiliseras devant un team à Lohéac**. Il doit être lisible, pas juste fonctionnel.

Le seul test automatisé réellement indispensable est celui des règles. Une règle non testée est une
hypothèse, et ici l'hypothèse porte sur « personne ne peut se fabriquer une licence ».

---

# PLAN B — Analyse vidéo V1

**Objectif** : fichier local jamais téléversé → sélection du départ → détection des voitures →
association aux pilotes → `autoTurn1Pos` exploitable dans `startAnalyses`. **Tout dans le
navigateur**, moteur chargé uniquement sur cette page, modèles hors du cache du service worker.

**Détecteur validé : YOLOX-tiny, Apache 2.0.** Décision confirmée — l'AGPL d'Ultralytics
obligerait à publier le source de l'ensemble du service dès la première vente.

## 4.1 Ce qui est **déjà prêt** — vérifié fichier par fichier

| Brique | Où | Réutilisable tel quel ? |
|---|---|---|
| Sélection d'un fichier local, **jamais téléversé** (`URL.createObjectURL`) | `videoPlayer.js:275` | ✅ **oui, intégralement** |
| Lecture image par image, vitesses 0,1× à 2× | `videoPlayerCalc.js` — `stepTime`, `LOCAL_RATES` | ✅ oui |
| Mesure **réelle** de la cadence via `requestVideoFrameCallback` | `videoPlayer.js:307`, `estimateFps` | ✅ oui — **c'est la brique qu'on aurait dû écrire** |
| Canvas superposé, aligné sur l'image utile, redimensionné, plein écran | `computeVideoRect`, `projectBox`, `resizeCanvas` | ✅ oui |
| **API de boîtes** : `renderBoxes(boxes)` en coordonnées **normalisées 0..1**, avec `driverId`, `carNumber`, `label`, `confidence`, `status` ∈ `confirmed/probable/unknown/lost` | `videoPlayer.js:408`, `sanitizeBoxes`, `BOX_STATUS_COLORS` | ✅ **oui — le contrat d'interface est déjà écrit** |
| `normalizeBox(pixelBox, rect)` — pixels → normalisé | `videoPlayerCalc.js:314` | ✅ **oui, exactement ce dont la sortie YOLOX a besoin** |
| Énumération des départs physiques, identifiant déterministe | `enumerateStarts`, `startDocId` | ✅ oui |
| Grille de départ (`gridPos`, `gridRow`, `lane`) | `buildStartGrid`, `placeOnGrid` | ✅ oui |
| **`autoTurn1Pos` déjà dans le modèle de ligne et déjà persisté** | `startAnalysisCalc.js:647,681` · `startAnalysis.js:1026` | ✅ **oui — l'emplacement du résultat automatique existe** |
| Indicateur de confiance 🟢🟡🔴 déjà dans l'UI et dans `validateAnalysis` | `startAnalysis.js:484`, `startAnalysisCalc.js:781` | ✅ oui |
| Positions disponibles, anti-doublon à la saisie | `availableTurn1Positions` | ✅ oui |
| Validation + statut `draft`/`validated` | `validateAnalysis` | ✅ oui |
| Règles Firestore `startAnalyses` (`rows` ≤ 16) | `firestore.rules` | ✅ **oui, aucune modification** |
| Résolution du timecode de départ | `resolveStartTime`, `buildVideoBlock` | ✅ oui |
| Raccourcis clavier, navigation entre départs | `keyboardAction`, `neighbourStartId` | ✅ oui |

> **Le V0 du plan `AUTOMATION-ARCHITECTURE.md` §14 est fait, et il a été écrit en prévision de
> V1.** Le commentaire d'en-tête de `videoPlayer.js` le dit : « c'est le futur module YOLO qui
> l'utilisera, sans qu'il faille reconstruire le lecteur ». C'est exact — je l'ai vérifié.

**Corpus actuel** : 19 départs validés, 92 lignes, **91 avec `turn1Pos` saisi à la main**. C'est
peu pour calibrer, mais c'est exactement la **vérité terrain** dont V1 a besoin pour se mesurer.

## 4.2 Ce qu'il reste à écrire — huit éléments

| # | Élément | Contenu | Effort | Risque |
|---|---|---|---|---|
| 1 | **`videoEngine.js`** — chargeur | import ESM d'ONNX Runtime Web, choix WebGPU → repli WASM SIMD, **affichage du moteur actif**, initialisation de la session | 0,5 j | faible |
| 2 | **`videoModelCache.js`** — modèles hors SW | téléchargement à la demande, stockage via l'API `Cache` sous une **clé distincte de `CACHE_NAME`**, barre de progression, reprise | 0,5 j | faible |
| 2b | **Modification de `sw.js`** | le gestionnaire `fetch` intercepte aujourd'hui **toutes** les requêtes GET de même origine et les remet en cache sous `CACHE_NAME` → un modèle de 15 Mo y atterrirait et serait **purgé à chaque incrément de version**. Ajouter un `return` anticipé sur le chemin des modèles, exactement comme la sortie déjà en place pour `gstatic.com` | 0,25 j | **à ne pas oublier** |
| 3 | **`videoFrames.js`** — extraction | parcours de la fenêtre (~10 s), `requestVideoFrameCallback` ou seek + `drawImage`, `createImageBitmap`, transfert *transferable* au worker | 0,5 j | moyenne |
| 4 | **`videoDetectWorker.js`** — inférence | session ORT dans un Web Worker, exécution YOLOX, retour des boîtes | 1 j | moyenne |
| 5 | **`videoDetectCalc.js`** — module **pur et testé** | *letterbox* 416×416, décodage de la sortie YOLOX (grilles + *strides*, sans ancres), **NMS**, seuil de score, filtrage des classes COCO `car`/`truck`/`bus`, conversion en boîtes normalisées | 1–1,5 j | **élevée** |
| 6 | **Association boîte → pilote** | **par clic en V1** : l'opérateur clique une boîte, choisit le pilote dans la liste du départ. `renderBoxes` gère déjà libellé et statut | 0,5 j | faible |
| 7 | **Ordre au premier virage** | à l'image de mesure, trier les boîtes associées selon `poleSide` → remplir `autoTurn1Pos`, poser `confidence: 'yellow'`, laisser l'opérateur confirmer vers `turn1Pos` | 0,5 j | moyenne |
| 8 | **Interface** | bouton « analyser ce départ », progression, bascule auto/manuel, moteur actif, message d'échec explicite | 0,5 j | faible |

> ### **PLAN B : 5 à 6 jours. Difficulté moyenne-élevée, concentrée sur l'élément 5.**

## 4.3 Où est le risque, précisément

**L'élément 5 est le seul qui peut déraper.** Le post-traitement de YOLOX n'est pas difficile
conceptuellement — pas d'ancres, une grille par *stride*, une NMS classique — mais c'est le genre
de code où une transposition d'axe inversée produit des boîtes plausibles et fausses, qu'on met une
journée à débusquer. C'est aussi la raison pour laquelle il doit vivre dans un **module pur testé**
au format maison : on peut lui faire avaler un tenseur de référence et vérifier la sortie sans
lancer de vidéo.

**Le second risque, moins technique et plus important** : YOLOX-tiny est entraîné sur COCO. Sur des
voitures de rallycross vues d'une caméra de retransmission, dans la poussière, partiellement
masquées, la classe `car` fonctionnera — mais pas brillamment. **Le critère de réussite de V1 doit
être « trouve-t-il la plupart des voitures sur l'image de mesure », pas « suit-il les voitures ».**
Le suivi, c'est V2.

D'où la recommandation du document existant (§15), que je reprends telle quelle : **commencer par
un POC de mesure** — une page autonome, un fichier vidéo, une image, combien de voitures trouvées,
combien de fausses détections. Une demi-journée qui décide si les 5 jours valent la peine.

## 4.4 Ce que le plan B **ne** demande **pas**

| | |
|---|---|
| Changement d'hébergement | **non** — tout fonctionne sur Netlify aujourd'hui |
| Backend | **non** |
| En-têtes COOP/COEP | **non** — ils ne servent qu'au WASM multi-thread, et casseraient l'iframe YouTube |
| Dépendance npm | **non** — ORT Web se charge en module ES, comme le SDK Firebase |
| Modification du modèle de données | **non** — `autoTurn1Pos` et `confidence` existent déjà |
| Modification des règles Firestore | **non** |
| Téléversement de vidéo | **non — jamais** |

**Une seule modification hors du nouveau module : les cinq lignes de `sw.js`** (élément 2b). C'est
la seule chose que le plan B touche dans l'existant.

## 4.5 Poids et impact

| | |
|---|---|
| ONNX Runtime Web | ~10–15 Mo |
| YOLOX-tiny ONNX | ~15 Mo |
| **Total téléchargé, une seule fois, au premier usage** | **~25–30 Mo** |
| Impact sur le chargement du site pour les autres visiteurs | **zéro** — chargement par `await import()`, modèles hors `ASSET_PATHS` |
| Impact sur le mode spectateur et les overlays OBS | **zéro** |

## 4.6 Où héberger les modèles

Trois options, par ordre de préférence :

1. **Sur ton propre domaine** (`/models/yolox_tiny.onnx`) — simple, hors ligne complet après le
   premier chargement, et c'est le seul moyen de contrôler la version. **Impose l'élément 2b.**
2. **CDN public** (jsDelivr pour ORT Web) — pour le runtime, c'est même préférable : le SW ignore
   déjà les hôtes tiers, donc aucune modification. Pour les **poids**, un CDN tiers est un point de
   défaillance que tu ne maîtrises pas.
3. **Firebase Storage** — pertinent seulement plus tard, si tu veux servir les poids derrière une
   vérification de licence (`IMPACT-HEBERGEMENT-ET-VIDEO.md` §10).

**Recommandation V1 : runtime depuis un CDN, poids sur ton domaine.**

---

# ORDRE

Ton ordre est le bon, et l'audit le confirme plutôt qu'il ne le nuance.

| Rang | Action | Durée | Pourquoi ici |
|---|---|---|---|
| **0** | Trois `curl` (§1.1) + `netlify.toml` (§1.3) | **15 min** | Coût nul, bénéfice immédiat, aucun risque |
| **0 bis** | Trancher les trois fiches du §2.2 | **5 min** | Ne pas les traîner dans le modèle de licences |
| **1** | **Plan A — comptes + licences** | **5,5–6 j** | Prêt pour Lohéac. Ni Stripe, ni backend, ni migration |
| **2** | **Plan B — vidéo V1** *(POC d'une demi-journée d'abord)* | **5–6 j** | Indépendant. Aucun fichier commun avec le plan A |
| **3** | Décision commerciale après Lohéac | — | Avec des retours réels |
| **4** | Migration Hosting, puis lot C, puis Stripe | 14–18 j | Seulement si les teams accrochent |

**Les plans A et B ne partagent aucun fichier.** Plan A touche `auth.js`, `app.js`, `index.html`,
`firestore.rules` et ajoute trois vues ; plan B touche `sw.js` et ajoute un dossier `js/video/`.
Ils peuvent avancer en parallèle sans conflit de fusion.

**Un dernier point sur le calendrier.** Lohéac, c'est le **30 août** — dans neuf jours. Le plan A en
demande six. C'est jouable, mais sans marge, et l'écran d'administration est celui que tu montreras.
Si le temps manque, coupe dans cet ordre : d'abord l'écran « Mon compte » (§3.5 n° 2), qui peut
attendre ; ensuite la vérification d'e-mail. **Ne coupe jamais les tests de règles** : c'est la
seule chose du plan A qui protège réellement quelque chose.

Et si tu ne devais garder qu'une chose de ces deux audits : **la reprise de données que je
redoutais n'existe pas.** Ta base est propre. Le chemin est libre.
