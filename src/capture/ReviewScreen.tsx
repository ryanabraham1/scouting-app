import { useEffect, useRef, useState } from 'react';
import {
  Shield,
  Flag,
  Route,
  ClipboardCheck,
  Check,
  ArrowLeft,
  ArrowRight,
  Save,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/ui/NumberField';
import { RatingSlider } from '@/components/ui/RatingSlider';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import { FUEL_GROUP_WINDOWS, groupFuelMax, type FuelGroup } from '@/capture/fuelCorrection';
import { FOUL_REASONS } from '@/scoring/fouls';
import type { TeamAutoHistory } from '@/capture/useTeamAutoHistory';
import { AutoPathPanel } from '@/capture/AutoPathPanel';
import type { useCaptureSession } from '@/capture/useCaptureSession';

const STEPS = [
  { title: 'Robot performance', icon: Shield },
  { title: 'Auto', icon: Route },
  { title: 'Review & save', icon: ClipboardCheck },
] as const;
const STEP_TITLES = STEPS.map((s) => s.title);
const TOTAL_STEPS = STEPS.length;

export type ReviewObservedAction =
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
  | 'fuel'
  | 'next';

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
  // Retain the persisted five-page indices so existing drafts stay compatible.
  const step = s.reviewStep <= 2 ? 0 : s.reviewStep === 3 ? 1 : 2;
  const storedSteps = [0, 3, 4] as const;
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [step]);
  const unrated = [
    s.defenseRating === 0 ? 'Defense quality' : null,
    s.driverSkill === 0 ? 'Driver skill' : null,
    s.agility === 0 ? 'Agility' : null,
  ].filter(Boolean);

  useEffect(() => {
    props.onStepChange?.(step);
  }, [props.onStepChange, step]);

  const agg = computeAggregates({
    schemaVersion: SCHEMA_VERSION,
    inactiveFirst: s.inactiveFirst === null ? false : s.inactiveFirst,
    fuelBursts: s.bursts,
    noShow: s.noShow,
  });

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
  const goBack = () => s.setReviewStep(storedSteps[Math.max(0, step - 1)]);
  const goNext = () => {
    props.onAction?.('next');
    s.setReviewStep(storedSteps[Math.min(TOTAL_STEPS - 1, step + 1)]);
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
        <p className="text-sm text-muted-foreground">Team {s.targetTeamNumber}</p>
        <p className="text-base font-semibold text-brand landscape:text-lg md:hidden">{STEP_TITLES[step]}</p>
      </header>

      {/* Tablets and up: the sections become a step rail beside the content. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 landscape:gap-3 md:flex-row md:gap-5">
        <nav aria-label="Review sections" className="grid shrink-0 grid-cols-3 gap-1.5 md:flex md:w-52 md:flex-col md:gap-1">
          {STEP_TITLES.map((title, i) => (
            <button type="button" key={title} data-testid={`review-jump-${i}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => s.setReviewStep(storedSteps[i])}
              className={`min-h-11 rounded-lg border px-2 py-1 text-xs font-semibold md:flex md:items-center md:gap-2.5 md:px-3 md:text-left md:text-sm ${i === step ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:bg-accent md:border-transparent'}`}
            >
              <span
                aria-hidden="true"
                className={`hidden size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs md:inline-flex ${i < step ? 'bg-success/15 text-success' : i === step ? 'bg-brand text-brand-foreground' : 'border border-border'}`}
              >
                {i < step ? <Check className="size-3.5" /> : i + 1}
              </span>
              {title}
            </button>
          ))}
        </nav>

      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto landscape:gap-4">
        {/* Step 1: Ratings */}
        {step === 0 && (
          <section className="flex flex-col gap-3 landscape:gap-4">
            <div
              data-testid="review-ratings"
              className="rounded-2xl border border-border bg-card p-3 landscape:p-4"
            >
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Shield className="size-5 text-brand" />
                Ratings
              </p>
              <p className="mb-3 text-sm text-muted-foreground">Only rate what you saw. Didn’t see / unsure leaves the rating unrecorded; it is not a zero performance score.</p>
              <div className="grid grid-cols-1 gap-3 landscape:grid-cols-3 landscape:gap-4">
                <RatingSlider
                  label="Defense quality"
                  unsureLabel="Didn’t see / unsure"
                  value={s.defenseRating}
                  onChange={(value) => {
                    s.setDefenseRating(value);
                    props.onAction?.(value === 0 ? 'rating_clear' : 'defense_rating');
                  }}
                  testId="review-defense-rating"
                />
                <RatingSlider
                  label="Driver skill"
                  unsureLabel="Didn’t see / unsure"
                  value={s.driverSkill}
                  onChange={(value) => {
                    s.setDriverSkill(value);
                    props.onAction?.(value === 0 ? 'rating_clear' : 'driver_rating');
                  }}
                  testId="review-driver-skill"
                />
                <RatingSlider
                  label="Agility"
                  unsureLabel="Didn’t see / unsure"
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

        {step === 2 && (
          <section aria-label="Review checks" className="rounded-xl border border-border bg-card p-3 text-sm">
            <p className="font-semibold">Check before saving</p>
            <p className="mt-1 text-muted-foreground">Unrecorded items are optional. Leave them unsure rather than guessing.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" className="min-h-11 h-auto whitespace-normal text-left" onClick={() => s.setReviewStep(0)}>
                {unrated.length ? `Unrated: ${unrated.join(', ')}` : 'Ratings recorded · Edit'}
              </Button>
              <Button variant="outline" className="min-h-11" onClick={() => s.setReviewStep(3)}>
                {s.autoPath === null ? 'Auto path unrecorded · Review' : s.autoPath.length === 0 ? 'Auto: no movement · Edit' : 'Auto path recorded · Edit'}
              </Button>
            </div>
          </section>
        )}

        {/* Step 3: Fouls & flags */}
        {step === 2 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:gap-4">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <Flag className="size-5 text-warning" />
                Fouls &amp; reasons
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

        {/* Step 4: Auto. Normally already drawn live the moment Auto ended;
            this step lets the scout check or fix it before saving. */}
        {step === 1 && (
          <section className="flex flex-col gap-3">
            <AutoPathPanel
              session={s}
              autoHistory={props.autoHistory}
              onAction={() => props.onAction?.('auto_path')}
              testIdPrefix="review"
            />
          </section>
        )}

        {/* Step 5: Review & save */}
        {step === 2 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:items-start landscape:gap-4">
            <div
              data-testid="review-summary"
              className="rounded-2xl border border-border bg-card p-3 text-sm landscape:p-4"
            >
              <p className="mb-2 flex items-center gap-2 text-base font-semibold landscape:mb-3">
                <ClipboardCheck className="size-5 text-brand" />
                Match summary
              </p>
              {/* The three phase totals are EDITABLE: a scout who missed or
                  over-counted a burst corrects the number here (before OR after
                  submitting), and the session re-fits the recorded bursts so
                  the timeline, aggregates and server recompute all agree. */}
              <div className="grid grid-cols-2 items-center gap-y-1.5 landscape:gap-y-2">
                {(
                  [
                    ['auto', 'Auto fuel', agg.autoFuel],
                    ['teleop', 'Teleop fuel', agg.teleopFuelActive + agg.teleopFuelInactive],
                    ['endgame', 'Endgame fuel', agg.endgameFuel],
                  ] as const
                ).map(([group, label, value]) => (
                  <label key={group} className="contents">
                    <span className="text-muted-foreground">{label}</span>
                    <NumberField
                      data-testid={`review-fuel-${group}`}
                      min={0}
                      max={groupFuelMax(FUEL_GROUP_WINDOWS[group as FuelGroup])}
                      step={1}
                      inputMode="numeric"
                      value={value}
                      disabled={s.noShow}
                      onCommit={(v) => {
                        s.setGroupFuel(group as FuelGroup, v);
                        props.onAction?.('fuel');
                      }}
                      className="ml-auto w-24 rounded-lg border border-border bg-input px-2 py-1 text-right text-base tabular-nums text-energy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </label>
                ))}
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
      </div>

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
        {isLast && (              <Button
                data-testid="review-save"
                variant="success"
                size="xl"
                className="min-w-0 flex-1 px-3"
                disabled={saving}
                onClick={() => void onSave()}
              >
                <Save />
                {saving ? 'Saving…' : 'Save report'}
              </Button>
)}
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
