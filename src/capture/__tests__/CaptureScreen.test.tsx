import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db } from '@/db/localStore';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

function Host(props: { onToReview?: () => void }) {
  const session = useCaptureSession(target);
  return <CaptureScreen session={session} onToReview={props.onToReview ?? (() => {})} />;
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('CaptureScreen', () => {
  it('shows GO and inactive-first prompt after START', async () => {
    render(<Host />);
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
  it('increments running fuel on a hold burst after GO', async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
    const hold = await screen.findByTestId('capture-hold');
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    await waitFor(() => {
      expect(screen.getByTestId('capture-running-fuel').textContent).toBe('1');
    });
  });
});

describe('CaptureScreen reAnchor cue', () => {
  it('shows a 0:30 cue button that re-anchors to endgame', async () => {
    render(<Host />);
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
