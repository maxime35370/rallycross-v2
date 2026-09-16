/* CLASSEMENT AU PREMIER VIRAGE — deux instants, deux gestes.
   Voir v1.html pour l'intention. Rien ne sort de la machine. */

import {
  MODELS, DEFAULT_MODEL, VEHICLE_CLASS_IDS, letterbox, buildGrids,
  decodeOutput, assertAnchorCount, mergeVehicleDetections,
} from '/tools/yolox-poc/lib/detect.mjs';
import { signature, distance } from '/tools/yolox-poc/lib/apparence.mjs';
import { hungarian } from '/tools/yolox-poc/lib/track.mjs';
import {
  ouvrirCanal, messagePour, messageClassement,
  MSG_GRILLE, MSG_PRET,
} from '/js/analysisLink.js';

const ort = window.ort;
ort.env.wasm.wasmPaths = '/__ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
ort.env.logLevel = 'error';

const $ = (id) => document.getElementById(id);
const video = $('src');
const cadre = $('cadre'), cadreCtx = cadre.getContext('2d', { willReadFrequently: true });
const tuile = $('tuile'), tuileCtx = tuile.getContext('2d', { willReadFrequently: true });
const COULEURS = ['#ff3b30', '#34c759', '#0a84ff', '#ff9f0a', '#bf5af2', '#00c7be', '#ff2d92', '#a2845e'];

const selModele = $('modele');
selModele.innerHTML = Object.values(MODELS)
  .map(m => `<option value="${m.id}">${m.label} · ${m.inputSize} px</option>`).join('');
selModele.value = DEFAULT_MODEL;

const grilles = new Map();
const sessions = new Map();
const grillesDe = (size) => {
  if (!grilles.has(size)) grilles.set(size, buildGrids(size));
  return grilles.get(size);
};
async function session(m) {
  if (!sessions.has(m.id)) {
    sessions.set(m.id, await ort.InferenceSession.create(`/__modele/${m.file}`, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    }));
  }
  return sessions.get(m.id);
}

let sidecar = null, fps = 60;
// Grille annoncée venue de l'application : numéros ET noms. On reconnaît une
// déco bien plus vite qu'un numéro, souvent invisible sous l'angle de la caméra.
let grilleAnnoncee = null;      // { poleSide, drivers: [{carNumber, firstName, lastName, lane}] }
let etatDepart = null;          // { t, dets, pixels, largeur, hauteur }
let etatV1 = null;
let ordre = [];                 // indices des boîtes V1, dans l'ordre de passage
let startId = null;             // départ désigné par l'application, s'il y en a un

// ─────────────────────────────────────────────────────────
// VIDÉO ET DÉTECTION
// ─────────────────────────────────────────────────────────

function allerA(t) {
  return new Promise((ok, ko) => {
    if (Math.abs(video.currentTime - t) < 1e-4) { ok(); return; }
    const fini = () => { video.removeEventListener('seeked', fini); ok(); };
    video.addEventListener('seeked', fini, { once: true });
    video.currentTime = t;
    setTimeout(() => ko(new Error(`seek bloqué à ${t} s`)), 15000);
  });
}

function preparer(src, size) {
  tuile.width = size; tuile.height = size;
  tuileCtx.fillStyle = '#727272'; tuileCtx.fillRect(0, 0, size, size);
  const box = letterbox(src.width, src.height, size);
  tuileCtx.drawImage(src, 0, 0, src.width, src.height, 0, 0, box.width, box.height);
  const px = tuileCtx.getImageData(0, 0, size, size).data;
  const n = size * size, data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4 + 2]; data[n + i] = px[i * 4 + 1]; data[2 * n + i] = px[i * 4];
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, size, size]), ratio: box.ratio };
}

