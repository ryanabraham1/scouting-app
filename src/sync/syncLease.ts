import Dexie, { type Table } from 'dexie';

const SYNC_LEASE_NAME = 'frc-scout-outbox-sync';
const FALLBACK_LEASE_MS = 30_000;
const FALLBACK_RENEW_MS = 10_000;

interface SyncLeaseRow {
  name: string;
  token: string;
  expiresAt: number;
}

class SyncCoordinationDb extends Dexie {
  leases!: Table<SyncLeaseRow, string>;

  constructor() {
    // Keep coordination separate from scouting-db. Adding a lease must not
    // force the report database through a schema migration just to sync.
    super('scouting-sync-coordination');
    this.version(1).stores({ leases: 'name' });
  }
}

const coordinationDb = new SyncCoordinationDb();

type StillOwner = () => Promise<boolean>;

export type SyncLeaseWorkResult = 'completed' | 'incomplete';
/** Distinguishes a full drain from both contention and ownership loss. */
export type SyncLeaseResult = SyncLeaseWorkResult | 'not-acquired';

interface LeaseOptions {
  leaseMs?: number;
  renewMs?: number;
  /** Models a tab crash in deterministic expiry tests. */
  renew?: boolean;
  /** @internal Injectable monotonic wall clock for deterministic lease tests. */
  now?: () => number;
}

function createToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function tryAcquire(
  token: string,
  leaseMs: number,
  now: () => number,
): Promise<number | null> {
  return coordinationDb.transaction('rw', coordinationDb.leases, async () => {
    const claimedAt = now();
    const current = await coordinationDb.leases.get(SYNC_LEASE_NAME);
    if (current && current.expiresAt > claimedAt) return null;

    const expiresAt = claimedAt + leaseMs;
    await coordinationDb.leases.put({ name: SYNC_LEASE_NAME, token, expiresAt });
    return expiresAt;
  });
}

async function renewLease(
  token: string,
  leaseMs: number,
  now: () => number,
): Promise<number | null> {
  return coordinationDb.transaction('rw', coordinationDb.leases, async () => {
    const renewedAt = now();
    const current = await coordinationDb.leases.get(SYNC_LEASE_NAME);
    // Never resurrect an expired lease. Another tab is entitled to claim it as
    // soon as expiresAt passes, even if this tab's event loop was suspended.
    if (current?.token !== token || current.expiresAt <= renewedAt) return null;

    const expiresAt = renewedAt + leaseMs;
    await coordinationDb.leases.put({ ...current, expiresAt });
    return expiresAt;
  });
}

async function releaseLease(token: string): Promise<void> {
  await coordinationDb.transaction('rw', coordinationDb.leases, async () => {
    const current = await coordinationDb.leases.get(SYNC_LEASE_NAME);
    // An expired owner finishing late must not delete its successor's lease.
    if (current?.token === token) await coordinationDb.leases.delete(SYNC_LEASE_NAME);
  });
}

async function withIndexedDbLease(
  work: (stillOwner: StillOwner) => Promise<SyncLeaseWorkResult>,
  options: LeaseOptions,
): Promise<SyncLeaseResult> {
  const leaseMs = options.leaseMs ?? FALLBACK_LEASE_MS;
  const renewMs = options.renewMs ?? FALLBACK_RENEW_MS;
  const now = options.now ?? Date.now;
  const token = createToken();
  let localExpiresAt: number;

  try {
    const acquiredUntil = await tryAcquire(token, leaseMs, now);
    if (acquiredUntil == null) return 'not-acquired';
    localExpiresAt = acquiredUntil;
  } catch {
    // IndexedDB can be unavailable (private-mode/WebView policy, quota, or a
    // transient open failure). Sync is idempotent, so availability wins over
    // blocking the outbox forever when no cross-tab primitive can be used.
    return work(async () => true);
  }

  let ownershipLost = false;
  let renewalInFlight: Promise<void> | null = null;
  const startRenewal = () => {
    if (ownershipLost || renewalInFlight) return;
    renewalInFlight = renewLease(token, leaseMs, now)
      .then((expiresAt) => {
        if (expiresAt == null) ownershipLost = true;
        else localExpiresAt = expiresAt;
      })
      .catch(() => {
        // Fence subsequent work if persistent storage becomes unavailable.
        ownershipLost = true;
      })
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const renewTimer = options.renew === false
    ? null
    : setInterval(startRenewal, renewMs);

  const stillOwner: StillOwner = async () => {
    if (ownershipLost) return false;
    if (renewalInFlight) await renewalInFlight;
    if (ownershipLost || localExpiresAt <= now()) return false;
    try {
      const current = await coordinationDb.leases.get(SYNC_LEASE_NAME);
      const owns = current?.token === token && current.expiresAt > now();
      if (!owns) ownershipLost = true;
      return owns;
    } catch {
      ownershipLost = true;
      return false;
    }
  };

  try {
    if (!(await stillOwner())) return 'incomplete';
    return await work(stillOwner);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (renewalInFlight) await renewalInFlight;
    try {
      await releaseLease(token);
    } catch {
      // Expiry provides crash/storage-failure recovery if release cannot run.
    }
  }
}

/**
 * Run one outbox drain across all open tabs. Web Locks is the fast path;
 * IndexedDB provides atomic fallback acquisition in older Safari/WebViews.
 */
export async function withCrossTabSyncLease(
  work: (stillOwner: StillOwner) => Promise<SyncLeaseWorkResult>,
  options: LeaseOptions = {},
): Promise<SyncLeaseResult> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & {
        locks?: {
          request<T>(
            name: string,
            options: { ifAvailable: true },
            callback: (lock: unknown | null) => Promise<T>,
          ): Promise<T>;
        };
      }).locks
    : undefined;

  if (locks?.request) {
    return locks.request(SYNC_LEASE_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return 'not-acquired';
      return work(async () => true);
    });
  }

  return withIndexedDbLease(work, options);
}

/** @internal Test-only cleanup for the durable fallback lease. */
export async function resetSyncLeaseForTests(): Promise<void> {
  await coordinationDb.leases.clear();
}
