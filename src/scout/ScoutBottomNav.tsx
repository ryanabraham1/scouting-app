// src/scout/ScoutBottomNav.tsx — the scout app's persistent bottom tab bar.
// Plain client-side links so it works offline (no document reload).
import { Link } from 'react-router-dom';
import { Home, CalendarDays, ChartNoAxesColumn, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ScoutTab = 'home' | 'matches' | 'analysis' | 'my-data';

const TABS: { id: ScoutTab; label: string; href: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Home', href: '/scout', icon: Home },
  { id: 'matches', label: 'Matches', href: '/scout?tab=matches', icon: CalendarDays },
  { id: 'analysis', label: 'Analysis', href: '/analysis', icon: ChartNoAxesColumn },
  { id: 'my-data', label: 'My data', href: '/my-data', icon: UserRound },
];

export function ScoutBottomNav({ active }: { active: ScoutTab }): JSX.Element {
  return (
    <nav
      aria-label="Scout tabs"
      data-testid="scout-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto grid max-w-2xl grid-cols-4">
        {TABS.map(({ id, label, href, icon: Icon }) => (
          <li key={id}>
            <Link
              to={href}
              data-testid={`scout-tab-${id}`}
              aria-current={active === id ? 'page' : undefined}
              className={cn(
                'flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] transition-colors',
                active === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-[22px]" aria-hidden="true" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default ScoutBottomNav;
