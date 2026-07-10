import { supabase } from '@/lib/supabase';
import {
  deleteMatchupNote,
  deleteStrategyCanvas,
  listMatchupDeadLetters,
  listStrategyCanvasDeadLetters,
  requeueMatchupNote,
  requeueStrategyCanvas,
  saveMatchupNoteLocal,
  saveStrategyCanvasLocal,
} from '@/db/localStore';
import type {
  LocalMatchupNote,
  LocalStrategyCanvas,
  MatchupNoteRow,
  StrategyCanvasRow,
} from '@/db/types';
import {
  mergeCanvasDocs,
  parseCanvasDoc,
  type CanvasDoc,
} from '@/dash/strategy/strokes';

export type LocalRecoveryRecord =
  | { kind: 'matchup-note'; key: string; local: LocalMatchupNote }
  | { kind: 'strategy-canvas'; key: string; local: LocalStrategyCanvas };

export type RecoveryResolution = 'server' | 'local' | 'merge';

export type RecoveryVersions =
  | {
      kind: 'matchup-note';
      local: string;
      server: string | null;
      serverRevision: number | null;
    }
  | {
      kind: 'strategy-canvas';
      local: CanvasDoc;
      server: CanvasDoc | null;
      serverRevision: number | null;
    };

function notifyRecoveryChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('scout-sync-changed'));
  }
}

export async function listLocalRecoveryRecords(): Promise<LocalRecoveryRecord[]> {
  const [notes, canvases] = await Promise.all([
    listMatchupDeadLetters(),
    listStrategyCanvasDeadLetters(),
  ]);
  return [
    ...notes.map((local): LocalRecoveryRecord => ({
      kind: 'matchup-note',
      key: local.key,
      local,
    })),
    ...canvases.map((local): LocalRecoveryRecord => ({
      kind: 'strategy-canvas',
      key: local.key,
      local,
    })),
  ];
}

export async function retryLocalRecovery(record: LocalRecoveryRecord): Promise<void> {
  if (record.kind === 'matchup-note') await requeueMatchupNote(record.key);
  else await requeueStrategyCanvas(record.key);
  notifyRecoveryChanged();
}

export async function discardLocalRecovery(record: LocalRecoveryRecord): Promise<void> {
  if (record.kind === 'matchup-note') await deleteMatchupNote(record.key);
  else await deleteStrategyCanvas(record.key);
  notifyRecoveryChanged();
}

export async function loadRecoveryVersions(
  record: LocalRecoveryRecord,
): Promise<RecoveryVersions> {
  if (record.kind === 'matchup-note') {
    const { data, error } = await supabase
      .from('matchup_note')
      .select('event_key,our_team,opp_team,note,row_revision,updated_at,author_scout_id,deleted')
      .eq('event_key', record.local.eventKey)
      .eq('our_team', record.local.ourTeam)
      .eq('opp_team', record.local.oppTeam)
      .eq('deleted', false)
      .maybeSingle();
    if (error) throw error;
    const row = data as MatchupNoteRow | null;
    return {
      kind: 'matchup-note',
      local: record.local.note,
      server: row?.note ?? null,
      serverRevision: row ? Number(row.row_revision) || 0 : null,
    };
  }

  const phase = record.local.phase ?? 'auto';
  const { data, error } = await supabase
    .from('strategy_canvas')
    .select('event_key,match_key,phase,strokes,deleted_ids,robots,row_revision,updated_at')
    .eq('event_key', record.local.eventKey)
    .eq('match_key', record.local.matchKey)
    .eq('phase', phase)
    .maybeSingle();
  if (error) throw error;
  const row = data as StrategyCanvasRow | null;
  return {
    kind: 'strategy-canvas',
    local: {
      strokes: record.local.strokes,
      deletedIds: record.local.deletedIds,
      robots: record.local.robots ?? [],
    },
    server: row ? parseCanvasDoc(row.strokes, row.deleted_ids, row.robots) : null,
    serverRevision: row ? Number(row.row_revision) || 0 : null,
  };
}

function nextRevisionIso(localUpdatedAt: string, serverRevision: number | null): string {
  const localRevision = Date.parse(localUpdatedAt) || 0;
  return new Date(Math.max(Date.now(), localRevision + 1, (serverRevision ?? 0) + 1)).toISOString();
}

export async function resolveLocalRecovery(
  record: LocalRecoveryRecord,
  versions: RecoveryVersions,
  resolution: RecoveryResolution,
): Promise<void> {
  if (resolution === 'server') {
    if (versions.server == null) throw new Error('No server version is available.');
    await discardLocalRecovery(record);
    return;
  }

  if (record.kind === 'matchup-note' && versions.kind === 'matchup-note') {
    let note = versions.local;
    if (resolution === 'merge' && versions.server != null && versions.server !== versions.local) {
      note = `${versions.server.trim()}\n\n--- Recovered local copy ---\n${versions.local.trim()}`.trim();
    }
    await saveMatchupNoteLocal({
      ...record.local,
      note,
      updatedAt: nextRevisionIso(record.local.updatedAt, versions.serverRevision),
      syncState: 'dirty',
      syncAttempts: 0,
      lastSyncError: null,
      nextSyncAt: null,
      recoveryIssue: null,
    });
  } else if (record.kind === 'strategy-canvas' && versions.kind === 'strategy-canvas') {
    const doc =
      resolution === 'merge' && versions.server
        ? mergeCanvasDocs(versions.server, versions.local)
        : versions.local;
    await saveStrategyCanvasLocal({
      ...record.local,
      strokes: doc.strokes,
      deletedIds: doc.deletedIds,
      robots: doc.robots,
      updatedAt: nextRevisionIso(record.local.updatedAt, versions.serverRevision),
      syncState: 'dirty',
      syncAttempts: 0,
      lastSyncError: null,
      nextSyncAt: null,
      recoveryIssue: null,
    });
  } else {
    throw new Error('Recovery data no longer matches the selected item.');
  }
  notifyRecoveryChanged();
}
