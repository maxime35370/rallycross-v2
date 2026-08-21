# A0 — mise en service

Mode d'emploi opérationnel. À suivre dans l'ordre, console Firebase ouverte.
Rien ici n'a été fait à ta place : mon environnement n'a **aucun accès** à ta
console Firebase ni à ton interface Netlify.

---

## 1. Firebase Authentication — **rien à activer**

Sondé le 2026-08-21 sur le projet `rallycross-1512f`, en lecture seule et
**sans créer aucun compte** :

| Contrôle | Méthode | Résultat |
|---|---|---|
| Provider e-mail / mot de passe | `accounts:signInWithPassword` sur une adresse inexistante | **ACTIF** — réponse `INVALID_LOGIN_CREDENTIALS`, et non `OPERATION_NOT_ALLOWED` |
| Inscription publique | `accounts:signUp` avec un mot de passe de 2 caractères | **AUTORISÉE** — réponse `WEAK_PASSWORD`, donc le refus porte sur la seule longueur. Aucun compte créé. |
| Domaines autorisés | `identitytoolkit/v1/projects` | `localhost`, `rallycross-1512f.firebaseapp.com`, `rallycross-1512f.web.app`, **`rxchrono.netlify.app`** |
| Protection contre l'énumération d'adresses | déduite de `INVALID_LOGIN_CREDENTIALS` | **ACTIVE** |

**Aucune action requise.** Si tu veux le vérifier à l'œil :
*console Firebase → Authentication → Sign-in method → Email/Password* doit
être « Activé », et *Settings → User actions → Enable create (sign-up)* coché.

### Vérification d'e-mail — comment ça se passe réellement

**À l'inscription**, `js/auth.js` envoie l'e-mail automatiquement. Expéditeur
`noreply@rallycross-1512f.firebaseapp.com`, lien vers
`rallycross-1512f.firebaseapp.com/__/auth/action?...`. **Ce message part
souvent en indésirables** — c'est la première chose à dire au team.

**Pour le renvoyer** : menu → le bandeau orange « Adresse non vérifiée » →
**« Renvoyer l'e-mail »**.

**Tant que l'adresse n'est pas vérifiée** :

| Où | Ce qui se passe |
|---|---|
| Règles Firestore | la lecture de `licenses` et `teams` est **refusée** — `isVerified()` |
| Stratégie Live | écran « Adresse e-mail à vérifier », avec la marche à suivre |
| Le reste de l'application | **inchangé** — classements, championnat, spectateur, pronostics |
| Création du compte | **autorisée** : sinon l'administrateur ne verrait pas le compte à rattacher |

> ### ⚠️ Le piège, et le bouton qui le règle
>
> Les règles lisent `request.auth.token.email_verified` — une valeur **figée
> dans le jeton**. Cliquer le lien reçu met à jour le **compte**, pas le
> jeton déjà en main : l'onglet ouvert continue de présenter
> `email_verified: false` **pendant une heure**, jusqu'au renouvellement
> automatique.
>
> L'utilisateur aurait donc fait exactement ce qu'on lui demandait, et
> l'accès resterait fermé. C'est la pire des situations pour un premier
> contact commercial.
>
> D'où le bouton **« J'ai vérifié »** à côté du renvoi : il appelle
> `reload()` puis `getIdToken(true)`, réabonne les droits avec le nouveau
> jeton, et l'écran se réaligne immédiatement. **Dis-le au team** : « clique
> le lien, puis reviens et clique “J'ai vérifié” ».

---

## 2. Règles Firestore — publication

Le dépôt versionne `firestore.rules` ; **la console ne le lit pas**. Il faut
copier-coller.

### Ce que la publication change exactement — **vérifié**

Les règles de production ont été comparées bloc par bloc au dépôt et aux
nouvelles règles, le 2026-08-21.

> **Production et `main` sont IDENTIQUES sur les 23 blocs.** Aucune
> modification n'a été faite directement dans la console depuis le dernier
> commit. Publier ne perdra donc rien.
>
> **Conséquence pratique : le fichier de rollback est déjà dans git.**
> `git show origin/main:firestore.rules` rend exactement les règles
> actuellement en production. Une sauvegarde locale reste utile, mais elle
> n'est plus la seule copie.

