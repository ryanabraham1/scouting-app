import { useEffect, useState } from 'react';
import {
  Mountain,
  Shield,
  Flag,
  Route,
  ClipboardCheck,
  Check,
  ArrowLeft,
  ArrowRight,
  Save,
  X,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/ui/NumberField';
import { RatingSlider } from '@/components/ui/RatingSlider';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import { FOUL_REASONS } from '@/scoring/fouls';
import {
  useTeamAutoHistory,
  type TeamAutoHistory,
} from '@/capture/useTeamAutoHistory';
import AutoHistoryPicker from '@/capture/AutoHistoryPicker';
import type { useCaptureSession } from '@/capture/useCaptureSession';

const CLIMB_LEVELS: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];
const INTAKE = ['neutral', 'depot', 'human_feed'];

const STEPS = [
  { title: 'Climb', icon: Mountain },
  { title: 'Defense & handling', icon: Shield },
  { title: 'Fouls & flags', icon: Flag },
  { title: 'Auto', icon: Route },
  { title: 'Review & save', icon: ClipboardCheck },
] as const;
const STEP_TITLES = STEPS.map((s) => s.title);
const TOTAL_STEPS = STEPS.length;

export type ReviewObservedAction =
  | 'climb_level'
  | 'climb_attempted'
  | 'climb_success'
  | 'intake_sources'
  | 'defense_seconds'
  | 'defended_seconds'
  | 'pins'
  | 'max_capacity'
  | 'defense_rating'
  | 'driver_rating'
  | 'agility_rating'
  | 'rating_clear'
  | 'fouls_minor'
  | 'fouls_major'
  | 'foul_reason'
  | 'flag'
  | 'auto_path'
  | 'notes'
  | 'next';

/**
 * True when the viewport is in portrait orientation. Drives the Step 4 auto-path
 * field: portrait → render ROTATED 90° (tall + big) so the wide field becomes a
 * large tracing surface instead of a ~150px band; landscape → render normally.
 */
function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(orientation: portrait)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = (): void => setPortrait(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return portrait;
}

