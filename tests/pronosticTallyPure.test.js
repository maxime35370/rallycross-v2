import { describe, it, expect } from 'vitest';
import { tallyFromVotes } from '../overlay/_lib/obs-pronostics.js';

describe('tallyFromVotes — décompte à partir des votes réels', () => {
  it('compte un vote par document, par pilote', () => {
    expect(tallyFromVotes([{ driverId: 'A' }, { driverId: 'A' }, { driverId: 'B' }])).toEqual({ counts: { A: 2, B: 1 }, total: 3 });
  });
  it('ignore les votes vides ou invalides', () => {
    expect(tallyFromVotes([{ driverId: '' }, {}, null, undefined, { driverId: 'C' }])).toEqual({ counts: { C: 1 }, total: 1 });
  });
  it('aucun vote → décompte vide', () => {
    expect(tallyFromVotes([])).toEqual({ counts: {}, total: 0 });
    expect(tallyFromVotes(undefined)).toEqual({ counts: {}, total: 0 });
  });
  it('le total égale toujours la somme du décompte', () => {
    const t = tallyFromVotes([{ driverId: 'A' }, { driverId: 'B' }, { driverId: 'B' }, { driverId: 'C' }]);
    expect(Object.values(t.counts).reduce((a, b) => a + b, 0)).toBe(t.total);
  });
});
