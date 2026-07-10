import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const eq = vi.fn();
const select = vi.fn(() => ({ eq }));
const from = vi.fn((..._args: unknown[]) => ({ select }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
  },
}));

import {
  loadMatchAssignmentSnapshot,
  publishAssignments,
} from '../setAssignmentsClient';
import type { Assignment } from '../types';

const ASSIGNMENTS: Assignment[] = [
  { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
  { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 3, targetTeamNumber: 1678 },
];

describe('publishAssignments', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockClear();
    select.mockClear();
    eq.mockReset();
  });

  it('submits the base revision, verifies authoritative count, and returns applied', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'applied', revision: 4, count: 2 },
        error: null,
      });
    await expect(publishAssignments('2026casnv', ASSIGNMENTS, 3)).resolves.toEqual({
      status: 'applied',
      revision: 4,
      count: 2,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'set_assignments', {
      p_event_key: '2026casnv',
      p_assignments: [
        { match_key: '2026casnv_qm1', scout_id: 's1', alliance_color: 'red', station: 1, target_team_number: 254 },
        { match_key: '2026casnv_qm1', scout_id: 's2', alliance_color: 'blue', station: 3, target_team_number: 1678 },
      ],
      p_base_revision: 3,
    });
  });

  it('throws when the rpc returns an error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(publishAssignments('2026casnv', ASSIGNMENTS, 0)).rejects.toThrow(/permission denied/);
  });

  it('accepts a repeated idempotent publish without advancing revision', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'idempotent', revision: 8, count: 2 },
        error: null,
      });
    await expect(publishAssignments('2026casnv', ASSIGNMENTS, 8)).resolves.toMatchObject({
      status: 'idempotent',
      revision: 8,
    });
  });

  it('returns a conflict for a reverse/stale publish and does not verify it as success', async () => {
    rpc.mockResolvedValueOnce({
      data: { status: 'conflict', revision: 9, count: 2 },
      error: null,
    });
    await expect(
      publishAssignments('2026casnv', [...ASSIGNMENTS].reverse(), 8),
    ).resolves.toEqual({ status: 'conflict', revision: 9, count: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects an authoritative count mismatch', async () => {
    rpc.mockResolvedValueOnce({
      data: { status: 'applied', revision: 2, count: 1 },
      error: null,
    });
    await expect(publishAssignments('2026casnv', ASSIGNMENTS, 1)).rejects.toThrow(
      /expected 2, server wrote 1/i,
    );
  });

  it('loads rows only when before/after revision and count are stable', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'authoritative', revision: 5, count: 2 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'authoritative', revision: 5, count: 2 },
        error: null,
      });
    eq.mockResolvedValueOnce({
      data: [
        { match_key: '2026casnv_qm1', scout_id: 's1', alliance_color: 'red', station: 1, target_team_number: 254 },
        { match_key: '2026casnv_qm1', scout_id: 's2', alliance_color: 'blue', station: 3, target_team_number: 1678 },
      ],
      error: null,
    });

    await expect(loadMatchAssignmentSnapshot('2026casnv')).resolves.toEqual({
      state: { status: 'authoritative', revision: 5, count: 2 },
      assignments: ASSIGNMENTS,
    });
  });
});
