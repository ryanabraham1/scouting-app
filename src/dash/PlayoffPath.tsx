// src/dash/PlayoffPath.tsx
// A focused, column-sized playoff view for the Next-Match screen: instead of the
// whole double-elim tree, it answers the only questions our team actually has —
// "which match are we in, where do we go if we win, where do we go if we lose, and
// who do we play?" The opponent in a future match is the winner/loser of another
// match still to be decided, so it's shown as "Winner of M8" until that result
// lands, then resolves to the real teams. Pure/presentational over already-fetched
// schedule rows (see playoffModel.ts for the bracket graph).

import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Trophy, Flag, CircleSlash } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MatchRow } from '@/dash/useEventData';
import {
  type Feed,
  type Destination,
  redTeams,
  blueTeams,
  isPlayed,
  sfSet,
  slotForSet,
  feedLabel,
  resolveFeedTeams,
  winDestination,
  loseDestination,
} from '@/dash/playoffModel';

export interface PlayoffPathProps {
  matches: MatchRow[];
  baseTeam: number;
  ['data-testid']?: string;
}

/** Our alliance's teams + the opponent's, plus which color we are, for a row. */
function ourSide(row: MatchRow, baseTeam: number): { ours: number[]; opp: number[]; color: 'red' | 'blue' } | null {
  const r = redTeams(row);
  const b = blueTeams(row);
  if (r.includes(baseTeam)) return { ours: r, opp: b, color: 'red' };
  if (b.includes(baseTeam)) return { ours: b, opp: r, color: 'blue' };
  return null;
}

