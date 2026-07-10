import { supabase } from '@/lib/supabase';
import type {
  Assignment,
  AssignmentBatchState,
  AssignmentPublishResult,
  MatchAssignmentSnapshot,
} from './types';

interface MatchAssignmentRow {
  match_key: string;
  scout_id: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
}

function parseBatchState(value: unknown): AssignmentBatchState {
  const state = value as Partial<AssignmentBatchState> | null;
  if (
    state?.status !== 'authoritative' ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision ?? -1) < 0 ||
    !Number.isSafeInteger(state.count) ||
    (state.count ?? -1) < 0
  ) {
    throw new Error('Match assignment state response did not match the server contract.');
  }
  return state as AssignmentBatchState;
}

function parsePublishResult(value: unknown): AssignmentPublishResult {
  const result = value as Partial<AssignmentPublishResult> | null;
  if (
    !result ||
    !['applied', 'idempotent', 'conflict'].includes(result.status ?? '') ||
    !Number.isSafeInteger(result.revision) ||
    (result.revision ?? -1) < 0 ||
    !Number.isSafeInteger(result.count) ||
    (result.count ?? -1) < 0
  ) {
    throw new Error('Match assignment publish response did not match the server contract.');
  }
  return result as AssignmentPublishResult;
}

export async function getMatchAssignmentBatchState(
  eventKey: string,
): Promise<AssignmentBatchState> {
  const { data, error } = await supabase.rpc('get_assignment_batch_state', {
    p_event_key: eventKey,
    p_assignment_kind: 'match',
  });
  if (error) throw new Error(error.message);
  return parseBatchState(data);
}

export async function loadMatchAssignmentSnapshot(
  eventKey: string,
): Promise<MatchAssignmentSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await getMatchAssignmentBatchState(eventKey);
    const { data, error } = await supabase
      .from('assignment')
      .select('match_key,scout_id,alliance_color,station,target_team_number')
      .eq('event_key', eventKey);
    if (error) throw new Error(error.message);
    const after = await getMatchAssignmentBatchState(eventKey);
    const rows = (data as MatchAssignmentRow[] | null) ?? [];
    if (
      before.revision === after.revision &&
      before.count === after.count &&
      rows.length === after.count
    ) {
      return {
        state: after,
        assignments: rows.map((row) => ({
          matchKey: row.match_key,
          scoutId: row.scout_id,
          allianceColor: row.alliance_color,
          station: row.station,
          targetTeamNumber: row.target_team_number,
        })),
      };
    }
  }
  throw new Error('Match assignments kept changing while loading. Try again.');
}

export async function publishAssignments(
  eventKey: string,
  assignments: Assignment[],
  baseRevision: number,
): Promise<AssignmentPublishResult> {
  const p_assignments = assignments.map((a) => ({
    match_key: a.matchKey,
    scout_id: a.scoutId,
    alliance_color: a.allianceColor,
    station: a.station,
    target_team_number: a.targetTeamNumber,
  }));

  const { data, error } = await supabase.rpc('set_assignments', {
    p_event_key: eventKey,
    p_assignments,
    p_base_revision: baseRevision,
  });

  if (error) throw new Error(error.message);
  const result = parsePublishResult(data);
  if (result.status === 'conflict') return result;
  if (result.count !== assignments.length) {
    throw new Error(
      `Match assignment publish verification failed: expected ${assignments.length}, server wrote ${result.count}.`,
    );
  }
  // set_assignments performs validation, replacement, revision advance, and this
  // result construction in one transaction. Applied/idempotent is therefore
  // authoritative at return time; a separate state read is only best-effort UI
  // verification and belongs in the board, where its failure cannot relabel an
  // already-confirmed publish as failed.
  return result;
}
