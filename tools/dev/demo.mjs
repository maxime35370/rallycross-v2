/* ═══════════════════════════════════════════════
   DEMO.MJS — Application réelle, données de test, captures d'écran.

   Sert une seule chose : VÉRIFIER un écran au lieu de l'affirmer. Le script
   amorce les émulateurs, sert le site tel quel, pilote un navigateur et
   capture ce qu'un administrateur puis un team voient réellement.

   Rien ici n'est importé par l'application. Aucune donnée de production
   n'est touchée : les émulateurs sont locaux et éphémères.

   Usage :
     npx firebase emulators:exec --only firestore,auth \
         --project rallycross-1512f "node tools/dev/demo.mjs"
═══════════════════════════════════════════════ */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { makeMeeting, TEST_REGULATION } from '../../tests/helpers/projectionFixtures.js';

const PROJECT = 'rallycross-1512f';
const FS_HOST = 'http://127.0.0.1:8080';
const AU_HOST = 'http://127.0.0.1:9099';
const PORT = 4399;
const OUT = 'tools/dev/shots';
const ROOT = process.cwd();

// ─────────────────────────────────────────────────────────
// FIRESTORE ÉMULÉ — écriture privilégiée
// ─────────────────────────────────────────────────────────

/** Encode une valeur JS au format Value de l'API REST Firestore. */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}

/** `Bearer owner` : l'émulateur contourne alors les règles. */
async function put(col, id, data) {
  const url = `${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${col}/${id}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }),
  });
  if (!r.ok) throw new Error(`${col}/${id} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────
// AUTH ÉMULÉ
// ─────────────────────────────────────────────────────────

async function createUser({ email, password, verified }) {
  const signUp = await fetch(`${AU_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!signUp.ok) throw new Error(`signUp ${email} → ${await signUp.text()}`);
  const { localId, idToken } = await signUp.json();

  if (verified) {
    const upd = await fetch(`${AU_HOST}/identitytoolkit.googleapis.com/v1/accounts:update?key=fake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId, emailVerified: true, idToken }),
    });
    if (!upd.ok) throw new Error(`verify ${email} → ${await upd.text()}`);
  }
  return localId;
}

// ─────────────────────────────────────────────────────────
// JEU DE DONNÉES
//
// Volontairement construit autour du cas qui compte : UNE personne, DEUX
// championnats, et Lohéac à la même date des deux côtés. C'est là que la
// séparation FFSA / Euro RX doit se voir à l'écran.
// ─────────────────────────────────────────────────────────

const FFSA = 'champ_ffsa_2026';
const EURO = 'champ_euro_2026';
const PAILLER = 'person_pailler';
const MOREL = 'person_morel';

/** Quatre manches courues, pour que l'écran stratégique ait de la matière. */
function meetingFixture({ meetingId, championshipId, location, category }) {
  return makeMeeting({
    meetingId, championshipId, category, year: 2026,
    meeting: { date: '2026-08-30', location },
    drivers: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    races: {
      1: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8 },
      2: { B: 1, A: 2, D: 3, C: 4, F: 5, E: 6, H: 7, G: 8 },
      3: { A: 1, C: 2, B: 3, E: 4, D: 5, G: 6, F: 7, H: 8 },
    },
    plannedRaces: 4,
  });
}

