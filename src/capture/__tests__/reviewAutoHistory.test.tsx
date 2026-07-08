import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db, listReports } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

// Server leg of useTeamAutoHistory is controllable per test (default: reachable
// with zero rows); the local Dexie leg (seeded below) drives the picker, so the
// tests are deterministic + network-free.
const serverState = vi.hoisted(() => ({
  result: { data: [] as unknown[], error: null as unknown },
}));
vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    then: (resolve: (v: unknown) => void) => resolve(serverState.result),
  };
  return { supabase: { from: () => builder } };
});

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm7',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

// A routine team 254 was already scouted running, on RED, in an earlier match.
const PRIOR_PATH = [
  { x: 0.2, y: 0.3 },
  { x: 0.3, y: 0.4 },
  { x: 0.45, y: 0.5 },
];

// Default 'dirty': a pre-upload local capture is authoritative on this device.
// ('synced' rows defer to the server — see the stale-data regression tests.)
function seedPriorAuto(syncState: LocalMatchReport['syncState'] = 'dirty'): Promise<string> {
  const r = {
    id: 'prior-1',
    matchKey: 'qm3',
    eventKey: '2026demo',
    scoutId: 'scout-2',
    targetTeamNumber: 254,
    allianceColor: 'red',
    station: 2,
    autoStartPosition: { x: 0.2, y: 0.3 },
    autoPath: PRIOR_PATH,
    syncState,
    createdAt: new Date(0).toISOString(),
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
  } as unknown as LocalMatchReport;
  return db.reports.put(r);
}

function Host(props: { onSaved: (id: string) => void }) {
  const session = useCaptureSession(target);
  return <ReviewScreen session={session} onSaved={props.onSaved} />;
}

async function goToAutoStep() {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-next'));
    });
  }
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
  serverState.result = { data: [], error: null };
});

describe('ReviewScreen — pick a known auto', () => {
  it('shows the picker on the Auto step when the team has prior autos', async () => {
    await seedPriorAuto();
    render(<Host onSaved={vi.fn()} />);
    await goToAutoStep();

    // The mode toggle + the picker option appear once the history loads.
    await waitFor(() => expect(screen.getByTestId('review-auto-history-opt-0')).toBeTruthy());
    // Known mode is the default, so the draw field is hidden until "Draw new".
    expect(screen.queryByTestId('review-field-path')).toBeNull();
  });

  it('applies a selected routine to the report (same-alliance coords unchanged)', async () => {
    await seedPriorAuto();
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} />);
    await goToAutoStep();

    await waitFor(() => expect(screen.getByTestId('review-auto-history-opt-0')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-auto-history-opt-0'));
    });

    // Advance to the final step and save.
    for (let i = 0; i < 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(screen.getByTestId('review-next'));
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const saved = (await listReports()).find((r) => r.matchKey === 'qm7');
    expect(saved).toBeTruthy();
    // RED routine applied on a RED match → original absolute coords.
    expect(saved!.autoPath).toEqual(PRIOR_PATH);
    expect(saved!.autoStartPosition).toEqual({ x: 0.2, y: 0.3 });
  });

  it('falls back to the draw field when the team has no prior autos', async () => {
    render(<Host onSaved={vi.fn()} />);
    await goToAutoStep();
    // No toggle, no options — just the trace-it field (legacy behavior).
    expect(screen.queryByTestId('review-auto-history-opt-0')).toBeNull();
    expect(screen.getByTestId('review-field-path')).toBeTruthy();
  });

  it('a SYNCED local whose server twin was deleted does NOT resurface (stale-data bug)', async () => {
    // The report synced once, but the server no longer returns it (deleted /
    // superseded). The server answered authoritatively → no phantom "known auto".
    await seedPriorAuto('synced');
    render(<Host onSaved={vi.fn()} />);
    await goToAutoStep();
    await waitFor(() => expect(screen.getByTestId('review-field-path')).toBeTruthy());
    expect(screen.queryByTestId('review-auto-history-opt-0')).toBeNull();
  });

  it('a SYNCED local still shows when the server is unreachable (offline cache)', async () => {
    serverState.result = { data: null as unknown as unknown[], error: { message: 'offline' } };
    await seedPriorAuto('synced');
    render(<Host onSaved={vi.fn()} />);
    await goToAutoStep();
    await waitFor(() => expect(screen.getByTestId('review-auto-history-opt-0')).toBeTruthy());
  });
});