/** Détecte à l'instant `t` et rend les boîtes ET les pixels (pour l'apparence). */
async function analyser(t) {
  const modele = MODELS[selModele.value];
  const s = await session(modele);
  await allerA(t);
  cadre.width = video.videoWidth; cadre.height = video.videoHeight;
  cadreCtx.drawImage(video, 0, 0);
  const { tensor, ratio } = preparer(cadre, modele.inputSize);
  const sortie = await s.run({ images: tensor });
  const brut = sortie[s.outputNames[0]].data;
  assertAnchorCount(brut.length, modele.inputSize);
  const seuil = Number($('seuil').value);
  const brutes = decodeOutput(brut, grillesDe(modele.inputSize), ratio,
    { scoreThreshold: seuil, classIds: VEHICLE_CLASS_IDS });
  const dets = mergeVehicleDetections(brutes, 0.45).filter(d => d.score >= seuil);
  const pixels = cadreCtx.getImageData(0, 0, cadre.width, cadre.height).data;
  // Une boîte largement CONTENUE dans une autre n'est pas une voiture de plus :
  // c'est un morceau de celle du dessous. Sur cette grille le détecteur pose un
  // liseré de 131 × 52 px sur le pavillon d'une voiture — mesuré.
  const aire = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const contenue = (p, g) => {
    const i = Math.max(0, Math.min(p[2], g[2]) - Math.max(p[0], g[0]))
      * Math.max(0, Math.min(p[3], g[3]) - Math.max(p[1], g[1]));
    return aire(p) > 0 && i / aire(p) > 0.5;
  };
  const gardees = dets.filter(d => !dets.some(u => u !== d
    && aire(u.box) > aire(d.box) && contenue(d.box, u.box)));
  return {
    t, largeur: cadre.width, hauteur: cadre.height, pixels,
    emboitees: dets.length - gardees.length,
    dets: gardees
      .sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2]))
      .map(d => ({ box: d.box.map(Math.round), score: d.score, manuelle: false, exclue: false })),
  };
}

// ─────────────────────────────────────────────────────────
// BALAYAGE — quel instant le détecteur voit-il le mieux ?
// ─────────────────────────────────────────────────────────

async function balayer(centre, cible) {
  const marge = Number($('marge').value);
  // Un pas plus fin que 0,1 s ne change rien à ce qu'on cherche — savoir OÙ
  // le détecteur voit — et multiplie le temps d'attente par six.
  const pas = Math.max(0.1, 1 / fps);
  const instants = [];
  for (let t = centre - marge; t <= centre + marge + 1e-9; t += pas) {
    if (t < 0) continue;
    instants.push(Number(t.toFixed(3)));
  }
  const hote = $(cible);
  hote.innerHTML = '';
  const trouves = [];
  for (const t of instants) {
    const r = await analyser(t);
    trouves.push({ t, n: r.dets.length, score: r.dets.reduce((a, d) => a + d.score, 0) });
    hote.innerHTML = trouves.map(x => `<span class="pastille${x.n ? ' ok' : ' vide'}"
      data-t="${x.t}" data-cible="${cible}">${x.t.toFixed(2)} s · ${x.n}</span>`).join(' ');
  }
  // « Le plus de voitures » est un mauvais critère au DÉPART : au-delà de
  // l'effectif annoncé, une détection de plus est une détection de trop —
  // une voiture d'arrière-plan, un bout de stand. Quand la grille est connue,
  // on vise donc le bon COMPTE, et on départage au score.
  const attendu = cible === 'bDepart' ? numerosGrille().length : 0;
  const meilleur = [...trouves].sort((a, b) => {
    if (attendu) {
      const ea = Math.abs(a.n - attendu), eb = Math.abs(b.n - attendu);
      if (ea !== eb) return ea - eb;
    } else if (a.n !== b.n) return b.n - a.n;
    return b.score - a.score;
  })[0];
  if (meilleur) $(cible === 'bDepart' ? 'tDepart' : 'tV1').value = meilleur.t.toFixed(2);
  hote.querySelectorAll('.pastille').forEach(p => p.addEventListener('click', () => {
    $(p.dataset.cible === 'bDepart' ? 'tDepart' : 'tV1').value = Number(p.dataset.t).toFixed(2);
    rafraichir().catch(e => { $('etat').textContent = e.message; });
  }));
}

// ─────────────────────────────────────────────────────────
// RENDU DES DEUX VUES
// ─────────────────────────────────────────────────────────

