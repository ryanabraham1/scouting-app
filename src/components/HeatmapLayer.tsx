// src/components/HeatmapLayer.tsx
// Pure, dependency-free density heatmap helpers for the auto-path heatmap feature.
//
// Two layers of API, both in RAW, unmirrored [0,1] field space (the `mx()` mirror
// transform is applied at the FieldDiagram render boundary, never here):
//
//   • `heatmapCircles` — the original alpha-stacked binning (one circle per
//     non-empty cell, opacity scaled by the cell's share of the busiest cell).
//     Kept for back-compat / simple monochrome overlays.
//
//   • `densityGrid` + `heatmapBlobs` + `rampColor` — a TRADITIONAL heatmap: points
//     are splatted into a grid with a gaussian-ish kernel (so a sparse scatter
//     reads as a smooth continuous field, not isolated dots), the grid is
//     normalized to its peak, and each occupied cell becomes a soft blob whose
//     COLOR walks a multi-stop intensity ramp (transparent → blue → cyan → green →
//     yellow → red). Rendered with an SVG blur filter on top, this paints a real
//     density field rather than a constellation of same-colored circles.
//
// Binning bounds the output to <= bins² blobs regardless of input size, so render
// cost is bounded (perf guard).

import type { FieldPoint } from '@/components/FieldDiagram';

export const HEATMAP_BINS = 48;
export const HEATMAP_MIN_OPACITY = 0.12; // a single point is still visible
export const HEATMAP_MAX_OPACITY = 0.85; // never fully opaque (field stays readable)

export interface HeatmapCircle {
  x: number;
  y: number;
  r: number;
  fillOpacity: number;
}

/**
 * Bin `points` (raw [0,1]² field space) into a `bins × bins` grid, then emit one
 * circle per non-empty cell at the cell center, with opacity scaled by the cell's
 * share of the max bin count. Output is RAW space (no mirroring) and bounded to
 * <= bins² circles.
 */
