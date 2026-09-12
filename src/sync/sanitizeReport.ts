import { computeAggregates, type FuelBurst, type MatchWindow, type TimeInterval } from '@/scoring';
import type { LocalMatchReport } from '@/db/types';

const AUTO_MS = 20_000;
const TELEOP_MS = 140_000;
/** Bump only when the repair recipe changes, allowing one new recovery pass. */
export const MATCH_REPORT_AUTO_REPAIR_VERSION = 1;
const BURST_WINDOWS = new Set<MatchWindow>([
  'auto',
  'transition',
  'shift1',
  'shift2',
  'shift3',
  'shift4',
  'endgame',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boundedInteger(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(Math.round(value), min, max)
    : min;
}

function truncateCodePoints(value: unknown, max: number): string {
  return typeof value === 'string' ? Array.from(value).slice(0, max).join('') : '';
}

function sanitizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => truncateCodePoints(item, 64));
}

/**
 * Convert gesture-produced timestamps to the exact integer/range contract used
 * by validate_match_report_payload. Clock re-anchors can otherwise leave a
 * fractional fallback duration or an end just beyond the phase boundary.
 */
export function sanitizeBursts(value: unknown, maxItems: number): FuelBurst[] {
  if (!Array.isArray(value)) return [];
  const out: FuelBurst[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const burst = item as Partial<FuelBurst>;
    if (
      typeof burst.window !== 'string' ||
      !BURST_WINDOWS.has(burst.window as MatchWindow) ||
      typeof burst.startMs !== 'number' ||
      !Number.isFinite(burst.startMs) ||
      typeof burst.endMs !== 'number' ||
      !Number.isFinite(burst.endMs) ||
      typeof burst.rate !== 'number' ||
      !Number.isFinite(burst.rate)
    ) {
      continue;
    }
    const window = burst.window as MatchWindow;
    const maxEnd = window === 'auto' ? AUTO_MS : TELEOP_MS;
    const startMs = clamp(Math.round(burst.startMs), 0, maxEnd);
    const endMs = clamp(Math.round(burst.endMs), startMs, maxEnd);
    out.push({
      startMs,
      endMs,
      rate: clamp(burst.rate, 0, 30),
      window,
    });
    if (out.length === maxItems) break;
  }
  return out;
}

function sanitizePoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as { x?: unknown; y?: unknown };
  if (
    typeof point.x !== 'number' ||
    !Number.isFinite(point.x) ||
    typeof point.y !== 'number' ||
    !Number.isFinite(point.y)
  ) {
    return null;
  }
  return { x: clamp(point.x, -10, 10), y: clamp(point.y, -10, 10) };
}

/** Keep both endpoints while reducing a long pointer trail to the DB limit. */
export function sanitizeAutoPath(value: unknown): { x: number; y: number }[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const points = value.map(sanitizePoint).filter((point) => point !== null);
  if (points.length <= 256) return points;
  return Array.from({ length: 256 }, (_, index) =>
    points[Math.round((index * (points.length - 1)) / 255)],
  );
}

function sanitizeIntervals(value: unknown): TimeInterval[] {
  if (!Array.isArray(value)) return [];
  const out: TimeInterval[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const interval = item as Partial<TimeInterval>;
    if (
      (interval.phase !== 'auto' && interval.phase !== 'teleop') ||
      typeof interval.startMs !== 'number' ||
      !Number.isFinite(interval.startMs) ||
      typeof interval.endMs !== 'number' ||
      !Number.isFinite(interval.endMs)
    ) {
      continue;
    }
    const maxEnd = interval.phase === 'auto' ? AUTO_MS : TELEOP_MS;
    const startMs = clamp(Math.round(interval.startMs), 0, maxEnd);
    out.push({
      phase: interval.phase,
      startMs,
      endMs: clamp(Math.round(interval.endMs), startMs, maxEnd),
    });
    if (out.length === 64) break;
  }
  return out;
}

/**
 * Last-line client safety boundary before local persistence or upload. It is
 * intentionally loss-minimizing: valid reports are returned value-equivalent,
 * while malformed legacy/gesture edge values are clamped, filtered, or capped
 * to the server validator's documented limits.
 */
export function sanitizeMatchReport(report: LocalMatchReport): LocalMatchReport {
  const fuelBursts = sanitizeBursts(report.fuelBursts, 512);
  const feedingBursts = sanitizeBursts(report.feedingBursts, 256);
  const climbLevel = boundedInteger(report.climbLevel, 0, 3) as 0 | 1 | 2 | 3;
  const noShow = report.noShow === true;
  const autoClimbLevel1 = report.autoClimbLevel1 === true;
  const aggregates = computeAggregates({
    schemaVersion: report.schemaVersion,
    inactiveFirst: report.inactiveFirst === true,
    fuelBursts,
    climbLevel,
    autoClimbLevel1,
    noShow,
  });

  return {
    ...report,
    appVersion: truncateCodePoints(report.appVersion, 64),
    deviceId: truncateCodePoints(report.deviceId, 128),
    scoutName:
      report.scoutName === undefined ? undefined : truncateCodePoints(report.scoutName, 128),
    inactiveFirst:
      typeof report.inactiveFirst === 'boolean' ? report.inactiveFirst : null,
    inactiveFirstSource: ['derived', 'scout', 'official'].includes(
      String(report.inactiveFirstSource),
    )
      ? report.inactiveFirstSource
      : null,
    teleopClockUnconfirmed: report.teleopClockUnconfirmed === true,
    fuelBursts,
    feedingBursts,
    ...aggregates,
    climbLevel,
    climbAttempted: report.climbAttempted === true,
    climbSuccess: report.climbSuccess === true,
    autoStartPosition: sanitizePoint(report.autoStartPosition),
    autoPath: sanitizeAutoPath(report.autoPath),
    autoLeftStartingLine: report.autoLeftStartingLine === true,
    autoClimbLevel1,
    intakeSources: sanitizeStringArray(report.intakeSources, 16),
    maxFuelCapacityObserved: boundedInteger(report.maxFuelCapacityObserved, 0, 10_000),
    defenseRating: boundedInteger(report.defenseRating, 0, 10) as LocalMatchReport['defenseRating'],
    driverSkill: boundedInteger(report.driverSkill, 0, 10) as LocalMatchReport['driverSkill'],
    agility: boundedInteger(report.agility, 0, 10) as LocalMatchReport['agility'],
    defenseDurationMs: boundedInteger(report.defenseDurationMs, 0, TELEOP_MS),
    defendedDurationMs: boundedInteger(report.defendedDurationMs, 0, TELEOP_MS),
    defenseIntervals: sanitizeIntervals(report.defenseIntervals),
    defendedIntervals: sanitizeIntervals(report.defendedIntervals),
    pins: boundedInteger(report.pins, 0, 1_000),
    foulsMinor: boundedInteger(report.foulsMinor, 0, 1_000),
    foulsMajor: boundedInteger(report.foulsMajor, 0, 1_000),
    foulReasons: sanitizeStringArray(report.foulReasons, 32),
    noShow,
    died: report.died === true,
    tipped: report.tipped === true,
    droppedFuel: report.droppedFuel === true,
    fedCorral: report.fedCorral === true,
    notes: truncateCodePoints(report.notes, 10_000),
    rowRevision: boundedInteger(report.rowRevision, 1, Number.MAX_SAFE_INTEGER),
  };
}
