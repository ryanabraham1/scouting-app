# Phase 2: Offline Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline-first match-capture engine (timed clock, hold-to-shoot scoring attributed to active/inactive windows, draft autosave/recovery, review screen), pit scouting with photo upload, the field-diagram component, and a durability JSON export — all writing to a local Dexie store.

**Architecture:** A local-first Dexie store (`src/db`) holds reports + capture drafts. A pure, injectable-clock state machine (`src/capture/clock.ts`) drives the AUTO/TELEOP/shift windows. `useCaptureSession` records `FuelBurst`s tagged with the current window, autosaves a draft on every change, and on Save runs the frozen `computeAggregates` to produce a `LocalMatchReport` (syncState `dirty`; Phase 3 syncs it). A reusable `FieldDiagram` (official field PNG + normalized overlay) captures auto start position + path. Pit scouting uploads photos to the private `pit-photos` bucket.

**Tech Stack:** TypeScript (strict), React 18 + Vite, shadcn/ui, Dexie 4 (+ fake-indexeddb for tests), Supabase (Storage), the existing `@/scoring` module, Vitest + Playwright.

## Global Constraints

- **Repo:** `/Users/ryanabraham/Downloads/FRC-scouting-app`, branch `phase-2-capture` (off `main`). Conventional Commits; one commit per task minimum.
- **Offline-first:** match reports are written ONLY to the Dexie local store (`syncState: 'dirty'`). NO Supabase write of match reports in Phase 2 — that is Phase 3. Pit photos DO upload to Storage online (with an offline draft fallback).
- **Scoring is the source of truth:** the capture engine MUST produce its aggregates via the frozen `computeAggregates` from `@/scoring` (do not re-implement the math). Bursts are `FuelBurst { startMs; endMs; rate; window }`; rate-derived fuel is a low-confidence estimate (`fuelEstimateConfidence` low).
- **Clock purity:** `src/capture/clock.ts` pure helpers take an injectable `now` — NO `Date.now()` in pure functions (mirrors the scoring module's discipline) so tests are deterministic.
- **Storage infra (already provisioned):** the private `pit-photos` bucket (5 MB, image/jpeg|png|webp) + `storage.objects` RLS (`pit_photos_insert`/`pit_photos_select` for `authenticated`) exist. The PIT cluster assumes them.
- **Tests:** `npm run test` (vitest + jsdom; Dexie tests `import 'fake-indexeddb/auto'`); `npm run test:e2e` (playwright, chromium installed); `npm run typecheck`; `npm run build`.
- **UI:** shadcn/ui (`@/components/ui`), dark, mobile-first, **≥44px touch targets**; the capture LIVE screen must be usable one-handed.
- **Router wiring is the controller's job** (post-merge): `/scout` → `ScoutHome`, add `/pit`. Cluster agents must NOT edit `src/routes/router.tsx`.

## File Structure

```
src/db/{types,localStore}.ts + __tests__/localStore.test.ts                          (STORE)
src/capture/clock.ts + __tests__/clock.test.ts                                        (CLOCK)
src/components/FieldDiagram.tsx + __tests__/FieldDiagram.test.tsx                      (FIELD)
src/capture/{useCaptureSession.ts,CaptureScreen.tsx,ReviewScreen.tsx,ScoutHome.tsx} + __tests__ (CAPTURE)
src/pit/{photoUpload,pitStore}.ts + PitScoutScreen.tsx + __tests__                     (PIT)
src/export/exportReports.ts + __tests__                                               (EXPORT)
tests/e2e/capture.spec.ts + verification gate                                         (GATE)
```

**Execution order / parallel waves (opus):**
- **Wave 1 (parallel — disjoint foundations):** STORE, CLOCK, FIELD.
- **Wave 2 (parallel — after Wave 1):** CAPTURE (consumes STORE+CLOCK+FIELD+scoring), PIT, EXPORT.
- **Controller:** wire `/scout`→`ScoutHome` + `/pit` after merge.
- **GATE:** offline-capture E2E + verification.

Task IDs are cluster-prefixed (STORE1.., CLOCK1.., FIELD1.., CAPTURE1.., PIT1.., EXPORT1.., GATE1..).

---

<!-- ===== Cluster STORE ===== -->

### Task STORE1

**Files:**
- Create: `/Users/ryanabraham/Downloads/FRC-scouting-app/src/db/types.ts`
- Test: `/Users/ryanabraham/Downloads/FRC-scouting-app/src/db/__tests__/localStore.test.ts`

**Interfaces:**
- Consumes: `FuelBurst { startMs; endMs; rate; window }` from `@/scoring`
- Produces: `export interface LocalMatchReport { id:string; schemaVersion:number; appVersion:string; deviceId:string; createdAt:string; eventKey:string; matchKey:string; scoutId:string; targetTeamNumber:number; allianceColor:'red'|'blue'; station:1|2|3; inactiveFirst:boolean|null; inactiveFirstSource:'derived'|'scout'|'official'|null; teleopClockUnconfirmed:boolean; fuelBursts:FuelBurst[]; autoFuel:number; teleopFuelActive:number; teleopFuelInactive:number; endgameFuel:number; fuelByShift:[number,number,number,number]; fuelPoints:number; climbLevel:0|1|2|3; climbAttempted:boolean; climbSuccess:boolean; autoStartPosition:{x:number;y:number}|null; autoPath:{x:number;y:number}[]|null; autoLeftStartingLine:boolean; autoClimbLevel1:boolean; intakeSources:string[]; maxFuelCapacityObserved:number; defenseRating:0|1|2|3; pins:number; foulsMinor:number; foulsMajor:number; noShow:boolean; died:boolean; tipped:boolean; droppedFuel:boolean; fedCorral:boolean; notes:string; syncState:'dirty'|'pending'|'synced'|'error'; }`
- Produces: `export interface CaptureDraft { draftKey:string; updatedAt:string; state:unknown; }`

- [ ] **Step 1: Ensure fake-indexeddb devDep is installed.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && (node -e "require.resolve('fake-indexeddb/auto')" 2>/dev/null && echo "fake-indexeddb present" || npm i -D fake-indexeddb)
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && node -e "require.resolve('fake-indexeddb/auto'); console.log('ok')"`
Expected output: `ok`
Commit: `git add -A && git commit -m "chore(store): ensure fake-indexeddb devDep"`

- [ ] **Step 2: Write a failing type-import test (RED).**
```ts
// src/db/__tests__/localStore.test.ts
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { LocalMatchReport, CaptureDraft } from '../types';
import type { FuelBurst } from '@/scoring';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [
    { startMs: 0, endMs: 500, rate: 2, window: 'shift1' },
  ];
  return {
    id: 'r1',
    schemaVersion: 1,
    appVersion: 'test',
    deviceId: 'dev1',
    createdAt: new Date('2026-06-23T00:00:00.000Z').toISOString(),
    eventKey: '2026event',
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
    ...overrides,
  };
}

describe('STORE types', () => {
  it('shapes a LocalMatchReport', () => {
    const r = makeReport();
    expect(r.id).toBe('r1');
    expect(r.fuelBursts[0].window).toBe('shift1');
  });

  it('shapes a CaptureDraft', () => {
    const d: CaptureDraft = { draftKey: 'qm1:scout1:254', updatedAt: new Date().toISOString(), state: { a: 1 } };
    expect(d.draftKey).toBe('qm1:scout1:254');
  });
});

export { makeReport };
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: failure resolving `../types` (file does not exist yet).
Commit: `git add -A && git commit -m "test(store): failing type-import test for LocalMatchReport and CaptureDraft"`

- [ ] **Step 3: Create types.ts to make it pass (GREEN).**
```ts
// src/db/types.ts
import type { FuelBurst } from '@/scoring';

export interface LocalMatchReport {
  id: string;
  schemaVersion: number;
  appVersion: string;
  deviceId: string;
  createdAt: string;
  eventKey: string;
  matchKey: string;
  scoutId: string;
  targetTeamNumber: number;
  allianceColor: 'red' | 'blue';
  station: 1 | 2 | 3;
  inactiveFirst: boolean | null;
  inactiveFirstSource: 'derived' | 'scout' | 'official' | null;
  teleopClockUnconfirmed: boolean;
  fuelBursts: FuelBurst[];
  autoFuel: number;
  teleopFuelActive: number;
  teleopFuelInactive: number;
  endgameFuel: number;
  fuelByShift: [number, number, number, number];
  fuelPoints: number;
  climbLevel: 0 | 1 | 2 | 3;
  climbAttempted: boolean;
  climbSuccess: boolean;
  autoStartPosition: { x: number; y: number } | null;
  autoPath: { x: number; y: number }[] | null;
  autoLeftStartingLine: boolean;
  autoClimbLevel1: boolean;
  intakeSources: string[];
  maxFuelCapacityObserved: number;
  defenseRating: 0 | 1 | 2 | 3;
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
  noShow: boolean;
  died: boolean;
  tipped: boolean;
  droppedFuel: boolean;
  fedCorral: boolean;
  notes: string;
  syncState: 'dirty' | 'pending' | 'synced' | 'error';
}

export interface CaptureDraft {
  draftKey: string;
  updatedAt: string;
  state: unknown;
}
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts && npm run typecheck`
Expected output: both `STORE types` tests pass; typecheck reports no errors.
Commit: `git add -A && git commit -m "feat(store): add LocalMatchReport and CaptureDraft types"`

### Task STORE2

**Files:**
- Create: `/Users/ryanabraham/Downloads/FRC-scouting-app/src/db/localStore.ts`
- Test: `/Users/ryanabraham/Downloads/FRC-scouting-app/src/db/__tests__/localStore.test.ts` (Modify)

**Interfaces:**
- Consumes: `LocalMatchReport`, `CaptureDraft` from `./types`; Dexie 4
- Produces: `export class ScoutingDb extends Dexie` with tables `reports` (key `id`) + `drafts` (key `draftKey`); `export const db: ScoutingDb`; `export function saveReport(r:LocalMatchReport):Promise<void>`; `export function listReports():Promise<LocalMatchReport[]>`; `export function getUnsynced():Promise<LocalMatchReport[]>`; `export function countUnsynced():Promise<number>`; `export function markSynced(id:string):Promise<void>`; `export function saveDraft(draftKey:string, state:unknown):Promise<void>`; `export function getDraft(draftKey:string):Promise<CaptureDraft|undefined>`; `export function listDrafts():Promise<CaptureDraft[]>`; `export function deleteDraft(draftKey:string):Promise<void>`

- [ ] **Step 1: Add a failing report-roundtrip test (RED).**
Append to `src/db/__tests__/localStore.test.ts`:
```ts
import { beforeEach } from 'vitest';
import {
  db,
  saveReport,
  listReports,
  getUnsynced,
  countUnsynced,
  markSynced,
} from '../localStore';

describe('STORE reports', () => {
  beforeEach(async () => {
    await db.reports.clear();
    await db.drafts.clear();
  });

  it('saveReport + listReports roundtrip', async () => {
    const r = makeReport({ id: 'rt1' });
    await saveReport(r);
    const all = await listReports();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('rt1');
    expect(all[0].fuelBursts[0].window).toBe('shift1');
  });

  it('saveReport defaults syncState to dirty when unset', async () => {
    const r = makeReport({ id: 'rt2' });
    delete (r as Partial<typeof r>).syncState;
    await saveReport(r as typeof r);
    const got = (await listReports()).find((x) => x.id === 'rt2');
    expect(got?.syncState).toBe('dirty');
  });
});
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: failure resolving `../localStore` (file does not exist yet).
Commit: `git add -A && git commit -m "test(store): failing report roundtrip and syncState-default tests"`

- [ ] **Step 2: Create localStore.ts with the Dexie subclass + report functions (GREEN).**
```ts
// src/db/localStore.ts
import Dexie, { type Table } from 'dexie';
import type { LocalMatchReport, CaptureDraft } from './types';

export class ScoutingDb extends Dexie {
  reports!: Table<LocalMatchReport, string>;
  drafts!: Table<CaptureDraft, string>;

  constructor() {
    super('scouting-db');
    this.version(1).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
    });
  }
}

export const db = new ScoutingDb();

export async function saveReport(r: LocalMatchReport): Promise<void> {
  const record: LocalMatchReport = { ...r, syncState: r.syncState ?? 'dirty' };
  await db.reports.put(record);
}

export async function listReports(): Promise<LocalMatchReport[]> {
  return db.reports.toArray();
}

export async function getUnsynced(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all.filter((r) => r.syncState !== 'synced');
}

export async function countUnsynced(): Promise<number> {
  const unsynced = await getUnsynced();
  return unsynced.length;
}

export async function markSynced(id: string): Promise<void> {
  await db.reports.update(id, { syncState: 'synced' });
}

export async function saveDraft(draftKey: string, state: unknown): Promise<void> {
  const draft: CaptureDraft = { draftKey, updatedAt: new Date().toISOString(), state };
  await db.drafts.put(draft);
}

export async function getDraft(draftKey: string): Promise<CaptureDraft | undefined> {
  return db.drafts.get(draftKey);
}

export async function listDrafts(): Promise<CaptureDraft[]> {
  return db.drafts.toArray();
}

export async function deleteDraft(draftKey: string): Promise<void> {
  await db.drafts.delete(draftKey);
}
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: `STORE reports` tests pass (roundtrip + syncState default).
Commit: `git add -A && git commit -m "feat(store): add ScoutingDb, db singleton, and report functions"`

- [ ] **Step 3: Add failing getUnsynced/countUnsynced/markSynced test (RED).**
Append to `src/db/__tests__/localStore.test.ts`:
```ts
describe('STORE sync state', () => {
  beforeEach(async () => {
    await db.reports.clear();
  });

  it('getUnsynced excludes synced; markSynced flips it', async () => {
    await saveReport(makeReport({ id: 'u1', syncState: 'dirty' }));
    await saveReport(makeReport({ id: 'u2', syncState: 'pending' }));
    await saveReport(makeReport({ id: 's1', syncState: 'synced' }));

    expect(await countUnsynced()).toBe(2);
    const ids = (await getUnsynced()).map((r) => r.id).sort();
    expect(ids).toEqual(['u1', 'u2']);

    await markSynced('u1');
    expect(await countUnsynced()).toBe(1);
    expect((await getUnsynced()).map((r) => r.id)).toEqual(['u2']);
  });
});
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: the new `STORE sync state` block passes (functions already implemented in Step 2).
Commit: `git add -A && git commit -m "test(store): cover getUnsynced, countUnsynced, and markSynced"`

### Task STORE3

**Files:**
- Modify: `/Users/ryanabraham/Downloads/FRC-scouting-app/src/db/__tests__/localStore.test.ts`

**Interfaces:**
- Consumes: `db`, `saveDraft`, `getDraft`, `listDrafts`, `deleteDraft`, `saveReport`, `listReports` from `../localStore`; `ScoutingDb` from `../localStore`

- [ ] **Step 1: Add draft save/get/list/delete test (RED then GREEN).**
Append to `src/db/__tests__/localStore.test.ts`:
```ts
import { saveDraft, getDraft, listDrafts, deleteDraft } from '../localStore';

