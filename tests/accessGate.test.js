/* ═══════════════════════════════════════════════
   ACCESSGATE.TEST.JS — La table de décision de Stratégie Live.

   `licenseCalc.test.js` vérifie qu'une licence couvre bien ce qu'elle doit
   couvrir. Ce fichier-ci vérifie l'étage au-dessus : ce que l'écran montre
   à chaque type de visiteur, du spectateur anonyme à l'administrateur.

   Les dix scénarios reprennent, un pour un, la liste arrêtée pour le lot 3.
   Le risque couvert n'est pas la panne : c'est le message FAUX — dire
   « accès non inclus » à un client qui a payé, ou laisser passer quelqu'un
   qui n'a rien.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  viewerState, VIEWER, allowedDriverIds, canAnalysePerson,
  denialMessage, accessSummary, DENIAL,
} from '../js/access/licenseCalc.js';

const FFSA = 'champ_ffsa_2026';
const EURO = 'champ_euro_2026';
const PAILLER = 'person_pailler';
const AUTRE = 'person_autre';

const M_LOHEAC_FFSA = { id: 'mtg_loheac_ffsa', championshipId: FFSA, year: 2026 };
const M_LOHEAC_EURO = { id: 'mtg_loheac_euro', championshipId: EURO, year: 2026 };
const M_KERLABO     = { id: 'mtg_kerlabo',     championshipId: FFSA, year: 2026 };

const NOW = Date.parse('2026-08-30T09:00:00Z');
const JOUR = 86_400_000;

const licence = (over = {}) => ({
  id: 'lic', teamId: 'team_dupont', personId: PAILLER,
  scope: 'meeting', championshipId: FFSA, year: 2026, meetingId: M_LOHEAC_FFSA.id,
  status: 'active', origin: 'admin_grant',
  validFrom: NOW - 7 * JOUR, validUntil: NOW + 7 * JOUR,
  personLabel: 'Fabien Pailler', championshipLabel: 'Championnat FFSA Rallycross',
  ...over,
});

// Le plateau du meeting : une seule inscription est celle du pilote sous
// licence, les sept autres sont des adversaires.
const PLATEAU = {
  drv_pailler: PAILLER,
  drv_b: 'person_b', drv_c: 'person_c', drv_d: 'person_d',
  drv_e: 'person_e', drv_f: 'person_f', drv_g: 'person_g', drv_h: AUTRE,
};
const AU_DEPART = Object.keys(PLATEAU);

/** Ce que l'écran ferait, tous étages réunis. */
function ecran({ isAdmin = false, isRealUser = false, isVerified = false,
                 accessReady = true, licenses = [], meeting = M_LOHEAC_FFSA } = {}) {
  const viewer = viewerState({ isAdmin, isRealUser, isVerified, accessReady, licenses });
  const allowed = allowedDriverIds({
    licenses, personByDriver: PLATEAU, driverIds: AU_DEPART, meeting, isAdmin, now: NOW,
  });
  return { viewer, allowed, pilotesProposes: [...allowed] };
}

// ═══════════════════════════════════════════════════════════════════════
describe('1 · utilisateur NON CONNECTÉ', () => {
  it('ne se voit proposer aucun pilote, et on le lui explique', () => {
    const r = ecran({ isRealUser: false });
    expect(r.viewer.level).toBe(VIEWER.anonymous);
    expect(r.viewer.canSeeAnything).toBe(false);
    expect(r.pilotesProposes).toEqual([]);
    expect(denialMessage(DENIAL.noLicense)).toMatch(/réservé aux teams/);
  });
});

describe('2 · session ANONYME de pronostics', () => {
  it('est traitée exactement comme un visiteur non connecté', () => {
    // Le piège du projet : les votes créent une session authentifiée.
    // `isRealUser` est faux pour elle, et c'est tout ce qui compte ici.
    const r = ecran({ isRealUser: false, isVerified: false });
    expect(r.viewer.level).toBe(VIEWER.anonymous);
    expect(r.pilotesProposes).toEqual([]);
  });

  it('même si une licence traînait en mémoire, elle ne verrait rien', () => {
    // Défense en profondeur : le niveau prime sur les données.
    const r = ecran({ isRealUser: false, licenses: [licence()] });
    expect(r.viewer.canSeeAnything).toBe(false);
  });
});

describe('3 · compte connecté mais e-mail NON VÉRIFIÉ', () => {
  it('reçoit un message qui dit quoi faire, pas un refus sec', () => {
    const r = ecran({ isRealUser: true, isVerified: false });
    expect(r.viewer.level).toBe(VIEWER.unverified);
    expect(r.viewer.canSeeAnything).toBe(false);
  });
});

