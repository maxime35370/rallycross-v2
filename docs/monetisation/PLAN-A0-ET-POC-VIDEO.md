# PLAN A0 — accès pilote manuel · et POC vidéo minimal

Suite de `AUDITS-ET-PLANS.md`. **Aucun code applicatif écrit, `main` intact.**
Décisions validées le 2026-08-21, reportées ici comme cadre de travail.

## 0. Cadre validé

| Décision | Statut |
|---|---|
| Licence adossée à `personId` | ✅ validé — la base est propre (0 `driver` sans fiche) |
| PASS MEETING = championnat + meeting + `personId` | ✅ validé — « Lohéac FFSA » ≠ « Lohéac Euro RX » |
| PASS SAISON séparé par championnat | ✅ validé — un pilote des deux calendriers peut avoir deux licences saison |
| Aucune fusion automatique de fiches | ✅ validé |
| Tests de règles prioritaires | ✅ validé |
| Vidéo indépendante du chantier licences | ✅ validé |
| Pas de plan A complet, pas de Stripe, pas de migration, `main` non touchée | ✅ validé |

**Les trois fiches signalées** — aucune action automatique, conformément à ta consigne :

| Fiche | Traitement retenu |
|---|---|
| Maxime Morin (`W69FOpcPwt2zDCBuZJIz` / `a99NpcuKjiMmP0ssGxd7`) | **test présumé — à vérifier manuellement.** Aucune fusion. |
| Mickael / Michael Leonard (`bpRUyFz1hZCrSs5mXyry` / `qlTgFXpjzR40IiB5FvVG`) | **candidat à vérification**, marqué comme tel. Aucune fusion. |
| Nine / Noé Foulfoin (`E38hxYz8nxKFF00mmqKu` / `zGdFrfTJwbd2PC0XOE4g`) | **ne jamais fusionner** — deux personnes distinctes. |

> Conséquence pour A0 : le modèle doit prévoir un champ de **marquage** sur la fiche personne
> (`reviewFlag`) plutôt qu'une quelconque fusion. Une ligne, et le sujet est clos jusqu'à ce que
> tu tranches toi-même.

## 0 bis. `netlify.toml` — préparé, non actif

Le fichier est écrit dans **`docs/monetisation/proposed/netlify.toml`**, volontairement **pas** à la
racine : tant qu'il n'y est pas, Netlify l'ignore totalement. Rien n'est donc déployé ni modifié.

Pour l'activer après ta vérification :

```bash
git mv docs/monetisation/proposed/netlify.toml netlify.toml
```

Il exclut `docs`, `tests`, `tools` et `overlay/demo/*.png` — mais **conserve
`overlay/demo/*.html`**, référencé par sept liens depuis `overlay/index.html`. Le fichier porte
en commentaire l'avertissement sur `publish` (un `netlify.toml` prend le pas sur les réglages de
l'interface Netlify : relève la valeur actuelle avant de l'activer).

---

# 1. PLAN A0 — accès pilote manuel

**Objectif unique** : pouvoir, après Lohéac, donner à la main un accès premium à un compte pour une
fiche pilote donnée, sur un périmètre meeting ou saison. Cible : **1 à 3 teams**.

## 1.1 Ce qui a été retiré du plan A, et ce qui ne pouvait pas l'être

| Retiré | Pourquoi | Gain |
|---|---|---|
| Écran « Mon compte » | remplacé par un **bandeau** dans Stratégie Live : « Accès team X · Pilote Y · Saison FFSA 2026 · jusqu'au 31/12 ». L'information est là où elle sert | 0,4 j |
| Trois écrans d'administration | **un seul écran** à trois sections : teams, membres, licences | 0,3 j |
| Filtres, tri, pagination de l'écran admin | trois teams tiennent dans un tableau brut | 0,3 j |
| Invitations, recherche d'utilisateur | l'admin ajoute les membres (§1.3) | *déjà hors plan A* |
| `pricing` | pas de paiement, donc pas de prix à calculer | *déjà hors plan A* |

