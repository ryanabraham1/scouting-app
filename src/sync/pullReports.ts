import { supabase } from '@/lib/supabase';
import { db } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';
import { SCHEMA_VERSION } from '@/scoring';
import { sanitizeMatchReport } from '@/sync/sanitizeReport';

/**
 * The PULL half of match-report sync. The outbox only pushes this device's
 * captures up; without this, a scouter who switches devices (or whose report
 * was uploaded over QR by a teammate) sees nothing they already scouted — the
 * Done tab is empty, played matches land in "Missed", and My Data is blank.
 *
 * Pulls every report the server holds for one scout row (select_scouter keeps
 * a single canonical row per name per event, so scout_id is the scouter's
 * identity across devices) into the local Dexie store as `synced` rows.
 *
 * Two-step to stay cheap on venue wifi when polled: a tiny id/revision/deleted
 * manifest first, then full rows only for ids this device is missing or holds
 * an older synced revision of.
 */

/** Raw columns the RPC accepts — the inverse of `toUpsertPayload`. */
const FULL_REPORT_COLUMNS = [
  'id',
  'schema_version',
  'app_version',
  'device_id',
  'created_at',
  'event_key',
  'match_key',
  'scout_id',
  'target_team_number',
  'alliance_color',
  'station',
  'inactive_first',
  'inactive_first_source',
  'teleop_clock_unconfirmed',
  'fuel_bursts',
  'feeding_bursts',
  'auto_start_position',
  'auto_path',
  'auto_left_starting_line',
  'intake_sources',
  'max_fuel_capacity_observed',
  'defense_rating',
  'driver_skill',
  'agility',
  'defense_duration_ms',
  'defended_duration_ms',
  'defense_intervals',
  'defended_intervals',
  'pins',
  'fouls_minor',
  'fouls_major',
  'foul_reasons',
  'no_show',
  'died',
  'tipped',
  'dropped_fuel',
  'fed_corral',
  'notes',
  'row_revision',
  'deleted',
].join(',');

interface ManifestRow {
  id: string;
  row_revision: number | null;
  deleted: boolean | null;
}

export type ServerReportRow = Record<string, unknown> & {
  id: string;
  row_revision: number | null;
  deleted: boolean | null;
};

/** Pure: server snake_case row → local outbox row, marked already `synced`. */
export function serverRowToLocal(row: ServerReportRow, scoutName: string): LocalMatchReport {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const station = num(row.station);
  const local = {
    id: row.id,
    // Server ratings were rewritten to the 10-point scale by migration 0045, so
    // stamp the current version: a v1 stamp would re-scale them on local read.
    schemaVersion: SCHEMA_VERSION,
    appVersion: typeof row.app_version === 'string' ? row.app_version : '',
    deviceId: typeof row.device_id === 'string' ? row.device_id : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    eventKey: String(row.event_key ?? ''),
    matchKey: String(row.match_key ?? ''),
    scoutId: String(row.scout_id ?? ''),
    scoutName,
    targetTeamNumber: num(row.target_team_number),
    allianceColor: row.alliance_color === 'blue' ? 'blue' : 'red',
    station: (station === 2 || station === 3 ? station : 1) as 1 | 2 | 3,
    inactiveFirst: row.inactive_first as boolean | null,
    inactiveFirstSource: row.inactive_first_source as LocalMatchReport['inactiveFirstSource'],
    teleopClockUnconfirmed: row.teleop_clock_unconfirmed === true,
    fuelBursts: row.fuel_bursts as LocalMatchReport['fuelBursts'],
    feedingBursts: row.feeding_bursts as LocalMatchReport['feedingBursts'],
    autoStartPosition: row.auto_start_position as LocalMatchReport['autoStartPosition'],
    autoPath: row.auto_path as LocalMatchReport['autoPath'],
    autoLeftStartingLine: row.auto_left_starting_line === true,
    intakeSources: row.intake_sources as string[],
    maxFuelCapacityObserved: num(row.max_fuel_capacity_observed),
    defenseRating: num(row.defense_rating) as LocalMatchReport['defenseRating'],
    driverSkill: num(row.driver_skill) as LocalMatchReport['defenseRating'],
    agility: num(row.agility) as LocalMatchReport['defenseRating'],
    defenseDurationMs: num(row.defense_duration_ms),
    defendedDurationMs: num(row.defended_duration_ms),
    defenseIntervals: row.defense_intervals as LocalMatchReport['defenseIntervals'],
    defendedIntervals: row.defended_intervals as LocalMatchReport['defendedIntervals'],
    pins: num(row.pins),
    foulsMinor: num(row.fouls_minor),
    foulsMajor: num(row.fouls_major),
    foulReasons: row.foul_reasons as string[],
    noShow: row.no_show === true,
    died: row.died === true,
    tipped: row.tipped === true,
    droppedFuel: row.dropped_fuel === true,
    fedCorral: row.fed_corral === true,
    notes: typeof row.notes === 'string' ? row.notes : '',
    syncState: 'synced',
    rowRevision: Math.max(1, num(row.row_revision)),
    syncAttempts: 0,
    lastSyncError: null,
    nextSyncAt: null,
  } as LocalMatchReport;
  // Same normalizer the outbox applies: coerces jsonb/array shapes and
  // recomputes the display aggregates from the raw bursts.
  return { ...sanitizeMatchReport(local), syncState: 'synced' };
}

