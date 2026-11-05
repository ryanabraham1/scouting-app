// src/dash/AutoScoutTab.tsx — the lead's view of the Auto-Scout video computer. The match schedule
// is the page: each row shows where that match stands and runs it, so there is no separate job
// form. Following the live stream is the one primary action.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Play, Radio, RotateCcw, Settings2, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { StatTile } from '@/components/ui/StatTile';
import { compareMatchKeys, formatMatchKeyRaw } from '@/lib/formatMatch';
import { cn } from '@/lib/utils';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import { useEventInfo, useEventMatches, useWebcastSync, type MatchRow } from '@/dash/useEventData';
import {
  allianceFuel,
  isOpen,
  matchProgress,
  streamChoices,
  unfinishedMatches,
  useAutoScoutJobs,
  useAutoScoutResults,
  useAutoScoutWorker,
  useCancelAutoScout,
  useEnqueueAutoScout,
  workerOnline,
  youtubeId,
  type AutoScoutJob,
  type AutoScoutKind,
  type AutoScoutResultRow,
  type AutoScoutWorker,
  type MatchPhase,
  type MatchProgress,
} from '@/dash/autoScoutClient';

type Filter = 'all' | 'todo' | 'active' | 'done' | 'skipped';
type Source = 'stream' | 'videos' | 'custom';

const PHASE: Record<MatchPhase, { label: string; className: string }> = {
  upcoming: { label: 'Upcoming', className: 'text-muted-foreground' },
  played: { label: 'Not run', className: 'text-foreground' },
  waiting: { label: 'Waiting for clip', className: 'text-warning' },
  clipped: { label: 'Clipped', className: 'text-brand' },
  queued: { label: 'Queued', className: 'text-brand' },
  processing: { label: 'Processing', className: 'text-brand' },
  done: { label: 'Done', className: 'text-success' },
  skipped: { label: 'Skipped', className: 'text-destructive' },
};

const FILTER_PHASES: Record<Filter, MatchPhase[] | null> = {
  all: null,
  todo: ['played', 'clipped'],
  active: ['waiting', 'queued', 'processing'],
  done: ['done'],
  skipped: ['skipped'],
};

const KIND_LABEL: Record<AutoScoutKind, string> = {
  live: 'Live stream',
  vod: 'Stream clips',
  matches: 'Match videos',
};

function teamsOf(match: MatchRow, alliance: 'red' | 'blue'): (number | null)[] {
  return alliance === 'red' ? [match.red1, match.red2, match.red3] : [match.blue1, match.blue2, match.blue3];
}

