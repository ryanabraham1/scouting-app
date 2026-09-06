import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260722181030_allow_authenticated_pit_photo_deletes.sql',
  ),
  'utf8',
)
  .replace(/--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

describe('pit-photo storage delete policy migration', () => {
  it('recreates an authenticated DELETE policy scoped to only the pit-photos bucket', () => {
    expect(migration).toContain(
      'drop policy if exists pit_photos_delete on storage.objects;',
    );
    expect(migration).toContain(
      "create policy pit_photos_delete on storage.objects for delete to authenticated using (bucket_id = 'pit-photos');",
    );
  });

  it('does not grant DELETE to the unauthenticated anon role or broaden the bucket predicate', () => {
    expect(migration).not.toMatch(/for delete to (?:anon|public)\b/);
    expect(migration.match(/create policy/g)).toHaveLength(1);
    expect(migration.match(/bucket_id = 'pit-photos'/g)).toHaveLength(1);
  });
});
