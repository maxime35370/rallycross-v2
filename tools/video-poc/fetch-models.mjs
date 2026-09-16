/* Télécharge les exports ONNX officiels de YOLOX (Megvii, Apache 2.0).
   Les poids ne sont PAS versionnés : ~20 Mo et ~35 Mo.

   Usage :  node fetch-models.mjs               (yolox_tiny)
            node fetch-models.mjs yolox_s       (le second modèle, si besoin)
            node fetch-models.mjs --validation  (images publiques de contrôle)  */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0';
const MODELS = {
  // taille d'entrée de l'export officiel — yolox_s est en 640, pas en 416
  yolox_tiny:  { size: 416, mb: 20 },
  yolox_s:     { size: 640, mb: 35 },
  yolox_nano:  { size: 416, mb: 10 },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : ['yolox_tiny'];
mkdirSync('models', { recursive: true });

for (const name of want) {
  if (!MODELS[name]) {
    console.error(`✗ modèle inconnu : ${name}. Connus : ${Object.keys(MODELS).join(', ')}`);
    process.exitCode = 1;
    continue;
  }
  const dest = join('models', name + '.onnx');
  if (existsSync(dest)) {
    console.log(`• ${name} déjà présent (${(statSync(dest).size / 1e6).toFixed(1)} Mo)`);
    continue;
  }
  const url = `${RELEASE}/${name}.onnx`;
  process.stdout.write(`↓ ${name} (~${MODELS[name].mb} Mo) … `);
  const r = await fetch(url);
  if (!r.ok) { console.log(`échec HTTP ${r.status}`); process.exitCode = 1; continue; }
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`${(statSync(dest).size / 1e6).toFixed(1)} Mo  →  ${dest}`);
  console.log(`  entrée ${MODELS[name].size}×${MODELS[name].size} → lancer avec  --model ${name} --size ${MODELS[name].size}`);
}


// ─────────────────────────────────────────────────────────
// IMAGES DE VALIDATION TECHNIQUE
//
// Contenu connu, donc utiles pour vérifier que la chaîne n'a pas dérivé
// (alignement des boîtes, ordre des canaux) après une modification.
// Elles ne disent RIEN de la performance en rallycross : objets nets,
// proches, en pleine lumière. Ne jamais les compter dans le corpus.
// ─────────────────────────────────────────────────────────
if (process.argv.includes('--validation')) {
  const ASSETS = {
    'dog.jpg':    'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/main/assets/dog.jpg',
    'bus.jpg':    'https://raw.githubusercontent.com/ultralytics/yolov5/master/data/images/bus.jpg',
    'zidane.jpg': 'https://raw.githubusercontent.com/ultralytics/yolov5/master/data/images/zidane.jpg',
  };
  mkdirSync(join('images', '_validation'), { recursive: true });
  for (const [name, url] of Object.entries(ASSETS)) {
    const dest = join('images', '_validation', name);
    if (existsSync(dest)) { console.log(`• ${name} déjà présent`); continue; }
    const r = await fetch(url);
    if (!r.ok) { console.log(`✗ ${name} : HTTP ${r.status}`); continue; }
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    console.log(`↓ ${name}  →  ${dest}`);
  }
  console.log('\n  Pour contrôler la chaîne :');
  console.log('    cp images/_validation/*.jpg images/ && npm run detect -- --all-classes');
  console.log('    (attendu : dog.jpg → bicycle ~88 %, dog ~51 % · bus.jpg → bus ~94 % + 3 personnes)');
  console.log('    puis vider images/ avant de déposer le vrai corpus.\n');
}
