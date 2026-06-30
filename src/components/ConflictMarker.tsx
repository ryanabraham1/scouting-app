// src/components/ConflictMarker.tsx
// Reusable multi-scout conflict badge/chip. Tone derives from the group's
// severity tier; divergence lines come from `formatDivergences`. There is NO
// shared Tooltip/Popover primitive in src/components/ui, so this component is
// self-contained: a `title=` attribute carries the hover summary, and an inline
// click/Enter-toggled expansion (local `open` state) renders the keyboard- /
// touch-accessible divergence detail. No from-scratch floating popover.

import * as React from 'react';
import { AlertTriangle, Users, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDivergences, severityLabel } from '@/dash/reconcile';
import type { MultiScoutGroup, ConflictSeverity } from '@/dash/types';

export interface ConflictMarkerProps {
  group: MultiScoutGroup;
  size?: 'sm' | 'md';
  variant?: 'chip' | 'icon';
  /** Force the inline divergence detail open (e.g. the MatchView header chip). */
  showDetail?: boolean;
}

interface Tone {
  chip: string;
  text: string;
  icon: JSX.Element;
}

function toneFor(severity: ConflictSeverity, sizeClass: string): Tone {
  switch (severity) {
    case 'severe':
      return {
        chip: 'border-destructive/50 bg-destructive/15 text-destructive',
        text: 'text-destructive',
        icon: <AlertTriangle className={sizeClass} />,
      };
    case 'minor':
      return {
        chip: 'border-warning/50 bg-warning/10 text-warning',
        text: 'text-warning',
        icon: <Users className={sizeClass} />,
      };
    case 'unknown':
      return {
        chip: 'border-dashed border-border bg-muted/30 text-muted-foreground',
        text: 'text-muted-foreground',
        icon: <HelpCircle className={sizeClass} />,
      };
    case 'agree':
    default:
      return {
        chip: 'border-border bg-muted/40 text-muted-foreground',
        text: 'text-muted-foreground',
        icon: <Users className={sizeClass} />,
      };
  }
}

export default function ConflictMarker(props: ConflictMarkerProps): JSX.Element {
  const { group, size = 'md', variant = 'chip', showDetail = false } = props;
  const [open, setOpen] = React.useState(false);

  const lines = React.useMemo(() => formatDivergences(group), [group]);
  const summary = lines.join(' · ');
  const sizeClass = size === 'sm' ? 'size-3.5' : 'size-4';
  const tone = toneFor(group.severity, sizeClass);
  const n = group.scoutIds.length;
  const label = `${n} scouts · ${severityLabel(group.severity)}`;

  const detailVisible = showDetail || open;

  const toggle = (): void => setOpen((v) => !v);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <span
      data-testid="conflict-marker"
      data-severity={group.severity}
      className="inline-flex flex-col gap-1"
    >
      <span
        role="button"
        tabIndex={0}
        title={summary}
        aria-expanded={detailVisible}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={cn(
          'inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-full border font-medium',
          tone.chip,
          variant === 'chip'
            ? size === 'sm'
              ? 'px-2 py-0.5 text-xs'
              : 'px-2.5 py-1 text-sm'
            : 'p-1',
        )}
      >
        {tone.icon}
        {variant === 'chip' ? <span>{label}</span> : null}
      </span>

      {detailVisible ? (
        <span
          data-testid="conflict-marker-detail"
          className={cn('flex flex-col gap-0.5 text-xs', tone.text)}
        >
          {lines.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
