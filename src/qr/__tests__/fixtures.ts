// Shared QR wire-shape fixture (contracts §1a / §4).
//
// The QR hand-off carries the SAME snake_case object `toUpsertPayload` produces
// (the single source of the wire shape). Both sides of the hand-off —
// QrSendScreen (encodes frames) and QrReceiveScreen / ingestClient (decodes +
// POSTs) — assert against THIS fixture so the two sides can never drift back to
// camelCase. If you change the mapper, this fixture changes with it.

import type { FuelBurst } from '@/scoring';
import type { LocalMatchReport } from '@/db/types';
import { toUpsertPayload } from '@/sync/mapReport';

function sampleLocalReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [{ startMs: 0, endMs: 500, rate: 2, window: 'shift1' }];
  return {
    id: 'r1',
    schemaVersion: 1,
    appVersion: 'test',
    deviceId: 'dev1',
    createdAt: new Date('2026-06-23T00:00:00.000Z').toISOString(),
    eventKey: '2026casnv',
    matchKey: 'qm1',
    scoutId: 'scout1',
    targetTeamNumber: 254,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: bursts,
    autoFuel: 0,
    teleopFuelActive: 1,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 1, 0, 0],
    fuelPoints: 1,
    fuelEstimateConfidence: 1,
    climbLevel: 0,
    climbAttempted: false,
    climbSuccess: false,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: false,
    autoClimbLevel1: false,
    intakeSources: [],
    maxFuelCapacityObserved: 0,
    defenseRating: 0,
    pins: 0,
    foulsMinor: 0,
    foulsMajor: 0,
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: false,
    fedCorral: false,
    notes: '',
    syncState: 'dirty',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

/** A backlog of camelCase LocalMatchReports (what getSyncQueue() returns). */
export function sampleLocalReports(): LocalMatchReport[] {
  return [
    sampleLocalReport({ id: 'a1', matchKey: 'qm1', notes: 'x'.repeat(900) }),
    sampleLocalReport({ id: 'a2', matchKey: 'qm2', notes: 'y'.repeat(900) }),
  ];
}

/**
 * The snake_case wire payloads that travel over QR — the exact thing the sender
 * encodes into frames and the receiver POSTs to ingest-reports. Long `notes`
 * keep the encoded base64 over QR_CHUNK_CHARS so reassembly exercises >1 frame.
 */
export function sampleUpsertPayloads(): Record<string, unknown>[] {
  return sampleLocalReports().map(toUpsertPayload);
}
