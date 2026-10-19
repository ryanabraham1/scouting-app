// src/dash/board/search/interpret.ts
// Spotlight's brain: turns a free-form query ("cheesy last match", "q 32",
// "top 10 auto", "1678 vs 254") into resolved entities + intent, then into
// ranked, insertable results. Pure and synchronous (runs on every keystroke
// against event data already in the query cache, so it works offline).
// Plan: docs/plans/ryans-board/README.md §11.
import type { MatchRow } from '@/dash/useEventData';
import { METRICS, isPlayed, lastPlayedMatch, nextMatchOf, teamMatches, teamsOf, type MetricKey } from '@/dash/board/widgets/data';
import type { WidgetConfig, WidgetKind } from '@/dash/board/widgets/registry';
import { bestTerm, fuzzyScore } from '@/dash/board/search/fuzzy';
import {
  INTENT_WORDS,
  MATCH_PREFIX,
  METRIC_WORDS,
  NAME_STOPWORDS,
  PHRASES,
  STOPWORDS,
  type Intent,
} from '@/dash/board/search/lexicon';

export interface SearchTeam {
  number: number;
  nickname: string | null;
}

export interface SearchContext {
  eventKey: string;
  teams: SearchTeam[];
  matches: MatchRow[];
  baseTeam: number;
  watchlist?: number[];
  /** Text on the board (focus a note by searching its words). */
  texts?: { id: string; text: string }[];
  /** Per-device learned picks: normalized query -> result key -> count. */
  learned?: Record<string, Record<string, number>>;
}

export type ResultGroup = 'best' | 'team' | 'matches' | 'rankings' | 'board' | 'widgets' | 'actions';

export type ResultKind =
  | 'team'
  | 'match'
  | 'schedule'
  | 'compare'
  | 'rankings'
  | 'teamMetric'
  | 'epaHistory'
  | 'onField'
  | 'picklist'
  | 'watchlist'
  | 'watch'
  | 'boardText'
  | 'widget';

export interface SearchResult {
  key: string;
  kind: ResultKind;
  title: string;
  subtitle?: string;
  score: number;
  group: ResultGroup;
  widget?: { kind: WidgetKind; config: WidgetConfig };
  action?: { type: 'watch'; team: number } | { type: 'focus'; shapeId: string };
}

