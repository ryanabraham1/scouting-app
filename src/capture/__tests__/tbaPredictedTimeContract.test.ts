import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  tbaMatchToRow,
  upcomingMatchToRow,
} from '../../../supabase/functions/_shared/tbaMatchRow';

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
    // Both writers share one mapper, so they cannot drift apart again.
    const reconcile = source('supabase/functions/sync-event-results/index.ts');
    const webhook = source('supabase/functions/tba-webhook/index.ts');
    expect(reconcile).toContain('../_shared/tbaMatchRow.ts');
    expect(webhook).toContain('../_shared/tbaMatchRow.ts');
    expect(reconcile).toContain('scheduled_time, predicted_time');

    const scheduled = 1_789_000_000;
    const predicted = 1_789_000_420;
    const match = {
      key: '2026cc_qm3',
      comp_level: 'qm',
      match_number: 3,
      time: scheduled,
      predicted_time: predicted,
      alliances: { red: { score: -1 }, blue: { score: -1 } },
    };
    for (const timing of ['authoritative', 'present-only'] as const) {
      const row = tbaMatchToRow(match, '2026cc', { timing })!.row;
      expect(row.scheduled_time).toBe(new Date(scheduled * 1000).toISOString());
      expect(row.predicted_time).toBe(new Date(predicted * 1000).toISOString());
    }
    // A missing prediction never falls back to the schedule.
    const upcoming = upcomingMatchToRow({
      match_key: '2026cc_qm3',
      event_key: '2026cc',
      scheduled_time: scheduled,
    })!;
    expect(upcoming.scheduled_time).toBe(new Date(scheduled * 1000).toISOString());
    expect(upcoming).not.toHaveProperty('predicted_time');
  });
});
