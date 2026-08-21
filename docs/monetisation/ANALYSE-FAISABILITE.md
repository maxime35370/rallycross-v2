# Monétisation de « Stratégie Live » — analyse de faisabilité

Document d'aide à la décision. **Aucun code n'a été écrit, aucune donnée modifiée.**
État audité : branche `main`, commit `c9f7dfe`.

---

## 0. Réponse courte

| Question | Réponse |
|---|---|
| Est-ce réalisable ? | **Oui**, mais pas avec l'architecture *actuelle* telle quelle. |
| Le blocage principal est-il technique ? | **Oui, et un seul** : aujourd'hui tout le moteur stratégique et toutes ses données vivent dans le navigateur du visiteur. Tant que c'est le cas, il n'existe **aucun** moyen de faire payer quoi que ce soit. |
| Ce qui manque | Un backend (Cloud Functions), un modèle de comptes/licences, et le déplacement du **calcul de l'objectif** hors du navigateur. |
| Effort | ≈ **3 à 4 semaines** de travail concentré pour la chaîne complète. Mais **1 semaine** suffit pour vendre à la main à 2–3 teams et valider le marché. |
| Coût d'infrastructure | ≈ **0 €/mois** à 10, 50 et 100 teams. Les vrais coûts sont Stripe (~2,3 % du prix) et ton temps. |
| Le modèle « licence par fiche pilote » | **Oui, c'est le bon choix.** La relation existe déjà (`drivers.personId`). Elle a besoin d'être fiabilisée avant d'être monétisée. |

---

## 1. Audit de l'existant

### 1.1 Nature de l'application

Rallycross V2 est un **site statique pur**, sans build, sans bundler, sans CI :

- modules ES chargés directement depuis `js/`, SDK Firebase importé du CDN gstatic ;
- pas de `firebase.json`, pas de `functions/`, pas de `.github/workflows` ;
- présence de `.nojekyll`, `manifest.json`, `sw.js` → hébergement **vraisemblablement GitHub Pages** (à confirmer de ton côté, c'est une hypothèse déduite des fichiers, pas une certitude) ;
- **il n'y a strictement aucun code serveur aujourd'hui.** Tout ce que fait l'application, elle le fait dans le navigateur, contre Firestore en direct.

C'est le point structurant de toute cette analyse.

### 1.2 Authentification actuelle

`js/auth.js` :

- Firebase Auth **est déjà en place** (email/mot de passe) — bonne nouvelle, la brique existe ;
- un seul administrateur, en dur : `ADMIN_EMAILS = ['maxime.theard@gmail.com']` (`js/auth.js:22`) ;
- **la même liste est dupliquée** dans `firestore.rules:8` (`isRegie()`). Deux endroits à modifier pour un changement d'admin — c'est une dette à corriger avant d'ajouter des rôles ;
- le formulaire de connexion est masqué sauf si l'URL contient `?login` ;
- l'auth anonyme est utilisée pour les votes pronostics ;
- pas d'inscription publique, pas de réinitialisation de mot de passe, pas de vérification d'e-mail.

### 1.3 Protection actuelle des vues

`js/auth.js:15` :

```js
const PROTECTED_VIEWS = [
  'persons', 'drivers', 'meetings', 'engagements', 'sessions', 'timing',
  'audit', 'config', 'settings',
];
```

**`projection` n'y figure pas.** « Stratégie Live » est aujourd'hui une vue **entièrement publique**, présente dans le menu (`index.html:102`) et sur l'accueil (`index.html:170`).

Et même si on l'y ajoutait, la protection consiste en :

```js
if (!_authResolved) return;
if (!isProtectedView(_currentView) || isAdmin()) return;
toast('Accès impossible.', 'error');
setTimeout(() => { ... showView('spectator'); }, 0);
```

… c'est-à-dire exactement le `if (premium) afficher` que tu ne veux pas. C'est du confort d'interface, pas une sécurité.

### 1.4 Ce qui est public dans Firestore

`firestore.rules` : **toutes** les collections métier sont en `allow read: if true` — `drivers`, `meetings`, `sessions`, `engagements`, `sessionParticipants`, `results`, `interimStandings`, `meetingStandings`, `championshipStandings`, `championships`, `persons`, `reglements`, `startAnalyses`, `circuits`, `pronostics`, `pronoScores`, `players`, `obsControl`, `championshipPenalties`.

Seul `auditLog` est en lecture régie.

Et ce n'est pas théorique : **le dépôt contient déjà l'outil qui exploite cette ouverture**. `tools/qualification-audit/fetch.mjs` lit la clé API dans `js/firebase.js`, interroge l'API REST Firestore et **aspire des collections entières** en JSON. Le README l'écrit noir sur blanc :

> `fetch.mjs` … interroge l'API REST Firestore, **autorisée en lecture publique** par `firestore.rules`.

N'importe qui peut faire la même chose avec un `curl` et la clé API, qui est publique par nature (elle est dans le source du site).

### 1.5 Où vit le calcul stratégique

**Intégralement dans le navigateur.** `js/projection/` (~4 600 lignes) contient :

| Fichier | Rôle |
|---|---|
| `monteCarloEngine.js` | RNG déterministe, lois normales |
| `driverPerformanceModel.js` | **modèle de force pilote calibré** (contraction bayésienne) |
| `scenarioSimulator.js` | simulation Monte-Carlo, what-if, matrice croisée |
| `liveStrategy.js` | **objectif live, chrono cible, adversaires directs, résilience** |
| `strategyTargetCalculator.js` | gains marginaux, classification de stratégie |
| `raceCertainties.js` | certitudes mathématiques, bornes de position |
| `qualificationState.js` | reconstruction de l'état à un checkpoint |
| `qualificationHistory.js`, `dataQuality.js`, `qualificationBacktest.js` | historique, qualité, backtest |
| `qualificationData.js` | **seul module qui touche Firestore** |

Deux constats importants :

1. **Ces modules sont purs et déjà compatibles Node.** Les scripts `tools/qualification-audit/*.mjs` les importent tels quels côté serveur (`import { simulateFromCheckpoint } from '../../js/projection/scenarioSimulator.js'`). Le portage vers une Cloud Function est donc un **déplacement de fichiers**, pas une réécriture. C'est la meilleure nouvelle de cet audit.
2. **Le service worker les met en cache pour tout le monde.** `sw.js:61-75` précharge explicitement les treize fichiers du moteur, plus `projectionStats.js` et `projection.css`. Chaque visiteur repart donc avec une copie hors ligne, complète et fonctionnelle, du moteur.

### 1.6 Chargement des données par le module

`js/projection/qualificationData.js` charge, **par année**, l'intégralité de `meetings`, `sessions`, `results` et `sessionParticipants` (≈ 4 000 résultats sur l'historique actuel d'après `docs/qualification-projection/ANALYSE.md:22`). Le filtrage par meeting/catégorie se fait ensuite côté client.

C'est parfait pour un usage admin. C'est un problème de coût si on transpose tel quel côté serveur (voir §11).

### 1.7 Le modèle fiche pilote ↔ inscription sportive

**La relation que tu décris existe déjà et fonctionne.**

- `persons/{id}` — `firstName`, `lastName`, `createdAt`. C'est la personne physique.
- `drivers/{id}` — `firstName`, `lastName`, `carNumber`, `category`, `year`, `championshipId`, **`personId`**. C'est l'inscription sportive.
- `js/drivers.js:158-160` : à l'enregistrement d'un pilote, soit l'admin a sélectionné une fiche, soit `findOrCreatePerson()` rapproche sur `firstName` + `lastName` en minuscules, sinon crée la fiche.
- `js/personProfile.js:22` : `drivers where personId == X` — l'agrégation carrière multi-championnats/multi-catégories est **déjà implémentée**.

Donc ton exemple « Jean Dupont RX3 #123 + Jean Dupont Super1600 #45 » est déjà correctement modélisé : deux `drivers`, un seul `persons`.

**Mais trois fragilités, à traiter avant de facturer dessus :**

1. `personId` est **nullable**. Tout pilote créé avant l'introduction de ce champ peut avoir `personId: null`. Il faut un audit ponctuel (le patron de `tools/qualification-audit/` s'y prête) puis une reprise.
2. `firestore.rules:13-27` **ne valide pas `personId` du tout** — ni sa présence, ni son immuabilité. Une licence adossée à un champ que les règles ignorent est une licence adossée à du vide.
3. Le rapprochement par nom est fragile (homonymes, fautes de frappe, particules, `Jean-Pierre` vs `Jean Pierre`). `js/persons.js:63` propose déjà de créer un doublon en cas d'homonyme. Il **manque un outil admin de fusion de fiches** — et surtout : si tu fusionnes deux `persons`, les licences pointant sur la fiche supprimée deviennent orphelines.

