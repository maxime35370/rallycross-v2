/* CONTRÔLE DU SCAN DE PLANS — dans un vrai navigateur, sur une vraie vidéo.

   Fabrique une vidéo dont on connaît la vérité, puis vérifie que la page
   `/__plans` la retrouve :

     0,0 – 2,0 s   plan A, panoramique rapide  (aucune coupure attendue)
     2,0 s         COUPURE vers le plan B      (une coupure attendue, datée à l'image)
     2,0 – 4,0 s   plan B, panoramique
     4,0 – 6,0 s   plan B, la caméra « découvre » des objets IMMOBILES
                   (aucune coupure attendue — c'est le faux positif à éviter,
                    celui qui a fait prendre 10,3 s pour une coupure sur Kerlabo)

   Prérequis : ffmpeg (ou FFMPEG_PATH), Chromium de Playwright.

     node tools/smoke/plansPage.mjs

   Sortie : code 0 si tous les contrôles passent. */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.SMOKE_PORT || 8801);
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;
const L = 320, H = 180, FPS = 25, DUREE = 6;
const T_COUPURE = 2.0;

let code = 0;
const dire = (ok, texte) => { if (!ok) code = 1; console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${texte}`); };
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

const dossier = mkdtempSync(join(tmpdir(), 'rx-plans-'));
const webm = join(dossier, 'plans.webm');
const sidecar = join(dossier, 'plans.json');
writeFileSync(sidecar, JSON.stringify({ schema: 'rx-extract/1', file: 'plans.webm', fps: FPS, clipStart: 0 }, null, 2));

/**
 * La vidéo témoin est enregistrée PAR LE NAVIGATEUR.
 *
 * ffmpeg fourni avec Playwright est réduit au strict nécessaire : ni
 * démultiplexeur `rawvideo`, ni décodeur PNG. `MediaRecorder` sur un canvas
 * donne un WebM VP8 que ce même navigateur saura relire — ce qui est
 * exactement ce qu'on veut mesurer.
 */
async function enregistrerTemoin(page) {
  const b64 = await page.evaluate(({ L, H, FPS, DUREE, T_COUPURE }) => new Promise((ok, ko) => {
    const c = document.createElement('canvas');
    c.width = L; c.height = H;
    const ctx = c.getContext('2d');
    const flux = c.captureStream(FPS);
    const morceaux = [];
    const rec = new MediaRecorder(flux, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4e6 });
    rec.ondataavailable = (e) => e.data.size && morceaux.push(e.data);
    rec.onerror = (e) => ko(new Error(String(e.error || e)));
    rec.onstop = async () => {
      const buf = new Uint8Array(await new Blob(morceaux, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
      ok(btoa(s));
    };

    const depart = performance.now();
    const peindre = () => {
      const t = (performance.now() - depart) / 1000;
      if (t >= DUREE) { rec.stop(); return; }
      const apres = t >= T_COUPURE;
      ctx.fillStyle = apres ? '#1a2896' : '#1e783c';
      ctx.fillRect(0, 0, L, H);
      // panoramique : une barre traverse le cadre, dans les DEUX plans
      const x = ((t % 2) / 2) * (L + 60) - 60;
      ctx.fillStyle = apres ? '#e6d73c' : '#c8372a';
      ctx.fillRect(x, 0, 60, H);
      // après 4 s, des objets IMMOBILES apparaissent un à un : le plan
      // s'élargit, ce n'est surtout pas une coupure
      if (t >= 4) {
        ctx.fillStyle = '#ebebeb';
        for (let i = 0; i < Math.min(6, Math.floor((t - 4) * 3) + 1); i++) ctx.fillRect(20 + i * 48, 12, 22, 22);
      }
      requestAnimationFrame(peindre);
    };
    rec.start();
    requestAnimationFrame(peindre);
  }), { L, H, FPS, DUREE, T_COUPURE });
  writeFileSync(webm, Buffer.from(b64, 'base64'));
}

// ── Le scan ─────────────────────────────────────────────
const serveur = spawn(process.execPath, ['tools/yolox-poc/serve.mjs'], {
  env: { ...process.env, YOLOX_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await attendre(900);
  const navigateur = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await navigateur.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/__plans`, { waitUntil: 'load' });
  await enregistrerTemoin(page);
  await page.reload({ waitUntil: 'load' });

  await page.setInputFiles('#pick', [webm, sidecar]);
  await page.waitForFunction(() => !document.getElementById('lancer').disabled, { timeout: 15000 });
  dire((await page.textContent('#etat')).includes(`${FPS} img/s`), `la cadence vient du sidecar (${FPS} img/s)`);

  await page.fill('#tDebut', '0.100');
  await page.fill('#tFin', '5.800');
  await page.click('#lancer');
  await page.waitForFunction(() => window.__plans, { timeout: 180000 });
  const r = await page.evaluate(() => window.__plans);

  dire(erreurs.length === 0, `aucune erreur JavaScript${erreurs.length ? ` — ${erreurs[0]}` : ''}`);
  dire(r.coupures.length === 1,
    `une seule coupure trouvée (${r.coupures.length} : ${r.coupures.map(c => c.t).join(', ') || 'aucune'})`);

  if (r.coupures.length) {
    const c = r.coupures[0];
    const ecart = Math.abs(c.t - T_COUPURE);
    // Tolérance large à dessein : `MediaRecorder` n'horodate pas à l'image
    // près. L'exactitude du calage image ↔ `currentTime` est mesurée
    // séparément, sur une vidéo construite image par image, par videoSeek.mjs.
    dire(ecart <= 0.2, `datée au bon endroit : t = ${c.t} s, attendu ${T_COUPURE} s (écart ${(ecart * 1000).toFixed(0)} ms)`);
    dire(c.avant < c.t && c.t - c.avant <= 2.5 / FPS, `l'image d'avant et celle d'après se touchent (${c.avant} → ${c.t})`);
    dire(c.rapport >= r.reglages.facteur, `le rapport au seuil local est franc (×${c.rapport} pour un facteur ${r.reglages.facteur})`);
  }

  const tardives = r.coupures.filter(c => c.t >= 3.9);
  dire(tardives.length === 0,
    `l'élargissement du plan à 4 s ne déclenche rien (${tardives.length ? tardives.map(c => c.t).join(', ') : 'rien'})`);
  const pano = r.distances.filter(x => x.t > 0.3 && x.t < 1.9);
  dire(pano.every(x => x.rapport < r.reglages.facteur),
    `le panoramique ne dépasse jamais son seuil local (rapport max ×${Math.max(...pano.map(x => x.rapport ?? 0)).toFixed(2)})`);
  dire(r.distances.every(x => x.seuil != null && x.reference != null), 'le seuil est publié pour chaque instant');

  await navigateur.close();
} catch (e) {
  code = 1;
  console.error('\x1b[31m✘\x1b[0m', e.message);
} finally {
  serveur.kill();
  rmSync(dossier, { recursive: true, force: true });
}

console.log(code === 0 ? '\nTous les contrôles passent.' : '\nAu moins un contrôle a échoué.');
process.exit(code);
