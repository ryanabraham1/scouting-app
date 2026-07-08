// src/dash/__tests__/nexusClient.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseNexusEventStatus,
  isPracticeLabel,
  ON_FIELD_STALE_MS,
  QUEUING_STALE_MS,
} from '@/dash/nexusClient';

// Fixture times anchor around this epoch; pass it as `now` so the staleness
// gates see the snapshot as live (real Date.now() would see everything as
// hours-old leftovers — which is its own test below).
const NOW = 1_700_000_700_000;

const payload = {
  eventKey: '2024onwa',
  dataAsOfTime: 1_700_000_000_000,
  nowQueuing: 'Qualification 12',
  matches: [
    {
      label: 'Qualification 10',
      status: 'Completed',
      redTeams: ['254', '1114', '111'],
      blueTeams: ['148', '2056', '67'],
      times: { estimatedStartTime: 1_700_000_000_000 },
    },
    {
      label: 'Qualification 11',
      status: 'On field',
      redTeams: ['100', '200', '300'],
      blueTeams: ['400', '500', '600'],
      times: { estimatedStartTime: 1_700_000_600_000 },
    },
    {
      label: 'Qualification 12',
      status: 'Now queuing',
      redTeams: ['1', '2', '3'],
      blueTeams: ['4', '5', '6'],
      times: { estimatedStartTime: 1_700_001_200_000 },
    },
    {
      label: 'Qualification 13',
      status: 'On deck',
      redTeams: ['7', '8', '9'],
      blueTeams: ['10', '11', '12'],
      times: { estimatedStartTime: 1_700_001_800_000 },
    },
  ],
};

