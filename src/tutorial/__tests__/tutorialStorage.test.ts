import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completeTutorial,
  EMPTY_TUTORIAL_DATA,
  readTutorialProgress,
  SCOUT_TUTORIAL_VERSION,
  tutorialStorageKey,
  writeTutorialProgress,
} from '../tutorialStorage';
import { installMemoryStorage } from './memoryStorage';

describe('tutorialStorage', () => {
  beforeAll(installMemoryStorage);

  beforeEach(() => {
    localStorage.clear();
  });

  it('versions progress and scopes it by scout with a device fallback', () => {
    expect(tutorialStorageKey('scout 1')).toContain(
      `v${SCOUT_TUTORIAL_VERSION}:scout:scout%201`,
    );
    expect(tutorialStorageKey()).toContain(`v${SCOUT_TUTORIAL_VERSION}:device`);

    writeTutorialProgress('scout-1', {
      status: 'in_progress',
      step: 3,
      data: { ...EMPTY_TUTORIAL_DATA, module: 'pit' },
    });
    expect(readTutorialProgress('scout-1')?.step).toBe(3);
    expect(readTutorialProgress('scout-1')?.data.module).toBe('pit');
    expect(readTutorialProgress('scout-1')?.data.match.status).toBe(
      'not_started',
    );
    expect(readTutorialProgress('scout-1')?.data.pit.status).toBe(
      'not_started',
    );
    expect(readTutorialProgress('scout-2')).toBeNull();
  });

  it('treats malformed and obsolete payloads as a fresh tutorial', () => {
    localStorage.setItem(tutorialStorageKey('scout-1'), '{not json');
    expect(readTutorialProgress('scout-1')).toBeNull();

    localStorage.setItem(
      tutorialStorageKey('scout-1'),
      JSON.stringify({
        version: SCOUT_TUTORIAL_VERSION - 1,
        status: 'completed',
        step: 99,
        updatedAt: new Date().toISOString(),
        data: EMPTY_TUTORIAL_DATA,
      }),
    );
    expect(readTutorialProgress('scout-1')).toBeNull();
  });

  it('persists separate match and pit completion', () => {
    const completed = completeTutorial('scout-2', 71, {
      ...EMPTY_TUTORIAL_DATA,
      module: 'hub',
      match: { status: 'completed', step: 42 },
      pit: { status: 'completed', step: 29 },
    });
    expect(completed.status).toBe('completed');
    expect(readTutorialProgress('scout-2')?.status).toBe('completed');
    expect(readTutorialProgress('scout-2')?.data.match.step).toBe(42);
    expect(readTutorialProgress('scout-2')?.data.pit.step).toBe(29);
  });
});
