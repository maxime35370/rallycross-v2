/* ═══════════════════════════════════════════════
   TURN1ANALYSIS.JS — Le classement au premier virage, dans l'application

   Ce panneau vit DANS « Analyse des départs », sous le lecteur. Il n'ouvre
   rien, ne télécharge rien, ne demande rien : la vidéo, les deux instants et
   la grille annoncée sont déjà là, à l'écran.

   Deux gestes : on regarde l'image du départ (la machine y numérote les
   voitures), puis on clique les voitures au virage dans l'ordre de passage.
   La machine dit ensuite laquelle est laquelle, et se tait quand elle doute.

   Le RAISONNEMENT est dans turn1AnalysisCalc.js, testé sans navigateur. Ici
   il n'y a que du DOM, du canvas et l'appel au détecteur.

   Tout reste local : aucune image ne quitte la machine.
═══════════════════════════════════════════════ */

import {
  MODELS, VEHICLE_CLASS_IDS, letterbox, buildGrids,
  decodeOutput, assertAnchorCount, mergeVehicleDetections,
} from './vision/detect.js';
import { signature } from './vision/apparence.js';
import {
  retirerEmboitees, deGaucheADroite, apparierVoitures, buildV1Proposal, grilleVueCamera,
} from './turn1AnalysisCalc.js';

// Le modèle « s » voit nettement mieux que « tiny » sur ces images de piste, et
// l'analyse ne porte que sur deux instants : la seconde gagnée ne vaut pas la
// voiture manquée.
const MODELE = 's';
const SEUIL = 0.30;
const PAS_BALAYAGE = 0.1;    // plus fin ne change pas OÙ le détecteur voit
const COULEURS = ['#ff3b30', '#34c759', '#0a84ff', '#ff9f0a', '#bf5af2', '#00c7be', '#ff2d92', '#a2845e'];

let ort = null;              // chargé à la demande : 8 Mo qu'on n'impose pas
let session = null;
let grilles = null;
let etat = null;             // { depart, v1, ordre, inverse }
let contexte = null;         // { video, grille, startAt, turn1At, startId, onProposal }

// ─────────────────────────────────────────────────────────
// CHARGEMENT À LA DEMANDE
// ─────────────────────────────────────────────────────────

/**
 * ONNX Runtime et le modèle ne sont pas des dépendances de l'application : ils
 * pèsent 8 et 35 Mo, et ne servent qu'ici. On ne les charge qu'au premier
 * usage, et on dit clairement quand ils manquent.
 */
async function moteur(dire) {
  if (session) return session;
  dire('chargement du détecteur…');
  if (!ort) {
    if (!window.ort) await charger('/__ort/ort.min.js');
    ort = window.ort;
    if (!ort) throw new Error('détecteur indisponible : lance l\'application avec le serveur local');
    ort.env.wasm.wasmPaths = '/__ort/';
    // Mesuré : le mono-thread ne coûte que 5 % sur cette charge — le temps
    // part dans le décodage vidéo. On ne réclame donc pas l'isolation
    // d'origine, qui casserait l'iframe YouTube du lecteur.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
    ort.env.logLevel = 'error';
  }
  const m = MODELS[MODELE];
  session = await ort.InferenceSession.create(`/__modele/${m.file}`, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  grilles = buildGrids(m.inputSize);
  return session;
}

function charger(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error(`${src} introuvable`));
    document.head.appendChild(s);
  });
}

// ─────────────────────────────────────────────────────────
// DÉTECTION
// ─────────────────────────────────────────────────────────

const cadre = document.createElement('canvas');
const tuile = document.createElement('canvas');
const cadreCtx = cadre.getContext('2d', { willReadFrequently: true });
const tuileCtx = tuile.getContext('2d', { willReadFrequently: true });

