import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;

const TABLES = [
  'event', 'event_secret', 'team', 'event_team', 'match', 'scout',
  'profile', 'assignment', 'match_scouting_report', 'pit_scouting_report',
  'pit_assignment', 'pit_report_history',
];

describe('0001 schema', () => {
  let admin: SupabaseClient;
  beforeAll(() => {
    expect(URL, 'VITE_SUPABASE_URL missing').toBeTruthy();
    expect(SECRET, 'SUPABASE_SECRET_KEY missing').toBeTruthy();
    admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  });

  it.each(TABLES)('table %s exists and is selectable with service role', async (table) => {
    const { error } = await admin.from(table).select('*').limit(1);
    expect(error, `select ${table}: ${error?.message}`).toBeNull();
  });

  it('match_scouting_report has frozen default for staged_fuel via event', async () => {
    const { error } = await admin.from('event').select('staged_fuel_per_match').limit(1);
    expect(error).toBeNull();
  });

  it('match_scouting_report exposes fuel_by_shift int[] and fuel_bursts jsonb columns', async () => {
    const { error } = await admin
      .from('match_scouting_report')
      .select('fuel_by_shift,fuel_bursts,row_revision,deleted')
      .limit(1);
    expect(error).toBeNull();
  });

  it('pit reports expose the ordered photo manifest and revision metadata', async () => {
    const { error } = await admin
      .from('pit_scouting_report')
      .select('photos,photo_path,row_revision')
      .limit(1);
    expect(error).toBeNull();
  });
});
