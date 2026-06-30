// src/dash/allianceSimulator.ts
// Pure, deterministic alliance simulation for the Lead Dashboard's Alliance tab.
// Delegates the projected-score / win-prob blend to predictMatch (src/dash/predict.ts)
// so the alliance score is consistent with the Next Match tab to the penny.
// Role classification + gap summary are local heuristics over match aggregates and
// (when present) pit capability/strategy. No React, no I/O — never throws on missing data.

import { predictMatch } from './predict';
import type { ComponentBreakdown } from './predict';
import type { TeamAgg, ComponentFraction } from './aggregate';
import type { TeamPit } from './useTeamPit';

export type RoleStatus = 'strong' | 'partial' | 'none' | 'unknown';
export type SourceTag = 'blend' | 'scouting' | 'epa' | 'none';

export interface TeamRoleRead {
  teamNumber: number;
  matchesScouted: number;
  hasPit: boolean;
  /** expected-points source (from predictTeam via predictMatch) */
  source: SourceTag;
  /** per-team expected points */
  expected: number;
  roles: {
    auto: RoleStatus;
    fuel: RoleStatus;
    defense: RoleStatus;
    climbL1: RoleStatus;
    /** L2 or L3 climb */
    climbL23: RoleStatus;
  };
}

export interface RoleGap {
  kind: 'gap' | 'surplus' | 'note';
  text: string;
}

export interface AllianceSimulation {
  /** length 3 (or fewer while building) */
  teamReads: TeamRoleRead[];
  /** sum of per-team expected */
  projectedScore: number;
  scoreSource: 'blend' | 'scouting' | 'epa' | 'mixed' | 'none';
  /** mean per-team w (predictMatch.confidence semantics) */
  confidence: number;
  /** vs the chosen baseline; null if no (3-team) baseline */
  redWinProb: number | null;
  /** ordered, human-readable */
  gaps: RoleGap[];
}

// --- role classification thresholds (exported for the unit test) -------------
export const FUEL_STRONG = 30; // meanFuelPoints >= 30 → strong fuel scorer
export const FUEL_PARTIAL = 10; // >= 10 → partial
export const DEFENSE_STRONG = 3.5; // avgDefenseRating (0..5) >= 3.5 → strong defender
export const DEFENSE_PARTIAL = 2; // >= 2 → partial
export const CLIMB_RATE_CONFIRM = 0.5; // climbSuccessRate >= 0.5 confirms a pit-claimed climb
export const CLIMB_L23_POINTS = 18; // meanClimbPoints >= 18 implies a habitual L2/L3 climb
/** auto fuel scored to confirm a pit-claimed auto routine as strong. */
export const AUTO_FUEL_STRONG = 5;
/** estimated auto POINTS (EPA fallback) at/above which an unscouted team is
 *  credited a partial auto contribution. */
export const EST_AUTO_PARTIAL = 2;
/** reliability below this flags a no-show/died risk note. */
export const RELIABILITY_RISK = 0.7;

export interface SimulateInput {
  /** the up-to-3 selected teams (red) */
  pickedTeams: number[];
  /** the baseline alliance (blue); [] when none chosen yet */
  baselineTeams: number[];
  agg: Map<number, TeamAgg>;
  epaByTeam: Map<number, number | null>;
  pits: Map<number, TeamPit>;
  statboticsAvailable: boolean;
  /**
   * OPTIONAL fitted component fraction — enables OUR EPA-based auto/fuel role
   * estimate for unscouted teams (predictMatch attaches a `components` split).
   * Omit → byte-identical to before (unscouted roles read "?").
   */
  fraction?: ComponentFraction;
  /** OPTIONAL played-match count gating the EPA split (see predict.ts). */
  playedMatches?: number;
}

function pitCapabilities(pit: TeamPit | undefined): string[] {
  return pit?.capabilities ?? [];
}
function pitStrategy(pit: TeamPit | undefined): string[] {
  return pit?.matchStrategy ?? [];
}

