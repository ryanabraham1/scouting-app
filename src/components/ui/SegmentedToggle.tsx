import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Extra classes applied only when this option is selected (e.g. a semantic
      tint like `text-brand` / `text-energy` so the active mode is glanceable). */
  activeClassName?: string;
}

export interface SegmentedToggleProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  size?: 'default' | 'big';
}

/**
 * Accessible pill-style segmented control (2–N options). Used for the Scout Home
 * Match/Pit switch and other inline mode toggles. Big touch targets by default.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  size = 'big',
}: SegmentedToggleProps<T>): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex w-full items-stretch gap-1 rounded-xl border border-border bg-muted/40 p-1',
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 font-semibold transition-colors [&_svg]:size-5',
              size === 'big' ? 'min-h-[52px] text-base' : 'min-h-[40px] text-sm',
              selected
                ? cn('border border-border bg-background text-foreground shadow-sm', opt.activeClassName)
                : 'border border-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground',
            )}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedToggle;
