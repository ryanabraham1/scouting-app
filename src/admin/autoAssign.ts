import type { AssignMatch, AssignScout, AssignOptions, Assignment, AllianceColor } from './types';
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
  // Scouting assignments are created ONLY for qualification matches; playoffs
  // are intentionally never assigned. Filter defensively here so even a direct
  // caller (not just AssignmentBoard) can never produce a playoff assignment.
  const matches = rawMatches.filter((m) => isQualMatchKey(m.matchKey));
  const result: Assignment[] = [];

  // Per-scout running state.
  const totalCount = new Map<string, number>(); // total assignments so far
  const consecutive = new Map<string, number>(); // consecutive assignments without a rest
  const restRemaining = new Map<string, number>(); // matches of owed rest still pending (soft)
  const lastStation = new Map<string, number>(); // last station scouted (for rotation bias)
  const lastColor = new Map<string, AllianceColor>(); // last alliance color (for rotation bias)
  for (const s of scouts) {
    totalCount.set(s.id, 0);
    consecutive.set(s.id, 0);
    restRemaining.set(s.id, 0);
  }
  // How long a break lasts once earned (>=1 match). Legacy callers omit it -> 1.
  const breakLength = Math.max(1, opts.breakLength ?? 1);

  const scoutOrder = new Map<string, number>();
  scouts.forEach((s, i) => scoutOrder.set(s.id, i));

  for (const match of matches) {
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

      // Scheduled break is a SOFT preference: prefer scouts who are NOT due for a
      // rest, but NEVER drop a slot just because everyone is due. When the scout
      // pool equals the slot count, the break used to fire for everyone at once,
      // leaving entire matches (every breakEveryN-th) completely unscouted. A
      // scout is "on break" while they still owe rest matches (restRemaining > 0).
      const notOnBreak = baseEligible.filter((s) => (restRemaining.get(s.id) ?? 0) <= 0);
      const eligible = notOnBreak.length > 0 ? notOnBreak : baseEligible;

      // When the pool is larger than slots, also avoid back-to-back same scout.
      // Opt-out via avoidBackToBack:false (default on for legacy callers).
      const slotsThisMatch = slots.length;
      let pool = eligible;
      if ((opts.avoidBackToBack ?? true) && scouts.length > slotsThisMatch) {
        const filtered = eligible.filter((s) => !prevMatchScouts.has(s.id));
        if (filtered.length > 0) pool = filtered;
      }

      if (pool.length === 0) continue; // slot omitted: no eligible scout

      pool.sort((a, b) => {
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
    }

    // Update per-scout counters after the match.
    for (const s of scouts) {
      if (usedThisMatch.has(s.id)) {
        // Worked this match: extend the streak. On hitting the cadence, owe a
        // full breakLength rest and reset the streak.
        const streak = (consecutive.get(s.id) ?? 0) + 1;
        if (opts.breakEveryN > 0 && streak >= opts.breakEveryN) {
          restRemaining.set(s.id, breakLength);
          consecutive.set(s.id, 0);
        } else {
          consecutive.set(s.id, streak);
        }
      } else {
        // Missed the match: pay down any owed rest, and the gap breaks the streak.
        const owed = restRemaining.get(s.id) ?? 0;
        if (owed > 0) restRemaining.set(s.id, owed - 1);
        consecutive.set(s.id, 0);
      }
    }
  }

  return result;
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
