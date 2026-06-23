// src/auth/__tests__/roles.test.ts
import { describe, it, expect } from 'vitest';
import { hasRole, ROLE_RANK, type Role } from '../roles';

describe('roles', () => {
  it('ranks scouter < lead < admin', () => {
    expect(ROLE_RANK.scouter).toBeLessThan(ROLE_RANK.lead);
    expect(ROLE_RANK.lead).toBeLessThan(ROLE_RANK.admin);
  });

  it('admin satisfies every required role', () => {
    const reqs: Role[] = ['scouter', 'lead', 'admin'];
    for (const r of reqs) expect(hasRole('admin', r)).toBe(true);
  });

  it('lead satisfies scouter and lead but not admin', () => {
    expect(hasRole('lead', 'scouter')).toBe(true);
    expect(hasRole('lead', 'lead')).toBe(true);
    expect(hasRole('lead', 'admin')).toBe(false);
  });

  it('scouter satisfies only scouter', () => {
    expect(hasRole('scouter', 'scouter')).toBe(true);
    expect(hasRole('scouter', 'lead')).toBe(false);
    expect(hasRole('scouter', 'admin')).toBe(false);
  });

  it('null/undefined actual never satisfies', () => {
    expect(hasRole(null, 'scouter')).toBe(false);
    expect(hasRole(undefined, 'scouter')).toBe(false);
  });
});