### 1.8 Verdict de l'audit

| Élément | État | Prêt pour la monétisation ? |
|---|---|---|
| Firebase Auth | en place | oui, à compléter |
| `drivers.personId` | en place, non validé | oui, à fiabiliser |
| Moteur stratégique pur et Node-compatible | en place | **oui — atout majeur** |
| Séparation calcul / affichage | nette | **oui — atout majeur** |
| Backend | **inexistant** | non |
| Rôles au-delà d'admin | **inexistants** | non |
| Lectures Firestore | **toutes publiques** | non |
| Protection de la vue projection | **inexistante** | non |
| Moteur envoyé au navigateur + mis en cache SW | oui | **non — bloquant** |

---

## 2. La question de sécurité (§7), traitée en premier parce qu'elle décide de tout

> « Si le JavaScript de Stratégie Live est téléchargé dans le navigateur de tout le monde mais simplement caché par l'interface, est-ce suffisamment sécurisé ? »

**Non. Et pas « moyennement non » : pas du tout.** Trois raisons indépendantes, dont chacune suffit à elle seule.

**a) Le moteur est distribué.** Les fichiers sont servis publiquement et **préchargés par le service worker** pour chaque visiteur. Contourner ne demande pas de « pirater » quoi que ce soit : il suffit d'ouvrir la console et de taper

```js
const m = await import('/js/projection/liveStrategy.js');
```

Le module est déjà là, déjà en cache, sans authentification. Un `git clone` du dépôt donne le même résultat en plus confortable.

**b) Les données d'entrée sont publiques.** Toutes. Par l'API REST, avec la seule clé API du site, qui est publique. Le dépôt fournit même le script.

**c) Il n'y a rien à demander à un serveur.** Puisque le calcul est intégralement client et les données intégralement accessibles, un visiteur non licencié **détient déjà tout ce qu'il faut** pour produire la réponse. Le cacher revient à mettre un rideau devant une porte ouverte.

### 2.1 Peut-on fermer les lectures Firestore à la place ?

**Non, et c'est structurel.** Le moteur a besoin des résultats de **tous** les pilotes comme adversaires — c'est toi qui le soulignes, et c'est exact. Or ces mêmes documents alimentent le mode spectateur, les classements, le championnat, les statistiques, l'overlay et les pronostics, qui doivent rester gratuits et sans compte.

Fermer `results` en lecture tuerait le produit gratuit. **Le verrou ne peut donc pas être posé sur les données.**

### 2.2 Le seul verrou qui tient : déplacer la *décision*, pas les données

Ce que tu vends n'est pas la donnée brute (des résultats de course, publics par nature). Ce que tu vends, c'est **la phrase** :

> `OBJECTIF 🎯 P5 au provisoire ou mieux · RÉFÉRENCE ⏱ battre 2:30.630 · 81,1 % · DNF → 0,0 %`

C'est **cette production-là** qui doit quitter le navigateur.

**Frontière recommandée :**

