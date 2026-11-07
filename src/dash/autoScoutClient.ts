// src/dash/autoScoutClient.ts — data layer for the lead dashboard's Auto-Scout page. The video
// computer calls in to the autoscout-worker Edge Function; this side only reads those tables and
// writes through the two RPCs, so nothing here ever talks to the computer directly.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export type AutoScoutKind = 'matches' | 'vod' | 'live';
export type AutoScoutStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AutoScoutJob {
  id: string;
  event_key: string;
  kind: AutoScoutKind;
  match_keys: string[];
  source_url: string | null;
  stream_starts: Record<string, string>;
  force: boolean;
  scout: boolean;
  status: AutoScoutStatus;
  cancel_requested: boolean;
  completed_matches: string[];
  match_errors: Record<string, string>;
  progress: {
    match_key?: string;
    stage?: string;
    pct?: number;
    eta_s?: number;
    recorder?: string;
    /** Live jobs: clipped and waiting for the GPU. */
    queued?: string[];
    /** Live jobs with scouting off: clips kept for later. */
    clipped?: string[];
  };
  error: string | null;
  created_at: string;
}

export interface AutoScoutWorker {
  last_seen_at: string;
  calibrated_events: string[];
  free_gb: number | null;
  busy: boolean;
}

export type AutoScoutTeam = { alliance?: string; station?: number } & Record<string, unknown>;

export interface AutoScoutResultRow {
  match_key: string;
  job_id: string | null;
  imported_at: string;
  teams: Record<string, AutoScoutTeam>;
  /** Keyed by seat, e.g. red0: how sure the bumper read was. */
  identity_conf: Record<string, number> | null;
}

export interface EnqueueInput {
  eventKey: string;
  kind: AutoScoutKind;
  matchKeys: string[];
  sourceUrl: string | null;
  streamStarts: Record<string, string>;
  force: boolean;
  scout: boolean;
}

/** The computer syncs every 5–15s, or up to a few minutes while its network is down. */
export const WORKER_ONLINE_MS = 60_000;
const POLL_MS = 5_000;

export function workerOnline(worker: AutoScoutWorker | null | undefined, now = Date.now()): boolean {
  if (!worker) return false;
  return now - Date.parse(worker.last_seen_at) < WORKER_ONLINE_MS;
}

export function isOpen(job: Pick<AutoScoutJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/** What a retry should still do: everything requested that did not finish. */
export function unfinishedMatches(job: Pick<AutoScoutJob, 'match_keys' | 'completed_matches'>): string[] {
  const done = new Set(job.completed_matches);
  return job.match_keys.filter((key) => !done.has(key));
}

export interface StreamChoice {
  url: string;
  label: string;
}

/** Every stream TBA lists for the event, as links the computer accepts. */
export function streamChoices(webcasts: unknown[] | undefined): StreamChoice[] {
  const choices = new Map<string, StreamChoice>();
  for (const raw of webcasts ?? []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { type, channel, file, date } = raw as Record<string, unknown>;
    const day = typeof date === 'string' && date ? ` · ${date}` : '';
    if (type === 'youtube') {
      const id = typeof file === 'string' && file ? file : channel;
      if (typeof id === 'string' && id) {
        const url = `https://www.youtube.com/watch?v=${id}`;
        choices.set(url, { url, label: `YouTube${day}` });
      }
    } else if (type === 'twitch' && typeof channel === 'string' && channel) {
      const url = `https://www.twitch.tv/${channel}`;
      choices.set(url, { url, label: `Twitch ${channel}${day}` });
    }
  }
  return [...choices.values()];
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
    if (!parsed.hostname.endsWith('youtube.com')) return null;
    return parsed.searchParams.get('v') ?? parsed.pathname.match(/^\/live\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Fuel credited to each alliance in one match. */
export function allianceFuel(row: Pick<AutoScoutResultRow, 'teams'>): { red: number; blue: number } {
  const totals = { red: 0, blue: 0 };
  for (const team of Object.values(row.teams ?? {})) {
    const fuel = typeof team.fuel_scored === 'number' ? team.fuel_scored : 0;
    if (team.alliance === 'red') totals.red += fuel;
    else if (team.alliance === 'blue') totals.blue += fuel;
  }
  return totals;
}

export type MatchPhase =
  | 'upcoming'
  | 'played'
  | 'waiting'
  | 'clipped'
  | 'queued'
  | 'processing'
  | 'done'
  | 'skipped';

export interface MatchProgress {
  matchKey: string;
  phase: MatchPhase;
  pct?: number;
  detail?: string;
}

type ProgressMatch = { match_key: string; actual_time?: string | null };

/**
 * Where every match stands across all of the event's jobs. Later phases win: a match reprocessed
 * after finishing shows as processing, and a finished one never falls back to waiting.
 */
export function matchProgress(
  matches: ProgressMatch[],
  jobs: AutoScoutJob[],
  results: Pick<AutoScoutResultRow, 'match_key'>[],
): MatchProgress[] {
  const done = new Set([...results.map((r) => r.match_key), ...jobs.flatMap((j) => j.completed_matches)]);
  const open = jobs.filter(isOpen);
  const following = open.filter((j) => j.kind === 'live');
  return matches.map(({ match_key: key, actual_time: actual }) => {
    const working = open.find((j) => j.progress.match_key === key);
    if (working) {
      return { matchKey: key, phase: 'processing', pct: working.progress.pct, detail: working.progress.stage };
    }
    if (open.some((j) => j.match_keys.includes(key) && !j.completed_matches.includes(key))) {
      return { matchKey: key, phase: 'queued' };
    }
    if (following.some((j) => j.progress.queued?.includes(key))) return { matchKey: key, phase: 'queued' };
    if (done.has(key)) return { matchKey: key, phase: 'done' };
    // Newest job's verdict: an old skip is stale once a later job has run the match.
    const skip = jobs.find((j) => j.match_errors[key]);
    if (skip) return { matchKey: key, phase: 'skipped', detail: skip.match_errors[key] };
    if (jobs.some((j) => j.progress.clipped?.includes(key))) return { matchKey: key, phase: 'clipped' };
    const started = actual ? Date.parse(actual) : NaN;
    if (following.some((j) => started >= Date.parse(j.created_at))) return { matchKey: key, phase: 'waiting' };
    return { matchKey: key, phase: actual ? 'played' : 'upcoming' };
  });
}

export type AutoScoutCommandKind = 'capture_frame' | 'save_calibration' | 'reanalyze' | 'rescore' | 'identify';

export interface AutoScoutCommand {
  id: string;
  kind: AutoScoutCommandKind;
  status: 'queued' | 'running' | 'done' | 'failed';
  result: { error_m?: number; done?: string[]; failed?: string[] };
  error: string | null;
  created_at: string;
}

export interface AutoScoutCalibration {
  frame_jpeg: string | null;
  frame_size: number[] | null;
  frame_at: string | null;
  view: number[] | null;
  points: Record<string, [number, number]> | null;
  error_m: number | null;
  saved_at: string | null;
}

export const commandsKey = (eventKey: string) => ['autoscout', 'commands', eventKey] as const;
export const calibrationKey = (eventKey: string) => ['autoscout', 'calibration', eventKey] as const;

const isCommandOpen = (c: AutoScoutCommand) => c.status === 'queued' || c.status === 'running';

export function useAutoScoutCommands(eventKey: string): UseQueryResult<AutoScoutCommand[]> {
  return useQuery({
    queryKey: commandsKey(eventKey),
    refetchInterval: (query) => (query.state.data?.some(isCommandOpen) ? 2_000 : 15_000),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('autoscout_command')
        .select('id, kind, status, result, error, created_at')
        .eq('event_key', eventKey)
        .order('created_at', { ascending: false })
        .limit(15);
      if (error) throw error;
      return (data ?? []) as AutoScoutCommand[];
    },
  });
}

export function useAutoScoutCalibration(eventKey: string, enabled: boolean): UseQueryResult<AutoScoutCalibration | null> {
  return useQuery({
    queryKey: calibrationKey(eventKey),
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('autoscout_calibration')
        .select('frame_jpeg, frame_size, frame_at, view, points, error_m, saved_at')
        .eq('event_key', eventKey)
        .maybeSingle();
      if (error) throw error;
      return data as AutoScoutCalibration | null;
    },
  });
}

export function useSendAutoScoutCommand(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, payload = {} }: { kind: AutoScoutCommandKind; payload?: Record<string, unknown> }) => {
      const { data, error } = await supabase.rpc('autoscout_send_command', {
        p_event_key: eventKey,
        p_kind: kind,
        p_payload: payload,
      });
      if (error) throw new Error(error.message);
      return data as AutoScoutCommand;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: commandsKey(eventKey) }),
  });
}

