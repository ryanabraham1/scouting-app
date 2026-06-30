// src/sync/classifyError.ts
//
// Sync error taxonomy — see phase3-contracts.md §9.
//
// transient (→ markDirtyRetry, backoff, retry):
//   network failure ("Failed to fetch", TypeError), offline, HTTP 5xx / 408 / 429,
//   no/empty response.
// terminal (→ markSyncError dead-letter):
//   PostgREST validation (4xx other than 408/429), auth/ownership (42501, 401, 403),
//   malformed payload. (Persistent transients are converted to terminal by the
//   engine's SYNC_MAX_ATTEMPTS cap — not here.)
//
// Unknown / ambiguous → 'transient': we'd rather retry than dead-letter
// prematurely; the attempt-cap is the safety net.

export type SyncErrorKind = 'transient' | 'terminal';

/** HTTP status codes that are retryable even though they are 4xx. */
const TRANSIENT_4XX = new Set([408, 429]);

/**
 * Postgres SQLSTATE classes that are transient infrastructure failures (retry),
 * not permanent validation/auth errors. Connection (08), insufficient resources
 * (53, e.g. 53300 too_many_connections), operator intervention (57P), and
 * serialization/deadlock (40001 / 40P01).
 */
const TRANSIENT_SQLSTATE = /^(08|53|57P|40001|40P01)/i;

/** Extract a numeric HTTP-ish status from a `.status` or `.code` field. */
function numericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function classifyHttpStatus(status: number): SyncErrorKind {
  // 5xx server errors are retryable.
  if (status >= 500) return 'transient';
  // Specific retryable 4xx (timeout / rate-limit).
  if (TRANSIENT_4XX.has(status)) return 'transient';
  // Any other 4xx is a validation/auth failure → dead-letter.
  if (status >= 400) return 'terminal';
  // Anything below 400 is not an error shape we recognize → retry.
  return 'transient';
}

export function classifySyncError(err: unknown): SyncErrorKind {
  // No/empty response → treat as a transient network gap.
  if (err == null) return 'transient';

  // Network failures throw a TypeError (fetch) — always retryable.
  if (err instanceof TypeError) return 'transient';

  if (typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown; message?: unknown };

    // 1. Prefer an explicit numeric HTTP status.
    const status = numericStatus(e.status);
    if (status !== null) return classifyHttpStatus(status);

    // 2. A `.code` may be a numeric-string HTTP status (e.g. "503") OR a
    //    PostgREST/Postgres error code (e.g. "42501", "PGRST204"). Only treat
    //    it as an HTTP status when it falls in the valid HTTP range; Postgres
    //    SQLSTATE codes like "42501" are 5 digits and must NOT be read as 5xx.
    if (e.code != null) {
      const codeStatus = numericStatus(e.code);
      if (codeStatus !== null && codeStatus >= 100 && codeStatus <= 599) {
        return classifyHttpStatus(codeStatus);
      }
      // Postgres connection / resource / serialization-class SQLSTATEs are
      // transient infrastructure hiccups, not validation failures — retry them
      // instead of dead-lettering:
      //   08xxx  connection exception
      //   53xxx  insufficient resources (e.g. 53300 too_many_connections)
      //   57Pxx  operator intervention (admin_shutdown / cannot_connect_now)
      //   40001  serialization_failure   40P01  deadlock_detected
      if (typeof e.code === 'string' && TRANSIENT_SQLSTATE.test(e.code)) {
        return 'transient';
      }
      // Any other code = a DB/PostgREST/Postgres error code → terminal
      // (validation / auth / ownership).
      return 'terminal';
    }

    // 3. Fall back to message sniffing for network failures.
    if (typeof e.message === 'string' && isNetworkMessage(e.message)) {
      return 'transient';
    }
  }

  // Unknown / ambiguous → transient (retry rather than dead-letter prematurely).
  return 'transient';
}

function isNetworkMessage(message: string): boolean {
  return /failed to fetch|network|load failed|fetch/i.test(message);
}

/**
 * Auth / RLS / ownership-class failures — the kind that a deployed RLS or RPC
 * change (e.g. migration 0012 relaxing the upsert ownership gate) can RESOLVE.
 * Such dead-letters are safe to auto-requeue once after the fix ships; genuine
 * validation failures (bad payload, type errors) are NOT in this set and stay
 * dead-lettered. Matched against the stored `lastSyncError` message string.
 *
 *   42501 → insufficient_privilege (Postgres / the old ownership raise)
 *   28000 → invalid_authorization (not authenticated)
 *   401 / 403 → HTTP auth/forbidden
 *   PGRST301 → JWT/role permission errors from PostgREST
 *   "not authorized" / "not authenticated" → the RPC's own raise messages
 */
const AUTH_CLASS = /\b(42501|28000|401|403|PGRST301)\b|not authoriz|not authenticat|permission denied|insufficient_privilege/i;

export function isAuthClassError(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_CLASS.test(message);
}

/**
 * A dead-letter that the server fix in migration 0025 (upsert_match_report now
 * supersedes a conflicting active report instead of raising 23505) makes
 * recoverable. Reports that dead-lettered on the one-active-report-per-match
 * unique index are safe to auto-requeue once after 0025 ships; they will now
 * supersede the stale row instead of failing again.
 */
const SUPERSEDE_RECOVERABLE = /idx_msr_match_scout_active/i;

export function isSupersedeRecoverable(message: string | null | undefined): boolean {
  if (!message) return false;
  return SUPERSEDE_RECOVERABLE.test(message);
}

/**
 * A dead-letter caused by an ORPHANED scout_id — the report's scout row was
 * deleted server-side by select_scouter's name-consolidation (e.g. the same
 * scouter name was picked on a second device). upsert_match_report's
 * authenticated branch raised 23503 'invalid scout_id'. The server fix in
 * migration 0030 (re-resolve a missing scout_id by scout_name, provisioning a
 * caller-owned row as a last resort) makes these recoverable, so they're safe to
 * auto-requeue once after that migration ships — re-sending now carries scout_name
 * and lands on the surviving canonical row instead of dead-lettering again.
 */
const ORPHANED_SCOUT_RECOVERABLE = /\b23503\b|invalid scout_id|no such scout/i;

export function isOrphanedScoutRecoverable(message: string | null | undefined): boolean {
  if (!message) return false;
  return ORPHANED_SCOUT_RECOVERABLE.test(message);
}