async function seed() {
  console.log('· championnats, fiches pilotes');
  // `id` retiré du gabarit : un document qui porte son propre champ `id`
  // piège toute lecture écrite `{ id: d.id, ...d.data() }`.
  const { id: _ignore, ...REGLEMENT } = TEST_REGULATION;
  await put('championships', FFSA, { ...REGLEMENT, name: 'Championnat FFSA Rallycross', year: 2026, isActive: true });
  await put('championships', EURO, { ...REGLEMENT, name: 'Euro RX', year: 2026, isActive: false });
  await put('persons', PAILLER, { firstName: 'Fabien', lastName: 'Pailler', nationality: 'France' });
  await put('persons', MOREL, { firstName: 'Camille', lastName: 'Morel', nationality: 'France', reviewFlag: 'duplicate_candidate' });
  for (const [i, nom] of [['C', 'Bernard'], ['D', 'Dumas'], ['E', 'Evrard'], ['F', 'Fauve'], ['G', 'Guyot'], ['H', 'Hamon']].entries()) {
    await put('persons', `person_${nom[0].toLowerCase()}`, { firstName: `Pilote${nom[0]}`, lastName: nom[1] });
  }

  console.log('· deux meetings à Lohéac, un par championnat');
  const fixtures = [
    { ...meetingFixture({ meetingId: 'mtg_loheac_ffsa', championshipId: FFSA, location: 'Lohéac', category: 'Supercar' }), champ: FFSA },
    { ...meetingFixture({ meetingId: 'mtg_loheac_euro', championshipId: EURO, location: 'France – Lohéac', category: 'RX1' }), champ: EURO },
    { ...meetingFixture({ meetingId: 'mtg_kerlabo', championshipId: FFSA, location: 'Kerlabo', category: 'Supercar' }), champ: FFSA },
  ];
  // Kerlabo est une autre date : sans quoi il serait indiscernable de Lohéac.
  fixtures[2].meeting.date = '2026-07-26';

  // ── Meeting À VENIR : engagements saisis, AUCUN chrono ────────────────
  // Reproduit la situation d'avant-meeting : la régie a saisi les
  // inscriptions, aucune manche n'est courue. Le team doit-il pouvoir
  // préparer sa stratégie ? C'est ce que cette entrée permet de vérifier.
  const avenir = meetingFixture({
    meetingId: 'mtg_dreux_avenir', championshipId: FFSA,
    location: 'Dreux (à venir)', category: 'Supercar',
  });
  avenir.meeting.date = '2026-10-11';
  avenir.results = [];                     // aucun chrono
  fixtures.push({ ...avenir, champ: FFSA });

  for (const f of fixtures) {
    await put('meetings', f.meeting.id, f.meeting);
    for (const s of f.sessions) await put('sessions', s.id, s);
    for (const r of f.results) await put('results', r.id, r);
    for (const p of f.participants) await put('sessionParticipants', p.id, p);

    // Une inscription sportive par pilote du meeting, rattachée à sa fiche.
    const cat = f.sessions[0]?.category;
    const vus = new Set();
    for (const p of f.participants) {
      if (vus.has(p.driverId)) continue;
      vus.add(p.driverId);
      const personId = p.driverId === 'A' ? PAILLER : p.driverId === 'B' ? MOREL : `person_${p.driverId.toLowerCase()}`;
      await put('drivers', p.driverId, {
        firstName: p.firstName, lastName: p.lastName, carNumber: p.carNumber,
        category: cat, year: 2026, championshipId: f.champ, personId,
      });
    }
  }

  console.log('· comptes');
  const admin = await createUser({ email: 'maxime.theard@gmail.com', password: 'demo1234', verified: true });
  const alice = await createUser({ email: 'alice@teamdupont.fr', password: 'demo1234', verified: true });
  const bob   = await createUser({ email: 'bob@teamdupont.fr',   password: 'demo1234', verified: true });
  const eric  = await createUser({ email: 'eric@nonverifie.fr',  password: 'demo1234', verified: false });
  for (const [uid, email] of [[admin, 'maxime.theard@gmail.com'], [alice, 'alice@teamdupont.fr'],
                              [bob, 'bob@teamdupont.fr'], [eric, 'eric@nonverifie.fr']]) {
    await put('users', uid, { email, displayName: '', createdAt: new Date() });
  }

  console.log('· team, membres, licence');
  await put('teams', 'team_dupont', { name: 'Team Dupont', contactEmail: 'alice@teamdupont.fr', createdAt: new Date() });
  await put('teamMembers', `team_dupont_${alice}`, { teamId: 'team_dupont', uid: alice, role: 'owner', addedAt: new Date() });
  await put('teamMembers', `team_dupont_${bob}`,   { teamId: 'team_dupont', uid: bob,   role: 'member', addedAt: new Date() });

  // Licence SAISON FFSA sur Fabien Pailler : elle doit ouvrir Lohéac FFSA et
  // Kerlabo, et rester fermée sur Lohéac Euro RX.
  await put('licenses', 'lic_demo', {
    teamId: 'team_dupont', personId: PAILLER, scope: 'season',
    championshipId: FFSA, year: 2026, meetingId: null,
    status: 'active', origin: 'admin_grant',
    personLabel: 'Fabien Pailler', championshipLabel: 'Championnat FFSA Rallycross', meetingLabel: '',
    validFrom: null, validUntil: null, note: 'démo Lohéac',
    createdAt: new Date(), createdBy: admin,
  });

  return { admin, alice, bob, eric };
}