function Alliance({ match, alliance, baseTeam }: { match: MatchRow; alliance: 'red' | 'blue'; baseTeam: number }) {
  return (
    <span className="grid grid-cols-3 gap-px overflow-hidden rounded-md">
      {teamsOf(match, alliance).map((team, i) => (
        <span
          key={i}
          className={cn(
            'px-1.5 py-1 text-center font-mono text-xs font-semibold tabular-nums',
            alliance === 'red' ? 'bg-red-950/80 text-red-100' : 'bg-blue-950/80 text-blue-100',
            team === baseTeam && 'bg-amber-400 text-neutral-900',
          )}
        >
          {team ?? '—'}
        </span>
      ))}
    </span>
  );
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Banner({ worker, eventKey }: { worker: AutoScoutWorker | null | undefined; eventKey: string }) {
  const online = workerOnline(worker);
  if (!online) {
    return (
      <p role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        {worker
          ? `The Auto-Scout computer was last seen ${new Date(worker.last_seen_at).toLocaleString()}.`
          : 'The Auto-Scout computer hasn’t connected yet.'}{' '}
        Anything you start waits here until it’s back.
      </p>
    );
  }
  if (worker && !worker.calibrated_events.includes(eventKey)) {
    return (
      <p role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        {eventKey} isn’t calibrated on the computer yet, so its matches will fail. Calibrate it there first.
      </p>
    );
  }
  return null;
}

function Now({
  live,
  current,
  match,
  baseTeam,
  onStop,
}: {
  live: AutoScoutJob | undefined;
  current: { job: AutoScoutJob; item: MatchProgress } | null;
  match: MatchRow | undefined;
  baseTeam: number;
  onStop: (id: string) => void;
}) {
  if (!live && !current) return null;
  const eta = current?.job.progress.eta_s;
  return (
    <section data-testid="autoscout-now" className="lead-coverage grid gap-5 lg:grid-cols-2">
      {live && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full rounded-full bg-red-500 opacity-70 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
            </span>
            Following the stream
          </div>
          <p className="text-sm text-muted-foreground">
            {live.cancel_requested ? 'Stopping…' : (live.progress.recorder ?? 'Starting…')}
            {' · '}
            {live.completed_matches.length} scouted
            {live.scout ? '' : `, ${live.progress.clipped?.length ?? 0} clipped`}
          </p>
          {!live.cancel_requested && (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onStop(live.id)}>
                <Square className="size-3.5" />
                Stop following
              </Button>
            </div>
          )}
        </div>
      )}
      {current && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">Now processing {formatMatchKeyRaw(current.item.matchKey)}</span>
            <span className="font-mono text-sm tabular-nums text-muted-foreground">
              {current.item.pct != null ? `${Math.round(current.item.pct)}%` : ''}
              {eta != null ? ` · ${Math.max(1, Math.round(eta / 60))} min left` : ''}
            </span>
          </div>
          {match && (
            <div className="grid max-w-md grid-cols-2 gap-2">
              <Alliance match={match} alliance="red" baseTeam={baseTeam} />
              <Alliance match={match} alliance="blue" baseTeam={baseTeam} />
            </div>
          )}
          <ProgressBar pct={current.item.pct ?? 0} label={`Processing ${current.item.matchKey}`} />
        </div>
      )}
    </section>
  );
}

