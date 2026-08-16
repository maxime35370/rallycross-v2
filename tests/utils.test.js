import { describe, it, expect } from 'vitest';
import {
  msToDisplay,
  inputToMs,
  parseTimeString,
  msToFields,
  escHtml,
  sanitize,
  categoryKey,
  isSpecialStatus,
  formatDate,
  parseTimecode,
  formatTimecode,
  extractYoutubeId,
  extractYoutubeTimecode,
  buildYoutubeUrl,
  timecodeKey,
} from '../js/utils.js';

// ─────────────────────────────────────────────────────────
// msToDisplay
// ─────────────────────────────────────────────────────────

describe('msToDisplay', () => {
  it('formats time with minutes', () => {
    expect(msToDisplay(83456)).toBe('1:23.456');
  });

  it('formats time without minutes', () => {
    expect(msToDisplay(45123)).toBe('45.123');
  });

  it('pads seconds and milliseconds', () => {
    expect(msToDisplay(60005)).toBe('1:00.005');
  });

  it('returns dash for null/undefined/NaN', () => {
    expect(msToDisplay(null)).toBe('—');
    expect(msToDisplay(undefined)).toBe('—');
    expect(msToDisplay(NaN)).toBe('—');
  });

  it('returns dash for negative values', () => {
    expect(msToDisplay(-1)).toBe('—');
  });

  it('handles zero', () => {
    expect(msToDisplay(0)).toBe('0.000');
  });

  it('handles exact minutes', () => {
    expect(msToDisplay(120000)).toBe('2:00.000');
  });
});

// ─────────────────────────────────────────────────────────
// inputToMs
// ─────────────────────────────────────────────────────────