export interface Interpretation {
  teams: number[];
  matches: MatchRow[];
  metric: MetricKey | null;
  intents: Set<Intent>;
  count: number | null;
  /** Mentioned "match"/"matches" without a number. */
  matchWord: boolean;
  /** Other stats the word being typed could complete to ("re" -> reliability, rank...). */
  completions: MetricKey[];
  /** The only team came from "our/us" (keeps dynamic 'our-next' bindings). */
  selfOnly: boolean;
  /** 0..1: how much of the query was understood. */
  quality: number;
  /** Every meaningful token was resolved. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeQuery(q: string): string {
  let s = q.toLowerCase().replace(/[’`]/g, "'");
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  s = s.replace(/'s\b/g, '').replace(/[^a-z0-9#\s]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Split words into letter / digit runs: "qm32" -> qm 32, "frc254" -> frc 254. */
export function tokenize(normalized: string): string[] {
  const out: string[] = [];
  for (const word of normalized.split(' ')) {
    if (!word) continue;
    for (const m of word.matchAll(/#|[a-z]+|\d+/g)) out.push(m[0]);
  }
  return out;
}

const isNum = (t: string | undefined): boolean => !!t && /^\d+$/.test(t);

// ---------------------------------------------------------------------------
// Index (memoized per context object)
// ---------------------------------------------------------------------------

interface Index {
  teamSet: Set<number>;
  nick: Map<number, string | null>;
  /** Nickname word -> teams. */
  words: Map<string, number[]>;
  byKey: Map<string, MatchRow>;
}

const indexCache = new WeakMap<SearchContext, Index>();

function buildIndex(ctx: SearchContext): Index {
  const hit = indexCache.get(ctx);
  if (hit) return hit;
  const teamSet = new Set<number>();
  const nick = new Map<number, string | null>();
  for (const t of ctx.teams) {
    teamSet.add(t.number);
    nick.set(t.number, t.nickname);
  }
  for (const m of ctx.matches) for (const t of teamsOf(m)) teamSet.add(t);
  const words = new Map<string, number[]>();
  for (const t of ctx.teams) {
    if (!t.nickname) continue;
    const ws = normalizeQuery(t.nickname).split(' ');
    for (const w of ws) {
      if (w.length < 2 || NAME_STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      const list = words.get(w) ?? [];
      if (!list.includes(t.number)) list.push(t.number);
      words.set(w, list);
    }
  }
  const byKey = new Map(ctx.matches.map((m) => [m.match_key, m] as const));
  const idx = { teamSet, nick, words, byKey };
  indexCache.set(ctx, idx);
  return idx;
}

function findMatch(ctx: SearchContext, idx: Index, level: 'qm' | 'qf' | 'sf' | 'f', a: number | null, b: number | null): MatchRow | null {
  const ek = ctx.eventKey;
  const keys: string[] = [];
  if (level === 'qm' && a != null) keys.push(`${ek}_qm${a}`);
  if ((level === 'sf' || level === 'qf') && a != null) keys.push(`${ek}_${level}${a}m${b ?? 1}`);
  if (level === 'f') {
    if (a != null) keys.push(`${ek}_f1m${a}`, `${ek}_f${a}m1`);
    else {
      // "final(s)": the next unplayed final, else the first.
      const finals = ctx.matches.filter((m) => m.comp_level === 'f').sort((x, y) => (x.match_key < y.match_key ? -1 : 1));
      return finals.find((m) => !isPlayed(m)) ?? finals[0] ?? idx.byKey.get(`${ek}_f1m1`) ?? null;
    }
  }
  for (const k of keys) {
    const m = idx.byKey.get(k);
    if (m) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

export function interpret(query: string, ctx: SearchContext): Interpretation {
  const idx = buildIndex(ctx);
  const tokens = tokenize(normalizeQuery(query));
  const teams: number[] = [];
  const matches: MatchRow[] = [];
  const intents = new Set<Intent>();
  let metric: MetricKey | null = null;
  let count: number | null = null;
  let matchWord = false;
  const qualities: number[] = [];
  const leftovers: { t: string; last: boolean }[] = [];
  const completions: MetricKey[] = [];
  const addTeam = (n: number): void => {
    if (!teams.includes(n)) teams.push(n);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const level = MATCH_PREFIX[t];
    if (level && isNum(next) && !(level === 'qm' && t === 'm' && i > 0 && isNum(tokens[i - 1]))) {
      let b: number | null = null;
      let used = 2;
      if ((level === 'sf' || level === 'qf') && tokens[i + 2] === 'm' && isNum(tokens[i + 3])) {
        b = Number(tokens[i + 3]);
        used = 4;
      }
      const m = findMatch(ctx, idx, level, Number(next), b);
      if (m) {
        if (!matches.includes(m)) matches.push(m);
        qualities.push(1);
      } else qualities.push(0.3);
      i += used - 1;
      continue;
    }
    if ((t === 'final' || t === 'finals') && !isNum(next)) {
      const m = findMatch(ctx, idx, 'f', null, null);
      if (m) matches.push(m);
      qualities.push(m ? 1 : 0.3);
      continue;
    }
    if (isNum(t)) {
      const n = Number(t);
      if (tokens[i - 1] === 'top' || isNum(t) && INTENT_WORDS[next ?? ''] === 'best' && n <= 30) {
        count = n;
        qualities.push(1);
        continue;
      }
      if (idx.teamSet.has(n)) {
        addTeam(n);
        qualities.push(1);
      } else {
        const m = findMatch(ctx, idx, 'qm', n, null);
        if (m) {
          matches.push(m);
          qualities.push(0.9);
        } else if (n > 0 && n < 100000) {
          addTeam(n);
          qualities.push(0.6);
        }
      }
      continue;
    }
    if (t === 'match' || t === 'm') {
      matchWord = true;
      continue;
    }
    if (INTENT_WORDS[t]) {
      intents.add(INTENT_WORDS[t]);
      qualities.push(1);
      continue;
    }
    if (METRIC_WORDS[t]) {
      metric = METRIC_WORDS[t];
      qualities.push(1);
      continue;
    }
    if (STOPWORDS.has(t) || t === '#') continue;
    leftovers.push({ t, last: i === tokens.length - 1 });
  }

  // Leftover words: team nicknames, or typos of known vocabulary.
  for (const { t, last } of leftovers) {
    let bestTeams: number[] = [];
    let bestTeamScore = 0;
    for (const [word, owners] of idx.words) {
      const s = fuzzyScore(t, word, last);
      if (s > bestTeamScore) {
        bestTeamScore = s;
        bestTeams = owners;
      } else if (s === bestTeamScore && s > 0) {
        bestTeams = [...new Set([...bestTeams, ...owners])];
      }
    }
    // The word still being typed prefix-matches the vocabulary too, so
    // "2045 reli" already means reliability (not just the team card).
    const vocabTerms = [...Object.keys(METRIC_WORDS), ...Object.keys(INTENT_WORDS)];
    const vocab = last && t.length >= 2 ? bestTerm(t, vocabTerms, true) : t.length >= 4 ? bestTerm(t, vocabTerms) : null;
    if (last && t.length >= 2) {
      // Other meanings the partial word could finish as (shown as alternates).
      for (const term of vocabTerms) {
        if (!term.startsWith(t) || term === vocab?.term) continue;
        const m = METRIC_WORDS[term];
        if (m && m !== METRIC_WORDS[vocab?.term ?? ''] && !completions.includes(m)) completions.push(m);
      }
    }
    if (vocab && vocab.score >= 0.7 && vocab.score > bestTeamScore) {
      if (METRIC_WORDS[vocab.term]) metric = METRIC_WORDS[vocab.term];
      else intents.add(INTENT_WORDS[vocab.term]);
      qualities.push(vocab.score);
    } else if (bestTeamScore >= 0.55 && bestTeams.length) {
      // An ambiguous word (shared by several nicknames) resolves to the
      // lowest number first; the others still show as alternates.
      bestTeams.sort((a, b) => a - b).slice(0, 1).forEach(addTeam);
      qualities.push(bestTeamScore * (bestTeams.length > 1 ? 0.9 : 1));
    } else {
      qualities.push(0);
    }
  }

  const selfOnly = intents.has('self') && teams.length === 0;
  if (selfOnly) teams.push(ctx.baseTeam);
  const quality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0;
  return {
    teams,
    matches,
    metric,
    intents,
    count,
    matchWord,
    selfOnly,
    completions: completions.slice(0, 4),
    quality,
    complete: qualities.every((q) => q >= 0.55),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function shortLabel(m: MatchRow): string {
  const i = m.match_key.lastIndexOf('_');
  return i >= 0 ? m.match_key.slice(i + 1) : m.match_key;
}

function scoreLine(m: MatchRow): string {
  return isPlayed(m) ? `${m.actual_red_score}–${m.actual_blue_score}` : 'upcoming';
}

const COMPARE_METRICS: MetricKey[] = ['bsr', 'auto', 'teleop', 'endgame', 'scouted', 'reliability'];

export function search(query: string, ctx: SearchContext): { interpretation: Interpretation; results: SearchResult[] } {
  const norm = normalizeQuery(query);
  const it = interpret(query, ctx);
  const idx = buildIndex(ctx);
  const out = new Map<string, SearchResult>();
  const base = it.quality + (it.complete ? 0.35 : 0);
  const name = (t: number): string => {
    const n = idx.nick.get(t);
    return n ? `${t} · ${n}` : String(t);
  };
  const add = (r: SearchResult): void => {
    const prev = out.get(r.key);
    if (!prev || r.score > prev.score) out.set(r.key, r);
  };

  const teamResult = (t: number, score: number, group: ResultGroup = 'team'): SearchResult => ({
    key: `team:${t}`,
    kind: 'team',
    title: name(t),
    subtitle: 'Team card',
    score,
    group,
    widget: { kind: 'team', config: { team: t, variant: 'detailed' } },
  });
  const matchResult = (m: MatchRow, score: number, title?: string, group: ResultGroup = 'matches'): SearchResult => ({
    key: `match:${m.match_key}`,
    kind: 'match',
    title: title ?? `${shortLabel(m)} · ${teamsOf(m).slice(0, 3).join(' ')} vs ${teamsOf(m).slice(3).join(' ')}`,
    subtitle: scoreLine(m),
    score,
    group,
    widget: { kind: 'match', config: { match: shortLabel(m) } },
  });
  const scheduleResult = (t: number, score: number): SearchResult => {
    const ms = teamMatches(ctx.matches, t);
    const played = ms.filter(isPlayed).length;
    return {
      key: `schedule:${t}`,
      kind: 'schedule',
      title: `${t} matches · last, next and full schedule`,
      subtitle: `${played} played · ${ms.length - played} upcoming`,
      score,
      group: 'team',
      widget: { kind: 'schedule', config: { team: t } },
    };
  };
  const teamSection = (t: number, score: number): void => {
    const last = lastPlayedMatch(ctx.matches, t);
    const next = nextMatchOf(ctx.matches, t);
    if (last) add(matchResult(last, score - 0.02, `Last match ${shortLabel(last)}`, 'team'));
    if (next) add(matchResult(next, score - 0.03, `Next match ${shortLabel(next)}`, 'team'));
    add(scheduleResult(t, score - 0.04));
    add(teamResult(t, score - 0.05));
    add({
      key: `watch:${t}`,
      kind: 'watch',
      title: (ctx.watchlist ?? []).includes(t) ? `Remove ${t} from watchlist` : `Add ${t} to watchlist`,
      score: score - 0.3,
      group: 'actions',
      action: { type: 'watch', team: t },
    });
  };
  const rankingsResult = (metric: MetricKey, score: number): SearchResult => {
    const def = METRICS[metric];
    const worst = it.intents.has('worst');
    const asc = worst ? !def.lowerBetter : !!def.lowerBetter;
    const count = Math.max(3, Math.min(30, it.count ?? 5));
    const dir = asc ? 'asc' : 'desc';
    return {
      key: `rankings:${metric}:${dir}:${count}`,
      kind: 'rankings',
      title: `${worst ? 'Bottom' : 'Top'} ${count} · ${def.label}`,
      subtitle: 'Live ranking',
      score,
      group: 'rankings',
      widget: { kind: 'rankings', config: { metric, count, dir } },
    };
  };

  const T = it.teams;
  const I = it.intents;
  const explorer = (['video', 'photo', 'autopath', 'notes', 'pit', 'reports', 'stats', 'data'] as const).find((intent) => I.has(intent));
  if (explorer) {
    const t = T[0] ?? ctx.baseTeam;
    const kind = ({ video: 'matchVideo', photo: 'robotPhoto', autopath: 'autoPath', notes: 'teamNotes', pit: 'pit', reports: 'reports', stats: 'stats', data: 'data' } as const)[explorer];
    const label = ({ video: 'Match video', photo: 'Robot photos', autopath: 'Auto path', notes: 'Scouting notes', pit: 'Pit report', reports: 'Scouting reports', stats: 'All stats', data: 'App data explorer' } as const)[explorer];
    const m = it.matches[0] ?? (I.has('next') ? nextMatchOf(ctx.matches, t) : I.has('last') ? lastPlayedMatch(ctx.matches, t) : null);
    const config: WidgetConfig = { team: it.matches.length && !T.length ? 'all' : t, ...(m ? { match: m.match_key } : {}), ...(kind === 'data' ? { source: 'reports' } : {}) };
    add({ key: `${kind}:${m?.match_key ?? t}`, kind: 'widget', title: `${label} · ${m ? shortLabel(m) : name(t)}`, score: base + 0.5, group: 'best', widget: { kind, config } });
    if (T.length) teamSection(t, base - 0.4);
  } else if (T.length >= 1 && I.has('watch')) {
    add({
      key: `watch:${T[0]}`,
      kind: 'watch',
      title: `${(ctx.watchlist ?? []).includes(T[0]) ? 'Remove' : 'Add'} ${name(T[0])} ${(ctx.watchlist ?? []).includes(T[0]) ? 'from' : 'to'} watchlist`,
      score: base + 0.3,
      group: 'actions',
      action: { type: 'watch', team: T[0] },
    });
    teamSection(T[0], base);
  } else if (T.length >= 2 || (I.has('compare') && T.length === 1)) {
    const teams = T.length >= 2 ? T.slice(0, 6) : [T[0], ctx.baseTeam];
    add({
      key: `compare:${teams.join(',')}`,
      kind: 'compare',
      title: `Compare ${teams.join(' and ')}`,
      subtitle: teams.map((t) => idx.nick.get(t) ?? t).join(' · '),
      score: base + 0.3,
      group: 'best',
      widget: { kind: 'compare', config: { teams, metrics: COMPARE_METRICS } },
    });
    for (const m of ctx.matches) {
      const ts = teamsOf(m);
      if (teams.slice(0, 2).every((t) => ts.includes(t))) add(matchResult(m, base - 0.1));
    }
    for (const t of teams) add(teamResult(t, base - 0.2));
  } else if (T.length === 1 && it.selfOnly && I.has('next')) {
    // "our next": keep the dynamic binding so the widget follows the event.
    const next = nextMatchOf(ctx.matches, ctx.baseTeam);
    add({
      key: 'match:our-next',
      kind: 'match',
      title: 'Our next match',
      subtitle: next ? shortLabel(next) : undefined,
      score: base + 0.3,
      group: 'matches',
      widget: { kind: 'match', config: { match: 'our-next' } },
    });
    teamSection(ctx.baseTeam, base);
  } else if (T.length === 1) {
    const t = T[0];
    const last = lastPlayedMatch(ctx.matches, t);
    const next = nextMatchOf(ctx.matches, t);
    if (I.has('last') && last) add(matchResult(last, base + 0.3, `${t} last match ${shortLabel(last)}`, 'best'));
    else if (I.has('next') && next) add(matchResult(next, base + 0.3, `${t} next match ${shortLabel(next)}`, 'best'));
    else if (I.has('last') || I.has('next') || I.has('schedule') || it.matchWord) add(scheduleResult(t, base + 0.3));
    else if (I.has('history') || it.metric === 'bsr') {
      add({
        key: `epaHistory:${t}`,
        kind: 'epaHistory',
        title: `${name(t)} · BSR history`,
        subtitle: 'BSR after every match',
        score: base + 0.3,
        group: 'best',
        widget: { kind: 'epaHistory', config: { teams: [t] } },
      });
    } else if (it.metric) {
      const label = METRICS[it.metric].label;
      add({
        key: `teamMetric:${t}:${it.metric}`,
        kind: 'teamMetric',
        title: `${t} · ${label}`,
        subtitle: 'Live stat tile',
        score: base + 0.3,
        group: 'best',
        widget: { kind: 'stat', config: { expr: `${t}.${it.metric}`, label: `${t} · ${label}` } },
      });
    } else add(teamResult(t, base + 0.3, 'best'));
    teamSection(t, base);
    for (const [i, m] of it.completions.entries()) {
      const label = METRICS[m].label;
      add({
        key: `teamMetric:${t}:${m}`,
        kind: 'teamMetric',
        title: `${t} · ${label}`,
        subtitle: 'Live stat tile',
        score: base + 0.1 - i * 0.02,
        group: 'team',
        widget: { kind: 'stat', config: { expr: `${t}.${m}`, label: `${t} · ${label}` } },
      });
    }
  } else if (it.matches.length) {
    it.matches.forEach((m, i) => add(matchResult(m, base + 0.3 - i * 0.05)));
  } else if (I.has('next') || I.has('last')) {
    const next = nextMatchOf(ctx.matches, ctx.baseTeam);
    const last = lastPlayedMatch(ctx.matches, ctx.baseTeam);
    add({
      key: 'match:our-next',
      kind: 'match',
      title: 'Our next match',
      subtitle: next ? shortLabel(next) : last ? `No more matches · last ${shortLabel(last)}` : undefined,
      score: base + (I.has('next') ? 0.3 : 0.1),
      group: 'matches',
      widget: { kind: 'match', config: { match: 'our-next' } },
    });
    if (last) add(matchResult(last, base + (I.has('last') ? 0.3 : 0), `Our last match ${shortLabel(last)}`));
  } else if (it.metric || I.has('best') || I.has('worst') || I.has('top')) {
    add(rankingsResult(it.metric ?? 'bsr', base + 0.3));
  } else if (I.has('onField')) {
    add({ key: 'onField', kind: 'onField', title: 'On field now', subtitle: 'Live Nexus status', score: base + 0.3, group: 'matches', widget: { kind: 'onField', config: {} } });
  } else if (I.has('picklist')) {
    add({ key: 'picklist', kind: 'picklist', title: 'Picklist', subtitle: 'Live from the Picklist tab', score: base + 0.3, group: 'widgets', widget: { kind: 'picklist', config: {} } });
  } else if (I.has('watchlist')) {
    add({ key: 'watchlist', kind: 'watchlist', title: 'Watchlist', subtitle: `${(ctx.watchlist ?? []).length} teams`, score: base + 0.3, group: 'widgets', widget: { kind: 'watchlist', config: { teams: ctx.watchlist ?? [] } } });
  } else if (I.has('schedule')) {
    add(scheduleResult(ctx.baseTeam, base + 0.2));
  } else if (I.has('history')) {
    add({ key: `epaHistory:${ctx.baseTeam}`, kind: 'epaHistory', title: `${ctx.baseTeam} · BSR history`, score: base + 0.2, group: 'widgets', widget: { kind: 'epaHistory', config: { teams: [ctx.baseTeam] } } });
  } else if (I.has('compare')) {
    add({ key: 'compare:', kind: 'compare', title: 'Compare teams', subtitle: 'Add teams in the widget settings', score: base + 0.2, group: 'widgets', widget: { kind: 'compare', config: { teams: [], metrics: COMPARE_METRICS } } });
  }

  // Board text (focus a note).
  if (norm.length >= 2) {
    const words = norm.split(' ').filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    for (const tx of ctx.texts ?? []) {
      const hay = normalizeQuery(tx.text);
      if (!words.length) break;
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits === 0) continue;
      const s = 0.4 + 0.5 * (hits / words.length);
      add({
        key: `board:${tx.id}`,
        kind: 'boardText',
        title: `Board text: "${tx.text.length > 60 ? `${tx.text.slice(0, 57)}…` : tx.text}"`,
        subtitle: 'on board',
        score: s,
        group: 'board',
        action: { type: 'focus', shapeId: tx.id },
      });
    }
  }

  // Context boosts and learned picks.
  const learned = ctx.learned?.[norm] ?? {};
  const results = [...out.values()].map((r) => {
    let s = r.score;
    const team = r.kind === 'team' ? Number(r.key.split(':')[1]) : null;
    if (team != null && (ctx.watchlist ?? []).includes(team)) s += 0.1;
    // A habit beats a heuristic: three picks of the same result make it the top one.
    if (learned[r.key]) s += Math.min(0.45, 0.15 * learned[r.key]);
    return { ...r, score: s };
  });
  results.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const visible = results.filter((r) => r.score >= 0.35);
  if (visible[0]) visible[0] = { ...visible[0], group: 'best' };
  return { interpretation: it, results: visible };
}

/** Suggestions for an empty query. */
export function suggestions(ctx: SearchContext): SearchResult[] {
  const out: SearchResult[] = [];
  const next = nextMatchOf(ctx.matches, ctx.baseTeam);
  if (next) {
    out.push({
      key: 'match:our-next',
      kind: 'match',
      title: `Our next match: ${shortLabel(next)}`,
      score: 1,
      group: 'matches',
      widget: { kind: 'match', config: { match: 'our-next' } },
    });
  }
  out.push({ key: 'onField', kind: 'onField', title: 'On field now', score: 0.9, group: 'matches', widget: { kind: 'onField', config: {} } });
  for (const t of (ctx.watchlist ?? []).slice(0, 5)) {
    const n = ctx.teams.find((x) => x.number === t)?.nickname;
    out.push({
      key: `team:${t}`,
      kind: 'team',
      title: n ? `${t} · ${n}` : String(t),
      subtitle: 'On your watchlist',
      score: 0.8,
      group: 'team',
      widget: { kind: 'team', config: { team: t, variant: 'detailed' } },
    });
  }
  out.push({
    key: 'rankings:bsr:desc:5',
    kind: 'rankings',
    title: 'Top 5 · BSR',
    score: 0.7,
    group: 'rankings',
    widget: { kind: 'rankings', config: { metric: 'bsr', count: 5, dir: 'desc' } },
  });
  return out;
}

/** Remember a pick so the same query ranks it higher next time. */
export function recordPick(
  learned: Record<string, Record<string, number>>,
  query: string,
  key: string,
): Record<string, Record<string, number>> {
  const norm = normalizeQuery(query);
  if (!norm) return learned;
  const next = { ...learned, [norm]: { ...(learned[norm] ?? {}), [key]: (learned[norm]?.[key] ?? 0) + 1 } };
  const keys = Object.keys(next);
  if (keys.length > 300) delete next[keys[0]];
  return next;
}
