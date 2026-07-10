import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  CheckCircle2,
  CloudOff,
  GraduationCap,
  Play,
  QrCode,
  RotateCcw,
  Wrench,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import CaptureFlow from '@/capture/CaptureFlow';
import type { CaptureObservedAction } from '@/capture/CaptureScreen';
import type { ReviewObservedAction } from '@/capture/ReviewScreen';
import type { CaptureTarget } from '@/capture/useCaptureSession';
import type { TeamAutoHistory } from '@/capture/useTeamAutoHistory';
import PitScoutScreen, {
  type PitObservedAction,
} from '@/pit/PitScoutScreen';
import {
  MATCH_COACH_STEPS,
  MATCH_STEP_COUNT,
  PIT_COACH_STEPS,
  PIT_STEP_COUNT,
  type MatchCoachStep,
  type PitCoachStep,
} from './curriculum';
import {
  EMPTY_TUTORIAL_DATA,
  SCOUT_TUTORIAL_VERSION,
  readTutorialProgress,
  writeTutorialProgress,
  type TutorialModule,
  type TutorialModuleProgress,
  type TutorialPracticeData,
  type TutorialProgress,
} from './tutorialStorage';
import { createPracticeAdapters } from './practiceAdapters';
import {
  CoachTargetIndicator,
  useCoachTarget,
} from './CoachTargetIndicator';

const PRACTICE_TARGET: CaptureTarget = {
  eventKey: 'practice-2026',
  matchKey: 'practice_qm12',
  scoutId: 'practice-scout',
  scoutName: 'Practice Scout',
  targetTeamNumber: 3256,
  allianceColor: 'red',
  station: 2,
};

const EMPTY_AUTO_HISTORY: TeamAutoHistory = { autos: [], loading: false };

function initialProgress(subject: string | null): TutorialProgress {
  return (
    readTutorialProgress(subject) ?? {
      version: SCOUT_TUTORIAL_VERSION,
      status: 'in_progress',
      step: 0,
      updatedAt: new Date(0).toISOString(),
      data: { ...EMPTY_TUTORIAL_DATA },
    }
  );
}

function moduleLabel(progress: TutorialModuleProgress): string {
  if (progress.status === 'completed') return 'Completed';
  if (progress.status === 'in_progress') return 'In progress';
  return 'Not started';
}

