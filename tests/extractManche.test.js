/* ═══════════════════════════════════════════════
   EXTRACTMANCHE.TEST.JS — Couche pure de l'outil d'extraction

   Ce que ces tests couvrent : TOUT ce qui décide (fenêtre, marges, nom de
   fichier, arguments yt-dlp, contrôle ffprobe, sidecar, plan du corpus).
   Ce qu'ils ne couvrent pas : l'exécution réelle de yt-dlp et de FFmpeg, qui
   demande un accès à YouTube — c'est le POC décrit dans
   docs/video-analysis/EXTRACTION-YOUTUBE.md §12 qui la vérifie.

   Les arguments yt-dlp sont testés ligne à ligne parce qu'ils portent des
   conclusions de l'audit qu'une modification distraite ferait disparaître
   sans que rien n'échoue visiblement (notamment --force-keyframes-at-cuts,
   sans lequel la coupe n'est plus précise et l'origine temporelle est perdue).
═══════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import {
  SCHEMA, DEFAULT_PAD_BEFORE, DEFAULT_PAD_AFTER, DEFAULT_CORPUS_PROFILE,
  FFMPEG_OUT_ARGS,
  parseTimeInput, toHms, buildWindow, sectionArg,
  slug, sessionLabel, buildBaseName,
  formatSelector, buildYtDlpArgs,
  parseRational, checkProbe, buildSidecar,
  planCorpusFrames, frameFileName,
} from '../tools/extract-manche/lib/recipe.mjs';
import {
  ytDlpReleaseDate, ytDlpAgeDays, explainFailure, INSTALL_HINTS,
} from '../tools/extract-manche/lib/tools.mjs';

// ─────────────────────────────────────────────────────────
// TEMPS
// ─────────────────────────────────────────────────────────

describe('parseTimeInput', () => {
  it('lit les timecodes tels qu\'on les relève sur YouTube', () => {
    expect(parseTimeInput('05:42:26')).toBe(20546);
    expect(parseTimeInput('5:42:26')).toBe(20546);
    expect(parseTimeInput('5:42:26.480')).toBeCloseTo(20546.48, 3);
    expect(parseTimeInput('42:26')).toBe(2546);
  });

  it('accepte un nombre de secondes, avec point ou virgule', () => {
    expect(parseTimeInput('20546')).toBe(20546);
    expect(parseTimeInput('20546.48')).toBeCloseTo(20546.48, 3);
    expect(parseTimeInput('20546,48')).toBeCloseTo(20546.48, 3);
    expect(parseTimeInput(90)).toBe(90);
  });

  it('renvoie null sur une saisie invalide — jamais 0', () => {
    // Une faute de frappe ne doit pas se transformer en « début de la vidéo ».
    for (const bad of ['', null, undefined, '05h42', 'départ', '5:99:26', -3]) {
      expect(parseTimeInput(bad)).toBeNull();
    }
  });
});

describe('toHms', () => {
  it('produit le format accepté par --download-sections', () => {
    expect(toHms(20546)).toBe('5:42:26.000');
    expect(toHms(20546.48)).toBe('5:42:26.480');
    expect(toHms(0)).toBe('0:00:00.000');
    expect(toHms(-5)).toBe('0:00:00.000');
  });

  it('fait l\'aller-retour avec parseTimeInput', () => {
    for (const s of [0, 61, 3599.5, 20546.48]) {
      expect(parseTimeInput(toHms(s))).toBeCloseTo(s, 3);
    }
  });
});

describe('buildWindow', () => {
  it('applique les marges autour de la plage utile', () => {
    const w = buildWindow({ sourceStart: 20546, sourceEnd: 20590, padBefore: 3, padAfter: 6 });
    expect(w).toMatchObject({ clipStart: 20543, clipEnd: 20596, clipDuration: 53, padBefore: 3, padAfter: 6 });
  });

  it('utilise les marges par défaut du document d\'architecture', () => {
    const w = buildWindow({ sourceStart: 100, sourceEnd: 130 });
    expect(w.clipStart).toBe(100 - DEFAULT_PAD_BEFORE);
    expect(w.clipEnd).toBe(130 + DEFAULT_PAD_AFTER);
  });

  it('tronque la marge amont au début de la vidéo et le dit', () => {
    // La marge RÉELLEMENT appliquée est renvoyée : le sidecar doit décrire ce
    // qui s'est passé, pas ce qui avait été demandé.
    const w = buildWindow({ sourceStart: 2, sourceEnd: 40, padBefore: 10, padAfter: 0 });
    expect(w.clipStart).toBe(0);
    expect(w.padBefore).toBe(2);
  });

  it('refuse une fenêtre vide ou inversée', () => {
    expect(() => buildWindow({ sourceStart: 100, sourceEnd: 100 })).toThrow();
    expect(() => buildWindow({ sourceStart: 200, sourceEnd: 100 })).toThrow();
    expect(() => buildWindow({ sourceStart: null, sourceEnd: 100 })).toThrow();
  });
});

describe('sectionArg', () => {
  it('produit exactement l\'argument --download-sections', () => {
    expect(sectionArg({ clipStart: 20543, clipEnd: 20596 })).toBe('*5:42:23.000-5:43:16.000');
  });
});

// ─────────────────────────────────────────────────────────
// NOMMAGE
// ─────────────────────────────────────────────────────────

describe('slug', () => {
  it('retire accents et caractères spéciaux, comme timecodeKey()', () => {
    expect(slug('Kerlabo')).toBe('Kerlabo');
    expect(slug('Faleyras / D3')).toBe('Faleyras_D3');
    expect(slug('Élite Supercar')).toBe('Elite_Supercar');
    expect(slug('  ')).toBe('');
    expect(slug(null)).toBe('');
  });
});

describe('sessionLabel', () => {
  it('parle la langue du terrain : une manche qualificative est une « Q »', () => {
    expect(sessionLabel('MQ', 3)).toBe('Q3');
    expect(sessionLabel('MQ', null)).toBe('Q');
    expect(sessionLabel('EC', 1)).toBe('EC1');
    expect(sessionLabel('DF', 2)).toBe('DF2');
    expect(sessionLabel('FIN', null)).toBe('FIN');
  });
});

describe('buildBaseName', () => {
  it('produit le nom attendu pour la manche Kerlabo', () => {
    expect(buildBaseName({
      location: 'Kerlabo', year: 2026, category: 'D3', sessionType: 'MQ', sessionNum: 3, serie: 4,
    })).toBe('Kerlabo_2026_D3_Q3_S4');
  });

  it('omet proprement les parties inconnues', () => {
    expect(buildBaseName({ location: 'Lohéac', year: 2026 })).toBe('Loheac_2026_SESSION');
    expect(buildBaseName({})).toBe('Meeting_SESSION');
  });
});

// ─────────────────────────────────────────────────────────
// LIGNE DE COMMANDE
// ─────────────────────────────────────────────────────────

describe('buildYtDlpArgs', () => {
  const base = {
    url: 'https://youtu.be/_SqxZQl5zzQ',
    window: { clipStart: 20543, clipEnd: 20596 },
    outputTemplate: '/tmp/Kerlabo_2026_D3_Q3_S4.%(ext)s',
  };

  it('limite le téléchargement à la seule plage demandée', () => {
    const args = buildYtDlpArgs(base);
    const i = args.indexOf('--download-sections');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('*5:42:23.000-5:43:16.000');
  });

  it('mode précis : coupe à l\'image et profil de sortie imposé', () => {
    const args = buildYtDlpArgs({ ...base, mode: 'precise' });
    // Sans ce drapeau, yt-dlp ajoute -c copy AVANT nos options ffmpeg, qui
    // deviennent alors sans effet, et la coupe retombe sur l'image-clé.
    expect(args).toContain('--force-keyframes-at-cuts');
    const j = args.indexOf('--downloader-args');
    expect(args[j + 1]).toBe(`ffmpeg_o:${FFMPEG_OUT_ARGS}`);
    for (const needed of ['libx264', 'yuv420p', '+faststart', '-crf', '18']) {
      expect(args[j + 1]).toContain(needed);
    }
  });

  it('mode rapide : copie brute, donc format avc1 exigé en entrée', () => {
    const args = buildYtDlpArgs({ ...base, mode: 'fast' });
    expect(args).not.toContain('--force-keyframes-at-cuts');
    expect(args).not.toContain('--downloader-args');
    expect(args[args.indexOf('-f') + 1]).toContain('avc1');
  });

  it('ne suit jamais une playlist et écrit où on lui dit', () => {
    const args = buildYtDlpArgs(base);
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('-o') + 1]).toBe(base.outputTemplate);
    expect(args[0]).toBe(base.url);
  });

  it('active un moteur JavaScript quand on lui donne un chemin Node', () => {
    // Sans lui, la liste de formats revient tronquée (aucun avc1 1080p60
    // constaté sur la vidéo Kerlabo) et le débit peut être bridé.
    const args = buildYtDlpArgs({ ...base, nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
    const i = args.indexOf('--js-runtimes');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('node:C:\\Program Files\\nodejs\\node.exe');
  });

  it('n\'ajoute rien quand aucun chemin Node n\'est fourni', () => {
    expect(buildYtDlpArgs(base)).not.toContain('--js-runtimes');
  });

  it('respecte un sélecteur de format imposé', () => {
    const args = buildYtDlpArgs({ ...base, format: '299+140' });
    expect(args[args.indexOf('-f') + 1]).toBe('299+140');
  });

  it('refuse une URL vide', () => {
    expect(() => buildYtDlpArgs({ ...base, url: '' })).toThrow();
  });
});

describe('formatSelector', () => {
  it('préfère l\'avc1 dans les deux modes', () => {
    // Constaté sur la vidéo Kerlabo : laissé libre, yt-dlp choisit l'AV1
    // (itag 399, 2681 kbit/s) alors que l'avc1 (299, 5040 kbit/s) est la piste
    // au plus haut débit ET la moins coûteuse à décoder.
    expect(formatSelector('precise').split('/')[0]).toContain('avc1');
    expect(formatSelector('fast').split('/')[0]).toContain('avc1');
  });

  it('écarte les pistes m3u8 au profit du DASH sur HTTP', () => {
    expect(formatSelector('precise').split('/')[0]).toContain('protocol^=https');
  });

  it('garde un repli sans avc1 en mode précis, pas en mode rapide', () => {
    // Le mode précis réencode : il peut partir de n'importe quel codec.
    // Le mode rapide copie : sans avc1 le fichier serait illisible par Safari.
    const precise = formatSelector('precise').split('/');
    expect(precise.length).toBeGreaterThan(2);
    expect(precise.slice(1).some(c => !c.includes('avc1'))).toBe(true);
    expect(formatSelector('fast')).toContain('ext=mp4');
  });
});

// ─────────────────────────────────────────────────────────
// CONTRÔLE DU FICHIER PRODUIT
// ─────────────────────────────────────────────────────────

describe('parseRational', () => {
  it('lit les cadences ffprobe', () => {
    expect(parseRational('50/1')).toBe(50);
    expect(parseRational('30000/1001')).toBe(29.97);
    expect(parseRational('25')).toBe(25);
  });
  it('rejette ce qui n\'est pas une cadence', () => {
    for (const bad of ['0/0', 'N/A', '', null, '-25/1']) expect(parseRational(bad)).toBeNull();
  });
});

/** Sortie ffprobe d'un extrait conforme au profil §5.2. */
const PROBE_OK = {
  streams: [{
    codec_name: 'h264', codec_type: 'video', profile: 'High', pix_fmt: 'yuv420p',
    width: 1920, height: 1080, r_frame_rate: '50/1', avg_frame_rate: '50/1',
    start_time: '0.000000', nb_read_packets: '2650',
  }],
  format: { duration: '53.000000', start_time: '0.000000', size: '28311552' },
};

