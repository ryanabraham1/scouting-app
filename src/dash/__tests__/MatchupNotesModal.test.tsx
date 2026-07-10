import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const saveTeamStrategyNoteMock = vi.fn();
vi.mock('@/dash/matchupNotesClient', () => ({
  saveTeamStrategyNote: (...args: unknown[]) => saveTeamStrategyNoteMock(...args),
}));

import MatchupNotesModal from '@/dash/MatchupNotesModal';

function renderModal(props: Partial<React.ComponentProps<typeof MatchupNotesModal>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MatchupNotesModal
        open
        onClose={vi.fn()}
        eventKey="2026evt"
        targetTeam={254}
        allianceContext="Opponent · Red alliance"
        initialNote="deny the feed lane"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe('MatchupNotesModal', () => {
  beforeEach(() => {
    saveTeamStrategyNoteMock.mockReset();
    saveTeamStrategyNoteMock.mockImplementation(
      async (eventKey: string, targetTeam: number, note: string) => ({
        key: `${eventKey}:-1:${targetTeam}`,
        note,
      }),
    );
  });

  it('names the actual team and explains event-scoped resurfacing', () => {
    const { getByText, queryByText } = renderModal();
    expect(getByText('Strategy note for team 254')).toBeTruthy();
    expect(getByText(/Opponent · Red alliance/)).toBeTruthy();
    expect(getByText(/follows team 254 across every matchup at this event/)).toBeTruthy();
    expect(queryByText(/alliance lead/i)).toBeNull();
  });

  it('saves against the frozen target team even if live props change mid-edit', async () => {
    const onClose = vi.fn();
    const view = renderModal({ onClose });
    fireEvent.change(view.getByTestId('matchup-notes-textarea'), {
      target: { value: 'force them away from the tower' },
    });
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <MatchupNotesModal
          open
          onClose={onClose}
          eventKey="2026other"
          targetTeam={1678}
          allianceContext="Opponent · Blue alliance"
          initialNote="different live note"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(view.getByTestId('matchup-notes-save'));

    await waitFor(() => {
      expect(saveTeamStrategyNoteMock).toHaveBeenCalledWith(
        '2026evt',
        254,
        'force them away from the tower',
      );
    });
    expect(
      view.queryClient
        .getQueryData<Map<string, string>>(['matchup-notes', '2026evt'])
        ?.get('2026evt:-1:254'),
    ).toBe('force them away from the tower');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the editor open and surfaces local-save failures', async () => {
    saveTeamStrategyNoteMock.mockRejectedValueOnce(new Error('quota'));
    const onClose = vi.fn();
    const view = renderModal({ onClose });

    fireEvent.click(view.getByTestId('matchup-notes-save'));

    expect(await view.findByRole('alert')).toHaveTextContent(/could not save/i);
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getByTestId('matchup-notes-textarea')).toBeTruthy();
  });
});
