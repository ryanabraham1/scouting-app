// src/dash/TeamSectionNav.tsx
// Jump-to-section navigation for the Team page: a sticky row of underlined
// section tabs on desktop, a sticky strip of chips on phones. The active entry
// tracks the section currently in view.

import { useEffect, useState } from 'react';
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
  const phone = useIsPhoneWidth();
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

  if (sections.length < 2) return null;

  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
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

  // Desktop: a sticky row of underlined section tabs under the page header —
  // one click jumps, the active tab follows the scroll.
  return (
    <nav
      aria-label="Team page sections"
      data-testid="team-section-nav"
      className="sticky top-0 z-30 -mx-1 flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-1 backdrop-blur"
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
              'inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-sm transition-colors',
              active
                ? 'text-brand shadow-[inset_0_-2px_0_hsl(var(--brand))]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
            {s.count != null ? (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{s.count}</span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}
