import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScoutTutorial from '../ScoutTutorial';
import {
  MATCH_COACH_STEPS,
  MATCH_STEP_COUNT,
  PIT_COACH_STEPS,
  PIT_STEP_COUNT,
} from '../curriculum';
import {
  EMPTY_TUTORIAL_DATA,
  readTutorialProgress,
  writeTutorialProgress,
} from '../tutorialStorage';
import { installMemoryStorage } from './memoryStorage';
import { db } from '@/db/localStore';
import { pitDb } from '@/pit/pitStore';

function renderTutorial(route = '/scout/tutorial?scout=scout-1'): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <ScoutTutorial />
    </MemoryRouter>,
  );
}

async function startMatch(): Promise<void> {
  fireEvent.click(screen.getByTestId('tutorial-hub-match'));
  await screen.findByTestId('capture-field');
}

async function startPit(): Promise<void> {
  fireEvent.click(screen.getByTestId('tutorial-hub-pit'));
  await screen.findByTestId('pit-drivetrain');
}

function skipOptional(): void {
  fireEvent.click(screen.getAllByTestId('tutorial-next-control')[0]);
}

function placeRobot(): void {
  fireEvent.pointerUp(screen.getByTestId('capture-field'), { pointerId: 1 });
  fireEvent.click(screen.getByTestId('capture-placement-submit'));
}

async function openReview(): Promise<void> {
  await startMatch();
  placeRobot();
  fireEvent.click(screen.getByTestId('capture-to-review'));
  await screen.findByTestId('review-climb');
}

