import { describe, expect, it } from 'vitest';
import {
  baseTeamNumber,
  formatTeam,
  isLetterTeam,
  parseTeamKey,
  teamKeyOf,
} from '@/lib/teamKey';
import { tbaMatchToRow, teamNum } from '../../../supabase/functions/_shared/tbaMatchRow';

describe('teamKey (offseason lettered robots)', () => {
  it('parses plain and lettered TBA keys to distinct ints', () => {
    expect(parseTeamKey('frc254')).toBe(254);
    expect(parseTeamKey('frc254B')).toBe(100254);
    expect(parseTeamKey('frc254b')).toBe(100254);
    expect(parseTeamKey('frc3256C')).toBe(203256);
    expect(parseTeamKey('254B')).toBe(100254);
    expect(parseTeamKey(254)).toBe(254);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', 'frc', 'frc0', 'frc254BB', 'frc254Z', 'frcabc', 'frc-1', null, undefined, NaN, 0, -3]) {
      expect(parseTeamKey(bad)).toBeNull();
    }
  });

  it('round-trips display and TBA key forms', () => {
    expect(formatTeam(254)).toBe('254');
    expect(formatTeam(100254)).toBe('254B');
    expect(teamKeyOf(100254)).toBe('frc254B');
    expect(teamKeyOf(3256)).toBe('frc3256');
    expect(baseTeamNumber(100254)).toBe(254);
    expect(isLetterTeam(100254)).toBe(true);
    expect(isLetterTeam(9999)).toBe(false);
    expect(formatTeam(null)).toBe('');
  });

  it('stays inside the RPCs 1..999999 team bound', () => {
    expect(parseTeamKey('frc99999J')).toBeLessThanOrEqual(999999);
  });

  it('server match mapping keeps the B robot distinct from its A team', () => {
    expect(teamNum('frc254B')).toBe(100254);
    const row = tbaMatchToRow(
      {
        key: '2026mttd_qm1',
        event_key: '2026mttd',
        comp_level: 'qm',
        match_number: 1,
        set_number: 1,
        alliances: {
          red: { score: -1, team_keys: ['frc254', 'frc254B', 'frc3256'] },
          blue: { score: -1, team_keys: ['frc1', 'frc2', 'frc3'] },
        },
      },
      '2026mttd',
    );
    expect(row?.row.red1).toBe(254);
    expect(row?.row.red2).toBe(100254);
  });
});