describe('STORE drafts', () => {
  beforeEach(async () => {
    await db.drafts.clear();
  });

  it('save/get/list/delete a draft by draftKey', async () => {
    const key = 'qm1:scout1:254';
    await saveDraft(key, { bursts: [], step: 'live' });

    const got = await getDraft(key);
    expect(got?.draftKey).toBe(key);
    expect(got?.state).toEqual({ bursts: [], step: 'live' });
    expect(typeof got?.updatedAt).toBe('string');

    await saveDraft('qm2:scout1:148', { bursts: [1], step: 'review' });
    const list = await listDrafts();
    expect(list.map((d) => d.draftKey).sort()).toEqual(['qm1:scout1:254', 'qm2:scout1:148']);

    await deleteDraft(key);
    expect(await getDraft(key)).toBeUndefined();
    expect(await listDrafts()).toHaveLength(1);
  });

  it('saveDraft refreshes updatedAt on re-save', async () => {
    const key = 'qm3:scout1:111';
    await saveDraft(key, { v: 1 });
    const first = (await getDraft(key))!.updatedAt;
    await new Promise((res) => setTimeout(res, 5));
    await saveDraft(key, { v: 2 });
    const second = (await getDraft(key))!.updatedAt;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
    expect((await getDraft(key))!.state).toEqual({ v: 2 });
  });
});
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: `STORE drafts` block passes.
Commit: `git add -A && git commit -m "test(store): cover draft save/get/list/delete and updatedAt refresh"`

- [ ] **Step 2: Add cross-instance persistence test (GREEN).**
Append to `src/db/__tests__/localStore.test.ts`:
```ts
import { ScoutingDb } from '../localStore';

describe('STORE persistence', () => {
  it('reports + drafts persist across a fresh ScoutingDb instance', async () => {
    await db.reports.clear();
    await db.drafts.clear();
    await saveReport(makeReport({ id: 'persist1' }));
    await saveDraft('qm9:scout1:9', { kept: true });
    await db.close();

    const fresh = new ScoutingDb();
    await fresh.open();
    const reports = await fresh.reports.toArray();
    const drafts = await fresh.drafts.toArray();
    expect(reports.map((r) => r.id)).toContain('persist1');
    expect(drafts.map((d) => d.draftKey)).toContain('qm9:scout1:9');
    await fresh.close();

    await db.open();
    expect((await listReports()).map((r) => r.id)).toContain('persist1');
  });
});
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts`
Expected output: all `STORE` blocks pass, including `STORE persistence`.
Commit: `git add -A && git commit -m "test(store): verify cross-instance persistence of reports and drafts"`

- [ ] **Step 3: Full cluster verification.**
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/db/__tests__/localStore.test.ts && npm run typecheck`
Expected output: all STORE tests pass; typecheck reports no errors.
Commit: `git add -A && git commit -m "chore(store): verify localStore tests and typecheck green"`

<!-- ===== Cluster CLOCK ===== -->

### Task CLOCK1

**Files:**
- Create: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Consumes: `import { MatchWindow, SHIFT_BOUNDS } from '@/scoring'`
- Produces: `export type ClockPhase = 'idle'|'auto'|'pause'|'teleop'|'done'`; `export const AUTO_MS = 20000`; `export const TELEOP_MS = 140000`; `export function teleopWindowAt(elapsedMs:number): MatchWindow`

- [ ] **Step 1: Write failing boundary-table test for teleopWindowAt**

```ts
// src/capture/__tests__/clock.test.ts
import { describe, it, expect } from 'vitest';
import { teleopWindowAt, AUTO_MS, TELEOP_MS } from '@/capture/clock';
import type { MatchWindow } from '@/scoring';

describe('teleopWindowAt boundary table', () => {
  const cases: Array<[number, MatchWindow]> = [
    [0, 'transition'],
    [9999, 'transition'],
    [10000, 'shift1'],
    [34999, 'shift1'],
    [35000, 'shift2'],
    [59999, 'shift2'],
    [60000, 'shift3'],
    [84999, 'shift3'],
    [85000, 'shift4'],
    [109999, 'shift4'],
    [110000, 'endgame'],
    [139999, 'endgame'],
    [140000, 'endgame'],
    [999999, 'endgame'],
  ];
  it.each(cases)('elapsed %d -> %s', (elapsed, expected) => {
    expect(teleopWindowAt(elapsed)).toBe(expected);
  });

  it('exposes phase-duration constants', () => {
    expect(AUTO_MS).toBe(20000);
    expect(TELEOP_MS).toBe(140000);
  });
});
```

Run: `npm run test -- clock` → expected: FAIL (cannot resolve `@/capture/clock`).
Commit: `git add -A && git commit -m "test(clock): failing teleopWindowAt boundary table"`

- [ ] **Step 2: Implement constants + teleopWindowAt to pass**

```ts
// src/capture/clock.ts
import type { MatchWindow } from '@/scoring';
import { SHIFT_BOUNDS } from '@/scoring';

export type ClockPhase = 'idle' | 'auto' | 'pause' | 'teleop' | 'done';

export const AUTO_MS = 20000;
export const TELEOP_MS = 140000;

export function teleopWindowAt(elapsedMs: number): MatchWindow {
  if (elapsedMs >= TELEOP_MS) return 'endgame';
  const order: MatchWindow[] = [
    'transition',
    'shift1',
    'shift2',
    'shift3',
    'shift4',
    'endgame',
  ];
  for (const window of order) {
    const [start, end] = SHIFT_BOUNDS[window];
    if (elapsedMs >= start && elapsedMs < end) return window;
  }
  return 'endgame';
}
```

Run: `npm run test -- clock` → expected: PASS (boundary table + constants green).
Commit: `git add -A && git commit -m "feat(clock): teleopWindowAt + phase constants"`

### Task CLOCK2

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Consumes: `import { MatchWindow } from '@/scoring'`; `ClockPhase`, `teleopWindowAt`
- Produces: `export function windowForBurst(phase:ClockPhase, teleopElapsedMs:number): MatchWindow`

- [ ] **Step 1: Add failing windowForBurst test**

```ts
// append to src/capture/__tests__/clock.test.ts
import { windowForBurst } from '@/capture/clock';

describe('windowForBurst', () => {
  it("returns 'auto' when phase is auto", () => {
    expect(windowForBurst('auto', 50000)).toBe('auto');
  });
  it('maps via teleopWindowAt when phase is teleop', () => {
    expect(windowForBurst('teleop', 0)).toBe('transition');
    expect(windowForBurst('teleop', 36000)).toBe('shift2');
    expect(windowForBurst('teleop', 120000)).toBe('endgame');
  });
  it("falls back to 'auto' for idle/pause/done", () => {
    expect(windowForBurst('idle', 36000)).toBe('auto');
    expect(windowForBurst('pause', 36000)).toBe('auto');
    expect(windowForBurst('done', 36000)).toBe('auto');
  });
});
```

Run: `npm run test -- clock` → expected: FAIL (`windowForBurst` is not exported).
Commit: `git add -A && git commit -m "test(clock): failing windowForBurst cases"`

- [ ] **Step 2: Implement windowForBurst**

```ts
// append to src/capture/clock.ts
export function windowForBurst(
  phase: ClockPhase,
  teleopElapsedMs: number,
): MatchWindow {
  if (phase === 'auto') return 'auto';
  if (phase === 'teleop') return teleopWindowAt(teleopElapsedMs);
  return 'auto';
}
```

Run: `npm run test -- clock` → expected: PASS (windowForBurst green).
Commit: `git add -A && git commit -m "feat(clock): windowForBurst phase mapping"`

### Task CLOCK3

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Produces: `export interface MatchClockState { phase:ClockPhase; autoStartedAt:number|null; teleopAnchoredAt:number|null; teleopClockUnconfirmed:boolean; }`; `export function useMatchClock(now?:()=>number)` returning `{ state; autoElapsedMs; teleopElapsedMs; window: MatchWindow; startAuto():void; markGo():void; reAnchor():void; finish():void; reset():void; }`
- Consumes: `import { renderHook, act } from '@testing-library/react'`; `AUTO_MS`, `MatchWindow`

- [ ] **Step 1: Failing test — startAuto enters 'auto' then auto-advances to 'pause' at AUTO_MS**

```ts
// append to src/capture/__tests__/clock.test.ts
import { renderHook, act } from '@testing-library/react';
import { useMatchClock } from '@/capture/clock';

function fakeNow() {
  let t = 0;
  const fn = () => t;
  fn.set = (v: number) => {
    t = v;
  };
  fn.advance = (d: number) => {
    t += d;
  };
  return fn as (() => number) & { set: (v: number) => void; advance: (d: number) => void };
}

describe('useMatchClock auto -> pause', () => {
  it('startAuto sets phase auto, then advances to pause after AUTO_MS', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    expect(result.current.state.phase).toBe('auto');
    expect(result.current.state.autoStartedAt).toBe(1000);
    expect(result.current.window).toBe('auto');

    act(() => {
      now.advance(AUTO_MS);
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.phase).toBe('pause');
  });
});
```

Add at the top of the file (after existing imports):

```ts
import { vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
```

Run: `npm run test -- clock` → expected: FAIL (`useMatchClock` not exported).
Commit: `git add -A && git commit -m "test(clock): failing startAuto auto-advance to pause"`

- [ ] **Step 2: Implement MatchClockState + useMatchClock core (startAuto, tick, finish, reset)**

```ts
// append to src/capture/clock.ts
import { useCallback, useEffect, useRef, useState } from 'react';

export interface MatchClockState {
  phase: ClockPhase;
  autoStartedAt: number | null;
  teleopAnchoredAt: number | null;
  teleopClockUnconfirmed: boolean;
}

const INITIAL_STATE: MatchClockState = {
  phase: 'idle',
  autoStartedAt: null,
  teleopAnchoredAt: null,
  teleopClockUnconfirmed: false,
};

export function useMatchClock(now: () => number = () => Date.now()) {
  const nowRef = useRef(now);
  nowRef.current = now;

  const [state, setState] = useState<MatchClockState>(INITIAL_STATE);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, []);

  const autoElapsedMs =
    state.autoStartedAt === null ? 0 : nowRef.current() - state.autoStartedAt;
  const teleopElapsedMs =
    state.teleopAnchoredAt === null
      ? 0
      : nowRef.current() - state.teleopAnchoredAt;

  useEffect(() => {
    if (state.phase === 'auto' && autoElapsedMs >= AUTO_MS) {
      setState((s) => (s.phase === 'auto' ? { ...s, phase: 'pause' } : s));
    }
  }, [state.phase, autoElapsedMs, tick]);

  const window: MatchWindow = windowForBurst(state.phase, teleopElapsedMs);

  const startAuto = useCallback(() => {
    setState({
      phase: 'auto',
      autoStartedAt: nowRef.current(),
      teleopAnchoredAt: null,
      teleopClockUnconfirmed: false,
    });
  }, []);

  const markGo = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: false,
    }));
  }, []);

  const reAnchor = useCallback(() => {
    setState((s) => {
      const [endgameStart] = SHIFT_BOUNDS.endgame;
      return { ...s, teleopAnchoredAt: nowRef.current() - endgameStart };
    });
  }, []);

  const finish = useCallback(() => {
    setState((s) => ({ ...s, phase: 'done' }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    autoElapsedMs,
    teleopElapsedMs,
    window,
    startAuto,
    markGo,
    reAnchor,
    finish,
    reset,
  };
}
```

Run: `npm run test -- clock` → expected: PASS (auto -> pause green; existing pure-helper tests still pass).
Commit: `git add -A && git commit -m "feat(clock): useMatchClock state machine with injectable now"`

### Task CLOCK4

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Consumes: `useMatchClock`, `markGo`, `state.teleopClockUnconfirmed`

- [ ] **Step 1: Failing test — markGo enters teleop with teleopClockUnconfirmed=false**

```ts
// append to src/capture/__tests__/clock.test.ts
describe('useMatchClock markGo -> teleop', () => {
  it('markGo sets phase teleop, anchors now, unconfirmed=false', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(5000);
      result.current.startAuto();
    });
    act(() => {
      now.set(28000);
      result.current.markGo();
    });

    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopAnchoredAt).toBe(28000);
    expect(result.current.state.teleopClockUnconfirmed).toBe(false);
    expect(result.current.teleopElapsedMs).toBe(0);
    expect(result.current.window).toBe('transition');
  });
});
```

Run: `npm run test -- clock` → expected: PASS (markGo already implemented; this locks behavior). If it fails, fix `markGo`.
Commit: `git add -A && git commit -m "test(clock): markGo teleop unconfirmed=false"`

### Task CLOCK5

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Produces: fallback teleop entry path on `useMatchClock` — `enterTeleopFallback():void` setting `phase:'teleop'`, anchoring `now`, `teleopClockUnconfirmed:true`
- Consumes: `useMatchClock`

- [ ] **Step 1: Failing test — fallback teleop entry sets unconfirmed=true**

```ts
// append to src/capture/__tests__/clock.test.ts
describe('useMatchClock fallback teleop entry', () => {
  it('entering teleop without markGo sets unconfirmed=true', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(5000);
      result.current.startAuto();
    });
    act(() => {
      now.set(30000);
      result.current.enterTeleopFallback();
    });

    expect(result.current.state.phase).toBe('teleop');
    expect(result.current.state.teleopAnchoredAt).toBe(30000);
    expect(result.current.state.teleopClockUnconfirmed).toBe(true);
  });
});
```

Run: `npm run test -- clock` → expected: FAIL (`enterTeleopFallback` is not a function).
Commit: `git add -A && git commit -m "test(clock): failing fallback teleop unconfirmed=true"`

- [ ] **Step 2: Implement enterTeleopFallback and expose it**

```ts
// in src/capture/clock.ts, inside useMatchClock, after markGo:
  const enterTeleopFallback = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'teleop',
      teleopAnchoredAt: nowRef.current(),
      teleopClockUnconfirmed: true,
    }));
  }, []);
```

```ts
// in src/capture/clock.ts, add to the returned object (after markGo):
    enterTeleopFallback,
