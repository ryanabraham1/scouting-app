/**
 * React Query cache persistence for offline-first PWA usage.
 *
 * The lead dashboard is entirely React-Query-driven. Without persistence, an
 * offline page reload drops the in-memory cache and every query restarts from
 * scratch — which, while offline, leaves the UI stuck on infinite "Loading…"
 * spinners. To fix that we:
 *
 *   1. Persist the React Query cache to IndexedDB (via idb-keyval) so a reload
 *      can rehydrate the last successful results.
 *   2. Use `networkMode: 'offlineFirst'` so queries serve cached data
 *      immediately and still attempt a network fetch, rather than getting
 *      stuck in a permanently paused/pending state when offline.
 *
 * Correctness invariant: `gcTime` MUST be >= the persister `maxAge`, otherwise
 * React Query garbage-collects cache entries before they can be restored from
 * IndexedDB. Both are pinned to 14 days here.
 *
 * The idb-keyval store name ('frc-react-query') is deliberately distinct from
 * the app's Dexie databases ('scouting-db' / 'pit-scouting-db') so the caches
 * never collide.
 *
 * Map/Set round-tripping: the persister serializes with JSON, which turns a
 * `Map` into `{}` and a `Set` into `{}` — silently dropping their contents and,
 * worse, their prototype. Query data that holds a Map (e.g. `useEventEpa`'s
 * `epaByTeam`) would then rehydrate as a plain object after a reload, and the
 * first `.get()` call throws "epaByTeam.get is not a function". The custom
 * serialize/deserialize below tag Maps and Sets so they survive the round-trip.
 */
import { hydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import type { Query } from '@tanstack/react-query';
import { createStore, get, update, del } from 'idb-keyval';

// 14 days. Used for both gcTime and the persister maxAge (see invariant above).
export const QUERY_CACHE_MAX_AGE: number = 1000 * 60 * 60 * 24 * 14;
// Bumped 2026-09-13: drops the pre-compaction persisted TBA payloads (multi-MB
// single blob) from every device on next boot; see seasonEpa.compactTbaMatch.
export const QUERY_CACHE_SCHEMA = '2026-09-compact-tba-v2';

export const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // MUST exceed persister maxAge or persisted entries get GC'd before restore.
      gcTime: QUERY_CACHE_MAX_AGE,
      // Return cached data and still attempt fetch; do not infinitely suspend when offline.
      networkMode: 'offlineFirst',
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Dedicated idb-keyval store so it doesn't collide with the app's Dexie DBs.
const idbStore = createStore('frc-react-query', 'cache');

// JSON replacer/reviver that preserve Map and Set through the persisted cache.
// JSON.stringify otherwise collapses both to `{}`, losing contents + prototype.
const MAP_TAG = '__rq_map__';
const SET_TAG = '__rq_set__';

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { [MAP_TAG]: true, value: Array.from(value.entries()) };
  }
  if (value instanceof Set) {
    return { [SET_TAG]: true, value: Array.from(value.values()) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v[MAP_TAG] === true && Array.isArray(v.value)) {
      return new Map(v.value as Iterable<[unknown, unknown]>);
    }
    if (v[SET_TAG] === true && Array.isArray(v.value)) {
      return new Set(v.value as Iterable<unknown>);
    }
  }
  return value;
}

export interface PersistedQueryClient {
  timestamp: number;
  buster: string;
  clientState: DehydratedState;
}

export interface AtomicQueryCacheStorage {
  read(): Promise<string | undefined>;
  update(transform: (current: string | undefined) => string): Promise<void>;
  remove(): Promise<void>;
}

export interface MergeSafePersister {
  persistClient(client: PersistedQueryClient): Promise<void>;
  restoreClient(): Promise<PersistedQueryClient | undefined>;
  removeClient(): Promise<void>;
}

function parsePersisted(value: string | undefined): PersistedQueryClient | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value, reviver) as Partial<PersistedQueryClient>;
    if (
      typeof parsed.timestamp !== 'number' ||
      !Number.isFinite(parsed.timestamp) ||
      typeof parsed.buster !== 'string' ||
      !parsed.clientState ||
      !Array.isArray(parsed.clientState.queries) ||
      !Array.isArray(parsed.clientState.mutations)
    ) return undefined;
    return parsed as PersistedQueryClient;
  } catch {
    return undefined;
  }
}

function queryRevision(query: DehydratedState['queries'][number]): number {
  const state = query.state as { dataUpdatedAt?: unknown; errorUpdatedAt?: unknown };
  const data = typeof state.dataUpdatedAt === 'number' ? state.dataUpdatedAt : 0;
  const error = typeof state.errorUpdatedAt === 'number' ? state.errorUpdatedAt : 0;
  return Math.max(data, error);
}

