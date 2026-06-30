// src/dash/useMultiScoutConflicts.ts
// React hook wrapping the pure `detectMultiScoutReports` detector. Memoizes the
// O(n) detection over the supplied reports and exposes O(1) lookup maps for the
// render loops in MatchView / TeamView / ReportDetail:
//   - byRobotKey: robotKey(r) -> group   (MatchView tiles + ReportDetail sibling)
//   - byReportKey: reportKey(r) -> group  (per-row identity lookup)
//   - byTeam: target_team_number -> group[]  (TeamView per-team derivation)
// Plus the robotKey/reportKey helpers re-exported so callers don't import two
// modules. Recomputes ONLY when the `reports` array identity changes.

import { useMemo } from 'react';
import {
  detectMultiScoutReports,
  robotKey,
  reportKey,
} from '@/dash/reconcile';
import type { MsrRow, MultiScoutGroup } from '@/dash/types';

export interface MultiScoutConflicts {
  groups: MultiScoutGroup[];
  byRobotKey: Map<string, MultiScoutGroup>;
  byReportKey: Map<string, MultiScoutGroup>;
  byTeam: Map<number, MultiScoutGroup[]>;
  robotKey: (r: MsrRow) => string;
  reportKey: (r: MsrRow) => string;
}

export function useMultiScoutConflicts(reports: MsrRow[]): MultiScoutConflicts {
  return useMemo(() => {
    const groups = detectMultiScoutReports(reports);
    const byRobotKey = new Map<string, MultiScoutGroup>();
    const byReportKey = new Map<string, MultiScoutGroup>();
    const byTeam = new Map<number, MultiScoutGroup[]>();
    for (const g of groups) {
      // Robot key is scout-independent; one group per robot.
      byRobotKey.set(`${g.matchKey}|${g.teamNumber}|${g.allianceColor}|${g.station}`, g);
      for (const r of g.reports) byReportKey.set(reportKey(r), g);
      const bucket = byTeam.get(g.teamNumber);
      if (bucket) bucket.push(g);
      else byTeam.set(g.teamNumber, [g]);
    }
    return { groups, byRobotKey, byReportKey, byTeam, robotKey, reportKey };
  }, [reports]);
}
