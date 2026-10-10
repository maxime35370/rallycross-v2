/* ═══════════════════════════════════════════════
   DATABASE.RULES.TEST.JS — Règles Realtime Database (miroir de lecture
   peu coûteux pour `results` et `obsControl`, cf. js/rtdb.js et
   overlay/_lib/obs-firebase.js). Même logique d'accès que Firestore :
   lecture publique, écriture réservée à la régie (email exact).

   Lancement :  npm run test:rules   (démarre les émulateurs, exécute, arrête)
═══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { ref, get, set, remove } from 'firebase/database';

const REGIE_EMAIL = 'maxime.theard@gmail.com';

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rallycross-rules',
    database: {
      rules: readFileSync('database.rules.json', 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => { await env.clearDatabase(); });

const regie      = () => env.authenticatedContext('uid_regie', { email: REGIE_EMAIL }).database();
const autreAuth   = () => env.authenticatedContext('uid_autre', { email: 'autre@example.com' }).database();
const anonyme     = () => env.unauthenticatedContext().database();

describe('Realtime Database — results (miroir de lecture)', () => {
  it('lecture publique, même sans authentification', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), 'results/sess_1/driver_1'), { ms: 42000, status: null });
    });
    const snap = await assertSucceeds(get(ref(anonyme(), 'results/sess_1/driver_1')));
    expect(snap.val()).toEqual({ ms: 42000, status: null });
  });

  it('écriture refusée sans authentification', async () => {
    await assertFails(set(ref(anonyme(), 'results/sess_1/driver_1'), { ms: 1000 }));
  });

  it('écriture refusée à un compte authentifié qui n\'est pas la régie', async () => {
    await assertFails(set(ref(autreAuth(), 'results/sess_1/driver_1'), { ms: 1000 }));
  });

  it('écriture et suppression autorisées pour la régie', async () => {
    await assertSucceeds(set(ref(regie(), 'results/sess_1/driver_1'), { ms: 39421, status: null }));
    await assertSucceeds(remove(ref(regie(), 'results/sess_1/driver_1')));
  });
});

describe('Realtime Database — obsControl (état régie)', () => {
  it('lecture publique, écriture régie uniquement', async () => {
    await assertFails(set(ref(anonyme(), 'obsControl/live'), { scene: 'dashboard' }));
    await assertSucceeds(set(ref(regie(), 'obsControl/live'), { scene: 'dashboard' }));
    const snap = await assertSucceeds(get(ref(anonyme(), 'obsControl/live')));
    expect(snap.val()).toEqual({ scene: 'dashboard' });
  });
});
