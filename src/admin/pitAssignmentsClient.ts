import { supabase } from '@/lib/supabase';
import type {
  AssignScout,
  AssignTeam,
  AssignmentBatchState,
  AssignmentPublishResult,
  PitAssignment,
  PitAssignmentSnapshot,
} from './types';

interface PitAssignmentRow {
  team_number: number;
  scout_id: string;
  source: 'manual' | 'auto';
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
    throw new Error('Pit assignment state response did not match the server contract.');
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
    throw new Error('Pit assignment publish response did not match the server contract.');
  }
  return result as AssignmentPublishResult;
}

export async function getPitAssignmentBatchState(
  eventKey: string,
): Promise<AssignmentBatchState> {
  const { data, error } = await supabase.rpc('get_assignment_batch_state', {
    p_event_key: eventKey,
    p_assignment_kind: 'pit',
  });
  if (error) throw new Error(error.message);
  return parseBatchState(data);
}

export async function loadPitAssignmentSnapshot(
  eventKey: string,
): Promise<PitAssignmentSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await getPitAssignmentBatchState(eventKey);
    const { data, error } = await supabase
      .from('pit_assignment')
      .select('team_number,scout_id,source')
      .eq('event_key', eventKey);
    if (error) throw new Error(error.message);
    const after = await getPitAssignmentBatchState(eventKey);
    const rows = (data as PitAssignmentRow[] | null) ?? [];
    if (
      before.revision === after.revision &&
      before.count === after.count &&
      rows.length === after.count
    ) {
      return {
        state: after,
        assignments: rows.map((row) => ({
          teamNumber: row.team_number,
          scoutId: row.scout_id,
          source: row.source,
        })),
      };
    }
  }
  throw new Error('Pit assignments kept changing while loading. Try again.');
}

export function autoAssignPits(
  teams: AssignTeam[],
  scouts: AssignScout[],
  crewSize = 1,
): PitAssignment[] {
  const orderedTeams = [...teams].sort((a, b) => a.teamNumber - b.teamNumber);
  const orderedScouts = [...scouts].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
  if (orderedScouts.length === 0) return [];
  const membersPerTeam = Math.min(
    orderedScouts.length,
    Math.max(1, Math.floor(crewSize)),
  );
  return orderedTeams.flatMap((team, teamIndex) =>
    Array.from({ length: membersPerTeam }, (_, memberIndex) => ({
      teamNumber: team.teamNumber,
      scoutId:
        orderedScouts[
          (teamIndex * membersPerTeam + memberIndex) % orderedScouts.length
        ].id,
      source: 'auto' as const,
    })),
  );
}

export async function publishPitAssignments(
  eventKey: string,
  assignments: PitAssignment[],
  baseRevision: number,
): Promise<AssignmentPublishResult> {
  const { data, error } = await supabase.rpc('set_pit_assignments', {
    p_event_key: eventKey,
    p_assignments: assignments.map((assignment) => ({
      team_number: assignment.teamNumber,
      scout_id: assignment.scoutId,
      source: assignment.source,
    })),
    p_base_revision: baseRevision,
  });
  if (error) throw new Error(error.message);
  const result = parsePublishResult(data);
  if (result.status === 'conflict') return result;
  if (result.count !== assignments.length) {
    throw new Error(
      `Pit assignment publish verification failed: expected ${assignments.length}, server wrote ${result.count}.`,
    );
  }
  // The atomic RPC result is authoritative at return time. The board performs a
  // best-effort row refresh separately so a failed read-back cannot relabel an
  // already-applied/idempotent publish as failed.
  return result;
}
