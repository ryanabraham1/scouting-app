// src/sync/matchupNotesSync.ts
//
// The matchup-note sibling of pitOutbox.ts. Drains the local matchup-note outbox
// through the revision-guarded `upsert_matchup_note` RPC (migration 0033). The RPC
// writes only when strictly newer (row_revision = local updatedAt epoch-ms), so a
// stale resync can never clobber a newer note and a re-send is idempotent.
import { supabase } from '@/lib/supabase';
import {
  getMatchupSyncQueue,
  markMatchupPending,
  markMatchupSynced,
  markMatchupDirtyRetry,
  markMatchupSyncError,
} from '@/db/localStore';
import type { LocalMatchupNote } from '@/db/types';
import { classifySyncError } from '@/sync/classifyError';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';

export interface MatchupSyncSummary {
  attempted: number;
  synced: number;
  retried: number;
  deadLettered: number;
}

function errorMessage(err: unknown): string {
  if (err == null) return 'unknown sync error';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.code === 'string') return e.code;
    if (typeof e.code === 'number') return String(e.code);
  }
  return 'unknown sync error';
}

/** Build the snake_case wire shape the `upsert_matchup_note` RPC expects. */
function notePayload(rec: LocalMatchupNote): Record<string, unknown> {
  // Revision = this note's local updatedAt epoch-ms (monotonic with edit time,
  // comparable across authors) — same scheme as upsert_pit_report.
  const revision = Date.parse(rec.updatedAt) || Date.now();
  return {
    event_key: rec.eventKey,
    our_team: rec.ourTeam,
    opp_team: rec.oppTeam,
    note: rec.note,
    row_revision: revision,
    author_scout_id: rec.authorScoutId,
  };
}

export async function syncMatchupNotesOnce(): Promise<MatchupSyncSummary> {
  const queue = await getMatchupSyncQueue();
  const summary: MatchupSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };

  for (const rec of queue) {
    summary.attempted += 1;
    await markMatchupPending(rec.key);

    let failure: unknown;
    let failed = false;
    try {
      const { error } = await supabase.rpc('upsert_matchup_note', { p: notePayload(rec) });
      if (error != null) {
        failed = true;
        failure = error;
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      await markMatchupSynced(rec.key);
      summary.synced += 1;
      continue;
    }

    const kind = classifySyncError(failure);
    const attempts = rec.syncAttempts ?? 0;
    const message = errorMessage(failure);

    if (kind === 'transient' && attempts < SYNC_MAX_ATTEMPTS) {
      await markMatchupDirtyRetry(rec.key, message);
      summary.retried += 1;
    } else {
      await markMatchupSyncError(rec.key, message);
      summary.deadLettered += 1;
    }
  }

  return summary;
}
