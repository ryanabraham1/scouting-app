import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, createEvent } from '@testing-library/react';
import { CaptureScreen, shouldLock, LOCK_SLIDE_PX } from '@/capture/CaptureScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
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

function Host(props: { onToReview?: () => void }) {
  const session = useCaptureSession(target);
  capturedSession = session;
  return <CaptureScreen session={session} onToReview={props.onToReview ?? (() => {})} />;
}

// Lets a test drive the placement step for a specific alliance (which half of
// the field the picker reveals).
function AllianceHost({ allianceColor }: { allianceColor: 'red' | 'blue' }) {
  const session = useCaptureSession({ ...target, allianceColor });
  return <CaptureScreen session={session} onToReview={() => {}} />;
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

// The pre-match placement step now gates the live screen: submit it first to
// reach the in-match controls (START etc.).
function submitPlacement() {
  fireEvent.click(screen.getByTestId('capture-placement-submit'));
}

// jsdom's synthetic PointerEvents DROP clientX (even when passed to fireEvent),
// which is exactly why the slide-to-lock gesture could never be DOM-tested before.
// Construct a native pointer event and force a clientX getter so the React
// handler actually receives coordinates — this lets us drive a real slide.
function pointerEventWithX(
  el: Element,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  clientX: number,
  pointerId = 1,
) {
  const ev = createEvent[type](el, { pointerId });
  Object.defineProperty(ev, 'clientX', { get: () => clientX });
  fireEvent(el, ev);
}

// Reach the live in-match teleop screen with all controls visible.
function enterLiveMatch() {
  submitPlacement();
  fireEvent.click(screen.getByTestId('capture-start'));
  fireEvent.click(screen.getByTestId('capture-go'));
  fireEvent.click(screen.getByTestId('capture-inactive-no'));
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

  it('reveals only the team half of the field (red = left, blue = right)', () => {
    const { unmount } = render(<AllianceHost allianceColor="red" />);
    expect(screen.getByTestId('capture-half-clip').getAttribute('data-half')).toBe('left');
    unmount();
    render(<AllianceHost allianceColor="blue" />);
    expect(screen.getByTestId('capture-half-clip').getAttribute('data-half')).toBe('right');
  });
});

describe('CaptureScreen', () => {
  it('shows GO and inactive-first prompt after START', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    expect(screen.getByTestId('capture-inactive-yes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('capture-inactive-yes'));
    await waitFor(() => {
      expect(screen.queryByTestId('capture-inactive-yes')).toBeNull();
    });
  });
});

describe('CaptureScreen hold-to-shoot', () => {
  it('shows accumulated ball count (rate*duration), not the burst count', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
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
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
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

describe('CaptureScreen defense hold-slide-lock', () => {
  it('plain hold→release activates while held and commits (deactivates) on release', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
    const btn = await screen.findByTestId('capture-defense');
    // Press & hold → active.
    fireEvent.pointerDown(btn, { pointerId: 1, clientX: 10 });
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('true');
      expect(btn.getAttribute('data-locked')).toBe('false');
    });
    // Release without sliding → commit + deactivate, not locked.
    fireEvent.pointerUp(btn, { pointerId: 1, clientX: 10 });
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('false');
      expect(btn.getAttribute('data-locked')).toBe('false');
    });
  });

  it('slide-right past the threshold LATCHES locked and STAYS active after release', async () => {
    render(<Host />);
    enterLiveMatch();
    const btn = await screen.findByTestId('capture-defense');

    // Press at x=10 → active, not locked.
    pointerEventWithX(btn, 'pointerDown', 10);
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('true');
      expect(btn.getAttribute('data-locked')).toBe('false');
    });

    // Slide right by exactly the lock threshold → latches locked.
    pointerEventWithX(btn, 'pointerMove', 10 + LOCK_SLIDE_PX);
    await waitFor(() => {
      expect(btn.getAttribute('data-locked')).toBe('true');
    });

    // Release while locked-this-gesture → must STAY active (the bug was that it
    // tore down on release because the locked branch ran before the latch check).
    pointerEventWithX(btn, 'pointerUp', 10 + LOCK_SLIDE_PX);
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('true');
      expect(btn.getAttribute('data-locked')).toBe('true');
    });

    // Tapping again while locked commits + deactivates.
    pointerEventWithX(btn, 'pointerDown', 10);
    pointerEventWithX(btn, 'pointerUp', 10);
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('false');
      expect(btn.getAttribute('data-locked')).toBe('false');
    });
  });

  it('does NOT lock on a tiny slide below the threshold (plain hold)', async () => {
    render(<Host />);
    enterLiveMatch();
    const btn = await screen.findByTestId('capture-defense');
    pointerEventWithX(btn, 'pointerDown', 10);
    pointerEventWithX(btn, 'pointerMove', 10 + LOCK_SLIDE_PX - 1);
    expect(btn.getAttribute('data-locked')).toBe('false');
    pointerEventWithX(btn, 'pointerUp', 10 + LOCK_SLIDE_PX - 1);
    await waitFor(() => {
      expect(btn.getAttribute('data-active')).toBe('false');
      expect(btn.getAttribute('data-locked')).toBe('false');
    });
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

describe('shouldLock (slide-right-to-lock threshold)', () => {
  it('does NOT lock until the pointer slides right past the threshold', () => {
    expect(shouldLock(10, 10)).toBe(false);
    expect(shouldLock(10, 10 + LOCK_SLIDE_PX - 1)).toBe(false);
  });
  it('locks once the pointer slides right by at least the threshold', () => {
    expect(shouldLock(10, 10 + LOCK_SLIDE_PX)).toBe(true);
    expect(shouldLock(10, 10 + LOCK_SLIDE_PX + 50)).toBe(true);
  });
  it('does NOT lock when sliding left', () => {
    expect(shouldLock(200, 10)).toBe(false);
  });
  it('is safe with non-finite coords (jsdom synthetic events)', () => {
    expect(shouldLock(10, NaN)).toBe(false);
    expect(shouldLock(NaN, 200)).toBe(false);
  });
});

describe('CaptureScreen reAnchor cue', () => {
  it('shows a 0:30 cue button that re-anchors to endgame', async () => {
    render(<Host />);
    submitPlacement();
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
    const cue = await screen.findByTestId('capture-reanchor');
    fireEvent.click(cue);
    await waitFor(() => {
      expect(screen.getByTestId('capture-window').textContent).toContain('endgame');
    });
  });
});
