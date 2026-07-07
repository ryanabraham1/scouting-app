import { useEffect, useState } from 'react';
import { CalendarClock, CheckCircle2, PartyPopper } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { supabase } from '@/lib/supabase';
import { nexusGet } from '@/dash/proxies';
import { parseNexusEventStatus, type NexusEventStatus } from '@/dash/nexusClient';
import { NEXUS_POLL_MS } from '@/dash/constants';
import { getCachedMatches } from '@/db/preloadClient';
import { cn } from '@/lib/utils';
import { OnDeckAlert } from '@/capture/OnDeckAlert';
import { selectOnDeck, nexusStatusForKey } from '@/capture/onDeck';

/** Raw `match` row shape we care about for the scout's match list. */
export interface UpcomingMatchRow {
  match_key: string;
  event_key: string;
  comp_level: string;
  match_number: number;
  scheduled_time: string | null;
  red1: number | null;
  red2: number | null;
  red3: number | null;
  blue1: number | null;
  blue2: number | null;
  blue3: number | null;
  actual_red_score: number | null;
  actual_blue_score: number | null;
  winner: string | null;
  result_synced_at: string | null;
}

/** The scout's assignment for a match (what they actually have to scout). */
export interface ScoutAssignment {
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

const COMP_LEVEL_LABEL: Record<string, string> = {
  qm: 'Qualification',
  qf: 'Quarterfinal',
  sf: 'Semifinal',
  f: 'Final',
};

// qm < qf < sf < f for tie-break ordering.
const COMP_LEVEL_ORDER: Record<string, number> = { qm: 0, qf: 1, sf: 2, f: 3 };

/** Parse the trailing "qm73"/"sf1" segment out of a match key like "2026casnv_qm73". */
function parseMatchKeyParts(key: string): { comp: string; num: number } | null {
  const tail = key.split('_').pop() ?? key;
  const m = /^([a-z]+)(\d+)$/i.exec(tail);
  if (!m) return null;
  return { comp: m[1].toLowerCase(), num: Number(m[2]) };
}

export function matchLabel(m: Pick<UpcomingMatchRow, 'comp_level' | 'match_number'>): string {
  const name = COMP_LEVEL_LABEL[m.comp_level] ?? m.comp_level.toUpperCase();
  return `${name} ${m.match_number}`;
}

/**
 * Friendly label derived purely from a match key — e.g. "2026casnv_qm73" →
 * "Qualification 73". Falls back to the raw key only if it can't be parsed.
 */
export function matchLabelFromKey(key: string): string {
  const parts = parseMatchKeyParts(key);
  if (!parts) return key;
  const name = COMP_LEVEL_LABEL[parts.comp] ?? parts.comp.toUpperCase();
  return `${name} ${parts.num}`;
}

/** A match is "upcoming" if it has no recorded result yet. */
export function isUpcoming(m: UpcomingMatchRow): boolean {
  return m.winner == null && m.result_synced_at == null;
}

interface EnrichedAssignment {
  assignment: ScoutAssignment;
  match: UpcomingMatchRow | null;
}

/** Sort fields from the joined match row, or parsed from the key when offline. */
function sortFields(e: EnrichedAssignment): { time: string | null; lvl: number; num: number } {
  if (e.match) {
    return {
      time: e.match.scheduled_time,
      lvl: COMP_LEVEL_ORDER[e.match.comp_level] ?? 99,
      num: e.match.match_number,
    };
  }
  const parts = parseMatchKeyParts(e.assignment.match_key);
  return { time: null, lvl: parts ? COMP_LEVEL_ORDER[parts.comp] ?? 99 : 99, num: parts?.num ?? 0 };
}

/** scheduled_time asc (nulls last) → comp_level order → match_number. */
function sortEnriched(a: EnrichedAssignment, b: EnrichedAssignment): number {
  const af = sortFields(a);
  const bf = sortFields(b);
  if (af.time && bf.time) {
    const cmp = af.time.localeCompare(bf.time);
    if (cmp !== 0) return cmp;
  } else if (af.time && !bf.time) {
    return -1;
  } else if (!af.time && bf.time) {
    return 1;
  }
  if (af.lvl !== bf.lvl) return af.lvl - bf.lvl;
  return af.num - bf.num;
}

function TeamChip(props: { team: number | null; color: 'red' | 'blue'; highlight: boolean }) {
  if (props.team == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      data-testid={props.highlight ? 'scout-upcoming-target' : undefined}
      className={cn(
        'rounded px-1.5 py-0.5 font-mono text-xs',
        props.color === 'red' ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300',
        props.highlight && 'ring-2 ring-yellow-400 font-bold',
      )}
    >
      {props.team}
    </span>
  );
}

export interface UpcomingMatchesProps {
  eventKey: string;
  /** The scout's assignments — the matches they actually have to scout. */
  assignments: ScoutAssignment[];
  /** Start capturing the tapped assignment. */
  onStart: (a: ScoutAssignment) => void;
  /**
   * Keys (`${match_key}:${target_team_number}`) the scout already has a saved
   * report for. These move out of the "To scout" feed into the "Completed" tab.
   */
  completedKeys?: Set<string>;
}

/** Stable completion key for an assignment / report: match + target team. */
export function assignmentKey(a: Pick<ScoutAssignment, 'match_key' | 'target_team_number'>): string {
  return `${a.match_key}:${a.target_team_number}`;
}

/**
 * Provider-free "matches to scout" list for the scout home. Shows ONLY the
 * matches this scout is assigned to that are not-yet-played, soonest first, with
 * friendly labels ("Qualification 73") and the team/station they're scouting.
 * Tapping a row starts capture for that assignment.
 */
/**
 * Does a Nexus live status flag this match key as currently queuing / on deck /
 * on field? Matches the trailing number plus a shared level-prefix defensively,
 * since Nexus labels ("Qualification 73") differ from our keys ("..._qm73").
 */
function liveStatusForKey(status: NexusEventStatus | null, key: string): string | null {
  const s = nexusStatusForKey(status, key);
  if (s === 'now queuing' || s === 'on deck' || s === 'on field') return s;
  return null;
}

export function UpcomingMatches({
  eventKey,
  assignments,
  onStart,
  completedKeys,
}: UpcomingMatchesProps) {
  const [matches, setMatches] = useState<UpcomingMatchRow[] | null>(null);
  // Optional Nexus live status. Fetched directly (no react-query) so this stays
  // self-contained; null/unavailable simply hides the live affordances.
  const [nexus, setNexus] = useState<NexusEventStatus | null>(null);
  // Which tab is shown: matches still TO scout (upcoming), ones already DONE, or
  // NOT FINISHED (already played but never scouted). Defaults to the to-do feed.
  const [view, setView] = useState<'todo' | 'done' | 'missed'>('todo');

  useEffect(() => {
    if (!eventKey) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Offline-first: show the cached schedule immediately so a reload with no
      // wifi renders matches instead of spinning on "Loading matches…" forever.
      // CachedMatch is structurally identical to UpcomingMatchRow.
      const cached = await getCachedMatches(eventKey);
      if (cancelled) return;
      const hadCache = cached.length > 0;
      if (hadCache) setMatches(cached as UpcomingMatchRow[]);

      // Then refresh from the network when reachable. If the query throws or
      // returns nothing/error, keep whatever we already showed from cache.
      try {
        const res = await supabase
          .from('match')
          .select(
            'match_key,event_key,comp_level,match_number,scheduled_time,red1,red2,red3,blue1,blue2,blue3,actual_red_score,actual_blue_score,winner,result_synced_at',
          )
          .eq('event_key', eventKey);
        if (cancelled) return;
        if (!res.error && res.data) {
          setMatches(res.data as UpcomingMatchRow[]);
        } else if (!hadCache) {
          // Genuinely nothing (no cache, network gave nothing): show the empty
          // state rather than leaving `null` (loading) forever.
          setMatches([]);
        }
      } catch {
        if (cancelled) return;
        // Offline / transport error. Only fall to empty if we had no cache.
        if (!hadCache) setMatches([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  // Live field status from Nexus (degrades silently when unavailable). This is
  // REAL-TIME data, so we poll on NEXUS_POLL_MS rather than fetching once — the
  // proxy is uncached, so each poll reflects the current field.
  useEffect(() => {
    if (!eventKey) {
      setNexus(null);
      return;
    }
    let cancelled = false;
    const fetchNexus = async (): Promise<void> => {
      const json = await nexusGet<unknown>(`/event/${eventKey}`);
      if (cancelled) return;
      const unavailable =
        typeof json === 'object' &&
        json !== null &&
        (json as { available?: unknown }).available === false;
      setNexus(unavailable ? null : parseNexusEventStatus(json));
    };
    void fetchNexus();
    const id = setInterval(() => void fetchNexus(), NEXUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [eventKey]);

  const byKey = new Map((matches ?? []).map((m) => [m.match_key, m]));
  const done = completedKeys ?? new Set<string>();
  const enrichedAll: EnrichedAssignment[] = assignments
    .map((assignment) => ({ assignment, match: byKey.get(assignment.match_key) ?? null }))
    .sort(sortEnriched);

  // To scout: not yet completed AND still upcoming (if we know the result; offline
  // / un-imported matches are assumed upcoming). Completed: a saved report exists.
  // Not finished: not completed AND the match has already been played — an
  // outstanding assignment the scout missed (so it stays visible to backfill,
  // instead of vanishing once an event's matches are all played).
  const todoList = enrichedAll.filter(
    (e) => !done.has(assignmentKey(e.assignment)) && (e.match ? isUpcoming(e.match) : true),
  );
  const doneList = enrichedAll.filter((e) => done.has(assignmentKey(e.assignment)));
  const missedList = enrichedAll.filter(
    (e) =>
      !done.has(assignmentKey(e.assignment)) && e.match != null && !isUpcoming(e.match),
  );
  const shown = view === 'done' ? doneList : view === 'missed' ? missedList : todoList;
  const hasAny = todoList.length > 0 || doneList.length > 0 || missedList.length > 0;

  // "You're on deck" alert: most-urgent imminent assigned match, driven by live
  // Nexus status (degrades to schedule-time when Nexus is unavailable). todoList
  // is already sorted soonest-first, exactly what selectOnDeck expects.
  const onDeck = selectOnDeck(
    todoList.map((e) => e.assignment),
    nexus,
    (a) => byKey.get(a.match_key)?.scheduled_time ?? null,
  );

  return (
    <section data-testid="scout-upcoming-matches">
      {onDeck ? (
        <div className="mb-3">
          <OnDeckAlert result={onDeck} onStart={onStart} />
        </div>
      ) : null}
      {/* Title on its own line, filter tabs full-width below — side-by-side the
          three counted tabs wrapped into a ragged second line on phones. */}
      <div className="mb-3 flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarClock className="size-5 text-brand" /> Your matches to scout
        </h2>
        {hasAny ? (
          <SegmentedToggle<'todo' | 'done' | 'missed'>
            ariaLabel="Show matches to scout, not finished, or already completed"
            size="default"
            value={view}
            onChange={setView}
            options={[
              { value: 'todo', label: `To scout (${todoList.length})` },
              {
                value: 'missed',
                label: `Missed (${missedList.length})`,
                activeClassName: 'text-warning',
              },
              {
                value: 'done',
                label: `Done (${doneList.length})`,
                activeClassName: 'text-success',
              },
            ]}
          />
        ) : null}
      </div>
      {matches == null ? (
        <p className="text-sm text-muted-foreground">Loading matches…</p>
      ) : !hasAny ? (
        <p className="text-sm text-muted-foreground">
          No matches assigned to you. Use Manual pick below if you need to scout one.
        </p>
      ) : shown.length === 0 ? (
        <p
          data-testid={`scout-upcoming-empty-${view}`}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          {view === 'done' ? (
            'No completed matches yet — scouted matches will show up here.'
          ) : view === 'missed' ? (
            'Nothing unfinished — assigned matches you missed will show here.'
          ) : (
            <>
              <PartyPopper className="size-4 shrink-0 text-success" />
              All caught up — no upcoming assigned matches left.
            </>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 landscape:grid landscape:grid-cols-2">
          {shown.map(({ assignment: a, match: m }) => {
            const isDone = view === 'done';
            const isMissed = view === 'missed';
            // Live (queuing/on-field) affordance only matters for the upcoming feed.
            const liveStatus = view === 'todo' ? liveStatusForKey(nexus, a.match_key) : null;
            return (
            <li key={a.match_key} data-testid="scout-upcoming-match">
              <Button
                data-testid="scout-assignment"
                variant="outline"
                size="big"
                className={cn(
                  'flex h-auto w-full flex-col items-stretch gap-2 rounded-xl border-l-4 px-3 py-3 text-left',
                  isDone
                    ? 'border-l-success/70 opacity-90'
                    : isMissed
                      ? 'border-l-warning/60 opacity-90'
                      : 'border-l-brand/50',
                  liveStatus && 'border-l-success ring-2 ring-success',
                )}
                onClick={() => onStart(a)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">
                    {isDone ? (
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                    ) : null}
                    <span className="truncate">{matchLabelFromKey(a.match_key)}</span>
                    {liveStatus ? (
                      <span
                        data-testid="scout-upcoming-live"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success"
                      >
                        <span className="relative flex size-2">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
                          <span className="relative inline-flex size-2 rounded-full bg-success" />
                        </span>
                        {liveStatus}
                      </span>
                    ) : null}
                  </span>
                  {/* Assignment chip: the target team is the hero number; the
                      alliance/station detail sits under it in small caps. */}
                  <span
                    className={cn(
                      'flex shrink-0 flex-col items-end rounded-lg px-2 py-1 leading-tight',
                      a.alliance_color === 'red'
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-blue-500/15 text-blue-300',
                    )}
                  >
                    <span
                      className={cn(
                        'font-mono text-sm font-bold tabular-nums',
                        a.alliance_color === 'red' ? 'text-red-200' : 'text-blue-200',
                      )}
                    >
                      #{a.target_team_number}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide opacity-90">
                      {isDone ? 'scouted' : `${a.alliance_color} ${a.station}`}
                    </span>
                  </span>
                </div>
                {m ? (
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 flex-wrap gap-1">
                      {[m.red1, m.red2, m.red3].map((t, i) => (
                        <TeamChip
                          key={`r${i}`}
                          team={t}
                          color="red"
                          highlight={t != null && t === a.target_team_number}
                        />
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">vs</span>
                    <div className="flex flex-1 flex-wrap justify-end gap-1">
                      {[m.blue1, m.blue2, m.blue3].map((t, i) => (
                        <TeamChip
                          key={`b${i}`}
                          team={t}
                          color="blue"
                          highlight={t != null && t === a.target_team_number}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {isDone ? (
                  <span className="text-xs font-medium text-success">
                    Tap to review or re-scout
                  </span>
                ) : null}
              </Button>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
