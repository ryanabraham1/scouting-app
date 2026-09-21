// src/dash/__tests__/matchStream.test.ts
// resolveMatchStream maps a match onto its day's YouTube livestream: which
// video id, where in it the match starts (given the stream's calibrated start),
// and whether the start is FMS-actual or only estimated.

import { describe, it, expect } from 'vitest';
import { resolveMatchStream, matchStartMs } from '@/dash/matchStream';

const webcasts = [
  { type: 'youtube', channel: 'friVid', date: '2026-09-18' },
  { type: 'youtube', channel: 'satVid', date: '2026-09-19' },
  { type: 'twitch', channel: 'robosportsnetwork' },
];

// 2026-09-19 local; stream began 10:00, match started 10:30.
const streamStart = new Date(2026, 8, 19, 10, 0, 0);
const matchStart = new Date(2026, 8, 19, 10, 30, 0);
const sync = { satVid: { video_id: 'satVid', stream_start_at: streamStart.toISOString(), source: 'auto' as const } };

describe('matchStartMs', () => {
  it('prefers actual_time, then predicted, then scheduled', () => {
    expect(
      matchStartMs({ actual_time: '2026-09-19T17:30:00Z', predicted_time: '2026-09-19T17:35:00Z', scheduled_time: null }),
    ).toEqual({ ms: Date.parse('2026-09-19T17:30:00Z'), approximate: false });
    expect(
      matchStartMs({ actual_time: null, predicted_time: '2026-09-19T17:35:00Z', scheduled_time: '2026-09-19T17:00:00Z' }),
    ).toEqual({ ms: Date.parse('2026-09-19T17:35:00Z'), approximate: true });
    expect(matchStartMs({ actual_time: null, predicted_time: null, scheduled_time: null })).toBeNull();
  });
});

describe('resolveMatchStream', () => {
  it("picks the stream dated on the match's day and computes t0 from the calibration", () => {
    const target = resolveMatchStream(
      { actual_time: matchStart.toISOString(), predicted_time: null, scheduled_time: null },
      webcasts,
      sync,
    );
    expect(target).toEqual({
      videoId: 'satVid',
      matchStartMs: matchStart.getTime(),
      approximate: false,
      streamStartMs: streamStart.getTime(),
      t0Seconds: 30 * 60,
    });
  });

  it('returns the stream with t0=null when it is not calibrated yet', () => {
    const target = resolveMatchStream(
      { actual_time: matchStart.toISOString(), predicted_time: null, scheduled_time: null },
      webcasts,
      {},
    );
    expect(target?.videoId).toBe('satVid');
    expect(target?.t0Seconds).toBeNull();
    expect(target?.streamStartMs).toBeNull();
  });

  it('treats a match that predates the calibrated stream start as uncalibrated', () => {
    const target = resolveMatchStream(
      { actual_time: new Date(2026, 8, 19, 9, 0, 0).toISOString(), predicted_time: null, scheduled_time: null },
      webcasts,
      sync,
    );
    expect(target?.t0Seconds).toBeNull();
  });

  it('flags an estimated start when only predicted/scheduled times exist', () => {
    const target = resolveMatchStream(
      { actual_time: null, predicted_time: matchStart.toISOString(), scheduled_time: null },
      webcasts,
      sync,
    );
    expect(target?.approximate).toBe(true);
    expect(target?.t0Seconds).toBe(30 * 60);
  });

  it('resolves to null for a Twitch-only day, a match with no time, or no webcasts', () => {
    const noTime = { actual_time: null, predicted_time: null, scheduled_time: null };
    expect(resolveMatchStream(noTime, webcasts, sync)).toBeNull();
    const withTime = { actual_time: matchStart.toISOString(), predicted_time: null, scheduled_time: null };
    expect(resolveMatchStream(withTime, [], sync)).toBeNull();
    expect(resolveMatchStream(withTime, undefined, sync)).toBeNull();
    expect(resolveMatchStream(withTime, [{ type: 'twitch', channel: 'x' }], sync)).toBeNull();
  });
});
