import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const eq = vi.fn();
const select = vi.fn(() => ({ eq }));
const from = vi.fn((..._args: unknown[]) => ({ select }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

import {
  autoAssignPits,
  loadPitAssignmentSnapshot,
  publishPitAssignments,
} from '../pitAssignmentsClient';

describe('pit assignments', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockClear();
    select.mockClear();
    eq.mockReset();
  });

  it('assigns sorted teams deterministically in consecutive crew blocks', () => {
    const result = autoAssignPits(
      [
        { teamNumber: 3, nickname: null },
        { teamNumber: 1, nickname: null },
        { teamNumber: 2, nickname: null },
      ],
      [
        { id: 'b', displayName: 'Zoe' },
        { id: 'a', displayName: 'Alex' },
      ],
    );
    expect(result).toEqual([
      { teamNumber: 1, scoutId: 'a', source: 'auto' },
      { teamNumber: 2, scoutId: 'a', source: 'auto' },
      { teamNumber: 3, scoutId: 'b', source: 'auto' },
    ]);
  });

  it('keeps stable crews together and folds extra scouts into the final crew', () => {
    const result = autoAssignPits(
      [
        { teamNumber: 5, nickname: null },
        { teamNumber: 1, nickname: null },
        { teamNumber: 8, nickname: null },
        { teamNumber: 2, nickname: null },
        { teamNumber: 7, nickname: null },
        { teamNumber: 4, nickname: null },
        { teamNumber: 3, nickname: null },
        { teamNumber: 6, nickname: null },
      ],
      [
        { id: 'a', displayName: 'Alex' },
        { id: 'b', displayName: 'Blair' },
        { id: 'c', displayName: 'Cam' },
        { id: 'd', displayName: 'Drew' },
        { id: 'e', displayName: 'Evan' },
      ],
      2,
    );
    expect(result).toEqual([
      { teamNumber: 1, scoutId: 'a', source: 'auto' },
      { teamNumber: 1, scoutId: 'b', source: 'auto' },
      { teamNumber: 2, scoutId: 'a', source: 'auto' },
      { teamNumber: 2, scoutId: 'b', source: 'auto' },
      { teamNumber: 3, scoutId: 'a', source: 'auto' },
      { teamNumber: 3, scoutId: 'b', source: 'auto' },
      { teamNumber: 4, scoutId: 'a', source: 'auto' },
      { teamNumber: 4, scoutId: 'b', source: 'auto' },
      { teamNumber: 5, scoutId: 'c', source: 'auto' },
      { teamNumber: 5, scoutId: 'd', source: 'auto' },
      { teamNumber: 5, scoutId: 'e', source: 'auto' },
      { teamNumber: 6, scoutId: 'c', source: 'auto' },
      { teamNumber: 6, scoutId: 'd', source: 'auto' },
      { teamNumber: 6, scoutId: 'e', source: 'auto' },
      { teamNumber: 7, scoutId: 'c', source: 'auto' },
      { teamNumber: 7, scoutId: 'd', source: 'auto' },
      { teamNumber: 7, scoutId: 'e', source: 'auto' },
      { teamNumber: 8, scoutId: 'c', source: 'auto' },
      { teamNumber: 8, scoutId: 'd', source: 'auto' },
      { teamNumber: 8, scoutId: 'e', source: 'auto' },
    ]);

    const capped = autoAssignPits(
      [{ teamNumber: 1, nickname: null }],
      [{ id: 'a', displayName: 'Alex' }, { id: 'b', displayName: 'Blair' }],
      4,
    );
    expect(capped.map((assignment) => assignment.scoutId)).toEqual(['a', 'b']);
  });

  it('publishes the complete replacement payload', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'applied', revision: 3, count: 1 },
        error: null,
      });
    await expect(
      publishPitAssignments('2026casj', [
        { teamNumber: 254, scoutId: 'scout-1', source: 'manual' },
      ], 2),
    ).resolves.toEqual({ status: 'applied', revision: 3, count: 1 });
    expect(rpc).toHaveBeenNthCalledWith(1, 'set_pit_assignments', {
      p_event_key: '2026casj',
      p_assignments: [
        { team_number: 254, scout_id: 'scout-1', source: 'manual' },
      ],
      p_base_revision: 2,
    });
  });

  it('accepts repeated idempotent publishes and rejects stale reverse publishes', async () => {
    const rows = [{ teamNumber: 254, scoutId: 'scout-1', source: 'manual' as const }];
    rpc
      .mockResolvedValueOnce({
        data: { status: 'idempotent', revision: 7, count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'conflict', revision: 8, count: 1 },
        error: null,
      });

    await expect(publishPitAssignments('2026casj', rows, 7)).resolves.toMatchObject({
      status: 'idempotent',
      revision: 7,
    });
    await expect(
      publishPitAssignments(
        '2026casj',
        [{ teamNumber: 1678, scoutId: 'scout-1', source: 'manual' }],
        7,
      ),
    ).resolves.toEqual({ status: 'conflict', revision: 8, count: 1 });
  });

  it('loads a stable authoritative pit snapshot', async () => {
    rpc
      .mockResolvedValueOnce({
        data: { status: 'authoritative', revision: 4, count: 1 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { status: 'authoritative', revision: 4, count: 1 },
        error: null,
      });
    eq.mockResolvedValueOnce({
      data: [{ team_number: 254, scout_id: 'scout-1', source: 'manual' }],
      error: null,
    });

    await expect(loadPitAssignmentSnapshot('2026casj')).resolves.toEqual({
      state: { status: 'authoritative', revision: 4, count: 1 },
      assignments: [{ teamNumber: 254, scoutId: 'scout-1', source: 'manual' }],
    });
  });
});
