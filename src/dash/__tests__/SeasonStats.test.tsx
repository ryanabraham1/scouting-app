// src/dash/__tests__/SeasonStats.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import SeasonStats, {
  inHouseEpaForTeam,
  seasonRecordFromTbaMatches,
} from '@/dash/SeasonStats';
import type { MatchRow } from '@/dash/useEventData';

let seq = 0;
function match(o: Partial<MatchRow>): MatchRow {
  seq += 1;
  return {
    match_key: `2026evt_qm${o.match_number ?? seq}`,
    event_key: '2026evt',
    comp_level: 'qm',
    match_number: o.match_number ?? seq,
    scheduled_time: null,
    red1: null,
    red2: null,
    red3: null,
    blue1: null,
    blue2: null,
    blue3: null,
    actual_red_score: null,
    actual_blue_score: null,
    winner: null,
    result_synced_at: null,
    ...o,
  };
}

beforeEach(() => {
  cleanup();
});

describe('inHouseEpaForTeam', () => {
  const played: MatchRow[] = [
    match({
      match_number: 1,
      red1: 1,
      red2: 2,
      red3: 3,
      blue1: 4,
      blue2: 5,
      blue3: 6,
      actual_red_score: 90,
      actual_blue_score: 60,
    }),
    match({
      match_number: 2,
      red1: 1,
      red2: 7,
      red3: 8,
      blue1: 4,
      blue2: 9,
      blue3: 10,
      actual_red_score: 110,
      actual_blue_score: 50,
    }),
  ];

  it('returns a finite number for a participating team', () => {
    const epa = inHouseEpaForTeam(played, 1);
    expect(epa).not.toBeNull();
    expect(Number.isFinite(epa as number)).toBe(true);
  });

  it('returns null for a team absent from all matches', () => {
    expect(inHouseEpaForTeam(played, 9999)).toBeNull();
  });

  it('returns null for empty matches', () => {
    expect(inHouseEpaForTeam([], 1)).toBeNull();
  });
});

describe('seasonRecordFromTbaMatches', () => {
  // Minimal TBA Match shape: alliances with team_keys + score, and winning_alliance.
  const m = (
    redKeys: string[],
    blueKeys: string[],
    redScore: number,
    blueScore: number,
    winner: 'red' | 'blue' | '',
    extra: Record<string, unknown> = {},
  ) => ({
    alliances: {
      red: { team_keys: redKeys, score: redScore, ...(extra.red as object) },
      blue: { team_keys: blueKeys, score: blueScore, ...(extra.blue as object) },
    },
    winning_alliance: winner,
  });

  it('counts wins, losses, and ties across quals + playoffs', () => {
    const matches = [
      m(['frc3256', 'frc1', 'frc2'], ['frc4', 'frc5', 'frc6'], 100, 80, 'red'), // win
      m(['frc7', 'frc8', 'frc9'], ['frc3256', 'frc10', 'frc11'], 90, 70, 'red'), // loss (on blue)
      m(['frc3256', 'frc1', 'frc2'], ['frc4', 'frc5', 'frc6'], 60, 60, ''), // tie
    ];
    expect(seasonRecordFromTbaMatches(matches, 3256)).toBe('1-1-1');
  });

  it('skips unplayed matches (alliance score of -1)', () => {
    const matches = [
      m(['frc3256'], ['frc4'], 100, 80, 'red'), // win
      m(['frc3256'], ['frc4'], -1, -1, ''), // not yet played → ignored
    ];
    expect(seasonRecordFromTbaMatches(matches, 3256)).toBe('1-0-0');
  });

  it('skips surrogate appearances', () => {
    const matches = [
      m(['frc3256'], ['frc4'], 100, 80, 'red'), // counts
      m(['frc3256'], ['frc4'], 50, 90, 'blue', {
        red: { surrogate_team_keys: ['frc3256'] },
      }), // surrogate → ignored, not a loss
    ];
    expect(seasonRecordFromTbaMatches(matches, 3256)).toBe('1-0-0');
  });

  it('ignores matches the team is not in', () => {
    const matches = [m(['frc1'], ['frc4'], 100, 80, 'red')];
    expect(seasonRecordFromTbaMatches(matches, 3256)).toBeNull();
  });

  it('returns null for non-arrays and garbage shapes', () => {
    expect(seasonRecordFromTbaMatches(null, 3256)).toBeNull();
    expect(seasonRecordFromTbaMatches('nope', 3256)).toBeNull();
    expect(seasonRecordFromTbaMatches([{}, { alliances: {} }], 3256)).toBeNull();
  });
});

describe('SeasonStats rendering', () => {
  it('shows match13 values and NO in-house badge', () => {
    render(
      <SeasonStats
        team={3256}
        worldRank={18}
        totalEpa={42.7}
        epaSource="match13"
        seasonRecord="12-3-1"
      />,
    );
    expect(screen.getByTestId('dash-season-rank')).toBeTruthy();
    expect(screen.getByTestId('dash-season-record').textContent).toBe('12-3-1');
    expect(screen.getByTestId('dash-season-world-rank').textContent).toBe('#18');
    expect(screen.getByTestId('dash-season-epa').textContent).toBe('42.7');
    expect(screen.queryByTestId('dash-season-epa-source')).toBeNull();
  });

  it('shows the in-house badge when epaSource is inhouse', () => {
    render(
      <SeasonStats
        team={3256}
        worldRank={null}
        totalEpa={29.4}
        epaSource="inhouse"
        seasonRecord={null}
      />,
    );
    expect(screen.getByTestId('dash-season-epa').textContent).toBe('29.4');
    const badge = screen.getByTestId('dash-season-epa-source');
    expect(badge.textContent).toMatch(/in-house/i);
    // World rank and record fall back to em-dash.
    expect(screen.getByTestId('dash-season-world-rank').textContent).toBe('—');
    expect(screen.getByTestId('dash-season-record').textContent).toBe('—');
  });

  it('renders em-dash for null EPA and shows no badge for source none', () => {
    render(
      <SeasonStats
        team={3256}
        worldRank={null}
        totalEpa={null}
        epaSource="none"
        seasonRecord={null}
      />,
    );
    expect(screen.getByTestId('dash-season-epa').textContent).toBe('—');
    expect(screen.queryByTestId('dash-season-epa-source')).toBeNull();
  });
});
