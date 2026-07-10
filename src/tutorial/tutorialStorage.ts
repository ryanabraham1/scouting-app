export const SCOUT_TUTORIAL_VERSION = 4;
const STORAGE_PREFIX = 'frc-scout-tutorial';

export type TutorialStatus = 'in_progress' | 'completed';
export type TutorialModule = 'hub' | 'match' | 'pit';
export type TutorialModuleStatus = 'not_started' | 'in_progress' | 'completed';

export interface TutorialModuleProgress {
  status: TutorialModuleStatus;
  step: number;
}

export interface TutorialPracticeData {
  module: TutorialModule;
  match: TutorialModuleProgress;
  pit: TutorialModuleProgress;
}

export interface TutorialProgress {
  version: number;
  status: TutorialStatus;
  step: number;
  updatedAt: string;
  data: TutorialPracticeData;
}

export const EMPTY_TUTORIAL_DATA: TutorialPracticeData = {
  module: 'hub',
  match: { status: 'not_started', step: 0 },
  pit: { status: 'not_started', step: 0 },
};

function safeSubject(subject?: string | null): string {
  const value = subject?.trim();
  return value ? `scout:${encodeURIComponent(value)}` : 'device';
}

export function tutorialStorageKey(subject?: string | null): string {
  return `${STORAGE_PREFIX}:v${SCOUT_TUTORIAL_VERSION}:${safeSubject(subject)}`;
}

function isPracticeData(value: unknown): value is TutorialPracticeData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<TutorialPracticeData>;
  const isModuleProgress = (progress: unknown): progress is TutorialModuleProgress => {
    if (!progress || typeof progress !== 'object') return false;
    const candidate = progress as Partial<TutorialModuleProgress>;
    return (
      (candidate.status === 'not_started' ||
        candidate.status === 'in_progress' ||
        candidate.status === 'completed') &&
      Number.isInteger(candidate.step) &&
      Number(candidate.step) >= 0
    );
  };
  return (
    (data.module === 'hub' || data.module === 'match' || data.module === 'pit') &&
    isModuleProgress(data.match) &&
    isModuleProgress(data.pit)
  );
}

function isProgress(value: unknown): value is TutorialProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<TutorialProgress>;
  return (
    progress.version === SCOUT_TUTORIAL_VERSION &&
    (progress.status === 'in_progress' || progress.status === 'completed') &&
    Number.isInteger(progress.step) &&
    Number(progress.step) >= 0 &&
    typeof progress.updatedAt === 'string' &&
    isPracticeData(progress.data)
  );
}

export function readTutorialProgress(subject?: string | null): TutorialProgress | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(tutorialStorageKey(subject));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isProgress(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTutorialProgress(
  subject: string | null | undefined,
  progress: Omit<TutorialProgress, 'version' | 'updatedAt'>,
): TutorialProgress {
  const stored: TutorialProgress = {
    ...progress,
    version: SCOUT_TUTORIAL_VERSION,
    updatedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(tutorialStorageKey(subject), JSON.stringify(stored));
  } catch {
    // Practice remains usable when storage is unavailable (private mode, quota).
  }
  return stored;
}

export function completeTutorial(
  subject: string | null | undefined,
  step: number,
  data: TutorialPracticeData,
): TutorialProgress {
  return writeTutorialProgress(subject, { status: 'completed', step, data });
}
