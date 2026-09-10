export interface MatchTimeFields {
  predicted_time?: string | null;
  scheduled_time?: string | null;
}

export type MatchTimeSource = 'estimated' | 'scheduled';
export type MatchTimeState = 'future' | 'now' | 'late';

export interface MatchTimeDisplay {
  source: MatchTimeSource;
  clock: string;
  relative: string;
  state: MatchTimeState;
  minutesAway: number | null;
}

const MINUTE_MS = 60_000;
const STARTING_NOW_GRACE_MS = 2 * MINUTE_MS;

function validTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/**
 * Build the scout-facing clock/countdown from the best available TBA time.
 * A live prediction wins; the published schedule is an explicitly-labelled
 * fallback. Invalid/missing values return null so the UI can say "Time TBD".
 */
export function matchTimeDisplay(
  match: MatchTimeFields,
  opts: { now?: number; locale?: string; timeZone?: string } = {},
): MatchTimeDisplay | null {
  const predicted = validTimestamp(match.predicted_time);
  const scheduled = validTimestamp(match.scheduled_time);
  const timestamp = predicted ?? scheduled;
  if (timestamp == null) return null;

  const source: MatchTimeSource = predicted != null ? 'estimated' : 'scheduled';
  const now = opts.now ?? Date.now();
  const delta = timestamp - now;
  const clock = new Intl.DateTimeFormat(opts.locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  }).format(new Date(timestamp));

  if (delta > MINUTE_MS) {
    const minutesAway = Math.max(1, Math.round(delta / MINUTE_MS));
    return {
      source,
      clock,
      relative: `in ${minutesAway} min`,
      state: 'future',
      minutesAway,
    };
  }
  if (delta >= -STARTING_NOW_GRACE_MS) {
    return {
      source,
      clock,
      relative: 'starting now',
      state: 'now',
      minutesAway: 0,
    };
  }
  return {
    source,
    clock,
    relative: 'running late',
    state: 'late',
    minutesAway: null,
  };
}

export function matchTimeSourceLabel(source: MatchTimeSource): string {
  return source === 'estimated' ? 'Estimated' : 'Scheduled';
}
