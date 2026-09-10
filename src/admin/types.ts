export interface AssignMatch {
  matchKey: string;
  redTeams: [number, number, number];
  blueTeams: [number, number, number];
}

export interface AssignScout {
  id: string;
  displayName: string;
  unavailableMatchKeys?: string[];
}

export interface AssignTeam {
  teamNumber: number;
  nickname: string | null;
}

export interface AssignOptions {
  ownTeam: number;
  rotatePositions: boolean;
  /** Assignment strategy. Omitted callers retain the standard balanced mode. */
  scheduleMode?: 'balanced' | 'blocked';
  /**
   * When there's slack (more scouts than seats in a match), avoid handing a
   * scout two matches in a row. Optional; treated as `true` when omitted so
   * existing callers keep their current spread-out behavior.
   */
  avoidBackToBack?: boolean;
  /**
   * In blocked mode, how many assignments a scout completes before their
   * longer break. Gaps between those assignments do not reset the count.
   */
  blockAssignments?: number;
  /**
   * In blocked mode, how many full event matches sit between assignments in a
   * work block. 0 allows consecutive matches, 1 means every other match, etc.
   */
  spacingMatches?: number;
  /**
   * In blocked mode, how many full event matches a scout rests after finishing
   * a work block. Scheduling constraints are preferences: coverage wins when
   * the available scout pool cannot satisfy both.
   */
  breakLength?: number;
}

export interface AutoAssignmentPlan {
  assignments: Assignment[];
  /** Match keys where a spacing or break preference had to be relaxed. */
  relaxedMatchKeys: string[];
}

export type AllianceColor = 'red' | 'blue';

export interface Assignment {
  matchKey: string;
  scoutId: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface PitAssignment {
  teamNumber: number;
  scoutId: string;
  source: 'manual' | 'auto';
}

export type AssignmentBatchKind = 'match' | 'pit';

export interface AssignmentBatchState {
  status: 'authoritative';
  revision: number;
  count: number;
}

export interface AssignmentPublishResult {
  status: 'applied' | 'idempotent' | 'conflict';
  revision: number;
  count: number;
}

export interface MatchAssignmentSnapshot {
  state: AssignmentBatchState;
  assignments: Assignment[];
}

export interface PitAssignmentSnapshot {
  state: AssignmentBatchState;
  assignments: PitAssignment[];
}
