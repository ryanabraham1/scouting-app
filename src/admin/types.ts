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
  breakEveryN: number;
  rotatePositions: boolean;
  /**
   * When there's slack (more scouts than seats in a match), avoid handing a
   * scout two matches in a row. Optional; treated as `true` when omitted so
   * existing callers keep their current spread-out behavior.
   */
  avoidBackToBack?: boolean;
  /**
   * How many matches a scout rests once they hit `breakEveryN` consecutive
   * matches. Optional; treated as `1` when omitted (the prior implicit behavior).
   * The rest is a SOFT preference — a slot is never left unscouted to honor it.
   */
  breakLength?: number;
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
