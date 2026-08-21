import { describe, it, expect } from 'vitest';
import {
  parseVideoSource, resolveStartTime, youtubeIdOfMeetingVideo,
  estimateFps, normalizeFps, frameDuration, clampTime, stepTime, frameOf,
  parseExtractSidecar, pairExtractFiles, EXTRACT_SCHEMA,
  formatPreciseTime, parsePreciseTime,
  YOUTUBE_RATES, LOCAL_RATES, ratesFor, nextRate,
  computeVideoRect, projectBox, normalizeBox, sanitizeBoxes, boxLabelText,
  keyboardAction, neighbourStartId, buildVideoBlock,
  COMMON_FPS, DEFAULT_FPS,
} from '../js/videoPlayerCalc.js';

// ─────────────────────────────────────────────────────────
// SOURCES
// ─────────────────────────────────────────────────────────

describe('parseVideoSource', () => {
  it('reconnaît les formes courantes d\'URL YouTube', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ]) {
      expect(parseVideoSource(url)).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
    }
  });

  it('récupère le timecode contenu dans le lien', () => {
    expect(parseVideoSource('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s').startAt).toBe(3723);
    expect(parseVideoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90').startAt).toBe(90);
  });

  it('renvoie null sur une entrée qui n\'est pas une vidéo YouTube', () => {
    expect(parseVideoSource('')).toBeNull();
    expect(parseVideoSource('https://example.com/course.mp4')).toBeNull();
  });
});

describe('youtubeIdOfMeetingVideo', () => {
  const videos = [
    { id: 'v-abc', url: 'https://youtu.be/dQw4w9WgXcQ' },
    { id: 'v-def', url: 'pas une vidéo' },
  ];

  it('résout l\'identifiant LOCAL en identifiant YouTube', () => {
    expect(youtubeIdOfMeetingVideo(videos, 'v-abc')).toBe('dQw4w9WgXcQ');
  });

  it('ne confond jamais l\'identifiant local avec un identifiant YouTube', () => {
    // 'v-abc' n'est PAS un id YouTube : le renvoyer chargerait une vidéo au hasard.
    expect(youtubeIdOfMeetingVideo(videos, 'v-def')).toBeNull();
    expect(youtubeIdOfMeetingVideo(videos, 'inconnu')).toBeNull();
    expect(youtubeIdOfMeetingVideo(null, 'v-abc')).toBeNull();
  });
});

describe('resolveStartTime', () => {
  const meetingVideos = [{ id: 'v1', url: 'https://youtu.be/dQw4w9WgXcQ' }];
  const meetingTimecodes = { MQ1__Supercar: { videoId: 'v1', seconds: 1118 } };
  const base = { sessionType: 'MQ', sessionNum: 1, category: 'Supercar', meetingVideos, meetingTimecodes };

  it('donne la priorité au timecode propre au départ', () => {
    const r = resolveStartTime({ ...base, startIndex: 3, analysisVideo: { startAt: 1450.25, youtubeId: 'abc12345678' } });
    expect(r).toMatchObject({ seconds: 1450.25, source: 'start', approximate: false });
  });

  it('retombe sur le timecode du meeting quand le départ n\'en a pas', () => {
    const r = resolveStartTime({ ...base, startIndex: 0, analysisVideo: null });
    expect(r).toMatchObject({ seconds: 1118, source: 'meeting', youtubeId: 'dQw4w9WgXcQ' });
  });

  it('signale que le timecode du meeting ne vise que la 1ʳᵉ série', () => {
    expect(resolveStartTime({ ...base, startIndex: 0 }).approximate).toBe(false);
    expect(resolveStartTime({ ...base, startIndex: 2 }).approximate).toBe(true);
  });

  it('n\'invente aucun timecode quand rien n\'est connu', () => {
    const r = resolveStartTime({
      sessionType: 'FIN', sessionNum: null, category: 'Supercar',
      meetingTimecodes: {}, meetingVideos: [],
    });
    expect(r).toMatchObject({ seconds: null, source: 'none', youtubeId: null });
  });

  it('garde la vidéo du meeting même sans timecode utilisable', () => {
    const r = resolveStartTime({ ...base, meetingTimecodes: { MQ1__Supercar: { videoId: 'v1' } } });
    expect(r.seconds).toBeNull();
    expect(r.youtubeId).toBe('dQw4w9WgXcQ');
  });
});

