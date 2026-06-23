import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({ upsert: upsertMock })),
  },
}));

import { supabase } from '@/lib/supabase';
import {
  savePitDraft,
  getPitDraft,
  submitPit,
  type PitReport,
} from '../pitStore';

function makeReport(over: Partial<PitReport> = {}): PitReport {
  return {
    eventKey: '2026casj',
    teamNumber: 254,
    drivetrain: 'swerve',
    mechanisms: ['shooter', 'climber'],
    capabilities: ['auto', 'climb_l3'],
    intakeSources: ['neutral'],
    photoPath: '2026casj/254/a.jpg',
    notes: 'fast',
    scoutId: 'scout-1',
    ...over,
  };
}

describe('pit draft', () => {
  it('saves and reads back a draft by event+team', async () => {
    const r = makeReport();
    await savePitDraft(r.eventKey, r.teamNumber, r);
    const got = await getPitDraft('2026casj', 254);
    expect(got?.draftKey).toBe('2026casj:254');
    expect(got?.data.drivetrain).toBe('swerve');
    expect(got?.updatedAt).toBeTruthy();
  });

  it('returns undefined for a missing draft', async () => {
    const got = await getPitDraft('2026casj', 9999);
    expect(got).toBeUndefined();
  });
});

describe('submitPit', () => {
  beforeEach(() => {
    upsertMock.mockReset();
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('upserts snake_case row into pit_scouting_report', async () => {
    upsertMock.mockResolvedValue({ data: null, error: null });
    await submitPit(makeReport());
    expect(supabase.from).toHaveBeenCalledWith('pit_scouting_report');
    expect(upsertMock).toHaveBeenCalledWith({
      event_key: '2026casj',
      team_number: 254,
      drivetrain: 'swerve',
      mechanisms: ['shooter', 'climber'],
      // intake sources are folded into the capabilities jsonb; there is no
      // top-level intake_sources column on pit_scouting_report.
      capabilities: { items: ['auto', 'climb_l3'], intakeSources: ['neutral'] },
      photo_path: '2026casj/254/a.jpg',
      notes: 'fast',
      author_scout_id: 'scout-1',
    });
  });

  it('throws on upsert error', async () => {
    upsertMock.mockResolvedValue({ data: null, error: { message: 'rls' } });
    await expect(submitPit(makeReport())).rejects.toThrow('rls');
  });
});
