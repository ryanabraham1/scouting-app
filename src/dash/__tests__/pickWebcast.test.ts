// src/dash/__tests__/pickWebcast.test.ts
// Multi-day events (e.g. Chezy Champs) publish one youtube webcast per day with
// a `date`, plus an undated twitch stream. The dashboard must embed *today's*
// stream, not whichever one TBA lists first.

import { describe, it, expect } from 'vitest';
import { pickWebcast } from '@/dash/useEventData';

const chezy = {
  webcasts: [
    { type: 'youtube', channel: 'friVid', date: '2026-09-18' },
    { type: 'youtube', channel: 'satVid', date: '2026-09-19' },
    { type: 'youtube', channel: 'sunVid', date: '2026-09-20' },
    { type: 'twitch', channel: 'robosportsnetwork' },
  ],
};

describe('pickWebcast', () => {
  it("picks the youtube stream dated today over TBA's first entry", () => {
    expect(pickWebcast(chezy, '2026-09-19')).toEqual({
      type: 'youtube',
      channel: 'satVid',
      file: null,
    });
    expect(pickWebcast(chezy, '2026-09-20')?.channel).toBe('sunVid');
  });

  it('falls back to an undated all-event stream when no stream is dated today', () => {
    expect(pickWebcast(chezy, '2026-09-21')?.channel).toBe('robosportsnetwork');
  });

  it('falls back to a dated stream from another day when nothing else is embeddable', () => {
    const onlyDated = { webcasts: chezy.webcasts.slice(0, 3) };
    expect(pickWebcast(onlyDated, '2026-09-21')?.channel).toBe('friVid');
  });

  it('prefers embeddable types over others and keeps a non-embeddable last resort', () => {
    expect(
      pickWebcast({ webcasts: [{ type: 'livestream', channel: 'x' }, { type: 'twitch', channel: 't' }] }, '2026-01-01')
        ?.type,
    ).toBe('twitch');
    expect(pickWebcast({ webcasts: [{ type: 'livestream', channel: 'x' }] }, '2026-01-01')?.type).toBe(
      'livestream',
    );
  });

  it('returns null for missing/empty/malformed webcasts', () => {
    expect(pickWebcast(null)).toBeNull();
    expect(pickWebcast({})).toBeNull();
    expect(pickWebcast({ webcasts: [] })).toBeNull();
    expect(pickWebcast({ webcasts: [{ channel: 'noType' }, null] })).toBeNull();
  });
});
