import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();

// Reference rpcMock LAZILY (inside a function body) so the hoisted vi.mock factory
// doesn't read it at import time — a direct `rpc: rpcMock` hits the const's TDZ.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  savePitDraft,
  getPitDraft,
  listPitDraftsForEvent,
  listPitQuarantine,
  deletePitQuarantine,
  pitDb,
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
    visionSystem: 'Limelight 3',
    batteryCount: 6,
    chargerCount: 2,
    batteryBrand: 'MK',
    batteryConnector: 'Anderson SB50',
    preferredAutoStartPosition: { x: 0.2, y: 0.5 },
    preferredAutoPath: [
      { x: 0.2, y: 0.5 },
      { x: 0.6, y: 0.5 },
    ],
    matchStrategy: ['score', 'cycle'],
    robotLengthIn: 30,
    robotWidthIn: 28,
    robotHeightIn: 24,
    trenchCapable: true,
    photos: [],
    photoPath: '2026casj/254/a.jpg',
    notes: 'fast',
    scoutId: 'scout-1',
    ...over,
  };
}

describe('pit draft', () => {
  beforeEach(async () => {
    await pitDb.pitDrafts.clear();
    await pitDb.pitQuarantine.clear();
    await pitDb.pitPhotoCleanup.clear();
  });

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

  it('quarantines malformed persisted rows for export/delete recovery', async () => {
    await pitDb.pitDrafts.put({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      updatedAt: '2026-07-10T12:00:00.000Z',
      data: { ...makeReport(), batteryCount: Number.POSITIVE_INFINITY },
    });

    expect(await listPitDraftsForEvent('2026casj')).toEqual([]);
    const quarantined = await listPitQuarantine('2026casj');
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toMatch(/batteryCount/i);
    expect(quarantined[0].raw).toBeTruthy();
    expect(await pitDb.pitDrafts.count()).toBe(0);

    await deletePitQuarantine(quarantined[0].id);
    expect(await pitDb.pitQuarantine.count()).toBe(0);
  });
});

describe('submitPit', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('upserts snake_case row via the revision-guarded upsert_pit_report RPC', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await submitPit(makeReport());
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0];
    expect(fn).toBe('upsert_pit_report');
    const { row_revision, ...rest } = args.p as Record<string, unknown>;
    expect(rest).toEqual({
      event_key: '2026casj',
      team_number: 254,
      drivetrain: 'swerve',
      mechanisms: ['shooter', 'climber'],
      // intake sources are folded into the capabilities jsonb; there is no
      // top-level intake_sources column on pit_scouting_report.
      capabilities: { items: ['auto', 'climb_l3'], intakeSources: ['neutral'] },
      vision_system: 'Limelight 3',
      batteries: { count: 6, chargers: 2, brand: 'MK', connector: 'Anderson SB50' },
      preferred_auto_start_position: { x: 0.2, y: 0.5 },
      preferred_auto_path: [
        { x: 0.2, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
      match_strategy: ['score', 'cycle'],
      robot_dimensions: { lengthIn: 30, widthIn: 28, heightIn: 24, trenchCapable: true },
      photos: [{
        id: 'legacy',
        path: '2026casj/254/a.jpg',
        order: 0,
        mimeType: null,
        width: null,
        height: null,
      }],
      photo_path: '2026casj/254/a.jpg',
      notes: 'fast',
      author_scout_id: 'scout-1',
    });
    // The guard value is a monotonic epoch-ms (the report's edit time).
    expect(typeof row_revision).toBe('number');
  });

  it('throws on upsert error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rls' } });
    await expect(submitPit(makeReport())).rejects.toThrow('rls');
  });
});