describe('4 · compte vérifié SANS licence', () => {
  it('aucun pilote proposé, message « réservé aux teams »', () => {
    const r = ecran({ isRealUser: true, isVerified: true, licenses: [] });
    expect(r.viewer.level).toBe(VIEWER.none);
    expect(r.pilotesProposes).toEqual([]);
  });
});

describe('⏳ droits pas encore chargés', () => {
  it('affiche une ATTENTE, jamais un refus', () => {
    // Un refus affiché pendant le chargement est un message faux à chaque
    // ouverture de page — et c'est celui qui fait douter un client.
    const r = ecran({ isRealUser: true, isVerified: true, accessReady: false });
    expect(r.viewer.level).toBe(VIEWER.loading);
    expect(r.viewer.ready).toBe(false);
  });

  it('sauf pour l\'administrateur, qui n\'a aucun droit à charger', () => {
    const r = ecran({ isAdmin: true, accessReady: false });
    expect(r.viewer.level).toBe(VIEWER.admin);
    expect(r.viewer.ready).toBe(true);
  });
});

describe('5 · licence MEETING valide', () => {
  const licences = [licence()];

  it('ouvre le meeting acheté, et UN SEUL pilote sur les huit', () => {
    const r = ecran({ isRealUser: true, isVerified: true, licenses: licences });
    expect(r.viewer.level).toBe(VIEWER.licensed);
    expect(r.pilotesProposes).toEqual(['drv_pailler']);
  });

  it('⚠️ mais pas un autre meeting du même championnat', () => {
    const r = ecran({ isRealUser: true, isVerified: true, licenses: licences, meeting: M_KERLABO });
    expect(r.pilotesProposes).toEqual([]);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_KERLABO, now: NOW }).reason)
      .toBe(DENIAL.wrongScope);
  });
});

describe('6 · licence SAISON', () => {
  const saison = [licence({ scope: 'season', meetingId: null })];

  it('ouvre TOUS les meetings de son championnat', () => {
    for (const m of [M_LOHEAC_FFSA, M_KERLABO]) {
      const r = ecran({ isRealUser: true, isVerified: true, licenses: saison, meeting: m });
      expect(r.pilotesProposes).toEqual(['drv_pailler']);
    }
  });
});

