import { describe, expect, it } from 'vitest';
import { matchTimeDisplay } from '@/capture/matchTime';

const NOW = Date.parse('2026-04-04T20:00:00Z');

describe('matchTimeDisplay', () => {
  it('prefers TBA predicted time and rounds the countdown to whole minutes', () => {
    expect(
      matchTimeDisplay(
        {
          predicted_time: '2026-04-04T20:18:20Z',
          scheduled_time: '2026-04-04T20:10:00Z',
        },
        { now: NOW, locale: 'en-US', timeZone: 'UTC' },
      ),
    ).toEqual({
      source: 'estimated',
      clock: '8:18 PM',
      relative: 'in 18 min',
      state: 'future',
      minutesAway: 18,
    });
  });

  it('falls back to the scheduled time when no prediction exists', () => {
    const display = matchTimeDisplay(
      { predicted_time: null, scheduled_time: '2026-04-04T20:18:00Z' },
      { now: NOW, locale: 'en-US', timeZone: 'America/Los_Angeles' },
    );
    expect(display?.source).toBe('scheduled');
    expect(display?.clock).toBe('1:18 PM');
    expect(display?.relative).toBe('in 18 min');
  });

  it('shows starting now from one minute before through the two-minute grace', () => {
    expect(
      matchTimeDisplay(
        { predicted_time: '2026-04-04T20:00:30Z' },
        { now: NOW, timeZone: 'UTC' },
      )?.state,
    ).toBe('now');
    expect(
      matchTimeDisplay(
        { predicted_time: '2026-04-04T19:58:00Z' },
        { now: NOW, timeZone: 'UTC' },
      )?.relative,
    ).toBe('starting now');
  });

  it('calls an unplayed match late instead of showing a negative countdown', () => {
    const display = matchTimeDisplay(
      { predicted_time: '2026-04-04T19:57:59Z' },
      { now: NOW, timeZone: 'UTC' },
    );
    expect(display?.state).toBe('late');
    expect(display?.relative).toBe('running late');
    expect(display?.minutesAway).toBeNull();
  });

  it('returns null when both TBA times are missing or invalid', () => {
    expect(matchTimeDisplay({ predicted_time: null, scheduled_time: null }, { now: NOW })).toBeNull();
    expect(matchTimeDisplay({ predicted_time: 'bad', scheduled_time: 'also bad' }, { now: NOW })).toBeNull();
  });
});
