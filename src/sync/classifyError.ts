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