function TutorialHub(props: {
  progress: TutorialProgress;
  completedModule: 'match' | 'pit' | null;
  exitHref: string;
  onStart: (module: 'match' | 'pit', startOver: boolean) => void;
}): JSX.Element {
  const modules = [
    {
      id: 'match' as const,
      title: 'Practice match scouting',
      detail:
        'Use the real match controls for Practice Match 12, Team 3256, red station 2.',
      icon: GraduationCap,
      steps: MATCH_STEP_COUNT,
      tone: 'border-energy/40 bg-energy/5 text-energy',
    },
    {
      id: 'pit' as const,
      title: 'Practice pit scouting',
      detail:
        'Use the real pit form for Team 3256, including preferred Auto and photos.',
      icon: Wrench,
      steps: PIT_STEP_COUNT,
      tone: 'border-brand/40 bg-brand/5 text-brand',
    },
  ];

  return (
    <main
      data-testid="tutorial-hub"
      className="min-h-dvh bg-background px-safe py-safe text-foreground"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow text-warning">Scouter tutorial</p>
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
              Choose what to practice
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
              Pick one module now. You can return here and practice the other one
              at any time.
            </p>
          </div>
          <Button asChild variant="outline" size="icon" className="size-11 shrink-0">
            <Link to={props.exitHref} aria-label="Exit tutorial">
              <X className="size-5" />
            </Link>
          </Button>
        </header>

        {props.completedModule ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-xl border border-success/35 bg-success/10 p-3 text-sm font-medium text-success"
          >
            <CheckCircle2 className="size-5" />
            {props.completedModule === 'match'
              ? 'Match practice complete.'
              : 'Pit practice complete.'}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {modules.map((module) => {
            const saved = props.progress.data[module.id];
            const Icon = module.icon;
            const primaryLabel =
              saved.status === 'in_progress'
                ? 'Restart practice'
                : saved.status === 'completed'
                  ? 'Practice again'
                  : module.title;
            return (
              <section
                key={module.id}
                data-testid={`tutorial-hub-${module.id}-card`}
                className={`min-w-0 flex flex-col rounded-2xl border p-5 ${module.tone}`}
              >
                <Icon className="size-8" aria-hidden />
                <div className="mt-3 flex items-center justify-between gap-2">
                  <h2 className="text-xl font-semibold text-foreground">
                    {module.title}
                  </h2>
                  <span className="shrink-0 rounded-full border border-current/30 px-2 py-1 text-xs font-medium">
                    {moduleLabel(saved)}
                  </span>
                </div>
                <p className="mt-2 flex-1 text-sm text-muted-foreground">
                  {module.detail}
                </p>
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {module.steps} guided controls
                </p>
                <Button
                  data-testid={`tutorial-hub-${module.id}`}
                  variant={module.id === 'match' ? 'brand' : 'default'}
                  size="big"
                  className="mt-4 w-full"
                  onClick={() =>
                    props.onStart(module.id, saved.status !== 'not_started')
                  }
                >
                  {saved.status === 'completed' ? <RotateCcw /> : <Play />}
                  {primaryLabel}
                </Button>
              </section>
            );
          })}
        </div>

        <details className="rounded-2xl border border-border bg-card p-4">
          <summary className="cursor-pointer font-semibold">Quick offline help</summary>
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
            <p className="flex gap-2 text-muted-foreground">
              <CloudOff className="size-5 shrink-0 text-brand" />
              Preload before the event so schedules and assignments work without
              Wi-Fi.
            </p>
            <p className="flex gap-2 text-muted-foreground">
              <QrCode className="size-5 shrink-0 text-energy" />
              Send reports by showing QR codes; Receive scans them on another
              device.
            </p>
            <p className="flex gap-2 text-muted-foreground">
              <BarChart3 className="size-5 shrink-0 text-success" />
              My Data shows reports saved on this device and reports waiting to
              send.
            </p>
          </div>
        </details>
      </div>
    </main>
  );
}

function CoachCard(props: {
  progress: string;
  task: string;
  detail: string;
  optional: boolean;
  onNextControl?: () => void;
}): JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-md border border-warning/50 bg-warning/10 px-1.5 py-1 font-mono text-[10px] font-bold tracking-[0.12em] text-warning">
            PRACTICE
          </span>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {props.progress}
          </p>
        </div>
        {props.optional ? (
          <span className="rounded-full border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground">
            Optional
          </span>
        ) : null}
      </div>
      <h2 className="mt-1 text-lg font-bold leading-snug">{props.task}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {props.detail}
      </p>
      {props.onNextControl ? (
        <Button
          data-testid="tutorial-next-control"
          variant="outline"
          size="sm"
          className="mt-3 min-h-11 w-full"
          onClick={props.onNextControl}
        >
          Next control
        </Button>
      ) : null}
    </>
  );
}

function PracticeFrame(props: {
  progress: string;
  task: string;
  detail: string;
  optional: boolean;
  stepKey: string;
  target: string;
  content: ReactNode;
  onNextControl?: () => void;
}): JSX.Element {
  const coachTarget = useCoachTarget(props.target, props.stepKey);
  const mobileCoachRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (mobileCoachRef.current) mobileCoachRef.current.open = false;
  }, [props.stepKey]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {props.progress}: {props.task}
      </p>
      <div
        data-testid="tutorial-mobile-coach"
        data-placement={coachTarget.mobilePlacement}
        className={`pointer-events-none fixed inset-x-2 z-40 mx-auto flex w-[calc(100vw-1rem)] max-w-md items-start gap-2 lg:hidden ${
          coachTarget.mobilePlacement === 'top'
            ? 'top-[calc(env(safe-area-inset-top)+8px)]'
            : 'bottom-[calc(env(safe-area-inset-bottom)+8px)]'
        }`}
      >
        <details
          ref={mobileCoachRef}
          className="pointer-events-auto group max-h-[48dvh] min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-2xl border border-warning/50 bg-card/95 shadow-2xl backdrop-blur"
        >
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-warning">
            <span className="rounded-md border border-warning/50 bg-warning/10 px-1.5 py-1 font-mono text-[9px] font-bold tracking-[0.08em]">
              PRACTICE
            </span>
            <span className="min-w-0 flex-1 truncate">{props.task}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {props.progress}
            </span>
          </summary>
          <div className="border-t border-border px-3 py-3">
            <CoachCard
              progress={props.progress}
              task={props.task}
              detail={props.detail}
              optional={props.optional}
              onNextControl={props.onNextControl}
            />
          </div>
        </details>
      </div>

      <div
        data-testid="tutorial-coach-layout"
        className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      >
        <div className="min-w-0 overflow-x-clip">{props.content}</div>
        <aside
          data-testid="tutorial-desktop-coach"
          className="sticky top-0 hidden max-h-dvh overflow-y-auto border-l border-warning/35 bg-card p-5 lg:block"
          aria-label="Tutorial coach"
        >
          <CoachCard
            progress={props.progress}
            task={props.task}
            detail={props.detail}
            optional={props.optional}
            onNextControl={props.onNextControl}
          />
        </aside>
      </div>

      <CoachTargetIndicator
        box={coachTarget.box}
        targetSelector={props.target}
      />
    </div>
  );
}

