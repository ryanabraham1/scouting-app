import { describe, expect, it } from 'vitest';
import type { MatchRow } from '@/dash/useEventData';
import type { SearchContext } from '@/dash/board/search/interpret';
import { appSearch, appSuggestions, PAGES } from '../appSearch';

function match(n: number, red: number[], blue: number[], played = false): MatchRow {
  return {
    match_key: `2026test_qm${n}`, event_key: '2026test', comp_level: 'qm', match_number: n,
    scheduled_time: null, red1: red[0], red2: red[1], red3: red[2], blue1: blue[0], blue2: blue[1], blue3: blue[2],
    actual_red_score: played ? 100 : null, actual_blue_score: played ? 90 : null,
  } as MatchRow;
}

const ctx: SearchContext = {
  eventKey: '2026test',
  teams: [
    { number: 254, nickname: 'The Cheesy Poofs' },
    { number: 1678, nickname: 'Citrus Circuits' },
    { number: 3256, nickname: 'WarriorBorgs' },
  ],
  matches: [match(1, [254, 1678, 3256], [1, 2, 3], true), match(32, [254, 4, 5], [3256, 6, 7])],
  baseTeam: 3256,
};

describe('appSearch', () => {
  it('sends a team number or nickname to its Analysis profile', () => {
    expect(appSearch('254', ctx)[0].to).toBe('/analysis?tab=team&team=254');
    expect(appSearch('cheesy', ctx)[0].to).toBe('/analysis?tab=team&team=254');
  });
  it('sends a match label to its breakdown', () => {
    expect(appSearch('qm32', ctx)[0].to).toBe('/analysis?tab=match&match=2026test_qm32');
  });
  it('finds pages and sections by keyword, with typos', () => {
    expect(appSearch('base team', ctx)[0].to).toBe('/dashboard?tab=settings#setup-base-team');
    expect(appSearch('do not pick', ctx)[0].to).toBe('/dashboard?tab=picklist#do-not-pick');
    expect(appSearch('assignmnts', ctx)[0].to).toBe('/dashboard?tab=settings#assignments');
    expect(appSearch('impo', null)[0].to).toBe('/dashboard?tab=settings#import-event');
  });
  it('works without event data and suggests our next match first', () => {
    expect(appSearch('draft', null)[0].to).toBe('/dashboard?tab=draft');
    expect(appSuggestions(ctx)[0].to).toBe('/analysis?tab=match&match=2026test_qm32');
  });
  it('gives every page a unique destination', () => {
    expect(new Set(PAGES.map((p) => p.to)).size).toBe(PAGES.length);
  });
});
