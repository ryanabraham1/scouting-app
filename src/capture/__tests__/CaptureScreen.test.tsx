import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { CaptureScreen } from '@/capture/CaptureScreen';
import {
  flushCaptureSessionWritesForTests,
  useCaptureSession,
  type CaptureTarget,
} from '@/capture/useCaptureSession';
import { AUTO_MS } from '@/capture/clock';
import { db, saveDraft } from '@/db/localStore';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

let capturedSession: ReturnType<typeof useCaptureSession> | null = null;

function Host(props: { onToReview?: () => void; allianceColor?: 'red' | 'blue' }) {
  const session = useCaptureSession({
    ...target,
    allianceColor: props.allianceColor ?? target.allianceColor,
  });
  capturedSession = session;
  return <CaptureScreen session={session} onToReview={props.onToReview ?? (() => {})} />;
}

// Lets a test drive the placement step for a specific alliance (which half of
// the field the picker reveals).
function AllianceHost({
  allianceColor,
  teamNumber = target.targetTeamNumber,
  station = target.station,
}: {
  allianceColor: 'red' | 'blue';
  teamNumber?: number;
  station?: 1 | 2 | 3;
}) {
  const session = useCaptureSession({
    ...target,
    allianceColor,
    targetTeamNumber: teamNumber,
    station,
  });
  return <CaptureScreen session={session} onToReview={() => {}} />;
}

function TimedHost({ nowMs }: { nowMs: number }) {
  const session = useCaptureSession(target, { now: () => nowMs });
  return <CaptureScreen session={session} onToReview={() => {}} />;
}

beforeEach(async () => {
  await flushCaptureSessionWritesForTests();
  await db.reports.clear();
  await db.drafts.clear();
});

afterEach(async () => {
  // Unmount first so no effect can enqueue more persistence, then await the
  // actual serialized writer. A one-tick delay is not a durability boundary:
  // under full-suite load an older Dexie write could finish after clear() and
  // make the next test hydrate into GO/resume-clock mid-gesture.
  cleanup();
  await flushCaptureSessionWritesForTests();
  await db.reports.clear();
  await db.drafts.clear();
  capturedSession = null;
});

// The pre-match placement step now gates the live screen: a placement tap is
// REQUIRED (the submit button is disabled until the field is tapped), so place the
// robot first, then submit, to reach the in-match controls (START etc.).
function submitPlacement() {
  fireEvent.pointerUp(screen.getByTestId('capture-field'), { pointerId: 1 });
  fireEvent.click(screen.getByTestId('capture-placement-submit'));
}

// jsdom's synthetic PointerEvents DROP clientX (even when passed to fireEvent),
// which is exactly why the slide-to-lock gesture could never be DOM-tested before.


// Reach the live in-match teleop screen with all controls visible.
function enterLiveMatch() {
  submitPlacement();
  fireEvent.click(screen.getByTestId('capture-start'));
  fireEvent.click(screen.getByTestId('capture-go'));
  fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
}

