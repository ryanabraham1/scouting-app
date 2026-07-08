// src/dash/DraftBoardView.tsx
// Live alliance-selection draft board (draft-board feature). During the real-time
// selection a lead crosses teams off as they're picked and the board surfaces the
// best remaining pick from our ranking, respecting picklist "do not pick" flags.
// The ranking follows ONE of the two picklists (1st pick / 2nd pick): it starts
// on the 1st-pick list and auto-switches to the 2nd-pick list the moment our
// alliance's first pick lands (we picked, or a captain picked us) — with a
// manual switcher in the header for full control.
//
// Read-only over the SAME data the Ranking tab uses (aggregateEvent + best-
// available EPA + the shared picklist). The draft picks are an EPHEMERAL per-event
// scratchpad persisted to localStorage — no server table, no migration. Degrades
// fully offline.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Gavel, Star, X, RotateCcw, Search, Trophy, Ban, Lock, StickyNote } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { aggregateEvent, emptyTeamAgg, type TeamAgg } from '@/dash/aggregate';
import {
  useEventReports,
  useEventEpa,
  useEventMatches,
  useEventTeams,
  useTbaRankings,
} from '@/dash/useEventData';
import { resolveRowEpa } from '@/dash/sorting';
import { OUR_TEAM } from '@/dash/constants';
import { useQuery } from '@tanstack/react-query';
import { getPicklist, entryList, type PicklistEntry, type PicklistId } from '@/dash/picklistClient';
import {
  loadDraftState,
  saveDraftState,
  statusOf,
  toggleStatus,
  bestRemaining,
  compareDraftOrder,
  draftActiveList,
  withAutoListSwitch,
  type DraftState,
  type DraftRow,
} from '@/dash/draftBoard';

/** Parse TBA `/event/{key}/rankings` into teamNumber → rank (mirrors RankingView). */
function buildTbaRankMap(data: unknown): Map<number, number> {
  const map = new Map<number, number>();
  if (typeof data !== 'object' || data === null) return map;
  const rankings = (data as { rankings?: Array<{ rank?: number; team_key?: string }> }).rankings;
  if (!Array.isArray(rankings)) return map;
  for (const r of rankings) {
    if (!r || typeof r.team_key !== 'string' || typeof r.rank !== 'number') continue;
    const m = /^frc(\d+)$/.exec(r.team_key);
    if (m) map.set(Number(m[1]), r.rank);
  }
  return map;
}

export interface DraftBoardViewProps {
  eventKey: string;
  /** Open a team's Team page (wires to the Dashboard's Team tab). */
  onSelectTeam?: (teamNumber: number) => void;
}

const EM_DASH = '—';
/** FRC playoffs are 8 alliances → the top 8 ranked teams are all captains. */
const TOP8_CAPTAINS = 8;

function fmt(n: number, digits = 0): string {
  return Number.isFinite(n) ? n.toFixed(digits) : EM_DASH;
}
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * A team number that links to the Team page when `onSelect` is provided (else a
 * plain span). Used everywhere a team appears on the board so any number opens
 * that team's profile.
 */
