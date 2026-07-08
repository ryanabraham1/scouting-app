// src/capture/useTeamAutoHistory.ts
// The auto routines a team has ALREADY been scouted running this event — the data
// behind the Review screen's "pick a known auto" picker. A scout who sees team 254
// run the same auto a teammate already traced can select it instead of redrawing.
//
// Two sources, merged so the picker works on a bad venue network:
//   • Dexie-local reports (this device's own captures + QR-merged), including
//     unsynced ones — always available offline.
//   • A best-effort server query for every scout's reports on this team — gives a
//     scout the routines OTHER devices traced. Skipped silently when offline.
// Deduped by match + scout (a synced local report and its server copy are one
// routine). Returns raw AutoPath[] in the ABSOLUTE field coords they were recorded
// in; the picker handles alliance re-framing. No scoring/wire-shape change.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { db } from '@/db/localStore';
import { matchLabelFromKey } from '@/capture/UpcomingMatches';
import type { AutoPath } from '@/dash/AutoHeatmap';
import type { FieldPoint } from '@/components/FieldDiagram';

/** Same rule the dashboard uses (AutoRoutines.hasAutoData): a start or a path. */
function hasAuto(
  start: FieldPoint | null | undefined,
  path: FieldPoint[] | null | undefined,
): boolean {
  return start != null || (path?.length ?? 0) > 0;
}

interface ServerAutoRow {
  match_key: string;
  alliance_color: string | null;
  scout_id: string | null;
  auto_start_position: FieldPoint | null;
  auto_path: FieldPoint[] | null;
}

export interface TeamAutoHistory {
  /** Distinct prior routines for the team (absolute-frame coords). */
  autos: AutoPath[];
  /** True while the first load is in flight (so the UI can avoid a flash). */
  loading: boolean;
}

/**
 * Prior auto routines for `teamNumber` at `eventKey`. `excludeMatchKey` drops the
 * match currently being scouted so an edit/resume never offers its own auto back.
 * `enabled` gates the lookup (e.g. only fetch once the auto step is reached).
 */
export function useTeamAutoHistory(
  eventKey: string,
  teamNumber: number,
  options?: { excludeMatchKey?: string; enabled?: boolean },
): TeamAutoHistory {
  const enabled = options?.enabled ?? true;
  const excludeMatchKey = options?.excludeMatchKey;
  const [autos, setAutos] = useState<AutoPath[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !eventKey || !teamNumber) {
      setAutos([]);
      setLoading(false); // clear any in-flight loading flag when the hook is disabled
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      // Keyed by match+scout so a synced local report and its server twin collapse
      // to a single routine. Server wins on a tie (it's the canonical copy).
      const byKey = new Map<string, AutoPath>();

      // Local first — always available, even with zero network.
      try {
        const local = await db.reports.where('targetTeamNumber').equals(teamNumber).toArray();
        for (const r of local) {
          if (r.eventKey !== eventKey) continue;
          if (excludeMatchKey && r.matchKey === excludeMatchKey) continue;
          if (!hasAuto(r.autoStartPosition, r.autoPath)) continue;
          byKey.set(`${r.matchKey}:${r.scoutId ?? ''}`, {
            matchKey: r.matchKey,
            label: matchLabelFromKey(r.matchKey),
            start: r.autoStartPosition ?? null,
            path: r.autoPath ?? null,
            alliance: r.allianceColor === 'blue' ? 'blue' : 'red',
          });
        }
      } catch {
        /* Dexie read failed: fall through to whatever the server returns. */
      }

      // Then the server — gives this scout the routines OTHER devices traced.
      // Offline / RLS error: keep the local-only set.
      try {
        const { data } = await supabase
          .from('match_scouting_report')
          .select('match_key,alliance_color,scout_id,auto_start_position,auto_path')
          .eq('event_key', eventKey)
          .eq('target_team_number', teamNumber)
          .eq('deleted', false);
        for (const r of (data ?? []) as ServerAutoRow[]) {
          if (excludeMatchKey && r.match_key === excludeMatchKey) continue;
          if (!hasAuto(r.auto_start_position, r.auto_path)) continue;
          byKey.set(`${r.match_key}:${r.scout_id ?? ''}`, {
            matchKey: r.match_key,
            label: matchLabelFromKey(r.match_key),
            start: r.auto_start_position ?? null,
            path: r.auto_path ?? null,
            alliance: r.alliance_color === 'blue' ? 'blue' : 'red',
          });
        }
      } catch {
        /* offline / network failure: local-only history is fine. */
      }

      if (!cancelled) {
        setAutos([...byKey.values()]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey, teamNumber, excludeMatchKey, enabled]);

  return { autos, loading };
}
