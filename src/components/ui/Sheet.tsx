import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Where the panel slides in from. 'right' on landscape, 'bottom' on phones. */
  side?: 'right' | 'bottom';
  children: React.ReactNode;
  className?: string;
  ['data-testid']?: string;
}

/**
 * Lightweight, dependency-free overlay drawer used for drill-downs (full report
 * detail, etc.) so the dashboard shows depth without long vertical scrolling.
 * Closes on Escape and backdrop click; locks body scroll while open.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = 'right',
  children,
  className,
  ...rest
}: SheetProps): JSX.Element | null {
  const testid = rest['data-testid'] ?? 'sheet';

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const panelPos =
    side === 'right'
      ? 'inset-y-0 right-0 h-full w-full max-w-xl border-l'
      : 'inset-x-0 bottom-0 max-h-[90vh] w-full rounded-t-2xl border-t';

  return createPortal(
    <div
      data-testid={`${testid}-overlay`}
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60"
        data-testid={`${testid}-backdrop`}
      />
      <div
        data-testid={testid}
        className={cn(
          'absolute flex flex-col overflow-hidden bg-card text-card-foreground shadow-xl',
          panelPos,
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 truncate text-lg font-bold">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-6"
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export default Sheet;
