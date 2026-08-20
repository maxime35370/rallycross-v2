/* ═══════════════════════════════════════════════
   ANTIDUPLICATE.TEST.JS — Inscriptions en double aux sessions.

   Contexte : des documents `sessionParticipants` en double existent réellement
   en base (Loheac / D4 / Q1 : 14 ; Mayenne / D3 / Q3 : 17). Tous portent un
   identifiant aléatoire, hérité d'une écriture par `addDoc` suivie d'une
   vérification non atomique.

   L'enjeu n'est pas cosmétique. Le nombre d'engagés alimente le calcul des
   points d'abandon (`statusRules.DNF`, `mode: 'engaged_offset'`) : sur Loheac
   D4, 38 engagés au lieu de 24 donneraient à un DNF les points de la place 39.
   Un pilote en double apparaîtrait en plus deux fois au classement de sa manche.

   Ce fichier verrouille les deux moitiés de la correction :
     • À L'ÉCRITURE — identifiant déterministe côté client ET contrainte
       Firestore qui l'impose, pour que le doublon soit structurellement
       impossible plutôt que simplement évité par convention.
     • À LA LECTURE — dédoublonnage défensif partagé, parce que les documents
       déjà en base ne disparaîtront pas d'eux-mêmes.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionParticipantId, resultId, dedupeParticipants } from '../js/utils.js';
import { buildMqStandings, calcStatusPoints } from '../js/calc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

// ─────────────────────────────────────────────────────────
// IDENTIFIANT DÉTERMINISTE
// ─────────────────────────────────────────────────────────

describe('identifiant déterministe', () => {
  it('porte la clé métier, donc deux écritures concurrentes se rejoignent', () => {
    expect(sessionParticipantId('S1', 'D1')).toBe('S1_D1');
    expect(sessionParticipantId('S1', 'D1')).toBe(sessionParticipantId('S1', 'D1'));
    expect(sessionParticipantId('S1', 'D1')).not.toBe(sessionParticipantId('S1', 'D2'));
    expect(sessionParticipantId('S2', 'D1')).not.toBe(sessionParticipantId('S1', 'D1'));
  });

  it('suit la même convention que results', () => {
    expect(resultId('S1', 'D1')).toBe(sessionParticipantId('S1', 'D1'));
  });
});

// ─────────────────────────────────────────────────────────
// CONTRAINTE SERVEUR
// ─────────────────────────────────────────────────────────

describe('règle Firestore — la contrainte ne doit pas disparaître', () => {
  // Aucun émulateur n'est disponible ici : on vérifie que la règle est bien
  // présente et formulée. C'est un garde-fou contre une suppression
  // accidentelle, pas une preuve d'exécution — la règle doit être déployée
  // pour produire son effet.
  const rules = src('firestore.rules');
  const block = rules.slice(
    rules.indexOf('match /sessionParticipants/'),
    rules.indexOf('match /results/'),
  );

  it('la section sessionParticipants existe', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  it('la création impose docId == sessionId + "_" + driverId', () => {
    expect(block).toMatch(/allow create:/);
    expect(block.replace(/\s+/g, ' ')).toContain(
      "docId == request.resource.data.sessionId + '_' + request.resource.data.driverId");
  });

  it('create et update ne sont plus autorisés par la même clause permissive', () => {
    expect(block).not.toMatch(/allow create,\s*update:/);
  });

  it('une mise à jour ne peut pas repointer une inscription vers un autre pilote', () => {
    const flat = block.replace(/\s+/g, ' ');
    expect(flat).toContain('request.resource.data.driverId == resource.data.driverId');
    expect(flat).toContain('request.resource.data.sessionId == resource.data.sessionId');
  });

  it('l\'écriture reste réservée à la régie', () => {
    expect(block).toMatch(/allow create: if isRegie\(\)/);
    expect(block).toMatch(/allow update: if isRegie\(\)/);
    expect(block).toMatch(/allow delete: if isRegie\(\)/);
  });
});

// ─────────────────────────────────────────────────────────
// ÉCRITURE CÔTÉ CLIENT
// ─────────────────────────────────────────────────────────

describe('écriture côté client', () => {
  const sessions = src(join('js', 'sessions.js'));

  it('addParticipant écrit avec setDoc sur l\'identifiant canonique', () => {
    expect(sessions).toMatch(/sessionParticipantId\(sessionId, driverId\)/);
    expect(sessions).toMatch(/setDoc\(doc\(db, 'sessionParticipants', docId\)/);
  });

  it('aucun module n\'inscrit un participant par addDoc', () => {
    // addDoc génère un identifiant aléatoire : c'est exactement le chemin qui
    // a produit les doublons en base.
    const offenders = [];
    for (const f of ['sessions.js', 'timing.js', 'standings.js', 'championship.js', 'meetings.js', 'engagements.js']) {
      const s = src(join('js', f));
      const re = /addDoc\(\s*collection\(\s*db\s*,\s*'sessionParticipants'/g;
      if (re.test(s)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('l\'identifiant n\'est pas réécrit à la main ailleurs', () => {
    // Une deuxième formule littérale finirait par diverger de la règle serveur.
    const literal = /['"`]\$\{sessionId\}_\$\{driverId\}['"`]/;
    expect(literal.test(sessions)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// LECTURE DÉFENSIVE
// ─────────────────────────────────────────────────────────

describe('dédoublonnage à la lecture', () => {
  const dup = (id, driverId, createdAt) => ({
    id, driverId, sessionId: 'S1', carNumber: 7,
    firstName: 'A', lastName: 'B', createdAt,
  });

  it('conserve un pilote une seule fois', () => {
    const { participants, duplicates } = dedupeParticipants([
      dup('x1', 'D1'), dup('x2', 'D1'), dup('x3', 'D2'),
    ], 'S1');
    expect(participants.map(p => p.driverId).sort()).toEqual(['D1', 'D2']);
    expect(duplicates).toHaveLength(1);
  });

  it('privilégie le document à identifiant déterministe', () => {
    const { participants } = dedupeParticipants([
      dup('aleatoire', 'D1', '2026-01-01T00:00:00Z'),
      dup('S1_D1', 'D1', '2026-06-01T00:00:00Z'),
    ], 'S1');
    expect(participants[0].id).toBe('S1_D1');
  });

  it('à défaut, garde le plus ancien', () => {
    const { participants } = dedupeParticipants([
      dup('b', 'D1', '2026-06-01T00:00:00Z'),
      dup('a', 'D1', '2026-01-01T00:00:00Z'),
    ], 'S1');
    expect(participants[0].id).toBe('a');
  });

  it('restitue les doublons écartés, pour permettre leur nettoyage', () => {
    const { duplicates } = dedupeParticipants([
      dup('S1_D1', 'D1'), dup('x', 'D1'), dup('y', 'D1'),
    ], 'S1');
    expect(duplicates.map(d => d.id).sort()).toEqual(['x', 'y']);
  });

  it('déduit la session du document quand elle n\'est pas fournie', () => {
    const { participants } = dedupeParticipants([dup('x', 'D1'), dup('S1_D1', 'D1')]);
    expect(participants[0].id).toBe('S1_D1');
  });

  it('ne touche à rien quand il n\'y a pas de doublon', () => {
    const rows = [dup('S1_D1', 'D1'), dup('S1_D2', 'D2'), dup('S1_D3', 'D3')];
    const { participants, duplicates } = dedupeParticipants(rows, 'S1');
    expect(participants).toEqual(rows);
    expect(duplicates).toEqual([]);
  });

  it('tolère une entrée vide', () => {
    expect(dedupeParticipants()).toEqual({ participants: [], duplicates: [] });
  });
});

describe('les lecteurs de participants passent tous par le dédoublonnage', () => {
  it('calc.js, standings.js et championship.js l\'appliquent', () => {
    for (const f of ['calc.js', 'standings.js', 'championship.js']) {
      expect(src(join('js', f))).toMatch(/dedupeParticipants\(/);
    }
  });

  it('timing.js réutilise la même logique au lieu d\'une copie locale', () => {
    const t = src(join('js', 'timing.js'));
    expect(t).toMatch(/dedupeParticipants\(raw, selectedSessionId\)/);
    expect(t).not.toMatch(/const byDriver = new Map\(\)/);
  });
});

// ─────────────────────────────────────────────────────────
// IMPACT MÉTIER — CE QUE LE DOUBLON CASSAIT
// ─────────────────────────────────────────────────────────

describe('conséquence métier d\'un doublon non traité', () => {
  const REG = {
    pointsScale: { MQ: { formula: '44 - position', overrides: { 1: 50, 2: 45, 3: 42 } } },
    statusRules: { DNF: { mode: 'engaged_offset', offset: 1 } },
  };
  const drivers = ['D1', 'D2', 'D3', 'D4'];
  const parts = drivers.map((d, i) => ({
    id: `S1_${d}`, sessionId: 'S1', driverId: d, carNumber: i + 1, firstName: d, lastName: d,
  }));
  const results = [
    { driverId: 'D1', ms: 1000 }, { driverId: 'D2', ms: 1100 },
    { driverId: 'D3', ms: 1200 }, { driverId: 'D4', status: 'DNF' },
  ];

  it('un pilote en double apparaîtrait deux fois au classement de la manche', () => {
    const gonfle = [...parts, { ...parts[0], id: 'aleatoire' }];
    const sansDedupe = buildMqStandings(gonfle, results, REG);
    expect(sansDedupe.filter(r => r.driverId === 'D1')).toHaveLength(2);

    const avecDedupe = buildMqStandings(dedupeParticipants(gonfle, 'S1').participants, results, REG);
    expect(avecDedupe.filter(r => r.driverId === 'D1')).toHaveLength(1);
    expect(avecDedupe).toHaveLength(4);
  });

  it('et fausserait les points de l\'abandon, via engaged_offset', () => {
    // 4 engagés → DNF classé 5e → 44 - 5 = 39 points.
    expect(calcStatusPoints('DNF', 'MQ', 4, REG)).toBe(39);
    // Avec un doublon, 5 engagés → 44 - 6 = 38 : le pilote perdrait un point
    // à cause d'une erreur de saisie qui ne le concerne même pas.
    expect(calcStatusPoints('DNF', 'MQ', 5, REG)).toBe(38);

    const gonfle = [...parts, { ...parts[0], id: 'aleatoire' }];
    const dnfAvant = buildMqStandings(gonfle, results, REG).find(r => r.driverId === 'D4');
    const dnfApres = buildMqStandings(dedupeParticipants(gonfle, 'S1').participants, results, REG)
      .find(r => r.driverId === 'D4');
    expect(dnfAvant.points).toBe(38);
    expect(dnfApres.points).toBe(39);
  });
});