| Reste dans le navigateur | Part sur le serveur |
|---|---|
| `projectionStats.js` (rendu, onglets, sélecteurs) | `driverPerformanceModel.js` |
| `qualificationHistory.js` (courbes publiques) | `scenarioSimulator.js` |
| `dataQuality.js` | `liveStrategy.js` |
| `qualificationState.js`, `qualificationRules.js` (état/seuil : déjà déductibles du classement public) | `strategyTargetCalculator.js` |
| `calc.js` (partagé avec tout le reste de l'app) | `raceCertainties.js` |
| | `monteCarloEngine.js` |
| | `qualificationBacktest.js` (admin) |

L'application appelle une fonction `getLiveStrategy({ personId, meetingId, category, checkpoint })`. Le serveur vérifie la licence, charge les données, calcule, et **ne renvoie que le résultat affichable** (quelques kilo-octets de JSON).

**Condition non négociable :** ces fichiers doivent **cesser d'être publiés** sur le site. Ils restent au dépôt pour les tests et l'audit, mais ils ne sont plus servis, et ils sortent de la liste de précache de `sw.js`. Un fichier laissé dans `js/` est un fichier offert.

### 2.3 Conséquence : l'hébergement doit changer

Aujourd'hui la racine du dépôt *est* le site. Il n'y a aucun moyen d'exclure `js/projection/` de la publication sans introduire soit une étape de build, soit une réorganisation.

Deux voies, la seconde est la bonne :

1. Déplacer le moteur hors de la racine publiée (`engine/projection/`), importé par la Function et par les tests. Conserve la propriété « aucun build ». Mais GitHub Pages publie la racine → il faudrait passer par un dossier `docs/` ou une branche `gh-pages`, ce qui complique.
2. **Migrer l'hébergement vers Firebase Hosting.** Comme les Cloud Functions imposent de toute façon le plan Blaze, autant en tirer parti : `firebase.json` déclare précisément ce qui est publié et ce qui est ignoré, on obtient des réécritures `/api/*` vers les functions, et tout vit dans un seul projet. **C'est la recommandation.** Prévoir une demi-journée pour la bascule et le domaine.

### 2.4 Risque résiduel, à assumer

Après tout cela, un concurrent motivé peut toujours **ré-implémenter** un moteur équivalent à partir des données publiques. C'est vrai de tout produit d'analyse et aucune technologie n'y remédie : ce qui protège, c'est l'avance, la calibration et le backtest, pas le code. Ce qui compte, c'est qu'il ne puisse pas **utiliser le tien** gratuitement. Ça, c'est atteignable.

### 2.5 Le contre-risque, sérieux : la connectivité en bord de piste

Déplacer le calcul sur un serveur signifie que **l'outil ne fonctionne plus sans réseau** — exactement au moment et à l'endroit où le réseau est le plus mauvais (paddock saturé un dimanche de meeting). C'est le prix réel de la sécurisation, et il faut le regarder en face.

Atténuations à intégrer dès la conception :

- réponse minuscule (quelques ko) → passe même sur un réseau dégradé ;
- mise en cache locale de la **dernière** réponse reçue, affichée avec son horodatage et une mention explicite « donnée figée à HH:MM » ;
- nouvelle tentative automatique, jamais de page blanche ;
- `minInstances: 1` sur la Function les week-ends de meeting pour éliminer les démarrages à froid (2–5 s, inacceptables en bord de piste).

---

## 3. Modèle de données proposé

### 3.1 Principe

```
                    ┌────────────┐
                    │  persons   │  ← fiche pilote physique (EXISTE)
                    └─────┬──────┘
                          │ 1..n
                    ┌─────▼──────┐
                    │  drivers   │  ← inscription sportive (EXISTE)
                    └────────────┘     personId, championshipId, category, year, carNumber

  ┌──────────┐      ┌──────────┐      ┌──────────────┐
  │  users   │──n:m─│  teams   │──1:n─│   licenses   │──► personId + périmètre
  └──────────┘      └──────────┘      └──────────────┘
       │  (via teamMembers)                    │
       └────────────────────────────────────────┘
              un compte accède à une licence
              parce qu'il est membre du team qui la détient
```

**La licence appartient au team, pas au compte.** C'est ce qui répond proprement à ton §3 : pilote, team manager, spotter, ingénieur et mécanicien sont cinq comptes membres du même team ; le team détient une licence pour Jean Dupont ; les cinq y ont accès. Ajouter ou retirer un membre ne touche pas à la licence. Un pilote seul est simplement un team d'une personne.

L'alternative — un tableau `grantedUids` sur la licence — fonctionne aussi et coûte moins cher à écrire, mais elle oblige à répéter la liste sur chaque licence et devient pénible dès qu'un team a plusieurs pilotes. **Le modèle par team est plus propre et n'est pas plus difficile.**

### 3.2 Collections à créer

```
users/{uid}
  email                 string        (copie, pour l'admin)
  displayName           string
  createdAt             timestamp
  disabled              bool

teams/{teamId}
  name                  string
  ownerUid              string        (uid du créateur)
  createdAt             timestamp

teamMembers/{teamId}_{uid}            ← id déterministe : anti-doublon, comme sessionParticipants
  teamId                string
  uid                   string
  role                  'owner' | 'manager' | 'member'
  addedAt               timestamp
  addedBy               string

licenses/{licenseId}                  ← id déterministe (voir §6.3)
  teamId                string
  personId              string        ← LA FICHE PILOTE, pas un driverId
  scope                 'meeting' | 'season'
  meetingId             string | null ← si scope = 'meeting'
  championshipId        string        ← toujours renseigné
  year                  number        ← toujours renseigné
  status                'active' | 'suspended' | 'revoked' | 'expired'
  origin                'purchase' | 'admin_grant' | 'trial'
  validFrom             timestamp
  validUntil            timestamp | null
  pricePaidCents        number | null ← montant réellement facturé, figé
  currency              'EUR'
  paymentRef            string | null ← id Stripe (session ou payment_intent)
  createdAt / createdBy
  revokedAt / revokedBy / revokeReason

pricing/{priceId}
  championshipId        string
  year                  number
  kind                  'meeting' | 'season'
  amountCents           number
  currency              'EUR'
  seasonDiscountPct     number        ← ex. 15
  meetingsPerSeason     number        ← ex. 10
  active                bool
  validFrom / validUntil

strategyContexts/{meetingId}_{category}     ← cache serveur, LECTURE CLIENT INTERDITE
  contexte pré-calculé, régénéré par déclencheur Firestore (voir §11)

strategyUsage/{autoId}                      ← journal d'usage, ADMIN uniquement
  uid, teamId, personId, meetingId, at, durationMs, ip
```

### 3.3 Modification à apporter à l'existant

Une seule, et elle est légère : **durcir `persons` et `drivers.personId`**.

- règle sur `drivers` : `personId` doit être une chaîne non vide ; il ne doit pas pouvoir être modifié sans passer par l'admin (déjà le cas — seule la régie écrit) ;
- interdire la suppression d'une `persons` qui porte des licences actives (contrôle côté Function, les règles Firestore ne peuvent pas requêter une collection en écriture de façon fiable pour cela) ;
- prévoir une **procédure de fusion de fiches** qui réécrit `drivers.personId` **et** `licenses.personId` dans la même transaction.

### 3.4 Pourquoi la licence sur `personId` est le bon choix — et ses conséquences

**Pour :**
- c'est le modèle que tu décris, et il correspond à la réalité : on achète l'accès à *un pilote*, pas à *un numéro de voiture* ;
- il est déjà supporté par le schéma (`drivers.personId`) et déjà exploité (`personProfile.js`) ;
- il survit à un changement de numéro, de catégorie ou de championnat en cours de saison — cas fréquent, et une licence par `driverId` obligerait à racheter ;
- une seule ligne à créer par vente.

**Contre / à surveiller :**
- **dépendance à la qualité de l'appariement.** Si une fiche pilote est mal reliée, la licence ne couvre pas ce qu'elle devrait, et le client le vit comme un bug de facturation. C'est le vrai risque : il est humain, pas technique. Prérequis : audit + reprise + outil de fusion.
- **suppression/fusion de fiche = licence orpheline.** À protéger explicitement.
- **un pilote engagé dans deux catégories au même meeting** obtient les deux avec un seul PASS MEETING. C'est bien ce que tu veux, mais c'est une décision commerciale : tu ne pourras pas facturer la seconde catégorie plus tard sans changer de modèle. Je recommande de l'assumer — facturer la catégorie donnerait au client l'impression d'être compté deux fois pour le même pilote.

**Verdict : oui, licence par fiche pilote.** Mais **fiabilise l'appariement avant de vendre**, pas après.

---

## 4. Les deux formules (§4)

### 4.1 Représentation

| Formule | `scope` | Champs qui font foi | Autorise |
|---|---|---|---|
| PASS MEETING | `'meeting'` | `personId` + `meetingId` | ce meeting, toutes catégories de ce pilote |
| PASS SAISON | `'season'` | `personId` + `championshipId` + `year` | tous les meetings de ce championnat cette année-là, y compris **ceux créés après l'achat** |

La vérification serveur est une seule fonction :

```
autorisé(uid, personId, meetingId) =
     admin(uid)
  OU il existe une licence L telle que
       L.personId == personId
    ET L.status == 'active'
    ET maintenant ∈ [L.validFrom, L.validUntil]
    ET uid est membre de L.teamId
    ET (   L.scope == 'meeting' ET L.meetingId == meetingId
        OU L.scope == 'season'  ET L.championshipId == meeting.championshipId
                                ET L.year == meeting.year )
```

C'est volontairement court : **toute complexité ajoutée ici est une faille future.**

### 4.2 Tarification paramétrable

Ta règle « saison = prix meeting × N × 0,85 » se code en une ligne, mais **ne la calcule pas à la volée à chaque affichage**. Raison : si tu changes le prix meeting en cours de saison, le prix saison change rétroactivement pour tout le monde, y compris pour ceux qui ont déjà payé, et ta comptabilité ne retombe plus.

Bonne pratique :
- `pricing` porte `amountCents`, `seasonDiscountPct` et `meetingsPerSeason` ;
- le prix saison est **calculé au moment de la création du tarif**, stocké explicitement, et versionné (un nouveau document `pricing`, jamais une modification en place) ;
- `licenses.pricePaidCents` fige ce qui a réellement été payé.

Tout ce que tu veux pouvoir changer facilement — prix meeting, prix saison, remise, championnat, saison, pilote, dates de validité — est ainsi un champ de document, modifiable depuis l'écran admin, sans déploiement.

### 4.3 Sur la valeur (remarque, pas une recommandation de prix)

Tu as raison de dire que 30 € pour « une page de statistiques » et 30 € pour « faut-il prendre des risques en Q4 » ne sont pas le même 30 €. Techniquement, cela n'a qu'une conséquence, mais elle compte : **ne bâtis rien qui rende un changement de prix coûteux.** Le modèle ci-dessus le garantit. Prévois aussi :

- les **codes promo Stripe** (gratuits, natifs) — parfaits pour un « -50 % Lohéac » sans toucher au code ;
- un tarif **par championnat**, pas global : la valeur n'est pas la même en championnat de France qu'en régional ;
- la possibilité d'un tarif à zéro, qui rend le circuit d'achat utilisable pour un essai gratuit sans code spécifique.

---

## 5. Paiement (§5)

### 5.1 Recommandation : **Stripe Checkout** (page hébergée) + **webhook**

| Critère | Stripe Checkout | Stripe Elements | PayPal | Mollie / SumUp | Paddle / Lemon Squeezy (MoR) |
|---|---|---|---|---|---|
| Données carte chez toi | **jamais** | jamais (mais iframe à intégrer) | jamais | jamais | jamais |
| 3-D Secure / DSP2 | automatique | à gérer | oui | oui | oui |
| Interface à développer | **aucune** | complète | moyenne | moyenne | aucune |
| Apple/Google Pay | inclus | à activer | non | partiel | inclus |
| Codes promo | natifs | à coder | limité | oui | oui |
| Facture / reçu | automatique | à coder | oui | oui | **automatique + TVA** |
| TVA européenne | **à ta charge** | à ta charge | à ta charge | à ta charge | **prise en charge** |
| Frais (carte EU) | ~1,5 % + 0,25 € | idem | ~2,9 % + 0,35 € | ~1,8 % + 0,25 € | ~5 % + 0,50 € |
| Coût sur une vente à 30 € | ≈ 0,70 € | ≈ 0,70 € | ≈ 1,22 € | ≈ 0,79 € | ≈ 2,00 € |

**Stripe Checkout**, parce que c'est le meilleur rapport sécurité / effort : tu ne vois **jamais** un numéro de carte (périmètre PCI réduit au minimum, SAQ-A), tu n'écris **aucune** interface de paiement, la conformité DSP2 est gérée, et l'intégration tient en deux fonctions serveur.

**Mais regarde sérieusement un « Merchant of Record » (Paddle, Lemon Squeezy)** si tu vends à des teams hors de France. Ils facturent nettement plus cher (~2 € contre 0,70 € sur une vente à 30 €), mais ils deviennent le vendeur juridique et **gèrent la TVA de chaque pays à ta place**. À 100 ventes par an, l'écart est d'environ 130 € — probablement moins cher que le temps passé sur les déclarations. C'est un arbitrage comptable, pas technique : à trancher avec ton comptable, pas ici.

Je déconseille de dépendre d'une extension Firebase « Stripe » clé en main : leur maintenance a beaucoup bougé ces dernières années, et surtout elles sont pensées pour un modèle produit/abonnement, alors que ton droit d'accès est un couple `(personId, périmètre)` sur mesure. Deux fonctions écrites à la main sont plus courtes à lire et ne dépendent de personne.

### 5.2 Enchaînement serveur

```
1. Client authentifié  ──► createCheckoutSession({ personId, scope, meetingId | (championshipId, year) })
2. Serveur             ──► vérifie : compte valide, e-mail vérifié, team, fiche pilote existante,
                                     tarif actif, licence pas déjà détenue
                           calcule LE MONTANT LUI-MÊME (jamais celui envoyé par le client)
                           crée la session Stripe avec metadata { uid, teamId, personId, scope, ... }
                           renvoie l'URL
3. Client              ──► redirection vers la page Stripe. Paiement. 3-D Secure.
4. Stripe              ──► POST webhook `checkout.session.completed`
5. Serveur             ──► VÉRIFIE LA SIGNATURE Stripe (corps brut, secret de webhook)
                           crée licenses/{id déterministe} via Admin SDK
6. Client              ──► onSnapshot voit la licence apparaître, l'écran se déverrouille
```

**Trois points qui ne se négocient pas :**

1. **Le montant est calculé côté serveur.** Si le client peut envoyer un prix, il enverra 0.
2. **La signature du webhook est vérifiée.** Sans cela, n'importe qui poste un faux « paiement réussi » sur ton point d'entrée public et s'attribue une licence.
3. **L'identifiant de licence est déterministe**, dérivé de l'identifiant Stripe. Stripe rejoue ses webhooks en cas d'échec : sans identifiant déterministe, un client se retrouve avec trois licences pour un paiement.

Et le fondamental : **le client n'écrit jamais dans `licenses`.** Jamais. La règle est `allow write: if isAdmin()` et rien d'autre — la Function passe par l'Admin SDK, qui ignore les règles.

---

## 6. Authentification et rôles (§8)

### 6.1 Firebase Auth : oui, garde-le

Il est **déjà en place et déjà fonctionnel** (`js/auth.js`). Changer de fournisseur d'identité serait une régression gratuite. Il s'intègre nativement aux règles Firestore (`request.auth`) et aux Cloud Functions `onCall` (jeton vérifié automatiquement, sans code).

### 6.2 Ce qu'il faut ajouter

| Besoin | Moyen | Effort |
|---|---|---|
| Création de compte | `createUserWithEmailAndPassword` + formulaire public | faible |
| Connexion / déconnexion | **existe déjà** | nul |
| Mot de passe oublié | `sendPasswordResetEmail` | très faible |
| Vérification d'e-mail | `sendEmailVerification` + **contrôle serveur** sur `token.email_verified` | faible |
| Rôle admin | **custom claim** `admin: true` posé une fois via Admin SDK | faible |
| Comptes team | collections `users` / `teams` / `teamMembers` | moyen |
| Compte ↔ licences | via `teamMembers` (§3) | moyen |

### 6.3 Deux corrections à faire au passage

**a) Sortir l'admin de l'e-mail codé en dur.** Aujourd'hui la liste est écrite deux fois (`js/auth.js:22` et `firestore.rules:8`). Avec un custom claim, les règles lisent `request.auth.token.admin == true` et il n'y a plus qu'une source de vérité. Garde l'allowlist e-mail en secours pour ne pas te verrouiller dehors le jour où le claim est mal posé. Attention : un claim n'est visible qu'après rafraîchissement du jeton (`getIdToken(true)`) ou reconnexion.

