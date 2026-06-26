import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db, listReports } from '@/db/localStore';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

// Host owns the session in the same render tree as ReviewScreen, mirroring how
// ScoutHome.CaptureFlow wires LIVE + REVIEW around one session. This keeps the
// session prop fresh on every state change (no stale snapshot).
function Host(props: { onSaved: (id: string) => void; initInactiveFirst?: boolean }) {
  const session = useCaptureSession(target);
  useEffect(() => {
    if (props.initInactiveFirst !== undefined) {
      session.setInactiveFirst(props.initInactiveFirst);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ReviewScreen session={session} onSaved={props.onSaved} />;
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

// The wizard is a 5-step flow: Climb -> Defense -> Fouls/flags -> Auto -> Summary.
// `goToFinalStep` clicks Next until the SAVE step is reached.
async function goToFinalStep() {
  // 4 Next clicks: step 1 -> 2 -> 3 -> 4 -> 5.
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-next'));
    });
  }
}

describe('ReviewScreen', () => {
  it('renders climb on step 1 and saves from final step, calling onSaved with an id', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    // Step 1 shows climb; summary/save live on the final step.
    expect(screen.getByTestId('review-climb')).toBeTruthy();
    expect(screen.getByTestId('review-step')).toBeTruthy();
    expect(screen.queryByTestId('review-save')).toBeNull();

    await goToFinalStep();

    expect(screen.getByTestId('review-summary')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(typeof onSaved.mock.calls[0][0]).toBe('string');

    const reports = await listReports();
    expect(reports).toHaveLength(1);
  });

  it('navigates forward and back between steps', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    expect(screen.getByTestId('review-climb')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-next'));
    });
    // Step 2 shows defense fields, not climb.
    expect(screen.getByTestId('review-defense-seconds')).toBeTruthy();
    expect(screen.queryByTestId('review-climb')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-back'));
    });
    // Back to step 1.
    expect(screen.getByTestId('review-climb')).toBeTruthy();
  });

  it('renders the kept flags but not the Fed corral flag on the Fouls & flags step', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    // Advance to the Fouls & flags step (step 3 = 2 Next clicks).
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(screen.getByTestId('review-next'));
      });
    }

    // Kept flags are present.
    expect(screen.getByText('No show')).toBeTruthy();
    expect(screen.getByText('Died')).toBeTruthy();
    expect(screen.getByText('Tipped')).toBeTruthy();
    expect(screen.getByText('Dropped')).toBeTruthy();

    // Fed corral flag control must be gone.
    expect(screen.queryByText(/fed corral/i)).toBeNull();
  });

  it('records selected foul reasons and persists them into the saved report', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    // Advance to the Fouls & flags step (step 3 = 2 Next clicks).
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(screen.getByTestId('review-next'));
      });
    }

    // Tag two common foul reasons (separate acts so each toggle sees the prior
    // state — a single act batches both clicks against one stale snapshot).
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-foul-reason-pinning'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-foul-reason-opponent_contact'));
    });

    // Finish (2 more Next clicks) and save.
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(screen.getByTestId('review-next'));
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const reports = await listReports();
    expect(reports[0].foulReasons).toEqual(['pinning', 'opponent_contact']);
  });

  it('does not offer a second editable start-position picker on the Auto step', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    // Advance to the Auto step (step 4 = 3 Next clicks).
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        fireEvent.click(screen.getByTestId('review-next'));
      });
    }

    // The editable pick-start FieldDiagram must be gone; only path editing remains.
    expect(screen.queryByTestId('review-field-start')).toBeNull();
    expect(screen.getByTestId('review-field-path')).toBeTruthy();
  });
});

describe('ReviewScreen climb', () => {
  it('updates climb level on click and persists into saved report', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} />);

    const climb = screen.getByTestId('review-climb');
    await act(async () => {
      fireEvent.click(climb.querySelectorAll('button')[3]); // level 3
    });
    await waitFor(() =>
      expect((climb.querySelectorAll('button')[3] as HTMLButtonElement).className).toContain(
        'bg-primary',
      ),
    );

    await goToFinalStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const reports = await listReports();
    expect(reports[0].climbLevel).toBe(3);
  });
});
