import type {
  AssignMatch,
  AssignScout,
  AssignOptions,
  Assignment,
  AllianceColor,
  AutoAssignmentPlan,
} from './types';
import { isQualMatchKey } from '@/lib/formatMatch';

interface Slot {
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export function slotsForMatch(m: AssignMatch, ownTeam: number): Slot[] {
  const slots: Slot[] = [];
  const stations: (1 | 2 | 3)[] = [1, 2, 3];
  for (const station of stations) {
    slots.push({ allianceColor: 'red', station, targetTeamNumber: m.redTeams[station - 1] });
  }
  for (const station of stations) {
    slots.push({ allianceColor: 'blue', station, targetTeamNumber: m.blueTeams[station - 1] });
  }
  // Drop own-team slots and any empty alliance slots (null/NaN team numbers can
  // appear for events with incomplete schedules — they have no team to scout).
  return slots.filter(
    (s) =>
      s.targetTeamNumber !== ownTeam &&
      s.targetTeamNumber != null &&
      Number.isFinite(s.targetTeamNumber),
  );
}

export function autoAssign(
  rawMatches: AssignMatch[],
  scouts: AssignScout[],
  opts: AssignOptions,
): Assignment[] {
  return autoAssignPlan(rawMatches, scouts, opts).assignments;
}

export function autoAssignPlan(
  rawMatches: AssignMatch[],
  scouts: AssignScout[],
  opts: AssignOptions,
): AutoAssignmentPlan {
  // Scouting assignments are created ONLY for qualification matches; playoffs
  // are intentionally never assigned. Filter defensively here so even a direct
  // caller (not just AssignmentBoard) can never produce a playoff assignment.
  const matches = rawMatches.filter((m) => isQualMatchKey(m.matchKey));
  const result: Assignment[] = [];
  const relaxedMatchKeys = new Set<string>();
  const blocked = opts.scheduleMode === 'blocked';
  const blockAssignments = Math.max(1, opts.blockAssignments ?? 2);
  const spacingMatches = Math.max(0, opts.spacingMatches ?? 0);
  const breakLength = Math.max(0, opts.breakLength ?? 1);

  // Per-scout running state.
  const totalCount = new Map<string, number>(); // total assignments so far
  const blockProgress = new Map<string, number>(); // assignments completed in this work block
  const nextPreferredMatch = new Map<string, number>(); // first match index after spacing/rest
  const lastStation = new Map<string, number>(); // last station scouted (for rotation bias)
  const lastColor = new Map<string, AllianceColor>(); // last alliance color (for rotation bias)
  for (const s of scouts) {
    totalCount.set(s.id, 0);
    blockProgress.set(s.id, 0);
    nextPreferredMatch.set(s.id, 0);
  }

  const scoutOrder = new Map<string, number>();
  scouts.forEach((s, i) => scoutOrder.set(s.id, i));

  for (const [matchIndex, match] of matches.entries()) {
    const slots = slotsForMatch(match, opts.ownTeam);
    const usedThisMatch = new Set<string>();

    // Scouts who scouted the immediately previous match (to skip when pool > slots).
    const prevKey = prevMatchKey(matches, match);
    const prevMatchScouts = new Set<string>();
    if (prevKey !== null) {
      for (const a of result) {
        if (a.matchKey === prevKey) {
          prevMatchScouts.add(a.scoutId);
        }
      }
    }

    for (const slot of slots) {
      // Hard eligibility: not already on this match, and available this match.
      const baseEligible = scouts.filter((s) => {
        if (usedThisMatch.has(s.id)) return false;
        if (s.unavailableMatchKeys?.includes(match.matchKey)) return false;
        return true;
      });

      // Block spacing and breaks are SOFT preferences. If nobody eligible can
      // honor them, fill the seat anyway and record that the plan was relaxed.
      const onSchedule = blocked
        ? baseEligible.filter((s) => matchIndex >= (nextPreferredMatch.get(s.id) ?? 0))
        : baseEligible;
      const eligible = onSchedule.length > 0 ? onSchedule : baseEligible;
      if (blocked && onSchedule.length === 0 && baseEligible.length > 0) {
        relaxedMatchKeys.add(match.matchKey);
      }

      // When the pool is larger than slots, also avoid back-to-back same scout.
      // Opt-out via avoidBackToBack:false (default on for legacy callers).
      const slotsThisMatch = slots.length;
      let pool = eligible;
      if (!blocked && (opts.avoidBackToBack ?? true) && scouts.length > slotsThisMatch) {
        const filtered = eligible.filter((s) => !prevMatchScouts.has(s.id));
        if (filtered.length > 0) pool = filtered;
      }

      if (pool.length === 0) continue; // slot omitted: no eligible scout

      pool.sort((a, b) => {
        if (blocked) {
          // Finish an already-started work block before opening a new one. This
          // forms recognizable shifts while spacing can still produce every-
          // other, every-third, or wider patterns inside each block.
          const activeA = (blockProgress.get(a.id) ?? 0) > 0 ? 0 : 1;
          const activeB = (blockProgress.get(b.id) ?? 0) > 0 ? 0 : 1;
          if (activeA !== activeB) return activeA - activeB;
        }
        const ca = totalCount.get(a.id) ?? 0;
        const cb = totalCount.get(b.id) ?? 0;
        if (ca !== cb) return ca - cb; // fewest assignments first
        if (opts.rotatePositions) {
          const ra = rotationPenalty(a.id, slot, lastStation, lastColor);
          const rb = rotationPenalty(b.id, slot, lastStation, lastColor);
          if (ra !== rb) return ra - rb; // prefer scout who varies station/color
        }
        return (scoutOrder.get(a.id) ?? 0) - (scoutOrder.get(b.id) ?? 0); // stable tie-break
      });

      const chosen = pool[0];
      result.push({
        matchKey: match.matchKey,
        scoutId: chosen.id,
        allianceColor: slot.allianceColor,
        station: slot.station,
        targetTeamNumber: slot.targetTeamNumber,
      });
      usedThisMatch.add(chosen.id);
      totalCount.set(chosen.id, (totalCount.get(chosen.id) ?? 0) + 1);
      lastStation.set(chosen.id, slot.station);
      lastColor.set(chosen.id, slot.allianceColor);
      if (blocked) {
        const progress = (blockProgress.get(chosen.id) ?? 0) + 1;
        if (progress >= blockAssignments) {
          blockProgress.set(chosen.id, 0);
          nextPreferredMatch.set(chosen.id, matchIndex + breakLength + 1);
        } else {
          blockProgress.set(chosen.id, progress);
          nextPreferredMatch.set(chosen.id, matchIndex + spacingMatches + 1);
        }
      }
    }
  }

  return { assignments: result, relaxedMatchKeys: [...relaxedMatchKeys] };
}

function prevMatchKey(matches: AssignMatch[], current: AssignMatch): string | null {
  const idx = matches.indexOf(current);
  return idx > 0 ? matches[idx - 1].matchKey : null;
}

function rotationPenalty(
  scoutId: string,
  slot: Slot,
  lastStation: Map<string, number>,
  lastColor: Map<string, AllianceColor>,
): number {
  let penalty = 0;
  if (lastStation.get(scoutId) === slot.station) penalty += 1;
  if (lastColor.get(scoutId) === slot.allianceColor) penalty += 1;
  return penalty;
}
