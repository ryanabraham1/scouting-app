import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('TBA predicted-time ingestion contract', () => {
  it('adds a separate nullable predicted_time database column', () => {
    const migration = source(
      'supabase/migrations/20260910051254_add_match_predicted_time.sql',
    );
    expect(migration).toMatch(/add column if not exists predicted_time timestamptz/i);
  });

  it('maps predicted time independently in reconcile and webhook paths', () => {
    const reconcile = source('supabase/functions/sync-event-results/index.ts');
    const webhook = source('supabase/functions/tba-webhook/index.ts');

    expect(reconcile).toContain('row.predicted_time =');
    expect(reconcile).toContain('scheduled_time, predicted_time');
    expect(webhook).toContain('row.predicted_time = new Date(predicted * 1000).toISOString()');
    expect(webhook).not.toContain('data.predicted_time ?? data.scheduled_time');
  });
});