/**
 * Role read for an UNSCOUTED team (no pit, no matches) from our EPA-based
 * estimate — the auto/fuel decomposition predictMatch derives from the
 * event-wide fitted fraction. Only auto & fuel are knowable this way (climb is
 * never fabricated from EPA, defense is scouting-only), so the rest stay
 * 'unknown'. Estimated roles cap at 'partial' so an EPA guess never reads as a
 * CONFIRMED ('strong' ✓) capability. Falls back to all-unknown when there is no
 * usable estimate (Statbotics down / not enough played matches / no EPA).
 */
function rolesFromEstimate(estimate: ComponentBreakdown | undefined): TeamRoleRead['roles'] {
  const unknown: TeamRoleRead['roles'] = {
    auto: 'unknown',
    fuel: 'unknown',
    defense: 'unknown',
    climbL1: 'unknown',
    climbL23: 'unknown',
  };
  if (!estimate || estimate.source !== 'epa') return unknown;
  const fuel: RoleStatus = estimate.fuel >= FUEL_PARTIAL ? 'partial' : 'none';
  const auto: RoleStatus = estimate.auto >= EST_AUTO_PARTIAL ? 'partial' : 'none';
  return { ...unknown, auto, fuel };
}

/**
 * Classify a single team's role coverage from its match aggregate (may be
 * undefined for an unscouted team) and pit report (may be undefined). Pit
 * capability is authoritative when present; match aggregates confirm/upgrade.
 * `estimate` is OUR EPA-based auto/fuel calculation — used only when the team
 * has neither pit nor match data, so the table shows an estimate instead of "?".
 */
export function classifyRoles(
  agg: TeamAgg | undefined,
  pit: TeamPit | undefined,
  estimate?: ComponentBreakdown,
): TeamRoleRead['roles'] {
  const hasPit = pit !== undefined;
  const matches = agg?.matchesScouted ?? 0;

  // No pit AND no matches → fall back to our estimated auto/fuel calculation
  // (everything the estimate can't speak to stays unknown).
  if (!hasPit && matches === 0) {
    return rolesFromEstimate(estimate);
  }

  const caps = pitCapabilities(pit);
  const strat = pitStrategy(pit);

  const meanAutoFuel = agg?.meanAutoFuel ?? 0;
  const meanFuelPoints = agg?.meanFuelPoints ?? 0;
  const avgDefenseRating = agg?.avgDefenseRating ?? 0;
  const climbSuccessRate = agg?.climbSuccessRate ?? 0;
  const avgClimbLevel = agg?.avgClimbLevel ?? 0;
  const meanClimbPoints = agg?.meanClimbPoints ?? 0;

  // --- auto -----------------------------------------------------------------
  // ONLY clean auto signals: pit `auto` capability + meanAutoFuel (NOT
  // meanClimbPoints, which folds teleop + auto-climb bonus together).
  const pitAuto = caps.includes('auto');
  const autoFuelSignal = meanAutoFuel > 0;
  let auto: RoleStatus;
  if (pitAuto && meanAutoFuel >= AUTO_FUEL_STRONG) auto = 'strong';
  else if (pitAuto || autoFuelSignal) auto = 'partial';
  else auto = 'none';

  // --- fuel -----------------------------------------------------------------
  let fuel: RoleStatus;
  if (meanFuelPoints >= FUEL_STRONG) fuel = 'strong';
  else if (meanFuelPoints >= FUEL_PARTIAL) fuel = 'partial';
  else if (meanFuelPoints > 0) fuel = 'partial';
  else fuel = 'none';
  // Pit score/cycle strategy bumps a 0-match `none` up to partial (claimed).
  if (fuel === 'none' && matches === 0 && (strat.includes('score') || strat.includes('cycle'))) {
    fuel = 'partial';
  }

  // --- defense --------------------------------------------------------------
  const pitDefender = caps.includes('defense') || strat.includes('defend');
  let defense: RoleStatus;
  if (avgDefenseRating >= DEFENSE_STRONG) defense = 'strong';
  else if (avgDefenseRating >= DEFENSE_PARTIAL || (pitDefender && matches === 0)) defense = 'partial';
  else defense = 'none';

  // --- climb L1 -------------------------------------------------------------
  const pitL1 = caps.includes('climb_l1');
  const matchClimbConfirmed = avgClimbLevel >= 1 && climbSuccessRate >= CLIMB_RATE_CONFIRM;
  let climbL1: RoleStatus;
  if (pitL1 && matchClimbConfirmed) climbL1 = 'strong';
  else if (pitL1) climbL1 = 'partial';
  else if (matchClimbConfirmed) climbL1 = 'partial';
  else climbL1 = 'none';

  // --- climb L2/L3 ----------------------------------------------------------
  const pitL23 = caps.includes('climb_l2') || caps.includes('climb_l3');
  const matchHighClimb = meanClimbPoints >= CLIMB_L23_POINTS;
  let climbL23: RoleStatus;
  if (pitL23 && (matchHighClimb || avgClimbLevel >= 2)) climbL23 = 'strong';
  else if (pitL23) climbL23 = 'partial';
  else if (matchHighClimb) climbL23 = 'strong';
  else climbL23 = 'none';

  return { auto, fuel, defense, climbL1, climbL23 };
}

