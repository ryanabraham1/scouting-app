import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamAgg } from '@/dash/aggregate';

// Mock the notes hook + the save client (so we assert the save call, no network).
const useMatchupNotesMock = vi.fn();
vi.mock('@/dash/useEventData', () => ({
  useMatchupNotes: (eventKey: string | null) => useMatchupNotesMock(eventKey),
}));
const saveTeamStrategyNoteMock = vi.fn(
  async (eventKey: string, targetTeam: number, note: string) => ({
    key: `${eventKey}:-1:${targetTeam}`,
    note,
  }),
);
vi.mock('@/dash/matchupNotesClient', async () => {
  const actual = await vi.importActual<typeof import('@/dash/matchupNotesClient')>(
    '@/dash/matchupNotesClient',
  );
  return {
    ...actual,
    saveTeamStrategyNote: (eventKey: string, targetTeam: number, note: string) =>
      saveTeamStrategyNoteMock(eventKey, targetTeam, note),
  };
});

import MatchupPanel from '@/dash/MatchupPanel';

function ta(over: Partial<TeamAgg> = {}): TeamAgg {
  return {
    teamNumber: 100,
    matchesScouted: 5,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 40,
    meanFuelConfidence: 1,
    climbSuccessRate: 0.5,
    avgClimbLevel: 1,
    meanClimbPoints: 10,
    avgDefenseRating: 0,
    noShowRate: 0,
    diedRate: 0,
    tippedRate: 0,
    incidentMatches: 0,
    reliability: 1,
    scoutingExpectedPoints: 50,
    fuelSuppressionWhileDefended: null,
    defendedSampleMs: 0,
    defenderEffectiveness: null,
    defenseSampleCount: 0,
    stdDevFuelPoints: 0,
    minFuelPoints: 0,
    maxFuelPoints: 0,
    stdDevClimbPoints: 0,
    minClimbPoints: 0,
    maxClimbPoints: 0,
    stdDevDefenseRating: 0,
    minDefenseRating: 0,
    maxDefenseRating: 0,
    recentFuelMean: 40,
    recentFuelDelta: 0,
    recentTrend: 'stable',
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof MatchupPanel>> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MatchupPanel
        eventKey="2026casnv"
        redTeams={[254, 100, 200]}
        blueTeams={[3256, 300, 400]}
        ourSide="blue"
        redAggs={[ta({ teamNumber: 254, climbSuccessRate: 0.8, avgClimbLevel: 2.7 })]}
        blueAggs={[ta({ teamNumber: 3256 })]}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  useMatchupNotesMock.mockReset();
  saveTeamStrategyNoteMock.mockClear();
  // Default: no notes.
  useMatchupNotesMock.mockReturnValue({ data: new Map<string, string>() });
});

describe('MatchupPanel', () => {
  it('renders the panel with synthesis bullets and a note badge when a note exists', () => {
    useMatchupNotesMock.mockReturnValue({
      data: new Map<string, string>([['2026casnv:-1:100', 'scout it']]),
    });
    const { getByTestId } = renderPanel();
    const panel = getByTestId('dash-matchup-panel');
    expect(panel).toBeTruthy();
    expect(within(panel).getByText('Alliance Matchup')).toBeTruthy();
    // The reliable high climber threat renders.
    expect(within(panel).getByText(/Contest 254's L3 climb/)).toBeTruthy();
    // The badge appears for the matchup with a note.
    expect(within(panel).getAllByTestId('matchup-note-badge').length).toBeGreaterThan(0);
    expect(within(panel).getByTestId('matchup-note-text').textContent).toContain('scout it');
  });

  it('renders "No scouting data yet" when an alliance has no scouted teams', () => {
    const { getAllByText } = renderPanel({
      redAggs: [undefined, undefined],
      blueAggs: [undefined],
    });
    expect(getAllByText('No scouting data yet').length).toBeGreaterThan(0);
  });

  it('opens the modal, names the actual team, and saves a team-scoped note', async () => {
    const { getAllByTestId, getByTestId } = renderPanel();
    fireEvent.click(getAllByTestId('matchup-notes-btn')[0]); // red block
    const textarea = getByTestId('matchup-notes-textarea');
    expect(textarea).toBeTruthy();
    expect(getByTestId('matchup-notes-sheet').textContent).toContain('Strategy note for team 100');
    fireEvent.change(textarea, { target: { value: 'deny their feed lane' } });
    fireEvent.click(getByTestId('matchup-notes-save'));
    await vi.waitFor(() => expect(saveTeamStrategyNoteMock).toHaveBeenCalled());
    expect(saveTeamStrategyNoteMock).toHaveBeenCalledWith(
      '2026casnv',
      100,
      'deny their feed lane',
    );
  });

  it('ourSide=null uses neutral per-color labels (no Our edges/Our risks)', () => {
    const { getByTestId, queryByText } = renderPanel({ ourSide: null });
    const panel = getByTestId('dash-matchup-panel');
    expect(within(panel).getByText('Red threats')).toBeTruthy();
    expect(within(panel).getByText('Blue threats')).toBeTruthy();
    expect(queryByText('Our edges')).toBeNull();
    expect(queryByText('Our risks')).toBeNull();
  });
});
