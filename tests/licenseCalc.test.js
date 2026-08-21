/* ═══════════════════════════════════════════════
   LICENSECALC.TEST.JS — La règle d'accès commercial ne doit jamais ouvrir
   plus large que ce qui a été vendu.

   Le risque ici n'est pas un plantage : c'est un accès accordé par erreur,
   qui ne se voit pas. Un team paie l'accès à son pilote pour le Championnat
   de France ; si la règle raisonne sur la seule fiche pilote, ce même team
   obtient gratuitement l'Euro RX du même pilote. Personne ne s'en plaindra
   — et c'est exactement pour ça qu'il faut le tester.

   Le cas n'a rien de théorique : l'audit du 2026-08-21 montre que 11 des 12
   pilotes à inscriptions multiples courent DANS LES DEUX championnats
   (docs/monetisation/AUDITS-ET-PLANS.md §2.3). Et Lohéac 2026-08-30 existe
   en deux meetings distincts, un par championnat.

   Les données de test reprennent donc des cas réels de la base plutôt que
   des identifiants inventés : ce qui est vérifié est ce qui existe.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  toMillis, licenseValidity, licenseCoversMeeting,
  canAnalysePerson, canAnalyseDriver, allowedDriverIds,
  denialMessage, scopeLabel, accessSummary, DENIAL,
} from '../js/access/licenseCalc.js';

// ── Décor, tiré de la base réelle ──────────────────────────────────────
const FFSA  = 'champ_1775737455330';   // Championnat FFSA Rallycross 2026 — 7 meetings
const EURO  = 'champ_1775771412329';   // Euro RX 2026 — 5 meetings

// Fabien Pailler : une personne, deux inscriptions, deux championnats.
const PAILLER = '78H4Kub2KJ1mqVZy3T8G';
const DRV_PAILLER_FFSA = 'drv_pailler_supercar_7';
const DRV_PAILLER_EURO = 'drv_pailler_rx1_29';

// Adrien Le Quere : deux inscriptions dans le MÊME championnat.
const LEQUERE = 'PM517ZYCW9lLMy3A8nHd';
const DRV_LEQUERE_D3  = 'drv_lequere_d3_313';
const DRV_LEQUERE_SUP = 'drv_lequere_supercar_98';

const AUTRE_PERSONNE = 'personne_sans_licence';
const DRV_AUTRE = 'drv_autre_42';

// Lohéac, le même jour, dans les deux championnats. Deux documents.
const M_LOHEAC_FFSA = { id: 'mtg_loheac_ffsa', championshipId: FFSA, year: 2026 };
const M_LOHEAC_EURO = { id: 'mtg_loheac_euro', championshipId: EURO, year: 2026 };
const M_KERLABO     = { id: 'mtg_kerlabo',     championshipId: FFSA, year: 2026 };
const M_HOLJES      = { id: 'mtg_holjes',      championshipId: EURO, year: 2026 };
const M_LOHEAC_2027 = { id: 'mtg_loheac_2027', championshipId: FFSA, year: 2027 };

const NOW = Date.parse('2026-08-30T09:00:00Z');
const JOUR = 86_400_000;

/** Licence active par défaut : on ne surcharge que ce que le test étudie. */
const licence = (over = {}) => ({
  id: 'lic_1', teamId: 'team_A', personId: PAILLER,
  scope: 'meeting', championshipId: FFSA, year: 2026, meetingId: M_LOHEAC_FFSA.id,
  status: 'active', origin: 'admin_grant',
  validFrom: NOW - 7 * JOUR, validUntil: NOW + 7 * JOUR,
  ...over,
});

const PERSON_BY_DRIVER = {
  [DRV_PAILLER_FFSA]: PAILLER,
  [DRV_PAILLER_EURO]: PAILLER,
  [DRV_LEQUERE_D3]:   LEQUERE,
  [DRV_LEQUERE_SUP]:  LEQUERE,
  [DRV_AUTRE]:        AUTRE_PERSONNE,
};

