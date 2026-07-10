// src/scoring/migrations.ts
import { SCHEMA_VERSION } from './constants';

export type AnyReport = Record<string, unknown> & { schema_version?: number };

// Ordered migration steps. migrations[n] transforms a record AT version n into
// a record at version n+1. When SCHEMA_VERSION grows, append a step here.
// For SCHEMA_VERSION=1 there are no transforms; records are only stamped.
type MigrationStep = (record: AnyReport) => AnyReport;

const migrations: Record<number, MigrationStep> = {
  // 0: (record) => ({ ...record, /* v0 -> v1 field changes */ }),
  1: (record) => {
    const ordinalToTenPoint = (value: unknown): unknown => {
      if (value === 1) return 3;
      if (value === 2) return 7;
      if (value === 3) return 10;
      return value;
    };
    return {
      ...record,
      defense_rating: ordinalToTenPoint(record.defense_rating),
      driver_skill: ordinalToTenPoint(record.driver_skill),
      agility: ordinalToTenPoint(record.agility),
    };
  },
};

export function migrateUp(record: AnyReport): AnyReport {
  const current =
    typeof record.schema_version === 'number' ? record.schema_version : 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Cannot migrate: record schema_version ${current} is newer than supported SCHEMA_VERSION ${SCHEMA_VERSION}`,
    );
  }

  let working: AnyReport = { ...record };
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (step) {
      working = step(working);
    }
    working.schema_version = v + 1;
  }

  // Ensure the version field is stamped even when current === SCHEMA_VERSION
  // (e.g. missing schema_version with SCHEMA_VERSION at the floor).
  working.schema_version = SCHEMA_VERSION;
  return working;
}