/**
 * What to do with one manifest entry given this device's copy. Local rows that
 * are not `synced` (dirty / pending / dead-lettered) are this device's
 * unsent work and are never touched.
 */
export function planPull(
  server: ManifestRow,
  local: Pick<LocalMatchReport, 'syncState' | 'rowRevision'> | undefined,
): 'fetch' | 'delete' | 'skip' {
  const serverRev = server.row_revision ?? 1;
  if (server.deleted) {
    // Deleted or superseded server-side (a supersede bumps the old row's
    // revision): drop the stale synced copy so it stops counting as Done.
    return local && local.syncState === 'synced' && (local.rowRevision ?? 1) <= serverRev
      ? 'delete'
      : 'skip';
  }
  if (!local) return 'fetch';
  return local.syncState === 'synced' && serverRev > (local.rowRevision ?? 1) ? 'fetch' : 'skip';
}

/** Coalesce concurrent pulls for the same scout (poll + focus + realtime). */
const inFlight = new Map<string, Promise<number>>();

/**
 * Pull one scout's server reports into the local store. Returns how many local
 * rows changed. Throws on network/RLS failure so callers can stay offline-quiet.
 */
export function pullScoutReports(
  eventKey: string,
  scoutId: string,
  scoutName: string,
): Promise<number> {
  if (!eventKey || !scoutId) return Promise.resolve(0);
  const key = `${eventKey}:${scoutId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = doPull(eventKey, scoutId, scoutName).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function doPull(eventKey: string, scoutId: string, scoutName: string): Promise<number> {
  const manifestRes = await supabase
    .from('match_scouting_report')
    .select('id,row_revision,deleted')
    .eq('event_key', eventKey)
    .eq('scout_id', scoutId);
  if (manifestRes.error) throw new Error(manifestRes.error.message);
  const manifest = (manifestRes.data ?? []) as ManifestRow[];
  if (manifest.length === 0) return 0;

  const locals = await db.reports.bulkGet(manifest.map((m) => m.id));
  const toFetch: string[] = [];
  let hasDeletes = false;
  manifest.forEach((m, i) => {
    const plan = planPull(m, locals[i]);
    if (plan === 'fetch') toFetch.push(m.id);
    else if (plan === 'delete') hasDeletes = true;
  });
  if (toFetch.length === 0 && !hasDeletes) return 0;

  let fullRows: ServerReportRow[] = [];
  if (toFetch.length > 0) {
    const fullRes = await supabase
      .from('match_scouting_report')
      .select(FULL_REPORT_COLUMNS)
      .in('id', toFetch);
    if (fullRes.error) throw new Error(fullRes.error.message);
    fullRows = (fullRes.data ?? []) as unknown as ServerReportRow[];
  }
  const manifestById = new Map(manifest.map((m) => [m.id, m]));

  // Re-check against the CURRENT local row inside one transaction: an outbox
  // transition or a local edit may have landed while the network reads ran.
  return db.transaction('rw', db.reports, async () => {
    let changed = 0;
    for (const m of manifest) {
      if (!m.deleted) continue;
      if (planPull(m, await db.reports.get(m.id)) === 'delete') {
        await db.reports.delete(m.id);
        changed++;
      }
    }
    for (const row of fullRows) {
      const m = manifestById.get(row.id);
      if (!m || row.deleted) continue;
      if (planPull(row, await db.reports.get(row.id)) !== 'fetch') continue;
      await db.reports.put(serverRowToLocal(row, scoutName));
      changed++;
    }
    return changed;
  });
}
