// Pure-side tests for the Strategy-tab Discord post: board content gating and
// the embed builder (no canvas, no network).
import { describe, it, expect } from 'vitest';
import {
  boardHasContent,
  buildStrategyMessage,
  resolveTeamNote,
} from '@/dash/strategy/discordPost';
import { EMPTY_DOC, type CanvasDoc, type Stroke } from '@/dash/strategy/strokes';
import { teamNoteKeyFor, keyFor } from '@/dash/matchupNotesClient';
import type { MatchPrediction, TeamPrediction } from '@/dash/predict';
import type { TeamAgg } from '@/dash/aggregate';

const stroke: Stroke = { id: 's1', seq: 1, color: '#fff', size: 0.01, points: [[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]] };

function tp(teamNumber: number, expected: number, source: TeamPrediction['source'] = 'epa'): TeamPrediction {
  return { teamNumber, expected, w: 1, source };
}

const pred: MatchPrediction = {
  red: { teams: [tp(1, 40), tp(2, 30), tp(3256, 50)], score: 120 },
  blue: { teams: [tp(4, 35), tp(5, 25), tp(6, 20, 'none')], score: 80 },
  redWinProb: 0.82,
  confidence: 0.9,
};

function agg(matchesScouted: number, scoutingExpectedPoints: number): TeamAgg {
  return { matchesScouted, scoutingExpectedPoints } as unknown as TeamAgg;
}

const base = {
  eventKey: '2026casj',
  matchLabel: 'Qual 12',
  matchTime: '10:30 AM',
  redTeams: [1, 2, 3256],
  blueTeams: [4, 5, 6],
  baseTeam: 3256,
  ourSide: 'red' as const,
  pred,
  agg: new Map<number, TeamAgg>([[3256, agg(5, 48)], [4, agg(2, 30)]]),
  reportsByTeam: new Map(),
  postedPhases: ['auto', 'endgame'] as const,
  imageName: 'qm12-whiteboard.png',
};

describe('boardHasContent', () => {
  it('counts ink or placed robots on any phase', () => {
    expect(boardHasContent(EMPTY_DOC, 'auto')).toBe(false);
    expect(boardHasContent({ ...EMPTY_DOC, strokes: [stroke] }, 'active')).toBe(true);
    const robots: CanvasDoc = { ...EMPTY_DOC, robots: [{ key: '3256', team: 3256, x: 0.2, y: 0.5, movedAt: 1 }] };
    expect(boardHasContent(robots, 'auto')).toBe(true);
    expect(boardHasContent(robots, 'endgame')).toBe(true);
    expect(boardHasContent(null, 'auto')).toBe(false);
  });
});

describe('buildStrategyMessage', () => {
  it('builds one embed with prediction, both alliances, and the attached image', () => {
    const msg = buildStrategyMessage({ ...base, postedPhases: [...base.postedPhases] });
    const embed = (msg.embeds as Record<string, unknown>[])[0];
    expect(msg.content).toContain('Qual 12');
    expect(embed.title).toBe('Qual 12 · 10:30 AM — Red 1, 2, 3256 vs Blue 4, 5, 6');
    expect(embed.description).toBe('Whiteboard: Auto · Endgame');
    expect(embed.image).toEqual({ url: 'attachment://qm12-whiteboard.png' });
    expect(embed.color).toBe(0xef4444);
    const fields = embed.fields as { name: string; value: string }[];
    expect(fields[0].value).toBe('Red **120** – **80** Blue · Red 82% to win');
    expect(fields[1].name).toBe('Red alliance · US');
    expect(fields[1].value).toContain('**3256** (us) · exp 50 (epa) · scouted 48 · n=5');
    expect(fields[2].name).toBe('Blue alliance');
    expect(fields[2].value).toContain('**6** · exp — · not scouted');
    expect(fields.map((f) => f.name)).not.toContain('Red flags');
    expect(fields.map((f) => f.name)).not.toContain('Matchup notes');
    expect(msg.allowed_mentions).toEqual({ parse: [] });
  });

  it('omits the image and says so when no board has content', () => {
    const msg = buildStrategyMessage({ ...base, postedPhases: [], imageName: null });
    const embed = (msg.embeds as Record<string, unknown>[])[0];
    expect(embed.image).toBeUndefined();
    expect(embed.description).toBe('Whiteboard: no drawings yet');
  });

  it('reports an unavailable prediction instead of a 0-0 toss-up', () => {
    const none: MatchPrediction = {
      red: { teams: [tp(1, NaN, 'none')], score: NaN },
      blue: { teams: [tp(4, NaN, 'none')], score: NaN },
      redWinProb: 0.5,
      confidence: 0,
    };
    const msg = buildStrategyMessage({ ...base, pred: none, postedPhases: [] });
    const fields = (msg.embeds as { fields: { value: string }[] }[])[0].fields;
    expect(fields[0].value).toMatch(/Prediction unavailable/);
  });

  it('includes matchup notes and season EPA-drop flags for the other teams only', () => {
    const notes = new Map<string, string>([
      [teamNoteKeyFor('2026casj', 4), 'plays hard defense on the scorer'],
      [teamNoteKeyFor('2026casj', 3256), 'ignored — that is us'],
    ]);
    const epaFlagsByTeam = new Map([
      [2, { severity: 'high' as const, kind: 'epa-drop' as const, text: 'EPA down 20%' }],
      [3256, { severity: 'high' as const, kind: 'epa-drop' as const, text: 'never shown' }],
    ]);
    const msg = buildStrategyMessage({ ...base, notes, epaFlagsByTeam, postedPhases: [] });
    const fields = (msg.embeds as { fields: { name: string; value: string }[] }[])[0].fields;
    const flags = fields.find((f) => f.name === 'Red flags');
    expect(flags?.value).toBe('**2** (partner): HIGH: EPA down 20%');
    const noteField = fields.find((f) => f.name === 'Matchup notes');
    expect(noteField?.value).toBe('**4**: plays hard defense on the scorer');
  });
});

describe('resolveTeamNote', () => {
  it('prefers the per-team note and falls back to the legacy pair note on the opp lead', () => {
    const legacy = keyFor('e', 1, 4); // alliance leads = min of each side
    const notes = new Map([[legacy, 'legacy note']]);
    expect(resolveTeamNote(notes, 'e', 4, [1, 2, 3256], [4, 5, 6])).toBe('legacy note');
    expect(resolveTeamNote(notes, 'e', 5, [1, 2, 3256], [4, 5, 6])).toBe('');
    notes.set(teamNoteKeyFor('e', 4), 'current');
    expect(resolveTeamNote(notes, 'e', 4, [1, 2, 3256], [4, 5, 6])).toBe('current');
    expect(resolveTeamNote(null, 'e', 4, [], [])).toBe('');
  });
});
