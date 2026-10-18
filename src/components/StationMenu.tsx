// src/components/StationMenu.tsx — the header "who/where am I" control. Tapping it
// opens a bottom sheet to jump between stations (Scout / Analysis / Lead
// dashboard) plus any station-specific account actions passed as children.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Check, ClipboardList, ChartNoAxesColumn, LayoutDashboard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';

export type Station = 'scout' | 'analysis' | 'lead';

const LAST_STATION_KEY = 'last-station';

export const STATIONS: { id: Station; label: string; blurb: string; href: string; icon: LucideIcon }[] = [
  { id: 'scout', label: 'Scout', blurb: 'Capture matches and pits', href: '/scout', icon: ClipboardList },
  { id: 'analysis', label: 'Analysis', blurb: 'Teams, matches, rankings', href: '/analysis', icon: ChartNoAxesColumn },
  { id: 'lead', label: 'Lead dashboard', blurb: 'Strategy, picklist, settings', href: '/dashboard', icon: LayoutDashboard },
];

export function readLastStation(): Station | null {
  try {
    const v = localStorage.getItem(LAST_STATION_KEY);
    return v === 'scout' || v === 'analysis' || v === 'lead' ? v : null;
  } catch {
    return null;
  }
}

export function StationMenu({
  current,
  title,
  subtitle,
  avatar,
  children,
}: {
  current: Station;
  title: string;
  subtitle?: string;
  avatar: React.ReactNode;
  /** Account actions shown under the station list (change scouter, lock, ...). */
  children?: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_STATION_KEY, current);
    } catch {
      /* storage unavailable: the launcher just won't suggest "continue" */
    }
  }, [current]);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-haspopup="dialog"
        data-testid="station-menu-trigger"
        onClick={() => setOpen(true)}
        className="flex min-h-11 min-w-0 items-center gap-2.5 text-left"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[13px] font-medium text-brand [&_svg]:size-[18px]">
          {avatar}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1 text-[15px] font-medium leading-tight">
            <span className="truncate">{title}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </span>
          {subtitle ? (
            <span className="block truncate font-mono text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        side="bottom"
        title="Switch station"
        data-testid="station-sheet"
      >
        <ul>
          {STATIONS.map((s) => {
            const Icon = s.icon;
            const here = s.id === current;
            return (
              <li key={s.id} className="border-t border-border first:border-t-0">
                <Link
                  to={s.href}
                  data-testid={`station-${s.id}`}
                  onClick={() => setOpen(false)}
                  className="flex min-h-[56px] items-center gap-3 py-2"
                >
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-[18px]',
                      here ? 'bg-brand/15 text-brand' : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    <Icon aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{s.blurb}</span>
                  </span>
                  {here ? (
                    <Check className="size-4 text-brand" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        {children ? (
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">{children}</div>
        ) : null}
      </Sheet>
    </>
  );
}

export default StationMenu;
