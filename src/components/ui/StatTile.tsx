import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatTone =
  | 'default'
  | 'brand'
  | 'energy'
  | 'success'
  | 'warning'
  | 'destructive';

const toneValue: Record<StatTone, string> = {
  default: 'text-foreground',
  brand: 'text-brand',
  energy: 'text-energy',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: StatTone;
  className?: string;
}

/**
 * Compact stat card: an uppercase label, a large tabular value, and optional
 * sub-line/icon. The building block for low-scroll, glanceable dashboard grids.
 */
export function StatTile({
  label,
  value,
  sub,
  icon,
  tone = 'default',
  className,
}: StatTileProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border border-border bg-card/60 p-3',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {icon ? <span className="[&_svg]:size-4">{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div className={cn('font-mono text-2xl font-bold tabular-nums leading-none', toneValue[tone])}>
        {value}
      </div>
      {sub != null ? <div className="text-sm text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export default StatTile;