function nextPageStep<T extends { page: number }>(
  steps: readonly T[],
  page: number,
): number {
  const index = steps.findIndex((step) => step.page === page);
  return index < 0 ? 0 : index;
}

export default function ScoutTutorial(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const scoutId = searchParams.get('scout');
  const exitHref = scoutId ? '/scout' : '/';
  const [progress, setProgress] = useState<TutorialProgress>(() =>
    initialProgress(scoutId),
  );
  const [screen, setScreen] = useState<TutorialModule>('hub');
  const [completedModule, setCompletedModule] = useState<'match' | 'pit' | null>(
    null,
  );
  const [matchRunKey, setMatchRunKey] = useState(0);
  const [pitRunKey, setPitRunKey] = useState(0);
  const [matchStep, setMatchStep] = useState(0);
  const [pitCoachStep, setPitCoachStep] = useState(0);
  const [reviewPage, setReviewPage] = useState(0);
  const [pitPage, setPitPage] = useState(0);
  const matchAdapters = useMemo(() => createPracticeAdapters(), [matchRunKey]);
  const pitAdapters = useMemo(() => createPracticeAdapters(), [pitRunKey]);

  const persistModule = useCallback(
    (
      module: 'match' | 'pit',
      moduleStatus: TutorialModuleProgress['status'],
      step: number,
    ): void => {
      setProgress((current) => {
        const data: TutorialPracticeData = {
          ...current.data,
          module: screen,
          [module]: { status: moduleStatus, step },
        };
        const status =
          data.match.status === 'completed' && data.pit.status === 'completed'
            ? 'completed'
            : 'in_progress';
        return writeTutorialProgress(scoutId, { status, step, data });
      });
    },
    [scoutId, screen],
  );

  useEffect(() => {
    if (screen === 'match') persistModule('match', 'in_progress', matchStep);
  }, [matchStep, persistModule, screen]);

  useEffect(() => {
    if (screen === 'pit') persistModule('pit', 'in_progress', pitCoachStep);
  }, [persistModule, pitCoachStep, screen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (screen === 'hub') navigate(exitHref);
      else setScreen('hub');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitHref, navigate, screen]);

  const startModule = (
    module: 'match' | 'pit',
    _startOver: boolean,
  ): void => {
    setCompletedModule(null);
    if (module === 'match') {
      setMatchRunKey((value) => value + 1);
      setMatchStep(0);
      setReviewPage(0);
    } else {
      setPitRunKey((value) => value + 1);
      setPitCoachStep(0);
      setPitPage(0);
    }
    setScreen(module);
  };

  const finishModule = (module: 'match' | 'pit'): void => {
    const count = module === 'match' ? MATCH_STEP_COUNT : PIT_STEP_COUNT;
    persistModule(module, 'completed', count);
    setCompletedModule(module);
    setScreen('hub');
  };

  const currentMatchStep: MatchCoachStep =
    MATCH_COACH_STEPS[Math.min(matchStep, MATCH_STEP_COUNT - 1)];
  const currentPitStep: PitCoachStep =
    PIT_COACH_STEPS[Math.min(pitCoachStep, PIT_STEP_COUNT - 1)];

  const advanceMatch = (): void =>
    setMatchStep((value) => Math.min(MATCH_STEP_COUNT - 1, value + 1));
  const advancePit = (): void =>
    setPitCoachStep((value) => Math.min(PIT_STEP_COUNT - 1, value + 1));

  const observeCapture = (action: CaptureObservedAction): void => {
    if (action === 'to_review') {
      const firstReview = MATCH_COACH_STEPS.findIndex(
        (step) => step.screen === 'review' && step.page === 0,
      );
      if (firstReview >= 0) setMatchStep(firstReview);
      return;
    }
    if (
      currentMatchStep.screen === 'live' &&
      currentMatchStep.action === action
    ) {
      advanceMatch();
    }
  };

  const observeReview = (action: ReviewObservedAction): void => {
    if (
      currentMatchStep.screen === 'review' &&
      currentMatchStep.action === action
    ) {
      advanceMatch();
    }
  };

  const handleReviewPage = (page: number): void => {
    setReviewPage(page);
    const current = MATCH_COACH_STEPS[matchStep];
    if (current?.screen === 'review' && current.page === page) return;
    const index = MATCH_COACH_STEPS.findIndex(
      (step) => step.screen === 'review' && step.page === page,
    );
    if (index >= 0) setMatchStep(index);
  };

  const observePit = (action: PitObservedAction): void => {
    if (currentPitStep.action === action) advancePit();
  };

  const handlePitPage = (page: number): void => {
    setPitPage(page);
    if (PIT_COACH_STEPS[pitCoachStep]?.page === page) return;
    setPitCoachStep(nextPageStep(PIT_COACH_STEPS, page));
  };

  return (
    <>
      {screen === 'hub' ? (
        <TutorialHub
          progress={progress}
          completedModule={completedModule}
          exitHref={exitHref}
          onStart={startModule}
        />
      ) : null}

      {screen === 'match' ? (
        <div>
          <CaptureFlow
            key={`match-${matchRunKey}`}
            target={PRACTICE_TARGET}
            storage={matchAdapters.capture}
            autoHistory={EMPTY_AUTO_HISTORY}
            onAction={observeCapture}
            onReviewAction={observeReview}
            onReviewStepChange={handleReviewPage}
            onExit={() => setScreen('hub')}
            onDone={() => finishModule('match')}
            renderFrame={(frame) => {
              const step = currentMatchStep;
              const visible =
                screen === 'match' &&
                ((step.screen === 'live' && frame.stage === 'live') ||
                (step.screen === 'review' &&
                  frame.stage === 'review' &&
                  step.page === reviewPage));
              return (
                <PracticeFrame
                  progress={`Match · ${matchStep + 1}/${MATCH_STEP_COUNT}`}
                  task={step.task}
                  detail={step.detail}
                  optional={step.optional}
                  stepKey={`match:${step.id}`}
                  target={visible ? step.target : '[data-tutorial-missing]'}
                  content={frame.content}
                  onNextControl={step.optional ? advanceMatch : undefined}
                />
              );
            }}
          />
        </div>
      ) : null}

      {screen === 'pit' ? (
        <div>
          <PracticeFrame
            progress={`Pit · ${pitCoachStep + 1}/${PIT_STEP_COUNT}`}
            task={currentPitStep.task}
            detail={currentPitStep.detail}
            optional={currentPitStep.optional}
            stepKey={`pit:${currentPitStep.id}`}
            target={
              screen === 'pit' && currentPitStep.page === pitPage
                ? currentPitStep.target
                : '[data-tutorial-missing]'
            }
            onNextControl={currentPitStep.optional ? advancePit : undefined}
            content={
              <PitScoutScreen
                key={`pit-${pitRunKey}`}
                eventKey={PRACTICE_TARGET.eventKey}
                teamNumber={PRACTICE_TARGET.targetTeamNumber}
                scoutId={PRACTICE_TARGET.scoutId}
                adapter={pitAdapters.pit}
                onAction={observePit}
                onStepChange={handlePitPage}
                onExit={() => setScreen('hub')}
                onDone={() => finishModule('pit')}
              />
            }
          />
        </div>
      ) : null}
    </>
  );
}
