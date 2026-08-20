/* ═══════════════════════════════════════════════
   PROJECTIONWORDING.TEST.JS — Garde-fou sur les formulations.

   Le module montre ce qui est OBSERVABLE. Il n'interprète pas l'intention
   d'un pilote et ne donne aucune consigne de course. Ce test échoue si une
   formulation interdite réapparaît dans les sources du module ou dans une
   sortie de calcul — c'est une règle produit, pas une préférence de style,
   et elle doit survivre aux futures évolutions.

   Il vérifie aussi que la séparation « données historiques » / « simulation »
   reste explicite dans les libellés, pour que les deux ne se confondent
   jamais à l'écran.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MESSAGES, FORBIDDEN_WORDINGS, CONFIDENCE_LEVELS, RESULT_BUCKETS,
  MIN_CASES_TO_SHOW_RATE, HISTORY, TARGET, SIMULATION, CLASSIFICATION,
} from '../js/projection/projectionConfig.js';
import { buildHistoricalOutlook } from '../js/projection/qualificationHistory.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'js', 'projection');
const FILES = readdirSync(DIR).filter(f => f.endsWith('.js'));
const SOURCES = Object.fromEntries(FILES.map(f => [f, readFileSync(join(DIR, f), 'utf8')]));

/** Texte plat de toutes les valeurs d'un objet, fonctions évaluées. */
function textOf(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') { try { out.push(String(value(1, 1))); } catch { /* signature différente */ } }
  else if (Array.isArray(value)) value.forEach(v => textOf(v, out));
  else if (typeof value === 'object') Object.values(value).forEach(v => textOf(v, out));
  return out;
}

describe('certitude et probabilité ne se disent pas de la même façon', () => {
  it('le libellé du bloc CERTITUDES ne contient aucun vocabulaire probabiliste', () => {
    for (const key of ['sectionCertainties', 'certaintiesScope']) {
      expect(MESSAGES[key], key).not.toMatch(/%|probab|estim|simulation|chance/i);
    }
  });

  it('la formulation non déterministe existe et s\'annonce comme telle', () => {
    // Une métrique utile mais issue d'un tirage doit pouvoir être dite — hors
    // du bloc CERTITUDES, et sous une forme qui nomme sa source.
    expect(MESSAGES.inSimulations('98,0 %')).toBe('Dans 98,0 % des simulations.');
  });

  it('le rappel « une manche reste à courir » interdit toute lecture définitive', () => {
    expect(MESSAGES.stillAProjection).toMatch(/PROBABILITÉ/);
    expect(MESSAGES.stillAProjection).not.toMatch(/certitude,|acquis/i);
  });

  it('le refus de what-if nomme la manche concernée', () => {
    expect(MESSAGES.whatIfUnavailable(4)).toBe(
      'Résultat Q4 déjà acquis — scénario What-if indisponible pour cette manche.');
    expect(MESSAGES.whatIfUnavailable(2)).toContain('Q2');
  });

  it('le compte de séries dit d\'où il vient', () => {
    expect(MESSAGES.seriesFromEntered(2, 6)).toBe(
      '2 / 6 séries terminées d\'après les séries renseignées.');
    expect(MESSAGES.seriesUnknown).toMatch(/ne peut pas être établi/);
  });
});

describe('formulations interdites', () => {
  it('la liste est non vide et couvre le cas emblématique', () => {
    expect(FORBIDDEN_WORDINGS.length).toBeGreaterThan(0);
    expect(FORBIDDEN_WORDINGS).toContain('levé le pied');
  });

  it('aucune source du module ne contient de formulation interdite', () => {
    const found = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      // La déclaration de la liste elle-même est le seul endroit légitime.
      if (file === 'projectionConfig.js') continue;
      const lower = src.toLowerCase();
      for (const w of FORBIDDEN_WORDINGS) {
        if (lower.includes(w.toLowerCase())) found.push(`${file} → « ${w} »`);
      }
    }
    expect(found).toEqual([]);
  });

  it('aucun message configuré ne contient de formulation interdite', () => {
    const found = [];
    for (const text of textOf(MESSAGES)) {
      const lower = text.toLowerCase();
      for (const w of FORBIDDEN_WORDINGS) {
        if (lower.includes(w.toLowerCase())) found.push(`« ${text} » → « ${w} »`);
      }
    }
    expect(found).toEqual([]);
  });

  it('les messages produits par un calcul réel restent descriptifs', () => {
    const observations = Array.from({ length: 40 }, (_, i) => ({
      championshipId: 'C1', category: 'Cat1',
      checkpoints: { 3: { gap: 0, points: 100 } },
      raceResults: { 4: { position: 1 + (i % 12), status: null } },
      final: { qualifiedByRule: i % 4 !== 0 },
    }));
    const out = buildHistoricalOutlook({
      observations, checkpoint: 3, finalRace: 4,
      driver: { points: 100, position: 16, gap: 0 },
      filters: { championshipId: 'C1', category: 'Cat1' },
    });
    const text = out.messages.join(' ').toLowerCase();
    for (const w of FORBIDDEN_WORDINGS) expect(text).not.toContain(w.toLowerCase());
    expect(out.messages.join(' ')).toMatch(/Observé sur \d+ cas/);
  });
});

