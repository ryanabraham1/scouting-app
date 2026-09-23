// src/lib/timeoutFetch.ts
//
// A `fetch` that cannot hang. At a venue the wifi often stays "connected"
// (`navigator.onLine === true`) while packets go nowhere, and a browser fetch
// has no timeout of its own: it sits in the OS socket timeout (a minute or
// more) and whatever awaits it reads as a dead screen.
//
// PostgREST reads were already bounded (`db.timeout` in lib/supabase.ts), but
// nothing else was — and supabase-js awaits `auth.getSession()` (which may
// refresh the token over the network) before EVERY PostgREST, Storage and
// Functions call. One stalled token refresh therefore stalled every read and
// every outbox upload behind it, no matter what `db.timeout` said.
//
// The timeout aborts with a `TypeError` reason, so a timeout rejects exactly
// like a dropped connection ("Failed to fetch"): auth-js retries it as an
// AuthRetryableFetchError, postgrest/storage surface it as a transport error,
// and the outboxes' `isNetworkFailure` requeues without burning an attempt.

/** Per-request budgets (ms) by Supabase service path. 0 = no timeout. */
export const FETCH_TIMEOUTS_MS = {
  /** Token refresh / anon sign-in: small bodies, and everything waits on it. */
  auth: 15_000,
  /** Backstop only — `db.timeout` (20 s) normally aborts PostgREST first. */
  rest: 30_000,
  /** Photo uploads on slow wifi. */
  storage: 120_000,
  /** Read proxies and the results reconcile. */
  functions: 25_000,
} as const;

/** Edge Functions that legitimately run long (upstream fan-out / big bodies). */
const LONG_FUNCTIONS_MS: Record<string, number> = {
  'import-event': 90_000,
  'seed-demo': 120_000,
  'ingest-reports': 90_000,
  'discord-post': 60_000,
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The budget for one request, from its URL. 0 means "leave it alone". */
export function fetchTimeoutFor(input: RequestInfo | URL): number {
  let path: string;
  try {
    path = new URL(requestUrl(input), 'http://local.invalid').pathname;
  } catch {
    return 0;
  }
  if (path.includes('/auth/v1/')) return FETCH_TIMEOUTS_MS.auth;
  if (path.includes('/rest/v1/')) return FETCH_TIMEOUTS_MS.rest;
  if (path.includes('/storage/v1/')) return FETCH_TIMEOUTS_MS.storage;
  const fn = path.match(/\/functions\/v1\/([^/?#]+)/)?.[1];
  if (fn) return LONG_FUNCTIONS_MS[fn] ?? FETCH_TIMEOUTS_MS.functions;
  return 0;
}

/**
 * `fetch` with a time-to-response budget chosen by `fetchTimeoutFor`. A caller's
 * own `signal` still works (its abort, and its reason, win). The budget covers
 * the wait for response headers; a caller that passed a signal can still abort
 * a slow body read with it.
 *
 * Resolves `globalThis.fetch` per call (never captured at import) so test
 * stubs and late polyfills are honoured.
 */
export function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutMs = fetchTimeoutFor(input);
  if (!timeoutMs || typeof AbortController === 'undefined') {
    return globalThis.fetch(input, init);
  }

  const controller = new AbortController();
  const outer =
    init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  const forwardAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new TypeError(`Network request timed out after ${Math.round(timeoutMs / 1000)}s`),
    );
  }, timeoutMs);

  return globalThis
    .fetch(input, { ...init, signal: controller.signal })
    .finally(() => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forwardAbort);
    });
}