function TeamLine(props: { teams: number[]; color: 'red' | 'blue' | 'neutral'; baseTeam: number }) {
  const { teams, color, baseTeam } = props;
  const base = color === 'red' ? 'text-red-300' : color === 'blue' ? 'text-blue-300' : 'text-foreground';
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-sm tabular-nums">
      {teams.map((t) => (
        <span
          key={t}
          className={cn(base, t === baseTeam && 'rounded bg-yellow-400/20 px-1 font-bold text-yellow-200 ring-1 ring-yellow-400/60')}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

/** An opponent that may not be decided yet: real teams once known, else a feed. */
function Opponent(props: { feed: Feed; bySet: Map<number, MatchRow>; baseTeam: number }) {
  const teams = resolveFeedTeams(props.feed, props.bySet);
  if (teams && teams.length) return <TeamLine teams={teams} color="neutral" baseTeam={props.baseTeam} />;
  return <span className="text-sm italic text-muted-foreground">{feedLabel(props.feed)}</span>;
}

/** Headline for where a branch leads. */
function destTitle(d: Destination): string {
  switch (d.kind) {
    case 'finals':
      return 'Finals';
    case 'set':
      return `${d.slot.tag} · ${d.slot.round}`;
    case 'champion':
      return 'Champions';
    case 'eliminated':
      return 'Eliminated';
  }
}

/** One "if we win / if we lose" branch. */
function Branch(props: {
  outcome: 'win' | 'lose';
  dest: Destination;
  bySet: Map<number, MatchRow>;
  baseTeam: number;
  testid: string;
}) {
  const { outcome, dest, bySet, baseTeam, testid } = props;
  const win = outcome === 'win';
  const Icon = win ? ArrowUp : ArrowDown;
  const tone = win
    ? 'border-l-success/70 bg-success/5'
    : dest.kind === 'eliminated'
      ? 'border-l-destructive/70 bg-destructive/5'
      : 'border-l-amber-400/70 bg-amber-400/5';
  const showOpponent = dest.kind === 'set' || dest.kind === 'finals';
  return (
    <div data-testid={testid} className={cn('rounded-md border border-border border-l-[3px] px-3 py-2', tone)}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        <Icon className={cn('size-3.5', win ? 'text-success' : dest.kind === 'eliminated' ? 'text-destructive' : 'text-amber-400')} />
        If we {outcome}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {dest.kind === 'champion' ? <Trophy className="size-4 text-success" /> : null}
        {dest.kind === 'eliminated' ? <CircleSlash className="size-4 text-destructive" /> : null}
        {destTitle(dest)}
      </div>
      {showOpponent ? (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
          <span>vs</span>
          <Opponent feed={dest.opponent} bySet={bySet} baseTeam={baseTeam} />
        </div>
      ) : null}
    </div>
  );
}

export default function PlayoffPath(props: PlayoffPathProps): JSX.Element {
  const { matches, baseTeam, ['data-testid']: testid = 'playoff-path' } = props;

  const { bySet, ourOrdered } = useMemo(() => {
    const map = new Map<number, MatchRow>();
    const sf: { set: number; row: MatchRow }[] = [];
    const finals: MatchRow[] = [];
    for (const m of matches) {
      const lvl = m.comp_level.toLowerCase();
      if (lvl === 'sf') {
        const set = sfSet(m);
        if (set != null) {
          map.set(set, m);
          sf.push({ set, row: m });
        }
      } else if (lvl === 'f') {
        finals.push(m);
      }
    }
    sf.sort((a, b) => a.set - b.set);
    finals.sort((a, b) => a.match_number - b.match_number);
    // Our matches in play order: semifinals (by set) then finals (by game).
    const ours = [
      ...sf.filter((s) => ourSide(s.row, baseTeam)).map((s) => ({ set: s.set, row: s.row, isFinal: false })),
      ...finals.filter((f) => ourSide(f, baseTeam)).map((f) => ({ set: 99, row: f, isFinal: true })),
    ];
    return { bySet: map, ourOrdered: ours };
  }, [matches, baseTeam]);

  const current = ourOrdered.find((o) => !isPlayed(o.row));

  // ── Status when we have no upcoming match (eliminated / champions / waiting) ──
  if (!current) {
    const last = ourOrdered[ourOrdered.length - 1];
    let title = 'Your playoff matches haven’t been scheduled yet.';
    let tone = 'text-muted-foreground';
    let icon = <Flag className="size-4" />;
    if (last) {
      const side = ourSide(last.row, baseTeam);
      const wonLast = side && last.row.winner === side.color;
      if (last.isFinal) {
        const ourWins = ourOrdered.filter((o) => o.isFinal && ourSide(o.row, baseTeam)?.color === o.row.winner).length;
        if (ourWins >= 2) {
          title = 'Champions — you won the event! 🏆';
          tone = 'text-success';
          icon = <Trophy className="size-4 text-success" />;
        } else {
          title = 'Event over — finalists.';
          tone = 'text-foreground';
        }
      } else if (wonLast) {
        title = `Won ${last.row ? `M${sfSet(last.row)}` : 'your match'} — your next match is being set.`;
        tone = 'text-success';
      } else {
        const set = sfSet(last.row);
        const drop: Destination = set != null ? loseDestination(set) : { kind: 'eliminated' };
        if (drop.kind === 'set') {
          title = `Lost — dropped to ${drop.slot.tag} (${drop.slot.round}), awaiting schedule.`;
          tone = 'text-amber-400';
        } else {
          title = 'Eliminated — your playoff run is over.';
          tone = 'text-destructive';
          icon = <CircleSlash className="size-4 text-destructive" />;
        }
      }
    }
    return (
      <div data-testid={`${testid}-status`} className={cn('flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-3 text-sm font-medium', tone)}>
        {icon}
        <span>{title}</span>
      </div>
    );
  }

  // ── Focused current match + win/lose branches ────────────────────────────────
  const side = ourSide(current.row, baseTeam)!;
  const played = isPlayed(current.row);
  const set = sfSet(current.row);

  if (current.isFinal || set == null) {
    // Finals (best of 3): the series win is the whole story.
    const ourWins = ourOrdered.filter((o) => o.isFinal && ourSide(o.row, baseTeam)?.color === o.row.winner).length;
    const oppWins = ourOrdered.filter((o) => o.isFinal && isPlayed(o.row) && ourSide(o.row, baseTeam)?.color !== o.row.winner).length;
    return (
      <div data-testid={testid} className="flex flex-col gap-2.5">
        <div data-testid={`${testid}-current`} className="rounded-xl border border-red-500/40 bg-card/70 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-bold"><Trophy className="size-4 text-red-400" /> Finals</span>
            <span className="text-xs font-semibold tabular-nums text-muted-foreground">series {ourWins}–{oppWins} · best of 3</span>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            <TeamLine teams={side.ours} color={side.color} baseTeam={baseTeam} />
            <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
              <span>vs</span>
              <TeamLine teams={side.opp} color={side.color === 'red' ? 'blue' : 'red'} baseTeam={baseTeam} />
            </div>
          </div>
        </div>
        <Branch outcome="win" dest={{ kind: 'champion' }} bySet={bySet} baseTeam={baseTeam} testid={`${testid}-win`} />
        <p className="text-xs text-muted-foreground">Win two games to take the event.</p>
      </div>
    );
  }

  const winDest = winDestination(set);
  const loseDest = loseDestination(set);

  return (
    <div data-testid={testid} className="flex flex-col gap-2.5">
      {/* The match we're in. */}
      <div data-testid={`${testid}-current`} className="rounded-xl border border-brand/40 bg-card/70 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-foreground">
            M{set} <span className="font-medium text-muted-foreground">· {slotForSet(set)?.round ?? 'Playoffs'}</span>
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', played ? 'bg-muted text-muted-foreground' : 'bg-brand/15 text-brand')}>
            {played ? 'Final' : 'Our next match'}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <TeamLine teams={side.ours} color={side.color} baseTeam={baseTeam} />
            <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-300/80">us</span>
          </div>
          <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            <span className="font-semibold">vs</span>
            {side.opp.length ? (
              <TeamLine teams={side.opp} color={side.color === 'red' ? 'blue' : 'red'} baseTeam={baseTeam} />
            ) : (
              <span className="italic">opponent to be decided</span>
            )}
          </div>
        </div>
      </div>

      {/* Where each outcome takes us. */}
      <div className="flex flex-col gap-2">
        <Branch outcome="win" dest={winDest} bySet={bySet} baseTeam={baseTeam} testid={`${testid}-win`} />
        <Branch outcome="lose" dest={loseDest} bySet={bySet} baseTeam={baseTeam} testid={`${testid}-lose`} />
      </div>

      <p className="text-xs text-muted-foreground">
        “Winner/Loser of M#” fills in with real teams once that match is decided.
      </p>
    </div>
  );
}
