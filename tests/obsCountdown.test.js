import { describe, it, expect } from 'vitest';
import { LEAD_CHOICES, LEAD_DEFAULT, normalizeLead, effectiveLeadMs, alertState, mmss, leadLabel } from '../overlay/_lib/obs-countdown.js';

const base = { now: 1_000_000, onAir: true, acked: 0, armed: 0 };

describe('normalizeLead', () => {
  it('accepte les valeurs proposées, sinon retombe sur 30 s', () => {
    LEAD_CHOICES.forEach(v => expect(normalizeLead(v)).toBe(v));
    expect(normalizeLead('60')).toBe(60);
    expect(normalizeLead(45)).toBe(LEAD_DEFAULT);
    expect(normalizeLead('abc')).toBe(LEAD_DEFAULT);
    expect(LEAD_DEFAULT).toBe(30);
  });
  it('libellés', () => {
    expect(leadLabel(0)).toContain('0'); expect(leadLabel(30)).toBe('30 s avant la fin'); expect(leadLabel(120)).toBe('2 min avant la fin');
  });
});

describe('effectiveLeadMs', () => {
  it('délai complet pour un chrono long', () => {
    expect(effectiveLeadMs(60, 0, 0)).toBe(60_000);                       // durée inconnue
    expect(effectiveLeadMs(60, 1000, 1000 + 10 * 60_000)).toBe(60_000);   // 10 min
  });
  it('jamais plus de la moitié de la durée : un chrono de 1 min n\'alerte pas dès le départ', () => {
    expect(effectiveLeadMs(60, 0 + 1, 1 + 60_000)).toBe(30_000);
    expect(effectiveLeadMs(30, 1, 1 + 20_000)).toBe(10_000);
  });
});

describe('alertState', () => {
  const end = base.now + 100_000;
  it('avant la fenêtre d\'alerte : rien', () => {
    expect(alertState({ ...base, end, start: 1, leadSec: 30, armed: end }).show).toBe(false);
  });
  it('à 30 s de la fin (avance 30 s) : alerte « bientôt »', () => {
    const r = alertState({ ...base, now: end - 30_000, end, start: 1, leadSec: 30, armed: end });
    expect(r).toMatchObject({ show: true, phase: 'soon', left: 30_000 });
  });
  it('avance 60 s : l\'alerte se déclenche 30 s plus tôt qu\'avec 30 s', () => {
    const at = now => alertState({ ...base, now, end, start: 1, leadSec: 60, armed: end }).show;
    expect(at(end - 61_000)).toBe(false); expect(at(end - 60_000)).toBe(true);
  });
  it('avance 0 : alerte seulement à la fin (comportement d\'origine)', () => {
    expect(alertState({ ...base, now: end - 1000, end, start: 1, leadSec: 0, armed: end }).show).toBe(false);
    expect(alertState({ ...base, now: end, end, start: 1, leadSec: 0, armed: end })).toMatchObject({ show: true, phase: 'done' });
  });
  it('reste affichée après la fin tant qu\'elle n\'est pas acquittée', () => {
    expect(alertState({ ...base, now: end + 5000, end, start: 1, leadSec: 30, armed: end })).toMatchObject({ show: true, phase: 'done' });
  });
  it('acquittée → plus d\'alerte ; hors scène chrono → aucune', () => {
    expect(alertState({ ...base, now: end - 10_000, end, start: 1, leadSec: 30, armed: end, acked: end }).show).toBe(false);
    expect(alertState({ ...base, now: end - 10_000, end, start: 1, leadSec: 30, armed: end, onAir: false }).show).toBe(false);
  });
  it('vieux décompte déjà expiré à l\'ouverture de la page : aucune alerte', () => {
    const old = base.now - 600_000;
    expect(alertState({ ...base, end: old, start: 1, leadSec: 30, armed: 0 }).show).toBe(false);
    expect(alertState({ ...base, end: base.now - 30_000, start: 1, leadSec: 30, armed: 0 }).show).toBe(true);   // tout juste terminé
  });
  it('pas de chrono → rien', () => {
    expect(alertState({ ...base, end: 0, leadSec: 30 }).show).toBe(false);
  });
});

describe('mmss', () => {
  it('formate le temps restant', () => {
    expect(mmss(30_000)).toBe('0:30'); expect(mmss(65_000)).toBe('1:05'); expect(mmss(29_100)).toBe('0:30'); expect(mmss(-5)).toBe('0:00');
  });
});
