// src/dash/__tests__/validateAddTeam.test.ts
// Pure unit tests for the picklist add-team validation (BUG-11): only event
// teams that aren't already on the list may be added.
import { describe, it, expect } from 'vitest';
import { validateAddTeam } from '@/dash/PicklistView';

const EVENT = new Set([254, 1678, 9999]);
const EMPTY: ReadonlySet<number> = new Set<number>();

describe('validateAddTeam', () => {
  it('accepts a valid event team not already on the list', () => {
    expect(validateAddTeam('254', EMPTY, EVENT)).toEqual({ ok: true, teamNumber: 254 });
    // surrounding whitespace is trimmed
    expect(validateAddTeam('  1678 ', EMPTY, EVENT)).toEqual({ ok: true, teamNumber: 1678 });
  });

  it('rejects a team not competing at the event (BUG-11)', () => {
    const res = validateAddTeam('99999', EMPTY, EVENT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not competing/i);
  });

  it('rejects a team already on the picklist', () => {
    const res = validateAddTeam('254', new Set([254]), EVENT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/already on this list/i);
  });

  it('rejects non-numeric, zero, negative, and fractional input', () => {
    for (const bad of ['abc', '', '0', '-5', '12.5']) {
      const res = validateAddTeam(bad, EMPTY, EVENT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/valid team number/i);
    }
  });

  it('does not gate on membership when the event team list is empty (offline)', () => {
    // No team list loaded yet → still allow adding so the picklist stays usable.
    expect(validateAddTeam('99999', EMPTY, EMPTY)).toEqual({ ok: true, teamNumber: 99999 });
  });
});
