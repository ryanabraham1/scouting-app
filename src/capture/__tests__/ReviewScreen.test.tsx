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

describe('ReviewScreen', () => {
  it('renders summary and saves, calling onSaved with an id', async () => {
    const onSaved = vi.fn();
    render(<Host onSaved={onSaved} initInactiveFirst={false} />);

    expect(screen.getByTestId('review-summary')).toBeTruthy();
    expect(screen.getByTestId('review-climb')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(typeof onSaved.mock.calls[0][0]).toBe('string');

    const reports = await listReports();
    expect(reports).toHaveLength(1);
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

    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const reports = await listReports();
    expect(reports[0].climbLevel).toBe(3);
  });
});
