import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Upper bound on any single PostgREST request. At a venue the wifi often stays
 * "connected" (`navigator.onLine === true`) while packets go nowhere; without a
 * bound a fetch sits in the OS socket timeout (60s+) and every screen that waits
 * on it reads as dead. 20s comfortably covers the largest dashboard reads on a
 * slow link while still letting the app fail over to its local caches promptly.
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 20_000;

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  db: {
    timeout: SUPABASE_REQUEST_TIMEOUT_MS,
  },
});

// postgrest-js ≥2.8x silently retries every failed GET three times with 1s/2s/4s
// backoff (~7s) BEFORE surfacing the error. That stacks under the app's own
// React Query / outbox retry schedules, so a single unreachable read took
// 15-30s to settle and "verifying" / "loading" states hung far longer than the
// venue-network design intends. The app already owns retry policy in one place
// (`sync/retrySchedule.ts`, React Query `retry`), so turn the library layer off.
// `rest` is the PostgrestClient every `from()` / `rpc()` builder is created from;
// supabase-js exposes no createClient option for this yet.
(supabase as unknown as { rest: { retry?: boolean } }).rest.retry = false;