| Bloc | Effet de la publication |
|---|---|
| `users`, `teams`, `teamMembers`, `licenses` | **ajoutés** |
| `drivers` | **durci** — `personId` devient obligatoire |
| `persons` | **durci** — `reviewFlag` borné à deux valeurs |
| En-tête du fichier | **fonctions ajoutées** — `isSignedIn`, `isVerified`, `isTeamMember`, `nonEmpty`, `validLicense`, `validReviewFlag`, `meetingIdOf` ; `isRegie` passe en `get('email','')` |
| Les 19 autres blocs | **inchangés** |

**Rien n'est retiré.**

> ⚠️ **Le seul changement qui peut te gêner est `drivers.personId`.** C'est
> pour lui que le test 4 ci-dessous existe. Les 284 inscriptions en base en
> ont une, et `js/drivers.js` en calcule toujours une, donc l'enregistrement
> doit passer. Si un enregistrement de pilote était refusé, cela signifierait
> qu'un `personId` est nul : republie les anciennes règles, dis-le-moi, et on
> traite le cas avant de recommencer.

### Avant de publier — garder l'ancienne version

*Console Firebase → Firestore Database → Rules* → **sélectionner tout le
contenu de l'éditeur et le coller dans un fichier local**, par exemple
`firestore.rules.avant-A0`. C'est ton rollback, et il ne coûte rien.

> Firebase conserve aussi l'historique : onglet **Rules → Historique des
> versions** (ou « Rules playground → History » selon la langue). On peut y
> restaurer une version antérieure en deux clics. Le fichier local reste
> préférable : il ne dépend d'aucune interface.

### Publier

1. Ouvrir `firestore.rules` **de la branche** `claude/monetization-strategy-live-analysis-0y6f9k`
   (494 lignes).
2. **Tout sélectionner, tout copier.**
3. Console → *Firestore Database → Rules* → **tout sélectionner dans
   l'éditeur, tout remplacer** par le contenu copié.
4. **Publier**.

⚠️ **Remplacement intégral, pas un ajout.** Le fichier contient l'ensemble
des règles — les anciennes collections comprises, avec deux durcissements :
`drivers.personId` devient obligatoire, et `persons.reviewFlag` est borné.

### Vérifier que la nouvelle version est active

| Test | Où | Attendu |
|---|---|---|
| 1 | Console → Rules, en haut | horodatage « publié à l'instant » |
| 2 | `rxchrono.netlify.app` **déconnecté** → Classements | s'affichent normalement |
| 3 | Mode Spectateur, un pronostic ouvert | le vote fonctionne toujours |
| 4 | Connecté en régie → Pilotes → modifier un pilote | l'enregistrement passe |
| 5 | Console navigateur, déconnecté :<br>`await (await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')).getDocs(...collection('licenses'))` | **refusé** |

Le test 4 est le plus important : c'est lui qui prouve que le durcissement de
`drivers.personId` ne bloque pas ta saisie. Fais-le **avant** un week-end de
meeting.

### Revenir en arrière

Recoller `firestore.rules.avant-A0` dans l'éditeur et publier. Effet immédiat,
aucun redéploiement du site nécessaire. Les collections `users`, `teams`,
`teamMembers` et `licenses` redeviennent alors inaccessibles à tous — l'écran
d'administration affichera une erreur de lecture, sans rien casser d'autre.

---

## 3. Test bout en bout sur la vraie base

À faire **après** la publication des règles, **et après le déploiement de la
branche** (sans quoi l'écran « Accès team » n'existe pas en production).

Prévoir une adresse e-mail de test réelle — la vérification est exigée.