// ─────────────────────────────────────────────────────────
// SERVEUR STATIQUE
// ─────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(500); res.end('500'); }
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

// ─────────────────────────────────────────────────────────
// CAPTURES
// ─────────────────────────────────────────────────────────

const URL_BASE = `http://127.0.0.1:${PORT}/?emulator`;

async function login(page, email) {
  // `networkidle` est inutilisable ici : Firestore garde un flux Listen
  // ouvert en permanence, le réseau n'est jamais au repos. On attend donc
  // les éléments réellement nécessaires.
  await page.waitForSelector('#burger-btn', { timeout: 20000 });
  await page.click('#burger-btn');
  await page.waitForSelector('#auth-email', { state: 'visible', timeout: 8000 });
  await page.fill('#auth-email', email);
  await page.fill('#auth-pass', 'demo1234');
  await page.click('#auth-submit-btn');
  await page.waitForSelector('.auth-logged', { timeout: 12000 });
}

/**
 * Sert le SDK Firebase depuis node_modules au lieu de gstatic.com.
 *
 * Ce conteneur n'a pas accès à gstatic ; l'application, elle, importe le SDK
 * depuis ce CDN. Sans cette interception, le navigateur démarre mais n'a ni
 * Firestore ni Auth, et rien n'est vérifiable.
 *
 * Les fichiers de `node_modules/firebase/firebase-*.js` SONT les bundles
 * publiés sur gstatic : même code, même format ES. On mappe par nom de
 * fichier en ignorant le numéro de version, parce que les bundles
 * s'importent entre eux avec LEUR propre version dans l'URL.
 *
 * Détournement de développement uniquement : il vit dans ce script, jamais
 * dans l'application.
 */
async function routeFirebaseSdk(target) {
  await target.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    const file = join(ROOT, 'node_modules', 'firebase', route.request().url().split('/').pop());
    if (!existsSync(file)) { await route.abort(); return; }
    // NORMALISATION DE VERSION, indispensable : l'application importe
    // `.../10.12.0/firebase-app.js`, tandis que le bundle firestore importe
    // en interne `.../12.18.0/firebase-app.js`. Deux URL distinctes = DEUX
    // instances de module pour le navigateur, donc deux registres de
    // composants — d'où « Service firestore is not available ». On ramène
    // toutes les URL sur une seule version pour n'avoir qu'une instance.
    const body = (await readFile(file, 'utf8'))
      .replaceAll(/https:\/\/www\.gstatic\.com\/firebasejs\/[0-9.]+\//g,
                  'https://www.gstatic.com/firebasejs/10.12.0/');
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body,
    });
  });
}