```

Run: `npm run test -- clock` → expected: PASS (fallback unconfirmed=true green).
Commit: `git add -A && git commit -m "feat(clock): enterTeleopFallback sets teleopClockUnconfirmed=true"`

### Task CLOCK6

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Consumes: `useMatchClock`, `reAnchor`, `SHIFT_BOUNDS.endgame[0] === 110000`

- [ ] **Step 1: Failing test — reAnchor maps current now to endgame window start**

```ts
// append to src/capture/__tests__/clock.test.ts
describe('useMatchClock reAnchor', () => {
  it('reAnchor remaps now to the endgame window (110000ms)', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.set(40000);
      result.current.markGo();
    });
    expect(result.current.window).toBe('shift1');

    act(() => {
      now.set(200000);
      result.current.reAnchor();
    });

    expect(result.current.state.teleopAnchoredAt).toBe(200000 - 110000);
    expect(result.current.teleopElapsedMs).toBe(110000);
    expect(result.current.window).toBe('endgame');
  });
});
```

Run: `npm run test -- clock` → expected: PASS (reAnchor already implemented in CLOCK3; this locks the 0:30 cue behavior). If it fails, fix `reAnchor` to use `SHIFT_BOUNDS.endgame[0]`.
Commit: `git add -A && git commit -m "test(clock): reAnchor maps now to endgame window start"`

### Task CLOCK7

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Consumes: `useMatchClock`, `finish`, `reset`
- Produces: verified `finish():void` -> phase 'done'; `reset():void` -> INITIAL_STATE

- [ ] **Step 1: Failing test — finish and reset transitions**

```ts
// append to src/capture/__tests__/clock.test.ts
describe('useMatchClock finish + reset', () => {
  it('finish -> done; reset -> idle with cleared anchors', () => {
    const now = fakeNow();
    const { result } = renderHook(() => useMatchClock(now));

    act(() => {
      now.set(1000);
      result.current.startAuto();
    });
    act(() => {
      now.set(30000);
      result.current.markGo();
    });
    act(() => {
      result.current.finish();
    });
    expect(result.current.state.phase).toBe('done');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.autoStartedAt).toBeNull();
    expect(result.current.state.teleopAnchoredAt).toBeNull();
    expect(result.current.state.teleopClockUnconfirmed).toBe(false);
    expect(result.current.window).toBe('auto');
  });
});
```

Run: `npm run test -- clock` → expected: PASS (finish/reset already implemented in CLOCK3; this locks behavior).
Commit: `git add -A && git commit -m "test(clock): finish->done and reset->idle"`

### Task CLOCK8

**Files:**
- Modify: `src/capture/clock.ts`
- Test: `src/capture/__tests__/clock.test.ts`

**Interfaces:**
- Verifies: NO `Date.now` usage inside pure helpers (`teleopWindowAt`, `windowForBurst`); typecheck clean

- [ ] **Step 1: Static guard test — pure helpers contain no Date.now**

```ts
// append to src/capture/__tests__/clock.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('purity guard', () => {
  it('teleopWindowAt and windowForBurst do not reference Date.now', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../clock.ts', import.meta.url)),
      'utf8',
    );
    const teleopFn = src.slice(
      src.indexOf('export function teleopWindowAt'),
      src.indexOf('export function windowForBurst'),
    );
    const burstFn = src.slice(
      src.indexOf('export function windowForBurst'),
      src.indexOf('export interface MatchClockState'),
    );
    expect(teleopFn).not.toContain('Date.now');
    expect(burstFn).not.toContain('Date.now');
  });
});
```

Run: `npm run test -- clock` → expected: PASS (pure helpers are Date.now-free).
Commit: `git add -A && git commit -m "test(clock): purity guard for pure helpers"`

- [ ] **Step 2: Typecheck + full suite gate for the CLOCK cluster**

Run: `npm run typecheck && npm run test -- clock` → expected: typecheck exits 0; all clock tests green.
Commit: `git add -A && git commit -m "chore(clock): cluster green — typecheck + tests pass"`

<!-- ===== Cluster FIELD ===== -->

### Task FIELD1

**Files:**
- Test: `src/components/__tests__/FieldDiagram.test.tsx`
- Create: `src/components/FieldDiagram.tsx`

**Interfaces:**
- Produces: `export interface FieldPoint { x:number; y:number }`
- Produces: `export interface FieldDiagramProps { mode:'view'|'pick-start'|'draw-path'; startPosition?:FieldPoint|null; path?:FieldPoint[]|null; onStartChange?:(p:FieldPoint)=>void; onPathChange?:(pts:FieldPoint[])=>void; mirror?:boolean; ['data-testid']?:string }`
- Produces: `export function FieldDiagram(props:FieldDiagramProps): JSX.Element`

- [ ] **Step 1: Write failing test that FieldDiagram renders the field image + default testid**

```tsx
// src/components/__tests__/FieldDiagram.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { FieldDiagram } from '../FieldDiagram';

beforeEach(() => {
  cleanup();
  // Stub getBoundingClientRect so normalization is deterministic (200x100 at origin).
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

describe('FieldDiagram', () => {
  it('renders the field image and default testid', () => {
    const { getByTestId, container } = render(<FieldDiagram mode="view" />);
    expect(getByTestId('field-diagram')).toBeTruthy();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/assets/field/field.png');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails (module does not exist yet)**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: FAIL — `Failed to resolve import "../FieldDiagram"` (or "FieldDiagram is not a function").

- [ ] **Step 3: Create FieldDiagram with image + overlay + default testid to make the test pass**

```tsx
// src/components/FieldDiagram.tsx
import { useRef } from 'react';

export interface FieldPoint {
  x: number;
  y: number;
}

export interface FieldDiagramProps {
  mode: 'view' | 'pick-start' | 'draw-path';
  startPosition?: FieldPoint | null;
  path?: FieldPoint[] | null;
  onStartChange?: (p: FieldPoint) => void;
  onPathChange?: (pts: FieldPoint[]) => void;
  mirror?: boolean;
  ['data-testid']?: string;
}

export function FieldDiagram(props: FieldDiagramProps): JSX.Element {
  const { mode, mirror } = props;
  const testid = props['data-testid'] ?? 'field-diagram';
  const containerRef = useRef<HTMLDivElement>(null);

  const mx = (x: number): number => (mirror ? 1 - x : x);

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      data-mode={mode}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 44,
        minHeight: 44,
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <img
        src="/assets/field/field.png"
        alt="field"
        draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      <svg
        data-testid={`${testid}-svg`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      >
        <g data-mx={mx(0)} />
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: PASS — 1 passed (1).

- [ ] **Step 5: Commit**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/components/FieldDiagram.tsx src/components/__tests__/FieldDiagram.test.tsx && git commit -m "feat(field): scaffold FieldDiagram with field image and svg overlay"
```

Expected output: a commit is created (1 file changed for component, 1 for test).

### Task FIELD2

**Files:**
- Test: `src/components/__tests__/FieldDiagram.test.tsx`
- Modify: `src/components/FieldDiagram.tsx`

**Interfaces:**
- Consumes: `FieldDiagramProps { mode:'pick-start'; onStartChange?:(p:FieldPoint)=>void }`
- Produces: `onStartChange(p:FieldPoint)` with normalized `{x,y}` in `[0,1]` via `getBoundingClientRect`

- [ ] **Step 1: Add failing test — pick-start click emits normalized {x,y} in [0,1]**

```tsx
// append to src/components/__tests__/FieldDiagram.test.tsx
import { fireEvent } from '@testing-library/react';

describe('FieldDiagram pick-start', () => {
  it('emits normalized {x,y} in [0,1] on click', () => {
    const onStartChange = vi.fn();
    const { getByTestId } = render(
      <FieldDiagram mode="pick-start" onStartChange={onStartChange} />
    );
    // rect is 200x100 at origin; click at (50,25) -> {0.25, 0.25}
    fireEvent.pointerDown(getByTestId('field-diagram'), {
      clientX: 50,
      clientY: 25,
    });
    fireEvent.pointerUp(getByTestId('field-diagram'), {
      clientX: 50,
      clientY: 25,
    });
    expect(onStartChange).toHaveBeenCalledTimes(1);
    const p = onStartChange.mock.calls[0][0];
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(1);
    expect(p.x).toBeCloseTo(0.25, 5);
    expect(p.y).toBeCloseTo(0.25, 5);
  });
});
```

- [ ] **Step 2: Run the test and confirm the new case fails**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: FAIL — "emits normalized {x,y} in [0,1] on click" (onStartChange called 0 times).

- [ ] **Step 3: Add normalization helper + pick-start pointer handler**

```tsx
// src/components/FieldDiagram.tsx — replace the existing function body
import { useRef } from 'react';

export interface FieldPoint {
  x: number;
  y: number;
}

export interface FieldDiagramProps {
  mode: 'view' | 'pick-start' | 'draw-path';
  startPosition?: FieldPoint | null;
  path?: FieldPoint[] | null;
  onStartChange?: (p: FieldPoint) => void;
  onPathChange?: (pts: FieldPoint[]) => void;
  mirror?: boolean;
  ['data-testid']?: string;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function FieldDiagram(props: FieldDiagramProps): JSX.Element {
  const { mode, mirror, onStartChange } = props;
  const testid = props['data-testid'] ?? 'field-diagram';
  const containerRef = useRef<HTMLDivElement>(null);

  const mx = (x: number): number => (mirror ? 1 - x : x);

  const toNormalized = (clientX: number, clientY: number): FieldPoint => {
    const el = containerRef.current;
    const rect = el!.getBoundingClientRect();
    const rawX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const rawY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return { x: clamp01(mx(rawX)), y: clamp01(rawY) };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'pick-start' && onStartChange) {
      onStartChange(toNormalized(e.clientX, e.clientY));
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      data-mode={mode}
      onPointerUp={handlePointerUp}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 44,
        minHeight: 44,
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <img
        src="/assets/field/field.png"
        alt="field"
        draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      <svg
        data-testid={`${testid}-svg`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        <g data-mx={mx(0)} />
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm all cases pass**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: PASS — 2 passed (2).

- [ ] **Step 5: Commit**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/components/FieldDiagram.tsx src/components/__tests__/FieldDiagram.test.tsx && git commit -m "feat(field): pick-start emits normalized FieldPoint via bounding rect"
```

Expected output: a commit is created.

### Task FIELD3

**Files:**
- Test: `src/components/__tests__/FieldDiagram.test.tsx`
- Modify: `src/components/FieldDiagram.tsx`

**Interfaces:**
- Consumes: `FieldDiagramProps { mode:'draw-path'; onPathChange?:(pts:FieldPoint[])=>void }`
- Produces: `onPathChange(pts:FieldPoint[])` with `>= 2` normalized points

- [ ] **Step 1: Add failing test — draw-path emits >= 2 normalized points**

```tsx
// append to src/components/__tests__/FieldDiagram.test.tsx
describe('FieldDiagram draw-path', () => {
  it('emits a path with >= 2 points on pointerdown..move..up', () => {
    const onPathChange = vi.fn();
    const { getByTestId } = render(
      <FieldDiagram mode="draw-path" onPathChange={onPathChange} />
    );
    const el = getByTestId('field-diagram');
    fireEvent.pointerDown(el, { clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(onPathChange).toHaveBeenCalled();
    const lastCall =
      onPathChange.mock.calls[onPathChange.mock.calls.length - 1];
    const pts = lastCall[0] as Array<{ x: number; y: number }>;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (const pt of pts) {
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(1);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm the new case fails**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: FAIL — "emits a path with >= 2 points" (onPathChange not called).

- [ ] **Step 3: Add draw-path pointer state + handlers**

```tsx
// src/components/FieldDiagram.tsx — replace the import line and the function body
import { useRef } from 'react';

export interface FieldPoint {
  x: number;
  y: number;
}

export interface FieldDiagramProps {
  mode: 'view' | 'pick-start' | 'draw-path';
  startPosition?: FieldPoint | null;
  path?: FieldPoint[] | null;
  onStartChange?: (p: FieldPoint) => void;
  onPathChange?: (pts: FieldPoint[]) => void;
  mirror?: boolean;
  ['data-testid']?: string;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function FieldDiagram(props: FieldDiagramProps): JSX.Element {
  const { mode, mirror, onStartChange, onPathChange } = props;
  const testid = props['data-testid'] ?? 'field-diagram';
  const containerRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<FieldPoint[] | null>(null);

  const mx = (x: number): number => (mirror ? 1 - x : x);

  const toNormalized = (clientX: number, clientY: number): FieldPoint => {
    const el = containerRef.current;
    const rect = el!.getBoundingClientRect();
    const rawX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const rawY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return { x: clamp01(mx(rawX)), y: clamp01(rawY) };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'draw-path') {
      drawingRef.current = [toNormalized(e.clientX, e.clientY)];
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'draw-path' && drawingRef.current) {
      drawingRef.current.push(toNormalized(e.clientX, e.clientY));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (mode === 'pick-start' && onStartChange) {
      onStartChange(toNormalized(e.clientX, e.clientY));
      return;
    }
    if (mode === 'draw-path' && drawingRef.current) {
      drawingRef.current.push(toNormalized(e.clientX, e.clientY));
      if (onPathChange) onPathChange(drawingRef.current.slice());
      drawingRef.current = null;
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid={testid}
      data-mode={mode}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 44,
        minHeight: 44,
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <img
        src="/assets/field/field.png"
        alt="field"
        draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      <svg
        data-testid={`${testid}-svg`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        <g data-mx={mx(0)} />
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm all cases pass**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: PASS — 3 passed (3).

- [ ] **Step 5: Commit**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/components/FieldDiagram.tsx src/components/__tests__/FieldDiagram.test.tsx && git commit -m "feat(field): draw-path collects pointer trail into normalized FieldPoint[]"
```

Expected output: a commit is created.

### Task FIELD4

**Files:**
- Test: `src/components/__tests__/FieldDiagram.test.tsx`
- Modify: `src/components/FieldDiagram.tsx`

**Interfaces:**
- Consumes: `FieldDiagramProps { mode:'view'; startPosition?:FieldPoint|null; path?:FieldPoint[]|null; mirror?:boolean }`
- Produces: SVG `<circle>` marker at `startPosition` + `<polyline>` through `path` (x mirrored when `mirror`)

- [ ] **Step 1: Add failing test — view renders marker + polyline (and mirror flips x)**

```tsx
// append to src/components/__tests__/FieldDiagram.test.tsx
describe('FieldDiagram view', () => {
  it('renders a marker at startPosition and a polyline through path', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        startPosition={{ x: 0.2, y: 0.4 }}
        path={[
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.5 },
          { x: 0.9, y: 0.3 },
        ]}
      />
    );
    const marker = container.querySelector(
      '[data-testid="field-diagram-marker"]'
    ) as SVGCircleElement | null;
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute('cx')).toBe('0.2');
    expect(marker?.getAttribute('cy')).toBe('0.4');
    const polyline = container.querySelector(
      '[data-testid="field-diagram-polyline"]'
    ) as SVGPolylineElement | null;
    expect(polyline).toBeTruthy();
    expect(polyline?.getAttribute('points')).toBe('0.1,0.1 0.5,0.5 0.9,0.3');
  });

  it('mirrors x for marker and polyline when mirror is set', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        mirror
        startPosition={{ x: 0.2, y: 0.4 }}
        path={[
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.3 },
        ]}
      />
    );
    const marker = container.querySelector(
      '[data-testid="field-diagram-marker"]'
    ) as SVGCircleElement | null;
    expect(marker?.getAttribute('cx')).toBe('0.8');
    const polyline = container.querySelector(
      '[data-testid="field-diagram-polyline"]'
    ) as SVGPolylineElement | null;
    expect(polyline?.getAttribute('points')).toBe('0.9,0.1 0.1,0.3');
  });
});
```

- [ ] **Step 2: Run the test and confirm the new cases fail**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: FAIL — "renders a marker at startPosition and a polyline through path" (marker/polyline not found).

- [ ] **Step 3: Render marker + polyline inside the SVG overlay**

```tsx
// src/components/FieldDiagram.tsx — replace the <svg>...</svg> block
      <svg
        data-testid={`${testid}-svg`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {props.path && props.path.length >= 2 && (
          <polyline
            data-testid={`${testid}-polyline`}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={0.01}
            points={props.path.map((p) => `${mx(p.x)},${p.y}`).join(' ')}
          />
        )}
        {props.startPosition && (
          <circle
            data-testid={`${testid}-marker`}
            cx={mx(props.startPosition.x)}
            cy={props.startPosition.y}
            r={0.02}
            fill="#f97316"
          />
        )}
      </svg>
```

- [ ] **Step 4: Run the full FieldDiagram suite and confirm all cases pass**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- src/components/__tests__/FieldDiagram.test.tsx
```

Expected output: PASS — 5 passed (5).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run typecheck && git add src/components/FieldDiagram.tsx src/components/__tests__/FieldDiagram.test.tsx && git commit -m "feat(field): view mode renders marker + polyline with mirror support"
```

Expected output: typecheck exits 0; a commit is created.

<!-- ===== Cluster CAPTURE ===== -->

### Task CAPTURE1

**Files:**
- Create: `src/capture/useCaptureSession.ts`
- Test: `src/capture/__tests__/useCaptureSession.test.tsx`

**Interfaces:**
- Produces: `export interface CaptureTarget { eventKey:string; matchKey:string; scoutId:string; targetTeamNumber:number; allianceColor:'red'|'blue'; station:1|2|3 }`
- Produces: `export function useCaptureSession(target:CaptureTarget)` returning live capture state.
- Consumes: `@/scoring` (`computeAggregates`, `MatchReportInputs`, `FuelBurst`, `SCHEMA_VERSION`); `@/capture/clock` (`useMatchClock`, `windowForBurst`); `@/db/localStore` (`db.saveDraft`, `db.getDraft`, `db.deleteDraft`, `db.saveReport`); `@/db/types` (`LocalMatchReport`).

- [ ] **Step 1: Write failing test for draftKey + initial state.**
```tsx
// src/capture/__tests__/useCaptureSession.test.tsx
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db } from '@/db/localStore';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('useCaptureSession initial state', () => {
  it('starts with empty bursts and null inactiveFirst', () => {
    const { result } = renderHook(() => useCaptureSession(target));
    expect(result.current.bursts).toEqual([]);
    expect(result.current.inactiveFirst).toBeNull();
    expect(result.current.draftResumed).toBe(false);
  });

  it('sets inactiveFirst and autosaves a draft', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(true));
    expect(result.current.inactiveFirst).toBe(true);
    await waitFor(async () => {
      const d = await db.getDraft('qm1:scout-1:254');
      expect(d).toBeDefined();
    });
  });
});
```
Run: `npm run test -- useCaptureSession` → expect FAIL (module `@/capture/useCaptureSession` not found).
Commit: `git add -A && git commit -m "test(capture): failing initial-state test for useCaptureSession"`

- [ ] **Step 2: Create useCaptureSession with state, draftKey, autosave.**
```tsx
// src/capture/useCaptureSession.ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeAggregates,
  SCHEMA_VERSION,
  type FuelBurst,
  type MatchReportInputs,
} from '@/scoring';
import { useMatchClock, windowForBurst } from '@/capture/clock';
import { db } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

export interface CaptureTarget {
  eventKey: string;
  matchKey: string;
  scoutId: string;
  targetTeamNumber: number;
  allianceColor: 'red' | 'blue';
  station: 1 | 2 | 3;
}

interface DeferredState {
  climbLevel: 0 | 1 | 2 | 3;
  climbAttempted: boolean;
  climbSuccess: boolean;
  intakeSources: string[];
  maxFuelCapacityObserved: number;
  defenseRating: 0 | 1 | 2 | 3;
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
  noShow: boolean;
  died: boolean;
  tipped: boolean;
  droppedFuel: boolean;
  fedCorral: boolean;
  autoStartPosition: { x: number; y: number } | null;
  autoPath: { x: number; y: number }[] | null;
  autoLeftStartingLine: boolean;
  autoClimbLevel1: boolean;
  notes: string;
}

const initialDeferred: DeferredState = {
  climbLevel: 0,
  climbAttempted: false,
  climbSuccess: false,
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
  autoStartPosition: null,
  autoPath: null,
  autoLeftStartingLine: false,
  autoClimbLevel1: false,
  notes: '',
};

export function useCaptureSession(target: CaptureTarget) {
  const clock = useMatchClock();
  const draftKey = useMemo(
    () => `${target.matchKey}:${target.scoutId}:${target.targetTeamNumber}`,
    [target.matchKey, target.scoutId, target.targetTeamNumber],
  );

  const [bursts, setBursts] = useState<FuelBurst[]>([]);
  const [inactiveFirst, setInactiveFirstState] = useState<boolean | null>(null);
  const [rate, setRateState] = useState<number>(1);
  const [deferred, setDeferred] = useState<DeferredState>(initialDeferred);
  const [draftResumed, setDraftResumed] = useState(false);

  const holdStartMsRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);

  // Resume an existing draft on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await db.getDraft(draftKey);
      if (cancelled) {
        return;
      }
      if (d && d.state && typeof d.state === 'object') {
        const s = d.state as {
          bursts?: FuelBurst[];
          inactiveFirst?: boolean | null;
          rate?: number;
          deferred?: DeferredState;
        };
        if (s.bursts) {
          setBursts(s.bursts);
        }
        if (s.inactiveFirst !== undefined) {
          setInactiveFirstState(s.inactiveFirst);
        }
        if (typeof s.rate === 'number') {
          setRateState(s.rate);
        }
        if (s.deferred) {
          setDeferred({ ...initialDeferred, ...s.deferred });
        }
        setDraftResumed(true);
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  const persistDraft = useCallback(
    (next: {
      bursts: FuelBurst[];
      inactiveFirst: boolean | null;
      rate: number;
      deferred: DeferredState;
    }) => {
      void db.saveDraft(draftKey, next);
    },
    [draftKey],
  );

  const setInactiveFirst = useCallback(
    (b: boolean) => {
      setInactiveFirstState(b);
      persistDraft({ bursts, inactiveFirst: b, rate, deferred });
    },
    [bursts, rate, deferred, persistDraft],
  );

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      persistDraft({ bursts, inactiveFirst, rate: r, deferred });
    },
    [bursts, inactiveFirst, deferred, persistDraft],
  );

  const holdStart = useCallback(() => {
    holdStartMsRef.current =
      clock.state.phase === 'teleop' ? clock.teleopElapsedMs : clock.autoElapsedMs;
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);

  const holdEnd = useCallback(() => {
    const start = holdStartMsRef.current;
    if (start === null) {
      return;
    }
    holdStartMsRef.current = null;
    const end =
      clock.state.phase === 'teleop' ? clock.teleopElapsedMs : clock.autoElapsedMs;
    const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
    const burst: FuelBurst = { startMs: start, endMs: Math.max(end, start), rate, window };
    const nextBursts = [...bursts, burst];
    setBursts(nextBursts);
    persistDraft({ bursts: nextBursts, inactiveFirst, rate, deferred });
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs, rate, bursts, inactiveFirst, deferred, persistDraft]);

  const updateDeferred = useCallback(
    <K extends keyof DeferredState>(key: K, value: DeferredState[K]) => {
      setDeferred((prev) => {
        const next = { ...prev, [key]: value };
        persistDraft({ bursts, inactiveFirst, rate, deferred: next });
        return next;
      });
    },
    [bursts, inactiveFirst, rate, persistDraft],
  );

  const save = useCallback(async (): Promise<string> => {
    const inputs: MatchReportInputs = {
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: inactiveFirst === null ? false : inactiveFirst,
      fuelBursts: bursts,
      climbLevel: deferred.climbLevel,
      autoClimbLevel1: deferred.autoClimbLevel1,
    };
    const agg = computeAggregates(inputs);
    const report: LocalMatchReport = {
      id: crypto.randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      appVersion: '2.0.0',
      deviceId: 'device-local',
      createdAt: new Date().toISOString(),
      eventKey: target.eventKey,
      matchKey: target.matchKey,
      scoutId: target.scoutId,
      targetTeamNumber: target.targetTeamNumber,
      allianceColor: target.allianceColor,
      station: target.station,
      inactiveFirst,
      inactiveFirstSource: inactiveFirst === null ? null : 'scout',
      teleopClockUnconfirmed: clock.state.teleopClockUnconfirmed,
      fuelBursts: bursts,
      autoFuel: agg.autoFuel,
      teleopFuelActive: agg.teleopFuelActive,
      teleopFuelInactive: agg.teleopFuelInactive,
      endgameFuel: agg.endgameFuel,
      fuelByShift: agg.fuelByShift,
      fuelPoints: agg.fuelPoints,
      climbLevel: deferred.climbLevel,
      climbAttempted: deferred.climbAttempted,
      climbSuccess: deferred.climbSuccess,
      autoStartPosition: deferred.autoStartPosition,
      autoPath: deferred.autoPath,
      autoLeftStartingLine: deferred.autoLeftStartingLine,
      autoClimbLevel1: deferred.autoClimbLevel1,
      intakeSources: deferred.intakeSources,
      maxFuelCapacityObserved: deferred.maxFuelCapacityObserved,
      defenseRating: deferred.defenseRating,
      pins: deferred.pins,
      foulsMinor: deferred.foulsMinor,
      foulsMajor: deferred.foulsMajor,
      noShow: deferred.noShow,
      died: deferred.died,
      tipped: deferred.tipped,
      droppedFuel: deferred.droppedFuel,
      fedCorral: deferred.fedCorral,
      notes: deferred.notes,
      syncState: 'dirty',
    };
    await db.saveReport(report);
    await db.deleteDraft(draftKey);
    return report.id;
  }, [inactiveFirst, bursts, deferred, clock.state.teleopClockUnconfirmed, target, draftKey]);

  return {
    clock,
    bursts,
    holdStart,
    holdEnd,
    rate,
    setRate,
    inactiveFirst,
    setInactiveFirst,
    climbLevel: deferred.climbLevel,
    setClimbLevel: (v: 0 | 1 | 2 | 3) => updateDeferred('climbLevel', v),
    climbAttempted: deferred.climbAttempted,
    setClimbAttempted: (v: boolean) => updateDeferred('climbAttempted', v),
    climbSuccess: deferred.climbSuccess,
    setClimbSuccess: (v: boolean) => updateDeferred('climbSuccess', v),
    intakeSources: deferred.intakeSources,
    setIntakeSources: (v: string[]) => updateDeferred('intakeSources', v),
    maxFuelCapacityObserved: deferred.maxFuelCapacityObserved,
    setMaxFuelCapacityObserved: (v: number) => updateDeferred('maxFuelCapacityObserved', v),
    defenseRating: deferred.defenseRating,
    setDefenseRating: (v: 0 | 1 | 2 | 3) => updateDeferred('defenseRating', v),
    pins: deferred.pins,
    setPins: (v: number) => updateDeferred('pins', v),
    foulsMinor: deferred.foulsMinor,
    setFoulsMinor: (v: number) => updateDeferred('foulsMinor', v),
    foulsMajor: deferred.foulsMajor,
    setFoulsMajor: (v: number) => updateDeferred('foulsMajor', v),
    noShow: deferred.noShow,
    setNoShow: (v: boolean) => updateDeferred('noShow', v),
    died: deferred.died,
    setDied: (v: boolean) => updateDeferred('died', v),
    tipped: deferred.tipped,
    setTipped: (v: boolean) => updateDeferred('tipped', v),
    droppedFuel: deferred.droppedFuel,
    setDroppedFuel: (v: boolean) => updateDeferred('droppedFuel', v),
    fedCorral: deferred.fedCorral,
    setFedCorral: (v: boolean) => updateDeferred('fedCorral', v),
    autoStartPosition: deferred.autoStartPosition,
    setAutoStartPosition: (v: { x: number; y: number } | null) =>
      updateDeferred('autoStartPosition', v),
    autoPath: deferred.autoPath,
    setAutoPath: (v: { x: number; y: number }[] | null) => updateDeferred('autoPath', v),
    autoLeftStartingLine: deferred.autoLeftStartingLine,
    setAutoLeftStartingLine: (v: boolean) => updateDeferred('autoLeftStartingLine', v),
    autoClimbLevel1: deferred.autoClimbLevel1,
    setAutoClimbLevel1: (v: boolean) => updateDeferred('autoClimbLevel1', v),
    notes: deferred.notes,
    setNotes: (v: string) => updateDeferred('notes', v),
    save,
    draftResumed,
  };
}
```
Run: `npm run test -- useCaptureSession` → expect PASS (2 tests).
Commit: `git add -A && git commit -m "feat(capture): useCaptureSession state, draftKey, autosave"`

- [ ] **Step 3: Add failing test for burst window tagging via fake clock.**
```tsx
// append to src/capture/__tests__/useCaptureSession.test.tsx
import { useMatchClock } from '@/capture/clock';

