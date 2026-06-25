import * as React from 'react';
import { cn } from '@/lib/utils';

export interface PageScaffoldProps {
  title?: React.ReactNode;
  /** Right-aligned header actions (buttons, status chips). */
  actions?: React.ReactNode;
  /** Optional element rendered under the title row (e.g. a tab bar). */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Shared page shell: a sticky header (title + actions + optional toolbar) over a
 * scrollable body. Keeps headers/tab bars in view so users aren't scrolling past
 * navigation on mobile.
 */
export function PageScaffold({
  title,
  actions,
  toolbar,
  children,
  className,
  contentClassName,
}: PageScaffoldProps): JSX.Element {
  return (
    <div className={cn('flex min-h-screen flex-col bg-background text-foreground', className)}>
      {(title || actions || toolbar) && (
        <header className="sticky top-0 z-30 flex flex-col gap-3 border-b border-border bg-background/95 px-safe py-3 pt-safe backdrop-blur">
          {(title || actions) && (
            <div className="flex items-center justify-between gap-3">
              {title ? <h1 className="truncate text-xl font-bold">{title}</h1> : <span />}
              {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
            </div>
          )}
          {toolbar}
        </header>
      )}
      <main className={cn('flex-1 px-safe py-4 pb-safe', contentClassName)}>{children}</main>
    </div>
  );
}

export default PageScaffold;
