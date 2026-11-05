// src/dash/AutoScoutCards.tsx — Auto-Scout estimates where the data is read: the Match page (with
// its status and a Run button) and the Team page's scoring section. Team cards render nothing
// until there is data, so events that never run Auto-Scout look exactly as before.
import { Bot, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatTile } from '@/components/ui/StatTile';
import { TeamLink } from '@/components/ui/TeamLink';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { cn } from '@/lib/utils';
import {
  matchProgress,
  useAutoScoutJobs,
  useAutoScoutResults,
  useEnqueueAutoScout,
} from '@/dash/autoScoutClient';
import { teamAutoScout, toTeamMatch, type AutoScoutTeamMatch } from '@/dash/autoScoutStats';

const CARD = 'border-0 bg-transparent shadow-none sm:border sm:border-zinc-800 sm:bg-zinc-950';

function Heading({ title }: { title: string }) {
  return (
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-0 sm:px-6">
      <CardTitle className="flex items-center gap-2 text-zinc-100">
        <Bot className="size-5 text-brand" />
        {title}
      </CardTitle>
      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        Video estimate
      </span>
    </CardHeader>
  );
}

function value(n: number | null, digits = 0): string {
  return n == null ? '—' : n.toFixed(digits);
}

function towers(m: AutoScoutTeamMatch): string {
  return [m.autoTower && `Auto ${m.autoTower}`, m.endgameTower && `End ${m.endgameTower}`].filter(Boolean).join(' · ') || '—';
}

export function AutoScoutTeamCard({ eventKey, teamNumber }: { eventKey: string | null; teamNumber: number }) {
  const { data } = useAutoScoutResults(eventKey);
  const summary = teamAutoScout(data, teamNumber);
  if (!summary) return null;
  const top = Math.max(...summary.matches.map((m) => m.fuel ?? 0), 1);
  const guessed = summary.matches.some((m) => m.lowConfidence);
  return (
    <Card className={CARD} data-testid="team-autoscout">
      <Heading title="Auto-Scout" />
      <CardContent className="flex flex-col gap-4 px-0 sm:px-6">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile label="Fuel / match" value={value(summary.avgFuel, 1)} tone="energy" sub={`${summary.matches.length} match${summary.matches.length === 1 ? '' : 'es'}`} />
          <StatTile label="Auto fuel" value={value(summary.avgFuelAuto, 1)} />
          <StatTile label="Teleop fuel" value={value(summary.avgFuelTeleop, 1)} />
          <StatTile label="Fed" value={value(summary.avgFed, 1)} />
        </div>
        <ul className="flex flex-col gap-1.5">
          {summary.matches.map((m) => (
            <li
              key={m.matchKey}
              className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)_3rem_auto] items-center gap-3 text-sm', m.lowConfidence && 'opacity-60')}
            >
              <span className="font-mono text-xs">{formatMatchKeyRaw(m.matchKey)}{m.lowConfidence ? ' ?' : ''}</span>
              <span className="h-2 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-energy" style={{ width: `${((m.fuel ?? 0) / top) * 100}%` }} />
              </span>
              <span className="text-right font-mono tabular-nums">{value(m.fuel)}</span>
              <span className="w-24 truncate text-right text-xs text-muted-foreground">{towers(m)}</span>
            </li>
          ))}
        </ul>
        {guessed && (
          <p className="text-xs text-muted-foreground">
            ? = the robot’s identity was unsure, so that match is left out of the averages.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AllianceShare({ rows }: { rows: { team: string; m: AutoScoutTeamMatch }[] }) {
  const total = rows.reduce((sum, r) => sum + (r.m.fuel ?? 0), 0);
  const red = rows[0]?.m.alliance === 'red';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className={cn('text-xs font-semibold uppercase tracking-wide', red ? 'text-red-400' : 'text-blue-400')}>
          {red ? 'Red' : 'Blue'}
        </span>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{total} fuel</span>
      </div>
      {rows.map(({ team, m }) => (
        <div key={team} className="grid grid-cols-[3.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-sm">
          <TeamLink team={Number(team)} className="font-mono font-semibold tabular-nums" />
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className={cn('block h-full rounded-full', red ? 'bg-red-500' : 'bg-blue-500')}
              style={{ width: `${total ? ((m.fuel ?? 0) / total) * 100 : 0}%` }}
            />
          </span>
          <span className="text-right font-mono tabular-nums">{value(m.fuel)}{m.lowConfidence ? ' ?' : ''}</span>
          <span className="col-span-3 -mt-1 pl-[4rem] text-xs text-muted-foreground">
            Auto {value(m.fuelAuto)} · Teleop {value(m.fuelTeleop)} · Fed {value(m.fed)}
            {towers(m) !== '—' ? ` · ${towers(m)}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  waiting: 'Waiting for the clip',
  clipped: 'Clipped, ready to scout',
  queued: 'Queued on the Auto-Scout computer',
  processing: 'Processing',
};

export function AutoScoutMatchCard({
  eventKey,
  matchKey,
  played,
}: {
  eventKey: string;
  matchKey: string;
  played: boolean;
}) {
  const { data: results } = useAutoScoutResults(eventKey);
  const { data: jobs } = useAutoScoutJobs(eventKey);
  const enqueue = useEnqueueAutoScout();
  const row = results?.find((r) => r.match_key === matchKey);

  if (row?.teams) {
    const teams = Object.entries(row.teams)
      .map(([team, stats]) => ({ team, m: toTeamMatch(row, stats), station: Number(stats.station) }))
      .sort((a, b) => a.station - b.station);
    return (
      <Card className={cn(CARD, 'sm:border-border sm:bg-card')} data-testid="match-autoscout">
        <Heading title="Auto-Scout" />
        <CardContent className="grid gap-6 px-0 sm:px-6 md:grid-cols-2">
          <AllianceShare rows={teams.filter((t) => t.m.alliance === 'red')} />
          <AllianceShare rows={teams.filter((t) => t.m.alliance === 'blue')} />
        </CardContent>
      </Card>
    );
  }

  if (!played) return null;
  const item = matchProgress([{ match_key: matchKey, actual_time: null }], jobs ?? [], results ?? [])[0];
  const status = item.phase === 'skipped' ? item.detail : STATUS_TEXT[item.phase];
  const canRun = !STATUS_TEXT[item.phase] || item.phase === 'clipped';
  return (
    <div
      data-testid="match-autoscout-empty"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Bot className="size-4 shrink-0 text-brand" />
        <span className="truncate">
          {status ?? 'No Auto-Scout data for this match yet'}
          {item.phase === 'processing' && item.pct != null ? ` · ${Math.round(item.pct)}%` : ''}
        </span>
      </span>
      {canRun && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={enqueue.isPending}
          onClick={() =>
            enqueue.mutate({
              eventKey,
              kind: 'vod',
              matchKeys: [matchKey],
              sourceUrl: null,
              streamStarts: {},
              force: false,
              scout: true,
            })
          }
        >
          <Play className="size-3.5" />
          Run Auto-Scout
        </Button>
      )}
      {enqueue.error && <p role="alert" className="w-full text-destructive">{enqueue.error.message}</p>}
    </div>
  );
}
