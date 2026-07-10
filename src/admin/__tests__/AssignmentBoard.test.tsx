import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const autoAssign = vi.fn();
const publishAssignments = vi.fn();
const loadMatchAssignmentSnapshot = vi.fn();
const ensureEventScoutsFromRoster = vi.fn();
const getCachedAssignmentsForEvent = vi.fn();
const replaceCachedAssignmentsForEvent = vi.fn();
const assignmentServers = new Map<string, { revision: number; assignments: Assignment[] }>();
const queryCache = new Map<string, unknown>();
const fakeQueryClient = {
  invalidateQueries: () => Promise.resolve(),
  getQueryData: (key: unknown[]) => queryCache.get(JSON.stringify(key)),
  setQueryData: (key: unknown[], value: unknown) => queryCache.set(JSON.stringify(key), value),
};
vi.mock('../autoAssign', () => ({ autoAssign: (...a: unknown[]) => autoAssign(...a) }));
vi.mock('../setAssignmentsClient', () => ({
  publishAssignments: (...a: unknown[]) => publishAssignments(...a),
  loadMatchAssignmentSnapshot: (...a: unknown[]) => loadMatchAssignmentSnapshot(...a),
}));
vi.mock('../ensureEventScoutsClient', () => ({
  ensureEventScoutsFromRoster: (...a: unknown[]) => ensureEventScoutsFromRoster(...a),
}));
vi.mock('@/db/preloadClient', () => ({
  getCachedAssignmentsForEvent: (...a: unknown[]) => getCachedAssignmentsForEvent(...a),
  replaceCachedAssignmentsForEvent: (...a: unknown[]) => replaceCachedAssignmentsForEvent(...a),
}));
// The board also calls useQueryClient() (for post-publish cache invalidation).
// Stub it to a no-op so no real QueryClientProvider is needed.
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => fakeQueryClient,
}));

import { AssignmentBoard } from '../AssignmentBoard';
import type { AssignMatch, AssignScout, Assignment } from '../types';

const MATCHES: AssignMatch[] = [
  { matchKey: '2026casnv_qm1', redTeams: [254, 1678, 100], blueTeams: [200, 300, 400] },
];
const SCOUTS: AssignScout[] = [
  { id: 's1', displayName: 'Alice' },
  { id: 's2', displayName: 'Bob' },
];

