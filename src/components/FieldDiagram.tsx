import { useId, useRef } from 'react';
import { heatmapBlobs } from '@/components/HeatmapLayer';

export interface FieldPoint {
  x: number;
  y: number;
}

/**
 * A read-only routine overlay (e.g. another robot's auto path) rendered IN
 * ADDITION to the diagram's primary `path`/`startPosition`. Used by the
 * dashboard's multi-robot auto-routines view (contracts §7).
 */
export interface RoutineOverlay {
  startPosition?: FieldPoint | null;
  path?: FieldPoint[] | null;
  color: string;
  label?: string;
}

export interface FieldDiagramProps {
  mode: 'view' | 'pick-start' | 'draw-path';
  startPosition?: FieldPoint | null;
  path?: FieldPoint[] | null;
  onStartChange?: (p: FieldPoint) => void;
  onPathChange?: (pts: FieldPoint[]) => void;
  mirror?: boolean;
  /** Read-only routine overlays drawn on top of the primary path/start. */
  overlays?: RoutineOverlay[];
  /**
   * Read-only density heatmap drawn UNDER the polyline/marker/overlays (rendered
   * as the first child of the `<svg>`, so document order paints it below). Points
   * arrive in RAW [0,1] field space; this component applies the `mx()` mirror at
   * the render boundary (the heatmap helper never mirrors). Only rendered in
   * `mode === 'view'`, so it never blocks pick-start/draw-path interaction.
   */
  heatmap?: { points: FieldPoint[]; color?: string } | null;
  /**
   * Render the (very wide) field rotated 90° so it fills a TALL portrait
   * container — used on phones held vertically so the diagram is large and easy
   * to tap (the scout turns the phone sideways to view it upright). Pointer
   * coordinates are transformed back into canonical (un-rotated) field space, so
   * the stored {x,y} stay compatible with every other consumer (review/dash).
   */
  rotate?: boolean;
  /**
   * Size the diagram by the HEIGHT of its container (preserving aspect ratio,
   * centered) instead of by width. Lets the field fill a flex region without
   * overflowing vertically. Implied when `rotate` is set.
   */
  fillHeight?: boolean;
  ['data-testid']?: string;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Auto-start markers render as ROBOT-SIZED squares (a bumpered-robot footprint),
// not dots. The SVG viewBox is the stretched [0,1] space (preserveAspectRatio
// "none"), so a VISUAL square needs its width pre-divided by the field image's
// aspect (3902/1584): height is the real robot fraction of field height, width
// the matching fraction of field width.
// Display-only marker, kept a touch smaller than a true bumpered footprint
// (the image's border padding makes 9.5% of image height read oversized).
const ROBOT_MARK_H = 0.062;
const ROBOT_MARK_W = ROBOT_MARK_H * (1584 / 3902);

/** Robot-footprint start marker. `data-cx`/`data-cy` carry the CENTER (the
 *  stored field coordinate) for tests/tools; x/y are the rect corner. */
function RobotStartMarker({
  cx,
  cy,
  fill,
  testid,
}: {
  cx: number;
  cy: number;
  fill: string;
  testid: string;
}): JSX.Element {
  return (
    <rect
      data-testid={testid}
      data-shape="robot-square"
      data-cx={cx}
      data-cy={cy}
      x={cx - ROBOT_MARK_W / 2}
      y={cy - ROBOT_MARK_H / 2}
      width={ROBOT_MARK_W}
      height={ROBOT_MARK_H}
      rx={0.004}
      fill={fill}
      fillOpacity={0.85}
      stroke="#ffffff"
      strokeWidth={0.004}
    />
  );
}

export function FieldDiagram(props: FieldDiagramProps): JSX.Element {
  const {
    mode,
    mirror,
    startPosition,
    path,
    onStartChange,
    onPathChange,
    overlays,
    heatmap,
    rotate,
    fillHeight,
  } = props;
  const rotated = !!rotate;
  const heightFit = rotated || !!fillHeight;
  const testid = props['data-testid'] ?? 'field-diagram';
  // Unique-per-instance id for the heatmap blur filter so multiple diagrams on a
  // page don't share/clobber one another's <filter>.
  const blurId = `${useId()}-heat-blur`;
  const containerRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<FieldPoint[] | null>(null);

  // mirror flips the x axis (1 - x); y is unaffected. Round away binary
  // floating-point noise (e.g. 1 - 0.9 = 0.09999999999999998 -> 0.1) so the
  // rendered SVG coordinates stay clean.
  const mx = (x: number): number =>
    mirror ? Math.round((1 - x) * 1e9) / 1e9 : x;

  const toNormalized = (clientX: number, clientY: number): FieldPoint => {
    const el = containerRef.current;
    const rect = el!.getBoundingClientRect();
    const u = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const v = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    // In rotate mode the field image is drawn rotated 90° CW inside a tall box.
    // The inverse of that rotation maps a pointer at container-normalized (u,v)
    // back to canonical field space: x = v, y = 1 - u. (Rendering applies the
    // same rotation, so a placed marker always lands under the finger.)
    const fx = rotated ? v : u;
    const fy = rotated ? 1 - u : v;
    return { x: clamp01(mx(fx)), y: clamp01(fy) };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'draw-path') {
      drawingRef.current = [toNormalized(e.clientX, e.clientY)];
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'draw-path' && drawingRef.current) {
      drawingRef.current.push(toNormalized(e.clientX, e.clientY));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'pick-start') {
      if (onStartChange) onStartChange(toNormalized(e.clientX, e.clientY));
      return;
    }
    if (mode === 'draw-path' && drawingRef.current) {
      drawingRef.current.push(toNormalized(e.clientX, e.clientY));
      // Guarantee >= 2 points: if the trail somehow collapsed (e.g. a tap with
      // no intervening move), duplicate the last point so the path is valid.
      if (drawingRef.current.length < 2) {
        drawingRef.current.push({ ...drawingRef.current[0] });
      }
      if (onPathChange) onPathChange(drawingRef.current.slice());
      drawingRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (mode !== 'pick-start' || !onStartChange) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    const current = startPosition ?? { x: 0.5, y: 0.5 };
    let next: FieldPoint | null = null;
    if (e.key === 'ArrowLeft') next = { ...current, x: clamp01(current.x - step) };
    if (e.key === 'ArrowRight') next = { ...current, x: clamp01(current.x + step) };
    if (e.key === 'ArrowUp') next = { ...current, y: clamp01(current.y - step) };
    if (e.key === 'ArrowDown') next = { ...current, y: clamp01(current.y + step) };
    if (e.key === 'Home') next = { x: 0.5, y: 0.5 };
    if (!next) return;
    e.preventDefault();
    onStartChange(next);
  };

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      data-mode={mode}
      data-rotated={rotated ? 'true' : 'false'}
      role={mode === 'pick-start' ? 'application' : undefined}
      aria-label={mode === 'pick-start' ? 'Robot starting position on field' : undefined}
      aria-description={
        mode === 'pick-start'
          ? 'Use arrow keys to move the robot. Hold Shift for larger steps. Home centers it.'
          : undefined
      }
      tabIndex={mode === 'pick-start' ? 0 : undefined}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'relative',
        touchAction: 'none',
        userSelect: 'none',
        margin: heightFit ? '0 auto' : undefined,
        overflow: rotated ? 'hidden' : undefined,
        // rotate: tall box (swapped aspect), sized by height; the inner stage is
        // rotated to fill it via container-query units (100cqh/100cqw).
        // fillHeight (no rotate): normal aspect, still sized by height.
        // default: full width, height driven by the image (unchanged).
        ...(rotated
          ? { height: '100%', aspectRatio: '1584 / 3902', containerType: 'size' as const }
          : heightFit
            ? { height: '100%', aspectRatio: '3902 / 1584' }
            : { width: '100%', minWidth: 44, minHeight: 44 }),
      }}
    >
     <div
      style={
        rotated
          ? {
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: '100cqh',
              height: '100cqw',
              transform: 'translate(-50%, -50%) rotate(90deg)',
            }
          : { position: 'relative', width: '100%', height: heightFit ? '100%' : undefined }
      }
     >
      <img
        src="/assets/field/field.png"
        alt="field"
        draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      <svg
        data-testid={`${testid}-svg`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {/* Traditional density heatmap — FIRST child so document order paints it
            UNDER the polyline/marker/overlays. View mode only (never blocks
            editing). Soft ramp-colored blobs (transparent→blue→cyan→green→
            yellow→red) fused by a gaussian blur into a continuous intensity
            field. The `color` prop, when given, tints the whole field a single
            hue instead of the ramp (back-compat for monochrome callers). */}
        {heatmap && heatmap.points.length > 0 && mode === 'view' && (
          <g
            data-testid={`${testid}-heatmap`}
            filter={`url(#${blurId})`}
            style={{ pointerEvents: 'none' }}
          >
            {/* <defs> paints nothing, so it can live inside the <g>; keeping the
                <g> as the svg's first child preserves the UNDER-everything paint
                order (and the documented first-child contract). */}
            <defs>
              <filter
                id={blurId}
                x="-20%"
                y="-20%"
                width="140%"
                height="140%"
                filterUnits="objectBoundingBox"
              >
                {/* blur in [0,1] user space: a tight ~0.8% stdDev just softens
                    cell edges into a continuous line WITHOUT smearing each path
                    point into a wide zone (was 2.2%, which fattened every path
                    into a broad blob). */}
                <feGaussianBlur stdDeviation="0.008" />
              </filter>
            </defs>
            {heatmapBlobs(heatmap.points).map((b, i) => (
              <circle
                key={i}
                cx={mx(b.x)}
                cy={b.y}
                r={b.r}
                fill={heatmap.color ?? b.color}
                fillOpacity={b.fillOpacity}
                stroke="none"
              />
            ))}
          </g>
        )}
        {path && path.length >= 2 && (
          <polyline
            data-testid={`${testid}-polyline`}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={0.01}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={path.map((p) => `${mx(p.x)},${p.y}`).join(' ')}
          />
        )}
        {/* View / draw-path start marker: a circle inside the (stretched) SVG.
            The pick-start SQUARE marker is rendered as an HTML element below so it
            stays a true square regardless of the field image's aspect ratio (the
            SVG uses preserveAspectRatio="none", which would distort an SVG rect). */}
        {startPosition && mode !== 'pick-start' && (
          <RobotStartMarker
            testid={`${testid}-marker`}
            cx={mx(startPosition.x)}
            cy={startPosition.y}
            fill="#f97316"
          />
        )}
        {overlays?.map((overlay, i) => (
          <g key={i}>
            {overlay.path && overlay.path.length >= 2 && (
              <polyline
                data-testid={`${testid}-overlay-${i}`}
                fill="none"
                stroke={overlay.color}
                strokeWidth={0.01}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={overlay.path
                  .map((p) => `${mx(p.x)},${p.y}`)
                  .join(' ')}
              />
            )}
            {overlay.startPosition && (
              <RobotStartMarker
                testid={`${testid}-overlay-start-${i}`}
                cx={mx(overlay.startPosition.x)}
                cy={overlay.startPosition.y}
                fill={overlay.color}
              />
            )}
          </g>
        ))}
      </svg>
      {/* Pick-start marker: a true pixel SQUARE positioned over the field. */}
      {startPosition && mode === 'pick-start' && (
        <div
          data-testid={`${testid}-marker`}
          data-shape="square"
          style={{
            position: 'absolute',
            left: `${mx(startPosition.x) * 100}%`,
            top: `${startPosition.y * 100}%`,
            width: 22,
            height: 22,
            transform: 'translate(-50%, -50%)',
            background: '#f97316',
            border: '2px solid #ffffff',
            borderRadius: 2,
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }}
        />
      )}
     </div>
    </div>
  );
}
