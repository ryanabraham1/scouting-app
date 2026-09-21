import type { MouseEvent, ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { cn } from '@/lib/utils';

/** Canonical URL of a team's page on the Analysis → Team tab. */
export function teamPageHref(team: number): string {
  return `/analysis?tab=team&team=${encodeURIComponent(team)}`;
}

export interface TeamLinkProps {
  team: number;
  /** Visible content. Defaults to the team number. */
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
  /** Hover hint. Defaults to "Open team N in Analysis". */
  title?: string;
  /**
   * Extra click handler (e.g. to close a modal). The link still navigates
   * unless the handler calls `preventDefault()`.
   */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * A team number that links to that team's page in Analysis. Every non-scout
 * surface (Lead Dashboard, Analysis) renders team numbers through this so a
 * team is always one tap from its full profile. Uses react-router client-side
 * navigation inside the app (works offline — no document reload); falls back
 * to a plain anchor outside a router (unit tests render views bare).
 *
 * Clicks stop propagating so a link inside a clickable row/card opens the team
 * instead of triggering the row's own action.
 */
export function TeamLink(props: TeamLinkProps): JSX.Element {
  const { team, children, className, title, onClick } = props;
  const inRouter = useInRouterContext();
  const href = teamPageHref(team);
  // No aria-label: the visible number is the accessible name, so text that
  // embeds a link ("Strategy note for team 254") still reads naturally.
  const shared = {
    'data-testid': props['data-testid'],
    title: title ?? `Open team ${team} in Analysis`,
    className: cn(
      'rounded tabular-nums text-brand underline-offset-2 hover:text-brand/80 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      className,
    ),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.stopPropagation();
      onClick?.(event);
    },
  };
  const content = children ?? team;
  return inRouter ? (
    <Link to={href} {...shared}>
      {content}
    </Link>
  ) : (
    <a href={href} {...shared}>
      {content}
    </a>
  );
}

export default TeamLink;
