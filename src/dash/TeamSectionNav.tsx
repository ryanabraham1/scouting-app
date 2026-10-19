// src/dash/TeamSectionNav.tsx
// Jump-to-section rail for the Team page. Collapsed it is a slim strip of dots
// pinned to the left edge and vertically centered in the viewport (fixed, so it
// never moves while the page scrolls); hovering expands it into labelled links.
// Touch devices have no hover, so a tap on the strip toggles it open and picking
// a section closes it. The active dot tracks the section currently in view.

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useIsPhoneWidth } from '@/components/useIsPortrait';

export interface TeamSection {
  /** DOM id of the section element to scroll to. */
  id: string;
  label: string;
  /** Optional count badge (e.g. number of notes). */
  count?: number;
}

export default function TeamSectionNav(props: { sections: TeamSection[] }): JSX.Element | null {
  const { sections } = props;
  const [activeId, setActiveId] = useState<string | null>(sections[0]?.id ?? null);
  // Tap-to-open for touch; hover handles pointer devices purely in CSS.
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const phone = useIsPhoneWidth();
  const navRef = useRef<HTMLElement>(null);
  const sectionKey = sections.map((s) => s.id).join('|');

  // Scroll-spy: the active section is the last one whose top has passed the
  // upper third of the viewport. One observer for all sections.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        const first = els.find((el) => visible.has(el.id));
        if (first) setActiveId(first.id);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionKey]);

  // Close the tap-opened rail when tapping anywhere else.
  useEffect(() => {
    if (!pinnedOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setPinnedOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pinnedOpen]);

  if (sections.length < 2) return null;

  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
    setPinnedOpen(false);
  };

  // Phones have no hover and the edge rail is fiddly under a thumb: use a sticky
  // strip of section chips instead (same links and test ids).
  if (phone) {
    return (
      <nav
        aria-label="Team page sections"
        data-testid="team-section-nav"
        className="sticky top-0 z-30 -mx-4 flex gap-1.5 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur"
      >
        {sections.map((s) => {
          const active = s.id === activeId;
          return (
            <a
              key={s.id}
              href={`#${s.id}`}
              data-testid={`team-section-link-${s.id}`}
              aria-current={active ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(s.id);
              }}
              className={cn(
                'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs',
                active ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground',
              )}
            >
              {s.label}
              {s.count != null ? (
                <span className="font-mono tabular-nums opacity-70">{s.count}</span>
              ) : null}
            </a>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      ref={navRef}
      aria-label="Team page sections"
      data-testid="team-section-nav"
      data-open={pinnedOpen || undefined}
      onClick={(e) => {
        // A tap on the collapsed strip (not on a link) opens it on touch screens.
        if (!pinnedOpen && (e.target as HTMLElement).closest('a') == null) setPinnedOpen(true);
      }}
      className={cn(
        'group fixed left-1.5 top-1/2 z-40 -translate-y-1/2 overflow-hidden',
        'w-6 rounded-full border border-zinc-700 bg-zinc-950/95 py-2 shadow-lg backdrop-blur',
        'transition-[width,border-radius,padding] duration-150',
        'hover:w-44 hover:rounded-xl hover:px-1.5 data-[open]:w-44 data-[open]:rounded-xl data-[open]:px-1.5',
      )}
    >
      <ul className="flex flex-col gap-0.5">
        {sections.map((s) => {
          const active = s.id === activeId;
          return (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                data-testid={`team-section-link-${s.id}`}
                aria-current={active ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  // Collapsed on touch: the first tap only opens the rail.
                  if (!pinnedOpen && !navRef.current?.matches(':hover')) {
                    setPinnedOpen(true);
                    return;
                  }
                  jump(s.id);
                }}
                className={cn(
                  'flex h-7 items-center gap-2.5 whitespace-nowrap rounded-md px-[7px] text-sm',
                  active ? 'text-brand' : 'text-zinc-400 hover:text-zinc-100',
                  'group-hover:hover:bg-zinc-800/80 group-data-[open]:hover:bg-zinc-800/80',
                  active && 'group-hover:bg-brand/15 group-data-[open]:bg-brand/15',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 shrink-0 rounded-full transition-transform',
                    active ? 'scale-150 bg-brand' : 'bg-zinc-600',
                  )}
                />
                <span className="opacity-0 transition-opacity group-hover:opacity-100 group-data-[open]:opacity-100">
                  {s.label}
                </span>
                {s.count != null ? (
                  <span className="ml-auto font-mono text-xs text-zinc-500 opacity-0 group-hover:opacity-100 group-data-[open]:opacity-100">
                    {s.count}
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
