/* ═══════════════════════════════════════════════
   FIRESTORE.RULES.TEST.JS — Ce que les règles protègent RÉELLEMENT.

   À ce stade du projet (plan A0), le moteur de calcul est encore servi au
   navigateur : le filtrage de l'interface est un confort, pas une barrière.
   Les règles Firestore sont donc la SEULE protection réelle. Un défaut ici
   n'est pas un bug d'affichage, c'est un droit commercial qu'on se fabrique.

   Deux niveaux sont vérifiés, et il ne faut pas les confondre :

     1. ACCÈS AUX DOCUMENTS — porté par les règles. Qui peut lire ou écrire
        quoi. C'est ce que ce fichier teste en priorité.

     2. PORTÉE COMMERCIALE — portée par js/access/licenseCalc.js. Les règles
        ne savent pas dire « cette licence FFSA ne couvre pas l'Euro RX » :
        elles ne connaissent ni le meeting consulté ni l'instant présent.
        La dernière section combine donc les deux : lecture RÉELLE depuis
        l'émulateur, puis décision par le module réel.

   Lancement :  npm run test:rules   (démarre l'émulateur, exécute, arrête)
═══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs,
} from 'firebase/firestore';
import { canAnalysePerson, DENIAL } from '../../js/access/licenseCalc.js';

// ── Décor ───────────────────────────────────────────────────────────────
const REGIE_EMAIL = 'maxime.theard@gmail.com';

const FFSA = 'champ_ffsa_2026';
const EURO = 'champ_euro_2026';

// Lohéac 2026-08-30 : DEUX meetings distincts, un par championnat.
const M_LOHEAC_FFSA = { id: 'mtg_loheac_ffsa', championshipId: FFSA, year: 2026 };
const M_LOHEAC_EURO = { id: 'mtg_loheac_euro', championshipId: EURO, year: 2026 };
const M_KERLABO     = { id: 'mtg_kerlabo',     championshipId: FFSA, year: 2026 };

const PAILLER = 'person_pailler';   // court en FFSA *et* en Euro RX
const AUTRE   = 'person_autre';

const TEAM_A = 'team_A';
const TEAM_B = 'team_B';

const ALICE = 'uid_alice';   // membre de TEAM_A
const BOB   = 'uid_bob';     // second membre de TEAM_A
const CAROL = 'uid_carol';   // membre de TEAM_B
const DIANE = 'uid_diane';   // compte vérifié, sans team
const ERIC  = 'uid_eric';    // compte non vérifié
const SPECT = 'uid_spect';   // spectateur, session ANONYME (pronostics)

let env;

// ── Contextes d'identité ────────────────────────────────────────────────
const anonyme       = () => env.unauthenticatedContext().firestore();
/** Session anonyme Firebase — celle que les pronostics créent déjà. */
const spectateur    = () => env.authenticatedContext(SPECT,
  { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const nonVerifie    = () => env.authenticatedContext(ERIC,
  { email: 'eric@team.fr', email_verified: false, firebase: { sign_in_provider: 'password' } }).firestore();
const verifie       = (uid, email) => env.authenticatedContext(uid,
  { email, email_verified: true, firebase: { sign_in_provider: 'password' } }).firestore();
const alice  = () => verifie(ALICE, 'alice@teama.fr');
const bob    = () => verifie(BOB,   'bob@teama.fr');
const carol  = () => verifie(CAROL, 'carol@teamb.fr');
const diane  = () => verifie(DIANE, 'diane@sansteam.fr');
const regie  = () => verifie('uid_regie', REGIE_EMAIL);

// ── Modèle de licence ───────────────────────────────────────────────────
const NOW = Date.now();
const JOUR = 86_400_000;
const licence = (over = {}) => ({
  teamId: TEAM_A, personId: PAILLER,
  scope: 'meeting', championshipId: FFSA, year: 2026, meetingId: M_LOHEAC_FFSA.id,
  status: 'active', origin: 'admin_grant',
  validFrom: NOW - 7 * JOUR, validUntil: NOW + 7 * JOUR,
  createdAt: NOW, createdBy: 'uid_regie',
  ...over,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rallycross-rules',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // Amorçage HORS RÈGLES : on installe l'état, on ne le teste pas ici.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'teams', TEAM_A), { name: 'Team A', createdAt: NOW });
    await setDoc(doc(db, 'teams', TEAM_B), { name: 'Team B', createdAt: NOW });
    await setDoc(doc(db, 'teamMembers', `${TEAM_A}_${ALICE}`), { teamId: TEAM_A, uid: ALICE, role: 'owner' });
    await setDoc(doc(db, 'teamMembers', `${TEAM_A}_${BOB}`),   { teamId: TEAM_A, uid: BOB,   role: 'member' });
    await setDoc(doc(db, 'teamMembers', `${TEAM_B}_${CAROL}`), { teamId: TEAM_B, uid: CAROL, role: 'owner' });
    await setDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa'), licence());
    await setDoc(doc(db, 'licenses', 'lic_B_autre'), licence({ teamId: TEAM_B, personId: AUTRE }));
    // Données publiques, pour vérifier la non-régression.
    await setDoc(doc(db, 'meetings', M_LOHEAC_FFSA.id), { ...M_LOHEAC_FFSA, date: '2026-08-30', location: 'Lohéac', categories: ['Supercar'], nbMQ: 4 });
    await setDoc(doc(db, 'persons', PAILLER), { firstName: 'Fabien', lastName: 'Pailler' });
    await setDoc(doc(db, 'drivers', 'drv_1'), { firstName: 'Fabien', lastName: 'Pailler', carNumber: 7, category: 'Supercar', year: 2026, personId: PAILLER });
    await setDoc(doc(db, 'results', 'res_1'), { sessionId: 's1', driverId: 'drv_1', sessionType: 'MQ', ms: 150000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 1 · L'APPLICATION PUBLIQUE NE DOIT RIEN PERDRE
// ═══════════════════════════════════════════════════════════════════════
describe('non-régression — le produit gratuit reste accessible sans compte', () => {
  it('un visiteur SANS COMPTE lit meetings, results, drivers, persons', async () => {
    const db = anonyme();
    await assertSucceeds(getDoc(doc(db, 'meetings', M_LOHEAC_FFSA.id)));
    await assertSucceeds(getDoc(doc(db, 'results', 'res_1')));
    await assertSucceeds(getDoc(doc(db, 'drivers', 'drv_1')));
    await assertSucceeds(getDoc(doc(db, 'persons', PAILLER)));
  });

  it('un visiteur sans compte ne peut toujours pas écrire', async () => {
    const db = anonyme();
    await assertFails(setDoc(doc(db, 'meetings', 'pirate'), { date: '2026-01-01', location: 'X', year: 2026, categories: ['a'], nbMQ: 4 }));
    await assertFails(deleteDoc(doc(db, 'results', 'res_1')));
  });

  it('la régie écrit toujours un pilote — le durcissement de personId ne bloque pas', async () => {
    const db = regie();
    await assertSucceeds(setDoc(doc(db, 'drivers', 'drv_2'), {
      firstName: 'Jean', lastName: 'Dupont', carNumber: 42,
      category: 'Supercar', year: 2026, personId: PAILLER,
    }));
  });

  it('en revanche une inscription SANS fiche pilote est désormais refusée', async () => {
    // Sans personId, l'inscription échapperait à toute vérification de licence.
    const db = regie();
    await assertFails(setDoc(doc(db, 'drivers', 'drv_3'), {
      firstName: 'Sans', lastName: 'Fiche', carNumber: 43,
      category: 'Supercar', year: 2026, personId: null,
    }));
    await assertFails(setDoc(doc(db, 'drivers', 'drv_4'), {
      firstName: 'Sans', lastName: 'Champ', carNumber: 44,
      category: 'Supercar', year: 2026,
    }));
  });

  it('la régie peut marquer une fiche à vérifier, mais pas inventer un marquage', async () => {
    const db = regie();
    await assertSucceeds(setDoc(doc(db, 'persons', 'p_new'), {
      firstName: 'Michael', lastName: 'Leonard', reviewFlag: 'duplicate_candidate',
    }));
    await assertSucceeds(setDoc(doc(db, 'persons', 'p_new2'), { firstName: 'A', lastName: 'B' }));
    await assertFails(setDoc(doc(db, 'persons', 'p_bad'), {
      firstName: 'A', lastName: 'B', reviewFlag: 'a_fusionner',
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2 · QUI EST QUI — l'anonyme des pronostics n'est pas un client
// ═══════════════════════════════════════════════════════════════════════
describe('identité — request.auth != null ne suffit jamais', () => {
  it('1 · un utilisateur NON CONNECTÉ ne voit aucune licence, aucun team', async () => {
    const db = anonyme();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertFails(getDoc(doc(db, 'teams', TEAM_A)));
    await assertFails(getDoc(doc(db, 'teamMembers', `${TEAM_A}_${ALICE}`)));
  });

  it('2 · ⚠️ une session ANONYME de pronostics n\'obtient rien', async () => {
    // Le piège du projet : les votes de pronostics créent une session
    // authentifiée. Si les règles se contentaient de `request.auth != null`,
    // tout spectateur ayant voté deviendrait client.
    const db = spectateur();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertFails(getDoc(doc(db, 'teams', TEAM_A)));
    await assertFails(setDoc(doc(db, 'users', SPECT), { email: 'x@x.fr', createdAt: NOW }));
  });

  it('2b · mais elle continue de voter aux pronostics', async () => {
    // Non-régression : le durcissement ne doit pas casser le jeu existant.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'pronostics', 'p1'), { status: 'open' });
    });
    const db = spectateur();
    await assertSucceeds(setDoc(doc(db, 'pronostics', 'p1', 'votes', SPECT), {
      driverId: 'drv_1', at: NOW,
    }));
  });

  it('3 · un compte connecté mais e-mail NON VÉRIFIÉ n\'accède à aucune licence', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'teamMembers', `${TEAM_A}_${ERIC}`), {
        teamId: TEAM_A, uid: ERIC, role: 'member',
      });
    });
    // Éric est pourtant bien membre du team.
    const db = nonVerifie();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertFails(getDoc(doc(db, 'teams', TEAM_A)));
  });

  it('3b · … mais il peut créer son compte, sinon l\'admin ne le trouverait jamais', async () => {
    const db = nonVerifie();
    await assertSucceeds(setDoc(doc(db, 'users', ERIC), {
      email: 'eric@team.fr', displayName: 'Éric', createdAt: NOW,
    }));
  });

  it('4 · un compte vérifié SANS TEAM ne voit aucune licence', async () => {
    const db = diane();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertFails(getDoc(doc(db, 'teams', TEAM_A)));
  });

  it('⚠️ un jeton SANS claim e-mail refuse proprement, sans erreur d\'évaluation', async () => {
    // Régression trouvée dans isRegie(), qui existait déjà sur main : lire
    // `request.auth.token.email` sur un jeton qui n'en porte pas lève une
    // ERREUR d'évaluation, et une erreur dans un membre de `||` interrompt
    // toute l'expression au lieu de passer au membre suivant. Le refus
    // restait juste, mais accidentel — et il masquait le vrai motif dans
    // les journaux. Un jeton custom sans e-mail reproduit exactement ce cas.
    const db = env.authenticatedContext('uid_sans_email', {
      firebase: { sign_in_provider: 'custom' },
    }).firestore();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertFails(setDoc(doc(db, 'licenses', 'lic_z'), licence()));
    // Et il ne devient évidemment pas régie par absence d'adresse.
    await assertFails(setDoc(doc(db, 'teams', 'team_pirate'), { name: 'X', createdAt: NOW }));
  });

  it('⚠️ un jeton sans claim email_verified est traité comme non vérifié', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'teamMembers', `${TEAM_A}_uid_muet`), {
        teamId: TEAM_A, uid: 'uid_muet', role: 'member',
      });
    });
    const db = env.authenticatedContext('uid_muet', {
      email: 'muet@team.fr', firebase: { sign_in_provider: 'password' },
    }).firestore();
    await assertFails(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3 · COMPTES
// ═══════════════════════════════════════════════════════════════════════
describe('comptes — on ne se déclare pas sous l\'adresse d\'un autre', () => {
  it('chacun crée son propre document, avec l\'adresse de son jeton', async () => {
    await assertSucceeds(setDoc(doc(alice(), 'users', ALICE), {
      email: 'alice@teama.fr', displayName: 'Alice', createdAt: NOW,
    }));
  });

  it('⚠️ déclarer une AUTRE adresse que celle du jeton est refusé', async () => {
    // Sinon l'écran d'administration affiche une adresse qui n'est pas la
    // bonne, et le rattachement au team se fait sur la mauvaise personne.
    await assertFails(setDoc(doc(alice(), 'users', ALICE), {
      email: REGIE_EMAIL, displayName: 'Alice', createdAt: NOW,
    }));
  });

  it('⚠️ créer le document d\'un AUTRE compte est refusé', async () => {
    await assertFails(setDoc(doc(alice(), 'users', BOB), {
      email: 'bob@teama.fr', createdAt: NOW,
    }));
  });

  it('un champ non prévu est refusé — pas d\'auto-promotion par champ libre', async () => {
    await assertFails(setDoc(doc(alice(), 'users', ALICE), {
      email: 'alice@teama.fr', createdAt: NOW, role: 'admin',
    }));
    await assertFails(setDoc(doc(alice(), 'users', ALICE), {
      email: 'alice@teama.fr', createdAt: NOW, teamId: TEAM_A,
    }));
  });

  it('l\'adresse est immuable après création', async () => {
    await assertSucceeds(setDoc(doc(alice(), 'users', ALICE), {
      email: 'alice@teama.fr', displayName: 'Alice', createdAt: NOW,
    }));
    await assertSucceeds(updateDoc(doc(alice(), 'users', ALICE), { displayName: 'Alice B.' }));
    await assertFails(updateDoc(doc(alice(), 'users', ALICE), { email: 'autre@x.fr' }));
  });

  it('personne ne lit le compte d\'un autre — la régie, oui', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', BOB), { email: 'bob@teama.fr', createdAt: NOW });
    });
    await assertFails(getDoc(doc(alice(), 'users', BOB)));
    await assertSucceeds(getDoc(doc(bob(), 'users', BOB)));
    await assertSucceeds(getDoc(doc(regie(), 'users', BOB)));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4 · TEAMS ET MEMBRES
// ═══════════════════════════════════════════════════════════════════════
describe('teams — on ne s\'invite pas soi-même', () => {
  it('10 · plusieurs membres du même team lisent le team et ses licences', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'teams', TEAM_A)));
    await assertSucceeds(getDoc(doc(bob(),   'teams', TEAM_A)));
    await assertSucceeds(getDoc(doc(alice(), 'licenses', 'lic_A_loheac_ffsa')));
    await assertSucceeds(getDoc(doc(bob(),   'licenses', 'lic_A_loheac_ffsa')));
  });

  it('un membre voit ses coéquipiers, pas ceux d\'un autre team', async () => {
    await assertSucceeds(getDoc(doc(alice(), 'teamMembers', `${TEAM_A}_${BOB}`)));
    await assertFails(getDoc(doc(alice(), 'teamMembers', `${TEAM_B}_${CAROL}`)));
  });

  it('⚠️ un membre RETROUVE ses teams par requête — c\'est le premier appel de l\'application', async () => {
    // Trou de couverture réel : les tests ne vérifiaient que la lecture d'un
    // document PAR SON IDENTIFIANT, jamais la REQUÊTE que fait vraiment
    // l'application au démarrage. Or Firestore n'évalue pas une requête comme
    // une lecture unitaire — une règle qui marche sur `get` peut échouer sur
    // `list`. Résultat observé dans le navigateur : teamIds vide, aucune
    // licence, et un « accès non inclus » affiché à un client qui payait.
    const snap = await assertSucceeds(
      getDocs(query(collection(alice(), 'teamMembers'), where('uid', '==', ALICE))),
    );
    expect(snap.docs.map(d => d.data().teamId)).toEqual([TEAM_A]);
  });

  it('⚠️ … mais il ne peut pas lister les appartenances de quelqu\'un d\'autre', async () => {
    await assertFails(getDocs(query(collection(alice(), 'teamMembers'), where('uid', '==', CAROL))));
    await assertFails(getDocs(collection(alice(), 'teamMembers')));
  });

  it('13 · ⚠️ s\'ajouter soi-même à un team est refusé', async () => {
    await assertFails(setDoc(doc(diane(), 'teamMembers', `${TEAM_A}_${DIANE}`), {
      teamId: TEAM_A, uid: DIANE, role: 'member',
    }));
    // Même en se déclarant propriétaire.
    await assertFails(setDoc(doc(diane(), 'teamMembers', `${TEAM_A}_${DIANE}`), {
      teamId: TEAM_A, uid: DIANE, role: 'owner',
    }));
  });

  it('⚠️ un membre ne peut pas non plus ajouter quelqu\'un à son propre team', async () => {
    await assertFails(setDoc(doc(alice(), 'teamMembers', `${TEAM_A}_${DIANE}`), {
      teamId: TEAM_A, uid: DIANE, role: 'member',
    }));
  });

  it('14 · ⚠️ lire le team ou les licences d\'un AUTRE team est refusé', async () => {
    await assertFails(getDoc(doc(alice(), 'teams', TEAM_B)));
    await assertFails(getDoc(doc(alice(), 'licenses', 'lic_B_autre')));
    await assertFails(getDoc(doc(carol(), 'licenses', 'lic_A_loheac_ffsa')));
  });

  it('une requête non contrainte sur licenses est refusée, contrainte elle passe', async () => {
    const db = alice();
    await assertFails(getDocs(collection(db, 'licenses')));
    await assertFails(getDocs(query(collection(db, 'licenses'), where('teamId', '==', TEAM_B))));
    await assertSucceeds(getDocs(query(collection(db, 'licenses'), where('teamId', '==', TEAM_A))));
  });

  it('personne ne crée ni ne renomme un team — la régie, oui', async () => {
    await assertFails(setDoc(doc(alice(), 'teams', 'team_pirate'), { name: 'Pirate', createdAt: NOW }));
    await assertFails(updateDoc(doc(alice(), 'teams', TEAM_A), { name: 'Renommé' }));
    await assertSucceeds(setDoc(doc(regie(), 'teams', 'team_C'), { name: 'Team C', createdAt: NOW }));
  });

  it('l\'identifiant de membre doit être déterministe — anti-doublon', async () => {
    const db = regie();
    await assertFails(setDoc(doc(db, 'teamMembers', 'identifiant_libre'), {
      teamId: TEAM_A, uid: DIANE, role: 'member',
    }));
    await assertSucceeds(setDoc(doc(db, 'teamMembers', `${TEAM_A}_${DIANE}`), {
      teamId: TEAM_A, uid: DIANE, role: 'member',
    }));
  });

  it('un rôle inconnu est refusé', async () => {
    await assertFails(setDoc(doc(regie(), 'teamMembers', `${TEAM_A}_${DIANE}`), {
      teamId: TEAM_A, uid: DIANE, role: 'administrateur',
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5 · LICENCES — LA RÈGLE QUI PORTE TOUT
// ═══════════════════════════════════════════════════════════════════════
describe('licences — personne ne s\'en fabrique une', () => {
  it('12 · ⚠️ un utilisateur normal ne peut ni créer, ni modifier, ni supprimer', async () => {
    const db = alice();
    await assertFails(setDoc(doc(db, 'licenses', 'lic_pirate'), licence()));
    await assertFails(updateDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa'), { status: 'active' }));
    await assertFails(updateDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa'), { validUntil: NOW + 3650 * JOUR }));
    await assertFails(deleteDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
  });

  it('⚠️ … ni s\'en offrir une pour un autre pilote ou un autre championnat', async () => {
    const db = alice();
    await assertFails(setDoc(doc(db, 'licenses', 'lic_pirate2'),
      licence({ personId: AUTRE, scope: 'season', meetingId: null })));
    await assertFails(setDoc(doc(db, 'licenses', 'lic_pirate3'),
      licence({ championshipId: EURO, meetingId: M_LOHEAC_EURO.id })));
  });

  it('⚠️ ni réactiver une licence révoquée', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'licenses', 'lic_revoquee'), licence({ status: 'revoked' }));
    });
    await assertFails(updateDoc(doc(alice(), 'licenses', 'lic_revoquee'), { status: 'active' }));
    await assertSucceeds(updateDoc(doc(regie(), 'licenses', 'lic_revoquee'), { status: 'active' }));
  });

  it('15 · la régie crée, suspend, révoque et supprime', async () => {
    const db = regie();
    await assertSucceeds(setDoc(doc(db, 'licenses', 'lic_new'), licence({ teamId: TEAM_B })));
    await assertSucceeds(updateDoc(doc(db, 'licenses', 'lic_new'), { status: 'suspended' }));
    await assertSucceeds(updateDoc(doc(db, 'licenses', 'lic_new'), { status: 'revoked', revokedAt: NOW }));
    await assertSucceeds(deleteDoc(doc(db, 'licenses', 'lic_new')));
  });

  it('15b · la régie lit toutes les licences, sans appartenir à aucun team', async () => {
    const db = regie();
    await assertSucceeds(getDoc(doc(db, 'licenses', 'lic_A_loheac_ffsa')));
    await assertSucceeds(getDoc(doc(db, 'licenses', 'lic_B_autre')));
    await assertSucceeds(getDocs(collection(db, 'licenses')));
  });
});

describe('licences — deny by default sur la forme', () => {
  const refuse = (over) => assertFails(setDoc(doc(regie(), 'licenses', 'lic_x'), licence(over)));

  it('un statut inconnu est refusé', async () => {
    await refuse({ status: 'actif' });
    await refuse({ status: 'ACTIVE' });
    await refuse({ status: null });
  });

  it('une portée inconnue est refusée', async () => {
    await refuse({ scope: 'weekend' });
    await refuse({ scope: 'championship' });
    await refuse({ scope: null });
  });

  it('une origine inconnue est refusée', async () => {
    await refuse({ origin: 'cadeau' });
  });

  it('un champ obligatoire absent est refusé', async () => {
    for (const champ of ['teamId', 'personId', 'scope', 'championshipId', 'year', 'status', 'origin']) {
      const l = licence();
      delete l[champ];
      await assertFails(setDoc(doc(regie(), 'licenses', `lic_sans_${champ}`), l));
    }
  });

  it('un champ obligatoire vide est refusé', async () => {
    await refuse({ teamId: '' });
    await refuse({ personId: '' });
    await refuse({ championshipId: '' });
  });

  it('une année hors bornes est refusée', async () => {
    await refuse({ year: 2019 });
    await refuse({ year: 2031 });
    await refuse({ year: '2026' });
  });

  it('⚠️ un PASS MEETING sans meetingId est refusé', async () => {
    // Sans identifiant de meeting, la portée « meeting » n'aurait aucune
    // borne : le contrôle côté client la refuserait, mais une licence
    // incohérente n'a pas à exister en base.
    await refuse({ scope: 'meeting', meetingId: null });
    const l = licence(); delete l.meetingId;
    await assertFails(setDoc(doc(regie(), 'licenses', 'lic_y'), l));
  });

  it('⚠️ un PASS SAISON avec un meetingId est refusé', async () => {
    await refuse({ scope: 'season', meetingId: M_LOHEAC_FFSA.id });
  });

  it('un PASS SAISON bien formé passe', async () => {
    await assertSucceeds(setDoc(doc(regie(), 'licenses', 'lic_saison'),
      licence({ scope: 'season', meetingId: null })));
  });

  it('⚠️ un PASS SAISON sans la CLÉ meetingId passe, et reste modifiable', async () => {
    // Régression trouvée pendant l'écriture de ces règles : lire une
    // propriété ABSENTE en langage de règles lève une erreur d'évaluation,
    // pas null. La comparaison d'immuabilité échouait donc sur une licence
    // saison créée sans la clé — l'administrateur ne pouvait plus la
    // suspendre. Le refus était accidentel, pas voulu.
    const db = regie();
    const l = licence({ scope: 'season' });
    delete l.meetingId;
    await assertSucceeds(setDoc(doc(db, 'licenses', 'lic_saison_sans_cle'), l));
    await assertSucceeds(updateDoc(doc(db, 'licenses', 'lic_saison_sans_cle'), { status: 'suspended' }));
    await assertSucceeds(updateDoc(doc(db, 'licenses', 'lic_saison_sans_cle'), { status: 'revoked', revokedAt: NOW }));
  });

  it('⚠️ … mais on ne peut toujours pas lui greffer un meeting après coup', async () => {
    const db = regie();
    const l = licence({ scope: 'season' });
    delete l.meetingId;
    await assertSucceeds(setDoc(doc(db, 'licenses', 'lic_saison_sans_cle2'), l));
    await assertFails(updateDoc(doc(db, 'licenses', 'lic_saison_sans_cle2'), { meetingId: M_LOHEAC_FFSA.id }));
  });
});

describe('licences — le périmètre est immuable', () => {
  it('⚠️ réorienter une licence vers une autre personne est refusé, même pour la régie', async () => {
    // Reorienter, ce serait revendre le même droit sans laisser de trace.
    // Pour changer de périmètre : révoquer, puis recréer.
    await assertFails(updateDoc(doc(regie(), 'licenses', 'lic_A_loheac_ffsa'), { personId: AUTRE }));
  });

  it('⚠️ changer de championnat, d\'année, de meeting, de portée ou de team est refusé', async () => {
    const db = regie();
    const ref = doc(db, 'licenses', 'lic_A_loheac_ffsa');
    await assertFails(updateDoc(ref, { championshipId: EURO }));
    await assertFails(updateDoc(ref, { year: 2027 }));
    await assertFails(updateDoc(ref, { meetingId: M_KERLABO.id }));
    await assertFails(updateDoc(ref, { scope: 'season' }));
    await assertFails(updateDoc(ref, { teamId: TEAM_B }));
  });

  it('en revanche statut, validité et note restent modifiables', async () => {
    const db = regie();
    const ref = doc(db, 'licenses', 'lic_A_loheac_ffsa');
    await assertSucceeds(updateDoc(ref, { status: 'suspended' }));
    await assertSucceeds(updateDoc(ref, { validUntil: NOW + 30 * JOUR }));
    await assertSucceeds(updateDoc(ref, { note: 'démo Lohéac' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6 · BOUT EN BOUT — règles + module de décision
//
//   Les règles disent QUELLES licences ce compte peut lire.
//   licenseCalc dit CE QUE ces licences autorisent.
//   Ni l'un ni l'autre ne suffit : on vérifie ici la chaîne complète, avec
//   des lectures RÉELLES depuis l'émulateur.
// ═══════════════════════════════════════════════════════════════════════
describe('bout en bout — ce qu\'un compte peut réellement analyser', () => {
  /** Lit, comme le ferait l'application, les licences visibles par ce compte. */
  async function mesLicences(db, teamIds) {
    const snap = await getDocs(query(collection(db, 'licenses'), where('teamId', 'in', teamIds)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  it('5 · membre d\'un team SANS licence → aucun accès', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'licenses', 'lic_A_loheac_ffsa'));
    });
    const licences = await mesLicences(alice(), [TEAM_A]);
    expect(licences).toHaveLength(0);
    const d = canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DENIAL.noLicense);
  });

  it('6 · licence MEETING valide → accès sur ce meeting', async () => {
    const licences = await mesLicences(alice(), [TEAM_A]);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(true);
  });

  it('7 · ⚠️ même pilote, autre meeting du même championnat → refusé', async () => {
    const licences = await mesLicences(alice(), [TEAM_A]);
    const d = canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_KERLABO, now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DENIAL.wrongScope);
  });

  it('8 · licence SAISON → tous les meetings de SON championnat', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'licenses', 'lic_A_saison_ffsa'),
        licence({ scope: 'season', meetingId: null }));
    });
    const licences = await mesLicences(alice(), [TEAM_A]);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(true);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_KERLABO,     now: NOW }).allowed).toBe(true);
  });

  it('9 · ⚠️ même personId en FFSA et Euro RX, licence sur un seul championnat', async () => {
    // Le cas dominant en base : 11 pilotes sur 12 courent les deux
    // championnats. Une licence FFSA ne doit RIEN ouvrir côté Euro RX, y
    // compris à Lohéac où les deux épreuves ont lieu le même week-end.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'licenses', 'lic_A_saison_ffsa'),
        licence({ scope: 'season', meetingId: null, championshipId: FFSA }));
    });
    const licences = await mesLicences(alice(), [TEAM_A]);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(true);
    const euro = canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_EURO, now: NOW });
    expect(euro.allowed).toBe(false);
    expect(euro.reason).toBe(DENIAL.wrongScope);
  });

  it('10 · les deux membres du team ont exactement le même accès', async () => {
    const [la, lb] = await Promise.all([mesLicences(alice(), [TEAM_A]), mesLicences(bob(), [TEAM_A])]);
    expect(la.map(l => l.id).sort()).toEqual(lb.map(l => l.id).sort());
    expect(canAnalysePerson({ licenses: lb, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(true);
  });

  it('11 · licence suspendue puis révoquée → refusée, mais toujours lisible', async () => {
    // Lisible volontairement : l'interface doit pouvoir dire POURQUOI
    // l'accès ne fonctionne plus, au lieu d'afficher un écran vide.
    for (const statut of ['suspended', 'revoked']) {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'licenses', 'lic_A_loheac_ffsa'), { status: statut });
      });
      const licences = await mesLicences(alice(), [TEAM_A]);
      expect(licences).toHaveLength(1);
      const d = canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe(DENIAL.notActive);
    }
  });

  it('11b · licence expirée → refusée avec le bon motif', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'licenses', 'lic_A_loheac_ffsa'), { validUntil: NOW - JOUR });
    });
    const licences = await mesLicences(alice(), [TEAM_A]);
    const d = canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DENIAL.expired);
  });

  it('⚠️ le team B ne voit rien du team A, donc n\'analyse pas son pilote', async () => {
    const licences = await mesLicences(carol(), [TEAM_B]);
    expect(licences.map(l => l.id)).toEqual(['lic_B_autre']);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(false);
  });
});
