// src/dash/reconcile.ts
// Multi-scout reconciliation — PURE, client-side analysis over already-fetched
// match_scouting_report rows (multi-scout-reconciliation feature). Detects when
// two (or more) DIFFERENT scouts each filed an active report on the SAME robot
// in the SAME match, computes how far their captured metrics diverge, and
// classifies the disagreement into a severity tier.
//
// NO React, NO I/O. NO new wire fields (mapReport.ts untouched), NO scoring
// duplication (src/scoring/* untouched), NO migration. Aggregation
// (aggregate.ts) is unchanged — this is a PARALLEL read of the same rows.
//
// Comparand choice (PINNED by a unit test, deliberate): fuel divergence compares
// the server-recomputed `fuel_points` AGGREGATE, NOT the raw `auto_fuel +
// teleop_* + endgame_fuel` inputs. Rationale: `fuel_points` is what the
// dashboard actually displays and averages, so flagging on it matches what the
// lead sees. Tradeoff — two scouts can produce slightly different `fuel_points`
// purely from confidence/down-weight differences rather than a real
// disagreement, so small spreads are expected noise (absorbed by FUEL_MINOR_PTS).
// A unit test pins `fuel_points` as the comparand so a later refactor cannot
// silently switch to the raw inputs.

import type {
  MsrRow,
  ConflictSeverity,
  ConflictDivergences,
  MultiScoutGroup,
} from './types';

// --- Tunable thresholds (exported so tests + UI share the exact same numbers).
/** Below this fuel_points spread, fuel agrees. */
export const FUEL_MINOR_PTS = 3;
/** At/above this fuel_points spread, fuel is a severe disagreement. */
export const FUEL_SEVERE_PTS = 8;
/** defense_rating spread (0..5 scale) at/above which defense is severe. */
export const DEFENSE_SEVERE = 3;

/**
 * Identity of a row for O(1) conflict lookup. The trailing `scout_id` keeps the
 * key stable per row even in the rare case where two same-scout rows survive
 * (those are deduped out of the group, but a per-row key is still wanted).
 */
export function reportKey(r: MsrRow): string {
  return `${r.match_key}|${r.target_team_number}|${r.alliance_color}|${r.station}|${r.scout_id ?? '∅'}`;
}

/** Composite key identifying ONE robot in ONE match (scout-independent). */
export function robotKey(r: MsrRow): string {
  return `${r.match_key}|${r.target_team_number}|${r.alliance_color}|${r.station}`;
}

