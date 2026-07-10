import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom';

const publish = vi.fn();
const loadPitAssignmentSnapshot = vi.fn();
const getCachedPitAssignmentsForEvent = vi.fn();
const replaceCachedPitAssignmentsForEvent = vi.fn();
const pitServers = new Map<string, { revision: number; assignments: PitAssignment[] }>();
const scouts = [
  { id: 'a', displayName: 'Alex' },
  { id: 'b', displayName: 'Zoe' },
];

vi.mock('../ensureEventScoutsClient', () => ({
  ensureEventScoutsFromRoster: async () => scouts,
}));
vi.mock('@/db/preloadClient', () => ({
  getCachedPitAssignmentsForEvent: (...args: unknown[]) =>
    getCachedPitAssignmentsForEvent(...args),
  replaceCachedPitAssignmentsForEvent: (...args: unknown[]) =>
    replaceCachedPitAssignmentsForEvent(...args),
}));
vi.mock('../pitAssignmentsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pitAssignmentsClient')>();
  return {
    ...actual,
    publishPitAssignments: (...args: unknown[]) => publish(...args),
    loadPitAssignmentSnapshot: (...args: unknown[]) => loadPitAssignmentSnapshot(...args),
  };
});

import { PitAssignmentBoard } from '../PitAssignmentBoard';
import type { PitAssignment } from '../types';

