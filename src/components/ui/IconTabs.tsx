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
 * Icon-over-label navigation bar. Phones get a single, swipeable row so a large
 * section list does not consume half the viewport; tablet/desktop layouts keep
 * the original grid / landscape treatment.
 */
export function IconTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: IconTabsProps<T>): JSX.Element {
  const buttonRefs = React.useRef(new Map<T, HTMLButtonElement>());

  React.useEffect(() => {
    const selected = buttonRefs.current.get(value);
    const tabList = selected?.parentElement;
    if (!selected || !tabList || typeof tabList.scrollTo !== 'function') return;
    if (typeof window === 'undefined' || !window.matchMedia?.('(max-width: 639px)').matches) return;
    const centeredLeft = selected.offsetLeft - (tabList.clientWidth - selected.offsetWidth) / 2;
    tabList.scrollTo({ left: Math.max(0, centeredLeft), behavior: 'auto' });
  }, [value]);

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
        'flex w-full snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-6 sm:overflow-visible sm:pb-0 landscape:flex landscape:flex-wrap',
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
              'relative flex min-h-12 min-w-[5.5rem] shrink-0 snap-start flex-row items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors sm:min-h-[56px] sm:min-w-0 sm:flex-col sm:gap-1 sm:rounded-xl sm:py-1.5 landscape:flex-1 landscape:basis-24 [&_svg]:size-5',
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
