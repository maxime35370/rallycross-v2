/* ═══════════════════════════════════════════════
   MEETINGSESSIONSSYNC.TEST.JS — Modifier un meeting doit modifier ses
   sessions.

   Cas réel : un meeting créé avec 4 manches qualificatives, ramené à 3 dans
   le formulaire. La liste des meetings affichait « 3 MQ », l'onglet Sessions
   toujours 4 manches — le formulaire ne mettait à jour que le document
   meeting. Ce test fixe le plan de synchronisation attendu dans chaque cas
   (MQ en moins, MQ en plus, catégorie ajoutée / retirée), et sa prudence :
   rien d'autre n'est touché.
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  buildSessionTemplates, planSessionSync, describeSessionDataLoss, sessionKey,
} from '../js/meetingSessionsSync.js';

const FFSA_SC = { EC: { enabled: true, laps: 1 }, MQ: { count: 4, laps: 4 }, DF: { count: 2, laps: 6 }, FIN: { laps: 7 } };
const FIA_SC  = { EC: { enabled: false }, MQ: { count: 4, laps: 4 }, QF: { enabled: true, count: 4, laps: 5 }, DF: { count: 2, laps: 6 }, FIN: { laps: 7 } };

/** Sessions Firestore d'un meeting, telles que générées à sa création. */
function generated(sc, nbMQ, categories) {
  const out = [];
  categories.forEach(category => {
    buildSessionTemplates(sc, nbMQ).forEach(tpl => {
      out.push({ id: `${category}-${tpl.type}${tpl.num ?? ''}`, category, type: tpl.type, num: tpl.num, order: tpl.order, label: tpl.label });
    });
  });
  return out;
}