function dessiner(canvas, etat, etiquettes, actifs = null) {
  canvas.width = etat.largeur; canvas.height = etat.hauteur;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(etat.pixels), etat.largeur, etat.hauteur), 0, 0);
  const e = canvas.width / 1920;
  etat.dets.forEach((d, i) => {
    const [x1, y1, x2, y2] = d.box;
    const rang = actifs ? actifs.indexOf(i) : i;
    const vu = !actifs || rang >= 0;
    // Une boîte pas encore pointée doit rester FRANCHEMENT visible : c'est elle
    // qu'on cherche des yeux pour cliquer dessus. Seule la couleur distingue.
    ctx.save();
    ctx.globalAlpha = d.exclue ? 0.3 : 1;
    ctx.strokeStyle = d.exclue ? '#8e8e93'
      : (vu ? COULEURS[(rang >= 0 ? rang : i) % COULEURS.length] : '#ffffff');
    ctx.lineWidth = (vu ? 4 : 3) * e;
    ctx.setLineDash(d.manuelle ? [10 * e, 6 * e] : []);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.restore();
    const txt = d.exclue ? '✕' : etiquettes(i, rang);
    if (!txt) return;
    ctx.font = `700 ${Math.round(30 * e)}px system-ui, sans-serif`;
    const w = ctx.measureText(txt).width + 22 * e, h = 40 * e;
    ctx.fillStyle = d.exclue ? '#8e8e93'
      : (vu ? COULEURS[(rang >= 0 ? rang : i) % COULEURS.length] : '#3a3a3c');
    ctx.fillRect(x1, Math.max(0, y1 - h), w, h);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x1 + 11 * e, Math.max(0, y1 - h) + h / 2);
  });
}

/** Nom court du pilote portant ce numéro, s'il est connu. */
function nomDe(carNumber) {
  const d = grilleAnnoncee?.drivers?.find(x => Number(x.carNumber) === Number(carNumber));
  if (!d) return null;
  return `${(d.firstName || '').charAt(0)}${d.firstName ? '. ' : ''}${d.lastName || ''}`.trim() || null;
}

const numerosGrille = () => $('grille').value.split(',')
  .map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);

/** Les boîtes du départ retenues, dans l'ordre gauche → droite. */
const retenuesDepart = () => etatDepart.dets.map((d, i) => ({ d, i })).filter(x => !x.d.exclue);

function rendreDepart() {
  if (!etatDepart) return;
  $('pDepart').style.display = '';
  const nums = numerosGrille();
  const rang = new Map(retenuesDepart().map((x, k) => [x.i, k]));
  dessiner($('vueDepart'), etatDepart, (i) => {
    const k = rang.get(i);
    if (k == null) return '';
    if (nums[k] == null) return `${k + 1}`;
    const nom = nomDe(nums[k]);
    return nom ? `${nums[k]} ${nom}` : `n°${nums[k]}`;
  });
  const lignes = etatDepart.dets.map((d, i) => {
    const k = rang.get(i);
    return `<tr${d.exclue ? ' style="opacity:.45"' : ''}>
      <td class="num">${k != null ? k + 1 : '—'}</td><td class="num">${k != null ? (nums[k] ?? '—') : 'écartée'}</td>
      <td>${k != null && nums[k] != null ? (nomDe(nums[k]) ?? '') : ''}</td>
      <td class="num">${d.score != null ? d.score.toFixed(2) : '—'}</td>
      <td class="num">${d.box[2] - d.box[0]}×${d.box[3] - d.box[1]}</td></tr>`;
  }).join('');
  const n = retenuesDepart().length;
  const ecart = nums.length && nums.length !== n
    ? `<p class="avert">⚠ ${n} voiture(s) retenue(s) pour ${nums.length} annoncée(s) —
       cliquez une boîte pour l'écarter, ou choisissez un autre instant.</p>` : '';
  const emboitees = etatDepart.emboitees
    ? `<p class="sub" style="margin:0 0 6px">${etatDepart.emboitees} boîte(s) emboîtée(s) dans une autre, écartée(s) d'office.</p>` : '';
  $('tableDepart').innerHTML = `${ecart}${emboitees}<table><thead><tr>
    <th>Position</th><th>N°</th><th>Pilote</th><th>Score</th><th>Taille</th></tr></thead><tbody>${lignes}</tbody></table>`;
}

