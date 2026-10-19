// src/dash/board/search/lexicon.ts
// The vocabulary that lets many phrasings mean the same thing. Every table
// maps a surface word to a canonical meaning; multi-word phrases are folded
// to one token before tokenizing. Plan: docs/plans/ryans-board/README.md §11.2.
import type { MetricKey } from '@/dash/board/widgets/data';

export type Intent =
  | 'notes' | 'video' | 'pit' | 'photo' | 'reports' | 'autopath' | 'stats' | 'data'
  | 'schedule'
  | 'last'
  | 'next'
  | 'compare'
  | 'best'
  | 'worst'
  | 'history'
  | 'onField'
  | 'picklist'
  | 'watch'
  | 'watchlist'
  | 'self'
  | 'top';

/** Multi-word phrases folded to a single canonical token (applied in order). */
export const PHRASES: [RegExp, string][] = [
  [/\b(?:auto|autonomous)\s+(?:paths?|routines?)\b/g, 'autopath'],
  [/\b(?:robot|pit)\s+photos?\b/g, 'photo'],
  [/\ball\s+(?:team\s+)?stats\b/g, 'stats'],
  [/\bapp\s+data\b/g, 'data'],
  [/\bpick\s*lists?\b/g, 'picklist'],
  [/\balliance\s+selection\b/g, 'picklist'],
  [/\bwatch\s*list\b/g, 'watchlist'],
  [/\bon\s+(?:the\s+)?field\b/g, 'onfield'],
  [/\b(?:playing|happening)\s+now\b/g, 'now'],
  [/\bright\s+now\b/g, 'now'],
  [/\bwhat'?s\s+(?:playing|on)\b/g, 'now'],
  [/\bend\s+game\b/g, 'endgame'],
  [/\bclimb\s+rate\b/g, 'endgame'],
  [/\bwin\s+rate\b/g, 'winrate'],
  [/\bwin\s+percentage\b/g, 'winrate'],
  [/\bover\s+time\b/g, 'history'],
  [/\bcoming\s+up\b/g, 'next'],
  [/\bjust\s+played\b/g, 'last'],
  [/\bplays\s+next\b/g, 'next'],
  [/\bscouted\s+points?\b/g, 'scouted'],
  [/\bauto(?:nomous)?\s+points?\b/g, 'auto'],
  [/\bteleop\s+points?\b/g, 'teleop'],
  [/\bsemi\s+finals?\b/g, 'semifinal'],
  [/\bqualification\s+match\b/g, 'qual'],
];

export const INTENT_WORDS: Record<string, Intent> = {
  notes: 'notes', note: 'notes', comments: 'notes', observations: 'notes',
  video: 'video', videos: 'video', replay: 'video', footage: 'video', vod: 'video',
  pit: 'pit', questionnaire: 'pit', photo: 'photo', photos: 'photo', picture: 'photo', pictures: 'photo',
  reports: 'reports', report: 'reports', autopath: 'autopath', stats: 'stats', statistics: 'stats', data: 'data',
  matches: 'schedule',
  games: 'schedule',
  schedule: 'schedule',
  schedules: 'schedule',
  plays: 'schedule',
  play: 'schedule',
  last: 'last',
  recent: 'last',
  latest: 'last',
  previous: 'last',
  prev: 'last',
  next: 'next',
  upcoming: 'next',
  when: 'next',
  vs: 'compare',
  v: 'compare',
  versus: 'compare',
  against: 'compare',
  compare: 'compare',
  comp: 'compare',
  top: 'top',
  best: 'best',
  highest: 'best',
  most: 'best',
  leaders: 'best',
  leader: 'best',
  who: 'best',
  strongest: 'best',
  greatest: 'best',
  good: 'best',
  worst: 'worst',
  lowest: 'worst',
  least: 'worst',
  weakest: 'worst',
  history: 'history',
  trend: 'history',
  trends: 'history',
  graph: 'history',
  chart: 'history',
  progression: 'history',
  now: 'onField',
  live: 'onField',
  onfield: 'onField',
  field: 'onField',
  current: 'onField',
  playing: 'onField',
  picklist: 'picklist',
  picks: 'picklist',
  watch: 'watch',
  star: 'watch',
  track: 'watch',
  follow: 'watch',
  watchlist: 'watchlist',
  our: 'self',
  us: 'self',
  we: 'self',
  ours: 'self',

  my: 'self',
};

export const METRIC_WORDS: Record<string, MetricKey> = {
  bsr: 'bsr',
  epa: 'bsr',
  rating: 'bsr',
  ratings: 'bsr',
  strength: 'bsr',
  power: 'bsr',
  opr: 'bsr',
  overall: 'bsr',
  auto: 'auto',
  autos: 'auto',
  autonomous: 'auto',
  auton: 'auto',
  teleop: 'teleop',
  tele: 'teleop',
  teleoperated: 'teleop',
  driver: 'teleop',
  driving: 'teleop',
  endgame: 'endgame',
  climb: 'endgame',
  climbs: 'endgame',
  climbing: 'endgame',
  climber: 'endgame',
  climbers: 'endgame',
  hang: 'endgame',
  hangs: 'endgame',
  hanging: 'endgame',
  tower: 'endgame',
  scouted: 'scouted',
  scouting: 'scouted',
  defense: 'defense',
  defence: 'defense',
  defends: 'defense',
  defend: 'defense',
  defender: 'defense',
  defenders: 'defense',
  defensive: 'defense',
  reliable: 'reliability',
  reliability: 'reliability',
  consistent: 'reliability',
  breaks: 'reliability',
  breakdowns: 'reliability',
  dies: 'reliability',
  rank: 'rank',
  ranking: 'rank',
  rankings: 'rank',
  seed: 'rank',
  standings: 'rank',
  standing: 'rank',
  winrate: 'winrate',
  wins: 'winrate',
  record: 'winrate',
};

/** Words that start a match reference: maps to a comp level. */
export const MATCH_PREFIX: Record<string, 'qm' | 'qf' | 'sf' | 'f'> = {
  qm: 'qm',
  q: 'qm',
  qual: 'qm',
  quals: 'qm',
  qualification: 'qm',
  qualifications: 'qm',
  qualifier: 'qm',
  match: 'qm',
  m: 'qm',
  '#': 'qm',
  qf: 'qf',
  quarter: 'qf',
  quarters: 'qf',
  quarterfinal: 'qf',
  sf: 'sf',
  semi: 'sf',
  semis: 'sf',
  semifinal: 'sf',
  semifinals: 'sf',
  f: 'f',
  final: 'f',
  finals: 'f',
};

/** Ignored filler words. */
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'team', 'teams', 'is', 'are', 'does', 'do', 'did', 'what', 'whats',
  'show', 'me', 'how', 'has', 'have', 'had', 'with', 'in', 'at', 'to', 'and', 'robot', 'robots',
  'frc', 'please', 'get', 'find', 'see', 'look', 'up', 'their', 'there', 'they', 'it', 'its', 'on',
  'at', 'by', 'stats', 'stat', 'info', 'about', 'which', 'one', 'ones', 'all', 'list', 'event',
  'points', 'point', 'pts', 'score', 'scores', 'scoring', 'teams', 'did', 'was', 'were', 'be',
]);

/** Words too generic to identify a team by nickname. */
export const NAME_STOPWORDS = new Set([
  'the', 'team', 'robotics', 'robot', 'robots', 'of', 'and', 'inc', 'high', 'school', 'frc', 'club',
  'tech', 'technology', 'engineering', 'academy', 'bots', 'bot', 'a', 'de', 'la', 'el', 'los', 'las',
]);