**b) Interdire à un compte anonyme de détenir une licence.** L'auth anonyme est utilisée par les pronostics, donc `request.auth != null` **ne suffit pas** comme condition d'accès — c'est un piège classique. Il faut vérifier explicitement `request.auth.token.firebase.sign_in_provider != 'anonymous'`.

### 6.4 Ton accès admin (§6)

Ton compte reste au-dessus de tout, par trois mécanismes cumulés :

1. custom claim `admin: true` → toutes les règles Firestore contiennent `isAdmin() || …` ;
2. toute Function stratégique commence par `if (isAdmin(context)) return computeEverything()` — **avant** toute vérification de licence. Tu n'as donc jamais besoin de licence, ni pour un pilote, ni pour un meeting ;
3. un écran « Licences » (vue admin, à ajouter à `PROTECTED_VIEWS`) : liste filtrable, type meeting/saison, origine achat/offert/essai, dates de création et d'expiration, montant payé, création manuelle, suspension, révocation, prolongation.

Le **TRIAL** ne demande **aucune structure supplémentaire** : c'est une licence `origin: 'trial'` avec `validUntil` renseigné. Ton cas Lohéac se traite donc entièrement dans le lot « licences », **sans paiement, sans Stripe, sans ligne de code supplémentaire**. C'est important pour ton calendrier (voir §12).

