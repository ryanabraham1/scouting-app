// Groups an event's qual matches into calendar days so a lead can mark a
// scouter as only working, say, Saturday. Days come from each match's TBA
// scheduled_time bucketed in the device's local time zone — the lead is at
// (or planning for) the venue, and match times never sit near midnight, so a
// zone offset can't move a match across a day boundary in practice.
import type { AssignMatch, AssignScout } from './types';

export interface MatchDay {
  /** Stable key, `YYYY-MM-DD` in local time. */
  key: string;
  /** Weekday name — "Saturday". */
  weekday: string;
  /** Short calendar date — "Mar 14". */
  date: string;
  matchKeys: string[];
}

/** Per-scout set of day keys the scouter is NOT working. */
export type ScoutDaysOff = Record<string, string[]>;

export function matchDayKey(scheduledTime: string | null | undefined): string | null {
  if (!scheduledTime) return null;
  const ts = Date.parse(scheduledTime);
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Distinct days in schedule order. Matches without a usable time are skipped. */
export function matchDays(matches: AssignMatch[], locale?: string): MatchDay[] {
  const byKey = new Map<string, MatchDay>();
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  const dateFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  for (const m of matches) {
    const key = matchDayKey(m.scheduledTime);
    if (key === null) continue;
    let day = byKey.get(key);
    if (!day) {
      const d = new Date(Date.parse(m.scheduledTime as string));
      day = { key, weekday: weekdayFmt.format(d), date: dateFmt.format(d), matchKeys: [] };
      byKey.set(key, day);
    }
    day.matchKeys.push(m.matchKey);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Apply per-scout days off to the auto-assign pool by expanding each excluded
 * day into `unavailableMatchKeys`. Scouts with no days off are passed through
 * untouched (same object), so callers with no exclusions see no change.
 */
export function applyDaysOff(
  scouts: AssignScout[],
  days: MatchDay[],
  daysOff: ScoutDaysOff,
): AssignScout[] {
  const byDay = new Map(days.map((d) => [d.key, d.matchKeys]));
  return scouts.map((s) => {
    const off = daysOff[s.id];
    if (!off || off.length === 0) return s;
    const unavailable = new Set(s.unavailableMatchKeys ?? []);
    for (const key of off) {
      for (const matchKey of byDay.get(key) ?? []) unavailable.add(matchKey);
    }
    if (unavailable.size === 0) return s;
    return { ...s, unavailableMatchKeys: [...unavailable] };
  });
}

const STORAGE_PREFIX = 'assignment_days_off:';

/** Lead-device-local persistence so a regenerate after reload keeps the plan. */
export function loadDaysOff(eventKey: string): ScoutDaysOff {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + eventKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ScoutDaysOff = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[id] = v.filter((x): x is string => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDaysOff(eventKey: string, daysOff: ScoutDaysOff): void {
  try {
    const compact: ScoutDaysOff = {};
    for (const [id, v] of Object.entries(daysOff)) if (v.length > 0) compact[id] = v;
    if (Object.keys(compact).length === 0) localStorage.removeItem(STORAGE_PREFIX + eventKey);
    else localStorage.setItem(STORAGE_PREFIX + eventKey, JSON.stringify(compact));
  } catch {
    /* storage unavailable — non-fatal */
  }
}