function covered(status: RoleStatus): boolean {
  return status === 'strong' || status === 'partial';
}

/**
 * Produce an ordered, human-readable gap summary for the 3-team alliance.
 * Feeder count is pit-dependent (matchStrategy.includes('feed')) and is NOT
 * synthesized from match aggregates — on match-only events it is always 0 and
 * the feeder gap will not fire (expected).
 */
export function summarizeGaps(
  reads: TeamRoleRead[],
  pits?: Map<number, TeamPit>,
): RoleGap[] {
  const gaps: RoleGap[] = [];

  const anyClimbL23Strong = reads.filter((r) => r.roles.climbL23 === 'strong').length;
  const anyClimbL23 = reads.some((r) => r.roles.climbL23 !== 'none' && r.roles.climbL23 !== 'unknown');
  const anyClimbAtAll = reads.some(
    (r) =>
      (r.roles.climbL1 !== 'none' && r.roles.climbL1 !== 'unknown') ||
      (r.roles.climbL23 !== 'none' && r.roles.climbL23 !== 'unknown'),
  );

  // --- Climb ----------------------------------------------------------------
  if (!anyClimbAtAll) {
    gaps.push({ kind: 'gap', text: 'No climber — 0 endgame points' });
  } else {
    if (!anyClimbL23) gaps.push({ kind: 'gap', text: 'No L2/L3 climber' });
    if (anyClimbL23Strong >= 2) gaps.push({ kind: 'note', text: 'Double high climb available' });
  }

  // --- Defense --------------------------------------------------------------
  const defenders = reads.filter((r) => covered(r.roles.defense)).length;
  if (defenders === 0) gaps.push({ kind: 'gap', text: 'No dedicated defender' });

  // Feeder count is pit-only (matchStrategy.includes('feed')).
  const feeders = pits
    ? reads.filter((r) => (pits.get(r.teamNumber)?.matchStrategy ?? []).includes('feed')).length
    : 0;
  const scorers = reads.filter((r) => covered(r.roles.fuel)).length;
  if (feeders >= 2 && scorers === 0) {
    gaps.push({ kind: 'gap', text: 'Two feeders, no primary scorer' });
  }

  // --- Fuel -----------------------------------------------------------------
  if (scorers === 0) gaps.push({ kind: 'gap', text: 'No reliable fuel scorer' });

  // --- Data -----------------------------------------------------------------
  for (const r of reads) {
    if (r.source === 'none') {
      gaps.push({ kind: 'gap', text: `Team ${r.teamNumber}: no data` });
    }
  }

  // Match-only teams (have matches but no pit) → single trailing note.
  const matchOnly = reads.filter((r) => !r.hasPit && r.matchesScouted > 0).map((r) => r.teamNumber);
  if (matchOnly.length > 0) {
    gaps.push({
      kind: 'note',
      text: `Match-only role read for team${matchOnly.length > 1 ? 's' : ''} ${matchOnly.join(', ')} (no pit data)`,
    });
  }

  if (gaps.length === 0) {
    gaps.push({ kind: 'note', text: 'Balanced alliance — all core roles covered.' });
  }

  return gaps;
}