// ─────────────────────────────────────────────────────────
// TEMPS
// ─────────────────────────────────────────────────────────

describe('estimateFps', () => {
  it('recale une mesure bruitée sur une cadence standard', () => {
    const deltas = [0.0401, 0.0399, 0.04, 0.0402, 0.0398, 0.04, 0.04, 0.0401];
    expect(estimateFps(deltas)).toBe(25);
  });

  it('reconnaît le 29,97 malgré des images doublées', () => {
    const d = 1 / 29.97;
    const deltas = [d, d, d * 2, d, d, d, 0, d, d];   // une image doublée, un écart nul
    expect(estimateFps(deltas)).toBe(29.97);
  });

  it('refuse de conclure sur trop peu de mesures', () => {
    expect(estimateFps([0.04, 0.04])).toBeNull();
    expect(estimateFps([])).toBeNull();
  });

  it('renvoie la valeur brute quand elle ne colle à aucun standard', () => {
    const fps = estimateFps([0.125, 0.125, 0.125, 0.125]);
    expect(fps).toBeCloseTo(8, 3);
    expect(COMMON_FPS).not.toContain(fps);
  });
});

describe('estimateFps — résistance aux images sautées', () => {
  it('retrouve 60 alors que la majorité des images est sautée', () => {
    // Cas réel : un extrait 1080p60 présenté en partie à 30 img/s. La médiane
    // tombait sur 1/30 et renvoyait 30 — une valeur « plausible », donc une
    // erreur silencieuse. Le quartile bas retrouve la bonne cadence, parce que
    // la présentation ne peut que PERDRE des images, jamais en inventer.
    const deltas = [...Array(8).fill(1 / 60), ...Array(12).fill(2 / 60)];
    expect(estimateFps(deltas)).toBe(60);
  });

  it('ne transforme pas une vraie vidéo à 30 en 60', () => {
    expect(estimateFps(Array(20).fill(1 / 30))).toBe(30);
  });

  it('reste juste sur une cadence propre', () => {
    expect(estimateFps(Array(20).fill(1 / 50))).toBe(50);
    expect(estimateFps(Array(20).fill(1001 / 30000))).toBe(29.97);
  });
});

describe('parseExtractSidecar', () => {
  const valide = {
    schema: 'rx-extract/1', fps: 60, clipStart: 20543, sourceStart: 20546,
    v1At: 20554, youtubeId: '_SqxZQl5zzQ', file: 'Kerlabo.mp4',
    serie: 4, sessionType: 'MQ', sessionNum: 3, category: 'D3', location: 'Kerlabo',
  };

  it('lit un sidecar produit par tools/extract-manche', () => {
    const r = parseExtractSidecar(JSON.stringify(valide));
    expect(r).toMatchObject({ fps: 60, clipStart: 20543, v1At: 20554, serie: 4, category: 'D3' });
  });

  it('refuse tout ce qui n\'est pas ce schéma', () => {
    // Un JSON quelconque déposé par erreur ne doit pas imposer une cadence.
    expect(parseExtractSidecar(JSON.stringify({ fps: 60 }))).toBeNull();
    expect(parseExtractSidecar(JSON.stringify({ ...valide, schema: 'autre/2' }))).toBeNull();
    expect(parseExtractSidecar('pas du json')).toBeNull();
    expect(parseExtractSidecar('')).toBeNull();
    expect(parseExtractSidecar(null)).toBeNull();
  });

  it('neutralise une cadence absurde plutôt que de la propager', () => {
    expect(parseExtractSidecar(JSON.stringify({ ...valide, fps: 0 })).fps).toBeNull();
    expect(parseExtractSidecar(JSON.stringify({ ...valide, fps: 'soixante' })).fps).toBeNull();
    expect(EXTRACT_SCHEMA).toBe('rx-extract/1');
  });
});

