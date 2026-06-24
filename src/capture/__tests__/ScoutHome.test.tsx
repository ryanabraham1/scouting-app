import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const assignmentRows = [
  // Upcoming (qm5 has no result yet) — should appear in the scout's to-do list.
  {
    match_key: '2026demo_qm5',
    alliance_color: 'red',
    station: 1,
    target_team_number: 254,
    event_key: '2026demo',
  },
  // Already played (qm3 has a winner) — should be filtered OUT of upcoming.
  {
    match_key: '2026demo_qm3',
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

vi.mock('@/lib/supabase', () => {
  return {
    supabase: {
      from: (table: string) => ({
        select: () => ({
          // assignment: .select('*').eq('scout_id', id)
          // match: .select(...).eq('event_key', key)
          eq: () =>
            Promise.resolve({
              data: table === 'match' ? matchRows : assignmentRows,
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
}));

const forgetScouterName = vi.fn();
vi.mock('@/roster/selectScouter', () => ({
  forgetScouterName: () => forgetScouterName(),
  getRememberedScouterName: () => null,
  selectScouter: vi.fn(),
}));

vi.mock('@/roster/rosterClient', () => ({
  listRoster: () => Promise.resolve([{ id: 'r1', name: 'Casey' }]),
}));

vi.mock('@/dash/activeEventStore', () => ({
  getStoredActiveEvent: () => '2026demo',
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

import ScoutHome from '@/capture/ScoutHome';
import { db, saveDraft } from '@/db/localStore';

// ScoutHome reads ?mode from the URL via useSearchParams, so renders need a
// Router. `route` lets a test deep-link into a mode (e.g. /scout?mode=pit).
function renderHome(route = '/scout') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ScoutHome />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
  forgetScouterName.mockClear();
  sessionScout = { id: 'scout-1', display_name: 'Casey', event_key: '2026demo' };
});

describe('ScoutHome', () => {
  it('renders assignments and unsynced count', async () => {
    renderHome();
    expect(screen.getByTestId('scout-home')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByTestId('scout-assignment').length).toBe(1);
    });
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
});

describe('ScoutHome manual pick', () => {
  it('disables start until match + team provided', async () => {
    renderHome();
    const btn = screen.getByTestId('scout-start-capture') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'qm5' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    expect((screen.getByTestId('scout-start-capture') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ScoutHome resume click', () => {
  it('opens capture from a draft and renders the LIVE start button', async () => {
    await saveDraft('qm7:scout-1:222', { bursts: [] });
    renderHome();
    const item = await screen.findByTestId('scout-resume-qm7:scout-1:222');
    fireEvent.click(item);
    // The capture flow now opens on the robot-placement step; submitting it
    // advances to the live match screen with the START button.
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

  it('forgets the scouter and navigates home on logout', async () => {
    render(
      <MemoryRouter initialEntries={['/scout']}>
        <Routes>
          <Route path="/scout" element={<ScoutHome />} />
          <Route path="/" element={<div data-testid="home-marker">Home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const logout = await screen.findByTestId('scout-logout');
    fireEvent.click(logout);
    // A confirm step may appear; if so, click the confirming control.
    const confirm = screen.queryByTestId('scout-logout-confirm');
    if (confirm) fireEvent.click(confirm);
    // forgetScouterName must have been called so reload doesn't auto-skip picker.
    await waitFor(() => {
      expect(forgetScouterName).toHaveBeenCalled();
    });
    // Logout navigates to the home screen (Scout / Lead Dashboard chooser).
    await waitFor(() => {
      expect(screen.getByTestId('home-marker')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('tab', { name: /pit/i }));
    expect(await screen.findByTestId('pit-flow')).toBeTruthy();
    // Team picker is shown; the match manual-pick is gone.
    expect(screen.getByTestId('pit-team-input')).toBeTruthy();
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
