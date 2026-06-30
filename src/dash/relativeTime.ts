// src/dash/relativeTime.ts
// Pure relative-time formatter for the dashboard heartbeat / sync surfaces.
// Takes the "now" instant as an argument (no internal Date.now()) so it is
// deterministic in unit tests. Reused by ScoutHeartbeat, MatchView's
// ScoutingStatusCard, and SyncIndicator; distribution-trend / coverage-gaps may
// also import it.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * "just now" (<60s) · "Xm ago" (<60m) · "Xh Ym ago" (<24h, drops " 0m") ·
 * "Xd ago" else. `null`/empty/unparseable → "no reports yet". A future
 * timestamp (clock skew) reads "just now".
 */
export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return 'no reports yet';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'no reports yet';
  const d = nowMs - t;
  if (d < 0) return 'just now'; // clock skew guard
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    const m = Math.round((d - h * HOUR) / MIN);
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  return `${Math.floor(d / DAY)}d ago`;
}
