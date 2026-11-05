// supabase/functions/_shared/autoscoutWorker.ts
// Pure checks for what the Auto-Scout computer sends. Kept free of Deno APIs so they run under
// Vitest too. The token proves it is our computer; these keep a buggy or replaced client from
// writing anything the dashboard would then render as fact.

export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_ENVELOPE_BYTES + 64 * 1024;
const MAX_TEXT = 300;
const MATCH_KEY_RE = /^[0-9]{4}[a-z0-9]+_(?:qm[1-9][0-9]*|(?:ef|qf|sf|f)[1-9][0-9]*m[1-9][0-9]*)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPORTED_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export interface JobReport {
  id: string;
  status: string;
  completed_matches: string[];
  match_errors: Record<string, string>;
  progress: Record<string, unknown>;
  error: string | null;
}

export interface WorkerInfo {
  calibrated_events: string[];
  free_gb: number | null;
  busy: boolean;
}

/** The header's token as lowercase SHA-256 hex, or null when it can't be a worker token. */
export async function tokenHash(header: string | null): Promise<string | null> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length < 32 || token.length > 200) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time; a missing stored hash must never match anything. */
export function hashMatches(actual: string | null, stored: string | null | undefined): boolean {
  if (!actual || !stored || actual.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return diff === 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, MAX_TEXT) : null;
}

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isMatchKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && MATCH_KEY_RE.test(value);
}

export function parseWorkerInfo(raw: unknown): WorkerInfo {
  const info = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const events = Array.isArray(info.calibrated_events) ? info.calibrated_events : [];
  return {
    calibrated_events: events
      .filter((e): e is string => typeof e === 'string' && /^[0-9]{4}[a-z0-9]+$/.test(e))
      .slice(0, 500),
    free_gb: typeof info.free_gb === 'number' && Number.isFinite(info.free_gb) ? info.free_gb : null,
    busy: info.busy === true,
  };
}

/** Null when the report can't be trusted at all; otherwise only its known, bounded fields. */
export function parseJobReport(raw: unknown): JobReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isJobId(r.id) || typeof r.status !== 'string' || !REPORTED_STATUSES.has(r.status)) return null;

  const errors: Record<string, string> = {};
  if (typeof r.match_errors === 'object' && r.match_errors !== null) {
    for (const [key, value] of Object.entries(r.match_errors).slice(0, 300)) {
      const message = text(value);
      if (isMatchKey(key) && message) errors[key] = message;
    }
  }
  const p = (typeof r.progress === 'object' && r.progress !== null ? r.progress : {}) as Record<string, unknown>;
  const progress: Record<string, unknown> = {};
  for (const key of ['match_key', 'stage', 'recorder'] as const) {
    const value = text(p[key]);
    if (value) progress[key] = value;
  }
  for (const key of ['pct', 'eta_s'] as const) {
    if (typeof p[key] === 'number' && Number.isFinite(p[key])) progress[key] = p[key];
  }
  for (const key of ['queued', 'clipped'] as const) {
    if (Array.isArray(p[key])) progress[key] = p[key].filter(isMatchKey).slice(0, 300);
  }
  return {
    id: r.id,
    status: r.status,
    completed_matches: Array.isArray(r.completed_matches)
      ? r.completed_matches.filter(isMatchKey).slice(0, 300)
      : [],
    match_errors: errors,
    progress,
    error: text(r.error),
  };
}

/** A result is only stored as the match it says it is, in the envelope version we can read. */
export function isValidEnvelope(raw: unknown, matchKey: string): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const envelope = raw as { schema_version?: unknown; source?: unknown; match?: unknown };
  if (envelope.schema_version !== 1 || envelope.source !== 'autoscout') return false;
  if (typeof envelope.match !== 'object' || envelope.match === null) return false;
  const match = envelope.match as { match_key?: unknown; teams?: unknown };
  return match.match_key === matchKey && typeof match.teams === 'object' && match.teams !== null;
}