function TeamNumber(props: {
  team: number;
  onSelect?: (team: number) => void;
  className?: string;
  testid: string;
}): JSX.Element {
  const { team, onSelect, className, testid } = props;
  if (!onSelect) {
    return (
      <span className={className} data-testid={testid}>
        {team}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={() => onSelect(team)}
      aria-label={`Open team ${team}`}
      className={cn('hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', className)}
    >
      {team}
    </button>
  );
}

/** Status-tinted classes for a pool row. */
function rowTone(status: DraftRow['status']): string {
  switch (status) {
    case 'ours':
      return 'border-success/50 bg-success/10';
    case 'taken':
      return 'border-border bg-muted/20 opacity-55';
    default:
      return 'border-border bg-muted/30';
  }
}

export default function DraftBoardView(props: DraftBoardViewProps): JSX.Element {
  const { eventKey, onSelectTeam } = props;

  const reportsQuery = useEventReports(eventKey);
  const teamsQuery = useEventTeams(eventKey);
  const matchesQuery = useEventMatches(eventKey);
  const reports = reportsQuery.data;

  // Picklist for tier/DNP annotations — shares the offline-persisted query cache.
  const picklistQuery = useQuery({
    queryKey: ['picklist', eventKey],
    queryFn: () => getPicklist(eventKey),
    staleTime: 30_000,
  });

  // Aggregate scouted teams + EPA-only rows for every event team (mirrors Ranking).
  const aggs = useMemo<TeamAgg[]>(() => {
    const byTeam = reports ? aggregateEvent(reports) : new Map<number, TeamAgg>();
    for (const t of teamsQuery.data ?? []) {
      if (!byTeam.has(t.team_number)) byTeam.set(t.team_number, emptyTeamAgg(t.team_number));
    }
    return Array.from(byTeam.values());
  }, [reports, teamsQuery.data]);

  const teamNumbers = useMemo(() => aggs.map((a) => a.teamNumber), [aggs]);
  const epaQuery = useEventEpa(teamNumbers, eventKey, matchesQuery.data ?? []);
  const epaByTeam = epaQuery.data?.epaByTeam;
  const epaAvailable = epaQuery.data?.available === true;
  const epaFromScouting = !epaAvailable;

  // Official event ranks → which teams are ranked ABOVE us (can't pick them).
  const tbaRankingsQuery = useTbaRankings(eventKey);
  const tbaRankByTeam = useMemo(
    () => buildTbaRankMap(tbaRankingsQuery.data),
    [tbaRankingsQuery.data],
  );
  const ourRank = tbaRankByTeam.get(OUR_TEAM) ?? null;

  const nicknameByTeam = useMemo(() => {
    const m = new Map<number, string | null>();
    for (const t of teamsQuery.data ?? []) m.set(t.team_number, t.nickname);
    return m;
  }, [teamsQuery.data]);

  // teamNumber → its picklist entry (either list; flags/notes apply globally).
  const picklistByTeam = useMemo(() => {
    const m = new Map<number, PicklistEntry>();
    for (const entry of picklistQuery.data ?? []) m.set(entry.teamNumber, entry);
    return m;
  }, [picklistQuery.data]);

  // --- Draft scratch state (ephemeral, persisted per event) ------------------
  const [state, setState] = useState<DraftState>(() => loadDraftState(eventKey));

  // Which picklist drives the ranking: the 1st-pick list until our alliance's
  // first pick lands (auto-switch below), manually switchable any time.
  const activeList = draftActiveList(state);
  // teamNumber → 0-based rank on the ACTIVE list (DNP markers excluded).
  const activeRankByTeam = useMemo(() => {
    const m = new Map<number, number>();
    (picklistQuery.data ?? [])
      .filter((e) => !(e.dnp ?? false) && entryList(e) === activeList)
      .forEach((e, rank) => m.set(e.teamNumber, rank));
    return m;
  }, [picklistQuery.data, activeList]);
  // Which event the in-memory `state` belongs to. On an event switch, the
  // reload effect schedules setState but the save effect runs in the SAME
  // commit — before the re-render — so without this guard it would write the
  // OLD event's picks into the NEW event's storage key (permanently, if the
  // component unmounted before the corrective re-render).
  const stateEventRef = useRef(eventKey);
  // Reload when the active event changes; persist on every change.
  useEffect(() => {
    if (stateEventRef.current === eventKey) return;
    stateEventRef.current = eventKey;
    setState(loadDraftState(eventKey));
  }, [eventKey]);
  useEffect(() => {
    if (stateEventRef.current !== eventKey) return; // stale state from the previous event
    saveDraftState(eventKey, state);
  }, [eventKey, state]);

  const [search, setSearch] = useState('');

  // Build ranked DraftRows in DRAFT ORDER: our picklist first (in picklist
  // order), then everyone else by best-available EPA — and flag teams ranked
  // above us as un-pickable (compareDraftOrder + bestRemaining enforce this).
  const rankedRows = useMemo<DraftRow[]>(() => {
    // Once WE (as captain) have made our first pick, the top-8 ranked teams are
    // gone before our 2nd pick comes around (captains + their picks). `state.ours`
    // is read directly (not the derived `ourPicks`) to avoid a memo cycle.
    const madeFirstPick = (state.pickedBy ?? null) == null && state.ours.length >= 1;
    const rows: DraftRow[] = aggs.map((agg) => {
      const pl = picklistByTeam.get(agg.teamNumber);
      const rank = activeRankByTeam.get(agg.teamNumber) ?? null;
      const tbaRank = tbaRankByTeam.get(agg.teamNumber) ?? null;
      const blockedByRank =
        ourRank != null && tbaRank != null && tbaRank < ourRank && agg.teamNumber !== OUR_TEAM;
      const blockedTop8 =
        madeFirstPick && tbaRank != null && tbaRank <= TOP8_CAPTAINS && agg.teamNumber !== OUR_TEAM;
      return {
        teamNumber: agg.teamNumber,
        nickname: nicknameByTeam.get(agg.teamNumber) ?? null,
        epa: resolveRowEpa({ agg, epaByTeam, epaAvailable, epaFromScouting }),
        expectedPoints: agg.scoutingExpectedPoints,
        climbSuccessRate: agg.climbSuccessRate,
        matchesScouted: agg.matchesScouted,
        dnp: pl?.dnp ?? false,
        tier: pl?.tier ?? null,
        note: pl?.note ?? null,
        picklistRank: rank,
        onOtherList: rank == null && pl != null && !(pl.dnp ?? false),
        tbaRank,
        blockedByRank,
        blockedTop8,
        isUs: agg.teamNumber === OUR_TEAM,
        status: statusOf(agg.teamNumber, state),
      };
    });
    rows.sort(compareDraftOrder);
    return rows;
  }, [
    aggs,
    epaByTeam,
    epaAvailable,
    epaFromScouting,
    picklistByTeam,
    activeRankByTeam,
    nicknameByTeam,
    tbaRankByTeam,
    ourRank,
    state,
  ]);

  const hasPicklist = activeRankByTeam.size > 0;
  const listLabel = activeList === 'first' ? '1st' : '2nd';
  const otherListLabel = activeList === 'first' ? '2nd' : '1st';

  const best = useMemo(() => bestRemaining(rankedRows, 3), [rankedRows]);

  // Our picks (the teams we marked "ours").
  const ourPicks = useMemo(() => rankedRows.filter((r) => r.status === 'ours'), [rankedRows]);

  // Who picked us (a captain team), or null when WE are the captain.
  const pickedBy = state.pickedBy ?? null;
  const captainTeam = pickedBy ?? OUR_TEAM;

  // Our full alliance, captain first, then us (when we were picked), then picks —
  // deduped, resolved to ranked rows. When we're the captain, we lead the list.
  const alliance = useMemo<DraftRow[]>(() => {
    const byNum = (n: number): DraftRow | undefined =>
      rankedRows.find((r) => r.teamNumber === n);
    const ids: number[] = [];
    const push = (n: number | null): void => {
      if (n != null && !ids.includes(n)) ids.push(n);
    };
    push(captainTeam); // captain leads (us when not picked, else the picker)
    if (pickedBy != null) push(OUR_TEAM); // we're a member when someone picked us
    for (const r of ourPicks) push(r.teamNumber);
    return ids.map(byNum).filter((r): r is DraftRow => r != null);
  }, [rankedRows, ourPicks, captainTeam, pickedBy]);

  // Teams sorted by number for the "we got picked by" selector.
  const teamsByNumber = useMemo(
    () => rankedRows.slice().sort((a, b) => a.teamNumber - b.teamNumber),
    [rankedRows],
  );
  // Only teams ranked ABOVE us can have picked us (they pick before we would).
  // When our rank is unknown we can't filter, so fall back to every other team.
  // Always keep the currently-selected captain visible even if its rank shifts.
  const pickedByCandidates = useMemo(
    () =>
      teamsByNumber.filter(
        (r) => !r.isUs && (ourRank == null || r.blockedByRank || r.teamNumber === pickedBy),
      ),
    [teamsByNumber, ourRank, pickedBy],
  );
  // Getting picked counts as our alliance's first pick → list auto-switch.
  const setPickedBy = (team: number | null): void =>
    setState((s) => withAutoListSwitch(s, { ...s, pickedBy: team }));

  // Combined alliance stats for the viz: summed best-available EPA + summed
  // scouting expected points across members, and how many are reliable climbers.
  const allianceStats = useMemo(() => {
    let epaSum = 0;
    let epaKnown = false;
    let expSum = 0;
    let climbers = 0;
    for (const r of alliance) {
      if (r.epa != null) {
        epaSum += r.epa;
        epaKnown = true;
      }
      expSum += r.expectedPoints;
      if (r.climbSuccessRate >= 0.5) climbers += 1;
    }
    return { epaSum: epaKnown ? epaSum : null, expSum, climbers, size: alliance.length };
  }, [alliance]);

  const counts = useMemo(() => {
    let available = 0;
    let taken = 0;
    for (const r of rankedRows) {
      if (r.status === 'available') available += 1;
      else if (r.status === 'taken') taken += 1;
    }
    return { available, taken, ours: ourPicks.length, total: rankedRows.length };
  }, [rankedRows, ourPicks.length]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rankedRows;
    return rankedRows.filter(
      (r) => String(r.teamNumber).includes(q) || (r.nickname ?? '').toLowerCase().includes(q),
    );
  }, [rankedRows, search]);

  // Marking our FIRST pick auto-switches the board to the 2nd-pick list (and
  // undoing it switches back); manual switching below always remains available.
  const toggle = (teamNumber: number, target: 'ours' | 'taken'): void =>
    setState((s) => withAutoListSwitch(s, toggleStatus(teamNumber, target, s)));
  const setActiveList = (list: PicklistId): void =>
    setState((s) => ({ ...s, activeList: list }));
  const resetAll = (): void => setState({ ours: [], taken: [] });

  const loading =
    (reportsQuery.isLoading && !reports) || (teamsQuery.isLoading && !teamsQuery.data);

  if (loading) {
    return (
      <div data-testid="dash-draft" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="dash-draft-loading" className="text-sm text-muted-foreground">
              Loading event data…
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (rankedRows.length === 0) {
    return (
      <div data-testid="dash-draft" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="dash-draft-empty" className="text-sm text-muted-foreground">
              No teams for this event yet.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="dash-draft" className="space-y-4 text-foreground">
      {/* Best remaining pick — the headline of the board. */}
      <Card className="border-brand/40 bg-card">
        <CardHeader className="gap-1 space-y-0">
          <div className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Gavel className="size-5 text-brand" /> Best remaining
            </CardTitle>
            <span className="text-xs tabular-nums text-muted-foreground">
              {counts.available} available · {counts.taken} taken · {counts.ours} ours
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span data-testid="draft-best-source" className="text-xs text-muted-foreground">
              {hasPicklist
                ? `Your ${listLabel}-pick list order, then EPA`
                : `By EPA — no ${listLabel}-pick list yet`}
              {ourRank != null ? ` · excludes teams ranked above #${ourRank}` : ''}
            </span>
            {/* Active-list switcher: auto-flips to 2nd pick when our first pick
                lands (we picked / got picked); always manually switchable. */}
            <div
              className="inline-flex rounded-md border border-border p-0.5"
              role="tablist"
              aria-label="Active picklist"
            >
              {(
                [
                  ['first', '1st pick'],
                  ['second', '2nd pick'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeList === id}
                  data-testid={`draft-list-${id}`}
                  onClick={() => setActiveList(id)}
                  className={cn(
                    'rounded px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    activeList === id
                      ? 'bg-brand/20 text-brand'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {best.length === 0 ? (
            <div data-testid="draft-best-empty" className="text-sm text-muted-foreground">
              No teams left to pick.
            </div>
          ) : (
            <ol data-testid="draft-best" className="flex flex-col gap-2">
              {best.map((r, i) =>
                i === 0 ? (
                  // #1 — the recommended action. Brand-filled, oversized number,
                  // a loud PICK NEXT eyebrow, and a primary Pick button.
                  <li
                    key={r.teamNumber}
                    data-testid={`draft-best-${r.teamNumber}`}
                    className="flex flex-col gap-2 rounded-xl border-2 border-brand bg-brand/15 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="eyebrow flex items-center gap-1.5 text-brand">
                          <Star className="size-3.5 shrink-0" /> Pick next
                        </span>
                        <div className="flex min-w-0 items-baseline gap-2.5">
                          <TeamNumber
                            team={r.teamNumber}
                            onSelect={onSelectTeam}
                            testid={`draft-best-team-${r.teamNumber}`}
                            className="font-display text-3xl leading-none tabular-nums text-brand"
                          />
                          {r.nickname ? (
                            <span className="truncate text-sm text-muted-foreground">
                              {r.nickname}
                            </span>
                          ) : null}
                        </div>
                        <span className="flex items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                          <span>EPA {r.epa == null ? EM_DASH : fmt(r.epa)}</span>
                          <span>{fmt(r.expectedPoints, 1)} pts</span>
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          data-testid={`draft-pick-ours-${r.teamNumber}`}
                          onClick={() => toggle(r.teamNumber, 'ours')}
                        >
                          <Star /> Pick
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid={`draft-pick-taken-${r.teamNumber}`}
                          onClick={() => toggle(r.teamNumber, 'taken')}
                        >
                          <X /> Taken
                        </Button>
                      </div>
                    </div>
                    {/* Scouting note for this team from the picklist, so the lead sees
                        WHY it's a good pick without leaving the draft. */}
                    {r.note ? (
                      <p
                        data-testid={`draft-best-note-${r.teamNumber}`}
                        className="flex items-start gap-1.5 border-t border-brand/25 pt-2 text-xs text-muted-foreground"
                      >
                        <StickyNote className="mt-0.5 size-3 shrink-0 text-brand/70" />
                        <span className="min-w-0">{r.note}</span>
                      </p>
                    ) : null}
                  </li>
                ) : (
                  // #2 / #3 — quieter, smaller runners-up.
                  <li
                    key={r.teamNumber}
                    data-testid={`draft-best-${r.teamNumber}`}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="eyebrow shrink-0 text-muted-foreground">#{i + 1}</span>
                        <TeamNumber
                          team={r.teamNumber}
                          onSelect={onSelectTeam}
                          testid={`draft-best-team-${r.teamNumber}`}
                          className="font-mono text-sm font-semibold tabular-nums text-brand"
                        />
                        {r.nickname ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {r.nickname}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                        <span>EPA {r.epa == null ? EM_DASH : fmt(r.epa)}</span>
                        <span className="hidden sm:inline">{fmt(r.expectedPoints, 1)} pts</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid={`draft-pick-ours-${r.teamNumber}`}
                          onClick={() => toggle(r.teamNumber, 'ours')}
                        >
                          <Star /> Pick
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid={`draft-pick-taken-${r.teamNumber}`}
                          onClick={() => toggle(r.teamNumber, 'taken')}
                        >
                          <X /> Taken
                        </Button>
                      </span>
                    </div>
                    {r.note ? (
                      <p
                        data-testid={`draft-best-note-${r.teamNumber}`}
                        className="flex items-start gap-1.5 border-t border-border/50 pt-1 text-xs text-muted-foreground"
                      >
                        <StickyNote className="mt-0.5 size-3 shrink-0 text-brand/70" />
                        <span className="min-w-0">{r.note}</span>
                      </p>
                    ) : null}
                  </li>
                ),
              )}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Our alliance: captain + our picks, with combined stats. Always shown so
          the "we got picked by another team" control is reachable even before any
          picks. */}
      <Card className="border-success/40 bg-card" data-testid="draft-alliance">
        <CardHeader className="gap-1 space-y-0">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="size-5 text-success" />
              {pickedBy != null ? `On team ${pickedBy}'s alliance` : 'Our alliance'}
            </CardTitle>
            {pickedBy == null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {ourPicks.length}/2 picked
              </span>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* "We got picked by another team" — flips us from captain to a member. */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">We got picked by</span>
            <select
              data-testid="draft-pickedby"
              value={pickedBy ?? ''}
              onChange={(e) => setPickedBy(e.target.value === '' ? null : Number(e.target.value))}
              className="min-h-9 rounded-md border border-border bg-muted/30 px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— we&apos;re the captain —</option>
              {pickedByCandidates.map((r) => (
                <option key={r.teamNumber} value={r.teamNumber}>
                  {r.teamNumber}
                  {r.nickname ? ` — ${r.nickname}` : ''}
                </option>
              ))}
            </select>
            {pickedBy != null ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="draft-pickedby-clear"
                onClick={() => setPickedBy(null)}
              >
                <X /> Clear
              </Button>
            ) : null}
          </div>

          {alliance.length > 0 ? (
            <>
              {/* Combined stat tiles. */}
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Alliance EPA
                  </span>
                  <span data-testid="draft-alliance-epa" className="text-lg font-semibold tabular-nums text-energy">
                    {allianceStats.epaSum == null ? EM_DASH : fmt(allianceStats.epaSum)}
                  </span>
                </div>
                <div className="flex flex-col rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Scout exp. pts
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-foreground">
                    {fmt(allianceStats.expSum, 1)}
                  </span>
                </div>
                <div className="flex flex-col rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Climbers
                  </span>
                  <span className="text-lg font-semibold tabular-nums text-success">
                    {allianceStats.climbers}/{allianceStats.size}
                  </span>
                </div>
              </div>
              {/* Member chips: captain first (badged), then us / picks. Team numbers
                  link to the Team page; picks carry a remove button. */}
              <ul data-testid="draft-ours" className="flex flex-wrap gap-2">
                {alliance.map((r) => {
                  const isCaptain = r.teamNumber === captainTeam;
                  const removable = !isCaptain && !r.isUs;
                  return (
                    <li
                      key={r.teamNumber}
                      data-testid={`draft-alliance-member-${r.teamNumber}`}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm',
                        isCaptain || r.isUs
                          ? 'border-brand/50 bg-brand/10'
                          : 'border-success/40 bg-success/10',
                      )}
                    >
                      <TeamNumber
                        team={r.teamNumber}
                        onSelect={onSelectTeam}
                        testid={`draft-alliance-team-${r.teamNumber}`}
                        className={cn(
                          'font-semibold tabular-nums',
                          isCaptain || r.isUs ? 'text-brand' : 'text-success',
                        )}
                      />
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {r.epa == null ? EM_DASH : `EPA ${fmt(r.epa)}`}
                      </span>
                      {isCaptain ? (
                        <span className="rounded-full bg-brand/20 px-1.5 text-[10px] font-medium text-brand">
                          captain
                        </span>
                      ) : null}
                      {r.isUs ? (
                        <span className="rounded-full bg-brand/20 px-1.5 text-[10px] font-medium text-brand">
                          you
                        </span>
                      ) : null}
                      {removable ? (
                        <button
                          type="button"
                          aria-label={`Remove ${r.teamNumber} from our alliance`}
                          data-testid={`draft-ours-remove-${r.teamNumber}`}
                          onClick={() => toggle(r.teamNumber, 'ours')}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p data-testid="draft-alliance-empty" className="text-sm text-muted-foreground">
              No alliance yet — mark picks below, or set who picked us.
            </p>
          )}
        </CardContent>
      </Card>

      {/* The pool — every team, ranked, with one-tap cross-off. */}
      <Card className="bg-card">
        <CardHeader className="gap-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Team pool</CardTitle>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="draft-reset"
              onClick={resetAll}
            >
              <RotateCcw /> Reset
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              inputMode="search"
              data-testid="draft-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search team # or name…"
              aria-label="Search teams"
              className="w-full rounded-md border border-border bg-muted/30 py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </CardHeader>
        <CardContent>
          {visibleRows.length === 0 ? (
            <div data-testid="draft-pool-empty" className="text-sm text-muted-foreground">
              No teams match your search.
            </div>
          ) : (
            <ul data-testid="draft-pool" className="flex flex-col gap-2">
              {visibleRows.map((r, i) => (
                <li
                  key={r.teamNumber}
                  data-testid={`draft-row-${r.teamNumber}`}
                  className={cn(
                    'flex flex-col gap-2 rounded-xl border px-3 py-2 text-sm',
                    rowTone(r.status),
                    // Teams we can't pick (ranked above us, or a top-8 seed after
                    // our first pick) read as taken — dimmed + struck through.
                    (r.blockedByRank || r.blockedTop8) && r.status === 'available' && 'opacity-55',
                  )}
                >
                  {/* Line 1 — identity on the left, primary action on the right. */}
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-6 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <TeamNumber
                        team={r.teamNumber}
                        onSelect={onSelectTeam}
                        testid={`draft-team-${r.teamNumber}`}
                        className={cn(
                          'font-display text-base font-semibold tabular-nums text-brand',
                          (r.status === 'taken' || r.blockedByRank || r.blockedTop8) &&
                            'line-through',
                        )}
                      />
                      {r.nickname ? (
                        <span className="truncate text-xs text-muted-foreground">{r.nickname}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={r.status === 'ours' ? 'default' : 'outline'}
                        data-testid={`draft-ours-${r.teamNumber}`}
                        // Can't add ourselves, a team ranked above us, or (after our
                        // first pick) a top-8 seed to our alliance.
                        disabled={
                          r.isUs || ((r.blockedByRank || r.blockedTop8) && r.status !== 'ours')
                        }
                        title={
                          r.isUs
                            ? "That's us — you're the captain"
                            : r.blockedByRank
                              ? `Ranked above us (#${r.tbaRank}) — can't pick`
                              : r.blockedTop8
                                ? `Top-8 seed (#${r.tbaRank}) — unavailable by our 2nd pick`
                                : undefined
                        }
                        onClick={() => toggle(r.teamNumber, 'ours')}
                        aria-label={`Mark team ${r.teamNumber} as ours`}
                      >
                        {/* Icon-only under 420px so the team nickname keeps
                            readable width on phones. */}
                        <Star /> <span className="max-[420px]:hidden">Ours</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={r.status === 'taken' ? 'secondary' : 'ghost'}
                        data-testid={`draft-taken-${r.teamNumber}`}
                        // We can't be "taken" by another alliance — we're a captain.
                        disabled={r.isUs}
                        onClick={() => toggle(r.teamNumber, 'taken')}
                        aria-label={
                          r.status === 'taken'
                            ? `Undo taken for team ${r.teamNumber}`
                            : `Mark team ${r.teamNumber} as taken`
                        }
                      >
                        {r.status === 'taken' ? (
                          <>
                            <RotateCcw /> <span className="max-[420px]:hidden">Undo</span>
                          </>
                        ) : (
                          <>
                            <X /> <span className="max-[420px]:hidden">Taken</span>
                          </>
                        )}
                      </Button>
                    </span>
                  </div>
                  {/* Line 2 — compact stat strip + small badges, aligned. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-8">
                    <span className="flex items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                      <span>
                        <span className="text-muted-foreground/60">EPA</span>{' '}
                        {r.epa == null ? EM_DASH : fmt(r.epa)}
                      </span>
                      <span>
                        {fmt(r.expectedPoints, 1)}
                        <span className="text-muted-foreground/60"> pts</span>
                      </span>
                      <span>
                        <span className="text-muted-foreground/60">climb</span>{' '}
                        {pct(r.climbSuccessRate)}
                      </span>
                    </span>
                    {r.picklistRank != null ? (
                      <span
                        data-testid={`draft-picklist-rank-${r.teamNumber}`}
                        className="rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-brand"
                        title={`Position on your ${listLabel}-pick list`}
                      >
                        #{r.picklistRank + 1}
                      </span>
                    ) : r.onOtherList ? (
                      <span
                        data-testid={`draft-other-list-${r.teamNumber}`}
                        className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
                        title={`On your ${otherListLabel}-pick list`}
                      >
                        {otherListLabel} list
                      </span>
                    ) : null}
                    {r.isUs ? (
                      <span
                        data-testid={`draft-us-${r.teamNumber}`}
                        className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand"
                        title="Your team — you're the captain"
                      >
                        <Trophy className="size-3" /> You
                      </span>
                    ) : null}
                    {r.blockedByRank ? (
                      <span
                        data-testid={`draft-blocked-${r.teamNumber}`}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={`Ranked #${r.tbaRank} — above us (#${ourRank}); can't pick`}
                      >
                        <Lock className="size-3" /> rank #{r.tbaRank}
                      </span>
                    ) : r.blockedTop8 ? (
                      <span
                        data-testid={`draft-top8-${r.teamNumber}`}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={`Top-8 seed (#${r.tbaRank}) — a captain or taken before our 2nd pick`}
                      >
                        <Lock className="size-3" /> top 8
                      </span>
                    ) : null}
                    {r.dnp ? (
                      <span
                        data-testid={`draft-dnp-${r.teamNumber}`}
                        className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                      >
                        <Ban className="size-3" /> DNP
                      </span>
                    ) : null}
                    {r.tier ? (
                      <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                        {r.tier}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
