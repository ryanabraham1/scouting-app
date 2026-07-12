import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let assignmentRows = [
  // Upcoming (qm5 has no result yet) — should appear in the scout's to-do list.
  {
    match_key: '2026demo_qm5',
    scout_id: 'scout-1',
    alliance_color: 'red',
    station: 1,
    target_team_number: 254,
    event_key: '2026demo',
  },
  // Already played (qm3 has a winner) — should be filtered OUT of upcoming.
  {
    match_key: '2026demo_qm3',
    scout_id: 'scout-1',
    alliance_color: 'blue',
    station: 2,
    target_team_number: 22,
    event_key: '2026demo',
  },
];

// Upcoming-match fixtures: a mix of completed and not-yet-played matches with
// varied comp_level / scheduled_time so the sort + filter can be exercised.
const matchRows = [
  {
    match_key: '2026demo_qm5',
    event_key: '2026demo',
    comp_level: 'qm',
    match_number: 5,
    scheduled_time: '2026-06-23T10:00:00Z',
    red1: 254, red2: 1678, red3: 100,
    blue1: 200, blue2: 300, blue3: 400,
    actual_red_score: null, actual_blue_score: null,
    winner: null, result_synced_at: null,
  },
  {
    match_key: '2026demo_qm3',
    event_key: '2026demo',
    comp_level: 'qm',
    match_number: 3,
    scheduled_time: '2026-06-23T09:00:00Z',
    red1: 11, red2: 12, red3: 13,
    blue1: 21, blue2: 22, blue3: 23,
    actual_red_score: 50, actual_blue_score: 40,
    winner: 'red', result_synced_at: '2026-06-23T09:30:00Z',
  },
  {
    match_key: '2026demo_sf1',
    event_key: '2026demo',
    comp_level: 'sf',
    match_number: 1,
    scheduled_time: null,
    red1: 1, red2: 2, red3: 3,
    blue1: 4, blue2: 5, blue3: 6,
    actual_red_score: null, actual_blue_score: null,
    winner: null, result_synced_at: null,
  },
];

let activeEventRows: { event_key: string; is_active: boolean }[] = [
  { event_key: '2026demo', is_active: true },
];

vi.mock('@/lib/supabase', () => {
  return {
    supabase: {
      from: (table: string) => ({
        select: () => ({
          // assignment: .select('*').eq('scout_id', id)
          // match: .select(...).eq('event_key', key)
          eq: () =>
            Promise.resolve({
              data:
                table === 'event'
                  ? activeEventRows
                  : table === 'match'
                    ? matchRows
                    : assignmentRows,
              error: null,
            }),
        }),
      }),
    },
  };
});

let sessionScout: { id: string; display_name?: string; event_key?: string } | null = {
  id: 'scout-1',
  display_name: 'Casey',
  event_key: '2026demo',
};

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({ scout: sessionScout, session: {}, role: 'scout', loading: false }),
  clearCachedScout: () => {},
}));

const forgetScouterName = vi.fn();
const markScouterLoggedOut = vi.fn();
const reconcileScouterIdentity = vi.fn();
let loggedOutFlag = false;
vi.mock('@/roster/selectScouter', () => ({
  forgetScouterName: () => forgetScouterName(),
  getRememberedScouterName: () => null,
  isScouterLoggedOut: () => loggedOutFlag,
  markScouterLoggedOut: () => markScouterLoggedOut(),
  selectScouter: vi.fn(),
  reconcileScouterIdentity: (...args: unknown[]) => reconcileScouterIdentity(...args),
}));

vi.mock('@/roster/rosterClient', () => ({
  listRoster: () => Promise.resolve([{ id: 'r1', name: 'Casey' }]),
}));

let storedActiveEvent: string | null = '2026demo';
vi.mock('@/dash/activeEventStore', () => ({
  ACTIVE_EVENT_STORAGE_KEY: 'active_event_key',
  getStoredActiveEvent: () => storedActiveEvent,
  isValidStoredEventKey: (value: unknown) => typeof value === 'string' && value.length > 0,
  setStoredActiveEvent: (value: string | null) => {
    storedActiveEvent = value;
  },
}));

vi.mock('@/export/exportReports', () => ({
  exportUnsyncedToFile: () =>
    Promise.resolve({ count: 0, filename: 'reports.json', blobUrl: 'blob:fake' }),
}));

// SyncIndicator (mounted in the ScoutHome header) reads the useSync hook; the
// real hook lands this wave from a sibling agent, so stub it here.
vi.mock('@/sync/useSync', () => ({
  useSync: () => ({ online: true, queued: 0, deadLetters: 0, syncing: false, syncNow: () => {} }),
}));

