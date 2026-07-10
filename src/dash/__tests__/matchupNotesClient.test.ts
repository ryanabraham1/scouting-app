import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalMatchupNote } from '@/db/types';

const getMatchupNoteMock = vi.fn();
const saveMatchupNoteLocalMock = vi.fn();

vi.mock('@/db/localStore', () => ({
  getMatchupNote: (...args: unknown[]) => getMatchupNoteMock(...args),
  saveMatchupNoteLocal: (...args: unknown[]) => saveMatchupNoteLocalMock(...args),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}));

import {
  TEAM_STRATEGY_NOTE_NAMESPACE,
  keyFor,
  normalizeMatchup,
  saveTeamStrategyNote,
  teamNoteKeyFor,
} from '@/dash/matchupNotesClient';

describe('event-scoped team strategy note keys', () => {
  beforeEach(() => {
    getMatchupNoteMock.mockReset();
    saveMatchupNoteLocalMock.mockReset();
    getMatchupNoteMock.mockResolvedValue(undefined);
    saveMatchupNoteLocalMock.mockResolvedValue(undefined);
  });

  it('uses a reserved namespace that cannot collide with legacy lead-pair keys', () => {
    const legacy = normalizeMatchup([3256, 111, 222], [333, 444, 555]);
    expect(legacy).toEqual({ ourTeam: 111, oppTeam: 333 });
    expect(teamNoteKeyFor('2026evt', 333)).toBe('2026evt:-1:333');
    expect(teamNoteKeyFor('2026evt', 333)).not.toBe(
      keyFor('2026evt', legacy.ourTeam, legacy.oppTeam),
    );
  });

  it('writes distinct offline-first rows for alliance partners and opponents', async () => {
    const partner = await saveTeamStrategyNote('2026evt', 111, 'run the left auto');
    const opponent = await saveTeamStrategyNote('2026evt', 333, 'deny the feed lane');

    expect(partner.key).toBe('2026evt:-1:111');
    expect(opponent.key).toBe('2026evt:-1:333');
    expect(saveMatchupNoteLocalMock).toHaveBeenCalledTimes(2);
    expect(saveMatchupNoteLocalMock.mock.calls.map(([row]) => ({
      key: (row as LocalMatchupNote).key,
      ourTeam: (row as LocalMatchupNote).ourTeam,
      oppTeam: (row as LocalMatchupNote).oppTeam,
      syncState: (row as LocalMatchupNote).syncState,
    }))).toEqual([
      { key: '2026evt:-1:111', ourTeam: TEAM_STRATEGY_NOTE_NAMESPACE, oppTeam: 111, syncState: 'dirty' },
      { key: '2026evt:-1:333', ourTeam: TEAM_STRATEGY_NOTE_NAMESPACE, oppTeam: 333, syncState: 'dirty' },
    ]);
  });

  it('advances the local revision when two edits land in the same millisecond', async () => {
    getMatchupNoteMock.mockResolvedValue({
      updatedAt: '2026-07-10T00:00:00.000Z',
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    try {
      const saved = await saveTeamStrategyNote('2026evt', 254, 'newer text');
      expect(saved.updatedAt).toBe('2026-07-10T00:00:00.001Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid/sentinel target teams', async () => {
    await expect(saveTeamStrategyNote('2026evt', 0, 'bad')).rejects.toThrow(
      'Invalid strategy-note target team',
    );
    await expect(saveTeamStrategyNote('2026evt', -1, 'bad')).rejects.toThrow(
      'Invalid strategy-note target team',
    );
    expect(saveMatchupNoteLocalMock).not.toHaveBeenCalled();
  });
});
