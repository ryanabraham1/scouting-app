// src/components/BottomTabBar.tsx — the app-wide bottom tab bar. Each station
// (scout, analysis, lead) passes its own tabs; tabs are either router links
// (work offline, no reload) or in-page selections.
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BottomTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  /** Navigate here (client-side). Omit to handle the tap with `onSelect`. */
  href?: string;
  disabled?: boolean;
}

export interface BottomTabBarProps<T extends string> {
  tabs: readonly BottomTab<T>[];
  active: T;
  onSelect?: (id: T) => void;
  ariaLabel: string;
  testId: string;
  /** Prefix for each tab's data-testid (`${prefix}-${id}`). */
  tabTestIdPrefix: string;
}

const ITEM =
  'flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 text-[11px] transition-colors';

/** Bottom padding screens need so content clears the fixed bar. */
export const BOTTOM_BAR_CLEARANCE = 'pb-24';

export function BottomTabBar<T extends string>({
  tabs,
  active,
  onSelect,
  ariaLabel,
  testId,
  tabTestIdPrefix,
}: BottomTabBarProps<T>): JSX.Element {
  return (
    <nav
      aria-label={ariaLabel}
      data-testid={testId}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul
        className="mx-auto grid max-w-2xl"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map(({ id, label, icon: Icon, href, disabled }) => {
          const cls = cn(
            ITEM,
            active === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            disabled && 'opacity-40',
          );
          const inner = (
            <>
              <Icon className="size-[22px]" aria-hidden="true" />
              {label}
            </>
          );
          return (
            <li key={id}>
              {href ? (
                <Link
                  to={href}
                  data-testid={`${tabTestIdPrefix}-${id}`}
                  aria-current={active === id ? 'page' : undefined}
                  className={cls}
                >
                  {inner}
                </Link>
              ) : (
                <button
                  type="button"
                  data-testid={`${tabTestIdPrefix}-${id}`}
                  aria-current={active === id ? 'page' : undefined}
                  disabled={disabled}
                  onClick={() => onSelect?.(id)}
                  className={cls}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default BottomTabBar;
