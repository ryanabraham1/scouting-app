import { describe, it, expect } from 'vitest';
import {
  formatMatchKey,
  formatMatchKeyRaw,
  formatMatchShort,
  compareMatchKeys,
  isQualLevel,
  isQualMatchKey,
} from '../formatMatch';

describe('formatMatchKey', () => {
  it('formats qualification matches', () => {
    expect(formatMatchKey('qm', 1)).toBe('Qual 1');
    expect(formatMatchKey('qm', 12)).toBe('Qual 12');
  });
  it('formats playoff levels', () => {
    expect(formatMatchKey('qf', 3)).toBe('Quarter 3');
    expect(formatMatchKey('sf', 1)).toBe('Semi 1');
    expect(formatMatchKey('f', 1)).toBe('Final 1');
    expect(formatMatchKey('ef', 2)).toBe('Eighth 2');
  });
  it('is case-insensitive and trims', () => {
    expect(formatMatchKey('QM', 5)).toBe('Qual 5');
    expect(formatMatchKey(' sf ', 2)).toBe('Semi 2');
  });
  it('falls back for unknown levels and missing numbers', () => {
    expect(formatMatchKey('pr', 4)).toBe('Pr 4');
    expect(formatMatchKey('qm', null)).toBe('Qual');
    expect(formatMatchKey('', null)).toBe('Match');
  });
});

describe('formatMatchKeyRaw', () => {
  it('parses event-prefixed raw keys', () => {
    expect(formatMatchKeyRaw('2026casnv_qm1')).toBe('Qual 1');
    expect(formatMatchKeyRaw('2026casnv_sf3')).toBe('Semi 3');
    expect(formatMatchKeyRaw('2026casnv_f1')).toBe('Final 1');
  });
  it('parses double-elim style tokens', () => {
    expect(formatMatchKeyRaw('2026casnv_sf3m1')).toBe('Semi 3');
  });
  it('disambiguates best-of-3 finals and double-elim replays (no collapse)', () => {
    expect(formatMatchKeyRaw('2026casnv_f1m1')).toBe('Final 1');
    expect(formatMatchKeyRaw('2026casnv_f1m2')).toBe('Final 2');
    expect(formatMatchKeyRaw('2026casnv_f1m3')).toBe('Final 3');
    expect(formatMatchKeyRaw('2026casnv_sf3m2')).toBe('Semi 3-2');
  });
  it('handles bare tokens and empty input', () => {
    expect(formatMatchKeyRaw('qm7')).toBe('Qual 7');
    expect(formatMatchKeyRaw('')).toBe('');
    expect(formatMatchKeyRaw('garbage')).toBe('garbage');
  });
});

describe('formatMatchShort', () => {
  it('compresses qual keys to "Q<n>"', () => {
    expect(formatMatchShort('2026casnv_qm1')).toBe('Q1');
    expect(formatMatchShort('2026casnv_qm15')).toBe('Q15');
    expect(formatMatchShort('qm7')).toBe('Q7');
  });
  it('uses the SET number for non-final playoff rounds (BUG-8: replays keep their set)', () => {
    expect(formatMatchShort('2026casnv_sf3m1')).toBe('SF3');
    // Replay of set 3 (game 2) must stay "SF3" — NOT "SF2" (the game number).
    expect(formatMatchShort('2026casnv_sf3m2')).toBe('SF3');
    expect(formatMatchShort('2026casnv_qf2m1')).toBe('QF2');
    expect(formatMatchShort('2026casnv_ef1m1')).toBe('EF1');
  });
  it('uses the GAME number for finals (best-of-N within one set)', () => {
    expect(formatMatchShort('2026casnv_f1m1')).toBe('F1');
    expect(formatMatchShort('2026casnv_f1m2')).toBe('F2');
    expect(formatMatchShort('2026casnv_f1m3')).toBe('F3');
    // No game suffix → fall back to the set number.
    expect(formatMatchShort('2026casnv_f1')).toBe('F1');
  });
  it('handles bare tokens and empty input', () => {
    expect(formatMatchShort('')).toBe('');
    expect(formatMatchShort(null)).toBe('');
    expect(formatMatchShort('garbage')).toBe('garbage');
  });
});

