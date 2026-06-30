// src/components/__tests__/HeatmapLayer.test.tsx
import { describe, it, expect } from 'vitest';
import {
  heatmapCircles,
  heatmapBlobs,
  densityGrid,
  rampColor,
  HEATMAP_BINS,
  HEATMAP_MIN_OPACITY,
  HEATMAP_MAX_OPACITY,
} from '@/components/HeatmapLayer';
import type { FieldPoint } from '@/components/FieldDiagram';

describe('heatmapCircles', () => {
  it('returns [] for empty input', () => {
    expect(heatmapCircles([])).toEqual([]);
  });

  it('collapses all points in one cell to a single MAX_OPACITY circle', () => {
    const pts: FieldPoint[] = [
      { x: 0.5, y: 0.5 },
      { x: 0.505, y: 0.51 },
      { x: 0.5, y: 0.5 },
    ];
    const out = heatmapCircles(pts);
    expect(out.length).toBe(1);
    expect(out[0].fillOpacity).toBeCloseTo(HEATMAP_MAX_OPACITY, 6);
  });

  it('scales opacity by cell share: a 3-point cell is darker than a 1-point cell', () => {
    // Cell A near (0.01,0.01): 3 points (all inside one cell at the current bin
    // resolution). Cell B near (0.98,0.98): 1 point.
    const pts: FieldPoint[] = [
      { x: 0.005, y: 0.005 },
      { x: 0.008, y: 0.006 },
      { x: 0.004, y: 0.009 },
      { x: 0.98, y: 0.98 },
    ];
    const out = heatmapCircles(pts);
    expect(out.length).toBe(2);
    const sorted = out.slice().sort((a, b) => b.fillOpacity - a.fillOpacity);
    const [dark, faint] = sorted;
    expect(dark.fillOpacity).toBeGreaterThan(faint.fillOpacity);
    expect(faint.fillOpacity).toBeGreaterThanOrEqual(HEATMAP_MIN_OPACITY);
    // busiest cell (3/3) is MAX, the singleton (1/3) is the interpolated minimum
    expect(dark.fillOpacity).toBeCloseTo(HEATMAP_MAX_OPACITY, 6);
  });

  it('output is bounded to <= bins² circles for arbitrarily many points', () => {
    const pts: FieldPoint[] = Array.from({ length: 5000 }, () => ({
      x: Math.random(),
      y: Math.random(),
    }));
    const out = heatmapCircles(pts);
    expect(out.length).toBeLessThanOrEqual(HEATMAP_BINS * HEATMAP_BINS);
  });

  it('emits circle centers at the bin cell centers', () => {
    const bins = HEATMAP_BINS;
    const out = heatmapCircles([{ x: 0.0, y: 0.0 }]);
    expect(out.length).toBe(1);
    // ix = 0, iy = 0 -> center (0.5/bins, 0.5/bins)
    expect(out[0].x).toBeCloseTo(0.5 / bins, 9);
    expect(out[0].y).toBeCloseTo(0.5 / bins, 9);
  });
});

describe('rampColor (multi-stop intensity ramp)', () => {
  it('returns an rgb() string for any t in [0,1]', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(rampColor(t)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    }
  });

  it('clamps out-of-range t to the endpoint colors', () => {
    expect(rampColor(-5)).toBe(rampColor(0));
    expect(rampColor(5)).toBe(rampColor(1));
  });

  it('walks cool (blue, low) to hot (red, high)', () => {
    // low end is blue-dominant; high end is red-dominant.
    const lo = rampColor(0).match(/\d+/g)!.map(Number);
    const hi = rampColor(1).match(/\d+/g)!.map(Number);
    expect(lo[2]).toBeGreaterThan(lo[0]); // blue > red at the cool end
    expect(hi[0]).toBeGreaterThan(hi[2]); // red > blue at the hot end
  });
});

describe('densityGrid (gaussian splat)', () => {
  it('is empty (peak 0) for no points', () => {
    const { grid, peak } = densityGrid([]);
    expect(peak).toBe(0);
    expect(grid.every((v) => v === 0)).toBe(true);
  });

  it('spreads a single point into neighbouring cells (continuous field)', () => {
    const { grid, peak, bins } = densityGrid([{ x: 0.5, y: 0.5 }]);
    expect(peak).toBeGreaterThan(0);
    // more than one non-zero cell => the kernel bled into neighbours.
    const occupied = grid.filter((v) => v > 0).length;
    expect(occupied).toBeGreaterThan(1);
    // the center cell carries the most weight.
    const ix = Math.floor(0.5 * bins);
    const iy = Math.floor(0.5 * bins);
    expect(grid[iy * bins + ix]).toBe(peak);
  });
});

describe('heatmapBlobs (traditional density field)', () => {
  it('returns [] for empty input', () => {
    expect(heatmapBlobs([])).toEqual([]);
  });

  it('colors the densest region hotter than a sparse one', () => {
    // A tight cluster near (0.1,0.1) and a lone point near (0.9,0.9).
    const pts: FieldPoint[] = [
      { x: 0.1, y: 0.1 },
      { x: 0.11, y: 0.1 },
      { x: 0.1, y: 0.11 },
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ];
    const blobs = heatmapBlobs(pts);
    expect(blobs.length).toBeGreaterThan(0);
    const hottest = blobs.slice().sort((a, b) => b.t - a.t)[0];
    const coolest = blobs.slice().sort((a, b) => a.t - b.t)[0];
    expect(hottest.t).toBeCloseTo(1, 6); // peak normalizes to 1
    expect(hottest.t).toBeGreaterThan(coolest.t);
    // opacity tracks t between the documented bounds.
    expect(hottest.fillOpacity).toBeCloseTo(HEATMAP_MAX_OPACITY, 6);
    expect(coolest.fillOpacity).toBeGreaterThanOrEqual(HEATMAP_MIN_OPACITY);
    // ramp color differs between hot and cool cells (real heatmap, not one hue).
    expect(hottest.color).not.toBe(coolest.color);
  });

  it('is bounded to <= bins² blobs for arbitrarily many points', () => {
    const pts: FieldPoint[] = Array.from({ length: 5000 }, () => ({
      x: Math.random(),
      y: Math.random(),
    }));
    expect(heatmapBlobs(pts).length).toBeLessThanOrEqual(
      HEATMAP_BINS * HEATMAP_BINS,
    );
  });
});
