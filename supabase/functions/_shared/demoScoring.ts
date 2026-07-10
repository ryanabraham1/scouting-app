export const DEMO_SHIFT_BOUNDS = {
  transition: { start: 0, end: 10000 },
  shift1: { start: 10000, end: 35000 },
  shift2: { start: 35000, end: 60000 },
  shift3: { start: 60000, end: 85000 },
  shift4: { start: 85000, end: 110000 },
  endgame: { start: 110000, end: 140000 },
} as const;

export interface DemoFuelBurst {
  rate: number;
  startMs: number;
  endMs: number;
  window: "auto" | "shift1" | "shift2" | "shift3" | "shift4" | "endgame";
}

export function demoFuelFromAttribution(
  attributedPoints: number,
  teleopClimbPoints: number,
  autoClimbLevel1: boolean,
  noShow: boolean,
): number {
  if (noShow) return 0;
  return Math.max(
    0,
    attributedPoints - teleopClimbPoints - (autoClimbLevel1 ? 15 : 0),
  );
}

function splitInt(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  return Array.from(
    { length: count },
    (_, index) => base + (index < total % count ? 1 : 0),
  );
}

export function canonicalDemoFuelBursts(
  autoFuel: number,
  teleopActive: number,
  teleopInactive: number,
  endgameFuel: number,
  inactiveFirst: boolean,
): DemoFuelBurst[] {
  const shiftWindows = ["shift1", "shift2", "shift3", "shift4"] as const;
  const active = shiftWindows.filter(
    (_, index) => (((index + 1) % 2) === 1) !== inactiveFirst,
  );
  const inactive = shiftWindows.filter(
    (_, index) => (((index + 1) % 2) === 1) === inactiveFirst,
  );
  const amounts = new Map<string, number>();
  const activeAmounts = splitInt(teleopActive, active.length);
  const inactiveAmounts = splitInt(teleopInactive, inactive.length);
  active.forEach((window, index) => amounts.set(window, activeAmounts[index]));
  inactive.forEach((window, index) => amounts.set(window, inactiveAmounts[index]));

  const bursts: DemoFuelBurst[] = [];
  const add = (
    window: "auto" | "endgame" | (typeof shiftWindows)[number],
    amount: number,
    startMs: number,
  ) => {
    if (amount <= 0) return;
    // Keep generated rates inside the same 0..30 BPS validity envelope as live
    // capture while integrating to the requested integer amount.
    const durationMs = Math.ceil(amount / 30) * 1000;
    bursts.push({
      rate: (amount * 1000) / durationMs,
      startMs,
      endMs: startMs + durationMs,
      window,
    });
  };
  add("auto", autoFuel, 3000);
  for (const window of shiftWindows) {
    add(window, amounts.get(window) ?? 0, DEMO_SHIFT_BOUNDS[window].start + 1000);
  }
  add("endgame", endgameFuel, DEMO_SHIFT_BOUNDS.endgame.start + 1000);
  return bursts;
}
