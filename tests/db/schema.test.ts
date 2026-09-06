// tests/db/schema.test.ts
//
// Schema smoke test: the frozen 0001 tables + key columns still exist and are
// reachable through the roles that are *supposed* to reach them.
//
// The `explicit_browser_data_api_grants` migration deliberately narrowed the
// Data API surface, so "selectable with service_role" is no longer the right
// probe for most tables. This test now verifies the schema through the intended
// readers:
//   - Browser-readable tables: the anon key (grant-backed; RLS returns an empty
//     set for an unauthenticated caller, but PostgREST still validates every
//     selected column against the live schema — a missing column errors 42703).
//   - event_secret: service_role, which retains SELECT for the Edge Functions.
//   - profile / pit_report_history: intentionally private to every Data API role
//     (no grant). A SELECT is denied (42501) rather than "relation does not
//     exist" (42P01), which confirms the table exists while pinning the privacy
//     contract.
import { describe, it, expect, beforeAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, anonClient, SECRET, URL } from './seedHelpers';

// Browser-readable tables (anon/authenticated SELECT grant + RLS policy).
const BROWSER_TABLES = [
  'event', 'team', 'event_team', 'match', 'scout',
  'assignment', 'match_scouting_report', 'pit_scouting_report', 'pit_assignment',
];

// Tables intentionally invisible to every Data API role (RPC/service-only).
const PRIVATE_TABLES = ['profile', 'pit_report_history'];

describe('0001 schema', () => {
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  beforeAll(() => {
    expect(URL, 'VITE_SUPABASE_URL missing').toBeTruthy();
    expect(SECRET, 'SUPABASE_SECRET_KEY missing').toBeTruthy();
    admin = adminClient();
    anon = anonClient();
  });

  it.each(BROWSER_TABLES)('table %s exists and is browser-readable', async (table) => {
    const { error } = await anon.from(table).select('*').limit(1);
    expect(error, `select ${table}: ${error?.message}`).toBeNull();
  });

  it('event_secret exists and stays service-role readable', async () => {
    const { error } = await admin.from('event_secret').select('event_key').limit(1);
    expect(error, `select event_secret: ${error?.message}`).toBeNull();
  });

  it.each(PRIVATE_TABLES)('table %s exists but is Data-API private', async (table) => {
    const { error } = await anon.from(table).select('*').limit(1);
    // 42501 = permission denied (table present, no grant); NOT 42P01 (no table).
    expect(error?.code, `expected ${table} to be private, got ${error?.message}`).toBe('42501');
  });

  it('match_scouting_report exposes fuel_by_shift int[] and fuel_bursts jsonb columns', async () => {
    const { error } = await anon
      .from('match_scouting_report')
      .select('fuel_by_shift,fuel_bursts,row_revision,deleted')
      .limit(1);
    expect(error, error?.message).toBeNull();
  });

  it('event exposes the frozen staged_fuel_per_match default column', async () => {
    const { error } = await anon.from('event').select('staged_fuel_per_match').limit(1);
    expect(error, error?.message).toBeNull();
  });

  it('pit reports expose the ordered photo manifest and revision metadata', async () => {
    const { error } = await anon
      .from('pit_scouting_report')
      .select('photos,photo_path,row_revision')
      .limit(1);
    expect(error, error?.message).toBeNull();
  });
});