export function ReviewScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onSaved: (id: string) => void;
  /**
   * Leave review and return to Scout Home WITHOUT saving. Back/Next only step
   * within review; on an installed PWA (no browser back button) this is the only
   * escape. The draft auto-saves, so exiting is non-destructive and resumable.
   */
  onExit?: () => void;
  /**
   * Set when this Review is correcting a previously-submitted report. Renders an
   * "Editing · rev N -> N+1" banner in place of the plain "Review" heading so the
   * scout knows this resubmits an existing report rather than creating a new one.
   */
  editingRevision?: number;
  /** Optional injected auto history keeps practice/replay fully offline. */
  autoHistory?: TeamAutoHistory;
  /** Read-only observer for coach chrome; does not alter review navigation. */
  onStepChange?: (step: number) => void;
  /** Read-only interaction observer for app-native coaching. */
  onAction?: (action: ReviewObservedAction) => void;
}) {
  const s = props.session;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const step = s.reviewStep;
  const isPortrait = useIsPortrait();

  // Step 4 auto: offer the routines this team has already been scouted running so a
  // scout can reuse one instead of re-tracing it. Only looked up once the auto step
  // is reached (saves a request if the scout exits earlier). `known` mode shows the
  // picker, `draw` keeps the trace-it-yourself field.
  const loadedAutoHistory = useTeamAutoHistory(s.eventKey, s.targetTeamNumber, {
    excludeMatchKey: s.matchKey,
    enabled: step >= 3 && props.autoHistory === undefined,
  });
  const priorAutos = (props.autoHistory ?? loadedAutoHistory).autos;
  const hasPriorAutos = priorAutos.length > 0;
  const [autoMode, setAutoMode] = useState<'known' | 'draw'>('known');
  // Effective mode: with no prior autos there's nothing to pick, so always draw.
  const effectiveAutoMode = hasPriorAutos ? autoMode : 'draw';

  useEffect(() => {
    props.onStepChange?.(step);
  }, [props.onStepChange, step]);

  const agg = computeAggregates({
    schemaVersion: SCHEMA_VERSION,
    inactiveFirst: s.inactiveFirst === null ? false : s.inactiveFirst,
    fuelBursts: s.bursts,
    climbLevel: s.climbLevel,
    autoClimbLevel1: s.autoClimbLevel1,
  });

  const toggleIntake = (src: string) => {
    const has = s.intakeSources.includes(src);
    s.setIntakeSources(has ? s.intakeSources.filter((x) => x !== src) : [...s.intakeSources, src]);
    props.onAction?.('intake_sources');
  };

  const foulReasons = s.foulReasons ?? [];
  const toggleFoulReason = (key: string) => {
    const has = foulReasons.includes(key);
    s.setFoulReasons(has ? foulReasons.filter((x) => x !== key) : [...foulReasons, key]);
    props.onAction?.('foul_reason');
  };

  const onSave = async () => {
    // In-flight guard: a double-tap would call s.save() twice, creating two report
    // rows for the same (match, scout) that then collide on the server's
    // one-active-report-per-match unique index (idx_msr_match_scout_active).
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const id = await s.save();
      props.onSaved(id);
    } catch {
      setSaveError('Could not save this report on this device. Your draft is still available.');
      setSaving(false);
    }
  };

  const isFirst = step === 0;
  const isLast = step === TOTAL_STEPS - 1;
  const goBack = () => s.setReviewStep(Math.max(0, step - 1));
  const goNext = () => {
    props.onAction?.('next');
    s.setReviewStep(Math.min(TOTAL_STEPS - 1, step + 1));
  };

  const StepIcon = STEPS[step].icon;

  const inputClass =
    'h-12 rounded-xl border border-border bg-input px-3 font-mono text-lg tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring landscape:h-14';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-muted-foreground landscape:gap-1.5';

  return (
    <div className="flex h-[100dvh] flex-col gap-2 overflow-hidden bg-background px-safe-tight pt-safe-tight pb-safe-tight text-foreground landscape:gap-3">
      {/* Stepper / progress */}
      <header className="flex shrink-0 flex-col gap-1.5 landscape:gap-2">
        <div className="flex items-center justify-between gap-2">
          {props.editingRevision !== undefined ? (
            <h2
              data-testid="review-editing-banner"
              className="flex flex-col text-xl font-bold leading-tight landscape:text-2xl"
            >
              <span className="flex items-center gap-2">
                <StepIcon className="size-5 text-warning landscape:size-6" />
                Editing
              </span>
              <span className="text-xs font-medium text-warning tabular-nums">
                rev {props.editingRevision} -&gt; {props.editingRevision + 1}
              </span>
            </h2>
          ) : (
            <h2 className="flex items-center gap-2 text-xl font-bold landscape:text-2xl">
              <StepIcon className="size-5 text-brand landscape:size-6" />
              Review
            </h2>
          )}
          <div className="flex items-center gap-2">
            <span data-testid="review-step" className="text-sm tabular-nums text-muted-foreground">
              Step {step + 1} of {TOTAL_STEPS}
            </span>
            {props.onExit && (
              <Button
                data-testid="review-exit"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Exit review"
                onClick={props.onExit}
              >
                <X className="size-5" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-base font-semibold text-brand landscape:text-lg">{STEP_TITLES[step]}</p>
        <div className="flex gap-1.5">
          {STEP_TITLES.map((title, i) => (
            <span
              key={title}
              className={`h-2 flex-1 rounded-full transition-colors ${
                i < step ? 'bg-success' : i === step ? 'bg-brand' : 'bg-border'
              }`}
            />
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto landscape:gap-4">
        {/* Step 1: Climb */}
        {step === 0 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:gap-4">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Mountain className="size-5 text-brand" />
                Climb level
              </p>
              <div data-testid="review-climb" className="grid grid-cols-4 gap-2">
                {CLIMB_LEVELS.map((lvl) => (
                  <Button
                    key={lvl}
                    size="big"
                    variant={s.climbLevel === lvl ? 'default' : 'outline'}
                    aria-pressed={s.climbLevel === lvl}
                    className="px-2 text-2xl tabular-nums landscape:px-6"
                    onClick={() => {
                      s.setClimbLevel(lvl);
                      props.onAction?.('climb_level');
                    }}
                  >
                    {lvl}
                  </Button>
                ))}
              </div>
            </div>
            <div
              data-testid="review-climb-outcome"
              className="rounded-2xl border border-border bg-card p-3 landscape:p-4"
            >
              <p className="mb-2 text-base font-semibold landscape:mb-3">Outcome</p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="big"
                  variant={s.climbAttempted ? 'default' : 'outline'}
                  aria-pressed={s.climbAttempted}
                  className="px-2 landscape:px-6"
                  onClick={() => {
                    s.setClimbAttempted(!s.climbAttempted);
                    props.onAction?.('climb_attempted');
                  }}
                >
                  {s.climbAttempted && <Check />}
                  Attempted
                </Button>
                <Button
                  size="big"
                  variant={s.climbSuccess ? 'default' : 'outline'}
                  aria-pressed={s.climbSuccess}
                  className={`px-2 landscape:px-6 ${s.climbSuccess ? 'bg-success text-success-foreground hover:bg-success' : ''}`}
                  onClick={() => {
                    s.setClimbSuccess(!s.climbSuccess);
                    props.onAction?.('climb_success');
                  }}
                >
                  {s.climbSuccess && <Check />}
                  Success
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* Step 2: Defense & handling */}
        {step === 1 && (
          <section className="flex flex-col gap-3 landscape:gap-4">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Shield className="size-5 text-brand" />
                Intake sources
              </p>
              <div
                data-testid="review-intake-sources"
                className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3"
              >
                {INTAKE.map((src) => {
                  const selected = s.intakeSources.includes(src);
                  // Tone by meaning, echoing the live slider colors: human_feed →
                  // brand (cyan, the FEED slider) / depot · neutral → energy (orange,
                  // the FUEL slider).
                  const activeTone =
                    src === 'human_feed'
                      ? 'bg-brand text-brand-foreground hover:bg-brand'
                      : 'bg-energy text-energy-foreground hover:bg-energy';
                  return (
                    <Button
                      key={src}
                      size="big"
                      variant={selected ? 'default' : 'outline'}
                      aria-pressed={selected}
                      className={`truncate px-2 text-sm landscape:px-6 ${selected ? activeTone : ''}`}
                      onClick={() => toggleIntake(src)}
                    >
                      {selected && <Check />}
                      <span className="truncate">{src}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <div className="grid grid-cols-2 gap-2 landscape:grid-cols-4 landscape:gap-3">
                <label className={labelClass}>
                  Defense played (s)
                  <NumberField
                    data-testid="review-defense-seconds"
                    min={0}
                    step={0.1}
                    value={s.defenseDurationMs / 1000}
                    format={(v) => v.toFixed(1)}
                    onCommit={(v) => {
                      s.setDefenseDurationMs(Math.round(v * 1000));
                      props.onAction?.('defense_seconds');
                    }}
                    className={`${inputClass} ${s.defenseDurationMs > 0 ? 'border-warning bg-warning/10 text-foreground' : ''}`}
                  />
                </label>
                <label className={labelClass}>
                  Being defended (s)
                  <NumberField
                    data-testid="review-defended-seconds"
                    min={0}
                    step={0.1}
                    value={s.defendedDurationMs / 1000}
                    format={(v) => v.toFixed(1)}
                    onCommit={(v) => {
                      s.setDefendedDurationMs(Math.round(v * 1000));
                      props.onAction?.('defended_seconds');
                    }}
                    className={`${inputClass} ${s.defendedDurationMs > 0 ? 'border-destructive bg-destructive/10 text-foreground' : ''}`}
                  />
                </label>
                <label className={labelClass}>
                  Pins
                  <NumberField
                    data-testid="review-pins"
                    min={0}
                    value={s.pins}
                    onCommit={(v) => {
                      s.setPins(v);
                      props.onAction?.('pins');
                    }}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Max capacity
                  <NumberField
                    data-testid="review-max-capacity"
                    min={0}
                    value={s.maxFuelCapacityObserved}
                    onCommit={(v) => {
                      s.setMaxFuelCapacityObserved(v);
                      props.onAction?.('max_capacity');
                    }}
                    className={inputClass}
                  />
                </label>
              </div>
            </div>
            {/* Subjective super-scout ratings (0 = not rated). Advisory only — they
                never feed the scored fuel/climb points, just the dashboard's
                qualitative read of a robot. */}
            <div
              data-testid="review-ratings"
              className="rounded-2xl border border-border bg-card p-3 landscape:p-4"
            >
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Shield className="size-5 text-brand" />
                Ratings
              </p>
              <div className="grid grid-cols-1 gap-3 landscape:grid-cols-3 landscape:gap-4">
                <RatingSlider
                  label="Defense quality"
                  value={s.defenseRating}
                  onChange={(value) => {
                    s.setDefenseRating(value);
                    props.onAction?.(value === 0 ? 'rating_clear' : 'defense_rating');
                  }}
                  testId="review-defense-rating"
                />
                <RatingSlider
                  label="Driver skill"
                  value={s.driverSkill}
                  onChange={(value) => {
                    s.setDriverSkill(value);
                    props.onAction?.(value === 0 ? 'rating_clear' : 'driver_rating');
                  }}
                  testId="review-driver-skill"
                />
                <RatingSlider
                  label="Agility"
                  value={s.agility}
                  onChange={(value) => {
                    s.setAgility(value);
                    props.onAction?.(value === 0 ? 'rating_clear' : 'agility_rating');
                  }}
                  testId="review-agility"
                />
              </div>
            </div>
          </section>
        )}

        {/* Step 3: Fouls & flags */}
        {step === 2 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:gap-4">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Flag className="size-5 text-warning" />
                Fouls
              </p>
              <div className="grid grid-cols-2 gap-2 landscape:gap-3">
                <label className={labelClass}>
                  Fouls minor
                  <NumberField
                    data-testid="review-fouls-minor"
                    min={0}
                    value={s.foulsMinor}
                    onCommit={(v) => {
                      s.setFoulsMinor(v);
                      props.onAction?.('fouls_minor');
                    }}
                    className={`${inputClass} ${s.foulsMinor > 0 ? 'border-warning bg-warning/10 text-foreground' : ''}`}
                  />
                </label>
                <label className={labelClass}>
                  Fouls major
                  <NumberField
                    data-testid="review-fouls-major"
                    min={0}
                    value={s.foulsMajor}
                    onCommit={(v) => {
                      s.setFoulsMajor(v);
                      props.onAction?.('fouls_major');
                    }}
                    className={`${inputClass} ${s.foulsMajor > 0 ? 'border-destructive text-destructive' : ''}`}
                  />
                </label>
              </div>
              {/* What were the fouls for? Advisory tags (the counts above stay the
                  scoring source of truth). Multi-select — a robot can rack up more
                  than one kind in a match. */}
              <div className="mt-3" data-testid="review-foul-reasons">
                <p className="mb-2 text-sm font-medium text-muted-foreground">
                  What for? (optional)
                </p>
                <div className="grid grid-cols-2 gap-2 landscape:grid-cols-3">
                  {FOUL_REASONS.map((reason) => {
                    const selected = foulReasons.includes(reason.key);
                    return (
                      <Button
                        key={reason.key}
                        size="big"
                        variant={selected ? 'default' : 'outline'}
                        title={reason.hint}
                        aria-pressed={selected}
                        data-testid={`review-foul-reason-${reason.key}`}
                        className={`h-auto min-h-12 whitespace-normal px-2 py-2 text-sm leading-tight ${
                          selected ? 'bg-warning text-warning-foreground hover:bg-warning' : ''
                        }`}
                        onClick={() => toggleFoulReason(reason.key)}
                      >
                        {selected && <Check className="shrink-0" />}
                        <span>{reason.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div
              data-testid="review-flags"
              className="rounded-2xl border border-border bg-card p-3 landscape:p-4"
            >
              <p className="mb-2 text-base font-semibold landscape:mb-3">Flags</p>
              <div className="grid grid-cols-2 gap-2 landscape:grid-cols-3">
                {(
                  [
                    // Hard failures → destructive; recoverable mishaps → warning.
                    ['No show', s.noShow, s.setNoShow, 'bg-destructive text-destructive-foreground hover:bg-destructive'],
                    ['Died', s.died, s.setDied, 'bg-destructive text-destructive-foreground hover:bg-destructive'],
                    ['Tipped', s.tipped, s.setTipped, 'bg-warning text-warning-foreground hover:bg-warning'],
                    ['Dropped', s.droppedFuel, s.setDroppedFuel, 'bg-warning text-warning-foreground hover:bg-warning'],
                  ] as [string, boolean, (v: boolean) => void, string][]
                ).map(([label, val, set, activeTone]) => (
                  <Button
                    key={label}
                    size="big"
                    variant={val ? 'default' : 'outline'}
                    aria-pressed={val}
                    className={`text-sm ${val ? activeTone : ''}`}
                    onClick={() => {
                      set(!val);
                      props.onAction?.('flag');
                    }}
                  >
                    {val && <Check />}
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Step 4: Auto. Two ways to record the path: PICK one of the routines the
            team has already been scouted running (re-framed onto this match's
            alliance), or DRAW it by finger. The start position (captured pre-match
            on the placement step) renders as the orange marker on the draw field. */}
        {step === 3 && (
          <section className="flex flex-col gap-3">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-3 flex items-center gap-2 text-base font-semibold">
                <Route className="size-5 text-brand" />
                Auto path
                {effectiveAutoMode === 'draw' && (
                  <span className="text-sm font-normal text-muted-foreground">
                    (start position shown)
                  </span>
                )}
              </p>

              {/* Mode switch — only when the team has prior autos worth reusing. */}
              {hasPriorAutos && (
                <SegmentedToggle<'known' | 'draw'>
                  ariaLabel="Auto path entry mode"
                  className="mb-3"
                  size="default"
                  value={autoMode}
                  onChange={setAutoMode}
                  options={[
                    {
                      value: 'known',
                      label: 'Known autos',
                      icon: <Route />,
                      activeClassName: 'text-brand',
                    },
                    { value: 'draw', label: 'Draw new', icon: <Pencil /> },
                  ]}
                />
              )}

              {effectiveAutoMode === 'known' ? (
                <AutoHistoryPicker
                  autos={priorAutos}
                  alliance={s.allianceColor}
                  selectedPath={s.autoPath}
                  onSelect={({ start, path }) => {
                    // Applying a known routine writes BOTH its start and path (in
                    // this alliance's absolute coords) so the report is a complete,
                    // self-consistent auto — exactly as if it had been traced here.
                    s.setAutoStartPosition(start);
                    s.setAutoPath(path);
                  }}
                  data-testid="review-auto-history"
                />
              ) : (
                /* In portrait the very wide field is rotated 90° (tall + big) so
                   tracing the path with a finger is accurate; landscape gets the
                   full width (capped). */
                <div
                  className={
                    isPortrait
                      ? 'mx-auto flex h-[55dvh] w-full justify-center'
                      : 'mx-auto w-full max-w-[480px] landscape:max-w-[680px]'
                  }
                >
                  <FieldDiagram
                    mode="draw-path"
                    rotate={isPortrait}
                    fillHeight={isPortrait}
                    startPosition={s.autoStartPosition}
                    path={s.autoPath}
                    onPathChange={(pts: FieldPoint[]) => {
                      s.setAutoPath(pts);
                      props.onAction?.('auto_path');
                    }}
                    data-testid="review-field-path"
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {/* Step 5: Review & save */}
        {step === 4 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:items-start landscape:gap-4">
            <div
              data-testid="review-summary"
              className="rounded-2xl border border-border bg-card p-3 text-sm landscape:p-4"
            >
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <ClipboardCheck className="size-5 text-brand" />
                Match summary
              </p>
              <div className="grid grid-cols-2 gap-y-1.5 landscape:gap-y-2">
                <span className="text-muted-foreground">Auto fuel</span>
                <span className="text-right tabular-nums text-energy">{agg.autoFuel}</span>
                <span className="text-muted-foreground">Teleop active</span>
                <span className="text-right tabular-nums text-energy">{agg.teleopFuelActive}</span>
                <span className="text-muted-foreground">Teleop inactive</span>
                <span className="text-right tabular-nums text-energy/70">{agg.teleopFuelInactive}</span>
                <span className="text-muted-foreground">Endgame fuel</span>
                <span className="text-right tabular-nums text-energy">{agg.endgameFuel}</span>
                <span className="text-muted-foreground">By shift</span>
                <span className="text-right tabular-nums">{agg.fuelByShift.join(' / ')}</span>
                <span className="text-base font-semibold">Fuel points</span>
                <span className="text-right text-base font-semibold tabular-nums text-success">
                  {agg.fuelPoints}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 landscape:gap-4">
              <label className="flex flex-col gap-1 text-sm font-medium text-muted-foreground landscape:gap-1.5">
                Notes
                <textarea
                  data-testid="review-notes"
                  value={s.notes}
                  onChange={(e) => {
                    s.setNotes(e.target.value);
                    props.onAction?.('notes');
                  }}
                  className="min-h-[72px] rounded-xl border border-border bg-input p-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring landscape:min-h-[96px]"
                />
              </label>

              <Button
                data-testid="review-save"
                variant="success"
                size="xl"
                className="w-full"
                disabled={saving}
                onClick={() => void onSave()}
              >
                <Save />
                {saving ? 'SAVING…' : 'SAVE'}
              </Button>
              {saveError ? (
                <p role="alert" className="text-sm text-destructive">
                  {saveError}
                </p>
              ) : null}
            </div>
          </section>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex shrink-0 gap-3">
        <Button
          data-testid="review-back"
          size="big"
          variant="outline"
          className="flex-1"
          disabled={isFirst}
          onClick={goBack}
        >
          <ArrowLeft />
          Back
        </Button>
        {!isLast && (
          <Button
            data-testid="review-next"
            size="big"
            className="flex-1"
            onClick={goNext}
          >
            Next
            <ArrowRight />
          </Button>
        )}
      </nav>
    </div>
  );
}