/** Reliability-risk notes appended after the core gaps (uses the agg map). */
function reliabilityNotes(reads: TeamRoleRead[], agg: Map<number, TeamAgg>): RoleGap[] {
  const out: RoleGap[] = [];
  for (const r of reads) {
    const a = agg.get(r.teamNumber);
    if (a && a.matchesScouted > 0 && a.reliability < RELIABILITY_RISK) {
      out.push({ kind: 'note', text: `Team ${r.teamNumber} reliability risk (no-show/died)` });
    }
  }
  return out;
}

/** Per-team expected points (EPA-aware), keyed by team number, for baselining. */
function expectedFor(
  team: number,
  agg: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  statboticsAvailable: boolean,
): { expected: number; source: SourceTag } {
  const pred = predictMatch({
    redTeams: [team],
    blueTeams: [],
    agg,
    epaByTeam,
    statboticsAvailable,
  });
  const t = pred.red.teams[0];
  return { expected: t.expected, source: t.source };
}

/**
 * Build the Top / Median baseline (blue alliance) from `candidates`, ranked by
 * the EPA-aware per-team expected, EXCLUDING the current picks. Returns < 3 teams
 * when exclusion leaves too few — the view renders win-prob as "—" in that case.
 */
export function pickBaseline(
  kind: 'top' | 'median',
  candidates: number[],
  picks: number[],
  agg: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  statboticsAvailable: boolean,
): number[] {
  const pickSet = new Set(picks);
  const pool = candidates.filter((t) => !pickSet.has(t));
  if (pool.length < 3) return [];

  const ranked = [...pool].sort((a, b) => {
    const ea = expectedFor(a, agg, epaByTeam, statboticsAvailable).expected;
    const eb = expectedFor(b, agg, epaByTeam, statboticsAvailable).expected;
    if (eb !== ea) return eb - ea; // descending expected
    return a - b; // stable tiebreak
  });

  if (kind === 'top') return ranked.slice(0, 3);

  // median: 3 teams centered on the median index.
  const mid = Math.floor(ranked.length / 2);
  let start = mid - 1;
  if (start < 0) start = 0;
  if (start + 3 > ranked.length) start = ranked.length - 3;
  return ranked.slice(start, start + 3);
}

/** Per-axis comparison key used by the Versus head-to-head panel. */
export type VersusAxis = 'fuel' | 'climb' | 'defense' | 'reliability';

export interface VersusAxisCompare {
  axis: VersusAxis;
  label: string;
  /** raw alliance-summed value for side A */
  a: number;
  /** raw alliance-summed value for side B */
  b: number;
  /** which side leads this axis; 'tie' when equal (or both zero) */
  winner: 'a' | 'b' | 'tie';
}

export interface VersusSimulation {
  a: AllianceSimulation;
  b: AllianceSimulation;
  /** P(A beats B) over the two projected scores, via predictMatch; null until both sides have 3 teams */
  aWinProb: number | null;
  /** per-axis comparison (fuel / climb / defense / reliability) */
  axes: VersusAxisCompare[];
}

const VERSUS_AXES: { axis: VersusAxis; label: string }[] = [
  { axis: 'fuel', label: 'Fuel' },
  { axis: 'climb', label: 'Climb' },
  { axis: 'defense', label: 'Defense' },
  { axis: 'reliability', label: 'Reliability' },
];

/** Alliance-summed (defense/reliability averaged) raw value for one axis. */
function axisValue(axis: VersusAxis, teams: number[], agg: Map<number, TeamAgg>): number {
  if (axis === 'fuel') {
    return teams.reduce((s, t) => s + (agg.get(t)?.meanFuelPoints ?? 0), 0);
  }
  if (axis === 'climb') {
    return teams.reduce((s, t) => s + (agg.get(t)?.meanClimbPoints ?? 0), 0);
  }
  if (axis === 'defense') {
    // best (max) defender on the alliance — defense is a single-robot job
    return teams.reduce((m, t) => Math.max(m, agg.get(t)?.avgDefenseRating ?? 0), 0);
  }
  // reliability: mean over teams that have any scouting; 0 when none scouted
  const live = teams.map((t) => agg.get(t)).filter((a): a is TeamAgg => a != null && a.matchesScouted > 0);
  if (live.length === 0) return 0;
  return live.reduce((s, a) => s + a.reliability, 0) / live.length;
}

