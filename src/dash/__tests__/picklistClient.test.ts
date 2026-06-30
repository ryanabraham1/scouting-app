import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the browser supabase client exactly like the other *Client tests.
// `from()` returns a chainable builder; the read chain ends at `.maybeSingle()`
// and the write chain ends at `.upsert()` — both resolve to { data, error }.
const maybeSingle = vi.fn();
const upsert = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn((_table: string) => ({ select, upsert }));

vi.mock('@/lib/supabase', () => ({
  // Wrapped in a closure: vi.mock factories are hoisted above `const from`,
  // so the mock must reference it lazily, not capture it eagerly.
  supabase: { from: (table: string) => from(table) },
}));

import { getPicklist, savePicklist } from '../picklistClient';
import type { PicklistEntry } from '../picklistClient';

beforeEach(() => {
  from.mockClear();
  select.mockClear();
  eq.mockClear();
  maybeSingle.mockReset();
  upsert.mockReset();
});

describe('getPicklist', () => {
  it('returns [] when no row exists for the event', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await getPicklist('2026casnv');

    expect(result).toEqual([]);
    expect(from).toHaveBeenCalledWith('picklist');
    expect(select).toHaveBeenCalledWith('entries');
    expect(eq).toHaveBeenCalledWith('event_key', '2026casnv');
  });

  it('maps the entries jsonb of an existing row, preserving set fields', async () => {
    const entries: PicklistEntry[] = [
      { teamNumber: 254, tier: 'A', note: 'fast', tierType: 'first', dnp: true },
      { teamNumber: 3256, tier: null, note: null, tierType: 'second', dnp: false },
    ];
    maybeSingle.mockResolvedValue({ data: { entries }, error: null });

    const result = await getPicklist('2026casnv');

    expect(result).toEqual(entries);
  });

  it('normalizes legacy entries lacking dnp/tierType to false/null', async () => {
    const entries = [
      { teamNumber: 254, tier: 'A', note: 'fast' },
      { teamNumber: 3256, tier: null, note: null },
    ];
    maybeSingle.mockResolvedValue({ data: { entries }, error: null });

    const result = await getPicklist('2026casnv');

    expect(result).toEqual([
      { teamNumber: 254, tier: 'A', note: 'fast', dnp: false, tierType: null },
      { teamNumber: 3256, tier: null, note: null, dnp: false, tierType: null },
    ]);
  });

  it('throws when the read errors', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(getPicklist('2026casnv')).rejects.toEqual({ message: 'boom' });
  });
});

describe('savePicklist', () => {
  it('upserts { event_key, entries, updated_at } on conflict event_key', async () => {
    upsert.mockResolvedValue({ error: null });
    const entries: PicklistEntry[] = [{ teamNumber: 1678, tier: 'A', note: null }];

    await savePicklist('2026casnv', entries);

    expect(from).toHaveBeenCalledWith('picklist');
    expect(upsert).toHaveBeenCalledTimes(1);

    const [payload, options] = upsert.mock.calls[0];
    expect(payload).toMatchObject({ event_key: '2026casnv', entries });
    expect(typeof payload.updated_at).toBe('string');
    expect(Number.isNaN(Date.parse(payload.updated_at))).toBe(false);
    expect(options).toEqual({ onConflict: 'event_key' });
  });

  it('includes dnp/tierType in the upserted entries payload', async () => {
    upsert.mockResolvedValue({ error: null });
    const entries: PicklistEntry[] = [
      { teamNumber: 254, tier: 'A', note: null, tierType: 'first', dnp: true },
    ];

    await savePicklist('2026casnv', entries);

    const [payload] = upsert.mock.calls[0];
    expect(payload.entries).toEqual(entries);
    expect(payload.entries[0]).toMatchObject({ tierType: 'first', dnp: true });
  });

  it('throws when the upsert errors', async () => {
    upsert.mockResolvedValue({ error: { message: 'denied' } });

    await expect(savePicklist('2026casnv', [])).rejects.toEqual({ message: 'denied' });
  });
});
