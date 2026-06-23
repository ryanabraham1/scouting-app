// src/scoring/__tests__/migrations.test.ts
import { describe, it, expect } from 'vitest';
import { migrateUp } from '../migrations';
import { SCHEMA_VERSION } from '../constants';

describe('migrateUp', () => {
  it('is identity when record is already at SCHEMA_VERSION', () => {
    const rec = { schema_version: SCHEMA_VERSION, foo: 'bar', auto_fuel: 3 };
    const out = migrateUp({ ...rec });
    expect(out).toEqual(rec);
    expect(out.schema_version).toBe(SCHEMA_VERSION);
  });

  it('treats a missing schema_version as version 0 and stamps it to SCHEMA_VERSION', () => {
    const out = migrateUp({ foo: 'bar' });
    // With SCHEMA_VERSION=1 and no v0->v1 transform registered, the record is
    // simply stamped to the current version with content preserved.
    expect(out.schema_version).toBe(SCHEMA_VERSION);
    expect(out.foo).toBe('bar');
  });

  it('throws when the record is newer than SCHEMA_VERSION', () => {
    expect(() => migrateUp({ schema_version: SCHEMA_VERSION + 1 })).toThrow(
      /newer/i,
    );
  });
});
