// src/search/appSearch.ts
// App-wide spotlight: turns a query into places to GO (a page, a section on a
// page, a team or match in Analysis). Teams and matches reuse the board
// spotlight's interpreter (nicknames, typos, "q32", "our next", "1678 vs 254");
// pages and sections are a static index fuzzy-matched by keyword. Pure and
// synchronous, so it runs on every keystroke against cached event data.
import { search as boardSearch, normalizeQuery, tokenize, type SearchContext, type SearchResult } from '@/dash/board/search/interpret';
import { fuzzyScore } from '@/dash/board/search/fuzzy';
import { isPlayed, resolveMatch } from '@/dash/board/widgets/data';

export type AppResultGroup = 'teams' | 'matches' | 'pages';

export interface AppResult {
  key: string;
  title: string;
  subtitle?: string;
  /** Router destination; a #hash scrolls to that section once it renders. */
  to: string;
  group: AppResultGroup;
  score: number;
}

interface Page {
  title: string;
  subtitle: string;
  to: string;
  keywords: string;
}

/** Every screen and the sections worth jumping to. A hash names an element
 * id or data-testid on the destination (see scrollToHash). */
export const PAGES: readonly Page[] = [
  { title: 'Scout a match', subtitle: 'Scout', to: '/scout', keywords: 'scout match capture record stands' },
  { title: 'Pit scouting', subtitle: 'Scout', to: '/scout?mode=pit', keywords: 'pit scouting robot photo dimensions' },
  { title: 'Scouting tutorial', subtitle: 'Scout', to: '/scout/tutorial', keywords: 'tutorial practice learn training' },
  { title: 'My data', subtitle: 'Scout', to: '/my-data', keywords: 'my data reports submitted history' },
  { title: 'Send reports by QR', subtitle: 'Offline transfer', to: '/qr/send', keywords: 'qr send transfer offline share code' },
  { title: 'Receive reports by QR', subtitle: 'Offline transfer', to: '/qr/receive', keywords: 'qr receive scan import offline camera' },
  { title: 'Sync status', subtitle: 'Offline transfer', to: '/sync', keywords: 'sync status upload pending outbox failed offline' },
  { title: 'Pit display', subtitle: 'Analysis', to: '/analysis?tab=next', keywords: 'pit display next match on field now live' },
  { title: 'Team lookup', subtitle: 'Analysis', to: '/analysis?tab=team', keywords: 'team lookup profile stats' },
  { title: 'Match lookup', subtitle: 'Analysis', to: '/analysis?tab=match', keywords: 'match lookup breakdown prediction' },
  { title: 'Rankings', subtitle: 'Analysis', to: '/analysis?tab=ranking', keywords: 'ranking rankings standings bsr epa leaderboard table' },
  { title: 'Strategy', subtitle: 'Lead dashboard', to: '/dashboard?tab=strategy', keywords: 'strategy whiteboard plan phases field drawing' },
  { title: "Ryan's Board", subtitle: 'Lead dashboard', to: '/dashboard?tab=board', keywords: 'board canvas widgets infinite ryan' },
  { title: 'Scouters', subtitle: 'Lead dashboard', to: '/dashboard?tab=scouters', keywords: 'scouters roster people scouts' },
  { title: 'Scouting coverage', subtitle: 'Scouters', to: '/dashboard?tab=scouters#coverage', keywords: 'coverage next matches assigned open seats' },
  { title: 'Missed assignments', subtitle: 'Scouters', to: '/dashboard?tab=scouters#scouter-missed-card', keywords: 'missed assignments skipped no show' },
  { title: 'Scouter roster', subtitle: 'Scouters', to: '/dashboard?tab=scouters#roster-list', keywords: 'roster add hide delete scouter name' },
  { title: 'Picklist', subtitle: 'Lead dashboard', to: '/dashboard?tab=picklist', keywords: 'picklist pick list first second order' },
  { title: 'Do not pick', subtitle: 'Picklist', to: '/dashboard?tab=picklist#do-not-pick', keywords: 'do not pick dnp excluded blacklist avoid' },
  { title: 'Add teams to picklist', subtitle: 'Picklist', to: '/dashboard?tab=picklist#picklist-epa-board', keywords: 'add teams candidates not on list' },
  { title: 'Draft', subtitle: 'Lead dashboard', to: '/dashboard?tab=draft', keywords: 'draft alliance selection best remaining pick next' },
  { title: 'Alliances', subtitle: 'Draft', to: '/dashboard?tab=draft#alliances', keywords: 'alliances captains seats grid selection' },
  { title: 'Our alliance', subtitle: 'Draft', to: '/dashboard?tab=draft#draft-alliance', keywords: 'our alliance picked by captain partners' },
  { title: 'Team pool', subtitle: 'Draft', to: '/dashboard?tab=draft#draft-pool', keywords: 'pool available taken cross off' },
  { title: 'Settings', subtitle: 'Lead dashboard', to: '/dashboard?tab=settings', keywords: 'settings setup config admin' },
  { title: 'Active event', subtitle: 'Settings', to: '/dashboard?tab=settings#active-event', keywords: 'active event switch change competition' },
  { title: 'Base team', subtitle: 'Settings', to: '/dashboard?tab=settings#setup-base-team', keywords: 'base team our team number ours' },
  { title: 'Import an event', subtitle: 'Settings', to: '/dashboard?tab=settings#import-event', keywords: 'import event tba blue alliance new add' },
  { title: 'Events on this account', subtitle: 'Settings', to: '/dashboard?tab=settings#setup-events', keywords: 'events delete remove imported list' },
  { title: 'Demo mode', subtitle: 'Settings', to: '/dashboard?tab=settings#setup-demo', keywords: 'demo mode fake practice sample data' },
  { title: 'Validate scouting vs TBA', subtitle: 'Settings', to: '/dashboard?tab=settings#validate-scouting', keywords: 'validate check accuracy tba scores compare' },
  { title: 'Lock lead dashboard', subtitle: 'Settings', to: '/dashboard?tab=settings#lock-dashboard', keywords: 'lock pin code password' },
  { title: 'Assignments', subtitle: 'Settings · match and pit scouting', to: '/dashboard?tab=settings#assignments', keywords: 'assign schedule planner auto generate export' },
];