export function heatmapCircles(
  points: FieldPoint[],
  bins: number = HEATMAP_BINS,
): HeatmapCircle[] {
  if (points.length === 0) return [];
  const cell = 1 / bins;
  const r = cell * 0.75; // overlap slightly so dense regions blend
  const counts = new Map<string, number>(); // "ix,iy" -> count
  for (const p of points) {
    const ix = Math.min(bins - 1, Math.max(0, Math.floor(p.x * bins)));
    const iy = Math.min(bins - 1, Math.max(0, Math.floor(p.y * bins)));
    const k = `${ix},${iy}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const max = Math.max(...counts.values());
  const out: HeatmapCircle[] = [];
  for (const [k, c] of counts) {
    const [ix, iy] = k.split(',').map(Number);
    const t = max <= 1 ? 1 : c / max; // 0..1 share of the busiest cell
    const fillOpacity =
      HEATMAP_MIN_OPACITY + (HEATMAP_MAX_OPACITY - HEATMAP_MIN_OPACITY) * t;
    out.push({ x: (ix + 0.5) / bins, y: (iy + 0.5) / bins, r, fillOpacity });
  }
  return out;
}

// ===========================================================================
// Traditional density field.
// ===========================================================================

/**
 * A multi-stop intensity ramp. `t` in [0,1] maps from cool (low density) to hot
 * (peak density). Stops are an on-theme transparent → blue → cyan → green →
 * yellow → red. Returns an `rgb(r,g,b)` string (opacity is carried separately so
 * the ramp color and the blob opacity compose independently).
 */
const RAMP_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t: 0.0, rgb: [37, 99, 235] }, // blue-600
  { t: 0.3, rgb: [34, 211, 238] }, // cyan-400
  { t: 0.55, rgb: [34, 197, 94] }, // green-500
  { t: 0.78, rgb: [250, 204, 21] }, // yellow-400
  { t: 1.0, rgb: [239, 68, 68] }, // red-500
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample the intensity ramp at `t` (clamped to [0,1]) → `rgb(r,g,b)`. */
export function rampColor(t: number): string {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  let lo = RAMP_STOPS[0];
  let hi = RAMP_STOPS[RAMP_STOPS.length - 1];
  for (let i = 0; i < RAMP_STOPS.length - 1; i++) {
    if (x >= RAMP_STOPS[i].t && x <= RAMP_STOPS[i + 1].t) {
      lo = RAMP_STOPS[i];
      hi = RAMP_STOPS[i + 1];
      break;
    }
  }
  const span = hi.t - lo.t || 1;
  const k = (x - lo.t) / span;
  const r = Math.round(lerp(lo.rgb[0], hi.rgb[0], k));
  const g = Math.round(lerp(lo.rgb[1], hi.rgb[1], k));
  const b = Math.round(lerp(lo.rgb[2], hi.rgb[2], k));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Splat `points` into a `bins × bins` density grid with a small gaussian kernel
 * so neighbouring cells share weight (a smooth field, not hard pixels). Returns
 * the raw (un-normalized) accumulated weights, row-major `grid[iy * bins + ix]`,
 * plus the peak weight. Pure — no rendering, no mirroring.
 */
export interface DensityGrid {
  bins: number;
  grid: number[];
  peak: number;
}

export function densityGrid(
  points: FieldPoint[],
  bins: number = HEATMAP_BINS,
): DensityGrid {
  const grid = new Array<number>(bins * bins).fill(0);
  if (points.length === 0) return { bins, grid, peak: 0 };
  // 3x3 TIGHT gaussian kernel (very center-heavy) so a single point keeps almost
  // all its weight in its own cell and only faintly touches its neighbours. This
  // keeps an auto path reading as a thin footprint/line instead of a fat zone,
  // while a hair of bleed still lets an SVG blur fuse the cells into a continuous
  // field. (Was a broad [0.25/0.5/1] kernel that smeared each point into a blob.)
  const kernel = [
    [0.03, 0.12, 0.03],
    [0.12, 1.0, 0.12],
    [0.03, 0.12, 0.03],
  ];
  for (const p of points) {
    const ix = Math.min(bins - 1, Math.max(0, Math.floor(p.x * bins)));
    const iy = Math.min(bins - 1, Math.max(0, Math.floor(p.y * bins)));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = ix + dx;
        const ny = iy + dy;
        if (nx < 0 || nx >= bins || ny < 0 || ny >= bins) continue;
        grid[ny * bins + nx] += kernel[dy + 1][dx + 1];
      }
    }
  }
  let peak = 0;
  for (const v of grid) if (v > peak) peak = v;
  return { bins, grid, peak };
}

export interface HeatmapBlob {
  x: number;
  y: number;
  r: number;
  /** Normalized density 0..1 (peak = 1). Drives both ramp color and opacity. */
  t: number;
  color: string;
  fillOpacity: number;
}

/**
 * Turn `points` into soft, ramp-colored density blobs (one per occupied grid
 * cell), in RAW [0,1] space. Each blob sits at its cell center with a radius that
 * overlaps neighbours so an SVG blur filter fuses them into a continuous field.
 * Cells below `floor` of the peak are dropped (keeps near-empty noise off the
 * field and bounds the blob count). Bounded to <= bins² blobs.
 */
export function heatmapBlobs(
  points: FieldPoint[],
  bins: number = HEATMAP_BINS,
): HeatmapBlob[] {
  const { grid, peak } = densityGrid(points, bins);
  if (peak <= 0) return [];
  const cell = 1 / bins;
  // Keep the blob close to its own cell so a point reads as a tight footprint,
  // not a ballooning zone. A hair of overlap (+ the blur filter) still fuses
  // adjacent occupied cells into a continuous line. (Was cell * 1.15 — each blob
  // bled well past its cell, turning a single path into a fat smear.)
  const r = cell * 0.62;
  const floor = 0.12; // drop cells under 12% of peak so faint bleed stays off-field
  const out: HeatmapBlob[] = [];
  for (let iy = 0; iy < bins; iy++) {
    for (let ix = 0; ix < bins; ix++) {
      const v = grid[iy * bins + ix];
      if (v <= 0) continue;
      const t = v / peak; // 0..1
      if (t < floor) continue;
      const fillOpacity =
        HEATMAP_MIN_OPACITY + (HEATMAP_MAX_OPACITY - HEATMAP_MIN_OPACITY) * t;
      out.push({
        x: (ix + 0.5) / bins,
        y: (iy + 0.5) / bins,
        r,
        t,
        color: rampColor(t),
        fillOpacity,
      });
    }
  }
  return out;
}

export interface HeatmapLayerProps {
  points: FieldPoint[];
  bins?: number;
  ['data-testid']?: string;
}

/**
 * Standalone `<g>` of ramp-colored, soft density blobs in raw [0,1] space — a
 * traditional heatmap field. `FieldDiagram` inlines the same `heatmapBlobs()`
 * output (with mirroring + a shared blur filter) directly so the diagram can
 * apply its `mx()` transform. `pointer-events:none` so it never blocks
 * interaction underneath.
 */
export function HeatmapLayer(props: HeatmapLayerProps): JSX.Element {
  const { points, bins, ['data-testid']: testid } = props;
  const blobs = heatmapBlobs(points, bins);
  return (
    <g
      data-testid={testid ?? 'heatmap-layer'}
      style={{ pointerEvents: 'none' }}
    >
      {blobs.map((b, i) => (
        <circle
          key={i}
          cx={b.x}
          cy={b.y}
          r={b.r}
          fill={b.color}
          fillOpacity={b.fillOpacity}
          stroke="none"
        />
      ))}
    </g>
  );
}
