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
export const QUERY_CACHE_SCHEMA = '2026-07-release-hardening-v1';

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

export function createMergeSafePersister(
  storage: AtomicQueryCacheStorage,
  options: {
    now?: () => number;
    maxAge?: number;
    buster?: string;
    onPersist?: () => void;
  } = {},
): MergeSafePersister {
  const now = options.now ?? Date.now;
  const maxAge = options.maxAge ?? QUERY_CACHE_MAX_AGE;
  const buster = options.buster ?? QUERY_CACHE_SCHEMA;
  return {
    async persistClient(client) {
      let materiallyChanged = false;
      await storage.update((current) => {
        const stored = parsePersisted(current);
        const merged = mergePersistedQueryClients(stored, client);
        materiallyChanged =
          !stored ||
          stored.buster !== merged.buster ||
          JSON.stringify(stored.clientState, replacer) !==
            JSON.stringify(merged.clientState, replacer);
        return JSON.stringify(merged, replacer);
      });
      if (materiallyChanged) options.onPersist?.();
    },
    async restoreClient() {
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
      return restored;
    },
    removeClient: () => storage.remove(),
  };
}

const cacheStorage: AtomicQueryCacheStorage = {
  read: () => get<string>('frc-rq-cache', idbStore),
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