function rendreV1() {
  if (!etatV1) return;
  $('pV1').style.display = '';
  dessiner($('vueV1'), etatV1, (i, rang) => (rang >= 0 ? `P${rang + 1}` : ''), ordre);
  $('etatV1').textContent = `${ordre.length} / ${etatV1.dets.length} voiture(s) pointée(s)`;
  $('exporter').disabled = ordre.length === 0 || !etatDepart;
  rendreAppariement();
}

// ─────────────────────────────────────────────────────────
// APPARIEMENT EN ENSEMBLE FERMÉ
// ─────────────────────────────────────────────────────────

const MARGE_MIN = 0.06;      // écart relatif minimal entre le meilleur et le second

/**
 * Qui est qui ? Affectation hongroise entre les voitures pointées au V1 et
 * celles de la grille, sur la seule apparence. Une paire dont le second
 * candidat est presque aussi bon n'est PAS posée : elle ressort « non décidée »,
 * et une case vide coûte moins cher qu'une case fausse.
 */
function apparier() {
  const nums = numerosGrille();
  if (!etatDepart || !etatV1 || !ordre.length || !nums.length) return null;

  const sigD = retenuesDepart().map(x => signature(etatDepart.pixels, etatDepart.largeur, etatDepart.hauteur, x.d.box));
  const sigV = ordre.map(i => signature(etatV1.pixels, etatV1.largeur, etatV1.hauteur, etatV1.dets[i].box));

  const INTERDIT = 9;
  const cout = sigV.map(sv => sigD.map(sd => (sv && sd ? distance(sv, sd) : INTERDIT)));
  const aff = hungarian(cout);

  return ordre.map((_, rang) => {
    const j = aff[rang];
    const ligne = cout[rang];
    const tries = [...ligne].map((c, k) => ({ c, k })).sort((a, b) => a.c - b.c);
    const meilleur = tries[0], second = tries[1];
    const ecart = second && meilleur.c > 0 ? (second.c - meilleur.c) / meilleur.c : 1;
    const decidable = j >= 0 && j < sigD.length && ligne[j] < INTERDIT && ecart >= MARGE_MIN;
    return {
      position: rang + 1,
      carNumber: decidable ? (nums[j] ?? null) : null,
      confiance: decidable ? Math.max(0, Math.min(1, ecart)) : 0,
      distance: j >= 0 ? ligne[j] : null,
      ecart,
      raison: decidable ? null : (ecart < MARGE_MIN ? 'deux candidats trop proches' : 'aucun candidat exploitable'),
    };
  });
}

function rendreAppariement() {
  const res = apparier();
  if (!res) { $('tableV1').innerHTML = ''; return; }
  const lignes = res.map(r => `<tr>
    <td class="num">P${r.position}</td>
    <td class="num">${r.carNumber ?? '<span class="avert">non décidée</span>'}</td>
    <td>${r.carNumber != null ? (nomDe(r.carNumber) ?? '') : ''}</td>
    <td class="num">${r.distance != null ? r.distance.toFixed(3) : '—'}</td>
    <td class="num">${(r.ecart * 100).toFixed(0)} %</td>
    <td>${r.raison ?? ''}</td></tr>`).join('');
  const decidees = res.filter(r => r.carNumber != null).length;
  $('tableV1').innerHTML = `<p class="sub" style="margin:0 0 6px">
      ${decidees} décidée(s) · ${res.length - decidees} non décidée(s)</p>
    <table><thead><tr><th>Position</th><th>N°</th><th>Pilote</th><th>Distance</th><th>Écart au second</th><th></th>
    </tr></thead><tbody>${lignes}</tbody></table>`;
}

// ─────────────────────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────────────────────