| **Non retirable** | Pourquoi |
|---|---|
| Le modèle de données | c'est l'objet même de A0, et il doit être le bon du premier coup |
| Les règles Firestore | c'est la **seule** protection réelle de A0 (§1.6) |
| Les tests de règles | une règle non testée est une hypothèse — et l'hypothèse ici est « personne ne peut se fabriquer une licence » |
| L'écran d'administration | c'est celui que tu utiliseras devant un team |

> **Honnêteté sur le gain : A0 fait économiser environ une journée sur les six du plan A, pas
> quatre.** Le cœur coûteux — modèle, règles, écran admin — est exactement ce que A0 exige. Je
> préfère te le dire maintenant plutôt qu'au sixième jour.

## 1.2 Collections — quatre, et une ligne ajoutée à l'existant

```
users/{uid}                         créé par l'utilisateur à sa 1re connexion
  email          string             DOIT égaler request.auth.token.email
  displayName    string
  createdAt      timestamp

teams/{teamId}                      créé par l'ADMIN
  name           string
  contactEmail   string
  note           string             « démo Lohéac », « contact Untel »…
  createdAt / createdBy

teamMembers/{teamId}_{uid}          créé par l'ADMIN — id déterministe
  teamId, uid    string
  role           'owner' | 'member'
  addedAt / addedBy

licenses/{licenseId}                créé par l'ADMIN UNIQUEMENT
  teamId         string
  personId       string             ← LA FICHE PILOTE
  scope          'meeting' | 'season'
  championshipId string             ← TOUJOURS, y compris en scope 'meeting'
  year           number             ← TOUJOURS
  meetingId      string | null      ← si scope = 'meeting'
  status         'active' | 'suspended' | 'revoked'
  origin         'admin_grant' | 'trial'
  validFrom      timestamp
  validUntil     timestamp | null
  note           string
  createdAt / createdBy / revokedAt / revokedBy / revokeReason
```

**Ajout à `persons` — un seul champ optionnel :**

```
persons/{id}
  reviewFlag     string | null      'duplicate_candidate' | 'test_record' | null
  reviewNote     string | null
```

C'est la traduction directe de ta consigne « marquer, ne pas fusionner ». Les trois fiches du §0
reçoivent un marquage, restent parfaitement fonctionnelles, et l'écran d'administration peut
afficher un avertissement quand on attribue une licence à une fiche marquée — exactement le moment
où l'information est utile.

**Note sur `championshipId` toujours renseigné**, y compris pour un pass meeting : cela rend la
vérification uniforme, permet de lister les licences par calendrier commercial, et évite d'avoir à
relire le meeting pour savoir de quel championnat relève une licence. Coût : un champ dénormalisé
de plus, ce qui est la convention du projet.

## 1.3 Le modèle d'attribution : l'admin fait tout

```
   1. Le team te donne l'e-mail de chacun de ses membres
   2. Chacun crée son compte           → users/{uid} apparaît
   3. Tu crées le team                 → teams/{teamId}
   4. Tu ajoutes les membres           → teamMembers/{teamId}_{uid}
   5. Tu attribues la licence          → licenses/{id}   (personId + périmètre)
   6. Le membre ouvre Stratégie Live   → le pilote autorisé apparaît dans le sélecteur
```

Ce n'est pas seulement une simplification de confort. **Sans backend, ajouter un membre par
lui-même supposerait de retrouver son `uid` depuis son e-mail — donc de rendre la collection
`users` interrogeable depuis le navigateur, c'est-à-dire d'exposer la liste de tes clients.**
Faire faire les trois clics par l'admin supprime toute cette classe de problèmes, et à trois teams
le coût est nul.

## 1.4 Écrans — un nouveau, deux modifications

