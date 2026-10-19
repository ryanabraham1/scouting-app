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
 * Icon-and-label navigation row. Every tab receives an equal share of the
 * available width so the navigation reads as one complete control on phones,
 * tablets, and desktop.
 */
export function IconTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: IconTabsProps<T>): JSX.Element {
  const buttonRefs = React.useRef(new Map<T, HTMLButtonElement>());

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, current: T): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    event.preventDefault();
    const index = enabled.findIndex((tab) => tab.value === current);
    const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const next =
      event.key === 'Home'
        ? enabled[0]
        : event.key === 'End'
          ? enabled[enabled.length - 1]
          : enabled[(index + (backwards ? -1 : 1) + enabled.length) % enabled.length];
    onChange(next.value);
    buttonRefs.current.get(next.value)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'grid w-full grid-flow-col auto-cols-fr gap-1.5 sm:gap-2',
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
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => onKeyDown(event, tab.value)}
            ref={(node) => {
              if (node) buttonRefs.current.set(tab.value, node);
              else buttonRefs.current.delete(tab.value);
            }}
            className={cn(
              'relative flex min-h-11 min-w-0 w-full items-center justify-center gap-2 rounded-[10px] border px-2 text-sm font-medium transition-colors [&_svg]:size-[17px] [&_svg]:shrink-0',
              // Active tab wears the brand accent (E3) — a cyan-tinted surface,
              // brand text, and a top hairline that reads like a lit indicator —
              // so navigation state matches the rest of the color language.
              selected
                ? 'border-brand/50 bg-brand/10 text-brand shadow-[inset_0_2px_0_hsl(var(--brand))]'
                : 'border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              tab.disabled ? 'pointer-events-none opacity-40' : '',
            )}
          >
            {tab.icon}
            <span className="truncate leading-tight">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default IconTabs;
