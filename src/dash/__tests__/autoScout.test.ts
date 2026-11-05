import { describe, expect, it, vi } from 'vitest';
import {
  hashMatches,
  isValidEnvelope,
  parseJobReport,
  parseWorkerInfo,
  tokenHash,
} from '../../../supabase/functions/_shared/autoscoutWorker';
import {
  allianceFuel,
  streamChoices,
  unfinishedMatches,
  workerOnline,
  youtubeId,
  type AutoScoutWorker,
} from '../autoScoutClient';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const SECRET = 'x'.repeat(40);
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const MATCH = '2026cc_qm40';

describe('worker token', () => {
  it('hashes the bearer token the way Python’s hashlib does', async () => {
    expect(await tokenHash(`Bearer ${SECRET}`)).toBe('bd913ff68243d41b9611b2690dfbf2b0f6e42ea14536a98232af60e9f64ffdaa');
  });

  it('accepts only the exact token', async () => {
    const stored = await tokenHash(`Bearer ${SECRET}`);
    expect(hashMatches(await tokenHash(`Bearer ${SECRET}`), stored)).toBe(true);
    expect(hashMatches(await tokenHash(`Bearer ${'y'.repeat(40)}`), stored)).toBe(false);
  });

  it('refuses a malformed header, and everything while no hash is stored', async () => {
    expect(await tokenHash(SECRET)).toBeNull();
    expect(await tokenHash(null)).toBeNull();
    expect(await tokenHash('Bearer short')).toBeNull();
    expect(hashMatches(await tokenHash(`Bearer ${SECRET}`), null)).toBe(false);
    expect(hashMatches(null, null)).toBe(false);
  });
});

describe('job reports', () => {
  it('keeps only known, bounded fields', () => {
    const report = parseJobReport({
      id: JOB_ID,
      status: 'running',
      completed_matches: [MATCH, '../evil', 7],
      match_errors: { [MATCH]: 'y'.repeat(900), bad: 'dropped' },
      progress: { match_key: MATCH, pct: 41.5, recorder: 'recording', path: 'C:/secret', eta_s: Infinity },
      error: null,
      status_override: 'succeeded',
    });
    expect(report?.completed_matches).toEqual([MATCH]);
    expect(Object.keys(report?.match_errors ?? {})).toEqual([MATCH]);
    expect(report?.match_errors[MATCH]).toHaveLength(300);
    expect(report?.progress).toEqual({ match_key: MATCH, recorder: 'recording', pct: 41.5 });
    expect(report).not.toHaveProperty('status_override');
  });

  it.each([
    [null],
    [{ id: 'not-a-uuid', status: 'running' }],
    [{ id: JOB_ID, status: 'hacked' }],
    [{ id: JOB_ID }],
  ])('refuses %j', (raw) => {
    expect(parseJobReport(raw)).toBeNull();
  });

  it('survives junk worker info', () => {
    expect(parseWorkerInfo('nope')).toEqual({ calibrated_events: [], free_gb: null, busy: false });
    expect(parseWorkerInfo({ calibrated_events: ['2026cc', 7, 'x y'], free_gb: 12.5, busy: true })).toEqual({
      calibrated_events: ['2026cc'],
      free_gb: 12.5,
      busy: true,
    });
  });
});

describe('result envelopes', () => {
  const good = { schema_version: 1, source: 'autoscout', match: { match_key: MATCH, teams: {} } };

  it('accepts the versioned envelope for its own match', () => {
    expect(isValidEnvelope(good, MATCH)).toBe(true);
  });

  it.each([
    ['another match', good, '2026cc_qm41'],
    ['a future schema', { ...good, schema_version: 2 }, MATCH],
    ['another source', { ...good, source: 'human' }, MATCH],
    ['no teams', { ...good, match: { match_key: MATCH } }, MATCH],
    ['junk', 'nope', MATCH],
  ])('refuses %s', (_name, raw, key) => {
    expect(isValidEnvelope(raw, key)).toBe(false);
  });
});

describe('page helpers', () => {
  const worker = (ageMs: number): AutoScoutWorker => ({
    last_seen_at: new Date(1_000_000 - ageMs).toISOString(),
    calibrated_events: [],
    free_gb: null,
    busy: false,
  });

  it('calls the computer offline after a minute of silence', () => {
    expect(workerOnline(worker(30_000), 1_000_000)).toBe(true);
    expect(workerOnline(worker(61_000), 1_000_000)).toBe(false);
    expect(workerOnline(null)).toBe(false);
  });

  it('retries only what did not finish', () => {
    expect(unfinishedMatches({ match_keys: ['a', 'b', 'c'], completed_matches: ['b'] })).toEqual(['a', 'c']);
  });

  it('lists each day of a multi-day event once, and skips what can’t be fetched', () => {
    const choices = streamChoices([
      { type: 'youtube', channel: 'abc123def45', date: '2026-10-03' },
      { type: 'youtube', channel: 'UCchannel', file: 'xyz789uvw12', date: '2026-10-04' },
      { type: 'youtube', channel: 'abc123def45', date: '2026-10-03' },
      { type: 'twitch', channel: 'firstinspires' },
      { type: 'livestream', channel: '123' },
      'junk',
    ]);
    expect(choices.map((c) => c.url)).toEqual([
      'https://www.youtube.com/watch?v=abc123def45',
      'https://www.youtube.com/watch?v=xyz789uvw12',
      'https://www.twitch.tv/firstinspires',
    ]);
    expect(choices[0].label).toBe('YouTube · 2026-10-03');
  });

  it.each([
    ['https://www.youtube.com/watch?v=abc123def45&t=3', 'abc123def45'],
    ['https://youtu.be/abc123def45', 'abc123def45'],
    ['https://www.youtube.com/live/abc123def45', 'abc123def45'],
    ['https://www.twitch.tv/firstinspires', null],
    ['not a url', null],
  ])('reads the video id from %s', (url, id) => {
    expect(youtubeId(url)).toBe(id);
  });

  it('totals fuel per alliance, ignoring missing values', () => {
    expect(allianceFuel({ teams: {
      1: { alliance: 'red', fuel_scored: 10 },
      2: { alliance: 'red', fuel_scored: 5 },
      3: { alliance: 'blue', fuel_scored: 7 },
      4: { alliance: 'blue' },
    } })).toEqual({ red: 15, blue: 7 });
  });
});