describe('AssignmentBoard', () => {
  beforeEach(() => {
    autoAssign.mockReset();
    publishAssignments.mockReset();
    loadMatchAssignmentSnapshot.mockReset();
    ensureEventScoutsFromRoster.mockReset();
    getCachedAssignmentsForEvent.mockReset();
    replaceCachedAssignmentsForEvent.mockReset();
    assignmentServers.clear();
    queryCache.clear();
    getCachedAssignmentsForEvent.mockResolvedValue([]);
    replaceCachedAssignmentsForEvent.mockResolvedValue(undefined);
    loadMatchAssignmentSnapshot.mockImplementation(async (eventKey: string) => {
      const server = assignmentServers.get(eventKey) ?? { revision: 0, assignments: [] };
      assignmentServers.set(eventKey, server);
      return {
        state: {
          status: 'authoritative',
          revision: server.revision,
          count: server.assignments.length,
        },
        assignments: [...server.assignments],
      };
    });
    publishAssignments.mockImplementation(
      async (eventKey: string, assignments: Assignment[], baseRevision: number) => {
        const server = assignmentServers.get(eventKey) ?? { revision: 0, assignments: [] };
        if (baseRevision !== server.revision) {
          return {
            status: 'conflict',
            revision: server.revision,
            count: server.assignments.length,
          };
        }
        const revision = server.revision + 1;
        assignmentServers.set(eventKey, { revision, assignments: [...assignments] });
        return { status: 'applied', revision, count: assignments.length };
      },
    );
  });

  it('auto-generates a grid then publishes', async () => {
    const generated: Assignment[] = [
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
      { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 1, targetTeamNumber: 200 },
    ];
    autoAssign.mockReturnValue(generated);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);

    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    const grid = await screen.findByTestId('assignment-grid');
    expect(grid).toHaveTextContent('254');
    expect(grid).toHaveTextContent('Alice');
    expect(autoAssign).toHaveBeenCalledWith(MATCHES, SCOUTS, expect.objectContaining({ ownTeam: 3256 }));

    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    await screen.findByTestId('assignments-published');
    expect(publishAssignments).toHaveBeenCalledWith('2026casnv', generated, 0);
  });

  it('shows an error when publish fails', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    publishAssignments.mockRejectedValueOnce(new Error('permission denied'));
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    const err = await screen.findByTestId('assignments-publish-error');
    expect(err).toHaveTextContent('permission denied');
  });

  it('keeps local editing available from Dexie when revision loading fails', async () => {
    loadMatchAssignmentSnapshot.mockRejectedValueOnce(new Error('offline'));
    getCachedAssignmentsForEvent.mockResolvedValueOnce([
      {
        id: 'cached-qm1-r1',
        event_key: '2026casnv',
        match_key: '2026casnv_qm1',
        scout_id: 's1',
        alliance_color: 'red',
        station: 1,
        target_team_number: 254,
      },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);

    expect(await screen.findByTestId('assignments-authority-status')).toHaveTextContent(
      /keep editing.*publish.*locked/i,
    );
    expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled();
    expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    await waitFor(() =>
      expect((screen.getAllByTestId('slot-select')[0] as HTMLSelectElement).value).toBe('s1'),
    );
    expect(screen.getByTestId('publish-assignments-btn')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /retry server check/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('assignments-authority-status')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('publish-assignments-btn')).not.toBeDisabled();
  });

  it('keeps an applied publish successful when its follow-up refresh fails', async () => {
    const generated: Assignment[] = [
      {
        matchKey: '2026casnv_qm1',
        scoutId: 's1',
        allianceColor: 'red',
        station: 1,
        targetTeamNumber: 254,
      },
    ];
    autoAssign.mockReturnValue(generated);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    loadMatchAssignmentSnapshot.mockRejectedValueOnce(new Error('refresh offline'));
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));

    expect(await screen.findByTestId('assignments-published')).toHaveTextContent(
      'Published 1 assignment.',
    );
    expect(screen.queryByTestId('assignments-publish-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('assignments-authority-status')).toHaveTextContent(
      /publish succeeded.*follow-up server refresh failed/i,
    );

    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    await waitFor(() => expect(publishAssignments).toHaveBeenCalledTimes(2));
    expect(publishAssignments.mock.calls[1][2]).toBe(1);
  });

  it('lets a slot be reassigned manually via a select', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    const selects = screen.getAllByTestId('slot-select');
    fireEvent.change(selects[0], { target: { value: 's2' } });
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));

    await waitFor(() => expect(publishAssignments).toHaveBeenCalled());
    const published = publishAssignments.mock.calls[0][1] as Assignment[];
    const slot = published.find((a) => a.matchKey === '2026casnv_qm1' && a.allianceColor === 'red' && a.station === 1);
    expect(slot?.scoutId).toBe('s2');
  });

  it('is enabled with no event scouts and seeds the pool from the roster on click', async () => {
    // 2026caetb-shaped: matches imported, but no scouter has checked in yet.
    const seeded: AssignScout[] = [
      { id: 'r1', displayName: 'Cara' },
      { id: 'r2', displayName: 'Dev' },
    ];
    ensureEventScoutsFromRoster.mockResolvedValue(seeded);
    autoAssign.mockReturnValue([
      { matchKey: '2026caetb_qm1', scoutId: 'r1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);

    const caetbMatches: AssignMatch[] = [
      { matchKey: '2026caetb_qm1', redTeams: [254, 1678, 100], blueTeams: [200, 300, 400] },
    ];
    render(<AssignmentBoard eventKey="2026caetb" matches={caetbMatches} scouts={[]} />);

    // Button is NOT disabled just because the event has no scout rows yet.
    const btn = screen.getByTestId('auto-generate-btn');
    await waitFor(() => expect(btn).not.toBeDisabled());

    fireEvent.click(btn);
    await screen.findByTestId('assignment-grid');
    expect(ensureEventScoutsFromRoster).toHaveBeenCalledWith('2026caetb');
    // autoAssign ran with the seeded roster pool, not the empty prop.
    expect(autoAssign).toHaveBeenCalledWith(caetbMatches, seeded, expect.objectContaining({ ownTeam: 3256 }));
    // Seeded names populate the slot selects.
    expect(screen.getByTestId('assignment-grid')).toHaveTextContent('Cara');
  });

  it('renders draft coverage with gaps when only some slots are auto-assigned', async () => {
    // autoAssign covers only 1 of the 6 eligible slots -> 5 gaps.
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    expect(screen.getByTestId('coverage-headline')).toHaveTextContent(/Coverage:/);
    expect(screen.getByTestId('coverage-headline')).toHaveTextContent(/gap/);
    expect(screen.getByTestId('coverage-gaps')).toBeInTheDocument();
    expect(screen.getAllByTestId('coverage-gap-seat').length).toBeGreaterThan(0);
  });

  it('renders the all-covered state when every slot is auto-assigned', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
      { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'red', station: 2, targetTeamNumber: 1678 },
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 3, targetTeamNumber: 100 },
      { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 1, targetTeamNumber: 200 },
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'blue', station: 2, targetTeamNumber: 300 },
      { matchKey: '2026casnv_qm1', scoutId: 's2', allianceColor: 'blue', station: 3, targetTeamNumber: 400 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    expect(screen.getByTestId('coverage-all-covered')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-gaps')).not.toBeInTheDocument();
  });

  it('excludes playoff matches from the slot universe and auto-assign input (quals only)', async () => {
    // The board is fed a mix of a qual and a playoff match; only the qual seats
    // may be assigned. autoAssign is mocked, so we assert (a) it received only
    // the qual match, and (b) the playoff-only team (777) never reaches the grid.
    const mixed: AssignMatch[] = [
      { matchKey: '2026casnv_qm1', redTeams: [254, 1678, 100], blueTeams: [200, 300, 400] },
      { matchKey: '2026casnv_sf1', redTeams: [777, 888, 999], blueTeams: [111, 222, 333] },
    ];
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={mixed} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    // autoAssign got ONLY the qual match.
    const passedMatches = autoAssign.mock.calls[0][0] as AssignMatch[];
    expect(passedMatches.map((m) => m.matchKey)).toEqual(['2026casnv_qm1']);

    // The playoff-only team is absent from the rendered slot grid.
    const grid = screen.getByTestId('assignment-grid');
    expect(grid).toHaveTextContent('254');
    expect(grid).not.toHaveTextContent('777');
  });

  it('shows the quals-only note and a no-quals message when only playoffs exist', async () => {
    const playoffsOnly: AssignMatch[] = [
      { matchKey: '2026casnv_sf1', redTeams: [777, 888, 999], blueTeams: [111, 222, 333] },
    ];
    render(<AssignmentBoard eventKey="2026casnv" matches={playoffsOnly} scouts={SCOUTS} />);
    expect(screen.getByTestId('assignments-quals-only-note')).toBeInTheDocument();
    expect(screen.getByTestId('assignments-no-quals')).toBeInTheDocument();
    // Auto-generate is disabled when there are zero qualification matches.
    expect(screen.getByTestId('auto-generate-btn')).toBeDisabled();
    await waitFor(() =>
      expect(screen.queryByText(/loading authoritative assignment revision/i)).not.toBeInTheDocument(),
    );
  });

  it('opens the board for manual assignment WITHOUT auto-filling', async () => {
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    // Grid is shown, but autoAssign was never called (nothing pre-filled).
    const grid = await screen.findByTestId('assignment-grid');
    expect(autoAssign).not.toHaveBeenCalled();
    // Every seat starts unassigned.
    const selects = screen.getAllByTestId('slot-select') as HTMLSelectElement[];
    expect(selects.length).toBe(6);
    expect(selects.every((s) => s.value === '')).toBe(true);
    expect(grid).toBeInTheDocument();
  });

  it('renders one row per match with a selector per seat (not one row per seat)', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');
    // A single qual match -> exactly ONE match row holding all six seat selects.
    expect(screen.getAllByTestId('match-assign-row')).toHaveLength(1);
    expect(screen.getAllByTestId('slot-select')).toHaveLength(6);
  });

  it('passes the tuned auto-generate options through to autoAssign', async () => {
    autoAssign.mockReturnValue([]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    // Open the options panel and change every knob.
    fireEvent.click(screen.getByTestId('auto-generate-options-toggle'));
    fireEvent.change(screen.getByTestId('opt-rest-every'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('opt-rest-length'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('opt-rotate')); // default on -> off
    fireEvent.click(screen.getByTestId('opt-avoid-b2b')); // default on -> off
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await waitFor(() => expect(autoAssign).toHaveBeenCalled());
    expect(autoAssign).toHaveBeenCalledWith(
      MATCHES,
      SCOUTS,
      expect.objectContaining({
        breakEveryN: 3,
        breakLength: 2,
        rotatePositions: false,
        avoidBackToBack: false,
      }),
    );
  });

  it('shows a helpful message when the roster is empty', async () => {
    ensureEventScoutsFromRoster.mockResolvedValue([]);
    const caetbMatches: AssignMatch[] = [
      { matchKey: '2026caetb_qm1', redTeams: [254, 1678, 100], blueTeams: [200, 300, 400] },
    ];
    render(<AssignmentBoard eventKey="2026caetb" matches={caetbMatches} scouts={[]} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    const err = await screen.findByTestId('assignments-publish-error');
    expect(err).toHaveTextContent(/roster/i);
    expect(autoAssign).not.toHaveBeenCalled();
  });

  it('isolates published rows and drafts across A→B→A switches', async () => {
    const eventAMatches: AssignMatch[] = [
      { matchKey: '2026a_qm1', redTeams: [101, 102, 103], blueTeams: [104, 105, 106] },
    ];
    const eventBMatches: AssignMatch[] = [
      { matchKey: '2026b_qm1', redTeams: [201, 202, 203], blueTeams: [204, 205, 206] },
    ];
    const eventAScouts = [{ id: 'a-scout', displayName: 'Alice A' }];
    const eventBScouts = [{ id: 'b-scout', displayName: 'Blair B' }];
    assignmentServers.set('2026a', {
      revision: 2,
      assignments: [{
        matchKey: '2026a_qm1',
        scoutId: 'a-scout',
        allianceColor: 'red',
        station: 1,
        targetTeamNumber: 101,
      }],
    });
    assignmentServers.set('2026b', {
      revision: 4,
      assignments: [{
        matchKey: '2026b_qm1',
        scoutId: 'b-scout',
        allianceColor: 'red',
        station: 1,
        targetTeamNumber: 201,
      }],
    });

    const view = (eventKey: string, matches: AssignMatch[], eventScouts: AssignScout[]) => (
      <AssignmentBoard eventKey={eventKey} matches={matches} scouts={eventScouts} />
    );
    const rendered = render(view('2026a', eventAMatches, eventAScouts));
    await waitFor(() => expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    await waitFor(() =>
      expect((screen.getAllByTestId('slot-select')[0] as HTMLSelectElement).value).toBe('a-scout'),
    );

    rendered.rerender(view('2026b', eventBMatches, eventBScouts));
    await waitFor(() => expect(screen.queryByTestId('assignment-grid')).not.toBeInTheDocument());
    expect(screen.getByTestId('publish-assignments-btn')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    await waitFor(() =>
      expect((screen.getAllByTestId('slot-select')[0] as HTMLSelectElement).value).toBe('b-scout'),
    );
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));
    await waitFor(() =>
      expect(publishAssignments).toHaveBeenCalledWith(
        '2026b',
        expect.arrayContaining([expect.objectContaining({ matchKey: '2026b_qm1' })]),
        4,
      ),
    );

    rendered.rerender(view('2026a', eventAMatches, eventAScouts));
    await waitFor(() => expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    await waitFor(() =>
      expect((screen.getAllByTestId('slot-select')[0] as HTMLSelectElement).value).toBe('a-scout'),
    );
    expect(screen.getByText('101')).toBeInTheDocument();
    expect(screen.queryByText('201')).not.toBeInTheDocument();
  });

  it('does not publish an empty manual replacement', async () => {
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('assign-manually-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('assign-manually-btn'));
    await screen.findByTestId('assignment-grid');
    const publishButton = screen.getByTestId('publish-assignments-btn');
    expect(publishButton).toBeDisabled();
    fireEvent.click(publishButton);
    expect(publishAssignments).not.toHaveBeenCalled();
  });

  it('keeps the local draft and refreshes live rows after a CAS conflict', async () => {
    autoAssign.mockReturnValue([
      { matchKey: '2026casnv_qm1', scoutId: 's1', allianceColor: 'red', station: 1, targetTeamNumber: 254 },
    ]);
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    await waitFor(() => expect(screen.getByTestId('auto-generate-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('auto-generate-btn'));
    await screen.findByTestId('assignment-grid');

    assignmentServers.set('2026casnv', {
      revision: 1,
      assignments: [{
        matchKey: '2026casnv_qm1',
        scoutId: 's2',
        allianceColor: 'red',
        station: 1,
        targetTeamNumber: 254,
      }],
    });
    fireEvent.click(screen.getByTestId('publish-assignments-btn'));

    expect(await screen.findByTestId('assignments-publish-error')).toHaveTextContent(
      /another lead.*draft was kept/i,
    );
    expect((screen.getAllByTestId('slot-select')[0] as HTMLSelectElement).value).toBe('s1');
    expect(publishAssignments).toHaveBeenCalledWith(
      '2026casnv',
      expect.any(Array),
      0,
    );
  });

  it('requires confirmation and CAS to clear every published assignment', async () => {
    assignmentServers.set('2026casnv', {
      revision: 6,
      assignments: [{
        matchKey: '2026casnv_qm1',
        scoutId: 's1',
        allianceColor: 'red',
        station: 1,
        targetTeamNumber: 254,
      }],
    });
    render(<AssignmentBoard eventKey="2026casnv" matches={MATCHES} scouts={SCOUTS} />);
    const clear = await screen.findByTestId('clear-all-assignments-btn');

    fireEvent.click(clear);
    expect(clear).toHaveTextContent('Confirm clear all');
    expect(publishAssignments).not.toHaveBeenCalled();
    fireEvent.click(clear);

    await waitFor(() =>
      expect(publishAssignments).toHaveBeenCalledWith('2026casnv', [], 6),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('clear-all-assignments-btn')).not.toBeInTheDocument(),
    );
  });
});