describe('parseNexusEventStatus', () => {
  it('extracts top-level fields and parses team numbers', () => {
    const s = parseNexusEventStatus(payload);
    expect(s.eventKey).toBe('2024onwa');
    expect(s.dataAsOfTime).toBe(1_700_000_000_000);
    expect(s.nowQueuing).toBe('Qualification 12');
    expect(s.matches).toHaveLength(4);
    expect(s.matches[0].redTeams).toEqual([254, 1114, 111]);
  });

  it('identifies on-field and queuing matches', () => {
    const s = parseNexusEventStatus(payload, NOW);
    expect(s.onField?.label).toBe('Qualification 11');
    // queuing prefers the label matching nowQueuing.
    expect(s.queuing?.label).toBe('Qualification 12');
  });

  it('orders upcoming by estimated start and excludes completed', () => {
    const s = parseNexusEventStatus(payload, NOW);
    const labels = s.upcoming.map((m) => m.label);
    expect(labels).not.toContain('Qualification 10'); // completed excluded
    expect(labels).toEqual([
      'Qualification 11',
      'Qualification 12',
      'Qualification 13',
    ]);
  });

  it('is defensive: handles missing/garbage payloads without throwing', () => {
    expect(() => parseNexusEventStatus(null)).not.toThrow();
    expect(() => parseNexusEventStatus(undefined)).not.toThrow();
    expect(() => parseNexusEventStatus(42)).not.toThrow();
    const empty = parseNexusEventStatus({});
    expect(empty.matches).toEqual([]);
    expect(empty.onField).toBeNull();
    expect(empty.queuing).toBeNull();
    expect(empty.nowQueuing).toBeNull();
    expect(empty.upcoming).toEqual([]);
  });

  it('does NOT let a lingering "On field" practice match freeze the field (the P1 bug)', () => {
    // The event has moved on to quals, but Nexus still has Practice 3 marked
    // "On field". Once real matches exist, practice must be ignored for live
    // selection — so On Field shows the qual (or nothing), never "Practice 3".
    const s = parseNexusEventStatus({
      eventKey: '2026txhou1',
      nowQueuing: 'Qualification 8',
      matches: [
        {
          label: 'Practice 3',
          status: 'On field',
          redTeams: ['1'],
          blueTeams: ['2'],
          times: { estimatedStartTime: 1_700_000_000_000 },
        },
        {
          label: 'Qualification 7',
          status: 'On field',
          redTeams: ['100', '200', '300'],
          blueTeams: ['400', '500', '600'],
          times: { estimatedStartTime: 1_700_000_700_000, actualQueueTime: 1_700_000_650_000 },
        },
        {
          label: 'Qualification 8',
          status: 'Now queuing',
          redTeams: ['7'],
          blueTeams: ['8'],
          times: { estimatedStartTime: 1_700_001_300_000 },
        },
      ],
    }, NOW);
    expect(s.onField?.label).toBe('Qualification 7');
    expect(s.queuing?.label).toBe('Qualification 8');
    expect(s.upcoming.map((m) => m.label)).not.toContain('Practice 3');
  });

  it('shows a practice match on field only when NO real match exists yet', () => {
    const s = parseNexusEventStatus({
      matches: [
        { label: 'Practice 2', status: 'On field', redTeams: ['1'], blueTeams: ['2'], times: {} },
      ],
    });
    expect(s.onField?.label).toBe('Practice 2');
  });

  it('breaks an "On field" tie by freshness (defensive against stale duplicates)', () => {
    const s = parseNexusEventStatus({
      matches: [
        {
          label: 'Qualification 5',
          status: 'On field',
          redTeams: ['1'],
          blueTeams: ['2'],
          times: { actualQueueTime: 1_700_000_000_000 },
        },
        {
          label: 'Qualification 6',
          status: 'On field',
          redTeams: ['3'],
          blueTeams: ['4'],
          times: { actualQueueTime: 1_700_000_600_000 },
        },
      ],
    }, NOW);
    expect(s.onField?.label).toBe('Qualification 6'); // freshest actualQueueTime
  });

  it('drops STALE on-field/queuing claims (the 2026iscmp overnight bug)', () => {
    // Some events' feeds never flip matches to "Completed": every played match
    // stays "On field" forever. Overnight, the field tiles showed a replay from
    // hours earlier. A claim whose field-touch time is long past must be treated
    // as done — tiles show nothing, and upcoming skips the leftovers.
    const played = ON_FIELD_STALE_MS + 60_000; // played ~21 min before `now`
    const s = parseNexusEventStatus(
      {
        matches: [
          {
            label: 'Qualification 4 Replay',
            status: 'On field',
            redTeams: ['1'],
            blueTeams: ['2'],
            times: { actualOnFieldTime: NOW - played, actualQueueTime: NOW - played - 600_000 },
          },
          {
            label: 'Qualification 3',
            status: 'Now queuing',
            redTeams: ['3'],
            blueTeams: ['4'],
            times: { actualQueueTime: NOW - QUEUING_STALE_MS - 60_000 },
          },
          {
            label: 'Qualification 52',
            status: 'Queuing soon',
            redTeams: ['5'],
            blueTeams: ['6'],
            times: { estimatedStartTime: NOW + 8 * 3_600_000 }, // tomorrow
          },
        ],
      },
      NOW,
    );
    expect(s.onField).toBeNull(); // stale replay is NOT on the field
    expect(s.queuing).toBeNull(); // hours-old queue claim is dead too
    // Upcoming drops the stale ON-FIELD leftover (it demonstrably played) but
    // keeps the stale queuing row (could be a delayed match, not a played one);
    // with no schedule estimate it sorts last.
    expect(s.upcoming.map((m) => m.label)).toEqual(['Qualification 52', 'Qualification 3']);
  });

  it('keeps a FRESH on-field claim (staleness gate must not blank live play)', () => {
    const s = parseNexusEventStatus(
      {
        matches: [
          {
            label: 'Qualification 20',
            status: 'On field',
            redTeams: ['1'],
            blueTeams: ['2'],
            times: { actualOnFieldTime: NOW - 120_000 }, // 2 min ago — live
          },
        ],
      },
      NOW,
    );
    expect(s.onField?.label).toBe('Qualification 20');
  });

  it('isPracticeLabel matches Nexus practice labels only', () => {
    expect(isPracticeLabel('Practice 1')).toBe(true);
    expect(isPracticeLabel('practice 12')).toBe(true);
    expect(isPracticeLabel('Qualification 1')).toBe(false);
    expect(isPracticeLabel('Playoff 3')).toBe(false);
    expect(isPracticeLabel('')).toBe(false);
    expect(isPracticeLabel(null)).toBe(false);
  });

  it('drops malformed matches and junk team entries', () => {
    const s = parseNexusEventStatus({
      matches: [
        { status: 'On field' }, // no label -> dropped
        {
          label: 'Qualification 1',
          status: 'On deck',
          redTeams: ['frc254', null, 'abc', '99'],
          blueTeams: 'not-an-array',
          times: null,
        },
      ],
    });
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0].redTeams).toEqual([254, 99]);
    expect(s.matches[0].blueTeams).toEqual([]);
    expect(s.matches[0].times.estimatedStartTime).toBeNull();
  });
});