function coordonnees(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  return [(ev.clientX - r.left) * canvas.width / r.width, (ev.clientY - r.top) * canvas.height / r.height];
}

function installerDepart() {
  const c = $('vueDepart');
  c.addEventListener('click', (ev) => {
    if (!etatDepart) return;
    const [x, y] = coordonnees(c, ev);
    // On écarte à la main ce que le détecteur a trouvé en trop — une voiture
    // d'arrière-plan, un bout de stand. Explicite, donc jamais faux.
    const i = etatDepart.dets.findIndex(d => x >= d.box[0] && x <= d.box[2] && y >= d.box[1] && y <= d.box[3]);
    if (i < 0) return;
    etatDepart.dets[i].exclue = !etatDepart.dets[i].exclue;
    rendreDepart(); rendreV1();
  });
}

function installerPointage() {
  const c = $('vueV1');
  let depart = null;
  c.addEventListener('mousedown', (ev) => { depart = coordonnees(c, ev); });
  c.addEventListener('mouseup', (ev) => {
    if (!etatV1 || !depart) return;
    const fin = coordonnees(c, ev);
    const [dx, dy] = [Math.abs(fin[0] - depart[0]), Math.abs(fin[1] - depart[1])];
    if (dx > 12 && dy > 12) {
      // Glisser = tracer une boîte que le détecteur a manquée.
      etatV1.dets.push({
        box: [Math.min(depart[0], fin[0]), Math.min(depart[1], fin[1]),
          Math.max(depart[0], fin[0]), Math.max(depart[1], fin[1])].map(Math.round),
        score: null, manuelle: true,
      });
      ordre.push(etatV1.dets.length - 1);
    } else {
      // Cliquer = pointer la voiture, ou la retirer si elle l'était déjà.
      const i = etatV1.dets.findIndex(d => fin[0] >= d.box[0] && fin[0] <= d.box[2]
        && fin[1] >= d.box[1] && fin[1] <= d.box[3]);
      if (i < 0) { depart = null; return; }
      const k = ordre.indexOf(i);
      if (k >= 0) ordre.splice(k, 1); else ordre.push(i);
    }
    depart = null;
    rendreV1();
  });
}

async function rafraichir() {
  if (!video.src) return;
  $('etat').textContent = 'analyse…';
  etatDepart = await analyser(Number($('tDepart').value));
  etatV1 = await analyser(Number($('tV1').value));
  ordre = [];
  rendreDepart(); rendreV1();
  $('etat').textContent = `départ : ${etatDepart.dets.length} voiture(s) · V1 : ${etatV1.dets.length}`;
  window.__pret = true;
}

/**
 * Pose la grille annoncée : numéros, noms, et sens de lecture à l'image.
 *
 * Le couloir 1 est du côté du premier virage. Vu de la caméra, l'ordre
 * gauche → droite est donc l'un des deux sens : on propose, le bouton ⇄
 * corrige si la caméra filme de l'autre côté.
 */
function poserGrille(doc) {
  grilleAnnoncee = doc;
  const parCouloir = [...doc.drivers].sort((a, b) => (a.lane ?? 99) - (b.lane ?? 99));
  const ordreImage = doc.poleSide === 'right' ? parCouloir.reverse() : parCouloir;
  $('grille').value = ordreImage.map(d => d.carNumber).join(', ');
}

/** Charge un fichier vidéo, qu'il vienne du sélecteur ou du canal. */
async function chargerFilm(film) {
  video.src = URL.createObjectURL(film);
  if (video.readyState < 1) await new Promise(ok => video.addEventListener('loadedmetadata', ok, { once: true }));
  $('etat').textContent = `${video.videoWidth}×${video.videoHeight} · ${video.duration.toFixed(2)} s · ${fps} img/s`;
  window.__charge = true;
}

$('pick').addEventListener('change', async (e) => {
  const liste = Array.from(e.target.files);
  const film = liste.find(f => /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name) || f.type.startsWith('video/'));
  for (const j of liste.filter(f => /\.json$/i.test(f.name))) {
    const brut = JSON.parse(await j.text());
    if (brut?.schema === 'rx-extract/1') { sidecar = brut; fps = brut.fps || 60; }
    else if (brut?.schema === 'rx-start-grid/1' && Array.isArray(brut.drivers)) poserGrille(brut);
  }
  if (!film) { $('etat').textContent = 'aucune vidéo dans la sélection'; return; }
  await chargerFilm(film);
});

