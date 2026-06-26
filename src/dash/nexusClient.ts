// src/dash/nexusClient.ts
// Typed model + defensive parser for the FRC Nexus live-event API
// (GET /event/{eventKey}). The payload is produced by an external service, so
// every field is treated as possibly-missing/malformed: the parser never throws
// and only surfaces values it can verify.

/** Per-match estimated/actual timing (all unix-ms; any field may be absent). */
export interface NexusMatchTimes {
  estimatedQueueTime: number | null;
  estimatedOnDeckTime: number | null;
  estimatedOnFieldTime: number | null;
  estimatedStartTime: number | null;
  actualQueueTime: number | null;
}

/** A single match as reported by Nexus. */
export interface NexusMatch {
  /** Display label, e.g. "Qualification 42". */
  label: string;
  /** Field status, e.g. "Now queuing" | "On deck" | "On field" | "Completed". */
  status: string | null;
  /** Red alliance team numbers (parsed from Nexus' string team list). */
  redTeams: number[];
  /** Blue alliance team numbers. */
  blueTeams: number[];
  times: NexusMatchTimes;
}

/** A parsed snapshot of the live field status for an event. */
export interface NexusEventStatus {
  eventKey: string | null;
  /** When Nexus last refreshed this payload (unix-ms), if provided. */
  dataAsOfTime: number | null;
  /** The label Nexus reports as currently queuing, if any. */
  nowQueuing: string | null;
  /** The match currently on the field, if identifiable. */
  onField: NexusMatch | null;
  /** The match queuing / on deck (the one after on-field), if identifiable. */
  queuing: NexusMatch | null;
  /** All matches, in the order Nexus listed them. */
  matches: NexusMatch[];
  /** Upcoming (not-yet-completed) matches, ordered by estimated start time. */
  upcoming: NexusMatch[];
}

/** Raw shape we defensively read from Nexus (kept loose on purpose). */
export interface NexusEvent {
  eventKey?: string;
  dataAsOfTime?: number;
  nowQueuing?: string | null;
  matches?: unknown[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Parse a Nexus team list like ["100","200"] into [100, 200], dropping junk. */
function parseTeams(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    const n =
      typeof item === 'number'
        ? item
        : typeof item === 'string'
          ? Number(item.replace(/[^0-9]/g, ''))
          : NaN;
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

function parseTimes(v: unknown): NexusMatchTimes {
  const r = asRecord(v) ?? {};
  return {
    estimatedQueueTime: asFiniteNumber(r.estimatedQueueTime),
    estimatedOnDeckTime: asFiniteNumber(r.estimatedOnDeckTime),
    estimatedOnFieldTime: asFiniteNumber(r.estimatedOnFieldTime),
    estimatedStartTime: asFiniteNumber(r.estimatedStartTime),
    actualQueueTime: asFiniteNumber(r.actualQueueTime),
  };
}

function parseMatch(v: unknown): NexusMatch | null {
  const r = asRecord(v);
  if (!r) return null;
  const label = asString(r.label);
  if (!label) return null;
  return {
    label,
    status: asString(r.status),
    redTeams: parseTeams(r.redTeams),
    blueTeams: parseTeams(r.blueTeams),
    times: parseTimes(r.times),
  };
}

/** Normalize a status string for matching (case/space-insensitive). */
function normStatus(s: string | null): string {
  return (s ?? '').trim().toLowerCase();
}

function isCompleted(m: NexusMatch): boolean {
  const s = normStatus(m.status);
  return s === 'completed' || s === 'complete' || s === 'finished';
}

function isOnField(m: NexusMatch): boolean {
  return normStatus(m.status) === 'on field';
}

function isQueuing(m: NexusMatch): boolean {
  const s = normStatus(m.status);
  return s === 'now queuing' || s === 'on deck';
}

/**
 * Practice matches (Nexus labels them "Practice N"). They are NOT part of the
 * qual/playoff schedule we track, and at many events Nexus leaves an old practice
 * match lingering as "On field" after real play has started — which is exactly
 * the "On Field stuck on P1" bug. Once any real (non-practice) match exists we
 * exclude practice from live selection so a stale practice row can't freeze the
 * field tiles. Exported for direct testing.
 */
export function isPracticeLabel(label: string | null | undefined): boolean {
  return /^\s*practice\b/i.test(label ?? '');
}

/** Best-effort sort key for upcoming order: estimated start, then on-field/queue. */
function startKey(m: NexusMatch): number {
  return (
    m.times.estimatedStartTime ??
    m.times.estimatedOnFieldTime ??
    m.times.estimatedQueueTime ??
    Number.MAX_SAFE_INTEGER
  );
}

/**
 * "How recently did this match touch the field" — used to disambiguate when more
 * than one match is somehow marked "On field" (stale data): pick the freshest.
 */
function fieldFreshness(m: NexusMatch): number {
  return (
    m.times.actualQueueTime ??
    m.times.estimatedOnFieldTime ??
    m.times.estimatedStartTime ??
    m.times.estimatedQueueTime ??
    Number.MIN_SAFE_INTEGER
  );
}

/**
 * Parse a /event/{key} payload into a defensive live-status snapshot. Returns a
 * fully-populated (but possibly empty) status object; never throws.
 */
export function parseNexusEventStatus(payload: unknown): NexusEventStatus {
  const r = asRecord(payload);
  const rawMatches = Array.isArray(r?.matches) ? (r!.matches as unknown[]) : [];
  const matches = rawMatches
    .map(parseMatch)
    .filter((m): m is NexusMatch => m !== null);

  const nowQueuing = asString(r?.nowQueuing);

  // Once real (qual/playoff) matches exist, ignore practice rows for all LIVE
  // selection — a lingering "On field" practice match must not freeze the tiles.
  const nonPractice = matches.filter((m) => !isPracticeLabel(m.label));
  const pool = nonPractice.length > 0 ? nonPractice : matches;

  // On field: if several are flagged (shouldn't happen, but stale data does),
  // take the freshest rather than the first in play order.
  const onFieldCandidates = pool.filter(isOnField);
  const onField =
    onFieldCandidates.length > 0
      ? onFieldCandidates.reduce((best, m) =>
          fieldFreshness(m) >= fieldFreshness(best) ? m : best,
        )
      : null;

  // Prefer the match whose label matches nowQueuing; else the first queuing/on-deck.
  const queuing =
    (nowQueuing
      ? pool.find((m) => m.label === nowQueuing && m !== onField)
      : undefined) ??
    pool.find((m) => isQueuing(m) && m !== onField) ??
    null;

  const upcoming = pool
    .filter((m) => !isCompleted(m))
    .sort((a, b) => startKey(a) - startKey(b));

  return {
    eventKey: asString(r?.eventKey),
    dataAsOfTime: asFiniteNumber(r?.dataAsOfTime),
    nowQueuing,
    onField,
    queuing,
    matches,
    upcoming,
  };
}
