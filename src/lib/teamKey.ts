// Single source of truth shared with the Edge Functions (TBA key <-> int team,
// including offseason lettered robots like frc254B). See the module header.
export {
  LETTER_TEAM_BASE,
  parseTeamKey,
  baseTeamNumber,
  teamLetter,
  isLetterTeam,
  formatTeam,
  teamKeyOf,
} from '../../supabase/functions/_shared/teamKey';