import ScoutHome, { normalizeManualMatchKey, deriveSlotForTeam } from '@/capture/ScoutHome';
import { db, saveDraft } from '@/db/localStore';
import type { CachedMatch } from '@/db/types';

describe('normalizeManualMatchKey (BUG-1)', () => {
  const ev = '2026txhou1';
  it('builds the canonical qual key from a bare number', () => {
    expect(normalizeManualMatchKey('10', ev)).toBe('2026txhou1_qm10');
    expect(normalizeManualMatchKey(' 7 ', ev)).toBe('2026txhou1_qm7');
    // Leading zeros are stripped.
    expect(normalizeManualMatchKey('007', ev)).toBe('2026txhou1_qm7');
  });
  it('accepts q/qm-prefixed tokens', () => {
    expect(normalizeManualMatchKey('qm10', ev)).toBe('2026txhou1_qm10');
    expect(normalizeManualMatchKey('q10', ev)).toBe('2026txhou1_qm10');
    expect(normalizeManualMatchKey('QM10', ev)).toBe('2026txhou1_qm10');
  });
  it('accepts active-event full keys and rejects cross-event targets', () => {
    expect(normalizeManualMatchKey('2026txhou1_qm10', ev)).toBe('2026txhou1_qm10');
    expect(normalizeManualMatchKey('2026txhou1_sf3m1', ev)).toBe('2026txhou1_sf3m1');
    expect(normalizeManualMatchKey('2026casnv_qm10', ev)).toBe('');
    expect(normalizeManualMatchKey('2026txhou1_unknown', ev)).toBe('');
  });
  it('returns empty for unparseable / zero / blank input', () => {
    expect(normalizeManualMatchKey('', ev)).toBe('');
    expect(normalizeManualMatchKey('abc', ev)).toBe('');
    expect(normalizeManualMatchKey('0', ev)).toBe('');
  });
});

// ScoutHome reads ?mode from the URL via useSearchParams, so renders need a
// Router. `route` lets a test deep-link into a mode (e.g. /scout?mode=pit).
function renderHome(route = '/scout') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <ScoutHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
  await db.cachedMatches.clear();
  await db.cachedAssignments.clear();
  forgetScouterName.mockClear();
  markScouterLoggedOut.mockClear();
  loggedOutFlag = false;
  sessionScout = { id: 'scout-1', display_name: 'Casey', event_key: '2026demo' };
  storedActiveEvent = '2026demo';
  activeEventRows = [{ event_key: '2026demo', is_active: true }];
  assignmentRows = [
    {
      match_key: '2026demo_qm5',
      scout_id: 'scout-1',
      alliance_color: 'red',
      station: 1,
      target_team_number: 254,
      event_key: '2026demo',
    },
    {
      match_key: '2026demo_qm3',
      scout_id: 'scout-1',
      alliance_color: 'blue',
      station: 2,
      target_team_number: 22,
      event_key: '2026demo',
    },
  ];
  reconcileScouterIdentity.mockReset();
  reconcileScouterIdentity.mockResolvedValue({
    id: 'scout-1',
    display_name: 'Casey',
    event_key: '2026demo',
    auth_uid: 'anon-1',
    created_at: '2026-01-01T00:00:00Z',
  });
});

