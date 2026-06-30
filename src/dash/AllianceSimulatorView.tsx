// src/dash/AllianceSimulatorView.tsx
// Alliance Simulator — Lead Dashboard tab. Pick any 3 teams at the active event
// and see a projected alliance score (blended exactly like Next Match), a win
// probability vs a Top/Median/custom baseline, and a role-gap analysis table.
// Read-only; pure client computation; degrades fully offline from the persisted
// query cache. Dark theme, shadcn primitives, matching RankingView's language.

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { aggregateEvent, type TeamAgg, type ComponentFraction } from '@/dash/aggregate';
import {
  useEventReports,
  useEventEpa,
  useEventMatches,
  useEventTeams,
  useEventComponentEpas,
} from '@/dash/useEventData';
import { useEventPits } from '@/dash/useTeamPit';
import {
  predictMatch,
  type TeamPrediction,
  type ComponentBreakdown,
} from '@/dash/predict';
import {
  simulateAlliance,
  simulateVersus,
  pickBaseline,
  type RoleStatus,
  type TeamRoleRead,
} from '@/dash/allianceSimulator';

export interface AllianceSimulatorViewProps {
  eventKey: string;
}

const MAX_PICKS = 3;
const EM_DASH = '—';

type BaselineKind = 'top' | 'median' | 'custom';

/** Role rows rendered in the gap table, top to bottom. */
const ROLE_ROWS: { key: keyof TeamRoleRead['roles']; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'fuel', label: 'Fuel' },
  { key: 'defense', label: 'Defense' },
  { key: 'climbL1', label: 'Climb L1' },
  { key: 'climbL23', label: 'Climb L2-3' },
];

function roleGlyph(s: RoleStatus): string {
  switch (s) {
    case 'strong':
      return '✓';
    case 'partial':
      return '~';
    case 'none':
      return '·';
    default:
      return '?';
  }
}

function roleClass(s: RoleStatus): string {
  switch (s) {
    case 'strong':
      return 'text-success';
    case 'partial':
      return 'text-warning';
    case 'none':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground/60';
  }
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'blend':
      return 'blend';
    case 'scouting':
      return 'scouting';
    case 'epa':
      return 'EPA';
    case 'mixed':
      return 'mixed';
    default:
      return 'no data';
  }
}

// --- Scoring estimate (component-EPA, mirrors the Match tab's renderer) ------
// Per-alliance auto/fuel/climb decomposition of the SAME blended `expected` the
// simulator already shows, reusing predictMatch(components) + the event-wide
// fitted `fraction` from useEventComponentEpas. Pure presentation — no new math.

const SRC_LABEL: Record<ComponentBreakdown['source'], string> = {
  scouting: 'scouting',
  epa: 'epa',
  none: 'none',
};
const SRC_CLASS: Record<ComponentBreakdown['source'], string> = {
  scouting: 'bg-success/15 text-success border-success/40',
  epa: 'bg-brand/15 text-brand border-brand/40',
  none: 'bg-muted text-muted-foreground border-border',
};

/** Round a component for display, or '—' when there's nothing to surface
 *  (source `none`, or a `null` value — e.g. climb for an unscouted team). */
function comp(n: number | null, source: ComponentBreakdown['source']): string {
  if (source === 'none' || n == null) return EM_DASH;
  return String(Math.round(n));
}

/** Run predictMatch over ONE alliance (blue empty) so each picked team gets a
 * `components` breakdown summing to its slice of the alliance score. Pure. */
function estimateAlliance(
  teams: number[],
  agg: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  statboticsAvailable: boolean,
  fraction: ComponentFraction | undefined,
  playedMatches: number,
): TeamPrediction[] {
  if (teams.length === 0) return [];
  const pred = predictMatch({
    redTeams: teams,
    blueTeams: [],
    agg,
    epaByTeam,
    statboticsAvailable,
    fraction,
    playedMatches,
  });
  return pred.red.teams;
}