describe('séparation historique / simulation', () => {
  it('les deux sections ont un libellé explicite et distinct', () => {
    expect(MESSAGES.sectionHistorical).toMatch(/observations réellement mesurées/i);
    expect(MESSAGES.sectionSimulation).toMatch(/projection statistique/i);
    expect(MESSAGES.sectionHistorical).not.toBe(MESSAGES.sectionSimulation);
  });

  it('le blocage d\'un règlement non supporté est explicite', () => {
    expect(MESSAGES.unsupportedRegulation).toMatch(/indisponible/i);
    expect(MESSAGES.unsupportedRegulation).toMatch(/non supportée/i);
  });

  it('le résultat cible est présenté comme une estimation, pas comme un ordre', () => {
    const t = MESSAGES.targetBeyond('P8');
    expect(t).toMatch(/gain estimé/);
    expect(t).not.toMatch(/doit/);
  });
});

describe('configuration centralisée', () => {
  it('les niveaux de confiance vont du plus au moins exigeant', () => {
    const mins = CONFIDENCE_LEVELS.map(l => l.minCases);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
    expect(CONFIDENCE_LEVELS[CONFIDENCE_LEVELS.length - 1].minCases).toBe(0);
    expect(CONFIDENCE_LEVELS.map(l => l.id)).toEqual(['high', 'medium', 'low']);
  });

  it('les tranches de résultat couvrent les places et les statuts', () => {
    expect(RESULT_BUCKETS.some(b => b.status)).toBe(true);
    expect(RESULT_BUCKETS.filter(b => !b.status).length).toBeGreaterThanOrEqual(3);
    // Les tranches de places doivent être contiguës et sans trou.
    const chiffrees = RESULT_BUCKETS.filter(b => !b.status);
    for (let i = 1; i < chiffrees.length; i++) {
      expect(chiffrees[i].min).toBe(chiffrees[i - 1].max + 1);
    }
    expect(chiffrees[0].min).toBe(1);
  });

  it('les valeurs calibrables sont toutes exposées, pas dispersées dans le code', () => {
    expect(MIN_CASES_TO_SHOW_RATE).toBeGreaterThan(0);
    expect(HISTORY.adaptiveBuckets.minWidth).toBeGreaterThan(0);
    expect(HISTORY.adaptiveBuckets.maxWidth).toBeGreaterThan(HISTORY.adaptiveBuckets.minWidth);
    expect(HISTORY.comparableStrategies.length).toBeGreaterThan(1);
    expect(TARGET.diminishingReturnPctPerPosition).toBeGreaterThan(0);
    expect(SIMULATION.profiles.dev).toBe(10000);
    expect(SIMULATION.profiles.validation).toBe(50000);
    expect(SIMULATION.profiles.performance).toBe(100000);
    expect(CLASSIFICATION.green.minProbability).toBeGreaterThan(CLASSIFICATION.orange.minProbability);
  });

  it('la première stratégie de comparaison est la plus stricte', () => {
    const first = HISTORY.comparableStrategies[0];
    expect(first.gapTolerance).toBe(0);
    expect(first.match).toEqual(['championshipId', 'category']);
  });
});

describe('pureté des modules de calcul', () => {
  const PURE = FILES.filter(f => f !== 'qualificationData.js');

  it('aucun module pur ne touche à Firestore ni au DOM', () => {
    const bad = [];
    for (const f of PURE) {
      const src = SOURCES[f];
      if (/firebase/i.test(src)) bad.push(`${f} → firebase`);
      if (/\b(document|window)\./.test(src)) bad.push(`${f} → DOM`);
    }
    expect(bad).toEqual([]);
  });

  it('seul qualificationData.js parle à Firestore', () => {
    expect(SOURCES['qualificationData.js']).toMatch(/firebase/i);
  });
});
