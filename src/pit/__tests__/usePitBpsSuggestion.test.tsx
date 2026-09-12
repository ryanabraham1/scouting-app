import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePitBpsSuggestion } from '@/pit/usePitBpsSuggestion';

const getPitReport = vi.fn();
const useTeamPit = vi.fn();

vi.mock('@/pit/pitStore', () => ({
  getPitReport: (...args: unknown[]) => getPitReport(...args),
}));

vi.mock('@/dash/useTeamPit', () => ({
  useTeamPit: (...args: unknown[]) => useTeamPit(...args),
}));

describe('usePitBpsSuggestion', () => {
  beforeEach(() => {
    getPitReport.mockReset().mockResolvedValue(undefined);
    useTeamPit.mockReset().mockReturnValue({ data: null });
  });

  it('prefers a submitted local pit estimate so it works offline', async () => {
    getPitReport.mockResolvedValue({
      data: { questionnaire: { estimatedBallsPerSecond: 7.5 } },
    });
    useTeamPit.mockReturnValue({
      data: { questionnaire: { estimatedBallsPerSecond: 9 } },
    });
    const { result } = renderHook(() => usePitBpsSuggestion('2026demo', 254));
    await waitFor(() => expect(result.current).toBe(7.5));
  });

  it('falls back to the cached or remote pit estimate when no local report exists', async () => {
    useTeamPit.mockReturnValue({
      data: { questionnaire: { estimatedBallsPerSecond: 9 } },
    });
    const { result } = renderHook(() => usePitBpsSuggestion('2026demo', 254));
    await waitFor(() => expect(getPitReport).toHaveBeenCalledWith('2026demo', 254));
    expect(result.current).toBe(9);
  });
});
