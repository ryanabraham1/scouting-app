import { useState } from 'react';
import { Route, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import {
  useTeamAutoHistory,
  type TeamAutoHistory,
} from '@/capture/useTeamAutoHistory';
import AutoHistoryPicker from '@/capture/AutoHistoryPicker';
import { useIsPortrait } from '@/capture/useIsPortrait';
import type { useCaptureSession } from '@/capture/useCaptureSession';

/**
 * Auto path entry, shared by the live capture screen (opened the moment Auto
 * ends, while the route is fresh) and the Review auto step (to check or fix it).
 * Two ways to record the path: PICK one of the routines the team has already
 * been scouted running (re-framed onto this match's alliance), or DRAW it by
 * finger. The start position (captured pre-match on the placement step) renders
 * as the orange marker on the draw field.
 */
export function AutoPathPanel(props: {
  session: ReturnType<typeof useCaptureSession>;
  /** Optional injected auto history keeps practice/replay fully offline. */
  autoHistory?: TeamAutoHistory;
  /** Fired on every path change (observer for coach chrome). */
  onAction?: () => void;
  /** Prefix for the picker/field test ids (`review-field-path`, …). */
  testIdPrefix: 'review' | 'capture';
  /** Portrait field height; the live screen uses less so Done stays on-screen. */
  portraitFieldHeight?: string;
}): JSX.Element {
  const s = props.session;
  const isPortrait = useIsPortrait();
  // Only mounted once the auto path is actually being entered, so the lookup
  // doesn't run (or cost a request) on screens that never show it.
  const loadedAutoHistory = useTeamAutoHistory(s.eventKey, s.targetTeamNumber, {
    excludeMatchKey: s.matchKey,
    enabled: props.autoHistory === undefined,
  });
  const priorAutos = (props.autoHistory ?? loadedAutoHistory).autos;
  const hasPriorAutos = priorAutos.length > 0;
  const [autoMode, setAutoMode] = useState<'known' | 'draw'>('known');
  // Effective mode: with no prior autos there's nothing to pick, so always draw.
  const effectiveAutoMode = hasPriorAutos ? autoMode : 'draw';

  return (
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

      <div className="mb-3 flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" aria-pressed={s.autoPath === null}
          onClick={() => { s.setAutoPath(null); props.onAction?.(); }}>Didn’t see / unsure</Button>
        <Button variant="outline" className="min-h-11" aria-pressed={Array.isArray(s.autoPath) && s.autoPath.length === 0}
          onClick={() => { s.setAutoPath([]); props.onAction?.(); }}>Observed no movement</Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{s.autoPath === null ? 'Auto path unrecorded. Leave it unsure if you did not see it.' : s.autoPath.length === 0 ? 'Observed no movement during auto.' : 'Auto path recorded.'}</p>

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
          data-testid={`${props.testIdPrefix}-auto-history`}
        />
      ) : (
        /* In portrait the very wide field is rotated 90° (tall + big) so
           tracing the path with a finger is accurate; landscape gets the
           full width (capped). */
        <div
          className={
            isPortrait
              ? `mx-auto flex ${props.portraitFieldHeight ?? 'h-[55dvh]'} w-full justify-center`
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
              s.setAutoPath(pts.length > 0 ? pts : null);
              props.onAction?.();
            }}
            data-testid={`${props.testIdPrefix}-field-path`}
          />
        </div>
      )}
    </div>
  );
}

export default AutoPathPanel;
