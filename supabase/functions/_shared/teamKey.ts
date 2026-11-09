// supabase/functions/_shared/teamKey.ts
//
// TBA team keys -> the integer team numbers every table and RPC uses, and back.
//
// Offseason events (2026mttd, ...) run second robots as lettered teams: TBA
// names them `frc254B` in match alliances and rankings. Team identity is an
// `int` everywhere (team, event_team, match.red1..blue3, reports), so a
// lettered team is encoded into a reserved range instead of a schema change:
//
//   frc254   ->    254
//   frc254B  -> 100254   (letter index * LETTER_TEAM_BASE + base number)
//   frc254C  -> 200254
//
// Real FRC numbers stay far below LETTER_TEAM_BASE, and the largest encoding
// (J suffix, 9xxxxx) stays inside every RPC's `between 1 and 999999` check.
// Before this, the server parsed `frc254B` with parseInt (-> 254, silently
// merging the B robot into the A team) and the client with Number (-> NaN,
// dropping the B robot entirely).
//
// Pure, import-free: the client re-exports it from src/lib/teamKey.ts so both
// sides share one implementation.

export const LETTER_TEAM_BASE = 100_000;

const KEY_RE = /^(?:frc)?(\d{1,5})([A-Ja-j])?$/i;

/** `frc254` -> 254, `frc254B` -> 100254, `254B` -> 100254; anything else -> null. */
export function parseTeamKey(key: unknown): number | null {
  if (typeof key === "number") {
    return Number.isSafeInteger(key) && key > 0 && key < LETTER_TEAM_BASE * 10 ? key : null;
  }
  if (typeof key !== "string") return null;
  const m = KEY_RE.exec(key.trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (!(base > 0) || base >= LETTER_TEAM_BASE) return null;
  const letter = m[2] ? m[2].toUpperCase().charCodeAt(0) - 65 : 0; // A=0 (plain), B=1, ...
  return letter * LETTER_TEAM_BASE + base;
}

/** The plain FRC team behind a (possibly lettered) team: 100254 -> 254. */
export function baseTeamNumber(team: number): number {
  return team % LETTER_TEAM_BASE;
}

/** The suffix letter of a lettered team ("B"), or "" for a plain team. */
export function teamLetter(team: number): string {
  const idx = Math.floor(team / LETTER_TEAM_BASE);
  return idx > 0 && idx < 10 ? String.fromCharCode(65 + idx) : "";
}

/** True for an encoded lettered team (a B/C robot). */
export function isLetterTeam(team: number): boolean {
  return teamLetter(team) !== "";
}

/** Display form: 254 -> "254", 100254 -> "254B". Non-numbers pass through. */
export function formatTeam(team: number | null | undefined): string {
  if (team == null || !Number.isFinite(team)) return "";
  return `${baseTeamNumber(team)}${teamLetter(team)}`;
}

/** TBA key form: 254 -> "frc254", 100254 -> "frc254B". */
export function teamKeyOf(team: number): string {
  return `frc${formatTeam(team)}`;
}
