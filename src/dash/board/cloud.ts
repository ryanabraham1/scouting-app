// src/dash/board/cloud.ts
// Ryan's Board <-> Supabase reads: the initial pull of a board's records and
// the sync-status signal for the top-bar chip. Writes go through the outbox
// (src/sync/boardSync.ts). Plan: docs/plans/ryans-board/README.md §8.3–8.4.
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { supabase } from '@/lib/supabase';
import { countBoardUnsynced } from '@/db/localStore';
import { useOnline } from '@/sync/useOnline';
import { parseRecord, type BoardRecord } from '@/dash/board/model';

const PAGE = 1000;

/** Every server record for a board (live and tombstones), validated. */
export async function fetchBoardRecords(boardKey: string): Promise<BoardRecord[]> {
  const out: BoardRecord[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('board_record')
      .select('data')
      .eq('board_key', boardKey)
      .order('record_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { data: unknown }[];
    for (const row of rows) {
      const rec = parseRecord(row.data);
      if (rec) out.push(rec);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

export type BoardSyncState = 'synced' | 'saving' | 'offline' | 'error';

/** Live sync state for one board's local rows. */
export function useBoardSyncState(boardKey: string): BoardSyncState {
  const online = useOnline();
  const [counts, setCounts] = useState({ unsynced: 0, errors: 0 });
  useEffect(() => {
    const sub = liveQuery(() => countBoardUnsynced(boardKey)).subscribe({
      next: setCounts,
      error: () => setCounts({ unsynced: 0, errors: 0 }),
    });
    return () => sub.unsubscribe();
  }, [boardKey]);
  if (counts.errors > 0) return 'error';
  if (!online) return 'offline';
  return counts.unsynced > 0 ? 'saving' : 'synced';
}