describe('useCaptureSession burst tagging', () => {
  it('records an auto burst when phase is auto', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));
    expect(result.current.bursts[0].window).toBe('auto');
  });

  it('records a teleop burst tagged by teleop window', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));
    expect(result.current.bursts[0].window).toBe('transition');
  });
});

// silence unused import lint
void useMatchClock;
```
Run: `npm run test -- useCaptureSession` → expect PASS (4 tests).
Commit: `git add -A && git commit -m "test(capture): burst window-tagging coverage"`

- [ ] **Step 4: Add failing test for save() computing aggregates == scoring module.**
```tsx
// append to src/capture/__tests__/useCaptureSession.test.tsx
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';

describe('useCaptureSession.save', () => {
  it('writes a dirty LocalMatchReport with aggregates equal to scoring module', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(false));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));

    let id = '';
    await act(async () => {
      id = await result.current.save();
    });
    expect(id).toBeTruthy();

    const reports = await db.listReports();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.syncState).toBe('dirty');

    const expected = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: result.current.bursts,
      climbLevel: 0,
      autoClimbLevel1: false,
    });
    expect(r.fuelPoints).toBe(expected.fuelPoints);
    expect(r.fuelByShift).toEqual(expected.fuelByShift);
    expect(r.autoFuel).toBe(expected.autoFuel);

    const draft = await db.getDraft('qm1:scout-1:254');
    expect(draft).toBeUndefined();
  });
});
```
Run: `npm run test -- useCaptureSession` → expect PASS (5 tests).
Commit: `git add -A && git commit -m "test(capture): save writes dirty report with scoring aggregates"`

- [ ] **Step 5: Add failing test for draft resume on mount.**
```tsx
// append to src/capture/__tests__/useCaptureSession.test.tsx
describe('useCaptureSession draft resume', () => {
  it('resumes an existing draft on mount', async () => {
    await db.saveDraft('qm1:scout-1:254', {
      bursts: [{ startMs: 0, endMs: 1000, rate: 2, window: 'auto' }],
      inactiveFirst: true,
      rate: 2,
      deferred: { climbLevel: 2 },
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.draftResumed).toBe(true));
    expect(result.current.bursts).toHaveLength(1);
    expect(result.current.inactiveFirst).toBe(true);
    expect(result.current.climbLevel).toBe(2);
  });
});
```
Run: `npm run test -- useCaptureSession` → expect PASS (6 tests).
Commit: `git add -A && git commit -m "test(capture): draft resume on mount"`

### Task CAPTURE2

**Files:**
- Create: `src/capture/CaptureScreen.tsx`
- Test: `src/capture/__tests__/CaptureScreen.test.tsx`

**Interfaces:**
- Produces: `export function CaptureScreen(props:{ target:CaptureTarget; onToReview:()=>void }): JSX.Element` with testids `capture-start`, `capture-hold`, `capture-rate`, `capture-go`, `capture-inactive-yes`, `capture-inactive-no`, `capture-running-fuel`, `capture-to-review`.
- Consumes: `@/capture/useCaptureSession` (`useCaptureSession`, `CaptureTarget`); `@/components/ui` Button.

- [ ] **Step 1: Failing test for START -> GO interstitial -> inactive-first prompt.**
```tsx
// src/capture/__tests__/CaptureScreen.test.tsx
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { db } from '@/db/localStore';
import type { CaptureTarget } from '@/capture/useCaptureSession';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('CaptureScreen', () => {
  it('shows GO and inactive-first prompt after START', async () => {
    render(<CaptureScreen target={target} onToReview={() => {}} />);
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    expect(screen.getByTestId('capture-inactive-yes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('capture-inactive-yes'));
    await waitFor(() => {
      expect(screen.queryByTestId('capture-inactive-yes')).toBeNull();
    });
  });
});
```
Run: `npm run test -- CaptureScreen` → expect FAIL (module not found).
Commit: `git add -A && git commit -m "test(capture): failing CaptureScreen START/GO flow"`

- [ ] **Step 2: Create CaptureScreen.**
```tsx
// src/capture/CaptureScreen.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';

export function CaptureScreen(props: { target: CaptureTarget; onToReview: () => void }) {
  const s = useCaptureSession(props.target);
  const [showGo, setShowGo] = useState(false);

  const fuelCount = s.bursts.length;
  const phase = s.clock.state.phase;

  if (showGo) {
    return (
      <div data-testid="capture-go-interstitial" className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-foreground">
        <p className="text-xl font-semibold">Your HUB inactive first?</p>
        <div className="flex gap-4">
          <Button
            data-testid="capture-inactive-yes"
            className="h-16 min-h-[44px] flex-1 text-lg"
            onClick={() => {
              s.setInactiveFirst(true);
              s.clock.markGo();
              setShowGo(false);
            }}
          >
            Yes
          </Button>
          <Button
            data-testid="capture-inactive-no"
            variant="secondary"
            className="h-16 min-h-[44px] flex-1 text-lg"
            onClick={() => {
              s.setInactiveFirst(false);
              s.clock.markGo();
              setShowGo(false);
            }}
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <div className="flex items-center justify-between">
        <span className="text-sm uppercase tracking-wide text-muted-foreground">
          {phase} · {s.clock.window}
        </span>
        <span className="text-sm">
          {s.inactiveFirst === null ? '—' : s.inactiveFirst ? 'INACTIVE 1st' : 'ACTIVE 1st'}
        </span>
      </div>

      <div data-testid="capture-running-fuel" className="text-center text-5xl font-bold tabular-nums">
        {fuelCount}
      </div>

      {phase === 'idle' && (
        <Button
          data-testid="capture-start"
          className="h-20 min-h-[44px] text-2xl"
          onClick={() => s.clock.startAuto()}
        >
          START
        </Button>
      )}

      {(phase === 'auto' || phase === 'pause') && (
        <Button
          data-testid="capture-go"
          className="h-20 min-h-[44px] text-2xl"
          onClick={() => setShowGo(true)}
        >
          GO (Teleop)
        </Button>
      )}

      <Button
        data-testid="capture-hold"
        className="h-40 min-h-[44px] select-none text-3xl"
        onPointerDown={() => s.holdStart()}
        onPointerUp={() => s.holdEnd()}
        onPointerLeave={() => s.holdEnd()}
      >
        HOLD WHILE SHOOTING
      </Button>

      <div className="flex items-center gap-2">
        <span className="text-sm">Rate</span>
        <input
          data-testid="capture-rate"
          type="range"
          min={1}
          max={5}
          step={1}
          value={s.rate}
          onChange={(e) => s.setRate(Number(e.target.value))}
          className="h-11 flex-1"
        />
        <span className="w-6 text-center tabular-nums">{s.rate}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          className="h-14 min-h-[44px]"
          onClick={() => s.setFoulsMinor(s.foulsMinor + 1)}
        >
          FOUL ({s.foulsMinor})
        </Button>
        <Button
          variant="secondary"
          className="h-14 min-h-[44px]"
          onClick={() => s.setDefenseRating(Math.min(3, s.defenseRating + 1) as 0 | 1 | 2 | 3)}
        >
          DEFENSE ({s.defenseRating})
        </Button>
        <Button
          variant={s.autoLeftStartingLine ? 'default' : 'outline'}
          className="h-14 min-h-[44px]"
          onClick={() => s.setAutoLeftStartingLine(!s.autoLeftStartingLine)}
        >
          LEFT LINE
        </Button>
        <Button
          variant={s.autoClimbLevel1 ? 'default' : 'outline'}
          className="h-14 min-h-[44px]"
          onClick={() => s.setAutoClimbLevel1(!s.autoClimbLevel1)}
        >
          AUTO CLIMB
        </Button>
      </div>

      <Button
        data-testid="capture-to-review"
        variant="secondary"
        className="mt-auto h-16 min-h-[44px] text-xl"
        onClick={props.onToReview}
      >
        To Review
      </Button>
    </div>
  );
}
```
Run: `npm run test -- CaptureScreen` → expect PASS (1 test).
Commit: `git add -A && git commit -m "feat(capture): CaptureScreen LIVE tier"`

- [ ] **Step 3: Failing test for hold-to-shoot wiring (running fuel increments).**
```tsx
// append to src/capture/__tests__/CaptureScreen.test.tsx
describe('CaptureScreen hold-to-shoot', () => {
  it('increments running fuel on a hold burst after GO', async () => {
    render(<CaptureScreen target={target} onToReview={() => {}} />);
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
    const hold = await screen.findByTestId('capture-hold');
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    await waitFor(() => {
      expect(screen.getByTestId('capture-running-fuel').textContent).toBe('1');
    });
  });
});
```
Run: `npm run test -- CaptureScreen` → expect PASS (2 tests).
Commit: `git add -A && git commit -m "test(capture): CaptureScreen hold-to-shoot increments fuel"`

### Task CAPTURE3

**Files:**
- Create: `src/capture/ReviewScreen.tsx`
- Test: `src/capture/__tests__/ReviewScreen.test.tsx`

**Interfaces:**
- Produces: `export function ReviewScreen(props:{ session:ReturnType<typeof useCaptureSession>; onSaved:(id:string)=>void }): JSX.Element` with testids `review-climb`, `review-save`, `review-summary`.
- Consumes: `@/capture/useCaptureSession`; `@/components/FieldDiagram` (`FieldDiagram`, `FieldPoint`); `@/scoring` (`computeAggregates`, `SCHEMA_VERSION`); `@/components/ui` Button.

- [ ] **Step 1: Failing test for ReviewScreen render + SAVE flow.**
```tsx
// src/capture/__tests__/ReviewScreen.test.tsx
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db } from '@/db/localStore';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('ReviewScreen', () => {
  it('renders summary and saves, calling onSaved with an id', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(false));

    const onSaved = vi.fn();
    render(<ReviewScreen session={result.current} onSaved={onSaved} />);

    expect(screen.getByTestId('review-summary')).toBeTruthy();
    expect(screen.getByTestId('review-climb')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(typeof onSaved.mock.calls[0][0]).toBe('string');

    const reports = await db.listReports();
    expect(reports).toHaveLength(1);
  });
});
```
Run: `npm run test -- ReviewScreen` → expect FAIL (module not found).
Commit: `git add -A && git commit -m "test(capture): failing ReviewScreen save flow"`

- [ ] **Step 2: Create ReviewScreen.**
```tsx
// src/capture/ReviewScreen.tsx
import { Button } from '@/components/ui/button';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import type { useCaptureSession } from '@/capture/useCaptureSession';

const CLIMB_LEVELS: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];
const INTAKE = ['neutral', 'depot', 'human_feed'];

