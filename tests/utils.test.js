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