export const workerKey = ['autoscout', 'worker'] as const;
export const jobsKey = (eventKey: string) => ['autoscout', 'jobs', eventKey] as const;
export const resultsKey = (eventKey: string) => ['autoscout', 'results', eventKey] as const;

export function useAutoScoutWorker(): UseQueryResult<AutoScoutWorker | null> {
  return useQuery({
    queryKey: workerKey,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('autoscout_worker')
        .select('last_seen_at, calibrated_events, free_gb, busy')
        .maybeSingle();
      if (error) throw error;
      return data as AutoScoutWorker | null;
    },
  });
}

/** `live` always polls; elsewhere it polls only while something is actually running. */
export function useAutoScoutJobs(
  eventKey: string,
  { live = false }: { live?: boolean } = {},
): UseQueryResult<AutoScoutJob[]> {
  return useQuery({
    queryKey: jobsKey(eventKey),
    staleTime: 10_000,
    refetchInterval: (query) => (live || query.state.data?.some(isOpen) ? POLL_MS : false),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('autoscout_job')
        .select('*')
        .eq('event_key', eventKey)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as AutoScoutJob[];
    },
  });
}

/** `live` polls for the lead's job page; team and match pages just read the shared cache. */
export function useAutoScoutResults(
  eventKey: string | null,
  { live = false }: { live?: boolean } = {},
): UseQueryResult<AutoScoutResultRow[]> {
  return useQuery({
    queryKey: resultsKey(eventKey ?? ''),
    enabled: !!eventKey,
    staleTime: 30_000,
    refetchInterval: live ? POLL_MS * 3 : false,
    queryFn: async () => {
      // Only the per-team blocks: the rest of an envelope is large event timelines.
      const { data, error } = await supabase
        .from('autoscout_result')
        .select('match_key, job_id, imported_at, teams:envelope->match->teams, identity_conf:envelope->match->identity_conf')
        .eq('event_key', eventKey as string)
        .order('imported_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AutoScoutResultRow[];
    },
  });
}

export function useEnqueueAutoScout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: EnqueueInput) => {
      const { data, error } = await supabase.rpc('autoscout_enqueue', {
        p_event_key: input.eventKey,
        p_kind: input.kind,
        p_match_keys: input.matchKeys,
        p_source_url: input.sourceUrl,
        p_stream_starts: input.streamStarts,
        p_force: input.force,
        p_scout: input.scout,
      });
      if (error) throw new Error(error.message);
      return data as AutoScoutJob;
    },
    onSuccess: (_job, input) => client.invalidateQueries({ queryKey: jobsKey(input.eventKey) }),
  });
}

export function useCancelAutoScout(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('autoscout_cancel', { p_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: jobsKey(eventKey) }),
  });
}
