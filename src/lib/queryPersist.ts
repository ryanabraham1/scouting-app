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
 */
import { QueryClient } from '@tanstack/react-query';
import {
  createAsyncStoragePersister,
} from '@tanstack/query-async-storage-persister';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { createStore, get, set, del } from 'idb-keyval';

// 14 days. Used for both gcTime and the persister maxAge (see invariant above).
const MAX_AGE: number = 1000 * 60 * 60 * 24 * 14;

export const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // MUST exceed persister maxAge or persisted entries get GC'd before restore.
      gcTime: MAX_AGE,
      // Return cached data and still attempt fetch; do not infinitely suspend when offline.
      networkMode: 'offlineFirst',
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Dedicated idb-keyval store so it doesn't collide with the app's Dexie DBs.
const idbStore = createStore('frc-react-query', 'cache');

const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string): Promise<string | null> =>
      get<string>(key, idbStore).then((value) => value ?? null),
    setItem: (key: string, value: string): Promise<void> =>
      set(key, value, idbStore),
    removeItem: (key: string): Promise<void> => del(key, idbStore),
  },
  key: 'frc-rq-cache',
  throttleTime: 1000,
});

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: MAX_AGE,
  // Only persist successful queries so we never restore error/pending states.
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => query.state.status === 'success',
  },
};