describe('PitAssignmentBoard', () => {
  beforeEach(() => {
    publish.mockReset();
    loadPitAssignmentSnapshot.mockReset();
    getCachedPitAssignmentsForEvent.mockReset();
    replaceCachedPitAssignmentsForEvent.mockReset();
    pitServers.clear();
    getCachedPitAssignmentsForEvent.mockResolvedValue([]);
    replaceCachedPitAssignmentsForEvent.mockResolvedValue(undefined);
    loadPitAssignmentSnapshot.mockImplementation(async (eventKey: string) => {
      const server = pitServers.get(eventKey) ?? { revision: 0, assignments: [] };
      pitServers.set(eventKey, server);
      return {
        state: {
          status: 'authoritative',
          revision: server.revision,
          count: server.assignments.length,
        },
        assignments: [...server.assignments],
      };
    });
    publish.mockImplementation(
      async (eventKey: string, assignments: PitAssignment[], baseRevision: number) => {
        const server = pitServers.get(eventKey) ?? { revision: 0, assignments: [] };
        if (baseRevision !== server.revision) {
          return {
            status: 'conflict',
            revision: server.revision,
            count: server.assignments.length,
          };
        }
        const revision = server.revision + 1;
        pitServers.set(eventKey, { revision, assignments: [...assignments] });
        return { status: 'applied', revision, count: assignments.length };
      },
    );
  });

  it('auto-balances shared crews and publishes every membership', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[
            { teamNumber: 3, nickname: null },
            { teamNumber: 1, nickname: null },
            { teamNumber: 2, nickname: null },
          ]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('pit-auto-generate')).not.toBeDisabled());
    fireEvent.change(screen.getByTestId('pit-crew-size'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('pit-auto-generate'));
    expect(await screen.findAllByText('2 scouts')).toHaveLength(3);
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toEqual([
      { teamNumber: 1, scoutId: 'a', source: 'auto' },
      { teamNumber: 1, scoutId: 'b', source: 'auto' },
      { teamNumber: 2, scoutId: 'a', source: 'auto' },
      { teamNumber: 2, scoutId: 'b', source: 'auto' },
      { teamNumber: 3, scoutId: 'a', source: 'auto' },
      { teamNumber: 3, scoutId: 'b', source: 'auto' },
    ]);
  });

  it('keeps pit crew editing available from Dexie when revision loading fails', async () => {
    loadPitAssignmentSnapshot.mockRejectedValueOnce(new Error('offline'));
    getCachedPitAssignmentsForEvent.mockResolvedValueOnce([
      {
        id: '2026casj:254:a',
        event_key: '2026casj',
        team_number: 254,
        scout_id: 'a',
        source: 'manual',
      },
    ]);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('pit-assignments-authority-status')).toHaveTextContent(
      /keep editing.*publish.*locked/i,
    );
    expect(screen.getByTestId('pit-auto-generate')).not.toBeDisabled();
    expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    expect(await screen.findByTestId('pit-member-254-a')).toBeInTheDocument();
    expect(screen.getByTestId('publish-pit-assignments')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /retry server check/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('pit-assignments-authority-status')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('publish-pit-assignments')).not.toBeDisabled();
  });

  it('keeps an applied pit publish successful when its follow-up refresh fails', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('pit-auto-generate')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-auto-generate'));
    await screen.findByTestId('pit-member-254-a');

    loadPitAssignmentSnapshot.mockRejectedValueOnce(new Error('refresh offline'));
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));

    expect(await screen.findByText('Published 1 pit crew assignment.')).toBeInTheDocument();
    expect(screen.queryByText(/publish failed/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('pit-assignments-authority-status')).toHaveTextContent(
      /publish succeeded.*follow-up server refresh failed/i,
    );

    fireEvent.click(screen.getByTestId('publish-pit-assignments'));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish.mock.calls[1][2]).toBe(1);
  });

  it('adds and removes manual crew members without duplicate rows', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: 'Cheesy Poofs' }]}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    const addMember = await screen.findByTestId('pit-add-member-254');
    fireEvent.change(addMember, { target: { value: 'a' } });
    fireEvent.change(addMember, { target: { value: 'b' } });
    expect(screen.getByTestId('pit-member-254-a')).toBeInTheDocument();
    expect(screen.getByTestId('pit-member-254-b')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alex from team 254' }));
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toEqual([
      { teamNumber: 254, scoutId: 'b', source: 'manual' },
    ]);
  });

  it('drops generated crews when the event changes before publish', async () => {
    const client = new QueryClient();
    const view = (eventKey: string) => (
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey={eventKey}
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>
    );
    const rendered = render(view('2026old'));
    await waitFor(() => expect(screen.getByTestId('pit-auto-generate')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-auto-generate'));
    expect(await screen.findByTestId('pit-member-254-a')).toBeInTheDocument();

    rendered.rerender(view('2026new'));
    await waitFor(() =>
      expect(screen.queryByTestId('pit-assignment-grid')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('publish-pit-assignments')).toBeDisabled();
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));
    expect(publish).not.toHaveBeenCalled();
  });

  it('loads only the selected event crew across A→B→A', async () => {
    pitServers.set('2026a', {
      revision: 2,
      assignments: [{
        teamNumber: 101,
        scoutId: 'a',
        source: 'manual',
      }],
    });
    pitServers.set('2026b', {
      revision: 5,
      assignments: [{
        teamNumber: 202,
        scoutId: 'b',
        source: 'manual',
      }],
    });
    const client = new QueryClient();
    const view = (eventKey: string, teamNumber: number) => (
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey={eventKey}
          scouts={scouts}
          teams={[{ teamNumber, nickname: null }]}
        />
      </QueryClientProvider>
    );
    const rendered = render(view('2026a', 101));
    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    expect(await screen.findByTestId('pit-member-101-a')).toBeInTheDocument();

    rendered.rerender(view('2026b', 202));
    await waitFor(() =>
      expect(screen.queryByTestId('pit-assignment-grid')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('publish-pit-assignments')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    expect(await screen.findByTestId('pit-member-202-b')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith('2026b', [
        { teamNumber: 202, scoutId: 'b', source: 'manual' },
      ], 5),
    );

    rendered.rerender(view('2026a', 101));
    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    expect(await screen.findByTestId('pit-member-101-a')).toBeInTheDocument();
    expect(screen.queryByTestId('pit-team-crew-202')).not.toBeInTheDocument();
  });

  it('does not publish an empty pit replacement', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    await screen.findByTestId('pit-assignment-grid');
    const publishButton = screen.getByTestId('publish-pit-assignments');
    expect(publishButton).toBeDisabled();
    fireEvent.click(publishButton);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps a local pit draft and refreshes live crews after a CAS conflict', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('pit-assign-manually')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pit-assign-manually'));
    const addMember = await screen.findByTestId('pit-add-member-254');
    fireEvent.change(addMember, { target: { value: 'a' } });

    pitServers.set('2026casj', {
      revision: 1,
      assignments: [{ teamNumber: 254, scoutId: 'b', source: 'manual' }],
    });
    fireEvent.click(screen.getByTestId('publish-pit-assignments'));

    expect(await screen.findByText(/another lead.*draft was kept/i)).toBeInTheDocument();
    expect(screen.getByTestId('pit-member-254-a')).toBeInTheDocument();
    expect(publish).toHaveBeenCalledWith(
      '2026casj',
      [{ teamNumber: 254, scoutId: 'a', source: 'manual' }],
      0,
    );
  });

  it('requires confirmation and CAS before clearing all pit assignments', async () => {
    pitServers.set('2026casj', {
      revision: 3,
      assignments: [{ teamNumber: 254, scoutId: 'a', source: 'manual' }],
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PitAssignmentBoard
          eventKey="2026casj"
          scouts={scouts}
          teams={[{ teamNumber: 254, nickname: null }]}
        />
      </QueryClientProvider>,
    );
    const clear = await screen.findByTestId('clear-all-pit-assignments');
    fireEvent.click(clear);
    expect(clear).toHaveTextContent('Confirm clear all');
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(clear);

    await waitFor(() => expect(publish).toHaveBeenCalledWith('2026casj', [], 3));
    expect(await screen.findByText('Cleared all pit crew assignments.')).toBeInTheDocument();
  });
});