const pageTerms = new WeakMap<Page, string[]>();
function termsOf(p: Page): string[] {
  let t = pageTerms.get(p);
  if (!t) {
    t = tokenize(normalizeQuery(`${p.title} ${p.subtitle} ${p.keywords}`));
    pageTerms.set(p, t);
  }
  return t;
}

const titleTerms = new WeakMap<Page, string[]>();
function titleOf(p: Page): string[] {
  let t = titleTerms.get(p);
  if (!t) {
    t = tokenize(normalizeQuery(p.title));
    titleTerms.set(p, t);
  }
  return t;
}

/** Share of query words found in the page's words (last word may be partial),
 * plus a little for covering more of the title (so "assignments" prefers the
 * page titled exactly that). */
function pageScore(tokens: string[], p: Page): number {
  const terms = termsOf(p);
  const title = titleOf(p);
  const covered = new Set<string>();
  let total = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    let best = 0;
    let bestTerm = '';
    for (const term of terms) {
      const s = fuzzyScore(tokens[i], term, i === tokens.length - 1);
      if (s > best) {
        best = s;
        bestTerm = term;
      }
    }
    if (best === 0) return 0;
    covered.add(bestTerm);
    total += best;
  }
  const titleCover = title.filter((t) => covered.has(t)).length / Math.max(1, title.length);
  return total / tokens.length + 0.1 * titleCover;
}

const ANALYSIS_TEAM_KINDS = new Set(['team', 'schedule', 'stats', 'epaHistory', 'teamNotes', 'pit', 'robotPhoto', 'reports', 'nextMatch']);

