// src/auth/roles.ts
export type Role = 'scouter' | 'lead' | 'admin';

export const ROLE_RANK: Record<Role, number> = {
  scouter: 0,
  lead: 1,
  admin: 2,
};

/** True when `actual` is at least as privileged as `required`. */
export function hasRole(actual: Role | null | undefined, required: Role): boolean {
  if (actual == null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
