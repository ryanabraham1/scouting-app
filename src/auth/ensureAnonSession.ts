// src/auth/ensureAnonSession.ts
import { supabase } from '../lib/supabase';

/**
 * Ensure an anonymous Supabase session exists. The app has NO visible login;
 * every device silently gets one anonymous auth.uid() so RLS-backed reads/writes
 * (and per-device scout identity) keep working. Idempotent: reuses the persisted
 * session if present, so a device maps to exactly one auth.uid().
 *
 * Resilience: at a real event, dozens of scout devices sit behind ONE venue NAT
 * IP and open the app near-simultaneously, which trips Supabase's per-IP anon
 * signup limit — `POST /auth/v1/signup → 429 over_request_rate_limit`. A single
 * un-retried failure leaves the device with NO session, so `select_scouter` and
 * every subsequent RPC/write fail with `403 (28000 not authenticated)` and the
 * scout can't record anything. So we retry TRANSIENT failures (429, 5xx, network)
 * with exponential backoff + full jitter, honoring `Retry-After`, and only give
 * up (throw) once attempts are exhausted. Genuinely terminal auth errors (4xx
 * other than 429) are NOT retried — retrying them just burns the rate budget.
 */

// A handful of attempts with bounded exponential delays. With BASE 500ms and
// jitter the four inter-attempt gaps sum to at most 500+1000+2000+4000 ≈ 7.5s,
// so a device recovers within seconds of a transient 429 instead of hard-failing
// on the first try. main.tsx already renders after a 2.5s boot timeout and lets
// this promise keep retrying in the background, so a short-but-real budget here
// is the right trade-off (we favor recovering over blocking paint). An explicit
// server Retry-After can require a longer wait and must not be shortened.
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RetryOptions {
  /** Total sign-in attempts before giving up (default MAX_ATTEMPTS). */
  maxAttempts?: number;
  /** Injectable delay (tests pass an instant no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for the jitter (tests pin it). */
  random?: () => number;
}

/** Pull a `Retry-After` value (seconds, or an HTTP date) off an error, in ms. */
function retryAfterMs(error: unknown, now: number): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as {
    retryAfter?: unknown;
    retry_after?: unknown;
    headers?: { get?: (name: string) => string | null };
  };
  const raw =
    value.retryAfter ??
    value.retry_after ??
    value.headers?.get?.('Retry-After') ??
    value.headers?.get?.('retry-after') ??
    null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw * 1_000);
  if (typeof raw !== 'string') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Extract a numeric HTTP status from a supabase-js AuthError (`.status`). */
function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const s = (error as { status?: unknown }).status;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  if (typeof s === 'string' && /^\d+$/.test(s)) return Number(s);
  return null;
}

/**
 * Whether a failed sign-in is worth retrying. Transient: rate limit (429), server
 * errors (5xx), and transport/network gaps (no status — supabase-js throws an
 * AuthRetryableFetchError or resolves a "Failed to fetch" shape). Terminal: any
 * other 4xx (bad request / disabled provider / auth misconfig) — retrying wastes
 * the per-IP budget. Unknown shapes default to transient so a device keeps trying.
 */
function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status === null) return true; // network / unknown → retry
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  if (status >= 400) return false; // other 4xx → terminal
  return true;
}

/** Backoff for the next attempt: honor Retry-After, else exponential full jitter. */
function delayForAttempt(
  error: unknown,
  attempt: number,
  random: () => number,
  now: number,
): number {
  const retryAfter = retryAfterMs(error, now);
  if (retryAfter !== null) return retryAfter;
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  // Full jitter so dozens of devices behind one NAT don't re-signup in lockstep.
  return Math.round(exponential * (0.5 + random() * 0.5));
}

// De-dupe concurrent callers: main.tsx awaits this at boot while the same tab may
// also fire it from the `online` retry. A shared in-flight promise means N callers
// share ONE sign-in attempt-chain instead of each spawning its own signup storm.
// Cleared once settled so a later reconnect retry starts a fresh attempt.
let inFlight: Promise<void> | null = null;

async function run(options: RetryOptions): Promise<void> {
  const {
    maxAttempts = MAX_ATTEMPTS,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  // Reuse the persisted session — one auth.uid() per device, never a duplicate.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.user) return;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Supabase normally returns AuthError, but a transport/custom fetch may
    // reject. Give both forms the same retry policy.
    const { data, error } = await supabase.auth.signInAnonymously().catch(
      (error: unknown) => ({ data: null, error }),
    );
    if (!error) {
      if (!data?.user) throw new Error('Anonymous sign-in did not return a user.');
      return;
    }
    lastError = error;
    // Terminal auth error, or out of attempts → stop retrying.
    if (!isTransient(error) || attempt === maxAttempts - 1) break;
    await sleep(delayForAttempt(error, attempt, random, Date.now()));
  }

  const message =
    (lastError as { message?: unknown } | null)?.message ?? 'Anonymous sign-in failed.';
  throw new Error(typeof message === 'string' ? message : String(message));
}

export async function ensureAnonSession(options: RetryOptions = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