describe('inputToMs', () => {
  it('converts min, sec, ms to milliseconds', () => {
    expect(inputToMs(1, 23, 456)).toBe(83456);
  });

  it('handles zero minutes', () => {
    expect(inputToMs(0, 45, 123)).toBe(45123);
  });

  it('returns null for seconds > 59', () => {
    expect(inputToMs(0, 60, 0)).toBeNull();
  });

  it('returns null for negative seconds', () => {
    expect(inputToMs(0, -1, 0)).toBeNull();
  });

  it('returns null for ms > 999', () => {
    expect(inputToMs(0, 0, 1000)).toBeNull();
  });

  it('returns null for negative ms', () => {
    expect(inputToMs(0, 0, -1)).toBeNull();
  });

  it('returns null for negative minutes', () => {
    expect(inputToMs(-1, 0, 0)).toBeNull();
  });

  it('handles string inputs', () => {
    expect(inputToMs('1', '23', '456')).toBe(83456);
  });

  it('handles empty strings as 0', () => {
    expect(inputToMs('', '', '')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// parseTimeString
// ─────────────────────────────────────────────────────────

describe('parseTimeString', () => {
  it('parses m:ss.mmm format', () => {
    expect(parseTimeString('1:23.456')).toBe(83456);
  });

  it('parses ss.mmm format', () => {
    expect(parseTimeString('45.123')).toBe(45123);
  });

  it('accepts comma as decimal separator', () => {
    expect(parseTimeString('1:23,456')).toBe(83456);
  });

  it('pads short milliseconds', () => {
    expect(parseTimeString('45.1')).toBe(45100);
    expect(parseTimeString('45.12')).toBe(45120);
  });

  it('returns null for invalid input', () => {
    expect(parseTimeString(null)).toBeNull();
    expect(parseTimeString('')).toBeNull();
    expect(parseTimeString('abc')).toBeNull();
    expect(parseTimeString('1:2:3')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseTimeString('  1:23.456  ')).toBe(83456);
  });
});

// ─────────────────────────────────────────────────────────
// msToFields
// ─────────────────────────────────────────────────────────

describe('msToFields', () => {
  it('decomposes ms into min, sec, mil', () => {
    expect(msToFields(83456)).toEqual({ min: '1', sec: '23', mil: '456' });
  });

  it('pads seconds and milliseconds', () => {
    expect(msToFields(60005)).toEqual({ min: '1', sec: '00', mil: '005' });
  });

  it('returns empty strings for null', () => {
    expect(msToFields(null)).toEqual({ min: '', sec: '', mil: '' });
  });

  it('returns empty strings for NaN', () => {
    expect(msToFields(NaN)).toEqual({ min: '', sec: '', mil: '' });
  });

  it('handles zero', () => {
    expect(msToFields(0)).toEqual({ min: '0', sec: '00', mil: '000' });
  });
});

// ─────────────────────────────────────────────────────────
// escHtml
// ─────────────────────────────────────────────────────────

describe('escHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersand', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes single quotes', () => {
    expect(escHtml("it's")).toBe('it&#39;s');
  });

  it('returns empty string for null/undefined', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('handles number 0', () => {
    expect(escHtml(0)).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────
// sanitize
// ─────────────────────────────────────────────────────────

describe('sanitize', () => {
  it('trims whitespace', () => {
    expect(sanitize('  hello  ')).toBe('hello');
  });

  it('truncates to maxLen', () => {
    expect(sanitize('abcdefghij', 5)).toBe('abcde');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitize(null)).toBe('');
    expect(sanitize(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────
// categoryKey
// ─────────────────────────────────────────────────────────

describe('categoryKey', () => {
  it('normalizes accented characters', () => {
    expect(categoryKey('Feminines')).toBe('feminines');
  });

  it('removes non-alphanumeric characters', () => {
    expect(categoryKey('Division 5')).toBe('division5');
  });

  it('lowercases', () => {
    expect(categoryKey('Supercar')).toBe('supercar');
  });

  it('handles empty/null', () => {
    expect(categoryKey('')).toBe('');
    expect(categoryKey(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────
// isSpecialStatus
// ─────────────────────────────────────────────────────────

describe('isSpecialStatus', () => {
  it('returns true for DNS, DNF, DSQ, DSQ_RACE', () => {
    expect(isSpecialStatus('DNS')).toBe(true);
    expect(isSpecialStatus('DNF')).toBe(true);
    expect(isSpecialStatus('DSQ')).toBe(true);
    expect(isSpecialStatus('DSQ_RACE')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSpecialStatus('dns')).toBe(true);
    expect(isSpecialStatus('Dnf')).toBe(true);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isSpecialStatus(null)).toBe(false);
    expect(isSpecialStatus(undefined)).toBe(false);
    expect(isSpecialStatus('')).toBe(false);
  });

  it('returns false for normal values', () => {
    expect(isSpecialStatus('FINISHED')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// formatDate
// ─────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats a Date string', () => {
    const result = formatDate('2026-03-15');
    expect(result).toBe('15/03/2026');
  });

  it('returns dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('returns dash for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('handles Firestore Timestamp-like objects', () => {
    const fakeTimestamp = { toDate: () => new Date('2026-06-01') };
    expect(formatDate(fakeTimestamp)).toBe('01/06/2026');
  });
});

// ─────────────────────────────────────────────────────────
// parseTimecode
// ─────────────────────────────────────────────────────────

describe('parseTimecode', () => {
  it('retourne null pour valeur vide/invalide', () => {
    expect(parseTimecode(null)).toBe(null);
    expect(parseTimecode(undefined)).toBe(null);
    expect(parseTimecode('')).toBe(null);
    expect(parseTimecode('   ')).toBe(null);
    expect(parseTimecode('abc')).toBe(null);
  });

  it('parse le format s (secondes seules)', () => {
    expect(parseTimecode('45')).toBe(45);
    expect(parseTimecode('120')).toBe(120);
  });

  it('parse le format m:s', () => {
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('0:45')).toBe(45);
    expect(parseTimecode('42:15')).toBe(2535);
  });

  it('parse le format h:m:s', () => {
    expect(parseTimecode('1:00:00')).toBe(3600);
    expect(parseTimecode('1:23:45')).toBe(5025);
    expect(parseTimecode('2:15:30')).toBe(8130);
  });

  it('rejette secondes ou minutes > 59', () => {
    expect(parseTimecode('1:60')).toBe(null);
    expect(parseTimecode('1:60:00')).toBe(null);
    expect(parseTimecode('1:00:60')).toBe(null);
  });

  it('rejette caractères non numériques', () => {
    expect(parseTimecode('1:2a')).toBe(null);
    expect(parseTimecode('a:b:c')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────
// formatTimecode
// ─────────────────────────────────────────────────────────

describe('formatTimecode', () => {
  it('retourne chaîne vide pour valeur invalide', () => {
    expect(formatTimecode(null)).toBe('');
    expect(formatTimecode(undefined)).toBe('');
    expect(formatTimecode(NaN)).toBe('');
    expect(formatTimecode(-1)).toBe('');
  });

  it('formate en m:ss quand < 1h', () => {
    expect(formatTimecode(45)).toBe('0:45');
    expect(formatTimecode(90)).toBe('1:30');
    expect(formatTimecode(3599)).toBe('59:59');
  });

  it('formate en h:mm:ss quand >= 1h', () => {
    expect(formatTimecode(3600)).toBe('1:00:00');
    expect(formatTimecode(5025)).toBe('1:23:45');
    expect(formatTimecode(8130)).toBe('2:15:30');
  });

  it('tronque les décimales', () => {
    expect(formatTimecode(90.7)).toBe('1:30');
  });
});

// ─────────────────────────────────────────────────────────
// extractYoutubeId
// ─────────────────────────────────────────────────────────

describe('extractYoutubeId', () => {
  it('retourne null pour vide', () => {
    expect(extractYoutubeId('')).toBe(null);
    expect(extractYoutubeId(null)).toBe(null);
  });

  it('extrait depuis youtube.com/watch?v=', () => {
    expect(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeId('https://youtube.com/watch?v=dQw4w9WgXcQ&list=abc')).toBe('dQw4w9WgXcQ');
  });

  it('extrait depuis youtu.be/', () => {
    expect(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
  });

  it('extrait depuis /embed/, /live/, /shorts/', () => {
    expect(extractYoutubeId('https://youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('accepte un ID brut de 11 chars', () => {
    expect(extractYoutubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('retourne null pour URL non-YouTube', () => {
    expect(extractYoutubeId('https://vimeo.com/12345')).toBe(null);
    expect(extractYoutubeId('https://example.com/video')).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────
// extractYoutubeTimecode
// ─────────────────────────────────────────────────────────

describe('extractYoutubeTimecode', () => {
  it('retourne null pour vide ou non-URL', () => {
    expect(extractYoutubeTimecode('')).toBe(null);
    expect(extractYoutubeTimecode(null)).toBe(null);
    expect(extractYoutubeTimecode('1:23:45')).toBe(null);
    expect(extractYoutubeTimecode('juste du texte')).toBe(null);
  });

  it('retourne null pour URL YouTube sans timecode', () => {
    expect(extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ')).toBe(null);
    expect(extractYoutubeTimecode('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(null);
  });

  it('extrait ?t=NNN (secondes brutes)', () => {
    const r = extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ?t=1118');
    expect(r).toEqual({ seconds: 1118, videoId: 'dQw4w9WgXcQ' });
  });

  it('extrait ?t=NNNs', () => {
    const r = extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ?t=1118s');
    expect(r).toEqual({ seconds: 1118, videoId: 'dQw4w9WgXcQ' });
  });

  it('extrait ?t=MmSs composé', () => {
    expect(extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ?t=18m38s'))
      .toEqual({ seconds: 1118, videoId: 'dQw4w9WgXcQ' });
    expect(extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ?t=1h2m3s'))
      .toEqual({ seconds: 3723, videoId: 'dQw4w9WgXcQ' });
  });

  it('extrait &t= (position secondaire dans l\'URL)', () => {
    const r = extractYoutubeTimecode('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    expect(r).toEqual({ seconds: 42, videoId: 'dQw4w9WgXcQ' });
  });

  it('accepte ?start=NNN (alias historique)', () => {
    const r = extractYoutubeTimecode('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=90');
    expect(r).toEqual({ seconds: 90, videoId: 'dQw4w9WgXcQ' });
  });

  it('renvoie seconds=0 pour ?t=0 (edge case)', () => {
    const r = extractYoutubeTimecode('https://youtu.be/dQw4w9WgXcQ?t=0');
    expect(r).toEqual({ seconds: 0, videoId: 'dQw4w9WgXcQ' });
  });

  it('videoId null quand URL non reconnue mais timecode présent', () => {
    // Cas edge : quelqu'un colle un fragment style "?t=1118" sans URL complète
    expect(extractYoutubeTimecode('?t=1118')).toEqual({ seconds: 1118, videoId: null });
  });
});

// ─────────────────────────────────────────────────────────
// buildYoutubeUrl
// ─────────────────────────────────────────────────────────

describe('buildYoutubeUrl', () => {
  it('retourne null pour URL invalide', () => {
    expect(buildYoutubeUrl('', 0)).toBe(null);
    expect(buildYoutubeUrl('not-a-url', 0)).toBe(null);
  });

  it('construit URL sans timecode', () => {
    expect(buildYoutubeUrl('https://youtu.be/dQw4w9WgXcQ', 0)).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(buildYoutubeUrl('dQw4w9WgXcQ', null)).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('construit URL avec timecode', () => {
    expect(buildYoutubeUrl('https://youtu.be/dQw4w9WgXcQ', 90)).toBe('https://youtu.be/dQw4w9WgXcQ?t=90s');
    expect(buildYoutubeUrl('dQw4w9WgXcQ', 3600)).toBe('https://youtu.be/dQw4w9WgXcQ?t=3600s');
  });

  it('tronque les décimales sur le timecode', () => {
    expect(buildYoutubeUrl('dQw4w9WgXcQ', 90.7)).toBe('https://youtu.be/dQw4w9WgXcQ?t=90s');
  });
});

// ─────────────────────────────────────────────────────────
// timecodeKey
// ─────────────────────────────────────────────────────────

describe('timecodeKey', () => {
  it('génère clé pour session avec num', () => {
    expect(timecodeKey('MQ', 1, 'Supercar')).toBe('MQ1__Supercar');
    expect(timecodeKey('DF', 2, 'Super1600')).toBe('DF2__Super1600');
    expect(timecodeKey('QF', 3, 'D4')).toBe('QF3__D4');
  });

  it('génère clé pour session sans num (EC, FIN)', () => {
    expect(timecodeKey('FIN', null, 'Supercar')).toBe('FIN__Supercar');
    expect(timecodeKey('EC', null, 'Supercar')).toBe('EC__Supercar');
  });

  it('normalise les accents et espaces dans la catégorie', () => {
    expect(timecodeKey('MQ', 1, 'Féminines')).toBe('MQ1__Feminines');
    expect(timecodeKey('MQ', 1, 'Division 5')).toBe('MQ1__Division_5');
  });
});
