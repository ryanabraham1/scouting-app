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

export interface AssignOptions {
  ownTeam: number;
  breakEveryN: number;
  rotatePositions: boolean;
}

export type AllianceColor = 'red' | 'blue';

export interface Assignment {
  matchKey: string;
  scoutId: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}