export function ReviewScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onSaved: (id: string) => void;
}) {
  const s = props.session;
  const agg = computeAggregates({
    schemaVersion: SCHEMA_VERSION,
    inactiveFirst: s.inactiveFirst === null ? false : s.inactiveFirst,
    fuelBursts: s.bursts,
    climbLevel: s.climbLevel,
    autoClimbLevel1: s.autoClimbLevel1,
  });

  const toggleIntake = (src: string) => {
    const has = s.intakeSources.includes(src);
    s.setIntakeSources(has ? s.intakeSources.filter((x) => x !== src) : [...s.intakeSources, src]);
  };

  const onSave = async () => {
    const id = await s.save();
    props.onSaved(id);
  };

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <h2 className="text-xl font-semibold">Review</h2>

      <section data-testid="review-summary" className="rounded-lg border border-border p-3 text-sm">
        <div className="grid grid-cols-2 gap-1">
          <span>Auto fuel</span><span className="text-right tabular-nums">{agg.autoFuel}</span>
          <span>Teleop active</span><span className="text-right tabular-nums">{agg.teleopFuelActive}</span>
          <span>Teleop inactive</span><span className="text-right tabular-nums">{agg.teleopFuelInactive}</span>
          <span>Endgame fuel</span><span className="text-right tabular-nums">{agg.endgameFuel}</span>
          <span>By shift</span><span className="text-right tabular-nums">{agg.fuelByShift.join(' / ')}</span>
          <span className="font-semibold">Fuel points</span><span className="text-right font-semibold tabular-nums">{agg.fuelPoints}</span>
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Climb level</p>
        <div data-testid="review-climb" className="grid grid-cols-4 gap-2">
          {CLIMB_LEVELS.map((lvl) => (
            <Button
              key={lvl}
              variant={s.climbLevel === lvl ? 'default' : 'outline'}
              className="h-12 min-h-[44px]"
              onClick={() => s.setClimbLevel(lvl)}
            >
              {lvl}
            </Button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button variant={s.climbAttempted ? 'default' : 'outline'} className="h-11 min-h-[44px]" onClick={() => s.setClimbAttempted(!s.climbAttempted)}>Attempted</Button>
          <Button variant={s.climbSuccess ? 'default' : 'outline'} className="h-11 min-h-[44px]" onClick={() => s.setClimbSuccess(!s.climbSuccess)}>Success</Button>
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Intake sources</p>
        <div className="grid grid-cols-3 gap-2">
          {INTAKE.map((src) => (
            <Button key={src} variant={s.intakeSources.includes(src) ? 'default' : 'outline'} className="h-11 min-h-[44px] text-xs" onClick={() => toggleIntake(src)}>
              {src}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-1">Max capacity
          <input type="number" min={0} value={s.maxFuelCapacityObserved} onChange={(e) => s.setMaxFuelCapacityObserved(Number(e.target.value))} className="h-11 rounded border border-border bg-input px-2" />
        </label>
        <label className="flex flex-col gap-1">Defense (0-3)
          <input type="number" min={0} max={3} value={s.defenseRating} onChange={(e) => s.setDefenseRating(Math.max(0, Math.min(3, Number(e.target.value))) as 0|1|2|3)} className="h-11 rounded border border-border bg-input px-2" />
        </label>
        <label className="flex flex-col gap-1">Pins
          <input type="number" min={0} value={s.pins} onChange={(e) => s.setPins(Number(e.target.value))} className="h-11 rounded border border-border bg-input px-2" />
        </label>
        <label className="flex flex-col gap-1">Fouls minor
          <input type="number" min={0} value={s.foulsMinor} onChange={(e) => s.setFoulsMinor(Number(e.target.value))} className="h-11 rounded border border-border bg-input px-2" />
        </label>
        <label className="flex flex-col gap-1">Fouls major
          <input type="number" min={0} value={s.foulsMajor} onChange={(e) => s.setFoulsMajor(Number(e.target.value))} className="h-11 rounded border border-border bg-input px-2" />
        </label>
      </section>

      <section className="grid grid-cols-3 gap-2">
        {([
          ['No show', s.noShow, s.setNoShow],
          ['Died', s.died, s.setDied],
          ['Tipped', s.tipped, s.setTipped],
          ['Dropped', s.droppedFuel, s.setDroppedFuel],
          ['Fed corral', s.fedCorral, s.setFedCorral],
        ] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
          <Button key={label} variant={val ? 'default' : 'outline'} className="h-11 min-h-[44px] text-xs" onClick={() => set(!val)}>
            {label}
          </Button>
        ))}
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Auto start position</p>
        <FieldDiagram
          mode="pick-start"
          startPosition={s.autoStartPosition}
          onStartChange={(p: FieldPoint) => s.setAutoStartPosition(p)}
          data-testid="review-field-start"
        />
      </section>

      <section>
        <p className="mb-2 text-sm font-medium">Auto path</p>
        <FieldDiagram
          mode="draw-path"
          path={s.autoPath}
          onPathChange={(pts: FieldPoint[]) => s.setAutoPath(pts)}
          data-testid="review-field-path"
        />
      </section>

      <label className="flex flex-col gap-1 text-sm">Notes
        <textarea value={s.notes} onChange={(e) => s.setNotes(e.target.value)} className="min-h-[88px] rounded border border-border bg-input p-2" />
      </label>

      <Button data-testid="review-save" className="mt-2 h-16 min-h-[44px] text-xl" onClick={() => void onSave()}>
        SAVE
      </Button>
    </div>
  );
}
```
Run: `npm run test -- ReviewScreen` → expect PASS (1 test).
Commit: `git add -A && git commit -m "feat(capture): ReviewScreen DEFERRED tier + summary + save"`

- [ ] **Step 3: Failing test for climb selection + summary recompute.**
```tsx
// append to src/capture/__tests__/ReviewScreen.test.tsx
describe('ReviewScreen climb', () => {
  it('updates climb level on click and persists into saved report', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(false));
    const onSaved = vi.fn();
    render(<ReviewScreen session={result.current} onSaved={onSaved} />);

    const climb = screen.getByTestId('review-climb');
    fireEvent.click(climb.querySelectorAll('button')[3]); // level 3
    fireEvent.click(screen.getByTestId('review-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const reports = await db.listReports();
    expect(reports[0].climbLevel).toBe(3);
  });
});
```
Run: `npm run test -- ReviewScreen` → expect PASS (2 tests).
Commit: `git add -A && git commit -m "test(capture): ReviewScreen climb selection persists"`

### Task CAPTURE4

**Files:**
- Create: `src/capture/ScoutHome.tsx`
- Test: `src/capture/__tests__/ScoutHome.test.tsx`

**Interfaces:**
- Produces: `export default function ScoutHome(): JSX.Element` with testids `scout-home`, `scout-assignment`, `scout-manual-pick`, `scout-start-capture`.
- Consumes: `@/lib/supabase` (`supabase.from('assignment')`); `@/db/localStore` (`db.listDrafts`, `db.countUnsynced`); `@/capture/CaptureScreen`; `@/capture/ReviewScreen`; `@/capture/useCaptureSession` (`CaptureTarget`); `@/export/exportReports` (`exportUnsyncedToFile`); `@/components/ui` Button/Input/Label.

- [ ] **Step 1: Failing test for assignments list + drafts + unsynced count (mocked supabase).**
```tsx
// src/capture/__tests__/ScoutHome.test.tsx
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => {
  const rows = [
    { match_key: 'qm1', alliance_color: 'red', station: 1, target_team_number: 254, event_key: '2026demo' },
  ];
  return {
    supabase: {
      from: () => ({
        select: () => Promise.resolve({ data: rows, error: null }),
      }),
    },
  };
});

vi.mock('@/lib/useSession', () => ({
  useSession: () => ({ scout: { id: 'scout-1' }, session: {}, role: 'scout', loading: false }),
}));

import ScoutHome from '@/capture/ScoutHome';
import { db } from '@/db/localStore';

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('ScoutHome', () => {
  it('renders assignments and unsynced count', async () => {
    render(<ScoutHome />);
    expect(screen.getByTestId('scout-home')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByTestId('scout-assignment').length).toBe(1);
    });
  });

  it('lists resume drafts from the local store', async () => {
    await db.saveDraft('qm9:scout-1:111', { bursts: [] });
    render(<ScoutHome />);
    await waitFor(() => {
      expect(screen.getByText(/qm9:scout-1:111/)).toBeTruthy();
    });
  });
});
```
Run: `npm run test -- ScoutHome` → expect FAIL (module not found).
Commit: `git add -A && git commit -m "test(capture): failing ScoutHome assignments/drafts"`

- [ ] **Step 2: Create ScoutHome.**
```tsx
// src/capture/ScoutHome.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/useSession';
import { db } from '@/db/localStore';
import type { CaptureDraft } from '@/db/types';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { exportUnsyncedToFile } from '@/export/exportReports';

interface AssignmentRow {
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

function CaptureFlow(props: { target: CaptureTarget; onDone: () => void }) {
  const session = useCaptureSession(props.target);
  const [stage, setStage] = useState<'live' | 'review'>('live');
  if (stage === 'review') {
    return <ReviewScreen session={session} onSaved={() => props.onDone()} />;
  }
  return <CaptureFlowLive target={props.target} onToReview={() => setStage('review')} />;
}

// Note: CaptureScreen owns its own session for the LIVE tier; to share one
// session across LIVE + REVIEW we render a single session via CaptureFlow.
function CaptureFlowLive(props: { target: CaptureTarget; onToReview: () => void }) {
  return <CaptureScreen target={props.target} onToReview={props.onToReview} />;
}

export default function ScoutHome() {
  const { scout } = useSession();
  const scoutId = scout?.id ?? '';
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [unsynced, setUnsynced] = useState(0);
  const [active, setActive] = useState<CaptureTarget | null>(null);

  const [eventKey, setEventKey] = useState('');
  const [matchKey, setMatchKey] = useState('');
  const [alliance, setAlliance] = useState<'red' | 'blue'>('red');
  const [station, setStation] = useState<1 | 2 | 3>(1);
  const [team, setTeam] = useState('');

  const refreshLocal = async () => {
    setDrafts(await db.listDrafts());
    setUnsynced(await db.countUnsynced());
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await supabase.from('assignment').select('*');
      if (!cancelled && res.data) {
        setAssignments(res.data as AssignmentRow[]);
      }
    })();
    void refreshLocal();
    return () => {
      cancelled = true;
    };
  }, [scoutId]);

  if (active) {
    return (
      <CaptureFlow
        target={active}
        onDone={() => {
          setActive(null);
          void refreshLocal();
        }}
      />
    );
  }

  const startFromAssignment = (a: AssignmentRow) => {
    setActive({
      eventKey: a.event_key,
      matchKey: a.match_key,
      scoutId,
      targetTeamNumber: a.target_team_number,
      allianceColor: a.alliance_color,
      station: a.station,
    });
  };

  const startManual = () => {
    setActive({
      eventKey,
      matchKey,
      scoutId,
      targetTeamNumber: Number(team),
      allianceColor: alliance,
      station,
    });
  };

  const onExport = async () => {
    const desc = await exportUnsyncedToFile();
    const a = document.createElement('a');
    a.href = desc.blobUrl;
    a.download = desc.filename;
    a.click();
  };

  return (
    <div data-testid="scout-home" className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Scout</h1>
        <span className="text-sm text-muted-foreground">Unsynced: {unsynced}</span>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Your assignments</h2>
        <ul className="flex flex-col gap-2">
          {assignments.map((a, i) => (
            <li key={`${a.match_key}-${i}`}>
              <Button
                data-testid="scout-assignment"
                variant="outline"
                className="h-14 min-h-[44px] w-full justify-between"
                onClick={() => startFromAssignment(a)}
              >
                <span>{a.match_key} · {a.alliance_color} {a.station}</span>
                <span>#{a.target_team_number}</span>
              </Button>
            </li>
          ))}
          {assignments.length === 0 && <li className="text-sm text-muted-foreground">No assignments.</li>}
        </ul>
      </section>

      <section data-testid="scout-manual-pick" className="rounded-lg border border-border p-3">
        <h2 className="mb-2 text-lg font-semibold">Manual pick</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-event">Event</Label>
            <Input id="mp-event" value={eventKey} onChange={(e) => setEventKey(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-match">Match</Label>
            <Input id="mp-match" value={matchKey} onChange={(e) => setMatchKey(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-alliance">Alliance</Label>
            <select id="mp-alliance" value={alliance} onChange={(e) => setAlliance(e.target.value as 'red' | 'blue')} className="min-h-[44px] rounded border border-border bg-input px-2">
              <option value="red">red</option>
              <option value="blue">blue</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-station">Station</Label>
            <select id="mp-station" value={station} onChange={(e) => setStation(Number(e.target.value) as 1 | 2 | 3)} className="min-h-[44px] rounded border border-border bg-input px-2">
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="mp-team">Target team</Label>
            <Input id="mp-team" type="number" value={team} onChange={(e) => setTeam(e.target.value)} className="min-h-[44px]" />
          </div>
        </div>
        <Button
          data-testid="scout-start-capture"
          className="mt-3 h-14 min-h-[44px] w-full text-lg"
          disabled={!matchKey || !team}
          onClick={startManual}
        >
          Start capture
        </Button>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Resume drafts</h2>
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => (
            <li key={d.draftKey} className="rounded border border-border p-2 text-sm">
              {d.draftKey}
            </li>
          ))}
          {drafts.length === 0 && <li className="text-sm text-muted-foreground">No drafts.</li>}
        </ul>
      </section>

      <Button variant="secondary" className="h-14 min-h-[44px]" onClick={() => void onExport()}>
        Export unsynced
      </Button>
    </div>
  );
}
```
Run: `npm run test -- ScoutHome` → expect PASS (2 tests).
Commit: `git add -A && git commit -m "feat(capture): ScoutHome assignments + manual pick + drafts + export"`

- [ ] **Step 3: Failing test for manual-pick start button disabled until valid.**
```tsx
// append to src/capture/__tests__/ScoutHome.test.tsx
import { fireEvent } from '@testing-library/react';

describe('ScoutHome manual pick', () => {
  it('disables start until match + team provided', async () => {
    render(<ScoutHome />);
    const btn = screen.getByTestId('scout-start-capture') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'qm5' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    expect((screen.getByTestId('scout-start-capture') as HTMLButtonElement).disabled).toBe(false);
  });
});
```
Run: `npm run test -- ScoutHome` → expect PASS (3 tests).
Commit: `git add -A && git commit -m "test(capture): ScoutHome manual-pick validation"`

### Task CAPTURE5

**Files:**
- Modify: `src/capture/ScoutHome.tsx`
- Modify: `src/capture/__tests__/ScoutHome.test.tsx`

**Interfaces:**
- Consumes/Produces: same `ScoutHome` default export; resume-draft list items become clickable to re-open `CaptureTarget` parsed from `draftKey` (`matchKey:scoutId:targetTeamNumber`). No new exported signatures.

- [ ] **Step 1: Failing test for resume-draft click opening capture.**
```tsx
// append to src/capture/__tests__/ScoutHome.test.tsx
describe('ScoutHome resume click', () => {
  it('opens capture from a draft and renders the LIVE start button', async () => {
    await db.saveDraft('qm7:scout-1:222', { bursts: [] });
    render(<ScoutHome />);
    const item = await screen.findByTestId('scout-resume-qm7:scout-1:222');
    fireEvent.click(item);
    await waitFor(() => {
      expect(screen.getByTestId('capture-start')).toBeTruthy();
    });
  });
});
```
Run: `npm run test -- ScoutHome` → expect FAIL (testid `scout-resume-...` not found).
Commit: `git add -A && git commit -m "test(capture): failing ScoutHome resume-draft click"`

- [ ] **Step 2: Make draft items clickable and parse draftKey.**
Replace the resume-drafts `<ul>` block in `src/capture/ScoutHome.tsx`:
```tsx
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => (
            <li key={d.draftKey}>
              <Button
                data-testid={`scout-resume-${d.draftKey}`}
                variant="outline"
                className="h-12 min-h-[44px] w-full justify-start text-sm"
                onClick={() => {
                  const [dMatch, dScout, dTeam] = d.draftKey.split(':');
                  setActive({
                    eventKey,
                    matchKey: dMatch,
                    scoutId: dScout || scoutId,
                    targetTeamNumber: Number(dTeam),
                    allianceColor: alliance,
                    station,
                  });
                }}
              >
                {d.draftKey}
              </Button>
            </li>
          ))}
          {drafts.length === 0 && <li className="text-sm text-muted-foreground">No drafts.</li>}
        </ul>