function Row({
  match,
  item,
  fuel,
  baseTeam,
  selected,
  onToggle,
  onRun,
  disabled,
}: {
  match: MatchRow;
  item: MatchProgress;
  fuel: { red: number; blue: number } | null;
  baseTeam: number;
  selected: boolean;
  onToggle: () => void;
  onRun: () => void;
  disabled: boolean;
}) {
  const phase = PHASE[item.phase];
  const runnable = ['played', 'clipped', 'skipped', 'done'].includes(item.phase);
  const name = formatMatchKeyRaw(match.match_key);
  return (
    <li
      data-testid={`autoscout-row-${match.match_key}`}
      data-phase={item.phase}
      className={cn('autoscout-row border-t border-border first:border-t-0', selected && 'bg-brand/5')}
    >
      <input
        type="checkbox"
        aria-label={`Select ${name}`}
        checked={selected}
        disabled={!runnable}
        onChange={onToggle}
        className="size-4 accent-[hsl(var(--brand))]"
      />
      <Link to={`/analysis?tab=match&match=${match.match_key}`} className="font-mono text-sm font-semibold hover:text-brand">
        {name}
      </Link>
      <span className="autoscout-alliances grid grid-cols-2 gap-2">
        <Alliance match={match} alliance="red" baseTeam={baseTeam} />
        <Alliance match={match} alliance="blue" baseTeam={baseTeam} />
      </span>
      <span className="flex min-w-0 flex-col gap-1" title={item.detail}>
        <span className={cn('truncate text-sm font-medium', phase.className)}>
          {phase.label}
          {item.phase === 'processing' && item.pct != null ? ` ${Math.round(item.pct)}%` : ''}
        </span>
        {item.phase === 'skipped' && item.detail ? (
          <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
        ) : null}
        {item.phase === 'processing' && <ProgressBar pct={item.pct ?? 0} label={`Processing ${match.match_key}`} />}
      </span>
      <span className="autoscout-fuel font-mono text-sm tabular-nums">
        {fuel ? (
          <>
            <span className="text-red-400">{fuel.red}</span>
            <span className="text-muted-foreground"> – </span>
            <span className="text-blue-400">{fuel.blue}</span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span className="text-right">
        {runnable && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRun} aria-label={`Run ${name}`}>
            {item.phase === 'done' ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
          </Button>
        )}
      </span>
    </li>
  );
}

function Activity({ jobs, eventKey }: { jobs: AutoScoutJob[]; eventKey: string }) {
  const cancel = useCancelAutoScout(eventKey);
  const enqueue = useEnqueueAutoScout();
  if (jobs.length === 0) return null;
  return (
    <details className="lead-assignments">
      <summary>Activity ({jobs.length})</summary>
      <ul className="lead-settings-panel">
        {jobs.map((job) => {
          const unfinished = unfinishedMatches(job);
          const skipped = Object.keys(job.match_errors).length;
          return (
            <li key={job.id} data-testid="autoscout-job" className="lead-setting-row">
              <div className="min-w-0">
                <h3>
                  {KIND_LABEL[job.kind]}
                  <span className="ml-2 font-normal capitalize text-muted-foreground">
                    {job.cancel_requested && isOpen(job) ? 'stopping' : job.status}
                  </span>
                </h3>
                <p>
                  {new Date(job.created_at).toLocaleString()} · {job.completed_matches.length}
                  {job.match_keys.length ? ` of ${job.match_keys.length}` : ''} done
                  {skipped ? ` · ${skipped} skipped` : ''}
                </p>
                {job.error && <p role="alert" className="text-destructive">{job.error}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {isOpen(job) && !job.cancel_requested && (
                  <Button type="button" size="sm" variant="outline" onClick={() => cancel.mutate(job.id)}>
                    <X className="size-3.5" />
                    {job.kind === 'live' ? 'Stop' : 'Cancel'}
                  </Button>
                )}
                {!isOpen(job) && job.kind !== 'live' && unfinished.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={enqueue.isPending}
                    onClick={() =>
                      enqueue.mutate({
                        eventKey,
                        kind: job.kind,
                        matchKeys: unfinished,
                        sourceUrl: job.source_url,
                        streamStarts: job.stream_starts,
                        force: job.force,
                        scout: job.scout,
                      })
                    }
                  >
                    <RotateCcw className="size-3.5" />
                    Retry {unfinished.length}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export default function AutoScoutTab({ eventKey }: { eventKey: string }): JSX.Element {
  const workerQ = useAutoScoutWorker();
  const jobsQ = useAutoScoutJobs(eventKey, { live: true });
  const resultsQ = useAutoScoutResults(eventKey, { live: true });
  const matchesQ = useEventMatches(eventKey);
  const infoQ = useEventInfo(eventKey);
  const syncQ = useWebcastSync(eventKey);
  const enqueue = useEnqueueAutoScout();
  const cancel = useCancelAutoScout(eventKey);

  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showOptions, setShowOptions] = useState(false);
  const [source, setSource] = useState<Source>('stream');
  const [customUrl, setCustomUrl] = useState('');
  const [autoScout, setAutoScout] = useState(true);
  const [force, setForce] = useState(false);

  const worker = workerQ.data;
  const baseTeam = getStoredBaseTeam();
  const jobs = useMemo(() => jobsQ.data ?? [], [jobsQ.data]);
  const results = useMemo<AutoScoutResultRow[]>(() => resultsQ.data ?? [], [resultsQ.data]);
  const matches = useMemo(
    () => (matchesQ.data ?? []).slice().sort((a, b) => compareMatchKeys(a.match_key, b.match_key)),
    [matchesQ.data],
  );
  const board = useMemo(() => matchProgress(matches, jobs, results), [matches, jobs, results]);
  const byKey = useMemo(() => new Map(board.map((item) => [item.matchKey, item])), [board]);
  const fuelByMatch = useMemo(() => new Map(results.map((r) => [r.match_key, allianceFuel(r)])), [results]);
  const choices = useMemo(() => streamChoices(infoQ.data?.webcasts), [infoQ.data?.webcasts]);

  const count = (phases: MatchPhase[]) => board.filter((item) => phases.includes(item.phase)).length;
  const live = jobs.find((j) => j.kind === 'live' && isOpen(j));
  const processing = board.find((item) => item.phase === 'processing');
  const processingJob = processing && jobs.find((j) => isOpen(j) && j.progress.match_key === processing.matchKey);
  const current = processing && processingJob ? { job: processingJob, item: processing } : null;
  const customLink = source === 'custom' ? customUrl.trim() : '';
  const needsLink = source === 'custom' && !customLink;
  const online = workerOnline(worker);
  const notRun = count(['played', 'clipped']);
  const skipped = count(['skipped']);

  const rows = matches.filter((m) => {
    const phases = FILTER_PHASES[filter];
    return !phases || phases.includes(byKey.get(m.match_key)?.phase ?? 'upcoming');
  });

  function run(keys: string[], rerun = force): void {
    // Only a lead's calibration beats the platform's own start time.
    const manual: Record<string, string> = Object.fromEntries(
      Object.values(syncQ.data ?? {})
        .filter((row) => row.source === 'manual')
        .map((row) => [row.video_id, row.stream_start_at]),
    );
    const id = customLink ? youtubeId(customLink) : null;
    enqueue.mutate(
      {
        eventKey,
        kind: source === 'videos' ? 'matches' : 'vod',
        matchKeys: keys,
        sourceUrl: customLink || null,
        streamStarts: customLink ? (id && manual[id] ? { [id]: manual[id] } : {}) : manual,
        force: rerun,
        scout: true,
      },
      { onSuccess: () => setSelected(new Set()) },
    );
  }

  function follow(): void {
    enqueue.mutate({
      eventKey,
      kind: 'live',
      matchKeys: [],
      sourceUrl: customLink || null,
      streamStarts: {},
      force,
      scout: autoScout,
    });
  }

  function toggle(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  }

  const stream =
    source === 'custom'
      ? 'your link'
      : source === 'videos'
        ? 'TBA match videos'
        : choices.length > 0
          ? `${choices.length} event stream${choices.length === 1 ? '' : 's'} found`
          : infoQ.isLoading
            ? 'finding the event stream…'
            : 'no stream on TBA yet';

  return (
    <div data-testid="autoscout-tab" className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <header className="lead-page-heading">
        <div className="min-w-0">
          <h1>Auto-Scout</h1>
          <p data-testid="autoscout-stream">Video scouting for {eventKey} · {stream}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-label="Options"
            aria-expanded={showOptions}
            onClick={() => setShowOptions((v) => !v)}
          >
            <Settings2 className="size-4" />
            <span className="hidden sm:inline">Options</span>
          </Button>
          {!live && (
            <button
              type="button"
              className="lead-primary-action gap-2 disabled:opacity-50"
              disabled={enqueue.isPending || needsLink}
              onClick={follow}
            >
              <Radio className="size-4" />
              Follow live stream
            </button>
          )}
        </div>
      </header>

      <Banner worker={worker} eventKey={eventKey} />
      {enqueue.error && <p role="alert" className="text-sm text-destructive">{enqueue.error.message}</p>}

      {showOptions && (
        <section data-testid="autoscout-options" className="lead-settings-panel">
          <div className="lead-setting-row">
            <div>
              <h3>Footage</h3>
              <p>The event stream is found automatically, the right day for each match.</p>
            </div>
            <SegmentedToggle<Source>
              ariaLabel="Footage source"
              size="default"
              value={source}
              onChange={setSource}
              options={[
                { value: 'stream', label: 'Event stream' },
                { value: 'videos', label: 'TBA videos' },
                { value: 'custom', label: 'Link' },
              ]}
            />
          </div>
          {source === 'custom' && (
            <div className="lead-setting-row">
              <Input
                aria-label="Stream link"
                inputMode="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
              />
            </div>
          )}
          <label className="lead-setting-row cursor-pointer">
            <div>
              <h3>Scout clips automatically</h3>
              <p>When following live, run Auto-Scout on each clip. Off keeps clips to run later.</p>
            </div>
            <input
              type="checkbox"
              className="size-5 accent-[hsl(var(--brand))]"
              checked={autoScout}
              onChange={(e) => setAutoScout(e.target.checked)}
            />
          </label>
          <label className="lead-setting-row cursor-pointer">
            <div>
              <h3>Redo finished matches</h3>
              <p>Process again even when a match already has results.</p>
            </div>
            <input
              type="checkbox"
              className="size-5 accent-[hsl(var(--brand))]"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
          </label>
        </section>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Done" value={count(['done'])} tone="success" sub={`of ${matches.length} matches`} />
        <StatTile label="In progress" value={count(['waiting', 'queued', 'processing'])} tone="brand" />
        <StatTile label="Not run" value={notRun} />
        <StatTile
          label="Computer"
          value={online ? (worker?.busy ? 'Working' : 'Ready') : 'Offline'}
          tone={online ? 'success' : 'warning'}
          sub={online && worker?.free_gb != null ? `${Math.round(worker.free_gb)} GB free` : undefined}
        />
      </div>

      <Now
        live={live}
        current={current}
        match={matches.find((m) => m.match_key === current?.item.matchKey)}
        baseTeam={baseTeam}
        onStop={(id) => cancel.mutate(id)}
      />

      <section className="lead-settings-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0 flex-1 basis-96">
            <SegmentedToggle<Filter>
              ariaLabel="Filter matches"
              size="default"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'todo', label: `Not run ${notRun || ''}`.trim() },
                { value: 'active', label: 'In progress' },
                { value: 'done', label: 'Done' },
                { value: 'skipped', label: `Skipped ${skipped || ''}`.trim() },
              ]}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              setSelected(new Set(board.filter((i) => i.phase === 'played' || i.phase === 'clipped').map((i) => i.matchKey)))
            }
          >
            Select all not run
          </Button>
        </div>
        <div className="autoscout-row autoscout-head border-t border-border text-xs text-muted-foreground" aria-hidden="true">
          <span />
          <span>Match</span>
          <span className="autoscout-alliances">Alliances</span>
          <span>Status</span>
          <span className="autoscout-fuel">Fuel</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="border-t border-border p-6 text-center text-sm text-muted-foreground">
            {matches.length === 0 ? 'No schedule for this event yet.' : 'No matches in this filter.'}
          </p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto border-t border-border">
            {rows.map((m) => (
              <Row
                key={m.match_key}
                match={m}
                item={byKey.get(m.match_key) ?? { matchKey: m.match_key, phase: 'upcoming' }}
                fuel={fuelByMatch.get(m.match_key) ?? null}
                baseTeam={baseTeam}
                selected={selected.has(m.match_key)}
                onToggle={() => toggle(m.match_key)}
                onRun={() => run([m.match_key], force || byKey.get(m.match_key)?.phase === 'done')}
                disabled={enqueue.isPending || needsLink}
              />
            ))}
          </ul>
        )}
      </section>

      {selected.size > 0 && (
        <div
          data-testid="autoscout-selection"
          className="sticky bottom-20 z-10 flex items-center justify-between gap-3 rounded-xl border border-brand/50 bg-card px-4 py-3 shadow-lg md:bottom-4"
        >
          <span className="text-sm font-medium">{selected.size} selected</span>
          <span className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <button
              type="button"
              className="lead-primary-action gap-2 disabled:opacity-50"
              disabled={enqueue.isPending || needsLink}
              onClick={() => run([...selected])}
            >
              Run Auto-Scout
              <ChevronRight className="size-4" />
            </button>
          </span>
        </div>
      )}

      <Activity jobs={jobs} eventKey={eventKey} />
    </div>
  );
}
