import { Button } from '@/components/ui/button';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import type { useCaptureSession } from '@/capture/useCaptureSession';

const CLIMB_LEVELS: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];
const INTAKE = ['neutral', 'depot', 'human_feed'];

export function ReviewScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onSaved: (id: string) => void;
}) {
  const s = props.session;
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

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <h2 className="text-xl font-semibold">Review</h2>

      <section
        data-testid="review-summary"
        className="rounded-lg border border-border p-3 text-sm"
      >
        <div className="grid grid-cols-2 gap-1">
          <span>Auto fuel</span>
          <span className="text-right tabular-nums">{agg.autoFuel}</span>
          <span>Teleop active</span>
          <span className="text-right tabular-nums">{agg.teleopFuelActive}</span>
          <span>Teleop inactive</span>
          <span className="text-right tabular-nums">{agg.teleopFuelInactive}</span>
          <span>Endgame fuel</span>
          <span className="text-right tabular-nums">{agg.endgameFuel}</span>
          <span>By shift</span>
          <span className="text-right tabular-nums">{agg.fuelByShift.join(' / ')}</span>
          <span className="font-semibold">Fuel points</span>
          <span className="text-right font-semibold tabular-nums">{agg.fuelPoints}</span>
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Climb level</p>
        <div data-testid="review-climb" className="grid grid-cols-4 gap-2">
          {CLIMB_LEVELS.map((lvl) => (
            <Button
              key={lvl}
              variant={s.climbLevel === lvl ? 'default' : 'outline'}
              className="h-12 min-h-[44px]"
              onClick={() => s.setClimbLevel(lvl)}
            >
              {lvl}
            </Button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            variant={s.climbAttempted ? 'default' : 'outline'}
            className="h-11 min-h-[44px]"
            onClick={() => s.setClimbAttempted(!s.climbAttempted)}
          >
            Attempted
          </Button>
          <Button
            variant={s.climbSuccess ? 'default' : 'outline'}
            className="h-11 min-h-[44px]"
            onClick={() => s.setClimbSuccess(!s.climbSuccess)}
          >
            Success
          </Button>
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Intake sources</p>
        <div className="grid grid-cols-3 gap-2">
          {INTAKE.map((src) => (
            <Button
              key={src}
              variant={s.intakeSources.includes(src) ? 'default' : 'outline'}
              className="h-11 min-h-[44px] text-xs"
              onClick={() => toggleIntake(src)}
            >
              {src}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-1">
          Max capacity
          <input
            type="number"
            min={0}
            value={s.maxFuelCapacityObserved}
            onChange={(e) => s.setMaxFuelCapacityObserved(Number(e.target.value))}
            className="h-11 rounded border border-border bg-input px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Defense (0-3)
          <input
            type="number"
            min={0}
            max={3}
            value={s.defenseRating}
            onChange={(e) =>
              s.setDefenseRating(Math.max(0, Math.min(3, Number(e.target.value))) as 0 | 1 | 2 | 3)
            }
            className="h-11 rounded border border-border bg-input px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Pins
          <input
            type="number"
            min={0}
            value={s.pins}
            onChange={(e) => s.setPins(Number(e.target.value))}
            className="h-11 rounded border border-border bg-input px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Fouls minor
          <input
            type="number"
            min={0}
            value={s.foulsMinor}
            onChange={(e) => s.setFoulsMinor(Number(e.target.value))}
            className="h-11 rounded border border-border bg-input px-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Fouls major
          <input
            type="number"
            min={0}
            value={s.foulsMajor}
            onChange={(e) => s.setFoulsMajor(Number(e.target.value))}
            className="h-11 rounded border border-border bg-input px-2"
          />
        </label>
      </section>

      <section className="grid grid-cols-3 gap-2">
        {(
          [
            ['No show', s.noShow, s.setNoShow],
            ['Died', s.died, s.setDied],
            ['Tipped', s.tipped, s.setTipped],
            ['Dropped', s.droppedFuel, s.setDroppedFuel],
            ['Fed corral', s.fedCorral, s.setFedCorral],
          ] as [string, boolean, (v: boolean) => void][]
        ).map(([label, val, set]) => (
          <Button
            key={label}
            variant={val ? 'default' : 'outline'}
            className="h-11 min-h-[44px] text-xs"
            onClick={() => set(!val)}
          >
            {label}
          </Button>
        ))}
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Auto start position</p>
        <FieldDiagram
          mode="pick-start"
          startPosition={s.autoStartPosition}
          onStartChange={(p: FieldPoint) => s.setAutoStartPosition(p)}
          data-testid="review-field-start"
        />
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Auto path</p>
        <FieldDiagram
          mode="draw-path"
          path={s.autoPath}
          onPathChange={(pts: FieldPoint[]) => s.setAutoPath(pts)}
          data-testid="review-field-path"
        />
      </section>

      <label className="flex flex-col gap-1 text-sm">
        Notes
        <textarea
          value={s.notes}
          onChange={(e) => s.setNotes(e.target.value)}
          className="min-h-[88px] rounded border border-border bg-input p-2"
        />
      </label>

      <Button
        data-testid="review-save"
        className="mt-2 h-16 min-h-[44px] text-xl"
        onClick={() => void onSave()}
      >
        SAVE
      </Button>
    </div>
  );
}