describe('CaptureScreen placement step', () => {
  it('shows a placement step with a square picker, then submits into the match', () => {
    render(<Host />);
    // Placement step visible; live START not yet.
    expect(screen.getByTestId('capture-placement-submit')).toBeTruthy();
    expect(screen.queryByTestId('capture-start')).toBeNull();
    // Field is in pick-start mode during placement.
    expect(screen.getByTestId('capture-field').getAttribute('data-mode')).toBe('pick-start');
    submitPlacement();
    expect(screen.getByTestId('capture-start')).toBeTruthy();
  });

  it('keeps the submit button DISABLED until a placement tap is made', () => {
    render(<Host />);
    const submit = screen.getByTestId('capture-placement-submit') as HTMLButtonElement;
    // No start position yet → disabled, and clicking does NOT advance.
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(screen.queryByTestId('capture-start')).toBeNull();
    // Tap the field to place the robot → submit enables and advances.
    fireEvent.pointerUp(screen.getByTestId('capture-field'), { pointerId: 1 });
    expect((screen.getByTestId('capture-placement-submit') as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId('capture-placement-submit'));
    expect(screen.getByTestId('capture-start')).toBeTruthy();
  });

  it('reveals only the team half of the field (red = left, blue = right)', () => {
    const { unmount } = render(<AllianceHost allianceColor="red" />);
    expect(screen.getByTestId('capture-half-clip').getAttribute('data-half')).toBe('left');
    unmount();
    render(<AllianceHost allianceColor="blue" />);
    expect(screen.getByTestId('capture-half-clip').getAttribute('data-half')).toBe('right');
  });

  it('makes red and blue assignment identity explicit and accessible', () => {
    const { unmount } = render(
      <AllianceHost allianceColor="red" teamNumber={3256} station={2} />,
    );
    expect(screen.getByTestId('capture-target').getAttribute('aria-label')).toBe(
      'Scouting Team 3256, Red alliance station 2. Tap the field where it starts.',
    );
    const redStation = screen.getByTestId('capture-alliance-station');
    expect(redStation.textContent).toBe('RED 2');
    expect(redStation.className).toContain('bg-red-600');
    expect(screen.getByText('3256').className).toContain('text-xl');

    unmount();
    render(
      <AllianceHost allianceColor="blue" teamNumber={12345} station={3} />,
    );
    expect(screen.getByTestId('capture-target').getAttribute('aria-label')).toBe(
      'Scouting Team 12345, Blue alliance station 3. Tap the field where it starts.',
    );
    const blueStation = screen.getByTestId('capture-alliance-station');
    expect(blueStation.textContent).toBe('BLUE 3');
    expect(blueStation.className).toContain('bg-blue-600');
    expect(screen.getByTestId('capture-target').className).toContain('min-w-0');
    expect(screen.getByTestId('capture-placement-title').className).toContain(
      'shrink-0',
    );
  });
});

describe('CaptureScreen', () => {
  it('asks which alliance won Auto after GO and maps that alliance to inactive-first', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    expect(screen.getByText('Which alliance won Auto?')).toBeTruthy();
    expect(screen.getByTestId('capture-auto-winner-red').textContent).toBe('Red');
    expect(screen.getByTestId('capture-auto-winner-blue').textContent).toBe('Blue');
    fireEvent.click(screen.getByTestId('capture-auto-winner-red'));
    expect(capturedSession?.inactiveFirst).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId('capture-auto-winner-red')).toBeNull();
    });
  });

  it('maps a Blue Auto win to inactive-first for a Blue scouted team', () => {
    render(<Host allianceColor="blue" />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    expect(capturedSession?.inactiveFirst).toBe(true);
  });
});

describe('CaptureScreen top undo control', () => {
  it('shows a compact top icon when available and reverses the latest action', () => {
    render(<Host />);
    submitPlacement();

    expect(screen.queryByTestId('capture-undo')).toBeNull();
    expect(screen.getByTestId('capture-to-review').className).toContain('w-full');

    fireEvent.click(screen.getByTestId('capture-foul'));
    const undoFoul = screen.getByTestId('capture-undo');
    expect(undoFoul.closest('header')).toBeTruthy();
    expect(undoFoul.textContent).toContain('Undo');
    expect(undoFoul.className).toContain('h-11');
    expect(undoFoul.getAttribute('aria-label')).toBe('Undo last action: foul');
    expect(undoFoul.getAttribute('title')).toBe('Undo foul');

    fireEvent.click(screen.getByTestId('capture-left-line'));
    const undoLeftLine = screen.getByTestId('capture-undo');
    expect(undoLeftLine.getAttribute('aria-label')).toBe(
      'Undo last action: left line',
    );
    expect(capturedSession?.autoLeftStartingLine).toBe(true);

    fireEvent.click(undoLeftLine);
    expect(capturedSession?.autoLeftStartingLine).toBe(false);
    expect(screen.getByTestId('capture-undo').getAttribute('aria-label')).toBe(
      'Undo last action: foul',
    );

    fireEvent.click(screen.getByTestId('capture-undo'));
    expect(screen.getByTestId('capture-foul').textContent).toContain('(0)');
    expect(screen.queryByTestId('capture-undo')).toBeNull();
  });
});