describe('ScoutTutorial module hub and production coaching', () => {
  beforeAll(installMemoryStorage);

  beforeEach(async () => {
    localStorage.clear();
    await db.drafts.clear();
    await db.reports.clear();
    await pitDb.pitDrafts.clear();
    await pitDb.pitReports.clear();
  });

  it('opens on a mobile-first hub with separate match and pit choices', () => {
    renderTutorial('/scout/tutorial');

    expect(screen.getByTestId('tutorial-hub')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Practice match scouting' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Practice pit scouting' }),
    ).toBeInTheDocument();
    expect(screen.getByText(`${MATCH_STEP_COUNT} guided controls`)).toBeTruthy();
    expect(screen.getByText(`${PIT_STEP_COUNT} guided controls`)).toBeTruthy();
    expect(screen.queryByTestId('tutorial-practice-banner')).toBeNull();
    expect(screen.queryByText(/nothing is saved/i)).toBeNull();
    expect(screen.queryByText(/focus highlighted control/i)).toBeNull();
    expect(screen.queryByText(/safe practice/i)).toBeNull();
    expect(screen.getByTestId('tutorial-hub-match-card')).toHaveClass('min-w-0');
    expect(screen.getByTestId('tutorial-hub-pit-card')).toHaveClass('min-w-0');
  });

  it('stores progress separately and honestly restarts incomplete practice', async () => {
    writeTutorialProgress('scout-1', {
      status: 'in_progress',
      step: 11,
      data: {
        ...EMPTY_TUTORIAL_DATA,
        module: 'hub',
        match: { status: 'in_progress', step: 11 },
        pit: { status: 'completed', step: PIT_STEP_COUNT },
      },
    });
    renderTutorial();

    expect(screen.getByTestId('tutorial-hub-match-card')).toHaveTextContent(
      'In progress',
    );
    expect(screen.getByTestId('tutorial-hub-pit-card')).toHaveTextContent(
      'Completed',
    );
    expect(screen.getByTestId('tutorial-hub-match')).toHaveTextContent('Restart practice');
    expect(screen.queryByTestId('tutorial-hub-match-start-over')).toBeNull();

    fireEvent.click(screen.getByTestId('tutorial-hub-match'));
    expect(await screen.findByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="capture-field"]',
    );
    fireEvent.click(screen.getByTestId('capture-exit'));
    await screen.findByTestId('tutorial-hub');
    expect(screen.queryByTestId('capture-field')).toBeNull();

    expect(readTutorialProgress('scout-1')?.data.match.status).toBe(
      'in_progress',
    );
    expect(readTutorialProgress('scout-1')?.data.pit.status).toBe('completed');

    fireEvent.click(screen.getByTestId('tutorial-hub-match'));
    expect(await screen.findByTestId('capture-field')).toBeInTheDocument();
    expect(
      screen.getAllByText(`Match · 1/${MATCH_STEP_COUNT}`).length,
    ).toBeGreaterThan(0);
  });

  it('walks several real controls on the same live match screen in state-machine order', async () => {
    renderTutorial();
    await startMatch();

    expect(await screen.findByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="capture-field"]',
    );

    fireEvent.pointerUp(screen.getByTestId('capture-field'), { pointerId: 1 });
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
        'data-target-selector',
        '[data-testid="capture-placement-submit"]',
      ),
    );
    fireEvent.click(screen.getByTestId('capture-placement-submit'));
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="capture-start"]',
    );
    fireEvent.click(screen.getByTestId('capture-start'));
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="capture-hold"]',
    );
  });

  it('inherits production assignment identity and GO semantics', async () => {
    renderTutorial();
    await startMatch();

    expect(screen.getByTestId('capture-target')).toHaveAccessibleName(
      'Scouting Team 3256, Red alliance station 2. Tap the field where it starts.',
    );
    expect(screen.getByTestId('capture-alliance-station')).toHaveTextContent(
      'RED 2',
    );
    placeRobot();
    fireEvent.click(screen.getByTestId('capture-start'));
    expect(screen.getByTestId('capture-go')).toHaveAttribute(
      'data-auto-ended',
      'false',
    );
    expect(screen.getByTestId('capture-go')).toHaveAccessibleName(
      'GO to Teleop',
    );
  });

  it('keeps the guided Undo pointer on the production action row', () => {
    const undoStep = MATCH_COACH_STEPS.find((step) => step.id === 'undo');
    expect(undoStep?.target).toBe('[data-testid="capture-undo"]');
    expect(undoStep?.action).toBe('undo');
  });

  it('allows optional controls to advance without entering fake values', async () => {
    renderTutorial();
    await startPit();

    expect(screen.queryByTestId('tutorial-next-control')).toBeNull();
    fireEvent.change(screen.getByTestId('pit-drivetrain'), {
      target: { value: 'swerve' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
        'data-target-selector',
        '[data-testid="pit-mechanisms"]',
      ),
    );
    skipOptional();
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="pit-mechanisms-other"]',
    );
    skipOptional();
    expect(screen.queryByTestId('tutorial-next-control')).toBeNull();
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="pit-next"]',
    );
  });

  it('targets each review page and the production rating slider/Clear behavior', async () => {
    renderTutorial();
    await openReview();

    expect(screen.getAllByTestId('review-exit')).toHaveLength(1);
    expect(screen.queryByTestId('tutorial-exit-module-mobile')).toBeNull();
    expect(screen.queryByTestId('tutorial-exit-module-desktop')).toBeNull();
    expect(await screen.findByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="review-climb"]',
    );
    fireEvent.click(screen.getByTestId('review-next'));
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
        'data-target-selector',
        '[data-testid="review-intake-sources"]',
      ),
    );
    for (let i = 0; i < 5; i += 1) skipOptional();
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="review-defense-rating"]',
    );
    fireEvent.change(screen.getByTestId('review-defense-rating'), {
      target: { value: '7' },
    });
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="review-driver-skill"]',
    );
    skipOptional();
    skipOptional();
    expect(screen.getByTestId('tutorial-target-indicator')).toHaveAttribute(
      'data-target-selector',
      '[data-testid="review-defense-rating-clear"]',
    );
    expect(screen.getByTestId('review-defense-rating-clear')).toBeEnabled();
  });

  it('keeps pit photos and both module reports out of production persistence/network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderTutorial();
    await startPit();
    fireEvent.change(screen.getByTestId('pit-drivetrain'), {
      target: { value: 'swerve' },
    });
    for (let page = 0; page < 5; page += 1) {
      fireEvent.click(screen.getByTestId('pit-next'));
    }
    const file = new File(['robot'], 'robot.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('pit-photo'), {
      target: { files: [file] },
    });
    await screen.findByText(/Robot photos \(1\/6\)/i);
    await act(async () => {
      fireEvent.click(screen.getByTestId('pit-submit'));
    });
    await screen.findByTestId('tutorial-hub');

    expect(await pitDb.pitDrafts.count()).toBe(0);
    expect(await pitDb.pitReports.count()).toBe(0);
    expect(await db.drafts.count()).toBe(0);
    expect(await db.reports.count()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readTutorialProgress('scout-1')?.data.pit.status).toBe('completed');
    expect(readTutorialProgress('scout-1')?.data.match.status).toBe(
      'not_started',
    );
    fetchSpy.mockRestore();
  });

  it('completes match and pit independently and returns to the hub', async () => {
    renderTutorial();
    await openReview();
    for (let page = 0; page < 4; page += 1) {
      fireEvent.click(screen.getByTestId('review-next'));
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-save'));
    });
    await screen.findByTestId('tutorial-hub');
    expect(screen.getByText('Match practice complete.')).toBeInTheDocument();
    expect(readTutorialProgress('scout-1')?.data.match.status).toBe('completed');
    expect(readTutorialProgress('scout-1')?.data.pit.status).toBe('not_started');
  });

  it('keeps module progress in the coach without duplicating production navigation', async () => {
    renderTutorial();
    await startMatch();

    const mobile = screen.getByTestId('tutorial-mobile-coach');
    expect(mobile.className).toContain('safe-area-inset');
    expect(mobile.className).not.toContain('+60px');
    expect(screen.getByTestId('tutorial-desktop-coach')).toHaveClass('top-0');
    expect(screen.queryByTestId('tutorial-exit-module-mobile')).toBeNull();
    expect(screen.queryByTestId('tutorial-exit-module-desktop')).toBeNull();
    expect(screen.getAllByTestId('capture-exit')).toHaveLength(1);
    expect(
      screen.getAllByText(`Match · 1/${MATCH_STEP_COUNT}`).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('PRACTICE').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('tutorial-practice-banner')).toBeNull();
  });

  it('uses the real pit Back control as the only module exit', async () => {
    renderTutorial();
    await startPit();

    const back = screen.getByTestId('pit-back');
    expect(back).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
    expect(screen.queryByTestId('tutorial-exit-module-mobile')).toBeNull();
    expect(screen.queryByTestId('tutorial-exit-module-desktop')).toBeNull();

    fireEvent.click(back);
    await screen.findByTestId('tutorial-hub');
    expect(readTutorialProgress('scout-1')?.data.pit.status).toBe('in_progress');
  });

  it('defines the complete production-control coverage map with exact step counts', () => {
    expect(MATCH_STEP_COUNT).toBe(42);
    expect(PIT_STEP_COUNT).toBe(29);

    const matchTargets = MATCH_COACH_STEPS.map((step) => step.target);
    for (const target of [
      '[data-testid="capture-field"]',
      '[data-testid="capture-start"]',
      '[data-testid="capture-hold"]',
      '[data-testid="capture-left-line"]',
      '[data-testid="capture-auto-climb"]',
      '[data-testid="capture-go-interstitial"]',
      '[data-testid="capture-feed"]',
      '[data-testid="capture-defense"]',
      '[data-testid="capture-defended"]',
      '[data-testid="capture-reanchor"]',
      '[data-testid="review-climb"]',
      '[data-testid="review-intake-sources"]',
      '[data-testid="review-defense-rating"]',
      '[data-testid="review-defense-rating-clear"]',
      '[data-testid="review-flags"]',
      '[data-testid="review-field-path"]',
      '[data-testid="review-summary"]',
      '[data-testid="review-notes"]',
      '[data-testid="review-save"]',
    ]) {
      expect(matchTargets).toContain(target);
    }

    const pitTargets = PIT_COACH_STEPS.map((step) => step.target);
    for (const target of [
      '[data-testid="pit-drivetrain"]',
      '[data-testid="pit-mechanisms"]',
      '[data-testid="pit-mechanisms-other"]',
      '[data-testid="pit-capabilities"]',
      '[data-testid="pit-intake-sources"]',
      '[data-testid="pit-match-strategy"]',
      '[data-testid="pit-vision"]',
      '[data-testid="pit-battery-count"]',
      '[data-testid="pit-charger-count"]',
      '[data-testid="pit-length"]',
      '[data-testid="pit-trench"]',
      '[data-testid="pit-auto-pick-start"]',
      '[data-testid="pit-auto-field"]',
      '[data-testid="pit-auto-draw-path"]',
      '[data-testid="pit-auto-clear"]',
      '[data-testid="pit-notes"]',
      '[data-testid="pit-camera-control"]',
      '[data-testid="pit-photo-control"]',
      '[data-testid="pit-submit"]',
    ]) {
      expect(pitTargets).toContain(target);
    }
  });
});
