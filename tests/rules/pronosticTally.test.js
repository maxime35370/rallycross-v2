/* ═══════════════════════════════════════════════
   PRONOSTICTALLY.TEST.JS — Décompte des votes d'un pronostic ROUVERT puis refermé.

   Bug d'origine : `tally` (décompte agrégé, lu par l'overlay, le site spectateur et l'image récap)
   était écrit avec setDoc(…, { merge: true }). Or Firestore FUSIONNE les maps en profondeur :
   après « fermer → changer son vote → rouvrir → refermer », les anciens choix restaient dans `tally`
   (3 pilotes à 100 % alors que `totalVotes` valait 1). Les votes eux-mêmes (un document par spectateur)
   étaient justes ; seul le résumé affiché était pollué.

   On exécute ici le VRAI code (overlay/_lib/obs-pronostics.js) contre l'émulateur Firestore.
   Lancement :  npm run test:rules
═══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

// `db` de obs-firebase.js = la base de l'émulateur (rendue disponible avant l'import du module testé)
const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../overlay/_lib/obs-firebase.js', () => ({
  get db() { return holder.db; },
  initFirebase: async () => holder.db,
  fsQuery: async () => [], watchQuery: async () => () => {}, watchDoc: async () => () => {},
  getDocById: async () => null, setDocMerged: async () => {},
}));

const { openPronostic, closePronostic, revealPronostic, updateMeetingScores } = await import('../../overlay/_lib/obs-pronostics.js');

let env, db;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rallycross-rules',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
// La connexion de test n'est valable que PENDANT le bloc fourni : chaque test s'exécute donc à l'intérieur.
const t = (name, fn) => it(name, () => env.withSecurityRulesDisabled(async ctx => { db = ctx.firestore(); holder.db = db; await fn(); }));

const OPTIONS = [{ driverId: 'A', name: 'A' }, { driverId: 'B', name: 'B' }, { driverId: 'C', name: 'C' }];
const seed = (extra = {}) => setDoc(doc(db, 'pronostics', 'p1'), {
  question: 'Qui gagne ?', status: 'draft', category: 'D4', meetingId: 'm1', options: OPTIONS, tally: {}, totalVotes: 0, correctDriverId: '', ...extra,
});
/** Le spectateur choisit (ou change) son pilote — même opération que castVote(). */
const vote = (uid, driverId, at = Date.now()) => setDoc(doc(db, 'pronostics', 'p1', 'votes', uid), { driverId, at }, { merge: true });
const read = async () => (await getDoc(doc(db, 'pronostics', 'p1'))).data();

describe('pronostic rouvert puis refermé — le décompte reste exact', () => {
  t('scénario signalé : 3 votes successifs du même spectateur → un seul choix dans le décompte', async () => {
    await seed();
    await openPronostic('p1');
    await vote('u1', 'A');
    await closePronostic('p1');
    expect((await read()).tally).toEqual({ A: 1 });

    await openPronostic('p1'); await vote('u1', 'B'); await closePronostic('p1');
    let p = await read();
    expect(p.tally).toEqual({ B: 1 });            // avant correctif : { A: 1, B: 1 }
    expect(p.totalVotes).toBe(1);

    await openPronostic('p1'); await vote('u1', 'C'); await closePronostic('p1');
    p = await read();
    expect(p.tally).toEqual({ C: 1 });            // avant correctif : { A: 1, B: 1, C: 1 } = « 3 choix à 100 % »
    expect(p.totalVotes).toBe(1);
    expect(Object.values(p.tally).reduce((a, b) => a + b, 0)).toBe(p.totalVotes);   // cohérence décompte / total
  });

  t('plusieurs spectateurs : le décompte suit les changements de chacun', async () => {
    await seed();
    await openPronostic('p1'); await vote('u1', 'A'); await vote('u2', 'A'); await vote('u3', 'B');
    await closePronostic('p1');
    expect((await read()).tally).toEqual({ A: 2, B: 1 });
    await openPronostic('p1'); await vote('u2', 'C'); await closePronostic('p1');
    const p = await read();
    expect(p.tally).toEqual({ A: 1, B: 1, C: 1 }); expect(p.totalVotes).toBe(3);
  });

  t('rouvrir le pronostic remet le décompte figé à zéro (rien d\'ancien ne reste affichable)', async () => {
    await seed();
    await openPronostic('p1'); await vote('u1', 'A'); await closePronostic('p1');
    await openPronostic('p1');
    const p = await read();
    expect(p.status).toBe('open'); expect(p.tally).toEqual({}); expect(p.totalVotes).toBe(0);
  });

  t('la révélation recalcule aussi le décompte à neuf', async () => {
    await seed({ status: 'closed', tally: { A: 1, B: 1, C: 1 }, totalVotes: 1 });   // doc déjà pollué
    await vote('u1', 'C');
    await revealPronostic('p1', 'C');
    const p = await read();
    expect(p.tally).toEqual({ C: 1 }); expect(p.totalVotes).toBe(1); expect(p.status).toBe('revealed');
  });

  t('un vote reste unique par spectateur dans la base (le décompte n\'était qu\'un résumé pollué)', async () => {
    await seed();
    await openPronostic('p1'); await vote('u1', 'A'); await vote('u1', 'B'); await vote('u1', 'C');
    expect((await getDocs(collection(db, 'pronostics', 'p1', 'votes'))).size).toBe(1);
  });
});