---

## 7. Règles Firestore nécessaires

Esquisse — non destinée à être copiée telle quelle, mais elle montre la forme :

```
function isAdmin() {
  return request.auth != null && (
       request.auth.token.admin == true
    || request.auth.token.email in ['maxime.theard@gmail.com']   // secours
  );
}
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
  allow read:   if isAdmin() || (isRealUser() && request.auth.uid == uid);
  allow create: if isRealUser() && request.auth.uid == uid
                && request.resource.data.keys().hasOnly(['email','displayName','createdAt']);
  allow update: if isAdmin() || (isRealUser() && request.auth.uid == uid
                && request.resource.data.keys().hasOnly(['displayName']));
  allow delete: if isAdmin();
}

match /teams/{teamId} {
  allow read:   if isAdmin() || isTeamMember(teamId);
  allow create: if isRealUser() && request.resource.data.ownerUid == request.auth.uid;
  allow update: if isAdmin() || (isTeamMember(teamId)
                && resource.data.ownerUid == request.auth.uid);
  allow delete: if isAdmin();
}

match /teamMembers/{docId} {
  allow read:  if isAdmin() || isTeamMember(resource.data.teamId);
  // création/suppression de membres : par Function uniquement (contrôle du quota,
  // de l'invitation et de la propriété du team). Pas d'écriture client.
  allow write: if isAdmin();
}

// ── LE POINT CRITIQUE ─────────────────────────────────────────
match /licenses/{licenseId} {
  allow read:  if isAdmin() || isTeamMember(resource.data.teamId);
  allow write: if isAdmin();       // ← les achats passent par l'Admin SDK, jamais par le client
}

match /pricing/{priceId} {
  allow read:  if true;            // les tarifs sont publics, c'est une vitrine
  allow write: if isAdmin();
}

// Cache serveur : personne ne le lit depuis un navigateur.
match /strategyContexts/{docId} { allow read, write: if false; }

// Journal d'usage : admin seul.
match /strategyUsage/{docId} { allow read: if isAdmin(); allow write: if false; }

// Durcissement de l'existant
match /drivers/{docId} {
  allow read: if true;
  allow create, update: if isAdmin() && … && request.resource.data.personId is string;
  allow delete: if isAdmin();
}
```