```
Run: `npm run test -- ScoutHome` → expect PASS (4 tests).
Commit: `git add -A && git commit -m "feat(capture): resume capture from a saved draft"`

### Task CAPTURE6

**Files:**
- Modify: `src/capture/CaptureScreen.tsx`
- Modify: `src/capture/useCaptureSession.ts`
- Modify: `src/capture/ScoutHome.tsx`
- Modify: `src/capture/__tests__/useCaptureSession.test.tsx`

**Interfaces:**
- Produces: `useCaptureSession` adds `reAnchorCue():void` that calls `clock.reAnchor()` (0:30 endgame cue). `CaptureScreen` and `ScoutHome` share ONE session: change `CaptureScreen` to accept `props:{ session:ReturnType<typeof useCaptureSession>; onToReview:()=>void }`; `ScoutHome.CaptureFlow` creates the session and passes it to both `CaptureScreen` and `ReviewScreen`.
- Consumes: `@/capture/clock` (`reAnchor`).

- [ ] **Step 1: Failing test for reAnchorCue exposed by the session.**
```tsx
// append to src/capture/__tests__/useCaptureSession.test.tsx
describe('useCaptureSession reAnchorCue', () => {
  it('exposes reAnchorCue that maps now into the endgame window', () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.reAnchorCue());
    expect(result.current.clock.window).toBe('endgame');
  });
});
```
Run: `npm run test -- useCaptureSession` → expect FAIL (`reAnchorCue` is not a function).
Commit: `git add -A && git commit -m "test(capture): failing reAnchorCue endgame mapping"`

- [ ] **Step 2: Add reAnchorCue to useCaptureSession.**
In `src/capture/useCaptureSession.ts`, add before the return:
```tsx
  const reAnchorCue = useCallback(() => {
    clock.reAnchor();
  }, [clock]);
```
And add to the returned object (next to `save`):
```tsx
    reAnchorCue,
```
Run: `npm run test -- useCaptureSession` → expect PASS (all prior + new).
Commit: `git add -A && git commit -m "feat(capture): reAnchorCue wraps clock.reAnchor for 0:30 cue"`

- [ ] **Step 3: Refactor CaptureScreen to take an injected session (failing first).**
Update `src/capture/__tests__/CaptureScreen.test.tsx` to render with a shared session and a re-anchor control. Replace each `render(<CaptureScreen target={target} onToReview={...} />)` call by wrapping in a host that builds the session:
```tsx
// add near top of CaptureScreen.test.tsx
import { renderHook } from '@testing-library/react';
import { useCaptureSession } from '@/capture/useCaptureSession';

function Host(props: { onToReview?: () => void }) {
  const session = useCaptureSession(target);
  return <CaptureScreen session={session} onToReview={props.onToReview ?? (() => {})} />;
}
```
Replace the two existing `render(<CaptureScreen ... />)` lines with `render(<Host onToReview={() => {}} />)` (and `<Host />`). Also add a re-anchor test:
```tsx
describe('CaptureScreen reAnchor cue', () => {
  it('shows a 0:30 cue button that re-anchors to endgame', async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('capture-start'));
    fireEvent.click(screen.getByTestId('capture-go'));
    fireEvent.click(screen.getByTestId('capture-inactive-no'));
    const cue = await screen.findByTestId('capture-reanchor');
    fireEvent.click(cue);
    await waitFor(() => {
      expect(screen.getByTestId('capture-window').textContent).toContain('endgame');
    });
  });
});
// silence unused import
void renderHook;
```
Run: `npm run test -- CaptureScreen` → expect FAIL (CaptureScreen still takes `target`, no `capture-reanchor`/`capture-window`).
Commit: `git add -A && git commit -m "test(capture): failing CaptureScreen injected-session + reAnchor cue"`

- [ ] **Step 4: Change CaptureScreen signature + add cue + window testid.**
In `src/capture/CaptureScreen.tsx` replace the component signature and session line:
```tsx
export function CaptureScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onToReview: () => void;
}) {
  const s = props.session;
```
Remove the now-unused `useCaptureSession`/`CaptureTarget` import usage by importing only the type:
```tsx
import type { useCaptureSession } from '@/capture/useCaptureSession';
```
Add `data-testid="capture-window"` to the phase/window span:
```tsx
        <span data-testid="capture-window" className="text-sm uppercase tracking-wide text-muted-foreground">
          {phase} · {s.clock.window}
        </span>
```
Add a re-anchor button just above the To Review button:
```tsx
      {phase === 'teleop' && (
        <Button
          data-testid="capture-reanchor"
          variant="outline"
          className="h-14 min-h-[44px]"
          onClick={() => s.reAnchorCue()}
        >
          0:30 Endgame cue
        </Button>
      )}
```
Run: `npm run test -- CaptureScreen` → expect PASS (3 tests).
Commit: `git add -A && git commit -m "feat(capture): CaptureScreen takes injected session + endgame cue"`

- [ ] **Step 5: Wire ScoutHome.CaptureFlow to share one session.**
In `src/capture/ScoutHome.tsx` replace `CaptureFlow` and remove `CaptureFlowLive`:
```tsx
function CaptureFlow(props: { target: CaptureTarget; onDone: () => void }) {
  const session = useCaptureSession(props.target);
  const [stage, setStage] = useState<'live' | 'review'>('live');
  if (stage === 'review') {
    return <ReviewScreen session={session} onSaved={() => props.onDone()} />;
  }
  return <CaptureScreen session={session} onToReview={() => setStage('review')} />;
}
```
Run: `npm run test -- ScoutHome` → expect PASS (4 tests).
Commit: `git add -A && git commit -m "feat(capture): share one capture session across LIVE and REVIEW"`

### Task CAPTURE7

**Files:**
- Modify: (verification only; no file changes)

**Interfaces:**
- Consumes: full CAPTURE cluster (`useCaptureSession`, `CaptureScreen`, `ReviewScreen`, `ScoutHome`).

- [ ] **Step 1: Run the full capture test suite.**
Run: `npm run test -- src/capture` → expect PASS (all CAPTURE test files green, 0 failures).

- [ ] **Step 2: Typecheck the cluster against frozen contracts.**
Run: `npm run typecheck` → expect output with no errors (exit 0).

- [ ] **Step 3: Production build smoke.**
Run: `npm run build` → expect "built in" success, exit 0.

- [ ] **Step 4: Record the green gate.**
Run: `git commit --allow-empty -m "chore(capture): cluster green — test+typecheck+build"`
Expected output: a new empty commit is created.

<!-- ===== Cluster PIT ===== -->

I have everything I need. Now I'll draft the PIT cluster tasks.

### Task PIT1

**Files:**
- Create: `src/pit/photoUpload.ts`
- Test: `src/pit/__tests__/photoUpload.test.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase` (`supabase.storage.from('pit-photos').upload(path, file, {upsert:false})`, `supabase.storage.from('pit-photos').createSignedUrl(path, 3600)`)
- Produces: `export async function uploadPitPhoto(eventKey:string, teamNumber:number, file:Blob):Promise<string>`; `export async function signedPitPhotoUrl(path:string):Promise<string|null>`

- [ ] **Step 1: Write failing test for uploadPitPhoto path + return.**

```ts
// src/pit/__tests__/photoUpload.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadMock = vi.fn();
const createSignedUrlMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: vi.fn(() => ({
        upload: uploadMock,
        createSignedUrl: createSignedUrlMock,
      })),
    },
  },
}));

import { supabase } from '@/lib/supabase';
import { uploadPitPhoto, signedPitPhotoUrl } from '../photoUpload';

describe('uploadPitPhoto', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    createSignedUrlMock.mockReset();
    (supabase.storage.from as unknown as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-1111-1111-111111111111'
    );
  });

  it('uploads to a namespaced .jpg path and returns it', async () => {
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
    const file = new Blob(['abc'], { type: 'image/jpeg' });
    const path = await uploadPitPhoto('2026casj', 254, file);
    expect(supabase.storage.from).toHaveBeenCalledWith('pit-photos');
    expect(uploadMock).toHaveBeenCalledWith(
      '2026casj/254/11111111-1111-1111-1111-111111111111.jpg',
      file,
      { upsert: false }
    );
    expect(path).toBe('2026casj/254/11111111-1111-1111-1111-111111111111.jpg');
  });

  it('throws on upload error', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(
      uploadPitPhoto('2026casj', 254, new Blob(['x']))
    ).rejects.toThrow('boom');
  });
});

