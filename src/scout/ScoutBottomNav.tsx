// src/scout/ScoutBottomNav.tsx — the scout app's persistent bottom tab bar.
// Plain client-side links so it works offline (no document reload).
import { useEffect } from 'react';
import { Home, CalendarDays, ChartNoAxesColumn, UserRound } from 'lucide-react';
import { BottomTabBar, type BottomTab } from '@/components/BottomTabBar';

// Analysis is shared with the lead console, so it only shows the scout tab bar
// when the user came from a scout screen. A session flag (not router state)
// survives Analysis' own in-page navigation and reloads.
const SCOUT_ORIGIN_KEY = 'scout-nav-origin';

export function setScoutOrigin(fromScout: boolean): void {
  try {
    if (fromScout) sessionStorage.setItem(SCOUT_ORIGIN_KEY, '1');
    else sessionStorage.removeItem(SCOUT_ORIGIN_KEY);
  } catch {
    /* storage unavailable: the bar just stays hidden on shared screens */
  }
}

export function isScoutOrigin(): boolean {
  try {
    return sessionStorage.getItem(SCOUT_ORIGIN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Mark the session as scout (true) or lead/station-picker (false) on mount. */
export function useScoutOrigin(fromScout: boolean): void {
  useEffect(() => setScoutOrigin(fromScout), [fromScout]);
}

export type ScoutTab = 'home' | 'matches' | 'analysis' | 'my-data';

const TABS: readonly BottomTab<ScoutTab>[] = [
  { id: 'home', label: 'Home', href: '/scout', icon: Home },
  { id: 'matches', label: 'Matches', href: '/scout?tab=matches', icon: CalendarDays },
  { id: 'analysis', label: 'Analysis', href: '/analysis', icon: ChartNoAxesColumn },
  { id: 'my-data', label: 'My data', href: '/my-data', icon: UserRound },
];

export function ScoutBottomNav({ active }: { active: ScoutTab }): JSX.Element {
  return (
    <BottomTabBar
      tabs={TABS}
      active={active}
      ariaLabel="Scout tabs"
      testId="scout-bottom-nav"
      tabTestIdPrefix="scout-tab"
    />
  );
}

export default ScoutBottomNav;
