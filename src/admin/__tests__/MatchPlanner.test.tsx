import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadMatches = vi.fn();
const loadPits = vi.fn();
const getSchedule = vi.fn();
const getCachedMatches = vi.fn();
const getCachedPits = vi.fn();
const createDownload = vi.fn();

vi.mock('../AssignmentBoard', () => ({ AssignmentBoard: () => <div>match board</div> }));
vi.mock('../PitAssignmentBoard', () => ({ PitAssignmentBoard: () => <div>pit board</div> }));
vi.mock('../ScheduleView', () => ({ ScheduleView: () => <div>schedule</div> }));
vi.mock('../setAssignmentsClient', () => ({
  loadMatchAssignmentSnapshot: (...args: unknown[]) => loadMatches(...args),
}));
vi.mock('../pitAssignmentsClient', () => ({
  loadPitAssignmentSnapshot: (...args: unknown[]) => loadPits(...args),
}));
vi.mock('@/db/preloadClient', () => ({
  getCachedAssignmentsForEvent: (...args: unknown[]) => getCachedMatches(...args),
  getCachedMatches: (...args: unknown[]) => getSchedule(...args),
  getCachedPitAssignmentsForEvent: (...args: unknown[]) => getCachedPits(...args),
}));
vi.mock('../assignmentExport', () => ({
  assignmentWorkbookDownload: (...args: unknown[]) => createDownload(...args),
}));

import { MatchPlanner } from '../MatchPlanner';

describe('MatchPlanner assignment export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadMatches.mockResolvedValue({ state: {}, assignments: [] });
    loadPits.mockResolvedValue({ state: {}, assignments: [] });
    getSchedule.mockResolvedValue([]);
    getCachedMatches.mockResolvedValue([]);
    getCachedPits.mockResolvedValue([]);
    createDownload.mockResolvedValue({
      blobUrl: 'blob:assignments',
      filename: '2026test-scouting-assignments.xlsx',
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('downloads one workbook from the latest published match and pit snapshots', async () => {
    render(
      <MatchPlanner
        eventKey="2026test"
        matches={[]}
        scouts={[{ id: 'scout-a', displayName: 'Alex' }]}
        teams={[{ teamNumber: 111, nickname: 'Alpha' }]}
      />,
    );

    fireEvent.click(screen.getByTestId('export-assignment-workbook'));

    await waitFor(() => expect(createDownload).toHaveBeenCalledTimes(1));
    expect(loadMatches).toHaveBeenCalledWith('2026test');
    expect(loadPits).toHaveBeenCalledWith('2026test');
    expect(screen.getByTestId('assignment-export-message')).toHaveTextContent(
      'latest published assignments',
    );
  });

  it('exports the last saved schedules when the server is offline', async () => {
    loadMatches.mockRejectedValueOnce(new Error('offline'));
    loadPits.mockRejectedValueOnce(new Error('offline'));
    getCachedMatches.mockResolvedValueOnce([
      {
        match_key: '2026test_qm1',
        scout_id: 'scout-a',
        alliance_color: 'red',
        station: 1,
        target_team_number: 111,
      },
    ]);
    getCachedPits.mockResolvedValueOnce([
      { team_number: 111, scout_id: 'scout-a', source: 'manual' },
    ]);

    render(
      <MatchPlanner
        eventKey="2026test"
        matches={[]}
        scouts={[{ id: 'scout-a', displayName: 'Alex' }]}
        teams={[{ teamNumber: 111, nickname: 'Alpha' }]}
      />,
    );
    fireEvent.click(screen.getByTestId('export-assignment-workbook'));

    await waitFor(() =>
      expect(screen.getByTestId('assignment-export-message')).toHaveTextContent(
        'last schedule saved on this device',
      ),
    );
  });
});
