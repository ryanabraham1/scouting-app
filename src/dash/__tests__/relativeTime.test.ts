// src/dash/__tests__/relativeTime.test.ts
import { describe, it, expect } from 'vitest';
import { relativeTime } from '@/dash/relativeTime';

const NOW = Date.parse('2026-06-29T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe('relativeTime', () => {
  it('returns "no reports yet" for null / empty / unparseable', () => {
    expect(relativeTime(null, NOW)).toBe('no reports yet');
    expect(relativeTime('', NOW)).toBe('no reports yet');
    expect(relativeTime('not-a-date', NOW)).toBe('no reports yet');
  });

  it('treats <60s as "just now"', () => {
    expect(relativeTime(ago(10 * SEC), NOW)).toBe('just now');
  });

  it('rounds minutes for <60m', () => {
    expect(relativeTime(ago(90 * SEC), NOW)).toBe('1m ago'); // floor(1.5) = 1
    expect(relativeTime(ago(25 * MIN), NOW)).toBe('25m ago');
  });

  it('formats hours+minutes for <24h and drops " 0m"', () => {
    expect(relativeTime(ago(75 * MIN), NOW)).toBe('1h 15m ago');
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe('2h ago');
  });

  it('formats days for >=24h', () => {
    expect(relativeTime(ago(50 * HOUR), NOW)).toBe('2d ago');
  });

  it('treats a future timestamp (clock skew) as "just now"', () => {
    expect(relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('just now');
  });
});