/** Sum a numeric component (auto/fuel) across the alliance's per-team breakdowns. */
function sumComponent(preds: TeamPrediction[], key: 'auto' | 'fuel'): number {
  return preds.reduce((s, p) => s + (p.components?.[key] ?? 0), 0);
}
/** Alliance climb total — sums ONLY teams with a real (scouted) climb. Returns
 *  null when no team's climb is known, so it renders "—" rather than 0-as-known. */
function sumClimb(preds: TeamPrediction[]): number | null {
  let any = false;
  let total = 0;
  for (const p of preds) {
    const c = p.components?.climb;
    if (c != null) {
      any = true;
      total += c;
    }
  }
  return any ? total : null;
}
/** Alliance defense = points removed from the OPPOSING alliance (scouting-only). */
function allianceDefense(preds: TeamPrediction[]): number {
  return preds.reduce((s, p) => s + (p.components?.defense ?? 0), 0);
}

/** One team's estimate row: source badge + auto/fuel/climb + a defense sub-line. */
function EstimateTeamRow({ pred }: { pred: TeamPrediction }): JSX.Element {
  const c = pred.components;
  const source = c?.source ?? 'none';
  const hasDefense = c?.defense != null && c.defense > 0;
  return (
    <li
      data-testid={`alliance-estimate-team-${pred.teamNumber}`}
      className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold tabular-nums text-brand">{pred.teamNumber}</span>
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            SRC_CLASS[source],
          )}
        >
          {SRC_LABEL[source]}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span>
          auto <span className="text-foreground">{comp(c?.auto ?? 0, source)}</span>
        </span>
        <span>·</span>
        <span>
          fuel <span className="text-foreground">{comp(c?.fuel ?? 0, source)}</span>
        </span>
        <span>·</span>
        <span>
          climb <span className="text-foreground">{comp(c?.climb ?? null, source)}</span>
        </span>
      </div>
      <div className="text-xs text-muted-foreground/80">
        defense{' '}
        <span className="text-brand">
          {hasDefense ? `↓${Math.round(c!.defense as number)} on opp` : EM_DASH}
        </span>
      </div>
    </li>
  );
}

/** Per-alliance estimate block: rows + alliance totals + defense. Reused in
 * single (one block) and versus (two side-by-side). */