describe('isQualLevel', () => {
  it('treats qm/q/qual as qualification (case-insensitive, trimmed)', () => {
    expect(isQualLevel('qm')).toBe(true);
    expect(isQualLevel('q')).toBe(true);
    expect(isQualLevel('qual')).toBe(true);
    expect(isQualLevel('QM')).toBe(true);
    expect(isQualLevel(' Qual ')).toBe(true);
  });
  it('treats every playoff level as NOT a qual', () => {
    for (const lvl of ['sf', 'f', 'ef', 'qf', 'final']) {
      expect(isQualLevel(lvl)).toBe(false);
    }
  });
  it('treats empty/nullish as NOT a qual', () => {
    expect(isQualLevel('')).toBe(false);
    expect(isQualLevel(null)).toBe(false);
    expect(isQualLevel(undefined)).toBe(false);
  });
});

describe('isQualMatchKey', () => {
  it('recognizes qualification match keys (event-prefixed and bare)', () => {
    expect(isQualMatchKey('2026casnv_qm1')).toBe(true);
    expect(isQualMatchKey('2026casnv_qm73')).toBe(true);
    expect(isQualMatchKey('qm7')).toBe(true);
  });
  it('rejects playoff match keys', () => {
    expect(isQualMatchKey('2026casnv_sf3')).toBe(false);
    expect(isQualMatchKey('2026casnv_sf3m1')).toBe(false);
    expect(isQualMatchKey('2026casnv_f1')).toBe(false);
    expect(isQualMatchKey('2026casnv_f1m2')).toBe(false);
    expect(isQualMatchKey('2026casnv_qf2')).toBe(false);
    expect(isQualMatchKey('2026casnv_ef1')).toBe(false);
  });
  it('rejects empty/unparseable keys', () => {
    expect(isQualMatchKey('')).toBe(false);
    expect(isQualMatchKey(null)).toBe(false);
    expect(isQualMatchKey('garbage')).toBe(false);
  });
});

describe('compareMatchKeys', () => {
  it('orders by match number, not lexicographically (qm2 before qm10)', () => {
    const keys = ['2026casnv_qm10', '2026casnv_qm2', '2026casnv_qm1'];
    expect(keys.slice().sort(compareMatchKeys)).toEqual([
      '2026casnv_qm1',
      '2026casnv_qm2',
      '2026casnv_qm10',
    ]);
  });
  it('orders quals before playoffs before finals', () => {
    const keys = ['2026casnv_f1', '2026casnv_qm50', '2026casnv_sf3'];
    expect(keys.slice().sort(compareMatchKeys)).toEqual([
      '2026casnv_qm50',
      '2026casnv_sf3',
      '2026casnv_f1',
    ]);
  });
  it('orders games within a playoff set (f1m1 < f1m2 < f1m3; sf3m1 < sf3m2)', () => {
    // Without the m<game> suffix in the sort key, all games of a set compared
    // EQUAL — breaking next-match tracking + "last match" during finals.
    const keys = ['2026casnv_f1m3', '2026casnv_f1m1', '2026casnv_sf3m2', '2026casnv_f1m2', '2026casnv_sf3m1'];
    expect(keys.slice().sort(compareMatchKeys)).toEqual([
      '2026casnv_sf3m1',
      '2026casnv_sf3m2',
      '2026casnv_f1m1',
      '2026casnv_f1m2',
      '2026casnv_f1m3',
    ]);
    expect(compareMatchKeys('2026casnv_f1m1', '2026casnv_f1m2')).toBeLessThan(0);
    expect(compareMatchKeys('2026casnv_f1m2', '2026casnv_f1m1')).toBeGreaterThan(0);
  });
});