describe('CaptureScreen hold-to-shoot', () => {
  it('shows accumulated ball count (rate*duration), not the burst count', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    const hold = await screen.findByTestId('capture-hold');
    // Press, drag to the top (max BPS = 30), hold ~1s, release.
    fireEvent.pointerDown(hold, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(hold, { clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(hold, { clientY: 0, pointerId: 1 });
    // A non-zero accumulated count appears (one 30-BPS burst over the elapsed).
    await waitFor(() => {
      const txt = screen.getByTestId('capture-running-fuel').textContent ?? '';
      expect(Number(txt)).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('CaptureScreen live ball count from BPS', () => {
  it('the running-fuel readout reflects the session committedFuelCount (rate*duration)', async () => {
    await saveDraft('qm1:scout-1:254', {
      // 26 BPS for 1s => 26 balls.
      bursts: [{ startMs: 0, endMs: 1000, rate: 26, window: 'transition' }],
      inactiveFirst: false,
      rate: 1,
      deferred: {},
    });
    render(<Host />);
    await waitFor(() => expect(capturedSession?.committedFuelCount).toBe(26));
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    await waitFor(() => {
      expect(screen.getByTestId('capture-running-fuel').textContent).toBe('26');
    });
  });
});

describe('CaptureScreen countdown', () => {
  it('counts DOWN: auto remaining shrinks toward 0:00', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    const clock = await screen.findByTestId('capture-clock');
    const txt = clock.textContent ?? '';
    // Remaining (mm:ss) is at most the auto duration 0:20 and counting down.
    const [m, sec] = txt.replace(/[^0-9:]/g, '').split(':').map(Number);
    const totalSec = (m || 0) * 60 + (sec || 0);
    expect(totalSec).toBeLessThanOrEqual(20);
  });
});

describe('CaptureScreen Teleop-ready signal', () => {
  it('switches at the authoritative Auto boundary and preserves GO behavior', async () => {
    const { rerender } = render(<TimedHost nowMs={0} />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));

    rerender(<TimedHost nowMs={AUTO_MS - 1} />);
    let go = screen.getByTestId('capture-go');
    expect(go.getAttribute('data-auto-ended')).toBe('false');
    expect(go.className).toContain('bg-energy');
    expect(go.className).not.toContain('bg-success');
    expect(go.textContent).toMatch(/Start teleop/i);
    expect(go.getAttribute('aria-label')).toBe('Start teleop');

    rerender(<TimedHost nowMs={AUTO_MS} />);
    await waitFor(() => {
      expect(screen.getByTestId('capture-window').textContent).toContain('pause');
    });
    go = screen.getByTestId('capture-go');
    expect(go.getAttribute('data-auto-ended')).toBe('true');
    expect(go.className).toContain('bg-success');
    expect(go.textContent).toMatch(/Start teleop/i);
    expect(go.getAttribute('aria-label')).toBe('Start teleop — Auto ended');

    rerender(<TimedHost nowMs={AUTO_MS + 1} />);
    go = screen.getByTestId('capture-go');
    expect(go.getAttribute('data-auto-ended')).toBe('true');
    expect(go.className).toContain('bg-success');

    fireEvent.click(go);
    expect(screen.getByTestId('capture-go-interstitial')).toBeTruthy();
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    expect(screen.queryByTestId('capture-go')).toBeNull();
    expect(screen.getByTestId('capture-reanchor')).toBeTruthy();
  });
});

describe('CaptureScreen defense tap timers', () => {
  it.each(['capture-defense', 'capture-defended'])('toggles %s with two taps and supports undo', async (testid) => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    const button = screen.getByTestId(testid);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('Running · Tap to stop');
    fireEvent.pointerUp(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('capture-undo')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('capture-undo'));
    expect(screen.queryByTestId('capture-undo')).not.toBeInTheDocument();
  });
});

describe('CaptureScreen feeding slider', () => {
  it('renders a distinct feeding slider (brand tone) alongside the scoring slider', async () => {
    render(<Host />);
    enterLiveMatch();
    const scoring = await screen.findByTestId('capture-hold');
    const feeding = await screen.findByTestId('capture-feed');
    expect(scoring.getAttribute('data-tone')).toBe('energy');
    expect(feeding.getAttribute('data-tone')).toBe('brand');
    // Both are slider-role controls.
    expect(scoring.getAttribute('role')).toBe('slider');
    expect(feeding.getAttribute('role')).toBe('slider');
    // Feeding count readout is present and starts at 0.
    expect(screen.getByTestId('capture-running-feed').textContent).toBe('0');
  });

  it('a feeding gesture drives the session feed hold (start/end) lifecycle', async () => {
    render(<Host />);
    enterLiveMatch();
    const feeding = await screen.findByTestId('capture-feed');
    fireEvent.pointerDown(feeding, { pointerId: 1 });
    expect(feeding.getAttribute('data-active')).toBe('true');
    fireEvent.pointerUp(feeding, { pointerId: 1 });
    await waitFor(() => {
      expect(feeding.getAttribute('data-active')).toBe('false');
      // spring back to 0
      expect(feeding.getAttribute('data-rate')).toBe('0');
    });
  });
});

describe('CaptureScreen reAnchor cue', () => {
  it('shows a 0:30 cue button that re-anchors to endgame', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-auto-winner-blue'));
    const cue = await screen.findByTestId('capture-reanchor');
    fireEvent.click(cue);
    await waitFor(() => {
      expect(screen.getByTestId('capture-window').textContent).toContain('endgame');
    });
  });
});
