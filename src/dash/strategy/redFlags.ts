// src/dash/strategy/redFlags.ts
// Red-flag synthesis for the Strategy tab's team cards: the things a drive
// coach must know about a partner/opponent BEFORE the match, distilled from
// that team's raw scouted reports. Pure client-side derivation over MsrRow —
// no new columns, no wire change. Flags are worded as facts with counts
// ("Died in 2 of 5 scouted matches"), never vibes.

import type { MsrRow } from '@/dash/types';

export interface RedFlag {
  severity: 'high' | 'med';
  /** Short, fact-shaped sentence with counts. */
  text: string;
  /** Stable key for testing/rendering. */
  kind:
    | 'died'
    | 'no-show'
    | 'tipped'
    | 'climb-fails'
    | 'major-fouls'
    | 'foul-prone'
    | 'defense-specialist'
    | 'drops-fuel';
}

/** Approximate teleop length used for the defense time share (2:15). */
const TELEOP_MS = 135_000;

/** Teleop share above which a team reads as a dedicated defense bot. */
export const DEFENSE_PRIMARY_SHARE = 0.4;
/** Teleop share above which defense is a regular part of their game. */
export const DEFENSE_REGULAR_SHARE = 0.15;

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Derive red flags from one team's scouted reports. Ordered most-severe first.
 * Empty input (unscouted team) yields no flags — absence of data is shown by
 * the card's "scouted: 0", not by a fake all-clear.
 */
export function teamRedFlags(reports: MsrRow[]): RedFlag[] {
  const n = reports.length;
  if (n === 0) return [];
  const flags: RedFlag[] = [];

  // Robot died / lost comms mid-match. One occurrence is worth a mention; a
  // repeat (or a third of their matches) is a serious reliability risk.
  const died = reports.filter((r) => r.died).length;
  if (died > 0) {
    flags.push({
      kind: 'died',
      severity: died >= 2 || died / n >= 1 / 3 ? 'high' : 'med',
      text: `Died / lost comms in ${died} of ${n} scouted matches`,
    });
  }

  // Never showed up to the field.
  const noShows = reports.filter((r) => r.no_show).length;
  if (noShows > 0) {
    flags.push({
      kind: 'no-show',
      severity: 'high',
      text: `No-showed ${noShows} of ${n} scouted matches`,
    });
  }

  // Tipped over — usually a center-of-gravity problem that recurs.
  const tipped = reports.filter((r) => r.tipped).length;
  if (tipped > 0) {
    flags.push({
      kind: 'tipped',
      severity: tipped >= 2 ? 'high' : 'med',
      text: `Tipped over in ${tipped} of ${n} scouted matches`,
    });
  }

  // Climb attempts that fail half the time are endgame points you can't plan on.
  const attempts = reports.filter((r) => r.climb_attempted).length;
  const fails = reports.filter((r) => r.climb_attempted && !r.climb_success).length;
  if (attempts >= 2 && fails / attempts >= 0.5) {
    flags.push({
      kind: 'climb-fails',
      severity: fails === attempts ? 'high' : 'med',
      text: `Failed ${fails} of ${attempts} climb attempts`,
    });
  }

  // Foul trouble: majors are match-changing; a steady minor-foul habit adds up.
  const majors = reports.reduce((s, r) => s + (r.fouls_major ?? 0), 0);
  const minors = reports.reduce((s, r) => s + (r.fouls_minor ?? 0), 0);
  if (majors > 0) {
    flags.push({
      kind: 'major-fouls',
      severity: 'high',
      text: `${majors} major foul${majors === 1 ? '' : 's'} across ${n} scouted matches`,
    });
  }
  if (minors / n >= 2) {
    flags.push({
      kind: 'foul-prone',
      severity: 'med',
      text: `Averages ${(minors / n).toFixed(1)} minor fouls per match`,
    });
  }

  // Defense identity: how much of teleop they spend playing defense. Uses the
  // timed intervals when scouted; falls back to the per-match defense rating
  // (>0 means they played some) when durations were never captured.
  const timed = reports.filter((r) => (r.defense_duration_ms ?? 0) > 0 || r.defense_intervals != null);
  const defenseMs = reports.reduce((s, r) => s + (r.defense_duration_ms ?? 0), 0);
  const share = defenseMs / (n * TELEOP_MS);
  if (timed.length > 0 && share >= DEFENSE_REGULAR_SHARE) {
    flags.push({
      kind: 'defense-specialist',
      severity: 'med',
      text:
        share >= DEFENSE_PRIMARY_SHARE
          ? `Primarily a defense bot — on defense ~${pct(share)} of teleop`
          : `Plays regular defense — ~${pct(share)} of teleop`,
    });
  } else if (timed.length === 0) {
    const defMatches = reports.filter((r) => r.defense_rating > 0).length;
    if (defMatches / n >= 0.5) {
      flags.push({
        kind: 'defense-specialist',
        severity: 'med',
        text: `Played defense in ${defMatches} of ${n} scouted matches`,
      });
    }
  }

  // Chronic fuel dropping — matters when planning feeding lanes around them.
  const drops = reports.filter((r) => r.dropped_fuel).length;
  if (drops >= 2) {
    flags.push({
      kind: 'drops-fuel',
      severity: 'med',
      text: `Dropped fuel in ${drops} of ${n} scouted matches`,
    });
  }

  return flags.sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'));
}