describe('pairExtractFiles', () => {
  const f = (name, type = '') => ({ name, type });

  it('apparie la vidéo et son sidecar par le nom de base', () => {
    const r = pairExtractFiles([f('autre.json'), f('K_Q3_S4.mp4'), f('K_Q3_S4.json')]);
    expect(r.video.name).toBe('K_Q3_S4.mp4');
    expect(r.sidecar.name).toBe('K_Q3_S4.json');
  });

  it('accepte un couple unique même si les noms diffèrent', () => {
    const r = pairExtractFiles([f('manche.mp4'), f('description.json')]);
    expect(r.sidecar.name).toBe('description.json');
  });

  it('n\'apparie rien quand le choix est ambigu', () => {
    const r = pairExtractFiles([f('a.mp4'), f('b.mp4'), f('x.json'), f('y.json')]);
    expect(r.video.name).toBe('a.mp4');
    expect(r.sidecar).toBeNull();
  });

  it('reconnaît une vidéo par son type quand l\'extension est inhabituelle', () => {
    expect(pairExtractFiles([f('rush', 'video/mp4')]).video.name).toBe('rush');
  });

  it('supporte une sélection vide ou sans vidéo', () => {
    expect(pairExtractFiles([])).toEqual({ video: null, sidecar: null });
    expect(pairExtractFiles([f('seul.json')]).sidecar.name).toBe('seul.json');
    expect(pairExtractFiles(undefined)).toEqual({ video: null, sidecar: null });
  });
});

describe('normalizeFps — cadence ANNONCÉE (sidecar ffprobe)', () => {
  it('accepte une cadence plausible et l\'arrondit à 3 décimales', () => {
    expect(normalizeFps(50)).toBe(50);
    expect(normalizeFps('25')).toBe(25);
    expect(normalizeFps(30000 / 1001)).toBe(29.97);   // même valeur qu'estimateFps
    expect(normalizeFps(23.976023976)).toBe(23.976);
  });

  it('refuse ce qui n\'est pas une cadence — jamais de valeur par défaut', () => {
    // Renvoyer DEFAULT_FPS ici recréerait exactement le repli silencieux que
    // cette fonction existe pour supprimer.
    for (const bad of [0, -25, null, undefined, '', 'cinquante', NaN, Infinity, 5000]) {
      expect(normalizeFps(bad)).toBeNull();
    }
  });

  it('ne recale sur aucune valeur standard, contrairement à estimateFps', () => {
    // Elle vient de ffprobe : elle est exacte, il n'y a rien à corriger.
    expect(normalizeFps(48)).toBe(48);
    expect(normalizeFps(19.5)).toBe(19.5);
  });
});

describe('frameDuration / frameOf', () => {
  it('calcule la durée d\'une image', () => {
    expect(frameDuration(25)).toBeCloseTo(0.04, 9);
    expect(frameDuration(50)).toBeCloseTo(0.02, 9);
  });

  it('retombe sur la cadence par défaut si elle est inconnue', () => {
    expect(frameDuration(null)).toBeCloseTo(1 / DEFAULT_FPS, 9);
    expect(frameDuration(0)).toBeCloseTo(1 / DEFAULT_FPS, 9);
  });

  it('donne l\'image AFFICHÉE à un instant, jamais la suivante', () => {
    expect(frameOf(0, 25)).toBe(0);
    expect(frameOf(0.039, 25)).toBe(0);
    expect(frameOf(0.04, 25)).toBe(1);
    expect(frameOf(1, 25)).toBe(25);
  });
});

describe('clampTime', () => {
  it('borne à [0, durée]', () => {
    expect(clampTime(-5, 100)).toBe(0);
    expect(clampTime(150, 100)).toBe(100);
    expect(clampTime(42, 100)).toBe(42);
  });

  it('accepte une durée inconnue', () => {
    expect(clampTime(9999, undefined)).toBe(9999);
    expect(clampTime(-1, undefined)).toBe(0);
  });

  it('ne propage jamais NaN', () => {
    expect(clampTime(NaN, 100)).toBe(0);
    expect(clampTime('abc', 100)).toBe(0);
  });
});