describe('signedPitPhotoUrl', () => {
  beforeEach(() => {
    createSignedUrlMock.mockReset();
  });

  it('returns the signed url for a 1h expiry', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://signed/url' },
      error: null,
    });
    const url = await signedPitPhotoUrl('2026casj/254/a.jpg');
    expect(createSignedUrlMock).toHaveBeenCalledWith('2026casj/254/a.jpg', 3600);
    expect(url).toBe('https://signed/url');
  });

  it('returns null on error', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: null,
      error: { message: 'nope' },
    });
    const url = await signedPitPhotoUrl('2026casj/254/a.jpg');
    expect(url).toBeNull();
  });
});
```

Run: `npm run test -- src/pit/__tests__/photoUpload.test.ts`
Expected: FAIL — `Cannot find module '../photoUpload'`.
Commit: `git add -A && git commit -m "test(pit): failing tests for uploadPitPhoto and signedPitPhotoUrl"`

- [ ] **Step 2: Implement photoUpload.ts to pass.**

```ts
// src/pit/photoUpload.ts
import { supabase } from '@/lib/supabase';

const BUCKET = 'pit-photos';

export async function uploadPitPhoto(
  eventKey: string,
  teamNumber: number,
  file: Blob
): Promise<string> {
  const path = eventKey + '/' + teamNumber + '/' + crypto.randomUUID() + '.jpg';
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: false });
  if (error) {
    throw new Error(error.message);
  }
  return path;
}

export async function signedPitPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data) {
    return null;
  }
  return data.signedUrl;
}
```

Run: `npm run test -- src/pit/__tests__/photoUpload.test.ts`
Expected: PASS — 4 passing.
Commit: `git add -A && git commit -m "feat(pit): uploadPitPhoto and signedPitPhotoUrl via pit-photos bucket"`

### Task PIT2

**Files:**
- Create: `src/pit/pitStore.ts`
- Test: `src/pit/__tests__/pitStore.test.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase` (`supabase.from('pit_scouting_report').upsert(row)`); Dexie 4
- Produces: `export interface PitReport { eventKey:string; teamNumber:number; drivetrain:string; mechanisms:string[]; capabilities:string[]; intakeSources:string[]; photoPath:string|null; notes:string; scoutId:string }`; `export interface PitDraft { draftKey:string; eventKey:string; teamNumber:number; updatedAt:string; data:PitReport }`; `export async function savePitDraft(eventKey:string, teamNumber:number, data:PitReport):Promise<void>`; `export async function getPitDraft(eventKey:string, teamNumber:number):Promise<PitDraft|undefined>`; `export async function submitPit(report:PitReport):Promise<void>`

- [ ] **Step 1: Write failing test for pit draft save/get + submitPit upsert mapping.**

```ts
// src/pit/__tests__/pitStore.test.ts
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
      capabilities: ['auto', 'climb_l3'],
      intake_sources: ['neutral'],
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
```

Run: `npm run test -- src/pit/__tests__/pitStore.test.ts`
Expected: FAIL — `Cannot find module '../pitStore'` (install fake-indexeddb if missing: `npm i -D fake-indexeddb`).
Commit: `git add -A && git commit -m "test(pit): failing tests for pit draft store and submitPit"`

- [ ] **Step 2: Implement pitStore.ts to pass.**

```ts
// src/pit/pitStore.ts
import Dexie, { type Table } from 'dexie';
import { supabase } from '@/lib/supabase';

export interface PitReport {
  eventKey: string;
  teamNumber: number;
  drivetrain: string;
  mechanisms: string[];
  capabilities: string[];
  intakeSources: string[];
  photoPath: string | null;
  notes: string;
  scoutId: string;
}

export interface PitDraft {
  draftKey: string;
  eventKey: string;
  teamNumber: number;
  updatedAt: string;
  data: PitReport;
}

class PitDb extends Dexie {
  pitDrafts!: Table<PitDraft, string>;

  constructor() {
    super('pit-scouting-db');
    this.version(1).stores({
      pitDrafts: 'draftKey',
    });
  }
}

export const pitDb = new PitDb();

function pitDraftKey(eventKey: string, teamNumber: number): string {
  return eventKey + ':' + teamNumber;
}

export async function savePitDraft(
  eventKey: string,
  teamNumber: number,
  data: PitReport
): Promise<void> {
  const draft: PitDraft = {
    draftKey: pitDraftKey(eventKey, teamNumber),
    eventKey,
    teamNumber,
    updatedAt: new Date().toISOString(),
    data,
  };
  await pitDb.pitDrafts.put(draft);
}

export async function getPitDraft(
  eventKey: string,
  teamNumber: number
): Promise<PitDraft | undefined> {
  return pitDb.pitDrafts.get(pitDraftKey(eventKey, teamNumber));
}

export async function submitPit(report: PitReport): Promise<void> {
  const { error } = await supabase.from('pit_scouting_report').upsert({
    event_key: report.eventKey,
    team_number: report.teamNumber,
    drivetrain: report.drivetrain,
    mechanisms: report.mechanisms,
    capabilities: report.capabilities,
    intake_sources: report.intakeSources,
    photo_path: report.photoPath,
    notes: report.notes,
    author_scout_id: report.scoutId,
  });
  if (error) {
    throw new Error(error.message);
  }
}
```

Run: `npm run test -- src/pit/__tests__/pitStore.test.ts`
Expected: PASS — 4 passing.
Commit: `git add -A && git commit -m "feat(pit): offline pit draft store and submitPit upsert"`

### Task PIT3

**Files:**
- Create: `src/pit/PitScoutScreen.tsx`
- Test: `src/pit/__tests__/PitScoutScreen.test.tsx`

**Interfaces:**
- Consumes: `savePitDraft`, `getPitDraft`, `submitPit`, `PitReport` from `./pitStore`; `uploadPitPhoto`, `signedPitPhotoUrl` from `./photoUpload`; `Button` from `@/components/ui/button`; `Input` from `@/components/ui/input`; `Label` from `@/components/ui/label`
- Produces: `export default function PitScoutScreen(props:{ eventKey:string; teamNumber:number; scoutId:string }):JSX.Element`

- [ ] **Step 1: Write failing test for render + drivetrain + submit wiring.**

```tsx
// src/pit/__tests__/PitScoutScreen.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const savePitDraft = vi.fn().mockResolvedValue(undefined);
const getPitDraft = vi.fn().mockResolvedValue(undefined);
const submitPit = vi.fn().mockResolvedValue(undefined);
const uploadPitPhoto = vi.fn().mockResolvedValue('2026casj/254/a.jpg');
const signedPitPhotoUrl = vi.fn().mockResolvedValue('https://signed/a.jpg');

vi.mock('../pitStore', () => ({
  savePitDraft: (...a: unknown[]) => savePitDraft(...a),
  getPitDraft: (...a: unknown[]) => getPitDraft(...a),
  submitPit: (...a: unknown[]) => submitPit(...a),
}));
vi.mock('../photoUpload', () => ({
  uploadPitPhoto: (...a: unknown[]) => uploadPitPhoto(...a),
  signedPitPhotoUrl: (...a: unknown[]) => signedPitPhotoUrl(...a),
}));

import PitScoutScreen from '../PitScoutScreen';

const props = { eventKey: '2026casj', teamNumber: 254, scoutId: 'scout-1' };

describe('PitScoutScreen', () => {
  beforeEach(() => {
    savePitDraft.mockClear();
    getPitDraft.mockClear().mockResolvedValue(undefined);
    submitPit.mockClear().mockResolvedValue(undefined);
    uploadPitPhoto.mockClear().mockResolvedValue('2026casj/254/a.jpg');
    signedPitPhotoUrl.mockClear().mockResolvedValue('https://signed/a.jpg');
  });

  it('renders the pit form', () => {
    render(<PitScoutScreen {...props} />);
    expect(screen.getByTestId('pit-screen')).toBeInTheDocument();
    expect(screen.getByTestId('pit-drivetrain')).toBeInTheDocument();
    expect(screen.getByTestId('pit-submit')).toBeInTheDocument();
  });

  it('resumes a draft on mount', async () => {
    getPitDraft.mockResolvedValue({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      updatedAt: 'now',
      data: {
        eventKey: '2026casj',
        teamNumber: 254,
        drivetrain: 'tank',
        mechanisms: [],
        capabilities: [],
        intakeSources: [],
        photoPath: null,
        notes: 'resumed',
        scoutId: 'scout-1',
      },
    });
    render(<PitScoutScreen {...props} />);
    await waitFor(() =>
      expect((screen.getByTestId('pit-drivetrain') as HTMLSelectElement).value).toBe('tank')
    );
    expect(screen.getByLabelText(/notes/i)).toHaveValue('resumed');
  });

  it('submits the report and shows a saved indicator', async () => {
    render(<PitScoutScreen {...props} />);
    fireEvent.change(screen.getByTestId('pit-drivetrain'), {
      target: { value: 'swerve' },
    });
    fireEvent.click(screen.getByTestId('pit-submit'));
    await waitFor(() => expect(submitPit).toHaveBeenCalledTimes(1));
    expect(submitPit.mock.calls[0][0]).toMatchObject({
      eventKey: '2026casj',
      teamNumber: 254,
      drivetrain: 'swerve',
      scoutId: 'scout-1',
    });
    expect(await screen.findByTestId('pit-saved')).toBeInTheDocument();
  });

  it('shows an error indicator when submit fails', async () => {
    submitPit.mockRejectedValue(new Error('rls'));
    render(<PitScoutScreen {...props} />);
    fireEvent.click(screen.getByTestId('pit-submit'));
    expect(await screen.findByTestId('pit-error')).toBeInTheDocument();
  });

  it('uploads a photo and shows a preview', async () => {
    render(<PitScoutScreen {...props} />);
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('pit-photo'), {
      target: { files: [file] },
    });
    await waitFor(() => expect(uploadPitPhoto).toHaveBeenCalledTimes(1));
    expect(await screen.findByAltText(/pit photo/i)).toHaveAttribute(
      'src',
      'https://signed/a.jpg'
    );
  });
});
```

Run: `npm run test -- src/pit/__tests__/PitScoutScreen.test.tsx`
Expected: FAIL — `Cannot find module '../PitScoutScreen'`.
Commit: `git add -A && git commit -m "test(pit): failing tests for PitScoutScreen form, photo, submit"`

- [ ] **Step 2: Implement PitScoutScreen.tsx skeleton + state + draft resume.**

```tsx
// src/pit/PitScoutScreen.tsx
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  savePitDraft,
  getPitDraft,
  submitPit,
  type PitReport,
} from './pitStore';
import { uploadPitPhoto, signedPitPhotoUrl } from './photoUpload';

export interface PitScoutScreenProps {
  eventKey: string;
  teamNumber: number;
  scoutId: string;
}

const DRIVETRAINS = ['', 'swerve', 'tank', 'mecanum', 'west_coast', 'other'];
const CAPABILITY_OPTIONS = ['auto', 'climb_l1', 'climb_l2', 'climb_l3', 'defense'];
const INTAKE_OPTIONS = ['neutral', 'depot', 'human_feed'];

function emptyReport(p: PitScoutScreenProps): PitReport {
  return {
    eventKey: p.eventKey,
    teamNumber: p.teamNumber,
    drivetrain: '',
    mechanisms: [],
    capabilities: [],
    intakeSources: [],
    photoPath: null,
    notes: '',
    scoutId: p.scoutId,
  };
}