// ═══════════════════════════════════════════════════════════════════════
describe('toMillis — une date reste la même quelle que soit sa provenance', () => {
  it('accepte les quatre formes que Firestore et les tests produisent', () => {
    const ref = Date.parse('2026-08-30T09:00:00Z');
    expect(toMillis(ref)).toBe(ref);
    expect(toMillis(new Date(ref))).toBe(ref);
    expect(toMillis('2026-08-30T09:00:00Z')).toBe(ref);
    expect(toMillis({ toMillis: () => ref })).toBe(ref);
    expect(toMillis({ seconds: ref / 1000, nanoseconds: 0 })).toBe(ref);
  });

  it('rend null plutôt qu\'un NaN silencieux sur une valeur illisible', () => {
    // Un NaN se propagerait en comparaison toujours fausse, donc en accès
    // refusé sans explication. Mieux vaut une absence franche.
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('pas une date')).toBeNull();
    expect(toMillis(NaN)).toBeNull();
    expect(toMillis({})).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('validité dans le temps', () => {
  it('une licence active et dans sa fenêtre est valide', () => {
    expect(licenseValidity(licence(), NOW).ok).toBe(true);
  });

  it('sans échéance, une licence reste valide indéfiniment', () => {
    // Cas d'une licence saison : une échéance mal saisie ne doit pas
    // couper l'accès au milieu du championnat.
    const l = licence({ validUntil: null });
    expect(licenseValidity(l, NOW + 3650 * JOUR).ok).toBe(true);
  });

  it('sans date de début, une licence marche immédiatement', () => {
    // Attribution en bord de piste : l'admin ne doit pas avoir à penser
    // à l'horodatage pour que le team puisse s'en servir tout de suite.
    expect(licenseValidity(licence({ validFrom: null }), NOW).ok).toBe(true);
  });

  it('une licence expirée est refusée, avec le motif exact', () => {
    const r = licenseValidity(licence({ validUntil: NOW - JOUR }), NOW);
    expect(r).toEqual({ ok: false, reason: DENIAL.expired });
  });

  it('une licence pas encore ouverte est refusée', () => {
    const r = licenseValidity(licence({ validFrom: NOW + JOUR }), NOW);
    expect(r).toEqual({ ok: false, reason: DENIAL.notYetValid });
  });

  it('révocation et suspension ferment l\'accès', () => {
    expect(licenseValidity(licence({ status: 'revoked' }), NOW).reason).toBe(DENIAL.notActive);
    expect(licenseValidity(licence({ status: 'suspended' }), NOW).reason).toBe(DENIAL.notActive);
  });

  it('un statut inconnu ferme l\'accès au lieu de l\'ouvrir', () => {
    // Échouer fermé : une valeur inattendue en base ne doit jamais se
    // traduire par un accès accordé.
    expect(licenseValidity(licence({ status: 'actif' }), NOW).ok).toBe(false);
    expect(licenseValidity(licence({ status: undefined }), NOW).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('périmètre — c\'est le championnat qui définit ce qui a été acheté', () => {
  it('PASS MEETING : ouvre le meeting acheté', () => {
    expect(licenseCoversMeeting(licence(), M_LOHEAC_FFSA).ok).toBe(true);
  });

  it('PASS MEETING : n\'ouvre PAS un autre meeting du même championnat', () => {
    const r = licenseCoversMeeting(licence(), M_KERLABO);
    expect(r).toEqual({ ok: false, reason: DENIAL.wrongScope });
  });

  it('⚠️ Lohéac FFSA et Lohéac Euro RX sont deux droits distincts', () => {
    // Même date, même circuit, deux documents `meetings`. Une licence
    // achetée pour l'un ne donne rien sur l'autre.
    const l = licence({ meetingId: M_LOHEAC_FFSA.id, championshipId: FFSA });
    expect(licenseCoversMeeting(l, M_LOHEAC_FFSA).ok).toBe(true);
    expect(licenseCoversMeeting(l, M_LOHEAC_EURO).ok).toBe(false);
  });

  it('PASS SAISON : ouvre TOUS les meetings de son championnat', () => {
    const l = licence({ scope: 'season', meetingId: null, championshipId: FFSA });
    expect(licenseCoversMeeting(l, M_LOHEAC_FFSA).ok).toBe(true);
    expect(licenseCoversMeeting(l, M_KERLABO).ok).toBe(true);
  });

  it('⚠️ PASS SAISON FFSA n\'ouvre AUCUN meeting Euro RX', () => {
    // Le cœur du modèle. Sans cette barrière, 11 pilotes sur 12 offriraient
    // gratuitement leur seconde saison.
    const l = licence({ scope: 'season', meetingId: null, championshipId: FFSA });
    expect(licenseCoversMeeting(l, M_LOHEAC_EURO).ok).toBe(false);
    expect(licenseCoversMeeting(l, M_HOLJES).ok).toBe(false);
  });

  it('PASS SAISON : ne déborde pas sur l\'année suivante', () => {
    const l = licence({ scope: 'season', meetingId: null, year: 2026 });
    expect(licenseCoversMeeting(l, M_LOHEAC_2027).ok).toBe(false);
  });

  it('une portée inconnue refuse, et un meetingId manquant ne vaut pas joker', () => {
    expect(licenseCoversMeeting(licence({ scope: 'weekend' }), M_LOHEAC_FFSA).ok).toBe(false);
    expect(licenseCoversMeeting(licence({ meetingId: null }), M_LOHEAC_FFSA).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('décision par fiche pilote', () => {
  it('sans aucune licence, l\'accès est refusé', () => {
    const r = canAnalysePerson({ licenses: [], personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(DENIAL.noLicense);
  });

  it('une licence pour un AUTRE pilote n\'ouvre rien', () => {
    const r = canAnalysePerson({
      licenses: [licence()], personId: AUTRE_PERSONNE, meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(r.allowed).toBe(false);
  });

  it('la bonne licence sur le bon meeting ouvre l\'accès et est renvoyée', () => {
    const l = licence();
    const r = canAnalysePerson({ licenses: [l], personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW });
    expect(r.allowed).toBe(true);
    expect(r.license).toBe(l);
  });

  it('⚠️ une licence FFSA ne donne pas accès à l\'Euro RX du même pilote', () => {
    const r = canAnalysePerson({
      licenses: [licence({ scope: 'season', meetingId: null, championshipId: FFSA })],
      personId: PAILLER, meeting: M_LOHEAC_EURO, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(DENIAL.wrongScope);
  });

  it('deux licences distinctes couvrent bien les deux championnats', () => {
    // Le team qui achète les deux saisons obtient les deux, et seulement
    // parce qu'il a payé deux fois.
    const deux = [
      licence({ id: 'l_ffsa', scope: 'season', meetingId: null, championshipId: FFSA }),
      licence({ id: 'l_euro', scope: 'season', meetingId: null, championshipId: EURO }),
    ];
    expect(canAnalysePerson({ licenses: deux, personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW }).allowed).toBe(true);
    expect(canAnalysePerson({ licenses: deux, personId: PAILLER, meeting: M_LOHEAC_EURO, now: NOW }).allowed).toBe(true);
  });

  it('une licence révoquée ferme l\'accès même sur le bon meeting', () => {
    const r = canAnalysePerson({
      licenses: [licence({ status: 'revoked' })], personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(DENIAL.notActive);
  });

  it('parmi plusieurs licences, une seule valide suffit', () => {
    const r = canAnalysePerson({
      licenses: [
        licence({ id: 'l1', status: 'revoked' }),
        licence({ id: 'l2', meetingId: M_KERLABO.id }),
        licence({ id: 'l3' }),
      ],
      personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.license.id).toBe('l3');
  });

  it('le motif retenu est le plus explicite, pour pouvoir l\'expliquer', () => {
    // Une licence expirée sur le BON meeting mérite un message différent
    // d'une licence valide sur un autre championnat.
    const r = canAnalysePerson({
      licenses: [
        licence({ id: 'autre_champ', scope: 'season', meetingId: null, championshipId: EURO }),
        licence({ id: 'expiree', validUntil: NOW - JOUR }),
      ],
      personId: PAILLER, meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(DENIAL.expired);
  });

  it('l\'administrateur passe avant toute vérification', () => {
    const r = canAnalysePerson({
      licenses: [], personId: AUTRE_PERSONNE, meeting: M_LOHEAC_EURO, isAdmin: true, now: NOW,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('décision par inscription sportive — le cas des driverId multiples', () => {
  it('⚠️ une licence couvre TOUTES les inscriptions du pilote dans son périmètre', () => {
    // Adrien Le Quere : #313 en D3 et #98 en Supercar, MÊME championnat.
    // Un seul PASS SAISON doit couvrir les deux — c'est précisément ce que
    // la licence par fiche pilote apporte face à une licence par driverId.
    const l = licence({ personId: LEQUERE, scope: 'season', meetingId: null, championshipId: FFSA });
    const ctx = { licenses: [l], personByDriver: PERSON_BY_DRIVER, meeting: M_LOHEAC_FFSA, now: NOW };
    expect(canAnalyseDriver({ ...ctx, driverId: DRV_LEQUERE_D3 }).allowed).toBe(true);
    expect(canAnalyseDriver({ ...ctx, driverId: DRV_LEQUERE_SUP }).allowed).toBe(true);
  });

  it('⚠️ mais elle ne franchit pas la frontière du championnat', () => {
    // Fabien Pailler : #7 Supercar FFSA et #29 RX1 Euro RX.
    const l = licence({ personId: PAILLER, scope: 'season', meetingId: null, championshipId: FFSA });
    expect(canAnalyseDriver({
      licenses: [l], driverId: DRV_PAILLER_FFSA, personByDriver: PERSON_BY_DRIVER,
      meeting: M_LOHEAC_FFSA, now: NOW,
    }).allowed).toBe(true);
    expect(canAnalyseDriver({
      licenses: [l], driverId: DRV_PAILLER_EURO, personByDriver: PERSON_BY_DRIVER,
      meeting: M_LOHEAC_EURO, now: NOW,
    }).allowed).toBe(false);
  });

  it('une inscription sans fiche pilote est refusée, et le dit', () => {
    // `drivers.personId` est renseigné à 100 % aujourd'hui, mais rien ne
    // l'impose au niveau des règles pour les documents anciens.
    const r = canAnalyseDriver({
      licenses: [licence()], driverId: 'drv_orphelin', personByDriver: PERSON_BY_DRIVER,
      meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(DENIAL.unknownDriver);
  });

  it('accepte indifféremment une Map ou un objet', () => {
    const map = new Map(Object.entries(PERSON_BY_DRIVER));
    const args = { licenses: [licence()], driverId: DRV_PAILLER_FFSA, meeting: M_LOHEAC_FFSA, now: NOW };
    expect(canAnalyseDriver({ ...args, personByDriver: map }).allowed).toBe(true);
    expect(canAnalyseDriver({ ...args, personByDriver: PERSON_BY_DRIVER }).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('filtrage du sélecteur de pilote', () => {
  // Inscriptions réellement au départ, telles que `state.standings` les donne.
  const AU_DEPART_FFSA = [DRV_PAILLER_FFSA, DRV_LEQUERE_D3, DRV_LEQUERE_SUP, DRV_AUTRE];
  const AU_DEPART_EURO = [DRV_PAILLER_EURO, DRV_AUTRE];

  it('ne retient que les inscriptions couvertes, pas tout le plateau', () => {
    const l = licence({ personId: PAILLER, scope: 'season', meetingId: null, championshipId: FFSA });
    const ids = allowedDriverIds({
      licenses: [l], personByDriver: PERSON_BY_DRIVER, driverIds: AU_DEPART_FFSA,
      meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect([...ids].sort()).toEqual([DRV_PAILLER_FFSA]);
    expect(ids.has(DRV_AUTRE)).toBe(false);
  });

  it('⚠️ sur le meeting Euro RX, la licence FFSA ne fait rien remonter', () => {
    // Le même pilote, la même personne, mais un périmètre non acheté.
    const l = licence({ personId: PAILLER, scope: 'season', meetingId: null, championshipId: FFSA });
    const ids = allowedDriverIds({
      licenses: [l], personByDriver: PERSON_BY_DRIVER, driverIds: AU_DEPART_EURO,
      meeting: M_LOHEAC_EURO, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it('les deux inscriptions d\'un même pilote apparaissent ensemble', () => {
    const l = licence({ personId: LEQUERE, scope: 'season', meetingId: null, championshipId: FFSA });
    const ids = allowedDriverIds({
      licenses: [l], personByDriver: PERSON_BY_DRIVER, driverIds: AU_DEPART_FFSA,
      meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect([...ids].sort()).toEqual([DRV_LEQUERE_D3, DRV_LEQUERE_SUP].sort());
  });

  it('sans la liste du plateau, on retombe sur la table complète — et c\'est documenté', () => {
    // Contrat explicite : l'appelant DOIT passer `driverIds`. Sans lui, une
    // licence FFSA fait remonter aussi l'inscription Euro RX du pilote, parce
    // que la décision porte sur la PERSONNE. Le test fige ce comportement
    // pour qu'il ne se découvre pas en production.
    const l = licence({ personId: PAILLER, scope: 'season', meetingId: null, championshipId: FFSA });
    const ids = allowedDriverIds({
      licenses: [l], personByDriver: PERSON_BY_DRIVER, meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect([...ids].sort()).toEqual([DRV_PAILLER_EURO, DRV_PAILLER_FFSA].sort());
  });

  it('l\'administrateur voit tout le plateau', () => {
    const ids = allowedDriverIds({
      licenses: [], personByDriver: PERSON_BY_DRIVER, driverIds: AU_DEPART_EURO,
      meeting: M_LOHEAC_EURO, isAdmin: true, now: NOW,
    });
    expect([...ids].sort()).toEqual([...AU_DEPART_EURO].sort());
  });

  it('sans licence, la liste est vide — jamais partiellement remplie', () => {
    const ids = allowedDriverIds({
      licenses: [], personByDriver: PERSON_BY_DRIVER, driverIds: AU_DEPART_FFSA,
      meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect(ids.size).toBe(0);
  });

  it('une inscription sans fiche pilote est ignorée sans faire échouer le filtre', () => {
    const l = licence({ personId: PAILLER, scope: 'season', meetingId: null, championshipId: FFSA });
    const ids = allowedDriverIds({
      licenses: [l], personByDriver: PERSON_BY_DRIVER,
      driverIds: [...AU_DEPART_FFSA, 'drv_orphelin'], meeting: M_LOHEAC_FFSA, now: NOW,
    });
    expect([...ids]).toEqual([DRV_PAILLER_FFSA]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('libellés', () => {
  it('chaque motif de refus a un message distinct et compréhensible', () => {
    const messages = Object.values(DENIAL).map(r => denialMessage(r));
    expect(new Set(messages).size).toBe(messages.length);
    messages.forEach(m => expect(m.length).toBeGreaterThan(20));
  });

  it('le message général distingue « aucun accès » de « pas cet accès-là »', () => {
    expect(denialMessage(DENIAL.noLicense, { hasAnyLicense: false })).toMatch(/réservé aux teams/);
    expect(denialMessage(DENIAL.noLicense, { hasAnyLicense: true })).toMatch(/n'est pas incluse/);
  });

  it('la portée se lit sans avoir à connaître les identifiants', () => {
    expect(scopeLabel(licence({ scope: 'season' }), { championshipLabel: 'Championnat FFSA' }))
      .toBe('Saison Championnat FFSA 2026');
    expect(scopeLabel(licence(), { championshipLabel: 'Championnat FFSA', meetingLabel: '30/08 Lohéac' }))
      .toBe('30/08 Lohéac · Championnat FFSA');
  });

  it('le résumé écarte les licences périmées et nomme les pilotes', () => {
    const s = accessSummary({
      licenses: [
        licence({ id: 'ok', personId: PAILLER }),
        licence({ id: 'perimee', personId: LEQUERE, validUntil: NOW - JOUR }),
      ],
      now: NOW,
      personsById: {
        [PAILLER]: { firstName: 'Fabien', lastName: 'Pailler' },
        [LEQUERE]: { firstName: 'Adrien', lastName: 'Le Quere' },
      },
      championshipsById: { [FFSA]: { name: 'Championnat FFSA' } },
      meetingsById: { [M_LOHEAC_FFSA.id]: { date: '2026-08-30', location: 'Lohéac' } },
    });
    expect(s).toHaveLength(1);
    expect(s[0].personLabel).toBe('Fabien Pailler');
    expect(s[0].scopeLabel).toBe('2026-08-30 Lohéac · Championnat FFSA');
  });
});
