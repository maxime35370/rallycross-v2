/* ═══════════════════════════════════════════════
   RUN.MJS — Banc de mesure du POC.

   Parcourt `images/`, exécute YOLOX, écrit :
     • out/annotated/*.png   — image + rectangles, pour archive
     • out/results.json      — détections brutes et temps
     • out/report.html       — RAPPORT INTERACTIF, autonome
                               C'est lui qui sert à établir la vérité terrain.

   Le banc ne décide RIEN. Il n'invente aucune vérité terrain : c'est un
   humain qui, dans le rapport, pointe les voitures ratées et les fausses
   détections. Rappel et précision sont calculés à partir de ces clics.

   Usage :
     node run.mjs                       modèle par défaut (yolox_tiny)
     node run.mjs --model yolox_s       autre modèle, MÊME corpus
     node run.mjs --score 0.25          seuil de score
     node run.mjs --rgb                 force RGB au lieu de BGR
     node run.mjs --all-classes         ne filtre pas sur les véhicules
═══════════════════════════════════════════════ */

import { readdirSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import * as ort from 'onnxruntime-web';
import { loadImage, preprocess, writeAnnotated } from './image.mjs';
import { postprocess, VEHICLE_IDS, COCO_CLASSES } from './decode.mjs';
import { buildReport } from './report.mjs';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

// ── Arguments ──────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes('--' + name);

const MODEL   = arg('model', 'yolox_tiny');
const SCORE   = Number(arg('score', '0.30'));
const IOU     = Number(arg('iou', '0.45'));
const ORDER   = flag('rgb') ? 'RGB' : 'BGR';
const CLASSES = flag('all-classes') ? null : VEHICLE_IDS;
const NET     = Number(arg('size', '416'));
const REPEAT  = Number(arg('repeat', '3'));

const MODEL_PATH = join('models', MODEL + '.onnx');
const IMG_DIR = 'images';
const OUT_DIR = join('out', MODEL);

// ── Corpus ─────────────────────────────────────────────
if (!existsSync(MODEL_PATH)) {
  console.error(`\n✗ Modèle introuvable : ${MODEL_PATH}`);
  console.error(`  Voir README.md § « Obtenir les modèles ».\n`);
  process.exit(1);
}

const EXT = new Set(['.jpg', '.jpeg', '.png']);
const files = existsSync(IMG_DIR)
  ? readdirSync(IMG_DIR).filter(f => EXT.has(extname(f).toLowerCase())).sort()
  : [];

if (files.length === 0) {
  console.error(`
✗ Aucune image dans ${IMG_DIR}/.

  Le banc est prêt, il manque le corpus. Voir README.md § « Constituer le
  corpus » — 10 à 15 images, au moins 3 départs, plusieurs angles, prises
  AU PREMIER VIRAGE et non sur la ligne de départ.
`);
  process.exit(1);
}

// Métadonnées facultatives : images/corpus.json
//   { "img01.jpg": { "start": "MQ2 série 3", "angle": "large", "difficulte": ["poussiere"] } }
const metaPath = join(IMG_DIR, 'corpus.json');
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

// ── Session ────────────────────────────────────────────
console.log(`\nModèle   : ${MODEL}  (${NET}×${NET})`);
console.log(`Seuils   : score ≥ ${SCORE}  ·  IoU NMS ${IOU}`);
console.log(`Canaux   : ${ORDER}`);
console.log(`Classes  : ${CLASSES ? CLASSES.map(i => COCO_CLASSES[i]).join(', ') : 'toutes'}`);
console.log(`Images   : ${files.length}\n`);

const session = await ort.InferenceSession.create(MODEL_PATH);
const inputName = session.inputNames[0];

// Préchauffage : la première inférence porte le coût de compilation WASM et
// fausserait la médiane si on la comptait.
{
  const warm = new ort.Tensor('float32', new Float32Array(3 * NET * NET), [1, 3, NET, NET]);
  await session.run({ [inputName]: warm });
}

mkdirSync(join(OUT_DIR, 'annotated'), { recursive: true });

const results = [];
for (const f of files) {
  const img = loadImage(join(IMG_DIR, f));
  const { tensor } = preprocess(img, NET, NET, ORDER);
  const input = new ort.Tensor('float32', tensor, [1, 3, NET, NET]);

  // Plusieurs passes : on retient la MÉDIANE, moins sensible qu'une moyenne
  // à un à-coup d'ordonnancement du conteneur.
  const times = [];
  let out;
  for (let r = 0; r < REPEAT; r++) {
    const t0 = performance.now();
    out = await session.run({ [inputName]: input });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];

  const o = out[session.outputNames[0]];
  const boxes = postprocess(o.data, o.dims, {
    srcW: img.width, srcH: img.height, netW: NET, netH: NET,
    scoreThreshold: SCORE, iouThreshold: IOU, classIds: CLASSES,
  });

  writeFileSync(join(OUT_DIR, 'annotated', basename(f, extname(f)) + '.png'),
                writeAnnotated(img, boxes));

  results.push({
    file: f,
    width: img.width, height: img.height,
    inferenceMs: Number(median.toFixed(1)),
    boxes: boxes.map(b => ({
      x1: +b.x1.toFixed(1), y1: +b.y1.toFixed(1), x2: +b.x2.toFixed(1), y2: +b.y2.toFixed(1),
      score: +b.score.toFixed(4), className: b.className,
      // Part de l'image occupée : c'est le facteur qu'on soupçonne le plus
      // d'expliquer les échecs (voiture lointaine = peu de pixels).
      areaPct: +(100 * (b.x2 - b.x1) * (b.y2 - b.y1) / (img.width * img.height)).toFixed(2),
    })),
    meta: meta[f] || null,
  });

  const scores = boxes.map(b => (b.score * 100).toFixed(0) + '%').join(' ');
  console.log(`  ${f.padEnd(28)} ${String(img.width)}×${img.height}  ` +
              `${String(boxes.length).padStart(2)} détections  ${median.toFixed(0)} ms   ${scores}`);
}

// ── Synthèse machine (PAS de rappel : il exige la vérité terrain) ──
const allTimes = results.map(r => r.inferenceMs).sort((a, b) => a - b);
const p = q => allTimes[Math.min(allTimes.length - 1, Math.floor(q * allTimes.length))];
const allScores = results.flatMap(r => r.boxes.map(b => b.score)).sort((a, b) => a - b);

const summary = {
  model: MODEL, netSize: NET, scoreThreshold: SCORE, iouThreshold: IOU,
  channelOrder: ORDER, classes: CLASSES ? CLASSES.map(i => COCO_CLASSES[i]) : 'all',
  images: results.length,
  totalDetections: results.reduce((s, r) => s + r.boxes.length, 0),
  inferenceMs: { median: p(0.5), p90: p(0.9), min: allTimes[0], max: allTimes[allTimes.length - 1] },
  scoreDistribution: allScores.length ? {
    min: +allScores[0].toFixed(3),
    median: +allScores[Math.floor(allScores.length / 2)].toFixed(3),
    max: +allScores[allScores.length - 1].toFixed(3),
  } : null,
  runtime: 'onnxruntime-web (WASM, 1 thread)',
};

writeFileSync(join(OUT_DIR, 'results.json'),
              JSON.stringify({ summary, results }, null, 2));
writeFileSync(join(OUT_DIR, 'report.html'),
              buildReport({ summary, results, imgDir: IMG_DIR }));

console.log(`
─────────────────────────────────────────────
  ${summary.totalDetections} détections sur ${summary.images} images
  Inférence : médiane ${summary.inferenceMs.median} ms · p90 ${summary.inferenceMs.p90} ms
  Scores    : ${summary.scoreDistribution
      ? `min ${summary.scoreDistribution.min} · médiane ${summary.scoreDistribution.median} · max ${summary.scoreDistribution.max}`
      : '—'}

  ⚠️  Rappel et précision ne sont PAS calculés ici : ils exigent la vérité
     terrain. Ouvre le rapport, pointe les voitures ratées et les fausses
     détections, les taux s'affichent alors.

  →  ${join(OUT_DIR, 'report.html')}
─────────────────────────────────────────────
`);
