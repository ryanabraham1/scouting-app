import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import {
  createMergeSafePersister,
  enforceCacheBudget,
  QUERY_CACHE_SCHEMA,
  shouldPersistQuery,
  type AtomicQueryCacheStorage,
  type PersistedQueryClient,
} from './queryPersist';

function memoryStorage(initial?: string): AtomicQueryCacheStorage & { value?: string } {
  const storage: AtomicQueryCacheStorage & { value?: string } = {
    value: initial,
    async read() {
      return storage.value;
    },
    async update(transform) {
      storage.value = transform(storage.value);
    },
    async remove() {
      storage.value = undefined;
    },
  };
  return storage;
}

function persisted(
  client: QueryClient,
  timestamp = 1_000,
): PersistedQueryClient {
  return {
    timestamp,
    buster: QUERY_CACHE_SCHEMA,
    clientState: dehydrate(client),
  };
}

describe('query persistence policy', () => {
  it('boots without a cache when the storage read never settles', async () => {
    vi.useFakeTimers();
    try {
      const remove = vi.fn(async () => {});
      const hung = {
        read: () => new Promise<string | undefined>(() => {}),
        update: async () => {},
        remove,
      };
      const persister = createMergeSafePersister(hung, { restoreTimeoutMs: 50 });
      const pending = persister.restoreClient();
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBeUndefined();
      // The unreadable blob is discarded so the next boot does not pay again.
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts raw TBA payloads first, then the oldest data, to stay under the byte budget', () => {
    const big = 'x'.repeat(10_000);
    const q = (key: unknown[], dataUpdatedAt: number, data: unknown) => ({
      queryKey: key,
      queryHash: JSON.stringify(key),
      state: {
        data,
        dataUpdateCount: 1,
        dataUpdatedAt,
        error: null,
        errorUpdateCount: 0,
        errorUpdatedAt: 0,
        fetchFailureCount: 0,
        fetchFailureReason: null,
        fetchMeta: null,
        isInvalidated: false,
        status: 'success' as const,
        fetchStatus: 'idle' as const,
      },
    });
    const client = {
      timestamp: 1_000,
      buster: 'b',
      clientState: {
        mutations: [],
        queries: [
          q(['matches', '2026casnv'], 900, big), // freshest app data: keep
          q(['reports', '2026casnv'], 100, big), // oldest app data: evicted last
          q(['tba', 'event-matches', '2026x'], 950, big), // raw fan-out: evicted first
          q(['tba', 'event-matches', '2026y'], 50, big),
        ],
      },
    };
    const trimmed = enforceCacheBudget(client, 21_000);
    expect(trimmed.clientState.queries.map((x) => x.queryKey)).toEqual([
      ['matches', '2026casnv'],
      ['reports', '2026casnv'],
    ]);
    const tighter = enforceCacheBudget(client, 11_000);
    expect(tighter.clientState.queries.map((x) => x.queryKey)).toEqual([['matches', '2026casnv']]);
    // Under budget: untouched (same reference).
    expect(enforceCacheBudget(client, 1_000_000)).toBe(client);
  });

  it('never persists active-event authority but keeps normal successful data', () => {
    const client = new QueryClient();
    client.setQueryData(['active-event', 'server-authority-v2'], '2026casnv');
    client.setQueryData(['event-teams', '2026casnv'], [3256]);

    const active = client.getQueryCache().find({
      queryKey: ['active-event', 'server-authority-v2'],
      exact: true,
    });
    const teams = client.getQueryCache().find({
      queryKey: ['event-teams', '2026casnv'],
      exact: true,
    });

    expect(active && shouldPersistQuery(active)).toBe(false);
    expect(teams && shouldPersistQuery(teams)).toBe(true);
  });

  it('atomically merges disjoint hashes and refuses a stale local overwrite', async () => {
    const storage = memoryStorage();
    const tabA = createMergeSafePersister(storage, { now: () => 1_000 });
    const tabB = createMergeSafePersister(storage, { now: () => 1_000 });

    const serverTab = new QueryClient();
    serverTab.setQueryData(['teams'], [254, 3256], { updatedAt: 900 });
    const otherTab = new QueryClient();
    otherTab.setQueryData(['matches'], ['qm1'], { updatedAt: 950 });
    await Promise.all([
      tabA.persistClient(persisted(serverTab)),
      tabB.persistClient(persisted(otherTab)),
    ]);

    const staleLocalTab = new QueryClient();
    staleLocalTab.setQueryData(['teams'], [254], { updatedAt: 800 });
    await tabB.persistClient(persisted(staleLocalTab));

    const restored = await tabA.restoreClient();
    const hydrated = new QueryClient();
    if (restored) {
      const { hydrate } = await import('@tanstack/react-query');
      hydrate(hydrated, restored.clientState);
    }
    expect(hydrated.getQueryData(['teams'])).toEqual([254, 3256]);
    expect(hydrated.getQueryData(['matches'])).toEqual(['qm1']);
  });

  it('round-trips Map and Set values through the merge-safe persister', async () => {
    const storage = memoryStorage();
    const persister = createMergeSafePersister(storage, { now: () => 1_000 });
    const client = new QueryClient();
    client.setQueryData(
      ['epa'],
      { values: new Map([[254, 32.5]]), selected: new Set([254]) },
      { updatedAt: 900 },
    );
    await persister.persistClient(persisted(client));
    const restored = await persister.restoreClient();
    const data = restored?.clientState.queries[0].state.data as {
      values: Map<number, number>;
      selected: Set<number>;
    };
    expect(data.values).toBeInstanceOf(Map);
    expect(data.values.get(254)).toBe(32.5);
    expect(data.selected).toBeInstanceOf(Set);
    expect(data.selected.has(254)).toBe(true);
  });

  it('removes corrupt, expired, and wrong-buster cache snapshots', async () => {
    const corrupt = memoryStorage('{bad json');
    const corruptPersister = createMergeSafePersister(corrupt, { now: () => 5_000 });
    await expect(corruptPersister.restoreClient()).resolves.toBeUndefined();
    expect(corrupt.value).toBeUndefined();

    const oldClient = new QueryClient();
    oldClient.setQueryData(['old'], true, { updatedAt: 100 });
    const expired = memoryStorage(JSON.stringify(persisted(oldClient, 100)));
    const expiredPersister = createMergeSafePersister(expired, {
      now: () => 5_000,
      maxAge: 1_000,
    });
    await expect(expiredPersister.restoreClient()).resolves.toBeUndefined();
    expect(expired.value).toBeUndefined();

    const wrong = persisted(oldClient, 4_900);
    wrong.buster = 'old-schema';
    const wrongBuster = memoryStorage(JSON.stringify(wrong));
    const busterPersister = createMergeSafePersister(wrongBuster, { now: () => 5_000 });
    await expect(busterPersister.restoreClient()).resolves.toBeUndefined();
    expect(wrongBuster.value).toBeUndefined();
  });
});
