import { describe, it, expect } from 'vitest';
import {
  selectOnDeck,
  nexusStatusForKey,
  onDeckHeadline,
  type OnDeckMatch,
} from '@/capture/onDeck';
import type { NexusEventStatus, NexusMatch } from '@/dash/nexusClient';

const EVENT = '2026casnv';

function assign(num: number, color: 'red' | 'blue' = 'red', team = 100 + num): OnDeckMatch {
  return {
    match_key: `${EVENT}_qm${num}`,
    alliance_color: color,
    station: 1,
    target_team_number: team,
  };
}

function nexusMatch(label: string, status: string | null): NexusMatch {
  return {
    label,
    status,
    redTeams: [],
    blueTeams: [],
    times: {
      estimatedQueueTime: null,
      estimatedOnDeckTime: null,
      estimatedOnFieldTime: null,
      estimatedStartTime: null,
      actualQueueTime: null,
      actualOnFieldTime: null,
    },
  };
}

function status(matches: NexusMatch[]): NexusEventStatus {
  return {
    eventKey: EVENT,
    dataAsOfTime: null,
    nowQueuing: null,
    onField: null,
    queuing: null,
    matches,
    upcoming: [],
  };
}

describe('nexusStatusForKey', () => {
  it('matches a key to a Nexus label by trailing number + level prefix', () => {
    const s = status([nexusMatch('Qualification 73', 'On deck')]);
    expect(nexusStatusForKey(s, '2026casnv_qm73')).toBe('on deck');
  });

  it('does not match across levels with the same number', () => {
    const s = status([nexusMatch('Semifinal 3', 'On field')]);
    expect(nexusStatusForKey(s, '2026casnv_qm3')).toBeNull();
  });

  it('returns null when status is unavailable', () => {
    expect(nexusStatusForKey(null, '2026casnv_qm1')).toBeNull();
  });
});

describe('selectOnDeck — live Nexus signal', () => {
  const todo = [assign(70), assign(71), assign(72)];

  it('flags on-deck when Nexus reports it', () => {
    const s = status([nexusMatch('Qualification 71', 'On deck')]);
    const r = selectOnDeck(todo, s, () => null);
    expect(r?.assignment.match_key).toBe('2026casnv_qm71');
    expect(r?.urgency).toBe('on-deck');
    expect(r?.liveStatus).toBe('on deck');
  });

  it('prefers on-field over on-deck over queuing', () => {
    const s = status([
      nexusMatch('Qualification 70', 'Now queuing'),
      nexusMatch('Qualification 71', 'On field'),
      nexusMatch('Qualification 72', 'On deck'),
    ]);
    const r = selectOnDeck(todo, s, () => null);
    expect(r?.assignment.match_key).toBe('2026casnv_qm71');
    expect(r?.urgency).toBe('on-field');
  });

  it('ignores non-live statuses (completed/null)', () => {
    const s = status([
      nexusMatch('Qualification 70', 'Completed'),
      nexusMatch('Qualification 71', null),
    ]);
    expect(selectOnDeck(todo, s, () => null)).toBeNull();
  });
});

describe('selectOnDeck — schedule fallback (offline)', () => {
  const now = Date.parse('2026-06-30T12:00:00Z');
  const todo = [assign(70), assign(71)];

  it('flags the head assignment "soon" when scheduled within the window', () => {
    const soon = new Date(now + 4 * 60 * 1000).toISOString();
    const r = selectOnDeck(todo, null, (a) =>
      a.match_key.endsWith('qm70') ? soon : null,
      { now },
    );
    expect(r?.assignment.match_key).toBe('2026casnv_qm70');
    expect(r?.urgency).toBe('soon');
    expect(r?.liveStatus).toBeNull();
  });

  it('does not flag when the next match is far out', () => {
    const far = new Date(now + 60 * 60 * 1000).toISOString();
    const r = selectOnDeck(todo, null, () => far, { now });
    expect(r).toBeNull();
  });

  it('returns null with no schedule time (offline, unknown)', () => {
    expect(selectOnDeck(todo, null, () => null, { now })).toBeNull();
  });

  it('returns null for an empty todo list', () => {
    expect(selectOnDeck([], null, () => null, { now })).toBeNull();
  });

  it('live Nexus takes precedence over schedule', () => {
    const s = status([nexusMatch('Qualification 71', 'On deck')]);
    const soon = new Date(now + 1 * 60 * 1000).toISOString();
    const r = selectOnDeck(todo, s, () => soon, { now });
    // Nexus flags qm71 on-deck, which wins over the schedule head qm70.
    expect(r?.assignment.match_key).toBe('2026casnv_qm71');
    expect(r?.urgency).toBe('on-deck');
  });
});

describe('onDeckHeadline', () => {
  it('returns a distinct headline per urgency', () => {
    const heads = (['on-field', 'on-deck', 'queuing', 'soon'] as const).map(onDeckHeadline);
    expect(new Set(heads).size).toBe(4);
    expect(onDeckHeadline('on-deck')).toMatch(/on deck/i);
  });
});
