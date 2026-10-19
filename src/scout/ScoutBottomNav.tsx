// src/scout/ScoutBottomNav.tsx — the scout app's navigation. Phones get the
// persistent bottom tab bar; from `md` up the same destinations render as a
// top tab row (ScoutTopNav) and the bottom bar steps aside. Plain client-side
// navigation so it works offline (no document reload).
import { useNavigate } from 'react-router-dom';
import { Home, CalendarDays, ChartNoAxesColumn, UserRound, Wrench, RefreshCw } from 'lucide-react';
import { BottomTabBar, type BottomTab } from '@/components/BottomTabBar';
import { IconTabs } from '@/components/ui/IconTabs';

export type ScoutTab = 'home' | 'matches' | 'analysis' | 'my-data';
export type ScoutDesktopTab = 'home' | 'matches' | 'pit' | 'my-data' | 'sync';

const TABS: readonly BottomTab<ScoutTab>[] = [
  { id: 'home', label: 'Home', href: '/scout', icon: Home },
  { id: 'matches', label: 'Matches', href: '/scout?tab=matches', icon: CalendarDays },
  { id: 'analysis', label: 'Analysis', href: '/analysis', icon: ChartNoAxesColumn },
  { id: 'my-data', label: 'My data', href: '/my-data', icon: UserRound },
];

// Desktop has the station switch for Analysis, so its row trades that slot for
// Pit scouting and Sync, which phones reach from the home screen.
const DESKTOP_TABS: readonly { id: ScoutDesktopTab; label: string; href: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Home', href: '/scout', icon: Home },
  { id: 'matches', label: 'Matches', href: '/scout?tab=matches', icon: CalendarDays },
  { id: 'pit', label: 'Pit scouting', href: '/scout?mode=pit', icon: Wrench },
  { id: 'my-data', label: 'My data', href: '/my-data', icon: UserRound },
  { id: 'sync', label: 'Sync & transfer', href: '/sync', icon: RefreshCw },
];

export function ScoutBottomNav({ active }: { active: ScoutTab }): JSX.Element {
  return (
    <BottomTabBar
      tabs={TABS}
      active={active}
      ariaLabel="Scout tabs"
      testId="scout-bottom-nav"
      tabTestIdPrefix="scout-tab"
      desktop="hidden"
    />
  );
}

/** Desktop-only (`md` and up) scout tab row; hidden on phones. */
export function ScoutTopNav({
  active,
  className,
}: {
  active: ScoutDesktopTab | null;
  className?: string;
}): JSX.Element {
  const navigate = useNavigate();
  return (
    <IconTabs<ScoutDesktopTab | 'none'>
      ariaLabel="Scout sections"
      value={active ?? 'none'}
      onChange={(id) => {
        const tab = DESKTOP_TABS.find((t) => t.id === id);
        if (tab) navigate(tab.href);
      }}
      tabs={DESKTOP_TABS.map(({ id, label, icon: Icon }) => ({ value: id, label, icon: <Icon /> }))}
      className={['hidden md:grid', className].filter(Boolean).join(' ')}
    />
  );
}

export default ScoutBottomNav;