function allerA(video, t) {
  return new Promise((ok, ko) => {
    if (Math.abs(video.currentTime - t) < 1e-4) { ok(); return; }
    const fini = () => { video.removeEventListener('seeked', fini); ok(); };
    video.addEventListener('seeked', fini, { once: true });
    video.currentTime = t;
    setTimeout(() => ko(new Error(`déplacement bloqué à ${t.toFixed(2)} s`)), 15000);
  });
}

function preparer(src, size) {
  tuile.width = size; tuile.height = size;
  tuileCtx.fillStyle = '#727272';
  tuileCtx.fillRect(0, 0, size, size);
  const box = letterbox(src.width, src.height, size);
  tuileCtx.drawImage(src, 0, 0, src.width, src.height, 0, 0, box.width, box.height);
  const px = tuileCtx.getImageData(0, 0, size, size).data;
  const n = size * size, data = new Float32Array(3 * n);
  // Le modèle attend du BGR, pas du RGB.
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4 + 2]; data[n + i] = px[i * 4 + 1]; data[2 * n + i] = px[i * 4];
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, size, size]), ratio: box.ratio };
}

/** Détecte à l'instant `t`, et garde les pixels : l'apparence en a besoin. */
async function analyser(video, t, dire) {
  const s = await moteur(dire);
  const m = MODELS[MODELE];
  await allerA(video, t);
  cadre.width = video.videoWidth; cadre.height = video.videoHeight;
  cadreCtx.drawImage(video, 0, 0);
  const { tensor, ratio } = preparer(cadre, m.inputSize);
  const sortie = await s.run({ images: tensor });
  const brut = sortie[s.outputNames[0]].data;
  assertAnchorCount(brut.length, m.inputSize);
  const brutes = decodeOutput(brut, grilles, ratio, { scoreThreshold: SEUIL, classIds: VEHICLE_CLASS_IDS });
  const dets = mergeVehicleDetections(brutes, 0.45).filter(d => d.score >= SEUIL);
  const gardees = deGaucheADroite(retirerEmboitees(dets));
  return {
    t, largeur: cadre.width, hauteur: cadre.height,
    pixels: cadreCtx.getImageData(0, 0, cadre.width, cadre.height).data,
    emboitees: dets.length - gardees.length,
    dets: gardees.map(d => ({ box: d.box.map(Math.round), score: d.score, manuelle: false, exclue: false })),
  };
}

/** Où le détecteur voit-il le mieux ? Le hasard du timecode n'est pas un choix. */
async function balayer(video, centre, marge, dire) {
  const instants = [];
  for (let t = centre - marge; t <= centre + marge + 1e-9; t += PAS_BALAYAGE) {
    if (t >= 0) instants.push(Number(t.toFixed(3)));
  }
  let meilleur = null;
  for (const [i, t] of instants.entries()) {
    dire(`balayage ${i + 1}/${instants.length}…`);
    const r = await analyser(video, t, dire);
    if (!meilleur || r.dets.length > meilleur.dets.length) meilleur = r;
  }
  return meilleur;
}

// ─────────────────────────────────────────────────────────
// AFFICHAGE
// ─────────────────────────────────────────────────────────

const retenues = (e) => (e ? e.dets.filter(d => !d.exclue) : []);