/** Where a board spotlight result lives in the rest of the app. */
function destination(r: SearchResult, ctx: SearchContext): Omit<AppResult, 'score'> | null {
  const kind = r.widget?.kind ?? r.kind;
  const c = r.widget?.config ?? {};
  const match = typeof c.match === 'string' ? resolveMatch(c.match, ctx) : null;
  const team = typeof c.team === 'number' ? c.team : null;
  if (match && (kind === 'match' || kind === 'matchVideo' || kind === 'autoPath' || !team)) {
    return { key: `match:${match.match_key}`, title: r.title, subtitle: r.subtitle ?? 'Match breakdown', to: `/analysis?tab=match&match=${encodeURIComponent(match.match_key)}`, group: 'matches' };
  }
  if (team && (ANALYSIS_TEAM_KINDS.has(kind) || kind === 'matchVideo' || kind === 'autoPath')) {
    return { key: `team:${team}`, title: r.kind === 'team' ? r.title : `${r.title}`, subtitle: 'Team profile', to: `/analysis?tab=team&team=${team}`, group: 'teams' };
  }
  if (kind === 'rankings' || kind === 'compare' || r.kind === 'teamMetric') {
    return { key: 'page:ranking', title: r.title, subtitle: 'Rankings', to: '/analysis?tab=ranking', group: 'pages' };
  }
  if (kind === 'onField') return { key: 'page:next', title: 'On field now', subtitle: 'Pit display', to: '/analysis?tab=next', group: 'matches' };
  if (kind === 'picklist') return { key: 'page:picklist', title: r.title, subtitle: 'Picklist', to: '/dashboard?tab=picklist', group: 'pages' };
  return null;
}

export function appSearch(query: string, ctx: SearchContext | null, limit = 10): AppResult[] {
  const tokens = tokenize(normalizeQuery(query));
  const out = new Map<string, AppResult>();
  const add = (r: AppResult): void => {
    const prev = out.get(r.key);
    if (!prev || r.score > prev.score) out.set(r.key, r);
  };
  if (ctx && tokens.length) {
    for (const r of boardSearch(query, ctx).results) {
      const d = destination(r, ctx);
      if (d) add({ ...d, score: r.score });
    }
  }
  if (tokens.length) {
    for (const p of PAGES) {
      const s = pageScore(tokens, p);
      // Page words are exact intent ("settings", "draft"): rank a full match
      // with the strongest entity hits.
      if (s > 0) add({ key: `page:${p.to}`, title: p.title, subtitle: p.subtitle, to: p.to, group: 'pages', score: s * 1.4 });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Shown before anything is typed. */
export function appSuggestions(ctx: SearchContext | null): AppResult[] {
  const out: AppResult[] = [];
  const next = ctx ? resolveMatch('our-next', ctx) : null;
  if (next) {
    out.push({ key: `match:${next.match_key}`, title: `${isPlayed(next) ? 'Our last match' : 'Our next match'} · ${next.match_key.slice(next.match_key.lastIndexOf('_') + 1)}`, subtitle: 'Match breakdown', to: `/analysis?tab=match&match=${encodeURIComponent(next.match_key)}`, group: 'matches', score: 1 });
  }
  if (ctx?.baseTeam) out.push({ key: `team:${ctx.baseTeam}`, title: `${ctx.baseTeam} · our team`, subtitle: 'Team profile', to: `/analysis?tab=team&team=${ctx.baseTeam}`, group: 'teams', score: 0.9 });
  for (const to of ['/analysis?tab=ranking', '/dashboard?tab=picklist', '/dashboard?tab=draft', '/dashboard?tab=settings#assignments']) {
    const p = PAGES.find((x) => x.to === to)!;
    out.push({ key: `page:${p.to}`, title: p.title, subtitle: p.subtitle, to: p.to, group: 'pages', score: 0.5 });
  }
  return out;
}