/**
 * Head-to-head simulation: run simulateAlliance for each side (passing the
 * opposing 3 as the baseline so each side's redWinProb is internally consistent),
 * compute P(A beats B) from the two projected scores via predictMatch, and a
 * per-axis comparison. Pure & synchronous; never throws on missing/empty sides.
 */
export function simulateVersus(
  aTeams: number[],
  bTeams: number[],
  agg: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  pits: Map<number, TeamPit>,
  statboticsAvailable: boolean,
  fraction?: ComponentFraction,
  playedMatches?: number,
): VersusSimulation {
  const a = simulateAlliance({
    pickedTeams: aTeams,
    baselineTeams: bTeams,
    agg,
    epaByTeam,
    pits,
    statboticsAvailable,
    fraction,
    playedMatches,
  });
  const b = simulateAlliance({
    pickedTeams: bTeams,
    baselineTeams: aTeams,
    agg,
    epaByTeam,
    pits,
    statboticsAvailable,
    fraction,
    playedMatches,
  });

  const bothFull = aTeams.length === 3 && bTeams.length === 3;
  // A-as-red prediction over the two alliances → symmetric win-prob.
  const pred = predictMatch({
    redTeams: aTeams,
    blueTeams: bTeams,
    agg,
    epaByTeam,
    statboticsAvailable,
  });
  const aWinProb = bothFull ? pred.redWinProb : null;

  const axes: VersusAxisCompare[] = VERSUS_AXES.map(({ axis, label }) => {
    const av = axisValue(axis, aTeams, agg);
    const bv = axisValue(axis, bTeams, agg);
    let winner: 'a' | 'b' | 'tie';
    if (av > bv) winner = 'a';
    else if (bv > av) winner = 'b';
    else winner = 'tie';
    return { axis, label, a: av, b: bv, winner };
  });

  return { a, b, aWinProb, axes };
}

function deriveScoreSource(reads: TeamRoleRead[]): AllianceSimulation['scoreSource'] {
  if (reads.length === 0) return 'none';
  const sources = reads.map((r) => r.source);
  if (sources.every((s) => s === 'none')) return 'none';
  const distinct = new Set(sources);
  if (distinct.size === 1) {
    const only = sources[0];
    return only === 'none' ? 'none' : only;
  }
  return 'mixed';
}

/**
 * Simulate a (partial) alliance: projected score, win prob vs a baseline, role
 * reads + gap summary. Pure & synchronous; delegates score/win-prob to
 * predictMatch for exact Next-Match consistency.
 */
export function simulateAlliance(input: SimulateInput): AllianceSimulation {
  const { pickedTeams, baselineTeams, agg, epaByTeam, pits, statboticsAvailable, fraction, playedMatches } =
    input;

  const pred = predictMatch({
    redTeams: pickedTeams,
    blueTeams: baselineTeams,
    agg,
    epaByTeam,
    statboticsAvailable,
    fraction,
    playedMatches,
  });

  const teamReads: TeamRoleRead[] = pickedTeams.map((team, i) => {
    const teamAgg = agg.get(team);
    const pit = pits.get(team);
    const p = pred.red.teams[i];
    return {
      teamNumber: team,
      matchesScouted: teamAgg?.matchesScouted ?? 0,
      hasPit: pit !== undefined,
      source: p?.source ?? 'none',
      expected: p?.expected ?? 0,
      // p.components is the EPA auto/fuel estimate (present only when a fraction
      // was supplied); classifyRoles uses it only for no-data teams.
      roles: classifyRoles(teamAgg, pit, p?.components),
    };
  });

  const projectedScore = pred.red.score;
  const scoreSource = deriveScoreSource(teamReads);
  const redWinProb = baselineTeams.length === 3 ? pred.redWinProb : null;

  const gaps =
    teamReads.length === 3
      ? [...summarizeGaps(teamReads, pits), ...reliabilityNotes(teamReads, agg)]
      : [];

  return {
    teamReads,
    projectedScore,
    scoreSource,
    confidence: pred.confidence,
    redWinProb,
    gaps,
  };
}
