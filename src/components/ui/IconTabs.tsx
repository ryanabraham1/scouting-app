import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IconTab<T extends string> {
  value: T;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

export interface IconTabsProps<T extends string> {
  tabs: IconTab<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

/**
 * Icon-over-label navigation bar that fits without horizontal scroll. It wraps
 * onto multiple compact rows on narrow screens instead of overflowing, so the
 * dashboard's tabs stay reachable on a phone.
 */
export function IconTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: IconTabsProps<T>): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'grid grid-cols-4 gap-1.5 sm:grid-cols-6 landscape:flex landscape:flex-wrap',
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => onChange(tab.value)}
            className={cn(
              'relative flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border px-2 py-1.5 text-xs font-semibold transition-colors landscape:flex-1 landscape:basis-24 [&_svg]:size-5',
              // Active tab wears the brand accent (E3) — a cyan-tinted surface,
              // brand text, and a top hairline that reads like a lit indicator —
              // so navigation state matches the rest of the color language.
              selected
                ? 'border-brand/50 bg-brand/10 text-brand shadow-[inset_0_2px_0_hsl(var(--brand))]'
                : 'border-border bg-card/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              tab.disabled ? 'pointer-events-none opacity-40' : '',
            )}
          >
            {tab.icon}
            <span className="text-center leading-tight">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default IconTabs;