describe('stepTime', () => {
  it('avance et recule d\'une image', () => {
    expect(stepTime(10, { direction: +1, mode: 'frame', fps: 25 })).toBeCloseTo(10.04, 9);
    expect(stepTime(10, { direction: -1, mode: 'frame', fps: 25 })).toBeCloseTo(9.96, 9);
  });

  it('applique les pas courts, moyens et longs', () => {
    expect(stepTime(10, { direction: +1, mode: 'small'  })).toBeCloseTo(10.2, 9);
    expect(stepTime(10, { direction: +1, mode: 'medium' })).toBeCloseTo(11, 9);
    expect(stepTime(10, { direction: +1, mode: 'large'  })).toBeCloseTo(15, 9);
  });

  it('ne sort jamais de la vidéo', () => {
    expect(stepTime(0.01, { direction: -1, mode: 'large' })).toBe(0);
    expect(stepTime(99, { direction: +1, mode: 'large', duration: 100 })).toBe(100);
  });
});

describe('formatPreciseTime', () => {
  it('affiche les millisecondes, indispensables pour caler une image', () => {
    expect(formatPreciseTime(83.456)).toBe('1:23.456');
    expect(formatPreciseTime(3723.4)).toBe('1:02:03.400');
    expect(formatPreciseTime(0)).toBe('0:00.000');
  });

  it('ajoute le numéro d\'image quand la cadence est connue', () => {
    expect(formatPreciseTime(2, { fps: 25, frames: true })).toBe('0:02.000 (f50)');
  });

  it('n\'affiche rien d\'exploitable pour une valeur absente', () => {
    expect(formatPreciseTime(null)).toBe('—');
    expect(formatPreciseTime(-1)).toBe('—');
  });
});

