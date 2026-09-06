import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryPersist';
import {
  fetchEventMatchesCached,
  fetchTeamEventKeysCached,
  fetchTeamSeasonMatchesCached,
} from '../seasonEpa';

const tbaGet = vi.hoisted(() => vi.fn());
vi.mock('@/dash/proxies', () => ({ tbaGet }));

afterEach(() => {
  queryClient.clear();
  tbaGet.mockReset();
});

describe('season data survives an upstream outage sentinel', () => {
  const cases = [
    {
      name: 'event matches',
      key: ['tba', 'event-matches', '2026test'],
      retained: [{ key: '2026test_qm1' }],
      fetch: () => fetchEventMatchesCached('2026test'),
    },
    {
      name: 'team events',
      key: ['tba', 'team-events', 3256, '2026'],
      retained: ['2026test'],
      fetch: () => fetchTeamEventKeysCached(3256, '2026'),
    },
    {
      name: 'season record matches',
      key: ['tba', 'team-season-matches', 3256, '2026'],
      retained: [{ key: '2026test_qm1' }],
      fetch: () => fetchTeamSeasonMatchesCached(3256, '2026'),
    },
  ];

  for (const entry of cases) {
    it(`retains ${entry.name} when a refresh returns available:false`, async () => {
      queryClient.setQueryData(entry.key, entry.retained, { updatedAt: 1 });
      tbaGet.mockResolvedValue({ available: false });
      expect(await entry.fetch()).toEqual(entry.retained);
      expect(queryClient.getQueryData(entry.key)).toEqual(entry.retained);
      expect(tbaGet).toHaveBeenCalledOnce();
    });

    it(`accepts a genuinely empty ${entry.name} response`, async () => {
      queryClient.setQueryData(entry.key, entry.retained, { updatedAt: 1 });
      tbaGet.mockResolvedValue([]);
      expect(await entry.fetch()).toEqual([]);
      expect(queryClient.getQueryData(entry.key)).toEqual([]);
    });
  }

  it('does not invent a zero-match season record when no cached data exists', async () => {
    tbaGet.mockResolvedValue({ available: false });
    await expect(fetchTeamSeasonMatchesCached(3256, '2026')).rejects.toThrow('unavailable');
  });
});