describe('buildSessionTemplates — mêmes sessions qu\'à la création', () => {
  it('FFSA : EC, nbMQ manches, 2 DF, finale, dans l\'ordre', () => {
    const t = buildSessionTemplates(FFSA_SC, 3);
    expect(t.map(x => `${x.type}${x.num ?? ''}`)).toEqual(['EC', 'MQ1', 'MQ2', 'MQ3', 'DF1', 'DF2', 'FIN']);
    expect(t.map(x => x.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(t[1].tours).toBe(4);
  });

  it('FIA : pas d\'EC, 4 quarts de finale entre les MQ et les DF', () => {
    const t = buildSessionTemplates(FIA_SC, 4);
    expect(t.map(x => `${x.type}${x.num ?? ''}`)).toEqual(['MQ1', 'MQ2', 'MQ3', 'MQ4', 'QF1', 'QF2', 'QF3', 'QF4', 'DF1', 'DF2', 'FIN']);
    expect(t.find(x => x.type === 'QF').tours).toBe(5);
  });

  it('sans nbMQ, le règlement décide ; sans règlement, 4', () => {
    expect(buildSessionTemplates(FFSA_SC).filter(x => x.type === 'MQ')).toHaveLength(4);
    expect(buildSessionTemplates(undefined).filter(x => x.type === 'MQ')).toHaveLength(4);
    expect(buildSessionTemplates({ MQ: { count: 2 } }).filter(x => x.type === 'MQ')).toHaveLength(2);
  });
});

describe('planSessionSync — le cas signalé : 4 MQ → 3 MQ', () => {
  const cats = ['RX1', 'RX3', 'RX4', 'RX5'];
  const existing = generated(FIA_SC, 4, cats);
  const plan = planSessionSync({ existing, templates: buildSessionTemplates(FIA_SC, 3), categories: cats });

  it('supprime la MQ4 de chaque catégorie, et rien d\'autre', () => {
    expect(plan.toDelete.map(s => s.id).sort()).toEqual(['RX1-MQ4', 'RX3-MQ4', 'RX4-MQ4', 'RX5-MQ4']);
    expect(plan.toCreate).toEqual([]);
  });

  it('resserre l\'ordre des sessions suivantes (les quarts passent juste après la MQ3)', () => {
    const qf1 = plan.toReorder.find(r => r.id === 'RX1-QF1');
    expect(qf1).toEqual({ id: 'RX1-QF1', order: 3 });
    // 4 catégories × (4 QF + 2 DF + FIN) décalés d'un cran
    expect(plan.toReorder).toHaveLength(4 * 7);
  });

  it('rien à faire quand le formulaire n\'a pas changé', () => {
    const same = planSessionSync({ existing, templates: buildSessionTemplates(FIA_SC, 4), categories: cats });
    expect(same).toEqual({ toCreate: [], toDelete: [], toReorder: [] });
  });
});

describe('planSessionSync — autres modifications du formulaire', () => {
  it('3 MQ → 4 MQ : crée la MQ4 par catégorie, la place avant les DF', () => {
    const existing = generated(FFSA_SC, 3, ['RX1', 'RX3']);
    const plan = planSessionSync({ existing, templates: buildSessionTemplates(FFSA_SC, 4), categories: ['RX1', 'RX3'] });
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate.map(c => `${c.category}-${c.tpl.type}${c.tpl.num}`)).toEqual(['RX1-MQ4', 'RX3-MQ4']);
    expect(plan.toCreate[0].tpl.order).toBe(4);
    expect(plan.toReorder).toContainEqual({ id: 'RX1-DF1', order: 5 });
    expect(plan.toReorder).toContainEqual({ id: 'RX1-FIN', order: 7 });
  });

  it('catégorie ajoutée : jeu complet de sessions pour elle seule', () => {
    const existing = generated(FFSA_SC, 4, ['RX1']);
    const plan = planSessionSync({ existing, templates: buildSessionTemplates(FFSA_SC, 4), categories: ['RX1', 'RX3'] });
    expect(plan.toDelete).toEqual([]);
    expect(plan.toReorder).toEqual([]);
    expect(plan.toCreate.every(c => c.category === 'RX3')).toBe(true);
    expect(plan.toCreate).toHaveLength(8);
  });

  it('catégorie retirée : toutes ses sessions partent, les autres restent intactes', () => {
    const existing = generated(FFSA_SC, 4, ['RX1', 'RX3']);
    const plan = planSessionSync({ existing, templates: buildSessionTemplates(FFSA_SC, 4), categories: ['RX1'] });
    expect(plan.toDelete.every(s => s.category === 'RX3')).toBe(true);
    expect(plan.toDelete).toHaveLength(8);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toReorder).toEqual([]);
  });

  it('prudence : un QF existant que le règlement n\'active plus n\'est pas supprimé, et une catégorie existante ne reçoit pas de sessions non-MQ', () => {
    const existing = generated(FIA_SC, 4, ['RX1']);          // avec QF
    const plan = planSessionSync({ existing, templates: buildSessionTemplates(FFSA_SC, 4), categories: ['RX1'] }); // règlement sans QF, avec EC
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([]);                        // pas d'EC ajouté d'office
  });

  it('sessions déjà en base sans num (EC, FIN) : clé stable', () => {
    expect(sessionKey('RX1', 'FIN', null)).toBe(sessionKey('RX1', 'FIN', undefined));
  });
});

describe('describeSessionDataLoss — ne dérange que s\'il y a quelque chose à perdre', () => {
  it('null quand les sessions supprimées sont vides', () => {
    expect(describeSessionDataLoss([{ label: 'MQ4', category: 'RX1', participants: 0, results: 0 }])).toBeNull();
    expect(describeSessionDataLoss([])).toBeNull();
  });

  it('liste les sessions chargées avec pilotes et temps', () => {
    const msg = describeSessionDataLoss([
      { label: 'Manche qualificative 4', category: 'RX1', participants: 0, results: 0 },
      { label: 'Manche qualificative 4', category: 'RX3', participants: 12, results: 3 },
    ]);
    expect(msg).toContain('Manche qualificative 4 (RX3) : 12 pilotes, 3 temps');
    expect(msg).not.toContain('(RX1)');
    expect(msg).toContain('Continuer ?');
  });
});