describe('ScoutHome', () => {
  it('renders assignments and unsynced count', async () => {
    renderHome();
    expect(screen.getByTestId('scout-home')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByTestId('scout-assignment').length).toBe(1);
    });
  });

  it('preserves cached assignments when live rows miss an unconfirmed stale identity', async () => {
    await db.cachedAssignments.put({
      id: 'cached-old-qm5',
      scout_id: 'scout-old',
      match_key: '2026demo_qm5',
      alliance_color: 'red',
      station: 1,
      target_team_number: 254,
      event_key: '2026demo',
    });
    sessionScout = { id: 'scout-old', display_name: 'Casey', event_key: '2026demo' };
    assignmentRows = assignmentRows.map((row) => ({ ...row, scout_id: 'scout-canonical' }));
    reconcileScouterIdentity.mockRejectedValue(new Error('Failed to fetch'));

    renderHome();

    await waitFor(() => expect(screen.getAllByTestId('scout-assignment')).toHaveLength(1));
    expect((await db.cachedAssignments.get('cached-old-qm5'))?.scout_id).toBe('scout-old');
  });

  it('authoritatively clears cached assignments when the whole live event is empty', async () => {
    await db.cachedAssignments.put({
      id: 'cached-cleared-qm5',
      scout_id: 'scout-1',
      match_key: '2026demo_qm5',
      alliance_color: 'red',
      station: 1,
      target_team_number: 254,
      event_key: '2026demo',
    });
    assignmentRows = [];

    renderHome();

    await waitFor(async () => {
      expect(await db.cachedAssignments.where('event_key').equals('2026demo').count()).toBe(0);
    });
    expect(screen.queryByTestId('scout-assignment')).toBeNull();
  });

  it('refreshes to the canonical scout identity and its live assignments', async () => {
    sessionScout = { id: 'scout-old', display_name: 'Casey', event_key: '2026demo' };
    assignmentRows = assignmentRows.map((row) => ({ ...row, scout_id: 'scout-canonical' }));
    reconcileScouterIdentity.mockResolvedValue({
      id: 'scout-canonical',
      display_name: 'Casey',
      event_key: '2026demo',
      auth_uid: 'anon-1',
      created_at: '2026-01-01T00:00:00Z',
    });

    renderHome();

    await waitFor(() => expect(screen.getAllByTestId('scout-assignment')).toHaveLength(1));
    expect(reconcileScouterIdentity).toHaveBeenCalledWith('2026demo', 'Casey');
    await waitFor(async () => {
      const cached = await db.cachedAssignments.where('event_key').equals('2026demo').toArray();
      expect(cached.every((row) => row.scout_id === 'scout-canonical')).toBe(true);
      expect(cached).toHaveLength(2);
    });
  });

  it('does not show tutorial promotion after identity selection', async () => {
    renderHome();
    await screen.findByTestId('scout-upcoming-matches');
    expect(screen.queryByTestId('tutorial-invite')).toBeNull();
    expect(screen.queryByTestId('scout-tutorial-link')).toBeNull();
  });

  it('offers one tutorial button before identity selection and with no event', async () => {
    sessionScout = null;
    storedActiveEvent = null;
    activeEventRows = [];
    renderHome();
    expect(await screen.findByTestId('scout-no-event')).toBeTruthy();
    expect(screen.getByTestId('scout-tutorial-link').getAttribute('href')).toBe(
      '/scout/tutorial',
    );
    expect(screen.getByRole('link', { name: /open tutorial/i })).toHaveTextContent(
      'Tutorial',
    );
    expect(screen.getAllByTestId('scout-tutorial-link')).toHaveLength(1);
  });

  it('allows roster names to wrap inside narrow picker columns', async () => {
    sessionScout = null;
    renderHome();

    const option = await screen.findByTestId('scout-name-option-Casey');
    expect(option).toHaveClass('min-w-0', 'whitespace-normal', 'break-words');
    expect(option.closest('li')).toHaveClass('min-w-0');
  });

  it('forces a new identity pick when the server event differs from cached state', async () => {
    storedActiveEvent = '2026casnv';
    activeEventRows = [{ event_key: '2026demo', is_active: true }];
    sessionScout = { id: 'scout-old', display_name: 'Casey', event_key: '2026casnv' };
    renderHome();

    expect(await screen.findByTestId('scout-name-picker')).toBeTruthy();
    expect(screen.getByText(/start scouting event/).textContent).toContain('2026demo');
    expect(screen.queryByTestId('scout-manual-pick')).toBeNull();
  });

  it('lists resume drafts with a human-readable title (not the raw key)', async () => {
    await saveDraft('qm9:scout-1:111', { bursts: [] });
    renderHome();
    await waitFor(() => {
      // Friendly: "Qualification 9 · Team 111" — never the raw "qm9:scout-1:111".
      expect(screen.getByText(/Qualification 9.*Team 111/)).toBeTruthy();
    });
    expect(screen.queryByText(/qm9:scout-1:111/)).toBeNull();
  });

  it('keeps a different-event draft stored without showing a bottom notice', async () => {
    await saveDraft('2026old_qm7:scout-1:222', {
      target: {
        eventKey: '2026old',
        matchKey: '2026old_qm7',
        scoutId: 'scout-1',
        scoutName: 'Casey',
        targetTeamNumber: 222,
        allianceColor: 'red',
        station: 1,
      },
    });
    renderHome();
    await screen.findByTestId('scout-upcoming-matches');
    expect(screen.queryByTestId('scout-resume-2026old_qm7:scout-1:222')).toBeNull();
    expect(screen.queryByTestId('scout-other-event-drafts')).toBeNull();
    expect(await db.drafts.get('2026old_qm7:scout-1:222')).toBeTruthy();
  });
});

