// src/dash/board/widgets/ui.tsx
// Shared building blocks so every widget reads as one system (mockup 03):
// mono section labels, hairline key/value rows, muted tags, compact icon
// links (instead of rows of blue text links) and quiet empty states.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WidgetLink } from './interaction';
import type { WidgetConfig, WidgetKind } from './registry';

export function Section({ label, aside, children, className }: { label: string; aside?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <section className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="eyebrow !text-[10px] !tracking-[0.14em]">{label}</span>
        {aside && <span className="ml-auto text-[11px] text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function Tag({ children, tone = 'muted', className }: { children: ReactNode; tone?: 'muted' | 'brand' | 'good' | 'bad' | 'warn'; className?: string }): JSX.Element {
  const tones = {
    muted: 'bg-white/[0.06] text-muted-foreground',
    brand: 'bg-brand/15 text-brand',
    good: 'bg-success/10 text-success',
    bad: 'bg-destructive/15 text-destructive',
    warn: 'bg-warning/10 text-warning',
  };
  return <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px]', tones[tone], className)}>{children}</span>;
}

/** Hairline-separated label/value rows. */
export function KeyValues({ rows }: { rows: [ReactNode, ReactNode, string?][] }): JSX.Element {
  return (
    <dl className="divide-y divide-[hsl(0_0%_14%)]">
      {rows.map(([k, v, key], i) => (
        <div key={key ?? i} className="flex min-w-0 items-baseline justify-between gap-3 py-1">
          <dt className="min-w-0 truncate text-muted-foreground">{k}</dt>
          <dd className="tnum shrink-0 text-right text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface IconLinkSpec {
  kind: WidgetKind;
  config: WidgetConfig;
  icon: LucideIcon;
  label: string;
}

/** Square icon buttons that pin (click) or place (drag) a related card. */
export function IconLinks({ links, className, children }: { links: IconLinkSpec[]; className?: string; children?: ReactNode }): JSX.Element {
  return (
    <div className={cn('flex shrink-0 items-center gap-0.5', className)}>
      {links.map(({ kind, config, icon: Icon, label }) => (
        <WidgetLink key={label} kind={kind} config={config} label={label} className="inline-flex !min-h-0 size-7 items-center justify-center text-muted-foreground hover:text-foreground">
          <Icon className="size-3.5" aria-hidden />
        </WidgetLink>
      ))}
      {children}
    </div>
  );
}

export function EmptyState({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-2 px-4 text-center text-xs leading-relaxed text-muted-foreground">
      {Icon && <Icon className="size-5 opacity-60" aria-hidden />}
      <p className="max-w-[260px]">{children}</p>
    </div>
  );
}