| # | Écran | Contenu | Accès |
|---|---|---|---|
| 1 | **Connexion / inscription** — extension de l'UI existante de `js/auth.js` | création de compte, connexion, **mot de passe oublié**, bouton « renvoyer l'e-mail de vérification » + état. Retirer la condition `?login` qui masque aujourd'hui le formulaire | public |
| 2 | **« Accès team »** — vue `access`, ajoutée à `PROTECTED_VIEWS` | **§A Teams** : créer, renommer · **§B Membres** : choisir un compte dans `users`, l'attacher à un team, le retirer · **§C Licences** : fiche pilote → périmètre → dates → origine · suspendre / réactiver / révoquer | **admin** |
| 3 | **`projectionStats.js`** — modification | filtrer le sélecteur de pilote sur les fiches autorisées · bandeau d'accès · message d'invitation si aucune licence · **court-circuit total si `isAdmin()`** | — |

**Trois exigences d'interface non négociables, issues de l'audit :**

1. **Le sélecteur de meeting affiche date + lieu + championnat.** Sans cela, les deux Lohéac du
   30/08/2026 sont indiscernables et tu vendras le mauvais.
2. **Le sélecteur de fiche pilote affiche les inscriptions rattachées** — « Fabien Pailler — #7
   Supercar FFSA · #29 RX1 Euro RX ». C'est ce qui rend visible, au moment de vendre, ce que la
   licence couvre.
3. **Une fiche marquée `reviewFlag` affiche un avertissement** au moment de l'attribution.

## 1.5 Règles Firestore

```
function isRealUser() {
  return request.auth != null
      && request.auth.token.firebase.sign_in_provider != 'anonymous';
}
function isVerified() {
  return isRealUser() && request.auth.token.email_verified == true;
}
function isTeamMember(teamId) {
  return isVerified()
      && exists(/databases/$(database)/documents/teamMembers/$(teamId + '_' + request.auth.uid));
}

match /users/{uid} {
  // création possible SANS e-mail vérifié : sinon l'admin ne peut pas trouver
  // le compte pour l'attacher à un team. La vérification est exigée plus bas,
  // là où elle compte : à la LECTURE d'une licence.
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

// ── LA RÈGLE QUI PORTE TOUT LE PLAN A0 ─────────────────────
match /licenses/{licenseId} {
  allow read:  if isRegie() || isTeamMember(resource.data.teamId);
  allow write: if isRegie();
}

// Durcissement de l'existant : personId devient obligatoire et le marquage est admissible
match /persons/{docId} {
  allow read:   if true;
  allow create, update: if isRegie() && … 
                && (!('reviewFlag' in request.resource.data)
                    || request.resource.data.reviewFlag in ['duplicate_candidate','test_record']);
  allow delete: if isRegie();
}
match /drivers/{docId} {
  allow create, update: if isRegie() && …
                && request.resource.data.personId is string
                && request.resource.data.personId.size() > 0;
}
```

**Cinq points sur lesquels il ne faut rien concéder :**

1. **`licenses` en `write: if isRegie()`, rien d'autre, jamais.** C'est la ligne qui rend A0
   honnête, et c'est celle qui restera identique dans le système payant (le webhook Stripe écrira
   via l'Admin SDK, qui ignore les règles).
2. **L'auth anonyme est exclue explicitement.** Elle est **déjà en service** pour les votes
   pronostics : `request.auth != null` laisserait donc entrer tout spectateur ayant voté. C'est le
   piège le plus facile à commettre dans ce projet précis.
3. **`users.email == request.auth.token.email` à la création**, et immuable ensuite — sinon on se
   déclare sous l'e-mail d'un autre et ton écran d'administration devient mensonger.
4. **`teamMembers` : identifiant déterministe imposé par la règle**, comme `sessionParticipants`
   et `results`. C'est la convention maison, et elle rend le doublon structurellement impossible.
5. **La vérification d'e-mail est exigée pour lire une licence, pas pour créer son compte.**
   Sans cette nuance, un compte tout juste créé serait invisible pour toi, et tu ne pourrais pas
   l'attacher à un team.

⚠️ Chaque `exists()` dans une règle est facturé comme une lecture et ajoute un aller-retour. Sans
importance à ton échelle, mais à savoir avant de l'employer dans une règle appelée souvent.

## 1.6 Ce qui est **réel** et ce qui reste **cosmétique**

