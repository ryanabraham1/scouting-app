// src/dash/autoGrouping.ts
// Pure clustering of a team's scouted auto routines into "auto options" — the
// distinct paths a team tends to run — replacing the old density heatmap. Each
// routine (start position + drawn path) is resampled to a fixed-length polyline
// by arc length, then greedily grouped by mean point-to-point distance. The
// representative shown per group is the medoid (the most central real routine),
// so we never draw a fabricated averaged path. No React, no I/O.

import type { FieldPoint } from '@/components/FieldDiagram';
import type { AutoPath } from '@/dash/AutoHeatmap';
import { rotate180, type AllianceColor } from '@/dash/fieldFrame';

/** Resampled-point count per routine — enough to capture path shape cheaply. */
const SAMPLES = 12;
/**
 * Mean point distance (field fraction, 0..1 space) under which two routines are
 * "the same option". ~0.13 ≈ an eighth of the field — tight enough to separate
 * genuinely different paths, loose enough to fold hand-drawn jitter together.
 */
export const AUTO_GROUP_THRESHOLD = 0.13;

export interface AutoGroup {
  /** Stable id (index in discovery order). */
  id: number;
  /** The most central real routine in the group — what we draw. */
  representative: AutoPath;
  /** Every routine that fell into this group (for the count + match list). */
  members: AutoPath[];
}

const dist = (a: FieldPoint, b: FieldPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Re-frame a routine onto `to`'s alliance side. Routines are stored in absolute
 * field coords, so re-framing applies the 180° red↔blue rotation when the
 * recorded alliance differs from the target (identity otherwise). This lets a red
 * auto and its blue mirror-equivalent be compared/grouped in one shared frame.
 */
export function autoPathToFrame(ap: AutoPath, to: AllianceColor): AutoPath {
  if (ap.alliance === to) return ap;
  return {
    ...ap,
    alliance: to,
    start: ap.start ? rotate180(ap.start) : null,
    path: ap.path ? ap.path.map(rotate180) : null,
  };
}

/** The ordered polyline for a routine: start (if any) then each path vertex. */
function polyline(p: AutoPath): FieldPoint[] {
  const pts: FieldPoint[] = [];
  if (p.start) pts.push(p.start);
  if (p.path) for (const v of p.path) pts.push(v);
  return pts;
}

/** Resample a polyline to exactly `n` points spaced evenly by arc length. */
export function resample(poly: FieldPoint[], n: number): FieldPoint[] {
  if (poly.length === 0) return [];
  if (poly.length === 1) return Array.from({ length: n }, () => poly[0]);
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const d = dist(poly[i - 1], poly[i]);
    seg.push(d);
    total += d;
  }
  if (total === 0) return Array.from({ length: n }, () => poly[0]);
  const out: FieldPoint[] = [];
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    let acc = 0;
    let i = 0;
    while (i < seg.length && acc + seg[i] < target) {
      acc += seg[i];
      i++;
    }
    if (i >= seg.length) {
      out.push(poly[poly.length - 1]);
      continue;
    }
    const t = seg[i] === 0 ? 0 : (target - acc) / seg[i];
    out.push({
      x: poly[i].x + t * (poly[i + 1].x - poly[i].x),
      y: poly[i].y + t * (poly[i + 1].y - poly[i].y),
    });
  }
  return out;
}

/** Mean point-to-point distance between two equal-length resampled routines. */
function featureDistance(a: FieldPoint[], b: FieldPoint[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += dist(a[i], b[i]);
  return sum / a.length;
}

/**
 * Greedily group routines into auto "options" by shape similarity. A routine
 * joins the nearest existing group within {@link AUTO_GROUP_THRESHOLD}, else it
 * seeds a new group. Groups are returned most-common-first; within a group the
 * representative is the medoid (min total distance to the others). Pure.
 */
export function groupAutoPaths(
  paths: AutoPath[],
  threshold = AUTO_GROUP_THRESHOLD,
): AutoGroup[] {
  const feats = paths.map((p) => resample(polyline(p), SAMPLES));
  const groups: { members: number[]; seed: FieldPoint[] }[] = [];

  paths.forEach((_, idx) => {
    let best = -1;
    let bestD = Infinity;
    for (let g = 0; g < groups.length; g++) {
      const d = featureDistance(feats[idx], groups[g].seed);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (best >= 0 && bestD <= threshold) groups[best].members.push(idx);
    else groups.push({ members: [idx], seed: feats[idx] });
  });

  const out: AutoGroup[] = groups.map((g, id) => {
    // Medoid: the member with the smallest total distance to the others.
    let medoid = g.members[0];
    let bestTotal = Infinity;
    for (const i of g.members) {
      let total = 0;
      for (const j of g.members) total += featureDistance(feats[i], feats[j]);
      if (total < bestTotal) {
        bestTotal = total;
        medoid = i;
      }
    }
    return { id, representative: paths[medoid], members: g.members.map((i) => paths[i]) };
  });

  // Most-run option first; stable on ties by discovery order.
  return out.sort((a, b) => b.members.length - a.members.length || a.id - b.id);
}
