// The spotlight corpus (plan §11.6): many phrasings -> the one obvious result.
// Every phrasing a user tries that misses belongs here.
import { describe, it, expect } from 'vitest';
import { search, normalizeQuery, tokenize, recordPick, type SearchContext } from '../interpret';
import type { MatchRow } from '@/dash/useEventData';

const EK = '2026test';

function match(key: string, red: number[], blue: number[], scores?: [number, number]): MatchRow {
  const level = key.startsWith('qm') ? 'qm' : key.startsWith('sf') ? 'sf' : 'f';
  const num = Number(key.match(/\d+/)![0]);
  return {
    match_key: `${EK}_${key}`,
    event_key: EK,
    comp_level: level,
    match_number: num,
    scheduled_time: null,
    red1: red[0],
    red2: red[1],
    red3: red[2],
    blue1: blue[0],
    blue2: blue[1],
    blue3: blue[2],
    actual_red_score: scores ? scores[0] : null,
    actual_blue_score: scores ? scores[1] : null,
    winner: null,
    result_synced_at: null,
  };
}

const filler = [100, 200, 300, 400, 500, 600, 700, 800];
const matches: MatchRow[] = [];
for (let n = 1; n <= 60; n += 1) {
  const played = n <= 40;
  let red = [filler[n % 8], filler[(n + 1) % 8], filler[(n + 2) % 8]];
  let blue = [filler[(n + 3) % 8], filler[(n + 4) % 8], filler[(n + 5) % 8]];
  if ([5, 13, 36].includes(n)) red = [254, 971, 115];
  if (n === 22) {
    red = [254, 971, 115];
    blue = [1678, 846, 199];
  }
  if (n === 44) blue = [254, 604, 5940];
  if (n === 50) red = [3256, 649, 8033];
  matches.push(match(`qm${n}`, red, blue, played ? [100 + n, 90 + n] : undefined));
}
for (let s = 1; s <= 13; s += 1) matches.push(match(`sf${s}m1`, [1, 2, 3], [4, 5, 6]));
for (let g = 1; g <= 3; g += 1) matches.push(match(`f1m${g}`, [1, 2, 3], [4, 5, 6]));

const ctx: SearchContext = {
  eventKey: EK,
  teams: [
    { number: 254, nickname: 'The Cheesy Poofs' },
    { number: 1678, nickname: 'Citrus Circuits' },
    { number: 3256, nickname: 'WarriorBorgs' },
    { number: 604, nickname: 'Quixilver' },
    { number: 971, nickname: 'Spartan Robotics' },
  ],
  matches,
  baseTeam: 3256,
  watchlist: [1678],
  texts: [{ id: 's:note', text: 'cheesy defends the feed lane' }],
};

function top(q: string): string | undefined {
  return search(q, ctx).results[0]?.key;
}