function dessiner(canvas, e, etiquettes, actifs = null) {
  if (!canvas || !e) return;
  canvas.width = e.largeur; canvas.height = e.hauteur;
  const ctx = canvas.getContext('2d');
  cadreCtx.putImageData(new ImageData(new Uint8ClampedArray(e.pixels), e.largeur, e.hauteur), 0, 0);
  ctx.drawImage(cadre, 0, 0);
  ctx.lineWidth = Math.max(2, Math.round(e.largeur / 640));
  ctx.font = `${Math.max(14, Math.round(e.largeur / 55))}px system-ui, sans-serif`;

  e.dets.forEach((d, i) => {
    const rang = actifs ? actifs.indexOf(i) : retenues(e).indexOf(d);
    const vu = actifs ? rang >= 0 : !d.exclue;
    const [x1, y1, x2, y2] = d.box;
    ctx.strokeStyle = vu ? COULEURS[(rang < 0 ? i : rang) % COULEURS.length] : 'rgba(255,255,255,0.35)';
    ctx.setLineDash(vu ? [] : [6, 5]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    if (!vu) return;
    const texte = etiquettes[rang] ?? '';
    if (!texte) return;
    const l = ctx.measureText(texte).width + 10;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(x1, Math.max(0, y1 - 24), l, 24);
    ctx.fillStyle = '#fff';
    ctx.fillText(texte, x1 + 5, Math.max(17, y1 - 6));
  });
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────
// PANNEAU
// ─────────────────────────────────────────────────────────

export function panneauHtml() {
  return `
    <div class="t1a" id="t1a">
      <div class="t1a-head">
        <strong>🎬 Classement au premier virage</strong>
        <span class="t1a-etat" id="t1a-etat"></span>
      </div>
      <p class="t1a-sub">
        Vous désignez les voitures dans l'ordre de passage — c'est ce que l'œil fait bien.
        La machine dit <em>laquelle</em> est laquelle, en ensemble fermé sur la grille annoncée.
        Quand elle doute, elle le dit. Rien ne quitte cette machine.
      </p>
      <div class="t1a-actions">
        <button class="btn btn-primary" id="t1a-lancer">Analyser les deux instants</button>
        <button class="btn btn-secondary" id="t1a-inverser" disabled
          title="La caméra filme la grille de l'autre côté">⇄ Inverser la grille</button>
        <button class="btn btn-secondary" id="t1a-reset" disabled>Recommencer le pointage</button>
        <button class="btn btn-primary" id="t1a-valider" disabled>Reprendre ce classement</button>
      </div>
      <div class="t1a-vues">
        <div>
          <h4>Départ — la grille</h4>
          <p class="t1a-aide">Cliquez une boîte en trop pour l'écarter ; recliquez pour la reprendre.</p>
          <canvas class="t1a-vue" id="t1a-depart"></canvas>
        </div>
        <div>
          <h4>Premier virage — pointez dans l'ordre</h4>
          <p class="t1a-aide">Cliquez les voitures dans l'ordre de passage.
      Le détecteur en manque souvent une : <strong>tracez sa boîte à la souris</strong>.</p>
          <canvas class="t1a-vue" id="t1a-v1"></canvas>
        </div>
      </div>
      <div id="t1a-table"></div>
    </div>`;
}

/**
 * Branche le panneau.
 *
 * @param {object} ctx
 * @param {HTMLVideoElement} ctx.video — le lecteur déjà à l'écran
 * @param {object} ctx.grille — grille annoncée (rx-start-grid/1)
 * @param {Function} ctx.onProposal — reçoit le document rx-v1-order/1
 */
export function brancherPanneau(ctx) {
  contexte = ctx;
  etat = { depart: null, v1: null, ordre: [], inverse: false };

  const $ = (id) => document.getElementById(id);
  const dire = (t) => { const e = $('t1a-etat'); if (e) e.textContent = t; };

  $('t1a-lancer')?.addEventListener('click', async () => {
    const b = $('t1a-lancer');
    if (b) b.disabled = true;
    try {
      if (!contexte.video?.videoWidth) throw new Error('aucune vidéo chargée');
      if (contexte.startAt == null || contexte.turn1At == null) {
        throw new Error('marquez le départ (D) et le premier virage (V)');
      }
      etat.depart = await balayer(contexte.video, contexte.startAt, 0.5, dire);
      etat.v1 = await balayer(contexte.video, contexte.turn1At, 0.5, dire);
      etat.ordre = [];
      rendre();
      dire(`départ : ${etat.depart.dets.length} voiture(s) · virage : ${etat.v1.dets.length}`);
      ['t1a-inverser', 't1a-reset'].forEach(i => { const e = $(i); if (e) e.disabled = false; });
    } catch (err) {
      dire(err.message);
    } finally {
      if (b) b.disabled = false;
    }
  });

  $('t1a-inverser')?.addEventListener('click', () => { etat.inverse = !etat.inverse; rendre(); });
  $('t1a-reset')?.addEventListener('click', () => { etat.ordre = []; rendre(); });

  $('t1a-depart')?.addEventListener('click', (ev) => {
    const i = boiteSous($('t1a-depart'), etat.depart, ev);
    // Écarter à la main ce que le détecteur a trouvé en trop — une voiture
    // d'arrière-plan, un bout de stand. Explicite, donc jamais faux.
    if (i >= 0) { etat.depart.dets[i].exclue = !etat.depart.dets[i].exclue; rendre(); }
  });

  // Au virage, le détecteur manque souvent une voiture : de profil, derrière une
  // glissière, dans la poussière. Glisser trace sa boîte ; cliquer la pointe.
  // Sans ce geste, une voiture invisible pour le modèle serait absente du
  // classement — et c'est précisément là que le détecteur est le plus faible.
  const vueV1 = $('t1a-v1');
  let depart = null;
  vueV1?.addEventListener('mousedown', (ev) => { depart = coordonnees(vueV1, ev); });
  vueV1?.addEventListener('mouseup', (ev) => {
    if (!etat.v1 || !depart) { depart = null; return; }
    const fin = coordonnees(vueV1, ev);
    const [dx, dy] = [Math.abs(fin[0] - depart[0]), Math.abs(fin[1] - depart[1])];
    if (dx > 12 && dy > 12) {
      etat.v1.dets.push({
        box: [Math.min(depart[0], fin[0]), Math.min(depart[1], fin[1]),
          Math.max(depart[0], fin[0]), Math.max(depart[1], fin[1])].map(Math.round),
        score: null, manuelle: true, exclue: false,
      });
      etat.ordre.push(etat.v1.dets.length - 1);
    } else {
      const i = etat.v1.dets.findIndex(d => fin[0] >= d.box[0] && fin[0] <= d.box[2]
        && fin[1] >= d.box[1] && fin[1] <= d.box[3]);
      if (i >= 0) {
        const k = etat.ordre.indexOf(i);
        if (k >= 0) etat.ordre.splice(k, 1); else etat.ordre.push(i);
      }
    }
    depart = null;
    rendre();
  });

  $('t1a-valider')?.addEventListener('click', () => {
    const doc = proposition();
    if (doc) contexte.onProposal?.(doc);
  });
}

/** Coordonnées du clic dans le repère de l'image, pas du canvas affiché. */
function coordonnees(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  return [(ev.clientX - r.left) * canvas.width / r.width,
    (ev.clientY - r.top) * canvas.height / r.height];
}

function boiteSous(canvas, e, ev) {
  if (!canvas || !e) return -1;
  const [x, y] = coordonnees(canvas, ev);
  return e.dets.findIndex(d => x >= d.box[0] && x <= d.box[2] && y >= d.box[1] && y <= d.box[3]);
}

/** La grille annoncée, dans l'ordre où la caméra la voit. */
function grilleOrdonnee() {
  return grilleVueCamera(contexte?.grille?.drivers || [], contexte?.grille?.poleSide, etat.inverse);
}

function nomsParNumero() {
  const m = new Map();
  for (const d of contexte?.grille?.drivers || []) {
    const n = [d.firstName, d.lastName].filter(Boolean).join(' ').trim();
    if (d.carNumber != null && n) m.set(Number(d.carNumber), n);
  }
  return m;
}

function appariement() {
  if (!etat?.depart || !etat?.v1 || !etat.ordre.length) return null;
  const d = etat.depart, v = etat.v1;
  return apparierVoitures({
    signaturesDepart: retenues(d).map(x => signature(d.pixels, d.largeur, d.hauteur, x.box)),
    signaturesV1: etat.ordre.map(i => signature(v.pixels, v.largeur, v.hauteur, v.dets[i].box)),
    numeros: grilleOrdonnee().map(x => x.carNumber),
  });
}

function proposition() {
  const res = appariement();
  if (!res) return null;
  return buildV1Proposal({
    appariement: res,
    numeros: grilleOrdonnee().map(x => x.carNumber),
    noms: nomsParNumero(),
    startAt: etat.depart?.t, turn1At: etat.v1?.t,
    startId: contexte?.startId ?? null,
  });
}

/** Somme éparse des pixels : assez pour distinguer deux images, pour rien d'autre. */
function empreinte(e) {
  if (!e?.pixels) return null;
  let s = 0;
  for (let i = 0; i < e.pixels.length; i += 4000) s += e.pixels[i];
  return s;
}

function rendre() {
  const grille = grilleOrdonnee();
  // Point d'observation pour les contrôles en navigateur : sans lui, rien ne
  // permet de cliquer une boîte détectée depuis un test. En lecture seule, et
  // recalculé à chaque rendu — ce n'est pas un état, c'est un reflet.
  // Les deux instants ET une empreinte de chaque image : c'est ce qui permet de
  // constater qu'on compare bien deux images DIFFÉRENTES. Un déplacement vidéo
  // sans effet donnerait deux fois la même, et un classement sans valeur.
  window.__t1a_t = {
    depart: etat.depart?.t ?? null, v1: etat.v1?.t ?? null,
    empreinteDepart: empreinte(etat.depart), empreinteV1: empreinte(etat.v1),
  };
  window.__t1a = {
    depart: (etat.depart?.dets || []).map(d => ({ box: d.box, exclue: d.exclue })),
    v1: (etat.v1?.dets || []).map(d => ({ box: d.box, manuelle: d.manuelle })),
    ordre: [...etat.ordre],
    grille: grille.map(d => d.carNumber),
  };
  dessiner(document.getElementById('t1a-depart'), etat.depart,
    retenues(etat.depart).map((_, i) => {
      const d = grille[i];
      if (!d) return `${i + 1}`;
      const nom = [d.firstName, d.lastName].filter(Boolean).join(' ').trim();
      return nom ? `${d.carNumber} ${nom}` : String(d.carNumber ?? i + 1);
    }));

  const res = appariement();
  dessiner(document.getElementById('t1a-v1'), etat.v1,
    etat.ordre.map((_, r) => {
      const a = res?.[r];
      return a?.carNumber != null ? `P${r + 1} · ${a.carNumber}` : `P${r + 1} · ?`;
    }), etat.ordre);

  const table = document.getElementById('t1a-table');
  const valider = document.getElementById('t1a-valider');
  if (!res) {
    if (table) table.innerHTML = '';
    if (valider) valider.disabled = true;
    return;
  }
  const noms = nomsParNumero();
  const decidees = res.filter(r => r.carNumber != null).length;
  if (table) {
    table.innerHTML = `<p class="t1a-bilan">${decidees} décidée(s) · ${res.length - decidees} non décidée(s)</p>
      <table class="table t1a-table"><thead><tr>
        <th>Position</th><th>N°</th><th>Pilote</th><th>Distance</th><th>Écart au second</th><th></th>
      </tr></thead><tbody>${res.map(r => `<tr>
        <td>P${r.position}</td>
        <td>${r.carNumber ?? '<span class="t1a-doute">non décidée</span>'}</td>
        <td>${r.carNumber != null ? (noms.get(Number(r.carNumber)) ?? '') : ''}</td>
        <td>${r.distance != null ? r.distance.toFixed(3) : '—'}</td>
        <td>${(r.ecart * 100).toFixed(0)} %</td>
        <td>${r.raison ?? ''}</td></tr>`).join('')}</tbody></table>`;
  }
  if (valider) valider.disabled = decidees === 0;
}
