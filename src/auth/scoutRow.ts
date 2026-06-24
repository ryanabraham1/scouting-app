// src/auth/scoutRow.ts
/** Mirrors the `scout` table row returned by select_scouter / read by useSession. */
export interface ScoutRow {
  id: string;
  event_key: string;
  display_name: string;
  auth_uid: string;
  created_at: string;
}
