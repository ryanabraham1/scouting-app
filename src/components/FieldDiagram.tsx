import { useRef } from 'react';

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
  ['data-testid']?: string;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
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
  } = props;
  const testid = props['data-testid'] ?? 'field-diagram';
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
    const rawX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const rawY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return { x: clamp01(mx(rawX)), y: clamp01(rawY) };
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

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      data-mode={mode}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 44,
        minHeight: 44,
        touchAction: 'none',
        userSelect: 'none',
      }}
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
        {startPosition && (
          <circle
            data-testid={`${testid}-marker`}
            cx={mx(startPosition.x)}
            cy={startPosition.y}
            r={0.02}
            fill="#f97316"
            stroke="#ffffff"
            strokeWidth={0.004}
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
              <circle
                data-testid={`${testid}-overlay-start-${i}`}
                cx={mx(overlay.startPosition.x)}
                cy={overlay.startPosition.y}
                r={0.02}
                fill={overlay.color}
                stroke="#ffffff"
                strokeWidth={0.004}
              />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