| # | Action | Où | Attendu |
|---|---|---|---|
| 1 | Créer le compte de test | menu → **Créer un compte** | « Compte créé. Vérifiez votre boîte e-mail. » |
| 2 | Ouvrir le lien reçu | boîte e-mail (**vérifier les indésirables**) | page Firebase « adresse vérifiée » |
| 3 | Revenir sur le site → **« J'ai vérifié »** | menu | bandeau orange disparu |
| 4 | Se **déconnecter**, se reconnecter en **régie** | menu | menu admin visible |
| 5 | Créer le team | `#access` → 1 · Team → **Créer** | le team apparaît dans le sélecteur |
| 6 | Rattacher le compte de test | 2 · Membres → choisir → **Rattacher** | ligne ajoutée avec son UID |
| 7 | Attribuer : fiche pilote réelle → **Championnat FFSA** → **Pass MEETING** → **Lohéac** | 3 · Licences | phrase de confirmation, puis ligne **active** |
| 8 | Se déconnecter, se connecter avec le compte de test | menu | — |
| 9 | Ouvrir **Stratégie Live**, choisir Lohéac FFSA | `#projection` | bandeau « Votre accès », **un seul pilote** proposé, analyse complète |
| 10 | Basculer sur **Lohéac Euro RX** | même écran | « Cette analyse n'est pas incluse… **un autre championnat ou un autre meeting** » |
| 11 | En régie (autre navigateur ou fenêtre privée) → **Suspendre** | `#access` | ligne passe en **suspendue** |
| 12 | Revenir sur l'onglet du compte de test **sans recharger** | `#projection` | l'accès se ferme **tout seul** — abonnement temps réel |
| 13 | **Réactiver** | `#access` | l'accès revient, toujours sans rechargement |
| 14 | Ménage : **Révoquer** la licence, **Retirer** le membre, supprimer le team | `#access` | — |
| 15 | Supprimer le compte de test | Console → Authentication → Users → ⋮ → Supprimer | — |

**L'étape 12 est celle qui compte.** C'est elle qui prouve qu'une révocation
est immédiate et non théorique — et c'est ce que tu montreras à un team qui
demande ce qui se passe s'il arrête de payer.

> Le document `users/{uid}` du compte supprimé reste en base. Sans
> conséquence : il ne donne aucun droit. Le supprimer à la main dans la
> console si tu tiens à une base propre.

---

## 4. Netlify — `netlify.toml`

Le fichier est prêt dans `docs/monetisation/proposed/netlify.toml`, **inactif**
tant qu'il n'est pas déplacé à la racine.

**Vérifié point par point le 2026-08-21 :**

| Contrôle | Résultat |
|---|---|
| `sw.js` — 71 chemins déclarés dans `ASSET_PATHS` | **aucun** sous `docs/`, `tests/`, `tools/` ni `overlay/demo/*.png` |
| Références depuis `index.html`, `js/`, `css/`, `manifest.json`, `overlay/*.html`, `overlay/_lib/` | **aucune** vers ces répertoires |
| Les 20 PNG de `overlay/demo/` | référencés par **aucun** fichier — ce sont des captures d'archive |
| `overlay/index.html` | six liens vers `demo/showcase.html` → **conservé**, d'où `overlay/demo/*.png` et non `overlay/demo` |
| OBS | `live.html`, `control.html`, `_lib/` hors périmètre — **les sources navigateur ne bougent pas** |

**Rien ne casse.** Gain : ~6,6 Mo de déploiement, et la méthode n'est plus
servie à côté du produit.

**Avant d'activer** : relever « Publish directory » dans l'interface Netlify
et le reporter dans `publish`. Un `netlify.toml` **prend le pas** sur les
réglages de l'interface.

**Pour activer** — en attente de ton feu vert :

```bash
git mv docs/monetisation/proposed/netlify.toml netlify.toml
```

**Rollback** : `git rm netlify.toml`, puis pousser. Netlify reprend les
réglages de l'interface au déploiement suivant.

Le fichier propose aussi, **en commentaire et non activé**, d'exclure
`firestore.rules`, `firebase.json`, `package.json` et les configurations
Vitest. Aucun n'est un secret, mais publier ses règles de sécurité à côté
d'un produit payant, c'est offrir la carte à qui cherche une faille. À toi
de voir.

---

## 5. Récapitulatif A0

### Ce qui est **réellement** sécurisé

Six garanties, portées par les règles Firestore et **testées à l'émulateur**.
Elles ne dépendent d'aucun code client et resteront vraies après le lot
backend.

| Garantie |
|---|
| Personne ne peut **créer, modifier ou prolonger** une licence |
| Personne ne peut **s'ajouter** à un team |
| Personne ne peut **lire les licences ou les membres** d'un autre team |
| Personne ne peut **se déclarer sous l'adresse d'un autre** |
| Une **session anonyme** (pronostics) n'obtient jamais rien |
| Un **compte non vérifié** n'obtient jamais rien |

S'y ajoute une invariance : le **périmètre d'une licence est immuable**, y
compris pour la régie. Réorienter une licence vers une autre personne ou un
autre championnat reviendrait à revendre le même droit sans trace.

### Ce qui reste **cosmétique**