const CORPUS: [string[], string][] = [
  [['254', 'frc254', 'cheesy', 'poofs', 'the cheesy poofs', 'chesy', 'cheesey', 'poof'], 'team:254'],
  [['citrus', 'citrus circ', 'circuits', 'citrus circuits'], 'team:1678'],
  [['spartan', 'quixilver', 'warriorborgs'], 'team:971|team:604|team:3256'],
  [['qm32', 'q32', 'q 32', 'quals 32', 'qual 32', 'match 32', 'm32', '#32', '32', 'qualification 32'], `match:${EK}_qm32`],
  [['sf2', 'semis 2', 'semifinal 2', 'semi 2', 'sf 2', 'semi finals 2'], `match:${EK}_sf2m1`],
  [['final', 'finals', 'f1'], `match:${EK}_f1m1`],
  [['254 matches', 'cheesy matches', '254 schedule', '254 games', 'poofs schedule', '254 match'], 'schedule:254'],
  [['254 last', '254 last match', 'poofs last match', 'last 254 match', '254 recent', 'cheesy latest'], `match:${EK}_qm36`],
  [['254 next', '254 next match', 'when does 254 play', 'cheesy upcoming', 'poofs coming up'], `match:${EK}_qm44`],
  [['1678 vs 254', '1678 v 254', '1678 254', 'compare 1678 254', 'citrus vs cheesy', '1678 versus 254', '1678 against 254'], 'compare:1678,254'],
  [['best auto', 'top auto', 'highest autonomous', 'who has the best auto', 'auto', 'autonomus'], 'rankings:auto:desc:5'],
  [['top 10 auto'], 'rankings:auto:desc:10'],
  [['best climbers', 'who climbs', 'top climb', 'best hang', 'climb rate'], 'rankings:endgame:desc:5'],
  [['who defends', 'best defense', 'defence'], 'rankings:defense:desc:5'],
  [['worst reliability', 'least reliable'], 'rankings:reliability:asc:5'],
  [['1678 auto', 'citrus autonomous', '1678 auto points'], 'teamMetric:1678:auto'],
  // While typing: the last word prefix-matches stats.
  [['254 reli', '254 relia', '254 reliab', '254 reliabilit', 'cheesy reli'], 'teamMetric:254:reliability'],
  [['254 defe', '254 defen'], 'teamMetric:254:defense'],
  [['254 tele', '254 telep'], 'teamMetric:254:teleop'],
  [['254 endg', '254 clim'], 'teamMetric:254:endgame'],
  [['254 scou'], 'teamMetric:254:scouted'],
  [['1678 epa', '1678 bsr', '1678 history', '1678 trend', 'citrus over time'], 'epaHistory:1678'],
  [['our next', 'our next match', 'next match', 'us next', 'next'], 'match:our-next'],
  [['our matches', 'our schedule', 'us schedule'], 'schedule:3256'],
  [['on field', 'now', 'live', 'whats playing', "what's on", 'on the field'], 'onField'],
  [['picklist', 'pick list', 'alliance selection'], 'picklist'],
  [['rankings', 'standings', 'rank'], 'rankings:rank:asc:5'],
  [['watch 254', 'star 254', 'track cheesy'], 'watch:254'],
  [['watchlist', 'watch list'], 'watchlist'],
  [['254 notes', 'cheesy scouting notes', 'notes on 254'], 'teamNotes:254'],
  [['254 video', 'poofs replay', 'video of 254'], 'matchVideo:254'],
  [['qm32 video', 'qual 32 footage'], `matchVideo:${EK}_qm32`],
  [['254 pit', 'cheesy pit report'], 'pit:254'],
  [['254 photo', '254 robot photos'], 'robotPhoto:254'],
  [['254 auto path'], 'autoPath:254'],
  [['254 reports'], 'reports:254'],
  [['254 stats', 'all stats 254'], 'stats:254'],
  [['app data'], 'data:3256'],
  [['feed lane'], 'board:s:note'],
];

describe('spotlight corpus', () => {
  for (const [queries, expected] of CORPUS) {
    for (const q of queries) {
      it(`"${q}" -> ${expected}`, () => {
        const allowed = expected.split('|');
        expect(allowed).toContain(top(q));
      });
    }
  }
});

describe('spotlight details', () => {
  it('normalizes and tokenizes letter/digit runs', () => {
    expect(tokenize(normalizeQuery('QM32 vs. frc254'))).toEqual(['qm', '32', 'vs', 'frc', '254']);
    expect(tokenize(normalizeQuery('sf2m1'))).toEqual(['sf', '2', 'm', '1']);
    expect(normalizeQuery('Pick List')).toBe('picklist');
  });

  it('a team query offers last, next, schedule and a watchlist action', () => {
    const keys = search('254', ctx).results.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([`match:${EK}_qm36`, `match:${EK}_qm44`, 'schedule:254', 'watch:254']));
  });

  it('compare queries also list the matches the teams met in', () => {
    const keys = search('1678 vs 254', ctx).results.map((r) => r.key);
    expect(keys).toContain(`match:${EK}_qm22`);
  });

  it('learned picks lift a result for the same query', () => {
    const learned = recordPick(recordPick(recordPick({}, 'cheesy', 'schedule:254'), 'cheesy', 'schedule:254'), 'cheesy', 'schedule:254');
    const res = search('cheesy', { ...ctx, learned }).results;
    expect(res[0].key).toBe('schedule:254');
  });

  it('a partial stat word offers the other completions as alternates', () => {
    const keys = search('254 re', ctx).results.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['teamMetric:254:reliability', 'teamMetric:254:winrate']));
  });

  it('gibberish returns nothing instead of a wrong guess', () => {
    expect(search('zzqqx', ctx).results).toEqual([]);
  });
});