async function shot(page, name) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  📸 ${name}.png`);
}

async function main() {
  console.log('\n── Amorçage ──');
  await seed();

  const server = await serve();
  console.log(`── Site servi sur http://127.0.0.1:${PORT} ──`);

  // Le SDK Firebase est importé depuis gstatic.com. Dans un conteneur
  // derrière un proxy, le navigateur ne l'hérite pas de l'environnement :
  // il faut le lui passer, et accepter le certificat du proxy. Sans cela,
  // l'application démarre mais n'a ni Firestore ni Auth.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    // `bypass` est indispensable : sans lui, le site servi en local et les
    // émulateurs partiraient eux aussi dans le proxy, qui répond 405.
    ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
    args: ['--no-sandbox'],
  });
  const newCtx = (viewport) => browser.newContext({
    viewport, locale: 'fr-FR',
    ignoreHTTPSErrors: Boolean(proxy),   // le proxy présente sa propre autorité
  });
  const ctx = await newCtx({ width: 1280, height: 1000 });
  await routeFirebaseSdk(ctx);
  const page = await ctx.newPage();
  const trace = (pg, tag) => {
    pg.on('console', m => { if (m.type() === 'error') console.log(`   [${tag}]`, m.text().slice(0, 240)); });
    pg.on('pageerror', e => console.log(`   [${tag} EXCEPTION]`, String(e).slice(0, 300)));
  };
  trace(page, 'admin');

  console.log('\n── Côté ADMIN ──');
  await page.goto(`${URL_BASE}#home`, { waitUntil: 'domcontentloaded' });
  await login(page, 'maxime.theard@gmail.com');
  await page.goto(`${URL_BASE}#access`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#acc-team', { timeout: 20000 })
    .catch(async (e) => { await shot(page, 'ECHEC-admin'); throw e; });
  await page.waitForTimeout(800);
  await shot(page, '01-admin-acces-team');

  // Formulaire complété : fiche marquée + championnat + meeting désambiguïsé.
  const morel = await page.$$eval('#acc-person option',
    els => els.find(e => /Morel/.test(e.textContent))?.value || '');
  await page.selectOption('#acc-person', morel);
  await page.waitForTimeout(300);
  await page.selectOption('#acc-champ', 'champ_ffsa_2026');
  await page.waitForTimeout(300);
  await page.selectOption('#acc-meeting', 'mtg_loheac_ffsa');
  await page.waitForTimeout(400);
  await shot(page, '02-admin-attribution');

  await page.selectOption('#acc-scope', 'season');
  await page.waitForTimeout(400);
  await shot(page, '03-admin-pass-saison');

  // ── ADMIN sur un meeting SANS manche terminée ────────────────────────
  // Le cas qui a produit le bug : bandeau « accès complet » affiché, et
  // pourtant un refus commercial en dessous.
  await page.goto(`${URL_BASE}#projection`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const optsAdmin = await page.$$eval('#prj-meeting option',
    els => els.map(e => ({ v: e.value, t: e.textContent.trim() })));
  const aVenir = optsAdmin.find(o => /venir/.test(o.t));
  if (aVenir) {
    await page.selectOption('#prj-meeting', aVenir.v);
    await page.waitForTimeout(2500);
    const txt = await page.textContent('#view-projection');
    const faux = /réservé aux teams|non incluse/.test(txt);
    console.log(faux
      ? '   ✗ ADMIN voit encore un message commercial'
      : '   ✓ ADMIN : aucun message commercial sur un meeting sans manche');
    await shot(page, '11-admin-meeting-sans-manche');
  } else {
    console.log('   ⚠️ meeting à venir absent côté admin');
  }

  console.log('\n── Côté TEAM ──');
  // CONTEXTE NEUF, pas un simple clearCookies : Firebase Auth persiste la
  // session dans IndexedDB, pas dans un cookie. Réutiliser le contexte de
  // l'administrateur laisserait la page connectée en tant qu'admin, ce qui
  // invaliderait entièrement la capture.
  const ctx2 = await newCtx({ width: 1280, height: 1000 });
  await routeFirebaseSdk(ctx2);
  const page2 = await ctx2.newPage();
  trace(page2, 'team');
  await page2.goto(`${URL_BASE}#home`, { waitUntil: 'domcontentloaded' });
  await login(page2, 'alice@teamdupont.fr');
  await page2.keyboard.press('Escape');
  await page2.goto(`${URL_BASE}#projection`, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(3500);

  // Diagnostic : ce que le navigateur voit RÉELLEMENT des droits.
  const diag = await page2.evaluate(async () => {
    const { getAccessState } = await import('/js/access/licenses.js');
    const { getUser } = await import('/js/auth.js');
    const u = getUser();
    return {
      email: u?.email, verifie: u?.emailVerified, anonyme: u?.isAnonymous,
      ...getAccessState(),
    };
  }).catch(e => ({ erreur: String(e).slice(0, 200) }));
  console.log('   ⋯ droits :', JSON.stringify({ ...diag, licenses: diag.licenses?.length }));

  const diag2 = await page2.evaluate(async () => {
    const { loadPersonByDriver } = await import('/js/access/licenses.js');
    const map = await loadPersonByDriver();
    const sel = document.getElementById('prj-meeting');
    return {
      taillePersonByDriver: map.size,
      quelquesEntrees: [...map.entries()].slice(0, 4),
      meetingsProposes: sel ? [...sel.options].map(o => o.textContent.trim()) : null,
    };
  }).catch(e => ({ erreur: String(e).slice(0, 200) }));
  console.log('   ⋯ carte pilote :', JSON.stringify(diag2));

  const options = await page2.$$eval('#prj-meeting option',
    els => els.map(e => ({ v: e.value, t: e.textContent.trim() })));
  console.log('   ⋯ meetings proposés :', options.map(o => o.t).join(' | '));

  // Le meeting du périmètre acheté : Lohéac, Championnat FFSA.
  const ffsa = options.find(o => /Supercar/.test(o.t) && /Lohéac/.test(o.t));
  if (ffsa) {
    await page2.selectOption('#prj-meeting', ffsa.v);
    await page2.waitForTimeout(2500);
    await shot(page2, '04-team-strategie-autorise');

    // Puis un pilote autorisé, pour voir l'analyse elle-même.
    const pilotes = await page2.$$eval('#prj-driver option',
      els => els.map(e => ({ v: e.value, t: e.textContent.trim() })));
    console.log('   ⋯ pilotes proposés :', pilotes.map(o => o.t).join(' | '));
    if (pilotes.length > 1) {
      await page2.selectOption('#prj-driver', pilotes[1].v);
      await page2.waitForTimeout(4000);
      await shot(page2, '05-team-analyse-ouverte');
    }
  } else {
    console.log('   ⚠️ meeting FFSA introuvable');
  }

  // Meeting À VENIR : engagements saisis, aucun chrono. Que montre l'écran ?
  const avenir = options.find(o => /venir/.test(o.t));
  if (avenir) {
    await page2.selectOption('#prj-meeting', avenir.v);
    await page2.waitForTimeout(2500);
    const pil = await page2.$$eval('#prj-driver option', els => els.map(e => e.textContent.trim()));
    console.log('   ⋯ meeting à venir — pilotes proposés :', pil.join(' | ') || '(pas de sélecteur)');
    await shot(page2, '09-team-meeting-a-venir');
    if (pil.length > 1) {
      await page2.selectOption('#prj-driver', await page2.$$eval('#prj-driver option', e => e[1].value));
      await page2.waitForTimeout(4000);
      await shot(page2, '10-team-avant-course');
    }
    // On revient sur le meeting couru pour la suite du scénario.
    const couru = options.find(o => /Lohéac/.test(o.t) && /Supercar/.test(o.t));
    if (couru) { await page2.selectOption('#prj-meeting', couru.v); await page2.waitForTimeout(2000); }
  }

  // Le meeting Euro RX n'apparaît PLUS dans la liste : depuis que le
  // sélecteur est filtré sur le périmètre acheté, un team ne se voit
  // proposer que ce qui lui est ouvert. On vérifie donc son ABSENCE.
  const euroPropose = options.some(o => /RX1/.test(o.t));
  console.log(euroPropose
    ? '   ⚠️ le meeting Euro RX est proposé alors qu\'il ne devrait pas'
    : '   ✓ meeting Euro RX bien ABSENT du sélecteur (licence FFSA seulement)');

  // Révocation en direct : la licence est retirée pendant que la page est
  // ouverte. L'abonnement Firestore doit fermer l'accès SANS rechargement.
  console.log('\n── Révocation en direct ──');
  await put('licenses', 'lic_demo', {
    teamId: 'team_dupont', personId: PAILLER, scope: 'season',
    championshipId: FFSA, year: 2026, meetingId: null,
    status: 'suspended', origin: 'admin_grant',
    personLabel: 'Fabien Pailler', championshipLabel: 'Championnat FFSA Rallycross', meetingLabel: '',
    validFrom: null, validUntil: null, note: 'démo Lohéac',
    createdAt: new Date(), createdBy: 'demo',
  });
  await page2.waitForTimeout(3000);   // aucun rechargement : on laisse l'abonnement agir
  await shot(page2, '06-team-licence-suspendue');

  console.log('\n── Visiteur SANS COMPTE ──');
  const ctx3 = await newCtx({ width: 1280, height: 900 });
  await routeFirebaseSdk(ctx3);
  const page3 = await ctx3.newPage();
  await page3.goto(`${URL_BASE}#projection`, { waitUntil: 'domcontentloaded' });
  await page3.waitForTimeout(3000);
  await shot(page3, '07-public-non-connecte');

  await page3.goto(`${URL_BASE}#standings`, { waitUntil: 'domcontentloaded' });
  await page3.waitForTimeout(1500);
  await shot(page3, '08-public-classements-libres');

  await browser.close();
  server.close();
  console.log(`\n✔ Captures dans ${OUT}/\n`);
}

main().catch(e => { console.error('\n✗', e); process.exit(1); });
