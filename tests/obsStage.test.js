import { describe, it, expect } from 'vitest';
import {
  LIVE_KEYS, splitPatch, stageToLivePatch, liveToStagePatch, stageDiff, diffLabels, stageIsStale, STAGE_MAX_AGE_MS,
} from '../overlay/_lib/obs-stage.js';
import { DEFAULT_CONTROL } from '../overlay/_lib/obs-control.js';

describe('splitPatch', () => {
  it('mode normal : tout part à l\'antenne, rien dans la préparation', () => {
    expect(splitPatch({ scene: 'grid', visible: false }, false)).toEqual({ stage: null, live: { scene: 'grid', visible: false } });
  });
  it('mode préparation : tout part dans la préparation, sauf les réglages directs (aussi copiés en préparation)', () => {
    const r = splitPatch({ scene: 'intro', visible: false, countdownEnd: 5, countdownStart: 1 }, true);
    expect(r.stage).toEqual({ scene: 'intro', visible: false, countdownEnd: 5, countdownStart: 1 });
    expect(r.live).toEqual({ visible: false, countdownEnd: 5, countdownStart: 1 });
  });
  it('mode préparation : un réglage non direct ne touche JAMAIS l\'antenne', () => {
    expect(splitPatch({ scene: 'studio', studio: { boards: ['champ'] } }, true).live).toBeNull();
  });
});

describe('stageToLivePatch (▶ Mettre à l\'antenne)', () => {
  const stage = { ...DEFAULT_CONTROL, scene: 'studio', headerText: 'X', visible: false, countdownEnd: 99, updatedAt: 5, id: 'preview' };
  it('copie tout sauf réglages directs et métadonnées', () => {
    const p = stageToLivePatch(stage);
    expect(p.scene).toBe('studio'); expect(p.headerText).toBe('X');
    LIVE_KEYS.forEach(k => expect(k in p).toBe(false));
    expect('updatedAt' in p).toBe(false); expect('id' in p).toBe(false);
  });
  it('transmet aussi les valeurs vides / nulles (ex. retirer une grille personnalisée)', () => {
    expect(stageToLivePatch({ gridOverride: null, headerText: '' })).toEqual({ gridOverride: null, headerText: '' });
  });
});

describe('liveToStagePatch', () => {
  it('copie l\'antenne (y compris visible/chrono) sans métadonnées', () => {
    const p = liveToStagePatch({ scene: 'grid', visible: true, countdownEnd: 3, id: 'live', updatedAt: 1 });
    expect(p).toEqual({ scene: 'grid', visible: true, countdownEnd: 3 });
  });
});

describe('stageDiff', () => {
  it('identique → aucune différence', () => {
    expect(stageDiff({ ...DEFAULT_CONTROL }, { ...DEFAULT_CONTROL })).toEqual([]);
  });
  it('liste uniquement ce qui change, ignore visible et chrono', () => {
    const live = { ...DEFAULT_CONTROL };
    const stage = { ...DEFAULT_CONTROL, scene: 'intro', studio: { ...DEFAULT_CONTROL.studio, rotate: true }, visible: false, countdownEnd: 7 };
    expect(stageDiff(stage, live)).toEqual(['scene', 'studio']);
    expect(diffLabels(['scene', 'studio', 'zzz'])).toEqual(['scène', 'plateau', 'zzz']);
  });
  it('compare en profondeur (objets)', () => {
    const a = { ...DEFAULT_CONTROL, infoBand: { enabled: true, label: 'A', message: '', logos: [] } };
    const b = { ...DEFAULT_CONTROL, infoBand: { enabled: true, label: 'A', message: '', logos: [] } };
    expect(stageDiff(a, b)).toEqual([]);
    b.infoBand.label = 'B';
    expect(stageDiff(a, b)).toEqual(['infoBand']);
  });
  it('championnat vide d\'un côté : pas une différence voulue', () => {
    expect(stageDiff({ ...DEFAULT_CONTROL, championshipId: 'ch1' }, { ...DEFAULT_CONTROL, championshipId: '' })).toEqual([]);
    expect(stageDiff({ ...DEFAULT_CONTROL, championshipId: 'ch1' }, { ...DEFAULT_CONTROL, championshipId: 'ch2' })).toEqual(['championshipId']);
  });
  it('après envoi à l\'antenne, plus de différence', () => {
    const stage = { ...DEFAULT_CONTROL, scene: 'ending', headerText: 'Merci' };
    const live = { ...DEFAULT_CONTROL, ...stageToLivePatch(stage) };
    expect(stageDiff(stage, live)).toEqual([]);
  });
});

describe('stageIsStale', () => {
  const now = 1_000_000_000_000;
  it('document absent ou sans date → périmé', () => {
    expect(stageIsStale(null, false, now)).toBe(true);
    expect(stageIsStale({}, true, now)).toBe(true);
  });
  it('récent → conservé ; ancien (> 12 h) → périmé', () => {
    expect(stageIsStale({ updatedAt: now - 60_000 }, true, now)).toBe(false);
    expect(stageIsStale({ updatedAt: now - STAGE_MAX_AGE_MS - 1 }, true, now)).toBe(true);
  });
});