function serializedRichness(value: unknown): number {
  try {
    return JSON.stringify(value, replacer).length;
  } catch {
    return 0;
  }
}

/**
 * Merge whole persisted clients at query-hash granularity. The per-query
 * dataUpdatedAt timestamp, not the tab's later persistence timestamp, decides
 * authority. Thus an old local/offline fallback cannot replace a richer server
 * snapshot merely because its tab wrote IndexedDB last.
 */
export function mergePersistedQueryClients(
  stored: PersistedQueryClient | undefined,
  incoming: PersistedQueryClient,
): PersistedQueryClient {
  if (!stored || stored.buster !== incoming.buster) return incoming;
  const queries = new Map<string, DehydratedState['queries'][number]>();
  for (const query of stored.clientState.queries) queries.set(query.queryHash, query);
  for (const query of incoming.clientState.queries) {
    const previous = queries.get(query.queryHash);
    if (!previous) {
      queries.set(query.queryHash, query);
      continue;
    }
    const previousRevision = queryRevision(previous);
    const incomingRevision = queryRevision(query);
    if (
      incomingRevision > previousRevision ||
      (incomingRevision === previousRevision &&
        serializedRichness(query.state.data) > serializedRichness(previous.state.data))
    ) {
      queries.set(query.queryHash, query);
    }
  }

  const mutations = new Map<string, DehydratedState['mutations'][number]>();
  for (const mutation of [
    ...stored.clientState.mutations,
    ...incoming.clientState.mutations,
  ]) {
    const key = JSON.stringify(mutation.mutationKey ?? mutation.state);
    mutations.set(key, mutation);
  }
  return {
    timestamp: Math.max(stored.timestamp, incoming.timestamp),
    buster: incoming.buster,
    clientState: {
      queries: [...queries.values()],
      mutations: [...mutations.values()],
    },
  };
}

/**
 * Upper bound on the boot-time cache restore. `PersistQueryClientProvider`
 * keeps EVERY query un-subscribed (no fetch, `fetchStatus: 'idle'`) until
 * `restoreClient()` settles, so an IndexedDB read that never resolves —
 * Firefox/Zen-class browsers with restricted or wedged site storage do this —
 * froze the whole dashboard: the active event sat on "verifying" and each data
 * tab rendered its empty state even with perfect connectivity. Past this bound
 * the app boots as if there were no persisted cache and fetches live.
 */
export const QUERY_CACHE_RESTORE_TIMEOUT_MS = 4_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Hard ceiling on the persisted blob. The whole cache is ONE IndexedDB value
 * that every boot must read and JSON.parse before any query may run, so its
 * size is directly the dashboard's cold-start latency (Firefox/Zen read a
 * multi-MB value in seconds, not milliseconds). Sized so a full event's live
 * data (reports ≈2.6 MB for 350 reports, pit ≈0.7 MB, the compacted season TBA
 * fan-out ≈0.7 MB) fits TOGETHER: at 3 MB they evicted one another on every
 * persist, so each reload re-downloaded whichever set had just been dropped.
 * Anything beyond this is stale accumulation. Parsing 6 MB is ~50 ms in
 * Chromium; the 4 s restore timeout still bounds a pathological browser.
 */
export const QUERY_CACHE_MAX_BYTES = 6 * 1024 * 1024;

/** Lower number = evicted first. Raw upstream fan-out is cheapest to refetch. */
function evictionPriority(query: DehydratedState['queries'][number]): number {
  return query.queryKey[0] === 'tba' ? 0 : 1;
}

/**
 * Evict queries until the serialized cache fits `maxBytes`. Drops raw TBA
 * payloads first, then everything else, oldest `dataUpdatedAt` first, so the
 * active event's freshest data is the last thing to go. The persister applies
 * this on every write, so the blob can never grow past the budget again — no
 * manual "clear site data" is ever required to recover boot speed.
 */
export function enforceCacheBudget(
  client: PersistedQueryClient,
  maxBytes: number = QUERY_CACHE_MAX_BYTES,
): PersistedQueryClient {
  const sized = client.clientState.queries.map((query) => ({
    query,
    bytes: JSON.stringify(query, replacer).length,
  }));
  let total = sized.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= maxBytes) return client;
  const order = [...sized].sort(
    (a, b) =>
      evictionPriority(a.query) - evictionPriority(b.query) ||
      a.query.state.dataUpdatedAt - b.query.state.dataUpdatedAt,
  );
  const evicted = new Set<string>();
  for (const entry of order) {
    if (total <= maxBytes) break;
    evicted.add(entry.query.queryHash);
    total -= entry.bytes;
  }
  return {
    ...client,
    clientState: {
      ...client.clientState,
      queries: client.clientState.queries.filter((q) => !evicted.has(q.queryHash)),
    },
  };
}

