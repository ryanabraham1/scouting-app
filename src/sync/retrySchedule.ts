const CIRCUIT_KEY = 'frc-scout-sync-circuit-until';
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

let memoryCircuitUntil = 0;

function retryAfterHeader(error: unknown, now: number): number | null {
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
    null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw * 1_000);
  }
  if (typeof raw !== 'string') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function retryDelayMs(
  error: unknown,
  attempt: number,
  now = Date.now(),
  random = Math.random,
): number {
  const retryAfter = retryAfterHeader(error, now);
  if (retryAfter !== null) return Math.min(MAX_DELAY_MS, retryAfter);
  const exponential = Math.min(
    MAX_DELAY_MS,
    BASE_DELAY_MS * 2 ** Math.max(0, Math.min(10, attempt)),
  );
  // Full jitter avoids every scout device reconnecting in the same millisecond.
  return Math.max(BASE_DELAY_MS, Math.round(exponential * (0.5 + random() * 0.5)));
}

export function openSyncCircuit(until: number): void {
  memoryCircuitUntil = Math.max(memoryCircuitUntil, until);
  try {
    localStorage.setItem(CIRCUIT_KEY, String(memoryCircuitUntil));
  } catch {
    // Memory fallback still protects this tab.
  }
}

export function syncCircuitUntil(): number {
  try {
    const persisted = Number(localStorage.getItem(CIRCUIT_KEY));
    if (Number.isFinite(persisted)) memoryCircuitUntil = Math.max(memoryCircuitUntil, persisted);
  } catch {
    // Memory fallback.
  }
  return memoryCircuitUntil;
}

export function isSyncCircuitOpen(now = Date.now()): boolean {
  return syncCircuitUntil() > now;
}

export function clearSyncCircuit(): void {
  memoryCircuitUntil = 0;
  try {
    localStorage.removeItem(CIRCUIT_KEY);
  } catch {
    // Memory state was still cleared.
  }
}