describe('checkProbe', () => {
  it('valide un extrait conforme et en résume les caractéristiques', () => {
    const v = checkProbe(PROBE_OK, { expectedDuration: 53 });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.summary).toMatchObject({
      codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080,
      fps: 50, duration: 53, frames: 2650,
    });
  });

  it('refuse un codec que <video> ne saura pas lire', () => {
    const probe = { ...PROBE_OK, streams: [{ ...PROBE_OK.streams[0], codec_name: 'av1' }] };
    expect(checkProbe(probe).ok).toBe(false);
    expect(checkProbe(probe).errors.join()).toMatch(/av1/);
  });

  it('refuse un flux 10 bits — le navigateur afficherait une image noire', () => {
    const probe = { ...PROBE_OK, streams: [{ ...PROBE_OK.streams[0], pix_fmt: 'yuv420p10le' }] };
    expect(checkProbe(probe).ok).toBe(false);
    expect(checkProbe(probe).errors.join()).toMatch(/yuv420p/);
  });

  it('refuse un start_time non nul — les numéros d\'image seraient décalés', () => {
    const probe = { ...PROBE_OK, format: { ...PROBE_OK.format, start_time: '0.083000' } };
    const v = checkProbe(probe);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/start_time/);
  });

  it('signale une cadence variable sans bloquer', () => {
    const probe = { ...PROBE_OK, streams: [{ ...PROBE_OK.streams[0], avg_frame_rate: '47/1' }] };
    const v = checkProbe(probe);
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/variable/);
  });

  it('signale une durée inattendue sans bloquer', () => {
    const v = checkProbe(PROBE_OK, { expectedDuration: 44 });
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/durée/);
  });

  it('signale les images de pré-roll d\'une coupe en copie', () => {
    // Cas mesuré sur un vrai fichier : 2750 paquets pour 53 s à 50 img/s.
    // Les 100 images en trop portent des timestamps négatifs, masqués par
    // l'edit list du MP4 — donc invisibles tant que le lecteur la respecte.
    const probe = {
      ...PROBE_OK,
      streams: [{ ...PROBE_OK.streams[0], nb_read_packets: '2750' }],
    };
    const v = checkProbe(probe, { expectedDuration: 53 });
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/pré-roll/);
  });

  it('ne crie pas au pré-roll sur un arrondi d\'une image', () => {
    const probe = { ...PROBE_OK, streams: [{ ...PROBE_OK.streams[0], nb_read_packets: '2651' }] };
    expect(checkProbe(probe, { expectedDuration: 53 }).warnings).toEqual([]);
  });

  it('refuse un fichier sans flux vidéo exploitable', () => {
    const v = checkProbe({ streams: [], format: {} });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────
// SIDECAR
// ─────────────────────────────────────────────────────────

describe('buildSidecar', () => {
  const sidecar = buildSidecar({
    identity: {
      meetingId: 'm1', sessionId: 's1', location: 'Kerlabo', year: '2026',
      category: 'D3', sessionType: 'MQ', sessionNum: 3, serie: 4, timecodeKey: 'MQ3__D3',
    },
    recipe: {
      youtubeId: '_SqxZQl5zzQ', url: 'https://youtu.be/_SqxZQl5zzQ',
      sourceStart: 20546, sourceEnd: 20590, padBefore: 3, padAfter: 6,
      clipStart: 20543, clipDuration: 53, v1At: 20554, origin: 'manual', mode: 'precise',
      format: '299+140',
    },
    probe: { file: 'Kerlabo_2026_D3_Q3_S4.mp4', fps: 50, width: 1920, height: 1080, codec: 'h264', startTime: 0, duration: 53, frames: 2650, sizeBytes: 28311552 },
    tool: { label: 'yt-dlp 2026.08.19 + ffmpeg 7.1', command: ['yt-dlp', '--no-playlist'] },
    createdAt: '2026-08-21T09:00:00.000Z',
  });

  it('porte le schéma attendu par l\'application', () => {
    expect(sidecar.schema).toBe('rx-extract/1');
    expect(SCHEMA).toBe('rx-extract/1');
  });

  it('conserve la recette, donc la reproductibilité de l\'extrait', () => {
    expect(sidecar).toMatchObject({
      youtubeId: '_SqxZQl5zzQ', sourceStart: 20546, sourceEnd: 20590,
      padBefore: 3, padAfter: 6, clipStart: 20543, v1At: 20554, origin: 'manual',
      mode: 'precise', format: '299+140',
    });
  });

  it('conserve l\'ancrage temporel absolu', () => {
    // instant_youtube = clipStart + t_local : c'est ce qui permet de réécrire
    // un timecode dans Firestore après une mesure faite sur l'extrait.
    expect(sidecar.clipStart + 11).toBe(sidecar.v1At);
  });

  it('normalise les nombres et n\'invente aucune valeur', () => {
    expect(sidecar.year).toBe(2026);              // « 2026 » saisi en texte
    const vide = buildSidecar({});
    expect(vide.meetingId).toBeNull();
    expect(vide.fps).toBeNull();
    expect(vide.origin).toBe('manual');
    expect(vide.createdAt).toBeTruthy();
  });

  it('reste sérialisable tel quel', () => {
    expect(() => JSON.parse(JSON.stringify(sidecar))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────
// CORPUS YOLOX (§13)
// ─────────────────────────────────────────────────────────

describe('planCorpusFrames', () => {
  const base = {
    baseName: 'Kerlabo_2026_D3_Q3_S4',
    startAt: 20546, v1At: 20554, clipStart: 20543, clipDuration: 53, fps: 50,
  };

  it('couvre les six zones du profil quand V1 est connu', () => {
    const plan = planCorpusFrames(base);
    expect(plan.map(f => f.zone)).toEqual(DEFAULT_CORPUS_PROFILE.map(p => p.zone));
  });

  it('ne garde que les zones du départ si V1 est inconnu', () => {
    const plan = planCorpusFrames({ ...base, v1At: null });
    expect(plan.map(f => f.zone)).toEqual(['depart', 'acceleration']);
  });

  it('cale chaque instant sur un numéro d\'image entier', () => {
    // Condition pour comparer YOLOX-tiny et YOLOX-s « sur exactement les mêmes
    // images » : même commande, même image.
    const plan = planCorpusFrames(base);
    for (const f of plan) {
      expect(Number.isInteger(f.clipFrame)).toBe(true);
      expect(f.clipTime).toBeCloseTo(f.clipFrame / base.fps, 6);
      expect(f.absoluteTime).toBeCloseTo(base.clipStart + f.clipTime, 3);
    }
    expect(plan.find(f => f.zone === 'depart').clipFrame).toBe(150);   // 3 s × 50
    expect(plan.find(f => f.zone === 'entree_v1').clipFrame).toBe(550); // 11 s × 50
  });

  it('ignore une zone qui tomberait hors de l\'extrait', () => {
    const plan = planCorpusFrames({ ...base, clipDuration: 9 });
    expect(plan.map(f => f.zone)).toEqual(['depart', 'acceleration']);
  });

  it('accepte un profil sur mesure — les circuits n\'ont pas la même distance V1', () => {
    const plan = planCorpusFrames({ ...base, profile: [{ zone: 'test', from: 'v1', offset: 0 }] });
    expect(plan).toHaveLength(1);
    expect(plan[0].absoluteTime).toBe(20554);
  });

  it('refuse de planifier sans cadence connue', () => {
    expect(() => planCorpusFrames({ ...base, fps: 0 })).toThrow();
    expect(() => planCorpusFrames({ ...base, fps: null })).toThrow();
  });
});

describe('frameFileName', () => {
  it('porte la zone et le timecode absolu, comme prévu au §13.3', () => {
    expect(frameFileName('Kerlabo_2026_D3_Q3_S4', 'entree_v1', 20551.48, 1027))
      .toBe('Kerlabo_2026_D3_Q3_S4__entree_v1__t20551.480__f1027.png');
  });
});

// ─────────────────────────────────────────────────────────
// OUTILS EXTERNES
// ─────────────────────────────────────────────────────────

describe('version de yt-dlp', () => {
  it('lit la date de publication', () => {
    expect(ytDlpReleaseDate('2026.08.19')?.toISOString()).toBe('2026-08-19T00:00:00.000Z');
    expect(ytDlpReleaseDate('inconnue')).toBeNull();
  });

  it('mesure l\'âge — le risque n° 1 de la brique est une version périmée', () => {
    const now = new Date('2026-08-21T00:00:00Z');
    expect(ytDlpAgeDays('2026.08.19', now)).toBe(2);
    expect(ytDlpAgeDays('2026.05.01', now)).toBeGreaterThan(30);
    expect(ytDlpAgeDays(null, now)).toBeNull();
  });
});

describe('explainFailure', () => {
  it('traduit les échecs courants en action à faire', () => {
    expect(explainFailure('ERROR: ffmpeg is not installed')).toMatch(/FFmpeg/);
    expect(explainFailure('Sign in to confirm you\'re not a bot')).toMatch(/confirmation humaine/);
    expect(explainFailure('ERROR: Private video')).toMatch(/aucun contournement/i);
    expect(explainFailure('Unable to download API page')).toMatch(/yt-dlp -U/);
    expect(explainFailure('ERROR: Requested format is not available')).toMatch(/--mode precise/);
  });

  it('renvoie null plutôt qu\'un diagnostic inventé', () => {
    expect(explainFailure('quelque chose de totalement inattendu')).toBeNull();
    expect(explainFailure('')).toBeNull();
  });

  it('propose une installation adaptée à la plateforme', () => {
    expect(INSTALL_HINTS['yt-dlp']).toBeTruthy();
    expect(INSTALL_HINTS.ffmpeg).toBeTruthy();
  });
});
