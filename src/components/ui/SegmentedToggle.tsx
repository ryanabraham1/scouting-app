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
  const buttonRefs = React.useRef(new Map<T, HTMLButtonElement>());

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, current: T): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const index = options.findIndex((option) => option.value === current);
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const next =
      event.key === 'Home'
        ? options[0]
        : event.key === 'End'
          ? options[options.length - 1]
          : options[(index + (backwards ? -1 : 1) + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    buttonRefs.current.get(next.value)?.focus();
  }

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
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(event) => onKeyDown(event, opt.value)}
            ref={(node) => {
              if (node) buttonRefs.current.set(opt.value, node);
              else buttonRefs.current.delete(opt.value);
            }}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-colors [&_svg]:size-5',
              // Default (compact) tabs get tight padding so three counted labels
              // fit one line on a 390px phone instead of wrapping raggedly.
              size === 'big' ? 'min-h-[52px] px-4 text-base' : 'min-h-[40px] px-2 text-sm',
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