Et **la règle la plus importante n'est pas dans ce fichier** : c'est que la vérification de droit qui compte réellement se fait **dans la Function**, avant de calculer. Les règles Firestore protègent les documents ; elles ne protègent pas un calcul. Ici, ce qu'on vend est un calcul.

Un mot sur `exists()` dans les règles : chaque appel est facturé comme une lecture et ajoute de la latence. À ce volume, c'est sans importance. Il faut simplement le savoir.

**Prévois de tester ces règles avec l'émulateur Firebase** (`@firebase/rules-unit-testing`) : une règle de sécurité non testée est une hypothèse. C'est un des rares endroits où le test automatisé est réellement indispensable — et le projet a déjà Vitest.

---

## 8. Découpage PUBLIC / TEAM PREMIUM / ADMIN (§9)

### PUBLIC — gratuit, sans compte (inchangé)

Accueil · Classements · Championnat · Statistiques · Stats des départs · Mode Spectateur · Overlay · Pronostics · Profils pilotes et fiches personnes · **onglet Historique** de Stratégie Live (courbes de qualification, taux comparables) · **onglet Qualité des données**.

Garder l'Historique gratuit est délibéré : c'est ta vitrine, c'est de la statistique descriptive sur des données publiques, et c'est aussi la partie la plus difficile à cloisonner (elle agrège tout le plateau).

### TEAM PREMIUM — licence requise, pour la fiche pilote achetée uniquement

Onglet **Stratégie** : situation, objectif de position, référence chrono, TARGET, risque DNF, concurrents directs, résilience après passage, certitudes mathématiques, chemins possibles.
Onglet **Analyse détaillée** : Monte-Carlo, what-if, matrice de scénarios croisés.

Le pilote **analysé** est restreint. Les données des autres pilotes continuent d'alimenter les simulations comme adversaires — c'est le serveur qui charge tout, le client ne choisit que le sujet.

### ADMIN — toi

Fiches Pilotes · Pilotes · Meetings · Engagements · Sessions · Chronométrage · Réglages · Configuration · Journal d'audit · **Licences** (nouveau) · **Tarifs** (nouveau) · **Backtest** · accès stratégique total, sans licence.

Le **backtest** mérite une note : c'est ton meilleur argument de vente (« voilà ce que l'outil annonçait après Q3, voilà ce qui s'est passé en Q4 »). Garde-le en admin, mais publie-en un résumé chiffré en accès libre. C'est de la preuve, pas de la fonctionnalité.

### Ce qui **ne change pas**

Toute la saisie reste identique. La monétisation s'ajoute **autour** de Stratégie Live. Aucune vue existante ne devient payante. Le seul changement visible pour un visiteur non connecté est que l'onglet Stratégie affiche une invitation à la place du calcul.

---

## 9. Ce qui doit absolument quitter le navigateur

Par ordre de nécessité :

| Rang | Élément | Pourquoi |
|---|---|---|
| 1 | **La vérification de licence** | Évident : sinon le contrôle est décoratif. |
| 2 | **`liveStrategy.js` + `strategyTargetCalculator.js`** | C'est *le produit* : l'objectif, la référence chrono, les concurrents directs. |
| 3 | **`scenarioSimulator.js` + `monteCarloEngine.js`** | Sans eux, aucune probabilité. |
| 4 | **`driverPerformanceModel.js`** | La calibration est ton actif le plus difficile à reproduire. |
| 5 | **`raceCertainties.js`** | Les certitudes mathématiques sont un argument de vente à part entière. |
| 6 | **Le calcul du prix** | Sinon le client choisit son prix. |
| 7 | **La création de licence** | Sinon le client s'auto-attribue un droit. |

