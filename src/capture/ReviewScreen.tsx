import { useState } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
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

export function ReviewScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onSaved: (id: string) => void;
}) {
  const s = props.session;
  const [step, setStep] = useState(0); // 0-indexed; UI shows step + 1

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
  };

  const onSave = async () => {
    const id = await s.save();
    props.onSaved(id);
  };

  const isFirst = step === 0;
  const isLast = step === TOTAL_STEPS - 1;
  const goBack = () => setStep((v) => Math.max(0, v - 1));
  const goNext = () => setStep((v) => Math.min(TOTAL_STEPS - 1, v + 1));

  const StepIcon = STEPS[step].icon;

  const inputClass =
    'h-12 rounded-xl border border-border bg-input px-3 text-lg tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring landscape:h-14';
  const labelClass = 'flex flex-col gap-1 text-sm font-medium text-muted-foreground landscape:gap-1.5';

  return (
    <div className="flex h-[100dvh] flex-col gap-2 overflow-hidden bg-background p-3 text-foreground landscape:gap-3 landscape:p-3">
      {/* Stepper / progress */}
      <header className="flex shrink-0 flex-col gap-1.5 landscape:gap-2">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-bold landscape:text-2xl">
            <StepIcon className="size-5 text-brand landscape:size-6" />
            Review
          </h2>
          <span data-testid="review-step" className="text-sm tabular-nums text-muted-foreground">
            Step {step + 1} of {TOTAL_STEPS}
          </span>
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
                    className="px-2 text-2xl tabular-nums landscape:px-6"
                    onClick={() => s.setClimbLevel(lvl)}
                  >
                    {lvl}
                  </Button>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 text-base font-semibold landscape:mb-3">Outcome</p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="big"
                  variant={s.climbAttempted ? 'default' : 'outline'}
                  className="px-2 landscape:px-6"
                  onClick={() => s.setClimbAttempted(!s.climbAttempted)}
                >
                  {s.climbAttempted && <Check />}
                  Attempted
                </Button>
                <Button
                  size="big"
                  variant={s.climbSuccess ? 'default' : 'outline'}
                  className="px-2 landscape:px-6"
                  onClick={() => s.setClimbSuccess(!s.climbSuccess)}
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
              <div className="grid grid-cols-3 gap-2">
                {INTAKE.map((src) => (
                  <Button
                    key={src}
                    size="big"
                    variant={s.intakeSources.includes(src) ? 'default' : 'outline'}
                    className="truncate px-2 text-sm landscape:px-6"
                    onClick={() => toggleIntake(src)}
                  >
                    {s.intakeSources.includes(src) && <Check />}
                    <span className="truncate">{src}</span>
                  </Button>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <div className="grid grid-cols-2 gap-2 landscape:grid-cols-4 landscape:gap-3">
                <label className={labelClass}>
                  Defense played (s)
                  <input
                    data-testid="review-defense-seconds"
                    type="number"
                    min={0}
                    step={0.1}
                    value={(s.defenseDurationMs / 1000).toFixed(1)}
                    onChange={(e) =>
                      s.setDefenseDurationMs(Math.max(0, Math.round(Number(e.target.value) * 1000)))
                    }
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Being defended (s)
                  <input
                    data-testid="review-defended-seconds"
                    type="number"
                    min={0}
                    step={0.1}
                    value={(s.defendedDurationMs / 1000).toFixed(1)}
                    onChange={(e) =>
                      s.setDefendedDurationMs(Math.max(0, Math.round(Number(e.target.value) * 1000)))
                    }
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Pins
                  <input
                    type="number"
                    min={0}
                    value={s.pins}
                    onChange={(e) => s.setPins(Number(e.target.value))}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Max capacity
                  <input
                    type="number"
                    min={0}
                    value={s.maxFuelCapacityObserved}
                    onChange={(e) => s.setMaxFuelCapacityObserved(Number(e.target.value))}
                    className={inputClass}
                  />
                </label>
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
                  <input
                    type="number"
                    min={0}
                    value={s.foulsMinor}
                    onChange={(e) => s.setFoulsMinor(Number(e.target.value))}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Fouls major
                  <input
                    type="number"
                    min={0}
                    value={s.foulsMajor}
                    onChange={(e) => s.setFoulsMajor(Number(e.target.value))}
                    className={inputClass}
                  />
                </label>
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 text-base font-semibold landscape:mb-3">Flags</p>
              <div className="grid grid-cols-2 gap-2 landscape:grid-cols-3">
                {(
                  [
                    ['No show', s.noShow, s.setNoShow],
                    ['Died', s.died, s.setDied],
                    ['Tipped', s.tipped, s.setTipped],
                    ['Dropped', s.droppedFuel, s.setDroppedFuel],
                  ] as [string, boolean, (v: boolean) => void][]
                ).map(([label, val, set]) => (
                  <Button
                    key={label}
                    size="big"
                    variant={val ? 'default' : 'outline'}
                    className="text-sm"
                    onClick={() => set(!val)}
                  >
                    {val && <Check />}
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Step 4: Auto — start position is captured pre-match on the placement
            step, so it is shown read-only here for reference. Only the auto path
            is editable. */}
        {step === 3 && (
          <section className="flex flex-col gap-3 landscape:grid landscape:grid-cols-2 landscape:gap-4">
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 flex items-center gap-2 text-base font-semibold">
                <Route className="size-5 text-brand" />
                Start position
                <span className="text-sm font-normal text-muted-foreground">(from placement)</span>
              </p>
              {/* Field image is ~2.46:1 wide. In portrait, cap the wrapper width
                  so two stacked diagrams + nav + header fit one viewport; in
                  landscape let it fill its grid column. */}
              <div className="mx-auto w-full max-w-[320px] landscape:max-w-none">
                <FieldDiagram
                  mode="view"
                  startPosition={s.autoStartPosition}
                  data-testid="review-field-start-view"
                />
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-3 landscape:p-4">
              <p className="mb-2 text-base font-semibold">Auto path</p>
              <div className="mx-auto w-full max-w-[320px] landscape:max-w-none">
                <FieldDiagram
                  mode="draw-path"
                  startPosition={s.autoStartPosition}
                  path={s.autoPath}
                  onPathChange={(pts: FieldPoint[]) => s.setAutoPath(pts)}
                  data-testid="review-field-path"
                />
              </div>
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
                <span className="text-right tabular-nums">{agg.autoFuel}</span>
                <span className="text-muted-foreground">Teleop active</span>
                <span className="text-right tabular-nums">{agg.teleopFuelActive}</span>
                <span className="text-muted-foreground">Teleop inactive</span>
                <span className="text-right tabular-nums">{agg.teleopFuelInactive}</span>
                <span className="text-muted-foreground">Endgame fuel</span>
                <span className="text-right tabular-nums">{agg.endgameFuel}</span>
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
                  value={s.notes}
                  onChange={(e) => s.setNotes(e.target.value)}
                  className="min-h-[72px] rounded-xl border border-border bg-input p-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring landscape:min-h-[96px]"
                />
              </label>

              <Button
                data-testid="review-save"
                size="xl"
                className="w-full"
                onClick={() => void onSave()}
              >
                <Save />
                SAVE
              </Button>
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
