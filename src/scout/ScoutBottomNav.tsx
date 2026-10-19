// src/scout/ScoutBottomNav.tsx — the scout app's persistent bottom tab bar.
// Plain client-side links so it works offline (no document reload).
import { Home, CalendarDays, ChartNoAxesColumn, UserRound } from 'lucide-react';
import { BottomTabBar, type BottomTab } from '@/components/BottomTabBar';

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