describe('deriveSlotForTeam', () => {
  const row = { red1: 254, red2: 1678, red3: 100, blue1: 200, blue2: 300, blue3: 400 };
  it('finds a red slot with its 1-based station', () => {
    expect(deriveSlotForTeam(row, 254)).toEqual({ alliance: 'red', station: 1 });
    expect(deriveSlotForTeam(row, 100)).toEqual({ alliance: 'red', station: 3 });
  });
  it('finds a blue slot with its 1-based station', () => {
    expect(deriveSlotForTeam(row, 300)).toEqual({ alliance: 'blue', station: 2 });
  });
  it('returns null for a team not in the lineup, an unknown row, or bad input', () => {
    expect(deriveSlotForTeam(row, 9999)).toBeNull();
    expect(deriveSlotForTeam(undefined, 254)).toBeNull();
    expect(deriveSlotForTeam(row, NaN)).toBeNull();
    expect(deriveSlotForTeam(row, 0)).toBeNull();
  });
  it('skips null (TBD) slots without matching them', () => {
    expect(
      deriveSlotForTeam({ red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null }, 254),
    ).toBeNull();
  });
});

// Full CachedMatch row for the preload cache (deriveSlotForTeam reads the
// lineup; the rest satisfies the row shape).
function mkCachedMatch(over: Partial<CachedMatch>): CachedMatch {
  return {
    match_key: '2026demo_qm5',
    event_key: '2026demo',
    comp_level: 'qm',
    match_number: 5,
    scheduled_time: null,
    red1: 254, red2: 1678, red3: 100,
    blue1: 200, blue2: 300, blue3: 400,
    actual_red_score: null, actual_blue_score: null,
    winner: null, result_synced_at: null,
    ...over,
  };
}

describe('ScoutHome manual pick', () => {
  it('disables start until match + team provided', async () => {
    renderHome();
    const btn = await screen.findByTestId('scout-start-capture') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'qm5' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    expect((screen.getByTestId('scout-start-capture') as HTMLButtonElement).disabled).toBe(false);
  });

  it('derives alliance/station from the cached schedule and hides the selects', async () => {
    await db.cachedMatches.put(mkCachedMatch({}));
    renderHome();
    fireEvent.change(await screen.findByLabelText('Match'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '300' } });
    // Derived chip appears (blue 2 for team 300); manual selects never show.
    const chip = await screen.findByTestId('scout-manual-derived');
    expect(chip.textContent).toContain('blue 2');
    expect(screen.queryByLabelText('Alliance')).toBeNull();
    expect(screen.queryByLabelText('Station')).toBeNull();
    // Starting opens the placement step on the BLUE (right) half — the derived
    // alliance actually drives the capture target.
    fireEvent.click(screen.getByTestId('scout-start-capture'));
    const clip = await screen.findByTestId('capture-half-clip');
    expect(clip.getAttribute('data-half')).toBe('right');
  });

  it('falls back to alliance/station selects when the match is not in the cache', async () => {
    // Cache is EMPTY (offline fresh device): typing both fields surfaces the
    // fallback selects instead of a derived chip.
    renderHome();
    await screen.findByLabelText('Match');
    expect(screen.queryByLabelText('Alliance')).toBeNull();
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'qm9' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    expect(screen.getByLabelText('Alliance')).toBeTruthy();
    expect(screen.getByLabelText('Station')).toBeTruthy();
    expect(screen.queryByTestId('scout-manual-derived')).toBeNull();
  });

  it('blocks a team that is not playing in a fully-known lineup', async () => {
    await db.cachedMatches.put(mkCachedMatch({}));
    renderHome();
    fireEvent.change(await screen.findByLabelText('Match'), { target: { value: '5' } });
    // First type a team that IS in the lineup and wait for its derived chip —
    // that's the visible signal the cached schedule has finished loading, so
    // the click below can't race the async cache read and start a capture.
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '300' } });
    await screen.findByTestId('scout-manual-derived');
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    fireEvent.click(screen.getByTestId('scout-start-capture'));
    expect(screen.getByTestId('scout-manual-warning').textContent).toMatch(
      /isn’t playing in Qualification 5/,
    );
    // Capture did NOT start.
    expect(screen.queryByTestId('capture-half-clip')).toBeNull();
  });
});

describe('ScoutHome resume click', () => {
  it('opens capture from a draft and renders the LIVE start button', async () => {
    await saveDraft('qm7:scout-1:222', { bursts: [] });
    renderHome();
    const item = await screen.findByTestId('scout-resume-qm7:scout-1:222');
    fireEvent.click(item);
    // The capture flow now opens on the robot-placement step; a placement tap is
    // required before the submit button enables, then it advances to the live
    // match screen with the START button.
    fireEvent.pointerUp(await screen.findByTestId('capture-field'), { pointerId: 1 });
    const submit = await screen.findByTestId('capture-placement-submit');
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByTestId('capture-start')).toBeTruthy();
    });
  });
});