describe('parsePreciseTime', () => {
  it('relit ce que formatPreciseTime a écrit', () => {
    for (const s of [0, 12.5, 83.456, 3723.4]) {
      expect(parsePreciseTime(formatPreciseTime(s))).toBeCloseTo(s, 3);
    }
  });

  it('accepte la virgule décimale', () => {
    expect(parsePreciseTime('1:23,5')).toBeCloseTo(83.5, 6);
  });

  it('renvoie null plutôt que 0 sur une saisie invalide', () => {
    // Renvoyer 0 transformerait une faute de frappe en « début de la vidéo ».
    for (const bad of ['', 'abc', '1:99', '1:2:99', null, '--']) {
      expect(parsePreciseTime(bad)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────
// VITESSES
// ─────────────────────────────────────────────────────────

describe('vitesses de lecture', () => {
  it('n\'offre sur YouTube que les vitesses réellement acceptées', () => {
    expect(ratesFor('youtube')).toEqual(YOUTUBE_RATES);
    expect(YOUTUBE_RATES).not.toContain(0.1);   // refusé par l'API YouTube
  });

  it('descend plus bas sur un fichier local', () => {
    expect(ratesFor('file')).toEqual(LOCAL_RATES);
    expect(LOCAL_RATES).toContain(0.1);
  });

  it('progresse d\'un cran sans sortir des bornes', () => {
    expect(nextRate(LOCAL_RATES, 1, -1)).toBe(0.75);
    expect(nextRate(LOCAL_RATES, 1, +1)).toBe(1.5);
    expect(nextRate(LOCAL_RATES, 0.1, -1)).toBe(0.1);
    expect(nextRate(LOCAL_RATES, 2, +1)).toBe(2);
  });

  it('repart de la vitesse la plus proche si la courante n\'est pas dans la liste', () => {
    // Cas réel : on passe d'un fichier local à ×0,1 vers une vidéo YouTube.
    expect(nextRate(YOUTUBE_RATES, 0.1, +1)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────
// ALIGNEMENT DE L'OVERLAY
// ─────────────────────────────────────────────────────────

describe('computeVideoRect — alignement du canvas sur l\'image', () => {
  it('remplit exactement un conteneur au même ratio', () => {
    expect(computeVideoRect(1600, 900, 1920, 1080))
      .toMatchObject({ x: 0, y: 0, width: 1600, height: 900 });
  });

  it('centre horizontalement quand le conteneur est trop large', () => {
    const r = computeVideoRect(2000, 900, 1920, 1080);
    expect(r.height).toBe(900);
    expect(r.width).toBe(1600);
    expect(r.x).toBe(200);
    expect(r.y).toBe(0);
  });

  it('centre verticalement quand le conteneur est trop haut', () => {
    const r = computeVideoRect(1600, 1200, 1920, 1080);
    expect(r.width).toBe(1600);
    expect(r.height).toBe(900);
    expect(r.x).toBe(0);
    expect(r.y).toBe(150);
  });

  it('suit un changement de ratio de la vidéo (4:3 dans un cadre 16:9)', () => {
    const r = computeVideoRect(1600, 900, 640, 480);
    expect(r.height).toBe(900);
    expect(r.width).toBe(1200);
    expect(r.x).toBe(200);
  });

  it('reste stable au redimensionnement : même position relative', () => {
    const box = { x: 0.25, y: 0.5, width: 0.1, height: 0.2 };
    const petit = projectBox(box, computeVideoRect(800, 450, 1920, 1080));
    const grand = projectBox(box, computeVideoRect(1600, 900, 1920, 1080));
    expect(grand.x).toBeCloseTo(petit.x * 2, 6);
    expect(grand.width).toBeCloseTo(petit.width * 2, 6);
  });

  it('ne produit rien plutôt qu\'un rectangle absurde sur des tailles invalides', () => {
    expect(computeVideoRect(0, 900, 1920, 1080)).toMatchObject({ width: 0, height: 0, scale: 0 });
    expect(computeVideoRect(1600, 900, 0, 0)).toMatchObject({ width: 0, height: 0 });
  });
});

describe('projectBox / normalizeBox', () => {
  const rect = computeVideoRect(2000, 900, 1920, 1080);   // bandes noires à gauche/droite

  it('place une boîte normalisée dans l\'image, pas dans les bandes noires', () => {
    const p = projectBox({ x: 0, y: 0, width: 1, height: 1 }, rect);
    expect(p.x).toBe(200);
    expect(p.width).toBe(1600);
  });

  it('fait l\'aller-retour sans perte', () => {
    const box = { x: 0.31, y: 0.62, width: 0.12, height: 0.2 };
    const back = normalizeBox(projectBox(box, rect), rect);
    expect(back.x).toBeCloseTo(box.x, 9);
    expect(back.y).toBeCloseTo(box.y, 9);
    expect(back.width).toBeCloseTo(box.width, 9);
    expect(back.height).toBeCloseTo(box.height, 9);
  });

  it('ne divise pas par zéro sur un rectangle vide', () => {
    expect(normalizeBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 }))
      .toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('sanitizeBoxes', () => {
  it('conserve une boîte valide et normalise son statut', () => {
    const [b] = sanitizeBoxes([{ driverId: 'd1', carNumber: 12, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]);
    expect(b).toMatchObject({ driverId: 'd1', carNumber: 12, status: 'unknown' });
  });

  it('écarte les boîtes inexploitables plutôt que de les dessiner n\'importe où', () => {
    expect(sanitizeBoxes([
      null,
      { x: 'a', y: 0, width: 0.1, height: 0.1 },
      { x: 0, y: 0, width: 0, height: 0.1 },
      { x: 2, y: 2, width: 0.1, height: 0.1 },      // entièrement hors image
    ])).toEqual([]);
  });

  it('borne une boîte qui déborde de l\'image', () => {
    const [b] = sanitizeBoxes([{ x: -0.1, y: 0.9, width: 0.5, height: 0.5 }]);
    expect(b.x).toBe(0);
    expect(b.y).toBeCloseTo(0.9, 9);
    expect(b.y + b.height).toBeLessThanOrEqual(1);
  });

  it('n\'accepte que les statuts connus', () => {
    expect(sanitizeBoxes([{ x: 0, y: 0, width: 0.1, height: 0.1, status: 'probable' }])[0].status).toBe('probable');
    expect(sanitizeBoxes([{ x: 0, y: 0, width: 0.1, height: 0.1, status: 'n\'importe quoi' }])[0].status).toBe('unknown');
  });
});

describe('boxLabelText', () => {
  it('compose « #12 DUPONT 🟢 »', () => {
    expect(boxLabelText({ carNumber: 12, label: 'DUPONT', status: 'confirmed' })).toBe('#12 DUPONT 🟢');
  });

  it('affiche la confiance seulement sur une proposition à confirmer', () => {
    expect(boxLabelText({ carNumber: 7, label: 'X', status: 'probable', confidence: 0.82 })).toBe('#7 X 🟡 82%');
    expect(boxLabelText({ carNumber: 7, label: 'X', status: 'confirmed', confidence: 0.82 })).toBe('#7 X 🟢');
  });

  it('reste lisible sans identité connue', () => {
    expect(boxLabelText({ status: 'unknown' })).toBe('⚪');
  });
});

// ─────────────────────────────────────────────────────────
// CLAVIER
// ─────────────────────────────────────────────────────────

describe('keyboardAction', () => {
  const ev = (key, extra = {}) => ({ key, target: { tagName: 'BODY' }, ...extra });

  it('mappe les commandes de lecture', () => {
    expect(keyboardAction(ev(' '))).toBe('togglePlay');
    expect(keyboardAction(ev('ArrowLeft'))).toBe('stepBack');
    expect(keyboardAction(ev('ArrowRight'))).toBe('stepForward');
    expect(keyboardAction(ev('ArrowRight', { shiftKey: true }))).toBe('jumpForward');
    expect(keyboardAction(ev('ArrowLeft', { altKey: true }))).toBe('framePrev');
    expect(keyboardAction(ev('.'))).toBe('frameNext');
    expect(keyboardAction(ev(','))).toBe('framePrev');
  });

  it('mappe les repères et la navigation entre départs', () => {
    expect(keyboardAction(ev('v'))).toBe('markTurn1');
    expect(keyboardAction(ev('V'))).toBe('markTurn1');
    expect(keyboardAction(ev('n'))).toBe('nextStart');
    expect(keyboardAction(ev('p'))).toBe('prevStart');
  });

  it('ne détourne jamais une frappe destinée à un champ de saisie', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(keyboardAction({ key: 'v', target: { tagName: tag } })).toBeNull();
    }
    expect(keyboardAction({ key: 'v', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull();
  });

  it('laisse passer les raccourcis système', () => {
    expect(keyboardAction(ev('v', { ctrlKey: true }))).toBeNull();
    expect(keyboardAction(ev('v', { metaKey: true }))).toBeNull();
  });

  it('ignore les touches sans rôle', () => {
    expect(keyboardAction(ev('x'))).toBeNull();
    expect(keyboardAction(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// NAVIGATION ENTRE DÉPARTS
// ─────────────────────────────────────────────────────────

describe('neighbourStartId', () => {
  const ids = ['s1_s1', 's1_s2', 's2_s1'];

  it('donne le départ suivant et le précédent', () => {
    expect(neighbourStartId(ids, 's1_s2', +1)).toBe('s2_s1');
    expect(neighbourStartId(ids, 's1_s2', -1)).toBe('s1_s1');
  });

  it('ne boucle pas : la fin de la catégorie est une information', () => {
    expect(neighbourStartId(ids, 's2_s1', +1)).toBeNull();
    expect(neighbourStartId(ids, 's1_s1', -1)).toBeNull();
  });

  it('repart du premier départ si l\'identifiant courant est inconnu', () => {
    expect(neighbourStartId(ids, 'inexistant', +1)).toBe('s1_s1');
    expect(neighbourStartId([], 'x', +1)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// PERSISTANCE
// ─────────────────────────────────────────────────────────

describe('buildVideoBlock', () => {
  it('conserve les repères avec une précision à la milliseconde', () => {
    expect(buildVideoBlock({ kind: 'file', fileName: 'course.mp4', startAt: 12.3456, turn1At: 18.99999, fps: 50 }))
      .toEqual({ kind: 'file', youtubeId: null, fileName: 'course.mp4', startAt: 12.346, turn1At: 19, fps: 50 });
  });

  it('ne stocke JAMAIS le contenu d\'un fichier local, seulement son nom', () => {
    const block = buildVideoBlock({ kind: 'file', fileName: 'course.mp4', startAt: 5 });
    expect(Object.keys(block).sort()).toEqual(['fileName', 'fps', 'kind', 'startAt', 'turn1At', 'youtubeId']);
  });

  it('renvoie null quand il n\'y a rien à enregistrer', () => {
    expect(buildVideoBlock({})).toBeNull();
    expect(buildVideoBlock()).toBeNull();
  });

  it('écarte les valeurs de temps aberrantes', () => {
    const b = buildVideoBlock({ kind: 'youtube', youtubeId: 'abc', startAt: -3, turn1At: 'x' });
    expect(b.startAt).toBeNull();
    expect(b.turn1At).toBeNull();
  });
});