$('balayer').addEventListener('click', async () => {
  $('pBalayage').style.display = '';
  $('etat').textContent = 'balayage…';
  try {
    await balayer(Number($('tDepart').value), 'bDepart');
    await balayer(Number($('tV1').value), 'bV1');
    await rafraichir();
  } catch (err) { $('etat').textContent = err.message; }
});

$('inverser').addEventListener('click', () => {
  $('grille').value = numerosGrille().reverse().join(', ');
  rendreDepart(); rendreV1();
});

$('grille').addEventListener('input', () => { rendreDepart(); rendreV1(); });
$('reset').addEventListener('click', () => { ordre = []; rendreV1(); });

$('exporter').addEventListener('click', () => {
  const res = apparier() || [];
  const doc = {
    schema: 'rx-v1-order/1',
    extrait: sidecar ? { file: sidecar.file, youtubeId: sidecar.youtubeId ?? null } : null,
    startAt: Number($('tDepart').value),
    turn1At: Number($('tV1').value),
    methode: 'hsv-zonee/1 + hongrois, ensemble fermé sur la grille annoncée',
    grille: numerosGrille(),
    positions: res.map(r => ({
      carNumber: r.carNumber, turn1Pos: r.carNumber != null ? r.position : null,
      pilote: r.carNumber != null ? nomDe(r.carNumber) : null,
      confiance: Number(r.confiance.toFixed(3)), raison: r.raison,
    })).filter(p => p.carNumber != null || p.raison),
    startId,
    createdAt: new Date().toISOString(),
  };
  window.__export = doc;

  // Quand l'application nous a ouverts, le classement lui revient tout seul :
  // c'est le trajet utile. Le fichier reste là pour le cas où l'outil a été
  // ouvert seul, ou pour garder une trace.
  if (canal && startId != null) {
    canal.poster(messageClassement({ doc, startId }));
    $('etat').textContent = 'classement renvoyé à l\'application';
    return;
  }
  const a = document.createElement('a');
  a.download = `classement-v1-${doc.startAt}-${doc.turn1At}.json`;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  a.click();
});

installerDepart();
installerPointage();

// ─────────────────────────────────────────────────────────
// PONT AVEC L'APPLICATION
// Même origine, documents séparés : l'outil a besoin de l'isolation COOP/COEP
// que l'application ne peut pas poser sans casser l'iframe YouTube. Un
// `BroadcastChannel` traverse cette frontière — et transporte le FICHIER
// vidéo lui-même, par clonage. Rien ne passe par le réseau.
// ─────────────────────────────────────────────────────────
const canal = ouvrirCanal();

if (canal) {
  canal.ecouter(async (msg) => {
    if (!messagePour(msg, MSG_GRILLE)) return;
    startId = msg.startId ?? null;
    if (msg.grid?.drivers?.length) poserGrille(msg.grid);
    if (msg.sidecar?.schema === 'rx-extract/1') { sidecar = msg.sidecar; fps = msg.sidecar.fps || fps; }
    if (msg.startAt != null) $('tDepart').value = msg.startAt;
    if (msg.turn1At != null) $('tV1').value = msg.turn1At;
    if (msg.file) {
      $('etat').textContent = `${msg.file.name} — reçu de l'application`;
      await chargerFilm(msg.file);
    }
    window.__recu = { startId, grille: $('grille').value, startAt: msg.startAt, turn1At: msg.turn1At };
  });

  // L'application poste sa grille dès qu'elle nous ouvre ; à cet instant ce
  // document n'écoute pas encore. On annonce donc qu'on est là, et elle
  // renvoie. Sans cette poignée de main, le premier message se perd.
  canal.poster({ type: MSG_PRET, envoi: Date.now() });
  window.addEventListener('pagehide', () => canal.fermer());
}
