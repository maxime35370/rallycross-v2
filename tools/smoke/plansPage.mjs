/* CONTRÔLE DU SCAN DE PLANS — dans un vrai navigateur, sur une vraie vidéo.

   Fabrique une vidéo dont on connaît la vérité, puis vérifie que la page
   `/__plans` la retrouve :

     0,0 – 2,0 s   plan A, panoramique rapide  (aucune coupure attendue)
     2,0 – 2,4 s   FONDU ENCHAÎNÉ A → B, sur 10 images à 25 img/s
     2,4 – 4,0 s   plan B, panoramique
     4,0 – 6,0 s   plan B, la caméra « découvre » des objets IMMOBILES
                   (aucune coupure attendue — c'est le faux positif à éviter,
                    celui qui a fait prendre 10,3 s pour une coupure sur Kerlabo)

   Le fondu est le cas réel rencontré sur Kerlabo : la rupture existe, mais elle
   s'étale, et les images du milieu contiennent les DEUX plans en transparence.

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
const T_COUPURE = 2.0, DUREE_FONDU = 0.4;

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
  const b64 = await page.evaluate(({ L, H, FPS, DUREE, T_COUPURE, DUREE_FONDU }) => new Promise((ok, ko) => {
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
      // α du fondu : 0 avant, 1 après, linéaire entre les deux
      const alpha = Math.max(0, Math.min(1, (t - T_COUPURE) / DUREE_FONDU));
      const plan = (dest, apres) => {
        dest.fillStyle = apres ? '#1a2896' : '#1e783c';
        dest.fillRect(0, 0, L, H);
        // panoramique : une barre traverse le cadre, dans les DEUX plans
        const x = ((t % 2) / 2) * (L + 60) - 60;
        dest.fillStyle = apres ? '#e6d73c' : '#c8372a';
        dest.fillRect(x, 0, 60, H);
        // après 4 s, des objets IMMOBILES apparaissent un à un : le plan
        // s'élargit, ce n'est surtout pas une coupure
        if (apres && t >= 4) {
          dest.fillStyle = '#ebebeb';
          for (let i = 0; i < Math.min(6, Math.floor((t - 4) * 3) + 1); i++) dest.fillRect(20 + i * 48, 12, 22, 22);
        }
      };
      ctx.globalAlpha = 1; plan(ctx, false);
      if (alpha > 0) { ctx.globalAlpha = alpha; plan(ctx, true); ctx.globalAlpha = 1; }
      requestAnimationFrame(peindre);
    };
    rec.start();
    requestAnimationFrame(peindre);
  }), { L, H, FPS, DUREE, T_COUPURE, DUREE_FONDU });
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
  // La fenêtre d'analyse doit être plusieurs fois plus large que la transition :
  // le fondu témoin dure 0,40 s, des demi-fenêtres de 0,20 s ne peuvent pas le
  // contenir avec la marge nécessaire pour estimer la dérive de part et d'autre.
  await page.fill('#fenTrans', '0.50,0.70,0.90,1.20');
  await page.click('#lancer');
  await page.waitForFunction(() => window.__plans, { timeout: 180000 });
  const r = await page.evaluate(() => window.__plans);

  dire(erreurs.length === 0, `aucune erreur JavaScript${erreurs.length ? ` — ${erreurs[0]}` : ''}`);
  dire(r.coupures.length === 1,
    `une seule coupure trouvée (${r.coupures.length} : ${r.coupures.map(c => c.t).join(', ') || 'aucune'})`);

  if (r.coupures.length) {
    const c = r.coupures[0];
    const tr = c.transition;
    dire(!!tr, 'la transition est analysée image par image');
    if (tr) {
      dire(tr.fenetreSuffisante, 'la fenêtre contient des images propres des deux côtés');
      // MediaRecorder n'horodate pas à l'image près, et le fondu est encodé en
      // VP8 : deux images de marge de chaque côté.
      const attendu = DUREE_FONDU * FPS;
      dire(Math.abs(tr.imagesDeTransition - attendu) <= 4,
        `étendue du fondu : ${tr.imagesDeTransition} images pour ${attendu} attendues (${(tr.duree * 1000).toFixed(0)} ms)`);
      dire(tr.nature.includes('étalée'), `nature reconnue : ${tr.nature}`);
      const st = c.stabilite;
      dire(!!st && st.retenus >= 2, `plusieurs fenêtres exploitables (${st?.retenus ?? 0})`);
      if (st && st.retenus >= 2) {
        // Le défaut d'origine : 5 images à ±0,20 s et 56 à ±0,60 s sur la même
        // coupure. Les bornes doivent maintenant tenir dans quelques images.
        dire(st.dispersionAvant <= 5 / FPS,
          `borne AVANT stable d'une fenêtre à l'autre (${(st.dispersionAvant * 1000).toFixed(0)} ms)`);
        dire(st.dispersionApres <= 5 / FPS,
          `borne APRÈS stable d'une fenêtre à l'autre (${(st.dispersionApres * 1000).toFixed(0)} ms)`);
        console.log('  \x1b[90m→ ' + st.essais.map(e => `±${e.demiFenetre}s:${e.suffisante ? `${e.images}img/${Math.round(100 * e.reduction)}%` : 'écartée'}`).join('  ') + '\x1b[0m');
      }
      // La rampe doit expliquer nettement plus que la dérive seule.
      const expliquees = (st?.essais ?? []).filter(e => e.suffisante).map(e => e.reduction);
      dire(expliquees.length > 0 && Math.min(...expliquees) > 0.3,
        `la rampe explique bien plus que la dérive (min ${Math.round(100 * Math.min(...expliquees))} %)`);
      dire(tr.derniereImagePropreAvant.t <= T_COUPURE + 2 / FPS,
        `la dernière image propre précède le fondu (t = ${tr.derniereImagePropreAvant.t})`);
      dire(tr.premiereImagePropreApres.t >= T_COUPURE + DUREE_FONDU - 2 / FPS,
        `la première image propre suit le fondu (t = ${tr.premiereImagePropreApres.t})`);
      dire(st?.fiable === true, `mesure déclarée fiable${st?.fiable ? '' : ` — ${st?.raisons.join(' ; ')}`}`);
    }
    const ecart = Math.abs(c.t - (T_COUPURE + DUREE_FONDU));
    // Tolérance large à dessein : `MediaRecorder` n'horodate pas à l'image
    // près. L'exactitude du calage image ↔ `currentTime` est mesurée
    // séparément, sur une vidéo construite image par image, par videoSeek.mjs.
    dire(ecart <= 0.2, `l'instant retenu APRÈS est la sortie du fondu : t = ${c.t} s, attendu ${(T_COUPURE + DUREE_FONDU).toFixed(2)} s (écart ${(ecart * 1000).toFixed(0)} ms)`);
    dire(c.t - c.avant >= DUREE_FONDU - 3 / FPS,
      `les deux images retenues encadrent le fondu au lieu de se toucher (${c.avant} → ${c.t})`);
    dire(c.rapport >= r.reglages.facteur, `le rapport au seuil local est franc (×${c.rapport} pour un facteur ${r.reglages.facteur})`);
  }

  const tardives = r.coupures.filter(c => c.t >= 3.9);
  dire(tardives.length === 0,
    `l'élargissement du plan à 4 s ne déclenche rien (${tardives.length ? tardives.map(c => c.t).join(', ') : 'rien'})`);
  const pano = r.distances.filter(x => x.t > 0.3 && x.t < 1.9);
  dire(pano.every(x => x.rapport < r.reglages.facteur),
    `le panoramique ne dépasse jamais son seuil local (rapport max ×${Math.max(...pano.map(x => x.rapport ?? 0)).toFixed(2)})`);
  dire(r.distances.every(x => x.seuil != null && x.reference != null), 'le seuil est publié pour chaque instant');

  // Aucune borne ne doit sortir d'une rupture dont les fenêtres divergent.
  const incoherentes = r.coupures.filter(c => !c.stabilite?.fiable).map(c => c.tGrille);
  const publiees = (r.bornesPropres ?? []).map(b => b.rupture);
  dire(incoherentes.every(t => !publiees.includes(t)),
    `aucune borne produite pour une rupture non fiable (${incoherentes.length} écartée(s))`);
  dire(r.bornesPropres.every(b => b.dispersionBornes.every(d => d <= 3 / FPS + 1e-9)),
    'les bornes publiées viennent de fenêtres concordantes');

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