| Ce qui n'est pas protégé | Pourquoi |
|---|---|
| Le filtre du sélecteur de pilote | du JavaScript sur la machine de l'utilisateur |
| L'usage réel du moteur, pour n'importe quel pilote | `js/projection/*` est servi publiquement et **préchargé par le service worker** ; les données sont publiques. `await import('/js/projection/liveStrategy.js')` dans la console suffit |

**A0 rend la relation commerciale réelle, pas la protection technique.**
Un team ne peut pas s'attribuer un accès — mais quelqu'un qui sait ce qu'il
fait peut se passer de l'accès. C'est le compromis validé, et il tient pour
un à trois teams que tu connais personnellement. **Il cesse de tenir à la
première vente à un inconnu.**

### Ce qui restera pour le lot backend / Stripe

| Lot | Contenu | Durée |
|---|---|---|
| **C — moteur serveur** | `functions/`, portage de `js/projection/*`, contrat JSON, `strategyContexts` + déclencheur, **retrait du moteur du site publié et du précache SW**, mode dégradé hors ligne | 5–8 j |
| **Migration Hosting** | `firebase.json` + `ignore`, GitHub Action, domaine | ½–1 j |
| **D — paiement** | `pricing`, `createCheckoutSession`, `stripeWebhook`, écran tarifs | 2–3 j |
| **Reprises** | allowlist e-mail → *custom claim* (~1 h) ; `origin: 'purchase'`, `pricePaidCents`, `paymentRef` **déjà prévus** au schéma | — |

**Environ 90 % de A0 survit tel quel.** La règle
`licenses.write: if isRegie()` ne change pas : le webhook écrira via l'Admin
SDK, hors règles. La fonction `canAnalysePerson()` se déplace **verbatim**
dans la Cloud Function.

### Rollback complet de A0

| Niveau | Geste | Effet |
|---|---|---|
| Règles | recoller `firestore.rules.avant-A0`, publier | immédiat |
| Site | `git revert` du merge, pousser | déploiement Netlify suivant |
| Netlify | `git rm netlify.toml` | déploiement suivant |
| Données | supprimer `users`, `teams`, `teamMembers`, `licenses` dans la console | aucune donnée métier touchée |

**Aucune donnée existante n'est modifiée par A0.** Quatre collections
ajoutées, un champ facultatif sur `persons`. Les collections métier —
`meetings`, `sessions`, `results`, `drivers`, `persons` — sont intactes.

### État des tests

| | |
|---|---|
| Unitaires | **942** — 27 fichiers |
| Règles Firestore, à l'émulateur | **58** |
| Vérification en navigateur réel | admin, team autorisé, team hors périmètre, visiteur sans compte |
| Non-régression | classements sans compte ✓ · pronostics anonymes ✓ · saisie régie ✓ · moteur Stratégie Live **non modifié** ✓ |

### Défauts trouvés et corrigés pendant A0

| Défaut | Découvert par |
|---|---|
| `accessAdmin.js` inchargeable (apostrophe sur-échappée) | capture d'écran — les 869 tests passaient |
| Règle `teamMembers` refusant la **requête** « mes teams » | capture d'écran, puis test de règle ajouté |
| Sélecteur de meeting masqué quand rien n'est autorisé | capture d'écran |
| `isRegie()` levant une erreur pour toute session sans e-mail | journaux de l'émulateur — **défaut pré-existant sur `main`** |
| Licence saison sans clé `meetingId` impossible à suspendre | journaux de l'émulateur |
| Jeton non rafraîchi après vérification d'e-mail | sondage de l'API Auth |
| POC vidéo cassant `npm test` à la racine | suite complète |

---

## Verdict

> ## **A0 : terminé — GO pour le merge**
>
> Sous **trois conditions**, dans cet ordre :
>
> 1. **Sauvegarder les règles actuelles** dans un fichier local avant de
>    publier les nouvelles (§2) ;
> 2. **Faire le test 4** — modifier un pilote en régie — juste après la
>    publication, et **pas la veille d'un meeting** ;
> 3. **Le test bout en bout du §3** avant de montrer quoi que ce soit à un
>    team.
>
> `netlify.toml` reste **hors du merge** : il s'active séparément, quand tu
> le décides.

Ce qui est livré est utilisable tel quel pour ce à quoi tu le destines :
dire à un team « je vous active l'accès pour votre pilote », et regarder
comment il s'en sert.
