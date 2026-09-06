import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadMigration(file: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// The as-applied migration on the remote: it re-added the composite
// (event_key, match_key) FK with ON DELETE CASCADE and validated it. This file
// must stay honest about what actually ran on the remote database.
const addFkMigration = loadMigration(
  '20260722191615_cascade_strategy_canvas_match_deletes.sql',
);

// The forward fix: a later migration that idempotently drops that FK again,
// restoring the 0043 design.
const dropFkMigration = loadMigration(
  '20260722203305_drop_strategy_canvas_match_fk.sql',
);

describe('strategy canvas match FK: as-applied add-cascade migration', () => {
  it('re-adds the composite match FK with ON DELETE CASCADE and validates it', () => {
    // This documents the remote reality that the forward fix has to undo.
    expect(addFkMigration).toContain('add constraint strategy_event_match_fkey');
    expect(addFkMigration).toContain('references public.match');
    expect(addFkMigration).toContain('on delete cascade');
    expect(addFkMigration).toContain('validate constraint strategy_event_match_fkey');
  });
});

describe('strategy canvas match FK: forward drop migration', () => {
  it('idempotently drops the composite match FK that broke manual boards and delete_event', () => {
    expect(dropFkMigration).toContain(
      'drop constraint if exists strategy_event_match_fkey;',
    );
  });

  it('does not re-add or validate a match foreign key ("__manual__" boards have no match row)', () => {
    // Re-adding a (event_key, match_key) FK to match would (a) reject every
    // schedule-less '__manual__' board upsert and (b) re-break delete_event.
    expect(dropFkMigration).not.toContain('add constraint strategy_event_match_fkey');
    expect(dropFkMigration).not.toContain('references public.match');
    expect(dropFkMigration).not.toContain('validate constraint');
  });
});