describe('points « audace » — calculés sur les vrais votes, pas sur un décompte éventuellement pollué', () => {
  t('un ancien document déjà pollué ne fausse plus l\'audace', async () => {
    // décompte pollué : A=3 alors qu'un seul vote existe (celui de u1, qui a juste)
    await seed({ status: 'revealed', correctDriverId: 'A', tally: { A: 3, B: 1, C: 1 }, totalVotes: 1 });
    await vote('u1', 'A', 100);
    await setDoc(doc(db, 'twitchProfiles', 'u1'), { displayName: 'u1' });
    await updateMeetingScores('m1', {});
    const stats = (await getDoc(doc(db, 'pronoScores', 'm1'))).data().stats;
    // 1 seul votant, et il a juste → 100 % du public a juste → audace = 1 - 1 = 0 (et jamais négative)
    expect(stats.u1.boldSum).toBe(0);
    expect(stats.u1.correct).toBe(1);
  });

  t('audace normale : un bon pronostic minoritaire pèse plus', async () => {
    await seed({ status: 'revealed', correctDriverId: 'A', tally: {}, totalVotes: 0 });
    await vote('u1', 'A', 1); await vote('u2', 'B', 2); await vote('u3', 'B', 3); await vote('u4', 'C', 4);
    await updateMeetingScores('m1', {});
    const stats = (await getDoc(doc(db, 'pronoScores', 'm1'))).data().stats;
    expect(stats.u1.boldSum).toBeCloseTo(0.75, 6);   // 1 votant sur 4 a juste → 1 - 1/4
  });
});

describe('règles : le correctif (updateDoc) reste réservé à la régie', () => {
  const REGIE = 'maxime.theard@gmail.com';
  const regie = () => env.authenticatedContext('uid_regie', { email: REGIE, email_verified: true, firebase: { sign_in_provider: 'password' } }).firestore();
  const spect = () => env.authenticatedContext('uid_spect', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const seedRaw = () => env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'pronostics', 'p1'), { status: 'closed', tally: { A: 1 }, totalVotes: 1 }));

  it('la régie peut remplacer le décompte (updateDoc)', async () => {
    await seedRaw();
    await assertSucceeds(updateDoc(doc(regie(), 'pronostics', 'p1'), { status: 'open', tally: {}, totalVotes: 0 }));
  });
  it('un spectateur ne peut toujours pas toucher au décompte', async () => {
    await seedRaw();
    await assertFails(updateDoc(doc(spect(), 'pronostics', 'p1'), { tally: { A: 99 }, totalVotes: 99 }));
  });
});