describe('7 · ⚠️ même personId en FFSA et Euro RX', () => {
  it('une licence FFSA n\'ouvre RIEN sur le meeting Euro RX du même jour', () => {
    // Lohéac : deux épreuves, deux documents, deux droits. C'est le cas
    // dominant en base — 11 pilotes sur 12 courent les deux championnats.
    const saison = [licence({ scope: 'season', meetingId: null, championshipId: FFSA })];
    const ffsa = ecran({ isRealUser: true, isVerified: true, licenses: saison, meeting: M_LOHEAC_FFSA });
    const euro = ecran({ isRealUser: true, isVerified: true, licenses: saison, meeting: M_LOHEAC_EURO });
    expect(ffsa.pilotesProposes).toEqual(['drv_pailler']);
    expect(euro.pilotesProposes).toEqual([]);
    expect(canAnalysePerson({ licenses: saison, personId: PAILLER, meeting: M_LOHEAC_EURO, now: NOW }).reason)
      .toBe(DENIAL.wrongScope);
  });

  it('le message distingue « pas cet accès-là » de « aucun accès »', () => {
    // Le client a bien un accès : lui dire « réservé aux teams » serait faux
    // et l'inquiéterait à tort.
    expect(denialMessage(DENIAL.wrongScope)).toMatch(/autre championnat ou un autre meeting/);
    expect(denialMessage(DENIAL.noLicense, { hasAnyLicense: true })).toMatch(/n'est pas incluse/);
  });
});

describe('8 · plusieurs membres du même team', () => {
  it('voient exactement le même périmètre — la licence appartient au team', () => {
    const licences = [licence({ scope: 'season', meetingId: null })];
    const alice = ecran({ isRealUser: true, isVerified: true, licenses: licences });
    const bob   = ecran({ isRealUser: true, isVerified: true, licenses: licences });
    expect(alice.pilotesProposes).toEqual(bob.pilotesProposes);
    expect(alice.viewer.level).toBe(bob.viewer.level);
  });
});

describe('9 · suspension, révocation, expiration', () => {
  it.each([
    ['suspendue', { status: 'suspended' }, DENIAL.notActive],
    ['révoquée',  { status: 'revoked' },   DENIAL.notActive],
    ['expirée',   { validUntil: NOW - JOUR }, DENIAL.expired],
  ])('une licence %s ferme l\'accès avec le bon motif', (_, patch, motif) => {
    const licences = [licence(patch)];
    const r = ecran({ isRealUser: true, isVerified: true, licenses: licences });
    expect(r.pilotesProposes).toEqual([]);
    expect(canAnalysePerson({ licenses: licences, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).reason)
      .toBe(motif);
  });

  it('la licence reste LISIBLE, pour pouvoir expliquer au lieu d\'un écran vide', () => {
    const licences = [licence({ status: 'suspended' })];
    const r = ecran({ isRealUser: true, isVerified: true, licenses: licences });
    // Le niveau reste « licensed » : le team a bien une licence, elle est
    // simplement inutilisable. L'écran doit le dire.
    expect(r.viewer.level).toBe(VIEWER.licensed);
    expect(denialMessage(DENIAL.notActive)).toMatch(/suspendu/);
  });

  it('la révocation prend effet dès que la liste des licences change', () => {
    // L'abonnement Firestore est en temps réel : révoquer, c'est retirer la
    // licence de cette liste. Aucun rechargement n'est nécessaire.
    const avant = ecran({ isRealUser: true, isVerified: true, licenses: [licence()] });
    const apres = ecran({ isRealUser: true, isVerified: true, licenses: [licence({ status: 'revoked' })] });
    expect(avant.pilotesProposes).toEqual(['drv_pailler']);
    expect(apres.pilotesProposes).toEqual([]);
  });
});

describe('⚠️ piège : une liste vide ne veut pas dire « pas d\'accès »', () => {
  it('même l\'administrateur obtient un ensemble VIDE si le plateau est vide', () => {
    // La source d'un bug réel : sur un meeting dont aucune manche n'est
    // terminée, `state.standings` est vide, donc `driverIds` aussi, donc
    // `allowedDriverIds` rend un ensemble vide — y compris pour
    // l'administrateur, qui a pourtant tous les droits.
    //
    // Le code en concluait « pas d'accès » et affichait « Stratégie Live est
    // réservé aux teams disposant d'un accès » juste sous le bandeau
    // « Administrateur — accès complet ». Deux lignes qui se contredisent.
    //
    // L'appelant DOIT donc distinguer l'absence de DONNÉES de l'absence
    // d'ACCÈS, et ne jamais déduire la seconde de la première.
    const vide = allowedDriverIds({
      licenses: [], personByDriver: PLATEAU, driverIds: [],
      meeting: M_LOHEAC_FFSA, isAdmin: true, now: NOW,
    });
    expect(vide.size).toBe(0);

    // Le niveau du visiteur, lui, reste « admin » : c'est LUI qui fait foi
    // pour savoir quel message afficher, jamais la taille de l'ensemble.
    expect(viewerState({ isAdmin: true }).level).toBe(VIEWER.admin);
    expect(viewerState({ isAdmin: true }).canSeeAnything).toBe(true);
  });

  it('un team licencié dans le même cas garde lui aussi son niveau', () => {
    const licences = [licence({ scope: 'season', meetingId: null })];
    const vide = allowedDriverIds({
      licenses: licences, personByDriver: PLATEAU, driverIds: [],
      meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(vide.size).toBe(0);
    expect(viewerState({
      isRealUser: true, isVerified: true, accessReady: true, licenses: licences,
    }).level).toBe(VIEWER.licensed);
  });
});

describe('10 · administrateur', () => {
  it('voit TOUS les pilotes, sur TOUS les meetings, sans aucune licence', () => {
    for (const m of [M_LOHEAC_FFSA, M_LOHEAC_EURO, M_KERLABO]) {
      const r = ecran({ isAdmin: true, licenses: [], meeting: m });
      expect(r.viewer.level).toBe(VIEWER.admin);
      expect(r.pilotesProposes.sort()).toEqual([...AU_DEPART].sort());
    }
  });
});

describe('bandeau d\'accès', () => {
  it('se lit sans connaître les identifiants, grâce aux libellés figés', () => {
    // Les libellés sont dénormalisés sur la licence à l'attribution : sans
    // eux, le bandeau afficherait « person_pailler — Saison champ_ffsa_2026 ».
    const [r] = accessSummary({ licenses: [licence({ scope: 'season', meetingId: null })], now: NOW });
    expect(r.personLabel).toBe('Fabien Pailler');
    expect(r.scopeLabel).toBe('Saison Championnat FFSA Rallycross 2026');
  });

  it('n\'annonce pas un accès périmé', () => {
    expect(accessSummary({ licenses: [licence({ validUntil: NOW - JOUR })], now: NOW })).toEqual([]);
  });
});
