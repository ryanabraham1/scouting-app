import type { AssignMatch, AssignScout, AssignOptions, Assignment, AllianceColor } from './types';

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
  return slots.filter((s) => s.targetTeamNumber !== ownTeam);
}

export function autoAssign(
  matches: AssignMatch[],
  scouts: AssignScout[],
  opts: AssignOptions,
): Assignment[] {
  const result: Assignment[] = [];

  // Per-scout running state.
  const totalCount = new Map<string, number>(); // total assignments so far
  const consecutive = new Map<string, number>(); // consecutive assignments without a rest
  const lastStation = new Map<string, number>(); // last station scouted (for rotation bias)
  const lastColor = new Map<string, AllianceColor>(); // last alliance color (for rotation bias)
  for (const s of scouts) {
    totalCount.set(s.id, 0);
    consecutive.set(s.id, 0);
  }

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
      const eligible = scouts.filter((s) => {
        if (usedThisMatch.has(s.id)) return false;
        if (s.unavailableMatchKeys?.includes(match.matchKey)) return false;
        // Scheduled break: if breakEveryN>0 and this scout has hit the cadence, rest this match.
        if (opts.breakEveryN > 0 && (consecutive.get(s.id) ?? 0) >= opts.breakEveryN) return false;
        return true;
      });

      // When the pool is larger than slots, also avoid back-to-back same scout.
      const slotsThisMatch = slots.length;
      let pool = eligible;
      if (scouts.length > slotsThisMatch) {
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

    // Update consecutive counters after the match: anyone who worked +1, anyone who rested -> 0.
    for (const s of scouts) {
      if (usedThisMatch.has(s.id)) {
        consecutive.set(s.id, (consecutive.get(s.id) ?? 0) + 1);
      } else {
        consecutive.set(s.id, 0); // a missed match counts as a rest, breaking the streak
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