C'est la question que tu poses, et elle mérite une réponse sans nuance de politesse.

### Réel — tient face à quelqu'un qui trafique son navigateur

| Garantie | Assurée par |
|---|---|
| Personne ne peut **créer, modifier ou supprimer** une licence | `licenses.write: if isRegie()` |
| Personne ne peut **s'ajouter** à un team | `teamMembers.write: if isRegie()` |
| Personne ne peut **lire les licences d'un autre team** | `licenses.read` + `isTeamMember()` |
| Personne ne peut **se faire passer** pour un autre e-mail | contrainte sur `users.email` |
| Une session **anonyme** (pronostics) n'obtient jamais rien | `sign_in_provider != 'anonymous'` |
| Un compte **non vérifié** n'obtient jamais d'accès | `email_verified` sur la lecture de licence |

Ces six garanties sont **définitives** : elles ne dépendent d'aucun code client et resteront vraies
dans le système payant.

### Cosmétique — tombe en trois lignes de console

| Ce qui n'est pas protégé | Pourquoi |
|---|---|
| Le **filtre du sélecteur de pilote** | c'est du JavaScript sur la machine de l'utilisateur |
| Le **masquage de l'onglet Stratégie** | idem |
| **L'usage réel du moteur**, pour n'importe quel pilote | `js/projection/*` est servi publiquement et **préchargé par le service worker** ; les données sont publiques. Un `await import('/js/projection/liveStrategy.js')` dans la console suffit |

**Autrement dit : A0 rend la relation commerciale réelle, pas la protection technique.**
Un team ne peut pas s'attribuer un accès — mais quelqu'un qui sait ce qu'il fait peut se passer de
l'accès. C'est exactement le compromis que tu as validé, et il est adapté à 1–3 teams que tu
connais personnellement. Il cesse de l'être à la première vente à un inconnu.

**Ce que je recommande d'en dire aux teams** : rien de particulier. Ne promets pas une protection
que tu n'as pas, mais il n'y a aucune raison d'ouvrir le sujet. Ce que tu vends, c'est un service et
une relation, pas un verrou.

## 1.7 Ce qui sera réutilisé dans le système payant

| Élément A0 | Devenir | Réutilisation |
|---|---|---|
| `users`, `teams`, `teamMembers` | inchangés | **100 %** |
| Schéma `licenses` | Stripe **ajoute** `origin:'purchase'`, `pricePaidCents`, `currency`, `paymentRef`. Aucun champ existant ne change | **100 %** |
| Règles `users` / `teams` / `teamMembers` | inchangées | **100 %** |
| Règle `licenses.write: if isRegie()` | **inchangée** — le webhook écrit via l'Admin SDK, hors règles | **100 %** |
| Tests de règles | s'étoffent, ne se réécrivent pas | **100 %** |
| Logique `autorisé(driverId, meetingId)` | **déplacée telle quelle** dans la Cloud Function du lot C. Les mêmes sept lignes | **100 %** |
| Écran d'administration | gagne filtres, montant, historique de paiement | **~80 %** |
| Filtre du sélecteur de pilote | reste, pour le confort — cesse d'être la protection | **100 %** (rôle changé) |
| Allowlist e-mail admin | remplacée par un *custom claim* quand `functions/` existera | **~1 h de reprise** |
| Bandeau d'accès | inchangé | **100 %** |

> **Environ 90 % du plan A0 survit tel quel dans le système payant.** Rien n'est jetable, à
> l'exception d'une heure pour basculer l'admin vers un *custom claim*. C'est la raison pour
> laquelle A0 n'est pas un prototype : c'est la première tranche du produit final.

## 1.8 Effort réel