describe('ScoutHome logout', () => {
  it('shows a clearly labeled logout control with the scout name', async () => {
    renderHome();
    const logout = await screen.findByTestId('scout-logout');
    // The control should be a labeled button (text), not just an icon.
    expect(logout.textContent).toMatch(/log out|switch/i);
  });

  it('forgets the scouter and shows the name picker in place on logout', async () => {
    renderHome();
    const logout = await screen.findByTestId('scout-logout');
    fireEvent.click(logout);
    // A confirm step may appear; if so, click the confirming control.
    const confirm = screen.queryByTestId('scout-logout-confirm');
    if (confirm) fireEvent.click(confirm);
    // forgetScouterName must have been called so reload doesn't auto-skip picker.
    await waitFor(() => {
      expect(forgetScouterName).toHaveBeenCalled();
    });
    // Logout surfaces the name picker in place (no navigation/reload needed), so a
    // new scouter can take over this device even though useSession still resolves
    // the previous scout row for the device's anonymous auth.uid.
    await waitFor(() => {
      expect(screen.getByTestId('scout-name-picker')).toBeTruthy();
    });
  });

  it('offers a Home link to leave the scouting area', async () => {
    renderHome();
    const home = await screen.findByTestId('nav-home');
    expect(home.getAttribute('href')).toBe('/');
  });
});

describe('ScoutHome matches to scout', () => {
  it('lists only the scout\'s OWN upcoming assigned matches, with friendly labels', async () => {
    renderHome();
    const section = await screen.findByTestId('scout-upcoming-matches');
    await waitFor(() => {
      // Two assignments: qm5 (upcoming) and qm3 (already played). Only qm5 shows.
      expect(screen.getAllByTestId('scout-upcoming-match').length).toBe(1);
    });
    // Friendly label, never the raw match key.
    expect(section.textContent).toContain('Qualification 5');
    expect(section.textContent).not.toContain('2026demo_qm5');
    // Completed assigned match (qm3) is filtered out.
    expect(section.textContent).not.toContain('Qualification 3');
    // sf1 is upcoming but NOT assigned to this scout → must not appear.
    expect(section.textContent).not.toContain('Semifinal 1');
    // The scout's target team for the assignment is shown.
    expect(section.textContent).toContain('254');
  });

  it('starts capture when an assigned match is tapped', async () => {
    renderHome();
    const row = await screen.findByTestId('scout-assignment');
    fireEvent.click(row);
    // Capture flow opens on the placement step.
    expect(await screen.findByTestId('capture-placement-submit')).toBeTruthy();
  });
});

describe('ScoutHome Match/Pit toggle', () => {
  it('defaults to match mode (manual pick visible, no pit flow)', async () => {
    renderHome();
    expect(await screen.findByTestId('scout-manual-pick')).toBeTruthy();
    expect(screen.queryByTestId('pit-flow')).toBeNull();
  });

  it('switching to Pit renders the pit flow inline using the bound identity', async () => {
    renderHome();
    // The toggle keeps the same scout — no name re-pick.
    fireEvent.click(await screen.findByRole('tab', { name: /pit/i }));
    expect(await screen.findByTestId('pit-flow')).toBeTruthy();
    // Team picker is shown; the match manual-pick is gone.
    expect(screen.getByTestId('pit-team-input')).toBeTruthy();
    const startCard = screen.getByTestId('pit-team-start-card');
    expect(startCard.className).toContain('mx-auto');
    expect(startCard.className).toContain('max-w-xl');
    expect(screen.queryByTestId('scout-manual-pick')).toBeNull();
    // No name picker — identity is reused.
    expect(screen.queryByTestId('scout-name-picker')).toBeNull();
  });

  it('deep-links into pit mode via ?mode=pit', async () => {
    renderHome('/scout?mode=pit');
    expect(await screen.findByTestId('pit-flow')).toBeTruthy();
    expect(screen.queryByTestId('scout-manual-pick')).toBeNull();
    // Identity still resolved from the session — picker never shows.
    expect(screen.queryByTestId('scout-name-picker')).toBeNull();
  });

  it('reaches the pit form for a team without re-picking the scout name', async () => {
    renderHome('/scout?mode=pit');
    fireEvent.change(await screen.findByTestId('pit-team-input'), {
      target: { value: '254' },
    });
    fireEvent.click(screen.getByTestId('pit-team-go'));
    expect(await screen.findByTestId('pit-screen')).toBeTruthy();
  });
});