export function createMergeSafePersister(
  storage: AtomicQueryCacheStorage,
  options: {
    now?: () => number;
    maxAge?: number;
    buster?: string;
    onPersist?: () => void;
    restoreTimeoutMs?: number;
    maxBytes?: number;
  } = {},
): MergeSafePersister {
  const now = options.now ?? Date.now;
  const maxAge = options.maxAge ?? QUERY_CACHE_MAX_AGE;
  const buster = options.buster ?? QUERY_CACHE_SCHEMA;
  const restoreTimeoutMs = options.restoreTimeoutMs ?? QUERY_CACHE_RESTORE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? QUERY_CACHE_MAX_BYTES;
  return {
    async persistClient(client) {
      let materiallyChanged = false;
      await storage.update((current) => {
        const stored = parsePersisted(current);
        const merged = enforceCacheBudget(mergePersistedQueryClients(stored, client), maxBytes);
        materiallyChanged =
          !stored ||
          stored.buster !== merged.buster ||
          JSON.stringify(stored.clientState, replacer) !==
            JSON.stringify(merged.clientState, replacer);
        return JSON.stringify(merged, replacer);
      });
      if (materiallyChanged) options.onPersist?.();
    },
    restoreClient() {
      // The ENTIRE restore (read + any cleanup delete) is bounded: the core
      // restore awaits both, so either hanging would hold every query. A
      // timed-out restore is "no cache for this boot", NOT a reason to wipe
      // storage — the data may be fine and the browser merely slow.
      const restore = async (): Promise<PersistedQueryClient | undefined> => {
        const raw = await storage.read();
        const restored = parsePersisted(raw);
        if (
          !restored ||
          restored.buster !== buster ||
          restored.timestamp > now() ||
          now() - restored.timestamp > maxAge
        ) {
          if (raw !== undefined) await storage.remove();
          return undefined;
        }
        // Never hydrate more than the budget even from an older build's blob.
        return enforceCacheBudget(restored, maxBytes);
      };
      let timedOut = true;
      const bounded = withTimeout(
        restore().finally(() => {
          timedOut = false;
        }),
        restoreTimeoutMs,
        undefined,
      );
      return bounded.then((result) => {
        // A budgeted blob reads in milliseconds, so a timeout means a
        // pathological value (e.g. an oversized blob from an older build).
        // Discard it in the background so the NEXT boot is fast without the
        // user ever clearing site data; the first persist rebuilds it.
        if (timedOut) void storage.remove().catch(() => {});
        return result;
      });
    },
    // Bounded for the same reason: the core awaits removeClient on the
    // expired/busted path before releasing the queries.
    removeClient: () => withTimeout(storage.remove(), restoreTimeoutMs, undefined),
  };
}

// Kick off the boot-time read at module evaluation so the IndexedDB open +
// read overlaps React's first render and the rest of the entry chunk instead
// of starting only once PersistQueryClientProvider mounts. Consumed once; any
// later read (cross-tab cache-updated pings) goes straight to storage.
let primedRead: Promise<string | undefined> | null =
  typeof indexedDB === 'undefined' ? null : get<string>('frc-rq-cache', idbStore).catch(() => undefined);

const cacheStorage: AtomicQueryCacheStorage = {
  read: () => {
    if (primedRead) {
      const pending = primedRead;
      primedRead = null;
      return pending;
    }
    return get<string>('frc-rq-cache', idbStore);
  },
  update: (transform) =>
    update<string>('frc-rq-cache', (current) => transform(current), idbStore),
  remove: () => del('frc-rq-cache', idbStore),
};

const queryCacheChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('frc-react-query-cache-v1')
    : null;

const persister = createMergeSafePersister(cacheStorage, {
  onPersist: () => queryCacheChannel?.postMessage({ type: 'cache-updated' }),
});

queryCacheChannel?.addEventListener('message', () => {
  void persister.restoreClient().then((cached) => {
    if (cached) hydrate(queryClient, cached.clientState);
  });
});

export function shouldPersistQuery(query: Query): boolean {
  return query.state.status === 'success' && query.queryKey[0] !== 'active-event';
}

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: QUERY_CACHE_MAX_AGE,
  buster: QUERY_CACHE_SCHEMA,
  // Only persist successful data queries. The active event is deliberately
  // excluded: its dedicated localStorage value is the offline fallback, while
  // restoring a "fresh" React Query result could outrank the server on launch.
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersistQuery,
  },
};
