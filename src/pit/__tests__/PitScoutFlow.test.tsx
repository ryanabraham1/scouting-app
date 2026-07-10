import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const { listPitDraftsMock } = vi.hoisted(() => ({
  listPitDraftsMock: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock('@/db/preloadClient', () => ({
  getCachedTeams: async () => [
    {
      id: '2026casj:254',
      event_key: '2026casj',
      team_number: 254,
      nickname: 'Cheesy Poofs',
    },
  ],
  getCachedPitAssignmentsForEvent: async () => [
    {
      id: '2026casj:254:scout-a',
      event_key: '2026casj',
      team_number: 254,
      scout_id: 'scout-a',
      scout_name: 'Alex',
      source: 'auto',
    },
    {
      id: '2026casj:254:scout-b',
      event_key: '2026casj',
      team_number: 254,
      scout_id: 'scout-b',
      scout_name: 'Blair',
      source: 'auto',
    },
  ],
}));

vi.mock('../pitStore', () => ({
  PIT_NUMERIC_LIMITS: {
    batteryCount: 99,
    chargerCount: 99,
    dimensionIn: 120,
    teamNumber: 99_999,
  },
  listPitDraftsForEvent: listPitDraftsMock,
  listPitReportsForEvent: async () => [],
  listPitQuarantine: async () => [],
  deletePitQuarantine: async () => undefined,
}));

vi.mock('../PitScoutScreen', () => ({
  default: () => <div data-testid="mock-pit-screen" />,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const data =
        table === 'pit_assignment'
          ? [
              {
                team_number: 254,
                scout_id: 'scout-a',
                scout: { display_name: 'Alex' },
              },
              {
                team_number: 254,
                scout_id: 'scout-b',
                scout: { display_name: 'Blair' },
              },
            ]
          : table === 'pit_scouting_report'
            ? [{ team_number: 254 }]
            : [];
      const query = {
        eq: () => query,
        order: () => query,
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve({ data, error: null }).then(resolve, reject),
      };
      return { select: () => query };
    },
  },
}));

import PitScoutFlow from '../PitScoutFlow';

describe('PitScoutFlow shared crew completion', () => {
  it('surfaces an unassigned manual draft after reload', async () => {
    listPitDraftsMock.mockResolvedValueOnce([
      {
        draftKey: '2026casj:999',
        eventKey: '2026casj',
        teamNumber: 999,
        updatedAt: '2026-07-10T12:00:00.000Z',
        data: {},
      },
    ]);
    render(<PitScoutFlow eventKey="2026casj" scoutId="scout-a" />);
    expect(await screen.findByTestId('pit-draft-999')).toHaveTextContent('Continue');
  });

  it('supports combobox arrow, enter, escape, and active-descendant semantics', async () => {
    render(<PitScoutFlow eventKey="2026casj" scoutId="scout-a" />);
    const input = await screen.findByRole('combobox');
    fireEvent.focus(input);
    const option = await screen.findByRole('option', { name: /254.*Cheesy Poofs/i });
    expect(option.tagName).toBe('LI');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'pit-team-option-254');
    expect(option).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue(254);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['scout-a', 'scout-b'])(
    'shows a team report as complete for assigned crew member %s',
    async (scoutId) => {
      render(<PitScoutFlow eventKey="2026casj" scoutId={scoutId} />);

      const assignment = await screen.findByTestId('pit-assignment-254');
      await waitFor(() => expect(assignment).toHaveTextContent('Edit'));
      expect(assignment).toHaveTextContent('Cheesy Poofs');
      expect(assignment).toHaveTextContent(scoutId === 'scout-a' ? 'With Blair' : 'With Alex');
    },
  );
});