function AllianceEstimateBlock({
  testId,
  preds,
}: {
  testId: string;
  preds: TeamPrediction[];
}): JSX.Element {
  const anyData = preds.some((p) => (p.components?.source ?? 'none') !== 'none');
  const totalAuto = sumComponent(preds, 'auto');
  const totalFuel = sumComponent(preds, 'fuel');
  const totalClimb = sumClimb(preds);
  const defOnOther = allianceDefense(preds);
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 flex-col gap-2">
      {!anyData ? (
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          No scouting or EPA yet — estimates appear once teams have data.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {preds.map((p) => (
            <EstimateTeamRow key={p.teamNumber} pred={p} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 border-t border-border/50 pt-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Alliance</span>
        <span>
          auto <span className="text-foreground">{Math.round(totalAuto)}</span>
        </span>
        <span>·</span>
        <span>
          fuel <span className="text-foreground">{Math.round(totalFuel)}</span>
        </span>
        <span>·</span>
        <span>
          climb{' '}
          <span className="text-foreground">
            {totalClimb == null ? EM_DASH : Math.round(totalClimb)}
          </span>
        </span>
      </div>
      <div className="text-xs text-muted-foreground/80">
        alliance defense:{' '}
        <span className="text-brand">
          {defOnOther > 0 ? `↓${Math.round(defOnOther)} on opp` : `↓0 on opp`}
        </span>
      </div>
    </div>
  );
}

const ESTIMATE_FOOTNOTE =
  'Estimates derived from scouting (else EPA). Climb is shown only from real scouting — an unscouted ' +
  'team shows "—" rather than a fabricated climb, and its auto/fuel carry the full estimate. The ' +
  'auto-period L1 climb bonus is counted under climb, not auto. Defense is the points a team removes ' +
  'from the opposing alliance — not added to its own.';

export default function AllianceSimulatorView(props: AllianceSimulatorViewProps): JSX.Element {
  const { eventKey } = props;

  const reportsQuery = useEventReports(eventKey);
  const reports = reportsQuery.data;
  const matchesQuery = useEventMatches(eventKey);
  const teamsQuery = useEventTeams(eventKey);
  const pitsQuery = useEventPits(eventKey);

  // Aggregate scouted teams once per reports change.
  const agg = useMemo<Map<number, TeamAgg>>(
    () => (reports ? aggregateEvent(reports) : new Map()),
    [reports],
  );

  const scoutedTeams = useMemo(() => Array.from(agg.keys()), [agg]);

  // The picker team list is the UNION of: scouted teams ∪ event roster ∪ every
  // team in the match schedule. Source (c) guarantees buttons render even at a
  // real event with 0 reports and 0 event_team rows (e.g. 2026casnv).
  const pickableTeams = useMemo(() => {
    const set = new Set<number>(scoutedTeams);
    for (const t of teamsQuery.data ?? []) {
      if (Number.isFinite(t.team_number)) set.add(t.team_number);
    }
    for (const m of matchesQuery.data ?? []) {
      for (const t of [m.red1, m.red2, m.red3, m.blue1, m.blue2, m.blue3]) {
        if (t != null && Number.isFinite(t)) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [scoutedTeams, teamsQuery.data, matchesQuery.data]);

  const [mode, setMode] = useState<'single' | 'versus'>('single');
  const [picks, setPicks] = useState<number[]>([]);
  const [baselineKind, setBaselineKind] = useState<BaselineKind>('top');
  const [customBaseline, setCustomBaseline] = useState<number[]>([]);
  const [filter, setFilter] = useState('');

  // Versus mode: two alliances, 3 teams each.
  const [picksA, setPicksA] = useState<number[]>([]);
  const [picksB, setPicksB] = useState<number[]>([]);

  // EPA team-number union: scouted ∪ selected ∪ active baseline picks (§2). An
  // unscouted picked team must get an EPA fetch so it can contribute via `epa`.
  const epaTeamNumbers = useMemo(() => {
    const set = new Set<number>(scoutedTeams);
    for (const t of picks) set.add(t);
    for (const t of picksA) set.add(t);
    for (const t of picksB) set.add(t);
    for (const t of baselineKind === 'custom' ? customBaseline : pickableTeams) set.add(t);
    return Array.from(set);
  }, [scoutedTeams, picks, picksA, picksB, baselineKind, customBaseline, pickableTeams]);

  const epaQuery = useEventEpa(epaTeamNumbers, eventKey, matchesQuery.data ?? []);
  const epaByTeam = epaQuery.data?.epaByTeam ?? new Map<number, number | null>();
  // Load-bearing: pass available === true (NOT source === 'statbotics') so a
  // LOCAL match-result EPA still feeds the blend, matching NextMatchView.
  const statboticsAvailable = epaQuery.data?.available === true;
  const epaSource = epaQuery.data?.source ?? 'none';
  const pits = pitsQuery.data ?? new Map();

  // Resolve the actual baseline teams now that EPA is available. The auto
  // (Top/Median) baseline ranks the pickable candidates by EPA-aware expected
  // and excludes the current picks.
  const resolvedBaseline = useMemo<number[]>(() => {
    if (baselineKind === 'custom') return customBaseline;
    if (picks.length !== MAX_PICKS) return [];
    return pickBaseline(baselineKind, pickableTeams, picks, agg, epaByTeam, statboticsAvailable);
  }, [baselineKind, customBaseline, picks, pickableTeams, agg, epaByTeam, statboticsAvailable]);

  // Component-EPA split inputs (event-wide fitted fraction + scouting-defense map).
  // Shares the persisted ['reports', eventKey] cache — the SAME hook MatchView uses.
  // Defined before the simulations so the Role Coverage table can fall back to
  // OUR estimated auto/fuel for teams with no scouting data.
  const componentQ = useEventComponentEpas(epaTeamNumbers, eventKey);
  const fraction = componentQ.data?.fraction;

  // Count of played matches at the event — gates the EPA-source split (an
  // unscouted team only gets an EPA estimate once enough matches are in).
  const playedMatches = useMemo(
    () =>
      (matchesQuery.data ?? []).filter(
        (m) => m.actual_red_score != null && m.actual_blue_score != null,
      ).length,
    [matchesQuery.data],
  );

  const sim = useMemo(
    () =>
      simulateAlliance({
        pickedTeams: picks,
        baselineTeams: resolvedBaseline,
        agg,
        epaByTeam,
        pits,
        statboticsAvailable,
        fraction,
        playedMatches,
      }),
    [picks, resolvedBaseline, agg, epaByTeam, pits, statboticsAvailable, fraction, playedMatches],
  );

  const versus = useMemo(
    () => simulateVersus(picksA, picksB, agg, epaByTeam, pits, statboticsAvailable, fraction, playedMatches),
    [picksA, picksB, agg, epaByTeam, pits, statboticsAvailable, fraction, playedMatches],
  );

  // Per-alliance component breakdowns (memoized). predictMatch over one alliance
  // (blue empty) attaches each picked team's auto/fuel/climb (+ scouting defense).
  const estimateSingle = useMemo(
    () => estimateAlliance(picks, agg, epaByTeam, statboticsAvailable, fraction, playedMatches),
    [picks, agg, epaByTeam, statboticsAvailable, fraction, playedMatches],
  );
  const estimateA = useMemo(
    () => estimateAlliance(picksA, agg, epaByTeam, statboticsAvailable, fraction, playedMatches),
    [picksA, agg, epaByTeam, statboticsAvailable, fraction, playedMatches],
  );
  const estimateB = useMemo(
    () => estimateAlliance(picksB, agg, epaByTeam, statboticsAvailable, fraction, playedMatches),
    [picksB, agg, epaByTeam, statboticsAvailable, fraction, playedMatches],
  );

  const ready = picks.length === MAX_PICKS;
  const versusReady = picksA.length === MAX_PICKS && picksB.length === MAX_PICKS;

  // Custom baseline overlapping a pick → inline note (don't block).
  const customOverlap =
    baselineKind === 'custom' && customBaseline.some((t) => picks.includes(t));
  // Auto baseline could not field 3 distinct teams (tiny event).
  const baselineInsufficient =
    ready && baselineKind !== 'custom' && resolvedBaseline.length < MAX_PICKS;

  function togglePick(team: number): void {
    setPicks((prev) => {
      if (prev.includes(team)) return prev.filter((t) => t !== team);
      if (prev.length >= MAX_PICKS) return prev;
      return [...prev, team];
    });
  }

  function toggleCustom(team: number): void {
    setCustomBaseline((prev) => {
      if (prev.includes(team)) return prev.filter((t) => t !== team);
      if (prev.length >= MAX_PICKS) return prev;
      return [...prev, team];
    });
  }

  function clearAll(): void {
    setPicks([]);
    setCustomBaseline([]);
  }

  // Versus pickers: exclude the team already on the OTHER side so a team can't
  // be on both alliances. Toggling on a full side is a no-op.
  function toggleVersus(side: 'a' | 'b', team: number): void {
    const setter = side === 'a' ? setPicksA : setPicksB;
    const other = side === 'a' ? picksB : picksA;
    if (other.includes(team)) return;
    setter((prev) => {
      if (prev.includes(team)) return prev.filter((t) => t !== team);
      if (prev.length >= MAX_PICKS) return prev;
      return [...prev, team];
    });
  }

  const filtered = useMemo(() => {
    const q = filter.trim();
    if (!q) return pickableTeams;
    return pickableTeams.filter((t) => String(t).includes(q));
  }, [pickableTeams, filter]);

  // --- render states ---------------------------------------------------------
  if (reportsQuery.isLoading && !reports) {
    return (
      <div data-testid="dash-alliance" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="alliance-loading" className="text-sm text-muted-foreground">
              Loading scouting data…
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const epaBanner =
    epaSource === 'local' ? (
      <div data-testid="alliance-epa-banner" className="text-xs text-warning">
        Statbotics offline — projections use a local EPA estimate computed from match results.
      </div>
    ) : !statboticsAvailable ? (
      <div data-testid="alliance-epa-banner" className="text-xs text-warning">
        Statbotics &amp; match-result EPA unavailable — projections use our in-house scouting estimate.
      </div>
    ) : null;

  return (
    <div data-testid="dash-alliance" className="space-y-4 text-foreground">
      {/* 0. Mode toggle ------------------------------------------------------ */}
      <div role="tablist" aria-label="Simulator mode" className="inline-flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {(['single', 'versus'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`alliance-mode-${m}`}
            onClick={() => setMode(m)}
            className={cn(
              'min-h-[44px] rounded-lg px-4 text-sm font-medium capitalize',
              mode === m
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === 'versus' ? (
        <VersusMode
          pickableTeams={pickableTeams}
          agg={agg}
          picksA={picksA}
          picksB={picksB}
          toggleVersus={toggleVersus}
          clearSide={(side) => (side === 'a' ? setPicksA([]) : setPicksB([]))}
          versus={versus}
          versusReady={versusReady}
          epaBanner={epaBanner}
          estimateA={estimateA}
          estimateB={estimateB}
        />
      ) : (
      <>
      {/* 1. Selection card --------------------------------------------------- */}
      <Card data-testid="alliance-picker" className="bg-card">
        <CardHeader>
          <CardTitle>Alliance Simulator</CardTitle>
          {epaBanner}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              data-testid="alliance-search"
              type="text"
              inputMode="numeric"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter teams…"
              className="min-h-[44px] flex-1 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <button
              type="button"
              data-testid="alliance-clear"
              onClick={clearAll}
              className="min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent/40"
            >
              Clear
            </button>
          </div>

          {/* selected chips strip */}
          {picks.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {picks.map((t) => (
                <span
                  key={t}
                  data-testid={`alliance-selected-${t}`}
                  className="inline-flex items-center gap-1 rounded-full bg-brand/20 px-2 py-1 text-xs text-brand"
                >
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove team ${t}`}
                    onClick={() => togglePick(t)}
                    className="text-brand/70 hover:text-brand"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="max-h-64 overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No teams.</div>
            ) : (
              <ul>
                {filtered.map((t) => {
                  const checked = picks.includes(t);
                  const atCap = !checked && picks.length >= MAX_PICKS;
                  const scouted = agg.has(t);
                  return (
                    <li key={t}>
                      <button
                        type="button"
                        data-testid={`alliance-pick-${t}`}
                        aria-pressed={checked}
                        disabled={atCap}
                        onClick={() => togglePick(t)}
                        className={cn(
                          'flex min-h-[44px] w-full items-center justify-between border-b border-border/40 px-3 text-left text-sm',
                          checked ? 'bg-brand/15 text-brand' : 'hover:bg-accent/30',
                          atCap && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <span className="tabular-nums">{t}</span>
                        <span className="text-xs text-muted-foreground">
                          {scouted ? 'scouted' : 'roster'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {!ready ? (
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="alliance-prompt" className="text-sm text-muted-foreground">
              Pick 3 teams to simulate an alliance.
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 2. Projected score card ---------------------------------------- */}
          <Card data-testid="alliance-score-card" className="bg-card">
            <CardHeader>
              <CardTitle>Projected Score</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-baseline gap-3">
                <span data-testid="alliance-score" className="text-4xl font-bold tabular-nums">
                  {sim.projectedScore.toFixed(0)}
                </span>
                <span
                  data-testid="alliance-score-source"
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {sourceLabel(sim.scoreSource)}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {sim.teamReads.map((r) => (
                  <span
                    key={r.teamNumber}
                    data-testid={`alliance-team-chip-${r.teamNumber}`}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                  >
                    <span className="font-medium tabular-nums text-brand">{r.teamNumber}</span>
                    <span className="tabular-nums">{r.expected.toFixed(0)} pts</span>
                    <span className="text-muted-foreground">· {sourceLabel(r.source)}</span>
                    {!r.hasPit && r.matchesScouted > 0 ? (
                      <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">
                        match-only
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* 3. Win-prob card ---------------------------------------------- */}
          <Card data-testid="alliance-winprob-card" className="bg-card">
            <CardHeader>
              <CardTitle>Win Probability vs Baseline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div role="tablist" aria-label="Baseline" className="inline-flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
                {(['top', 'median', 'custom'] as BaselineKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={baselineKind === k}
                    data-testid={`alliance-baseline-${k}`}
                    onClick={() => setBaselineKind(k)}
                    className={cn(
                      'min-h-[44px] rounded-lg px-4 text-sm font-medium capitalize',
                      baselineKind === k
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>

              <div className="flex items-baseline gap-2">
                <span data-testid="alliance-winprob" className="text-3xl font-bold tabular-nums">
                  {sim.redWinProb === null
                    ? EM_DASH
                    : `${Math.round(sim.redWinProb * 100)}%`}
                </span>
              </div>

              {baselineInsufficient ? (
                <div data-testid="alliance-winprob-note" className="text-xs text-muted-foreground">
                  Not enough teams left for a baseline alliance (excluding your picks).
                </div>
              ) : null}
              {customOverlap ? (
                <div data-testid="alliance-baseline-overlap" className="text-xs text-warning">
                  Baseline overlaps your picks.
                </div>
              ) : null}

              {baselineKind === 'custom' ? (
                <div data-testid="alliance-custom-picker" className="max-h-48 overflow-y-auto rounded-md border border-border">
                  <ul>
                    {pickableTeams.map((t) => {
                      const checked = customBaseline.includes(t);
                      const atCap = !checked && customBaseline.length >= MAX_PICKS;
                      return (
                        <li key={t}>
                          <button
                            type="button"
                            data-testid={`alliance-custom-pick-${t}`}
                            aria-pressed={checked}
                            disabled={atCap}
                            onClick={() => toggleCustom(t)}
                            className={cn(
                              'flex min-h-[44px] w-full items-center justify-between border-b border-border/40 px-3 text-left text-sm',
                              checked ? 'bg-brand/15 text-brand' : 'hover:bg-accent/30',
                              atCap && 'cursor-not-allowed opacity-40',
                            )}
                          >
                            <span className="tabular-nums">{t}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* 4. Role-gap table --------------------------------------------- */}
          <Card className="bg-card">
            <CardHeader>
              <CardTitle>Role Coverage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 p-0 sm:p-6">
              <div className="overflow-x-auto">
                <table data-testid="alliance-roles" className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                      {sim.teamReads.map((r) => (
                        <th key={r.teamNumber} scope="col" className="px-3 py-2 text-center font-medium tabular-nums text-brand">
                          {r.teamNumber}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROLE_ROWS.map(({ key, label }) => (
                      <tr key={key} className="border-b border-border/50">
                        <td className="px-3 py-2 font-medium text-muted-foreground">{label}</td>
                        {sim.teamReads.map((r) => {
                          const s = r.roles[key];
                          return (
                            <td
                              key={r.teamNumber}
                              data-testid={`alliance-role-${key}-${r.teamNumber}`}
                              className={cn('px-3 py-2 text-center text-lg', roleClass(s))}
                              title={s}
                            >
                              {roleGlyph(s)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {sim.teamReads.some(
                (r) => !r.hasPit && r.matchesScouted === 0 && r.source === 'epa',
              ) ? (
                <p
                  data-testid="alliance-roles-estimate-note"
                  className="px-3 text-[11px] leading-snug text-muted-foreground/80 sm:px-0"
                >
                  <span className="text-warning">~</span> Auto / Fuel for teams with no scouting
                  data are EPA estimates; defense &amp; climb stay unknown.
                </p>
              ) : null}

              <ul data-testid="alliance-gaps" className="space-y-1 px-3 pb-3 text-sm sm:px-0 sm:pb-0">
                {sim.gaps.map((g, i) => (
                  <li
                    key={`${g.kind}-${i}`}
                    data-testid={`alliance-gap-${i}`}
                    className={cn(
                      g.kind === 'gap' ? 'text-destructive' : g.kind === 'surplus' ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    {g.text}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* 5. Scoring estimate (component-EPA breakdown) ------------------ */}
          <Card className="border-dashed border-border bg-card">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>Scoring estimate</CardTitle>
              <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                estimate
              </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <AllianceEstimateBlock testId="alliance-estimate" preds={estimateSingle} />
              <p className="text-[11px] leading-snug text-muted-foreground/80">
                {ESTIMATE_FOOTNOTE}
              </p>
            </CardContent>
          </Card>
        </>
      )}
      </>
      )}
    </div>
  );
}

// --- Versus mode -------------------------------------------------------------

interface VersusModeProps {
  pickableTeams: number[];
  agg: Map<number, TeamAgg>;
  picksA: number[];
  picksB: number[];
  toggleVersus: (side: 'a' | 'b', team: number) => void;
  clearSide: (side: 'a' | 'b') => void;
  versus: ReturnType<typeof simulateVersus>;
  versusReady: boolean;
  epaBanner: JSX.Element | null;
  estimateA: TeamPrediction[];
  estimateB: TeamPrediction[];
}

function VersusPicker(props: {
  side: 'a' | 'b';
  label: string;
  picks: number[];
  other: number[];
  pickableTeams: number[];
  agg: Map<number, TeamAgg>;
  accent: string;
  toggleVersus: (side: 'a' | 'b', team: number) => void;
  clearSide: (side: 'a' | 'b') => void;
}): JSX.Element {
  const { side, label, picks, other, pickableTeams, agg, accent, toggleVersus, clearSide } = props;
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const q = filter.trim();
    const base = pickableTeams.filter((t) => !other.includes(t));
    if (!q) return base;
    return base.filter((t) => String(t).includes(q));
  }, [pickableTeams, other, filter]);

  return (
    <Card data-testid={`alliance-vs-picker-${side}`} className="bg-card">
      <CardHeader>
        <CardTitle className={accent}>{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            data-testid={`alliance-vs-search-${side}`}
            type="text"
            inputMode="numeric"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter teams…"
            className="min-h-[44px] flex-1 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-testid={`alliance-vs-clear-${side}`}
            onClick={() => clearSide(side)}
            className="min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent/40"
          >
            Clear
          </button>
        </div>

        {picks.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {picks.map((t) => (
              <span
                key={t}
                data-testid={`alliance-vs-${side}-selected-${t}`}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs"
              >
                <span className={cn('tabular-nums', accent)}>{t}</span>
                <button
                  type="button"
                  aria-label={`Remove team ${t}`}
                  onClick={() => toggleVersus(side, t)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="max-h-56 overflow-y-auto rounded-md border border-border">
          {filtered.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No teams.</div>
          ) : (
            <ul>
              {filtered.map((t) => {
                const checked = picks.includes(t);
                const atCap = !checked && picks.length >= MAX_PICKS;
                const scouted = agg.has(t);
                return (
                  <li key={t}>
                    <button
                      type="button"
                      data-testid={`alliance-vs-pick-${side}-${t}`}
                      aria-pressed={checked}
                      disabled={atCap}
                      onClick={() => toggleVersus(side, t)}
                      className={cn(
                        'flex min-h-[44px] w-full items-center justify-between border-b border-border/40 px-3 text-left text-sm',
                        checked ? 'bg-accent/40 font-medium' : 'hover:bg-accent/30',
                        atCap && 'cursor-not-allowed opacity-40',
                      )}
                    >
                      <span className={cn('tabular-nums', checked && accent)}>{t}</span>
                      <span className="text-xs text-muted-foreground">
                        {scouted ? 'scouted' : 'roster'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function VersusMode(props: VersusModeProps): JSX.Element {
  const {
    pickableTeams,
    agg,
    picksA,
    picksB,
    toggleVersus,
    clearSide,
    versus,
    versusReady,
    epaBanner,
    estimateA,
    estimateB,
  } = props;

  return (
    <div className="space-y-4">
      {epaBanner ? <Card className="bg-card"><CardContent className="p-4">{epaBanner}</CardContent></Card> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VersusPicker
          side="a"
          label="Alliance A (Red)"
          picks={picksA}
          other={picksB}
          pickableTeams={pickableTeams}
          agg={agg}
          accent="text-energy"
          toggleVersus={toggleVersus}
          clearSide={clearSide}
        />
        <VersusPicker
          side="b"
          label="Alliance B (Blue)"
          picks={picksB}
          other={picksA}
          pickableTeams={pickableTeams}
          agg={agg}
          accent="text-brand"
          toggleVersus={toggleVersus}
          clearSide={clearSide}
        />
      </div>

      {!versusReady ? (
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="alliance-vs-prompt" className="text-sm text-muted-foreground">
              Pick 3 teams for each alliance to compare them head-to-head.
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="alliance-vs-panel" className="bg-card">
          <CardHeader>
            <CardTitle>Head-to-Head</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* scores + win prob */}
            <div className="grid grid-cols-3 items-center gap-2 text-center">
              <div>
                <div data-testid="alliance-vs-a-score" className="text-3xl font-bold tabular-nums text-energy">
                  {versus.a.projectedScore.toFixed(0)}
                </div>
                <div className="text-xs text-muted-foreground">Alliance A</div>
              </div>
              <div data-testid="alliance-vs-winprob" className="text-sm">
                <div className="text-2xl font-bold tabular-nums">
                  {versus.aWinProb === null ? EM_DASH : `${Math.round(versus.aWinProb * 100)}%`}
                </div>
                <div className="text-xs text-muted-foreground">A win prob</div>
              </div>
              <div>
                <div data-testid="alliance-vs-b-score" className="text-3xl font-bold tabular-nums text-brand">
                  {versus.b.projectedScore.toFixed(0)}
                </div>
                <div className="text-xs text-muted-foreground">Alliance B</div>
              </div>
            </div>

            {/* per-axis comparison */}
            <table data-testid="alliance-vs-compare" className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-right font-medium text-energy">A</th>
                  <th className="px-2 py-2 text-center font-medium text-muted-foreground">Axis</th>
                  <th className="px-2 py-2 text-left font-medium text-brand">B</th>
                </tr>
              </thead>
              <tbody>
                {versus.axes.map((ax) => (
                  <tr key={ax.axis} className="border-b border-border/50" data-testid={`alliance-vs-axis-${ax.axis}`}>
                    <td
                      data-testid={`alliance-vs-axis-${ax.axis}-a`}
                      className={cn(
                        'px-2 py-2 text-right tabular-nums',
                        ax.winner === 'a' ? 'font-bold text-success' : 'text-muted-foreground',
                      )}
                    >
                      {ax.a.toFixed(1)}
                    </td>
                    <td className="px-2 py-2 text-center text-muted-foreground">{ax.label}</td>
                    <td
                      data-testid={`alliance-vs-axis-${ax.axis}-b`}
                      className={cn(
                        'px-2 py-2 text-left tabular-nums',
                        ax.winner === 'b' ? 'font-bold text-success' : 'text-muted-foreground',
                      )}
                    >
                      {ax.b.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* role gaps per side */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {(['a', 'b'] as const).map((side) => {
                const sim = side === 'a' ? versus.a : versus.b;
                const accent = side === 'a' ? 'text-energy' : 'text-brand';
                return (
                  <div key={side} data-testid={`alliance-vs-gaps-${side}`} className="space-y-2">
                    <div className={cn('text-sm font-medium', accent)}>
                      Alliance {side.toUpperCase()} role gaps
                    </div>
                    <ul className="space-y-1 text-sm">
                      {sim.gaps.map((g, i) => (
                        <li
                          key={`${g.kind}-${i}`}
                          className={cn(
                            g.kind === 'gap'
                              ? 'text-destructive'
                              : g.kind === 'surplus'
                                ? 'text-success'
                                : 'text-muted-foreground',
                          )}
                        >
                          {g.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            {/* scoring estimate: both alliances side by side */}
            <div className="space-y-2 border-t border-border/50 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Scoring estimate</div>
                <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  estimate
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-energy">Alliance A</div>
                  <AllianceEstimateBlock testId="alliance-vs-estimate-a" preds={estimateA} />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-brand">Alliance B</div>
                  <AllianceEstimateBlock testId="alliance-vs-estimate-b" preds={estimateB} />
                </div>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground/80">
                {ESTIMATE_FOOTNOTE}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
