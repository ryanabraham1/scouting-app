import { describe, expect, it } from 'vitest';
import { isLandedUpsertVerdict } from '../../supabase/functions/_shared/ingestVerdict';

describe('isLandedUpsertVerdict', () => {
  it('treats applied, idempotent and stale as landed', () => {
    expect(isLandedUpsertVerdict({ status: 'applied' })).toBe(true);
    expect(isLandedUpsertVerdict({ status: 'idempotent' })).toBe(true);
    expect(isLandedUpsertVerdict({ status: 'stale' })).toBe(true);
  });

  it('keeps conflicts and malformed results as failures', () => {
    expect(isLandedUpsertVerdict({ status: 'conflict' })).toBe(false);
    expect(isLandedUpsertVerdict({ status: 'stale', identity_conflict: true })).toBe(false);
    expect(isLandedUpsertVerdict({})).toBe(false);
    expect(isLandedUpsertVerdict(null)).toBe(false);
  });
});
