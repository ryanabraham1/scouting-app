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
    expect(out.schema_version).toBe(SCHEMA_VERSION);
    expect(out.foo).toBe('bar');
  });

  it('maps v1 qualitative ordinals while keeping v2 ten-point values literal', () => {
    expect(migrateUp({
      schema_version: 1,
      defense_rating: 1,
      driver_skill: 2,
      agility: 3,
    })).toMatchObject({
      schema_version: 2,
      defense_rating: 3,
      driver_skill: 7,
      agility: 10,
    });

    expect(migrateUp({
      schema_version: 2,
      defense_rating: 2,
      driver_skill: 3,
      agility: 9,
    })).toMatchObject({
      defense_rating: 2,
      driver_skill: 3,
      agility: 9,
    });
  });

  it('throws when the record is newer than SCHEMA_VERSION', () => {
    expect(() => migrateUp({ schema_version: SCHEMA_VERSION + 1 })).toThrow(
      /newer/i,
    );
  });
});