Peuvent rester dans le navigateur sans dommage : le rendu, les sélecteurs, l'historique, la qualité des données, la reconstruction d'état (déjà déductible des classements publics) et `calc.js` (partagé avec toute l'application).

**Corollaire opérationnel :** ces fichiers doivent **disparaître du site publié** et de la liste de précache de `sw.js:61-75`. C'est une tâche à part entière, facile à oublier, et l'oublier annule tout le reste.

---

## 10. Backend : lequel, et pourquoi

**Oui, un backend est indispensable.** Il n'y a aucun contournement : sans exécution serveur, il n'existe aucun endroit où poser un contrôle qu'un utilisateur ne puisse pas retirer.

**Recommandation : Cloud Functions for Firebase (2ᵉ génération), en Node.js.**

- même projet, même console, même facturation ;
- `onCall` vérifie le jeton Firebase Auth automatiquement — zéro code d'authentification à écrire ;
- l'Admin SDK écrit dans Firestore en ignorant les règles : exactement ce qu'il faut pour `licenses` ;
- **les modules du moteur tournent déjà en Node sans modification** (prouvé par `tools/qualification-audit/`) ;
- déclencheurs Firestore disponibles pour le cache de contexte (§11) ;
- impose le plan **Blaze** (carte bancaire enregistrée), dont le palier gratuit couvre très largement ton volume.

Alternatives écartées : Vercel / Netlify / Cloudflare Workers imposeraient de placer une clé de compte de service Firebase chez un tiers, de réécrire la vérification de jeton à la main, et de gérer deux consoles. Aucun bénéfice ici.

**Fonctions nécessaires (six) :**

| Fonction | Type | Rôle |
|---|---|---|
| `getLiveStrategy` | `onCall` | vérifie la licence, calcule, renvoie l'objectif |
| `createCheckoutSession` | `onCall` | calcule le prix, crée la session Stripe |
| `stripeWebhook` | HTTP | vérifie la signature, crée la licence |
| `onResultWrite` | déclencheur Firestore | régénère `strategyContexts` |
| `manageTeamMembers` | `onCall` | invitations, ajout/retrait de membres |
| `adminGrantLicense` | `onCall` | licence offerte / essai, avec journal d'audit |

---

## 11. Coûts (§10)

### 11.1 Le vrai poste de coût n'est pas le calcul, c'est la lecture

`loadSeason()` lit aujourd'hui **toute la saison** : meetings + sessions + results + sessionParticipants, soit de l'ordre de **6 000 à 8 000 documents**. Dans le navigateur c'est indolore (une fois, en cache mémoire). Transposé tel quel côté serveur, ce serait ruineux : le palier gratuit Firestore est de **50 000 lectures par jour**, soit **six appels** — de quoi tenir un quart de manche.

**D'où la pièce d'architecture obligatoire : `strategyContexts`.** Un déclencheur `onWrite` sur `results` régénère le contexte pré-calculé du meeting × catégorie concerné. Un appel stratégique lit alors **1 à 3 documents** au lieu de 8 000.

Bénéfice secondaire, aussi important : la réponse devient quasi instantanée, ce qui est exactement l'exigence en bord de piste.

### 11.2 Hypothèses de volume

Un team consulte après chaque manche et re-consulte pendant : disons **40 appels par team et par jour de meeting**, 10 meetings par an.

| Teams | Appels / an | Lectures Firestore / an | Invocations / an | Coût mensuel estimé |
|---|---|---|---|---|
| 10 | 4 000 | ~12 000 | 4 000 | **0 €** |
| 50 | 20 000 | ~60 000 | 20 000 | **0 €** |
| 100 | 40 000 | ~120 000 | 40 000 | **0 €** |

Ces chiffres sont **très en dessous** des paliers gratuits (2 M d'invocations et 400 000 Go·s **par mois** pour les Functions ; 50 000 lectures **par jour** pour Firestore). Même en multipliant l'usage par vingt, on reste dans le gratuit.

### 11.3 Ce qui coûte réellement

| Poste | Coût |
|---|---|
| Cloud Functions, Firestore, Hosting | ≈ **0 €/mois** aux trois échelles |
| `minInstances: 1` (élimination des démarrages à froid) | ≈ **6–10 €/mois** si laissé actif en permanence — **≈ 1–2 €/mois** si activé seulement les week-ends de meeting |
| Domaine personnalisé | ≈ 12 €/an |
| **Stripe** | **1,5 % + 0,25 €** par transaction carte européenne — ≈ 0,70 € sur une vente à 30 € |
| Comptabilité / TVA | variable, à voir avec ton comptable |

**Conclusion : l'infrastructure est gratuite à ton échelle, et le restera longtemps.** À 100 teams × 200 € de saison, tu encaisserais 20 000 € pour environ 500 € de frais Stripe et ~50 € d'infrastructure. Le modèle économique n'a aucun problème de coût technique. **Le coût réel de ce projet, c'est ton temps de développement.**

---

## 12. Risques

| # | Risque | Gravité | Traitement |
|---|---|---|---|
| 1 | Verrouillage cosmétique contourné en trois lignes de console | **critique** | LOT C — déplacer le calcul serveur. Non négociable. |
| 2 | Toutes les données lisibles publiquement | **élevée** | Non corrigeable sans tuer le produit gratuit. **À assumer** : on protège le calcul, pas la donnée. |
| 3 | Copie du moteur laissée dans `js/` ou dans `sw.js` | **critique** | Retirer les fichiers du site publié **et** du précache. À vérifier explicitement à chaque déploiement. |
| 4 | Une écriture client autorisée sur `licenses` | **critique** | `allow write: if isAdmin()` et rien d'autre. À tester avec l'émulateur. |
| 5 | Webhook Stripe falsifié | **critique** | Vérification de signature sur le corps brut. |
| 6 | Prix envoyé par le client | **élevée** | Montant calculé serveur exclusivement. |
| 7 | Webhook rejoué → licences en double | moyenne | Identifiant de document déterministe. |
| 8 | Partage de compte entre teams | faible | Peu exploitable : la licence est liée à *un* pilote. Journaliser `strategyUsage` et surveiller. |
| 9 | Fusion/suppression de fiche pilote → licence orpheline | moyenne | Procédure de fusion transactionnelle ; suppression bloquée si licence active. |
| 10 | `personId` manquant ou mal apparié | **élevée** | Audit + reprise **avant** la première vente. C'est un risque client, pas un risque technique. |
| 11 | Réseau indisponible en bord de piste | **élevée** | §2.5 : réponses minuscules, cache de la dernière réponse horodatée, `minInstances`. |
| 12 | RGPD / vente d'analyse sur un tiers | **à ne pas négliger** | Voir ci-dessous. |
| 13 | Obligations légales (CGV, TVA, droit de rétractation sur le numérique) | moyenne | À traiter avec un comptable. Un MoR (§5.1) en absorbe une partie. |

### Sur le point 12, qui mérite un paragraphe

Ton modèle vend l'analyse de la performance d'**une personne nommée**. Les résultats de course sont publics, et la France reconnaît un intérêt légitime à les traiter. Mais **rien, dans le modèle décrit, n'empêche le team B d'acheter la licence du pilote X pour l'analyser.** Techniquement c'est identique ; humainement et juridiquement, ce n'est pas du tout la même chose.

Trois mesures simples, à décider maintenant plutôt que dans l'urgence :

1. **une validation admin des achats** (ou au minimum la capacité de refuser et rembourser) — c'est de toute façon ce que tu feras au début, vu le volume ;
2. une clause de CGU limitant l'usage au team du pilote concerné ;
3. la possibilité de **révoquer** une licence, déjà prévue au modèle (`status: 'revoked'`).

Ce n'est pas de la paranoïa : c'est le genre de sujet qui, mal traité, se règle dans le paddock plutôt que par e-mail.

---

## 13. Difficulté et découpage

| Lot | Contenu | Durée | Risque | Vendable à la fin ? |
|---|---|---|---|---|
| **A — Comptes** | inscription, mot de passe oublié, vérification e-mail, custom claim admin, `users`/`teams`/`teamMembers`, règles + tests émulateur | 2–3 j | faible | non |
| **B — Licences** | modèle `licenses`, écran admin, attribution manuelle, suspension, révocation, essai gratuit, audit + reprise de `personId`, outil de fusion de fiches | 2–3 j | **moyen** (la reprise des données est le point dur) | **oui, à la main** |
| **C — Moteur serveur** | Cloud Functions, migration vers Firebase Hosting, `strategyContexts` + déclencheur, contrat d'API, adaptation de `projectionStats.js`, **retrait du moteur du site publié et du précache SW** | **5–8 j** | **élevé** | oui, réellement |
| **D — Paiement** | `pricing`, `createCheckoutSession`, `stripeWebhook`, écran tarifs, tunnel d'achat | 2–3 j | moyen | oui, automatiquement |
| **E — Durcissement** | limitation de débit, `strategyUsage`, tests de règles, mode dégradé hors ligne, CGV/RGPD | 2 j | faible | — |

**Total ≈ 3 à 4 semaines** de travail concentré pour une personne.

### Le lot le plus difficile est C, et il faut savoir pourquoi

Le portage du moteur en lui-même est facile — les modules sont purs et tournent déjà en Node. La difficulté est ailleurs : **`projectionStats.js` appelle aujourd'hui une quinzaine de fonctions pures en leur passant des objets riches et en recevant des structures riches.** Il faut geler tout cela en un contrat JSON stable, et l'écran opérationnel est précisément celui que tu as le plus soigné (LOT 6). Le risque n'est pas de casser le calcul : c'est d'appauvrir l'affichage sans s'en apercevoir.

Mesure de protection : les tests Vitest existants portent sur les modules purs et **restent valides après le déplacement** — ils continuent d'importer les mêmes fichiers. C'est un filet de sécurité qui existe déjà et qu'il ne faut surtout pas perdre en réorganisant.

### Recommandation d'enchaînement, et elle compte

**Ne construis pas C et D avant d'avoir un client payant.**

Fais **A + B** — environ une semaine. Tu obtiens : des comptes, des teams, des licences, un écran d'administration, et la capacité d'offrir un accès à un team pendant Lohéac en trois clics. Le verrou reste cosmétique pendant cette phase, et **il faut le savoir et l'assumer** : c'est acceptable face à deux ou trois teams identifiés à qui tu parles en personne, ce ne l'est plus dès la première vente à quelqu'un que tu ne connais pas.

Si les teams accrochent, tu fais C, puis D. Si personne n'accroche, tu auras économisé deux semaines et demie sur une infrastructure de paiement pour zéro client.

Cela colle exactement à ton calendrier Lohéac : **le lot B seul suffit à ta démonstration**, sans Stripe, sans backend, sans migration d'hébergement.

---

## 14. Réponses directes à tes 17 questions

| # | Question | Réponse |
|---|---|---|
| 1 | Facilement réalisable avec l'architecture actuelle ? | **Réalisable, pas « facilement ».** Deux atouts décisifs (moteur pur déjà Node-compatible, Firebase Auth en place) ; un manque structurel : aucun backend. |
| 2 | Collections supplémentaires ? | `users`, `teams`, `teamMembers`, `licenses`, `pricing`, `strategyContexts`, `strategyUsage`. Sept, dont deux techniques. |
| 3 | Compte → fiche pilote → licence ? | `users` –(`teamMembers`)– `teams` –(1:n)– `licenses` → `personId`. La licence appartient au **team**. |
| 4 | Pilote à plusieurs `driverId` ? | **Déjà résolu** : `drivers.personId` existe et `personProfile.js` l'exploite. La licence porte sur `personId` ; le serveur résout `personId` → `driverId` dans le contexte du meeting. Fiabiliser l'appariement avant de vendre. |
| 5 | Plusieurs membres sur une licence ? | Membres du team → licences du team. Ajouter/retirer un membre ne touche pas la licence. |
| 6 | PASS MEETING / PASS SAISON ? | Champ `scope` + (`meetingId`) ou (`championshipId`, `year`). Une seule fonction de vérification, sept lignes. |
| 7 | Accès offert / essai ? | `origin: 'admin_grant'` ou `'trial'` + `validUntil`. **Zéro structure supplémentaire.** |
| 8 | Authentification ? | **Firebase Auth**, déjà présent. Ajouter inscription, réinitialisation, vérification d'e-mail, custom claim admin. |
| 9 | Prestataire de paiement ? | **Stripe Checkout** + webhook. Regarder Paddle/Lemon Squeezy si vente hors de France (TVA prise en charge, ~1,30 € de plus par vente à 30 €). |
| 10 | Backend nécessaire ? | **Oui, obligatoire.** Cloud Functions 2ᵉ génération, six fonctions. Sans lui, rien de ce qui précède ne tient. |
| 11 | Qu'est-ce qui doit quitter le navigateur ? | Vérification de licence, `liveStrategy`, `strategyTargetCalculator`, `scenarioSimulator`, `monteCarloEngine`, `driverPerformanceModel`, `raceCertainties`, calcul du prix, création de licence. **Et ces fichiers doivent cesser d'être publiés.** |
| 12 | Règles Firestore ? | §7. La plus importante : `licenses` en `write: if isAdmin()` uniquement. Et : un compte anonyme ne doit jamais être traité comme un utilisateur. |
| 13 | Ton accès admin ? | Custom claim `admin: true` → court-circuit en tête de chaque Function, avant toute vérification de licence, plus `isAdmin()` dans toutes les règles. Allowlist e-mail conservée en secours. |
| 14 | Difficulté ? | **Moyenne-élevée.** 3–4 semaines au total ; le lot C (moteur serveur) concentre le risque. Mais **1 semaine** suffit pour vendre à la main. |
| 15 | Coût mensuel à 10 / 50 / 100 teams ? | **≈ 0 € dans les trois cas.** Ajouter 1–10 €/mois si tu gardes une instance chaude, et ~2,3 % du chiffre d'affaires pour Stripe. |
| 16 | Risques ? | §12. Les trois qui comptent : un moteur laissé côté client (fatal), une écriture client sur `licenses` (fatal), un `personId` mal apparié (perte de confiance client). Plus un risque opérationnel réel : le réseau en bord de piste. |
| 17 | Évolution multi-championnats ? | **Déjà prête.** `championshipId` est présent partout, le règlement vit dans `championships`, et le périmètre de licence le porte nativement. Rien à prévoir de plus. |

---

## 15. Ce que je recommande de décider maintenant

1. **Confirmer l'hébergement actuel** (GitHub Pages ?) — cela conditionne le lot C.
2. **Faire l'audit de `personId`** avant toute chose : combien de `drivers` n'ont pas de fiche, combien de fiches sont en doublon. C'est un script en lecture seule d'une heure, sur le patron de `tools/qualification-audit/`. Le résultat peut changer l'estimation du lot B.
3. **Accepter le principe** : ce qu'on protège, c'est le calcul, pas la donnée. Si ce principe n'est pas acceptable, il n'y a pas de produit vendable ici.
4. **Faire A + B avant Lohéac**, montrer l'outil, offrir deux ou trois accès d'essai — et ne décider de C et D qu'après avoir vu la réaction des teams.

Le reste — la grille tarifaire, la valeur perçue, le brief commercial — se décide après Lohéac, avec un vrai exemple : « voilà ce que l'outil annonçait après Q3, voilà ce qui s'est passé en Q4. » Aucune de ces décisions n'est bloquée par l'architecture proposée, et c'est précisément le but : **elle est conçue pour que tu puisses changer d'avis sur les prix sans changer de code.**