| Tâche | Durée |
|---|---|
| Inscription + mot de passe oublié + envoi/état de vérification (l'UI d'auth existe, on l'étend) | 0,5 j |
| `users` / `teams` / `teamMembers` : modèle, écritures, règles | 0,75 j |
| `licenses` : modèle, règles, `persons.reviewFlag` | 0,5 j |
| Écran « Accès team » — trois sections, tableaux bruts, sans filtres | 1,25 j |
| Filtre `personId` + bandeau dans `projectionStats.js` + réaction à `authchange` | 0,5 j |
| **Tests de règles** (émulateur Firebase + `@firebase/rules-unit-testing`) | 1 j |
| Câblage : `VIEW_TITLES`, menu, `safeInit`, `PROTECTED_VIEWS`, `ASSET_PATHS`, CSS | 0,25 j |

> ### **PLAN A0 : 4,5 à 5 jours.** Difficulté moyenne. Aucun backend, aucune dépendance runtime.

⚠️ **Un coût de mise en route à ne pas découvrir en cours de route** : l'émulateur Firestore exige
**`firebase-tools` et une JVM (Java 11+)**. C'est la première dépendance lourde du projet, qui n'a
aujourd'hui que Vitest et Playwright en développement. Compte **~0,25 j des 1 j de tests** rien que
pour l'installation et le premier `firebase emulators:exec` qui passe.

---

# 2. POC VIDÉO MINIMAL

**Question unique à laquelle il doit répondre :**

> **YOLOX-tiny trouve-t-il assez de voitures sur NOS images pour justifier cinq jours de V1 ?**

Rien d'autre. Pas de tracking, pas de ReID, pas d'association aux pilotes, pas de sauvegarde, pas
d'intégration.

## 2.1 Une correction à ma propre estimation

J'ai écrit « une demi-journée » dans le document précédent. **C'était optimiste.** Le POC ne peut
pas éviter d'écrire le post-traitement YOLOX — décodage des grilles, *strides*, NMS — qui est
précisément l'élément que j'avais chiffré à 1–1,5 jour dans la V1.

**Chiffrage honnête : 1 à 1,25 jour.** Mais avec une nuance décisive : **ce travail n'est pas
perdu si le POC échoue, parce que c'est exactement le module que la V1 utiliserait.** Le coût réel
d'un POC négatif est donc de l'ordre de **0,3 jour**, pas d'une journée.

## 2.2 Deux questions, pas une — et c'est ce qui rend le POC court

| | Question | Peut-elle tuer le projet ? | Où la mesurer |
|---|---|---|---|
| **Q1** | **YOLOX-tiny trouve-t-il nos voitures ?** | **OUI** | **Node** — 0,5–0,75 j |
| **Q2** | Est-ce assez rapide dans un navigateur ? | non — les ordres de grandeur sont déjà connus et acceptables | Navigateur — 0,5 j, **seulement si Q1 passe** |

### Écart assumé avec `AUTOMATION-ARCHITECTURE.md` §15

Ce document prescrit un POC **dans le navigateur**, « pour tester la vraie chaîne technique ».
L'argument est juste, mais il répond à Q2, pas à Q1. Or **c'est Q1 qui peut tout arrêter** : si le
détecteur ne voit pas les voitures, la vitesse d'exécution n'a aucun intérêt.

Faire Q1 sous Node apporte trois choses concrètes :

1. **on écrit directement le module pur** `videoDetectCalc.js` (letterbox, décodage, NMS), testable
   avec Vitest, réutilisé ensuite **sans modification** dans le navigateur ;
2. **c'est exactement le patron déjà éprouvé du projet** — `tools/qualification-audit/*.mjs`
   importent `js/projection/*.js` tels quels et les exécutent sous Node ;
3. on économise toute la plomberie navigateur (canvas, worker, cache de modèles) tant que la
   question de fond n'est pas tranchée.

**Je ne supprime donc pas l'étape navigateur du §15 : je la déplace après.**

## 2.3 Étape 1 — Q1, qualité de détection (Node)

**Emplacement** : `tools/video-poc/`, jamais importé par l'application. `onnxruntime-node` en
`devDependency`, aux côtés de Vitest et Playwright.

### Le jeu d'images — c'est là que se joue la validité du POC

| Exigence | Valeur | Pourquoi |
|---|---|---|
| Nombre d'images | **10 à 15** | en deçà, les taux sont du bruit ; au-delà, le comptage manuel devient une corvée |
| Départs différents | **≥ 3** | éviter de mesurer une seule situation |
| Angles de caméra différents | **≥ 2** | la révision 5 du document existant a été écrite parce que la caméra bouge |
| Images « difficiles » | **≥ 2** | poussière, peloton serré, contre-jour |
| **Instant choisi** | **l'image de mesure — au premier virage** | ⚠️ **le point le plus important de tout ce POC** |

> ⚠️ **Ne mesure pas sur la ligne de départ.** Voitures alignées, écartées, caméra fixe : la
> détection y sera excellente et **ne prédira rien**. La V1 a besoin de l'image du premier virage —
> peloton compressé, poussière, flou de mouvement, occlusions. Un POC mené sur une image facile est
> un POC qui ment.

**Extraction** : `ffmpeg -ss <t> -i video.mp4 -frames:v 1 -q:v 2 img.jpg` sur les départs déjà
analysés — tu disposes ainsi de la vérité terrain de `startAnalyses` (**19 départs validés, 92
lignes**) pour savoir combien de voitures étaient réellement au départ.

### Le modèle

| | |
|---|---|
| Modèle | **YOLOX-tiny**, export ONNX officiel — **Apache 2.0**, décision validée |
| Entrée | 416 × 416, *letterbox* avec conservation du rapport |
| Sortie | tenseur unique, ~3 549 propositions (52² + 26² + 13²) × (4 + objectness + 80 classes) — **à confirmer sur l'export retenu** |
| Décodage | `(xy + grille) × stride`, `exp(wh) × stride`, score = objectness × classe |
| Classes retenues | COCO `car` (2), `truck` (7), `bus` (5) — les voitures de rallycross sortent parfois en `truck` |
| Poids | ~15 Mo |

> ⚠️ **Prendre l'export SIMPLE, pas l'export « end2end » avec NMS intégrée.** L'export end2end
> ferait passer le POC plus vite — mais en laissant précisément non écrit le code risqué que la V1
> devra produire. Le POC servirait alors à se rassurer, pas à décider.

### Ce que le script produit

1. un **PNG annoté** par image, boîtes et scores dessinés ;
2. un **CSV / JSON** : image, nombre de détections, score de chacune, temps d'inférence ;
3. un **récapitulatif** en console.

**Le comptage de la vérité terrain reste humain** : tu ouvres les PNG annotés et tu remplis, pour
chaque image, trois nombres — voitures correctement détectées, faux positifs, voitures ratées. Dix
minutes pour quinze images.

**Définition à figer AVANT de compter, sinon le chiffre ne veut rien dire :**

> Une voiture compte comme « ratée » seulement si **un humain l'identifie comme une voiture
> distincte avec plus de la moitié de sa carrosserie visible**. Une voiture noyée dans la poussière
> ou masquée à 90 % ne compte pas comme un échec du détecteur.

Sans cette convention, le taux de rappel dépend de l'humeur de celui qui compte.

## 2.4 Critères de décision — **à figer maintenant, pas après**

Un POC dont le seuil est choisi après coup est un POC qu'on rationalise.

| Rappel (voitures visibles trouvées) | Précision | Verdict |
|---|---|---|
| **≥ 90 %** | ≥ 70 % | ✅ **GO complet** — V1 puis V2/V3 restent ouverts |
| **80 – 90 %** | ≥ 70 % | 🟡 **GO limité à V1** — l'assistance vaut le coup, mais le tracking (V2) sera fragile : le décider séparément |
| **< 80 %** | — | ❌ **STOP** avec YOLOX-tiny. Essayer **YOLOX-s** (~35 Mo) avant d'abandonner |
| toutes valeurs | **< 50 %** | ❌ trop de fausses boîtes : l'écran devient illisible |

**Pourquoi le seuil de rappel est plus haut que celui de précision** : en V1, l'association est
faite **par clic**. Une boîte en trop est simplement ignorée par l'opérateur — coût quasi nul. Une
voiture manquée, elle, oblige à la saisir à la main — c'est-à-dire à faire le travail que
l'automatisation devait éviter.

**Pourquoi 80 % et pas 95 %** : le §15 du document existant fixe **≥ 95 %**, et ce seuil est le bon
**pour la chaîne complète**, où une détection manquée casse une piste de suivi et se propage. Pour
le seul détecteur de V1, avec association manuelle, le calcul est différent : à 80 % de rappel sur
six voitures, tu en trouves cinq et tu en cliques une — au lieu d'en cliquer six.

**Et le seuil qui n'est pas négociable** : en dessous de **60 %**, on retombe exactement sur le
constat qui avait fait abandonner l'approche en révision 5 — *« la voie semi-automatique coûte
autant de clics qu'elle en économise »*. Ce projet a déjà tué une approche pour cette raison ; il
ne faut pas la ressusciter par optimisme.

**Ce que ce POC ne mesure PAS**, et qu'il ne faut pas lui demander :

- le taux d'**erreur silencieuse** (« 0 obligatoire » du §15) — c'est un critère de la **ReID**,
  donc de V3. Un détecteur ne propose aucune identité ;
- la **continuité du suivi** — c'est V2 ;
- le **temps humain par départ** — il faut V1 complet pour le mesurer.

## 2.5 Étape 2 — Q2, vitesse navigateur (seulement si Q1 passe)

Page HTML autonome dans `tools/video-poc/`, jamais importée par l'application, conformément au §15 :

- chargement d'ONNX Runtime Web, **WebGPU avec repli WASM SIMD**, affichage du moteur actif ;
- **réutilisation sans modification** du module pur écrit à l'étape 1 ;
- fichier vidéo local, positionnement sur l'image, analyse, boîtes dessinées sur un canvas ;
- mesure : temps de chargement du modèle, temps d'inférence (médiane et p90), sur **WebGPU et
  WASM**, sur ta machine et sur celle que tu emmènes en bord de piste.

**Effort : 0,5 j.** Elle valide en même temps toute la chaîne technique de la V1 — et, si les
chiffres sont bons, une bonne partie de cette page devient l'ossature du module V1.

## 2.6 Effort total

| Étape | Durée | Réutilisable en V1 |
|---|---|---|
| Q1 — extraction, modèle, module pur, rapport (Node) | 0,5–0,75 j | **~80 %** (le module pur, tel quel) |
| Comptage manuel des 10–15 images | 10 min | — |
| Q2 — page navigateur, WebGPU/WASM (si Q1 passe) | 0,5 j | **~60 %** |

> ### **POC : 0,5 à 0,75 jour pour la décision. 1 à 1,25 jour avec la validation navigateur.**

---

# 3. Dépendances entre A0 et le POC

## 3.1 Aucune — vérifié fichier par fichier

| | Plan A0 | POC vidéo |
|---|---|---|
| Fichiers existants touchés | `js/auth.js`, `js/app.js`, `index.html`, `firestore.rules`, `js/projectionStats.js`, `sw.js` (ASSET_PATHS), CSS | **aucun** |
| Fichiers ajoutés | 1 vue, 1 module pur d'autorisation, 1 CSS | `tools/video-poc/**` |
| `package.json` | inchangé *(sauf devDependency émulateur)* | `onnxruntime-node` en devDependency |
| Firestore | 4 collections + 1 champ | **aucun accès** |
| Réseau | Firebase | **aucun** |

**Ils ne partagent pas un seul fichier applicatif.** Deux branches, aucun conflit de fusion, aucun
ordre imposé.

Le seul point de contact possible est `package.json` — et encore, chacun ajoute une entrée
différente dans `devDependencies`. Un conflit trivial, s'il survient.

## 3.2 Les dépendances futures, qui n'existent pas encore

```
POC ──(si GO)──► Vidéo V1 ──┐
                            ├──► lot C : moteur serveur ──► Stripe
Plan A0 ────────────────────┘
```

- La **vidéo V1** ne dépendra de A0 que le jour où l'analyse vidéo deviendra elle-même payante —
  et le document précédent conclut qu'elle est structurellement peu protégeable, donc ce n'est pas
  le sujet immédiat.
- Le **lot C** réutilisera la logique d'autorisation de A0 telle quelle.
- **Aucune de ces dépendances ne s'applique aux neuf prochains jours.**

---

# 4. Lequel faire en premier

## 4.1 Ma recommandation : **le POC, et il est court**

Le raisonnement tient en une ligne :

> **Le POC coûte un demi-jour et peut dire non. A0 coûte cinq jours et ne peut pas échouer.**

A0, c'est du CRUD et des règles Firestore : tu sais déjà que ça marchera, la seule inconnue est la
durée. Le POC, lui, porte une vraie incertitude — YOLOX-tiny sur des images de retransmission en
plein virage peut très bien se révéler médiocre. **Lever une incertitude qui commande cinq jours,
pour un demi-jour, c'est le meilleur rapport du moment.**

Et l'asymétrie joue dans les deux sens :

- **POC négatif** → tu viens d'économiser 5 jours pour 0,3 jour de coût net ;
- **POC positif** → tu abordes la V1 avec le module le plus risqué déjà écrit et mesuré.

## 4.2 Mais la vraie question des neuf prochains jours n'est ni l'un ni l'autre

Lohéac, c'est le **30 août — dans neuf jours**. Or :

- **A0 sert « après Lohéac »** — c'est ta propre formulation. Aucune urgence.
- **Le POC ne sert pas Lohéac non plus.**

Ce qui sert Lohéac, c'est **Lohéac** : faire tourner Stratégie Live en direct sur les deux épreuves,
noter ce que l'outil annonçait après Q3, et le confronter à ce qui s'est passé en Q4.

**C'est ce matériau-là qui vend.** Un écran d'administration bien fait ne convainc personne ; « après
Q3 l'outil te donnait 81 %, voilà la Q4 » convainc en trente secondes. Et ce matériau n'existe
qu'une fois par meeting — tu ne peux pas le rattraper le mois suivant.

> **Consacrer cinq des neuf jours à du CRUD avant ta meilleure occasion de démonstration serait le
> mauvais arbitrage.** Ce n'est pas un jugement sur A0 : c'est une question de fenêtre.

## 4.3 Ordre proposé

| Quand | Quoi | Durée |
|---|---|---|
| **Cette semaine** | Vérifier `/docs/` par `curl`, activer `netlify.toml` si besoin | 15 min |
| **Cette semaine** | Vérifier à la main les fiches Maxime Morin et Leonard | 10 min |
| **Cette semaine** | **POC vidéo — étape Q1 seule** | **0,5–0,75 j** |
| **Cette semaine** | **Préparer Lohéac** : jeux de données à jour, essai à blanc de Stratégie Live, captures prêtes | le reste |
| **30 août** | **Lohéac** — faire tourner l'outil en direct, tout consigner | — |
| **Après Lohéac** | **Plan A0**, avec du matériel de démonstration réel en main | 4,5–5 j |
| **Ensuite** | POC étape Q2, puis V1 si GO · lot C si les teams accrochent | — |

## 4.4 Si tu préfères quand même faire A0 avant Lohéac

C'est jouable — 5 jours sur 9 — mais alors coupe dans cet ordre, et pas dans un autre :

1. la **vérification d'e-mail** (garde l'envoi, retire l'exigence dans les règles — une ligne à
   remettre ensuite) ;
2. les **sections Teams et Membres** de l'écran admin : crée les deux ou trois documents
   directement dans la console Firebase, et ne code que la section Licences ;
3. le **bandeau d'accès** dans Stratégie Live.

**Ne coupe jamais les tests de règles.** C'est la seule chose de A0 qui protège réellement quelque
chose — tout le reste est du confort d'interface.

Ainsi ramené, A0 tient en **2,5 à 3 jours** et laisse six jours pour Lohéac. C'est le compromis que
je retiendrais si tu tiens à montrer la logique d'accès sur place.