export default function PitScoutScreen(props: PitScoutScreenProps): JSX.Element {
  const [report, setReport] = React.useState<PitReport>(() => emptyReport(props));
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [uploading, setUploading] = React.useState(false);
  const resumedRef = React.useRef(false);

  React.useEffect(() => {
    let active = true;
    void getPitDraft(props.eventKey, props.teamNumber).then((draft) => {
      if (active && draft) {
        resumedRef.current = true;
        setReport(draft.data);
        if (draft.data.photoPath) {
          void signedPitPhotoUrl(draft.data.photoPath).then((url) => {
            if (active) setPreviewUrl(url);
          });
        }
      }
    });
    return () => {
      active = false;
    };
  }, [props.eventKey, props.teamNumber]);

  return <div data-testid="pit-screen" />;
}
```

Run: `npm run test -- src/pit/__tests__/PitScoutScreen.test.tsx`
Expected: FAIL — render test passes for `pit-screen` but `pit-drivetrain` not found (form not built yet).
Commit: `git add -A && git commit -m "feat(pit): PitScoutScreen state and draft resume scaffold"`

- [ ] **Step 3: Build the form body (drivetrain/mechanisms/capabilities/intake/notes) with autosave.**

```tsx
// src/pit/PitScoutScreen.tsx  — replace the `return <div data-testid="pit-screen" />;` line
  function update(patch: Partial<PitReport>): void {
    setReport((prev) => {
      const next = { ...prev, ...patch };
      void savePitDraft(props.eventKey, props.teamNumber, next);
      return next;
    });
    setStatus('idle');
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadPitPhoto(props.eventKey, props.teamNumber, file);
      const url = await signedPitPhotoUrl(path);
      setPreviewUrl(url);
      update({ photoPath: path });
    } catch {
      setStatus('error');
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(): Promise<void> {
    setStatus('saving');
    try {
      await submitPit(report);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div data-testid="pit-screen" className="mx-auto flex max-w-md flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">
        Pit Scout — Team {props.teamNumber}
      </h1>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-drivetrain">Drivetrain</Label>
        <select
          id="pit-drivetrain"
          data-testid="pit-drivetrain"
          value={report.drivetrain}
          onChange={(e) => update({ drivetrain: e.target.value })}
          className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {DRIVETRAINS.map((d) => (
            <option key={d} value={d}>
              {d === '' ? 'Select…' : d}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-mechanisms">Mechanisms (comma separated)</Label>
        <Input
          id="pit-mechanisms"
          className="h-11"
          value={report.mechanisms.join(', ')}
          onChange={(e) =>
            update({
              mechanisms: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Capabilities</legend>
        {CAPABILITY_OPTIONS.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={report.capabilities.includes(c)}
              onChange={() => update({ capabilities: toggle(report.capabilities, c) })}
            />
            {c}
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Intake sources</legend>
        {INTAKE_OPTIONS.map((s) => (
          <label key={s} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={report.intakeSources.includes(s)}
              onChange={() => update({ intakeSources: toggle(report.intakeSources, s) })}
            />
            {s}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-notes">Notes</Label>
        <textarea
          id="pit-notes"
          className="min-h-24 w-full rounded-md border border-input bg-transparent p-3 text-sm"
          value={report.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-photo">Robot photo</Label>
        <input
          id="pit-photo"
          data-testid="pit-photo"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => void onPhoto(e)}
          className="min-h-11 text-sm"
        />
        {previewUrl && (
          <img
            src={previewUrl}
            alt="pit photo preview"
            className="max-h-64 w-full rounded-md object-contain"
          />
        )}
      </div>

      <Button
        data-testid="pit-submit"
        size="lg"
        className="min-h-11"
        disabled={status === 'saving' || uploading}
        onClick={() => void onSubmit()}
      >
        {status === 'saving' ? 'Submitting…' : 'Submit'}
      </Button>

      {status === 'saved' && (
        <p data-testid="pit-saved" className="text-sm text-green-500">
          Saved.
        </p>
      )}
      {status === 'error' && (
        <p data-testid="pit-error" className="text-sm text-destructive">
          Submit failed — draft kept offline.
        </p>
      )}
    </div>
  );
}
```

Run: `npm run test -- src/pit/__tests__/PitScoutScreen.test.tsx`
Expected: PASS — 5 passing.
Commit: `git add -A && git commit -m "feat(pit): PitScoutScreen form, photo upload preview, autosave, submit"`

- [ ] **Step 4: Full PIT cluster verification.**

Run: `npm run test -- src/pit && npm run typecheck`
Expected: All PIT suites green (photoUpload 4, pitStore 4, PitScoutScreen 5) and typecheck exits 0 with no errors.
Commit: `git commit --allow-empty -m "chore(pit): PIT cluster green — photoUpload, pitStore, PitScoutScreen"`

<!-- ===== Cluster EXPORT ===== -->

### Task EXPORT1

**Files:**
- Create: `src/export/exportReports.ts`
- Test: `src/export/__tests__/exportReports.test.ts`

**Interfaces:**
- Consumes: `LocalMatchReport` from `@/db/types`; `saveReport(r:LocalMatchReport):Promise<void>`, `listReports():Promise<LocalMatchReport[]>`, `getUnsynced():Promise<LocalMatchReport[]>` from `@/db/localStore`
- Produces: `reportsToJson(reports:LocalMatchReport[]):string`

- [ ] **Step 1: Add a failing test for `reportsToJson` shape.**
  Create `src/export/__tests__/exportReports.test.ts`:
  ```ts
  import 'fake-indexeddb/auto';
  import { describe, it, expect, beforeEach } from 'vitest';
  import type { LocalMatchReport } from '@/db/types';
  import { reportsToJson } from '../exportReports';
  import { db } from '@/db/localStore';

  function makeReport(id: string, syncState: LocalMatchReport['syncState'] = 'dirty'): LocalMatchReport {
    return {
      id,
      schemaVersion: 1,
      appVersion: 'test',
      deviceId: 'dev-1',
      createdAt: '2026-06-23T00:00:00.000Z',
      eventKey: '2026event',
      matchKey: 'qm1',
      scoutId: 'scout-1',
      targetTeamNumber: 1234,
      allianceColor: 'red',
      station: 1,
      inactiveFirst: false,
      inactiveFirstSource: 'scout',
      teleopClockUnconfirmed: false,
      fuelBursts: [],
      autoFuel: 0,
      teleopFuelActive: 0,
      teleopFuelInactive: 0,
      endgameFuel: 0,
      fuelByShift: [0, 0, 0, 0],
      fuelPoints: 0,
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
      syncState,
    };
  }

  beforeEach(async () => {
    await db.reports.clear();
    await db.drafts.clear();
  });

  describe('reportsToJson', () => {
    it('produces a stable JSON document with a schemaVersion header and reports array', () => {
      const json = reportsToJson([makeReport('id-1'), makeReport('id-2')]);
      const parsed = JSON.parse(json);
      expect(parsed.schemaVersion).toBe(1);
      expect(Array.isArray(parsed.reports)).toBe(true);
      expect(parsed.reports.map((r: LocalMatchReport) => r.id)).toEqual(['id-1', 'id-2']);
    });
  });

  export { makeReport };
  ```
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: FAIL — `Cannot find module '../exportReports'`.
  Commit: `test(export): add failing reportsToJson shape test`

- [ ] **Step 2: Implement `reportsToJson` to pass.**
  Create `src/export/exportReports.ts`:
  ```ts
  import type { LocalMatchReport } from '@/db/types';
  import { getUnsynced, saveReport } from '@/db/localStore';

  const EXPORT_SCHEMA_VERSION = 1;

  interface ExportDocument {
    schemaVersion: number;
    reports: LocalMatchReport[];
  }

  export function reportsToJson(reports: LocalMatchReport[]): string {
    const doc: ExportDocument = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      reports,
    };
    return JSON.stringify(doc, null, 2);
  }
  ```
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: PASS — 1 passing.
  Commit: `feat(export): add reportsToJson with schemaVersion header`

### Task EXPORT2

**Files:**
- Modify: `src/export/exportReports.ts`
- Test: `src/export/__tests__/exportReports.test.ts`

**Interfaces:**
- Consumes: `reportsToJson(reports:LocalMatchReport[]):string`; `saveReport(r:LocalMatchReport):Promise<void>` from `@/db/localStore`
- Produces: `importReportsFromJson(json:string):Promise<number>`

- [ ] **Step 1: Add a failing roundtrip + dedupe test.**
  Append to `src/export/__tests__/exportReports.test.ts` (add `importReportsFromJson` to the import line and `listReports` from `@/db/localStore`):
  ```ts
  import { reportsToJson, importReportsFromJson } from '../exportReports';
  import { db, listReports } from '@/db/localStore';

  describe('importReportsFromJson', () => {
    it('roundtrips reportsToJson output, persisting reports and deduping by id', async () => {
      const json = reportsToJson([makeReport('id-1'), makeReport('id-2')]);

      const first = await importReportsFromJson(json);
      expect(first).toBe(2);

      const second = await importReportsFromJson(json);
      expect(second).toBe(2);

      const stored = await listReports();
      const ids = stored.map((r) => r.id).sort();
      expect(ids).toEqual(['id-1', 'id-2']);
      expect(stored).toHaveLength(2);
    });

    it('throws on malformed JSON document shape', async () => {
      await expect(importReportsFromJson('{"nope":true}')).rejects.toThrow();
      await expect(importReportsFromJson('not json')).rejects.toThrow();
      await expect(
        importReportsFromJson(JSON.stringify({ schemaVersion: 1, reports: [{ id: 5 }] })),
      ).rejects.toThrow();
    });
  });
  ```
  Note: remove the now-duplicate import of `reportsToJson`/`db` from Step 1's lines — keep a single import line for each module.
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: FAIL — `importReportsFromJson is not a function`.
  Commit: `test(export): add import roundtrip and dedupe tests`

- [ ] **Step 2: Implement `importReportsFromJson` with shape validation + dedupe.**
  Add to `src/export/exportReports.ts` (after `reportsToJson`):
  ```ts
  function isValidReport(value: unknown): value is LocalMatchReport {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    return (
      typeof r.id === 'string' &&
      typeof r.schemaVersion === 'number' &&
      typeof r.matchKey === 'string' &&
      typeof r.targetTeamNumber === 'number' &&
      Array.isArray(r.fuelBursts) &&
      Array.isArray(r.fuelByShift)
    );
  }

  function parseExportDocument(json: string): LocalMatchReport[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('importReportsFromJson: invalid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('importReportsFromJson: not an export document');
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc.schemaVersion !== 'number' || !Array.isArray(doc.reports)) {
      throw new Error('importReportsFromJson: missing schemaVersion or reports');
    }
    for (const candidate of doc.reports) {
      if (!isValidReport(candidate)) {
        throw new Error('importReportsFromJson: malformed report in document');
      }
    }
    return doc.reports as LocalMatchReport[];
  }

  export async function importReportsFromJson(json: string): Promise<number> {
    const reports = parseExportDocument(json);
    const seen = new Set<string>();
    let imported = 0;
    for (const report of reports) {
      if (seen.has(report.id)) continue;
      seen.add(report.id);
      await saveReport(report);
      imported += 1;
    }
    return imported;
  }
  ```
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: PASS — all import tests green.
  Commit: `feat(export): add importReportsFromJson with validation and dedupe`

### Task EXPORT3

**Files:**
- Modify: `src/export/exportReports.ts`
- Test: `src/export/__tests__/exportReports.test.ts`

**Interfaces:**
- Consumes: `getUnsynced():Promise<LocalMatchReport[]>`, `saveReport(r:LocalMatchReport):Promise<void>` from `@/db/localStore`; `reportsToJson(reports:LocalMatchReport[]):string`
- Produces: `exportUnsyncedToFile():Promise<{count:number;filename:string;blobUrl:string}>`

- [ ] **Step 1: Add a failing test that `exportUnsyncedToFile` gathers only unsynced.**
  Append to `src/export/__tests__/exportReports.test.ts` (add `exportUnsyncedToFile` to the `../exportReports` import and `saveReport` to the `@/db/localStore` import):
  ```ts
  describe('exportUnsyncedToFile', () => {
    it('gathers only unsynced reports into the export descriptor', async () => {
      if (typeof URL.createObjectURL !== 'function') {
        (URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
          'blob:fake';
      }
      await saveReport(makeReport('dirty-1', 'dirty'));
      await saveReport(makeReport('pending-1', 'pending'));
      await saveReport(makeReport('synced-1', 'synced'));

      const result = await exportUnsyncedToFile();

      expect(result.count).toBe(2);
      expect(result.filename).toMatch(/\.json$/);
      expect(typeof result.blobUrl).toBe('string');
    });
  });
  ```
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: FAIL — `exportUnsyncedToFile is not a function`.
  Commit: `test(export): add exportUnsyncedToFile unsynced-only test`

- [ ] **Step 2: Implement `exportUnsyncedToFile`.**
  Add to `src/export/exportReports.ts` (after `importReportsFromJson`):
  ```ts
  export async function exportUnsyncedToFile(): Promise<{
    count: number;
    filename: string;
    blobUrl: string;
  }> {
    const unsynced = await getUnsynced();
    const json = reportsToJson(unsynced);
    const blob = new Blob([json], { type: 'application/json' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `scouting-unsynced-${stamp}.json`;
    const blobUrl = URL.createObjectURL(blob);
    return { count: unsynced.length, filename, blobUrl };
  }
  ```
  Run: `npm run test -- src/export/__tests__/exportReports.test.ts`
  Expected: PASS — all export tests green.
  Commit: `feat(export): add exportUnsyncedToFile download descriptor`

- [ ] **Step 2b: Typecheck the cluster.**
  Run: `npm run typecheck`
  Expected: no errors.
  Commit: `chore(export): typecheck clean for exportReports`

<!-- ===== Cluster GATE ===== -->

### Task GATE1

**Files:**
- Test: `tests/e2e/capture.spec.ts` (Create)

**Interfaces:**
- Consumes (route): `/scout` -> `ScoutHome` (default export `src/capture/ScoutHome.tsx`); testids `scout-home`, `scout-manual-pick`, `scout-start-capture`.
- Consumes (CaptureScreen testids): `capture-start`, `capture-go`, `capture-inactive-yes`, `capture-inactive-no`, `capture-hold`, `capture-rate`, `capture-running-fuel`, `capture-to-review`.
- Consumes (ReviewScreen testids): `review-climb`, `review-save`, `review-summary`.
- Consumes (env): `process.env.E2E_JOIN_CODE` (skip when unset); base URL from Playwright config.

- [ ] **Step 1: Create the failing E2E spec skeleton (skip guard + navigation).**
```ts
// tests/e2e/capture.spec.ts
import { test, expect, type Page } from '@playwright/test';

const JOIN_CODE = process.env.E2E_JOIN_CODE;

test.describe('offline capture E2E', () => {
  test.skip(!JOIN_CODE, 'E2E_JOIN_CODE unset; skipping offline capture E2E');

  test('joined scout completes a manual capture and persists a report', async ({ page }) => {
    await page.goto('/scout');
    await expect(page.getByTestId('scout-home')).toBeVisible();
  });
});
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected (creds unset locally): `1 skipped`. With `E2E_JOIN_CODE` set: fails at a later step (no manual-pick wiring exercised yet). Either is the intended red-or-skip starting state.
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): scaffold offline capture E2E with skip guard"`

- [ ] **Step 2: Add a baseline unsynced-count reader helper inside the spec.**
```ts
// tests/e2e/capture.spec.ts  (insert ABOVE test.describe)
async function readUnsyncedCount(page: Page): Promise<number> {
  const raw = await page.getByTestId('scout-unsynced-count').textContent();
  const n = Number((raw ?? '').replace(/\D+/g, ''));
  return Number.isFinite(n) ? n : 0;
}
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset) — no behavior change yet.
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): add unsynced-count reader helper"`

- [ ] **Step 3: Drive the manual pick into CaptureScreen.**
```ts
// tests/e2e/capture.spec.ts  (append INSIDE the test body, after the scout-home assertion)
    const before = await readUnsyncedCount(page);

    await page.getByTestId('scout-manual-pick').click();
    await page.getByTestId('scout-start-capture').click();
    await expect(page.getByTestId('capture-start')).toBeVisible();
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset). With creds: reaches CaptureScreen, then fails at next missing steps.
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): drive manual pick into CaptureScreen"`

- [ ] **Step 4: Run START -> GO and answer inactive-first.**
```ts
// tests/e2e/capture.spec.ts  (append INSIDE the test body, after the capture-start assertion)
    await page.getByTestId('capture-start').click();
    await page.getByTestId('capture-go').click();
    await page.getByTestId('capture-inactive-yes').click();
    await expect(page.getByTestId('capture-hold')).toBeVisible();
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset).
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): run START then GO answering inactive-first"`

- [ ] **Step 5: Hold-to-shoot a couple of bursts and assert running fuel increments.**
```ts
// tests/e2e/capture.spec.ts  (append INSIDE the test body, after the capture-hold assertion)
    await page.getByTestId('capture-rate').click();

    const hold = page.getByTestId('capture-hold');
    for (let i = 0; i < 2; i++) {
      await hold.dispatchEvent('pointerdown');
      await page.waitForTimeout(400);
      await hold.dispatchEvent('pointerup');
      await page.waitForTimeout(100);
    }

    const fuelText = await page.getByTestId('capture-running-fuel').textContent();
    const fuel = Number((fuelText ?? '').replace(/\D+/g, ''));
    expect(fuel).toBeGreaterThan(0);
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset).
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): hold-to-shoot two bursts and assert running fuel"`

- [ ] **Step 6: Go to review, set a climb, and SAVE.**
```ts
// tests/e2e/capture.spec.ts  (append INSIDE the test body, after the running-fuel assertion)
    await page.getByTestId('capture-to-review').click();
    await expect(page.getByTestId('review-summary')).toBeVisible();

    await page.getByTestId('review-climb').selectOption('2');
    await page.getByTestId('review-save').click();
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset).
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): review screen set climb and save"`

- [ ] **Step 7: Assert saved indicator + unsynced count incremented back on ScoutHome.**
```ts
// tests/e2e/capture.spec.ts  (append INSIDE the test body, after review-save click)
    await expect(page.getByTestId('scout-home')).toBeVisible();
    await expect
      .poll(async () => readUnsyncedCount(page), { timeout: 10000 })
      .toBeGreaterThan(before);
```
Run: `npm run test:e2e -- tests/e2e/capture.spec.ts`
Expected: `1 skipped` (creds unset). With `E2E_JOIN_CODE` set and `/scout`->ScoutHome wired by the controller: `1 passed`.
Commit: `git add tests/e2e/capture.spec.ts && git commit -m "test(gate): assert saved report increments unsynced count"`

### Task GATE2

**Files:**
- (No source files; verification + empty chore commit only.)

**Interfaces:**
- Consumes (npm scripts, from contracts Tooling): `npm run test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`.
- Produces: a single empty `chore` Conventional Commit marking the Phase 2 verification gate green.

- [ ] **Step 1: Unit tests green.**
Run: `npm run test`
Expected: vitest exits `0`; final line shows all test files passed (e.g. `Test Files  N passed`, `Tests  M passed`), no failures.
Commit: none yet (verification step).

- [ ] **Step 2: Typecheck clean.**
Run: `npm run typecheck`
Expected: `tsc` exits `0` with no diagnostics printed.
Commit: none yet (verification step).

- [ ] **Step 3: Production build succeeds.**
Run: `npm run build`
Expected: Vite prints `built in <time>` and exits `0`; `dist/` produced with no errors.
Commit: none yet (verification step).

- [ ] **Step 4: E2E green (or cleanly skipped when creds unset).**
Run: `npm run test:e2e`
Expected: Playwright exits `0`. With `E2E_JOIN_CODE` set: `1 passed` for `tests/e2e/capture.spec.ts`. With it unset: `1 skipped`, still exit `0`.
Commit: none yet (verification step).

- [ ] **Step 5: Record the Phase 2 verification gate with an empty chore commit.**
Run: `git commit --allow-empty -m "chore(phase2): verification gate green — test, typecheck, build, e2e"`
Expected: git prints a new commit with `0 files changed` (empty commit) referencing the message above.
Commit: the command above IS the commit.