/** Keep only finite numbers (drops null / undefined / NaN). */
function num(xs: Array<number | null | undefined>): number[] {
  return xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Compute the per-metric divergences for a group of k≥2 deduped reports. Every
 * metric is null-guarded so a missing column never manufactures a false spread.
 */
export function computeDivergences(reports: MsrRow[]): ConflictDivergences {
  // fuel_points: present since 0008, but still guard legacy/QR rows.
  const fuels = num(reports.map((r) => r.fuel_points));
  const fuel_spread = fuels.length >= 2 ? Math.max(...fuels) - Math.min(...fuels) : 0;

  // Climb: categorical success disagreement OR level spread among successes.
  const climbSuccesses = reports.map((r) => r.climb_success === true);
  const climb_success_divergent =
    climbSuccesses.some((x) => x) && climbSuccesses.some((x) => !x);
  const climbLevels = num(reports.filter((r) => r.climb_success).map((r) => r.climb_level));
  const climb_level_spread =
    climbLevels.length >= 2 ? Math.max(...climbLevels) - Math.min(...climbLevels) : 0;

  const defenses = num(reports.map((r) => r.defense_rating));
  const defense_spread = defenses.length >= 2 ? Math.max(...defenses) - Math.min(...defenses) : 0;

  // Boolean reliability flags: divergent iff scouts disagree on the flag.
  const flagDivergent = (sel: (r: MsrRow) => boolean): boolean => {
    const vs = reports.map(sel);
    return vs.some(Boolean) && vs.some((v) => !v);
  };
  const no_show_divergent = flagDivergent((r) => r.no_show === true);
  const died_divergent = flagDivergent((r) => r.died === true);
  const tipped_divergent = flagDivergent((r) => r.tipped === true);

  // How many metrics were actually comparable (≥2 scouts had a usable value).
  // Booleans are always defined-vs-default comparable; the 3 below are
  // no_show / died / tipped. climb_success is a tri-state covered by
  // climb_success_divergent and not counted here.
  const comparable_metric_count =
    (fuels.length >= 2 ? 1 : 0) +
    (climbLevels.length >= 2 ? 1 : 0) +
    (defenses.length >= 2 ? 1 : 0) +
    3;

  return {
    fuel_spread,
    climb_success_divergent,
    climb_level_spread,
    defense_spread,
    no_show_divergent,
    died_divergent,
    tipped_divergent,
    comparable_metric_count,
  };
}

/**
 * Classify a divergence summary into a severity tier. See ConflictSeverity for
 * the meaning of each tier. The `unknown` tier guards against a false NEGATIVE:
 * when nothing was comparable (every numeric metric missing on a side AND no
 * boolean disagreement) we must NOT claim the two scouts "agree".
 */
export function classifySeverity(d: ConflictDivergences): ConflictSeverity {
  const severe =
    d.no_show_divergent ||
    d.died_divergent ||
    d.climb_success_divergent ||
    d.fuel_spread >= FUEL_SEVERE_PTS ||
    d.defense_spread >= DEFENSE_SEVERE;
  if (severe) return 'severe';

  const minor =
    d.fuel_spread >= FUEL_MINOR_PTS ||
    d.climb_level_spread >= 1 ||
    d.defense_spread >= 1 ||
    d.tipped_divergent;
  if (minor) return 'minor';

  // No divergence detected. Distinguish a genuine match from "we couldn't
  // compare anything" (every numeric metric missing on a side, no boolean
  // disagreement) — see the comparand/false-negative note above.
  const noNumericOverlap =
    !(d.fuel_spread > 0) &&
    !(d.climb_level_spread > 0) &&
    !(d.defense_spread > 0) &&
    d.comparable_metric_count <= 3; // only the always-on booleans were comparable
  const noBooleanDivergence =
    !d.no_show_divergent &&
    !d.died_divergent &&
    !d.tipped_divergent &&
    !d.climb_success_divergent;
  if (noNumericOverlap && noBooleanDivergence) return 'unknown';
  return 'agree';
}

/**
 * Detect multi-scout groups across an event's reports.
 *
 * 1. Drop deleted rows (belt-and-suspenders — `useEventReports` already filters
 *    `deleted=false`; this guards QR-merged / local-store rows).
 * 2. Group by robotKey.
 * 3. Dedupe by scout_id within a group (latest server_received_at wins). A null
 *    scout_id counts as one distinct "unassigned" scout — two SAME-scout rows
 *    are an outbox artifact, not a multi-scout disagreement.
 * 4. Keep groups with ≥2 distinct scouts.
 * 5. Compute divergences + severity per kept group.
 *
 * O(n) over reports. Pure — memoize at the call site.
 */
export function detectMultiScoutReports(reports: MsrRow[]): MultiScoutGroup[] {
  const buckets = new Map<string, MsrRow[]>();
  for (const r of reports) {
    if (r.deleted === true) continue;
    const key = robotKey(r);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }

  const groups: MultiScoutGroup[] = [];
  for (const bucket of buckets.values()) {
    // Dedupe by scout_id, keeping the latest server_received_at per scout.
    const byScout = new Map<string, MsrRow>();
    for (const r of bucket) {
      const sid = r.scout_id ?? '∅';
      const prev = byScout.get(sid);
      if (!prev || (r.server_received_at ?? '') > (prev.server_received_at ?? '')) {
        byScout.set(sid, r);
      }
    }
    if (byScout.size < 2) continue;

    const deduped = Array.from(byScout.values());
    const divergences = computeDivergences(deduped);
    const severity = classifySeverity(divergences);
    const first = deduped[0];
    groups.push({
      matchKey: first.match_key,
      teamNumber: first.target_team_number,
      allianceColor: first.alliance_color,
      station: first.station,
      reports: deduped,
      scoutIds: deduped.map((r) => r.scout_id ?? null),
      severity,
      isConflicted: severity === 'minor' || severity === 'severe',
      divergences,
    });
  }
  return groups;
}

/** Human label for a severity tier (used in chips / banners). */
export function severityLabel(s: ConflictSeverity): string {
  switch (s) {
    case 'severe':
      return 'conflict';
    case 'minor':
      return 'minor conflict';
    case 'unknown':
      return 'insufficient data';
    case 'agree':
    default:
      return 'agree';
  }
}

/** "L3" / "none" — climb summary for one report. */
function climbText(r: MsrRow): string {
  return r.climb_success ? `L${r.climb_level}` : 'none';
}

/**
 * Build the per-metric divergence lines for the tooltip / banner from the
 * deduped reports' ACTUAL values (not the spread numbers), so the lead sees the
 * real figures, e.g. `Fuel: 14 vs 8 pts`, `Climb: L3 vs none`, `Defense: 4 vs 1`.
 * Only lines for metrics that actually diverge are emitted.
 */
export function formatDivergences(group: MultiScoutGroup): string[] {
  const { reports, divergences: d } = group;
  const lines: string[] = [];

  if (d.fuel_spread > 0) {
    const fuels = num(reports.map((r) => r.fuel_points));
    lines.push(`Fuel: ${fuels.map((x) => Math.round(x)).join(' vs ')} pts`);
  }
  if (d.climb_success_divergent || d.climb_level_spread > 0) {
    lines.push(`Climb: ${reports.map(climbText).join(' vs ')}`);
  }
  if (d.defense_spread > 0) {
    const defs = num(reports.map((r) => r.defense_rating));
    lines.push(`Defense: ${defs.join(' vs ')}`);
  }
  if (d.no_show_divergent) {
    lines.push(`No-show: ${reports.map((r) => (r.no_show ? 'yes' : 'no')).join(' vs ')}`);
  }
  if (d.died_divergent) {
    lines.push(`Died: ${reports.map((r) => (r.died ? 'yes' : 'no')).join(' vs ')}`);
  }
  if (d.tipped_divergent) {
    lines.push(`Tipped: ${reports.map((r) => (r.tipped ? 'yes' : 'no')).join(' vs ')}`);
  }

  if (lines.length === 0) {
    // agree / unknown — surface a neutral summary instead of metric lines.
    lines.push(
      group.severity === 'unknown'
        ? 'Insufficient data to compare.'
        : 'Scouts agree on every comparable metric.',
    );
  }
  return lines;
}
