/* CONTRÔLE DE LA PAGE DE SUIVI — dans un vrai navigateur.

   Ne prétend pas suivre des voitures : sans l'extrait, il n'y a rien à suivre.
   Vérifie ce qui casse silencieusement quand on touche à `track.html` :

     • les modules importés par la page se résolvent tous ;
     • aucune erreur JavaScript au chargement ;
     • la sonde d'apparence, exécutée dans le navigateur sur une image
       fabriquée, sépare bien deux livrées et reconnaît la même deux fois.

   Le dernier point est le seul qui compte vraiment : `signature()` lit des
   pixels de `getImageData()`, et c'est exactement ce que les tests unitaires
   ne peuvent pas reproduire — ils fabriquent le tableau à la main.

     node tools/smoke/suiviPage.mjs

   Sortie : code 0 si tous les contrôles passent. */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = Number(process.env.SMOKE_PORT || 8799);
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

const serveur = spawn(process.execPath, ['tools/yolox-poc/serve.mjs'], {
  env: { ...process.env, YOLOX_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

let code = 0;
const dire = (ok, texte) => { if (!ok) code = 1; console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${texte}`); };

try {
  await attendre(900);
  const navigateur = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await navigateur.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/__suivi`, { waitUntil: 'load' });
  await attendre(600);

  dire(await page.locator('#sondeApparence').count() === 1, 'la case « sonde d\'apparence » est présente');
  dire(await page.locator('#lancer').count() === 1, 'le bouton d\'analyse est présent');

  // Les erreurs de RÉSEAU sur le modèle ONNX ne concernent pas ce contrôle :
  // le modèle n'est chargé qu'au moment d'analyser.
  const bloquantes = erreurs.filter(e => !/onnx|wasm|modele|Failed to load resource/i.test(e));
  dire(bloquantes.length === 0, `aucune erreur JavaScript au chargement${bloquantes.length ? ` — ${bloquantes[0]}` : ''}`);

  // Sonde d'apparence, sur des pixels réels produits par le navigateur.
  const resultat = await page.evaluate(async (port) => {
    const { signature, distance } = await import(`http://127.0.0.1:${port}/tools/yolox-poc/lib/apparence.mjs`);
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#555'; ctx.fillRect(0, 0, 300, 200);
    // deux « voitures » : l'une rouge à toit noir, l'autre bleue à toit blanc
    ctx.fillStyle = '#111'; ctx.fillRect(20, 40, 100, 30);
    ctx.fillStyle = '#c81e1e'; ctx.fillRect(20, 70, 100, 70);
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(170, 40, 100, 30);
    ctx.fillStyle = '#1e46c8'; ctx.fillRect(170, 70, 100, 70);
    const px = ctx.getImageData(0, 0, 300, 200).data;
    const a = signature(px, 300, 200, [20, 40, 120, 140]);
    const b = signature(px, 300, 200, [170, 40, 270, 140]);
    const aBis = signature(px, 300, 200, [23, 42, 123, 142]);   // même voiture, boîte décalée
    return { meme: distance(a, aBis), autre: distance(a, b), longueur: a?.length ?? 0 };
  }, PORT);

  dire(resultat.longueur > 0, `la signature est calculée sur des pixels du navigateur (${resultat.longueur} seaux)`);
  dire(resultat.meme < 0.25, `la même voiture reste proche d'elle-même (${resultat.meme})`);
  dire(resultat.autre > 0.6, `deux livrées différentes sont séparées (${resultat.autre})`);
  dire(resultat.autre > resultat.meme * 2, 'la séparation domine franchement la variation de cadrage');

  // Détection de plan, sur des images réellement peintes par le navigateur.
  const plans = await page.evaluate(async (port) => {
    const { signatureImage, detecterCoupures } = await import(`http://127.0.0.1:${port}/tools/yolox-poc/lib/apparence.mjs`);
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const peindre = (fond, barre, x) => {
      ctx.fillStyle = fond; ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = barre; ctx.fillRect(x, 0, 70, 180);
      return signatureImage(ctx.getImageData(0, 0, 320, 180).data, 320, 180);
    };
    const serie = [];
    // six images d'un panoramique, puis six d'un autre plan
    for (let i = 0; i < 6; i++) serie.push({ t: i, sig: peindre('#2f7a2f', '#c8402a', i * 40) });
    for (let i = 6; i < 12; i++) serie.push({ t: i, sig: peindre('#2a3f9e', '#e8d84a', (i - 6) * 40) });
    return detecterCoupures(serie).coupures.map(x => x.t);
  }, PORT);
  dire(plans.length === 1 && plans[0] === 6,
    `la coupure est vue à t = 6 et le panoramique ne déclenche rien (trouvé : ${plans.join(', ') || 'rien'})`);

  await navigateur.close();
} catch (e) {
  code = 1;
  console.error('\x1b[31m✘\x1b[0m', e.message);
} finally {
  serveur.kill();
}

console.log(code === 0 ? '\nTous les contrôles passent.' : '\nAu moins un contrôle a échoué.');
process.exit(code);
