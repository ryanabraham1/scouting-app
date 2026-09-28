import { describe, expect, it, vi } from 'vitest';
import {
  ensureEventTeams,
  referencedTeamNumbers,
  type EventTeamInput,
} from '../../supabase/functions/_shared/ensureEventTeams';

const row = (teams: Array<number | null>) => ({
  match_key: '2026cc_qm1',
  event_key: '2026cc',
  red1: teams[0],
  red2: teams[1],
  red3: teams[2],
  blue1: teams[3],
  blue2: teams[4],
  blue3: teams[5],
});

/** Fake of the ensure_event_teams RPC: `atEvent` is the event's team list. */
function fakeRpc(atEvent: number[], error: string | null = null) {
  const have = new Set(atEvent);
  return vi.fn(async (teams: EventTeamInput[]) => {
    if (error) return { data: null, error: { message: error } };
    const added = teams.map((t) => t.team_number).filter((team) => !have.has(team));
    for (const team of added) have.add(team);
    return { data: added, error: null };
  });
}

describe('referencedTeamNumbers', () => {
  it('collects distinct roster teams and ignores gaps and non-roster columns', () => {
    expect(
      referencedTeamNumbers([
        row([254, 1678, null, 971, 254, 3256]),
        { match_key: 'x', actual_red_score: 99 },
      ]),
    ).toEqual([254, 971, 1678, 3256]);
  });
});

describe('ensureEventTeams', () => {
  it('skips the RPC for rows without a roster', async () => {
    const rpc = fakeRpc([]);
    expect(await ensureEventTeams(rpc, [row([null, null, null, null, null, null])])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends every referenced team and reports nothing added when all are present', async () => {
    const rpc = fakeRpc([118, 148, 254, 971, 1678, 3256]);
    const nicknameFor = vi.fn();
    const added = await ensureEventTeams(rpc, [row([254, 1678, 971, 3256, 118, 148])], nicknameFor);
    expect(added).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toEqual(
      [118, 148, 254, 971, 1678, 3256].map((team_number) => ({ team_number })),
    );
    expect(nicknameFor).not.toHaveBeenCalled();
  });

  it('adds a late team, then fills its nickname in a second call', async () => {
    const rpc = fakeRpc([118, 254, 971, 1678, 3256]);
    const added = await ensureEventTeams(
      rpc,
      [row([254, 1678, 971, 3256, 118, 9999])],
      async (team) => (team === 9999 ? 'Late Bots' : null),
    );
    expect(added).toEqual([9999]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][0]).toEqual([{ team_number: 9999, nickname: 'Late Bots' }]);
  });

  it('keeps the added team when the nickname lookup fails', async () => {
    const rpc = fakeRpc([]);
    const added = await ensureEventTeams(rpc, [row([42, null, null, null, null, null])], async () => {
      throw new Error('tba down');
    });
    expect(added).toEqual([42]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('throws when the RPC fails so the caller can skip the match write', async () => {
    await expect(
      ensureEventTeams(fakeRpc([], 'event does not exist'), [row([42, null, null, null, null, null])]),
    ).rejects.toThrow('event does not exist');
  });
});
