# Dashboard Data-Freshness / Scout Heartbeat

Feature group: Workflow / trust. Make the invisible sync engine visible to the lead.

---

## 1. Overview & exact user-facing behavior

The lead currently has no way to know whether the dashboard reflects reality or stale
data. Reports flow into `match_scouting_report` silently; the only visible sync signal is
the header `SyncIndicator` (`↑queued`/`⚠deadLetters`), which is about THIS device's outbox,
not about whether the stands scouts are keeping up.

This feature adds a **scout heartbeat**: a trust indicator answering three questions.

1. **When did the last report arrive?** — a relative-time stamp ("5m ago", "just now",
   "1h 12m ago") derived from the freshest `server_received_at` across the event (global)
   and for the currently-viewed match (per-match).
2. **How many scouts synced for the current/last match?** — an "X/Y scouts" badge where
   X = distinct `scout_id`s with a live report on that match and Y = scouts registered for
   the event (`scout` rows). A subtle tone: green/"covered" when X ≥ expected (6 for a full
   6-station match, configurable cap at Y), amber when partial, red when 0.
3. **Which matches are missing reports?** — `MatchView`'s left match list already shows a
   per-match report count; this feature upgrades it to a coverage badge (`0 reports` stays
   warning, adds a faded ✓ when a match reaches full station coverage) and adds a
   "Scouting Status" card to the drill-down listing scouts who reported (with per-scout
   report time) and scouts registered but not yet reporting on that match.

Exact placement:

- **NextMatchView hero column** (right side, below the "Live field status" tiles, above
  "Upcoming"): a compact `ScoutHeartbeat` tile showing the global "last report" stamp + the
  per-match "X/Y scouts" badge for the currently-anchored match, plus an online/offline +
  pending hint sourced from `useSync()`.
- **MatchView drill-down** (top of the right detail pane, above `MatchVideoCard`): a
  "Scouting Status" card with per-scout report rows + a missing-scout list.
- **SyncIndicator** (header, optional): append "· synced 30s ago" using a new
  `lastSyncedAt` field on `useSync()`.

All numbers degrade gracefully offline (Section 6): they read the **query cache** (persisted
to IndexedDB) for already-synced reports and the **local outbox** (`getSyncQueue`) for
pending counts, so the lead always sees *something* truthful even with no network.

---

## 2. Data model

**Every column needed already exists** on `match_scouting_report`:

- `scout_id uuid` (attribution — who submitted)
- `server_received_at timestamptz` (set by the server on every upsert; the freshness clock)
- `match_key text`, `event_key text`, `target_team_number int`, `station int`
- `deleted boolean` (already filtered by `useEventReports` via `.eq('deleted', false)`)

and `scout` provides `id`, `display_name`, `event_key` (read by `useEventScouts`). The
heartbeat itself is a pure **client-side aggregation** of the existing report stream + scout
roster — no schema/columns change.

**ONE new migration IS required (`0033`) — for realtime, not data.** The headline
freshness promise ("new report refreshes the heartbeat within one realtime tick") depends on
`match_scouting_report` being in the `supabase_realtime` publication. It is **NOT** today:
migration `0027_live_webhooks.sql` (lines 83–99) only added `match` and `nexus_event_status`,
and no later migration adds `match_scouting_report`. Supabase Realtime delivers **nothing**
for a table outside the publication, so the Step-7 subscription would fire zero events and
silently no-op. Therefore this feature adds a single numbered migration:

```
supabase/migrations/0033_realtime_match_scouting_report.sql
```

It mirrors the exact guarded pattern in `0027` (idempotent `if not exists` publication add)
and sets `replica identity full` so RLS-filtered realtime works on UPDATE/DELETE:

```sql
-- 0033_realtime_match_scouting_report.sql
-- Add match_scouting_report to supabase_realtime so the dashboard heartbeat
-- refreshes the instant a scout report lands (0027 only added match + nexus_event_status).
alter table match_scouting_report replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'match_scouting_report'
    ) then
      execute 'alter publication supabase_realtime add table match_scouting_report';
    end if;
  end if;
end $$;
```

Deploy via `supabase db push` (the standing auto-deploy instruction). **Latest deployed
migration is 0032; this is `0033` and MUST NOT be marked deployed in MEMORY.md until
`supabase db push` confirms it.** RLS for the table is already correct (existing SELECT
policy gates anon to its event); realtime respects RLS, so no policy change is needed —
only the publication membership + replica identity.

> Out of scope (would need a FURTHER migration, NOT built here): a server-side
> `match_scouting_summary` view/RPC indexed by `(event_key, match_key)` for O(1)
> "which matches are at 0% coverage" without fetching all rows; and a `scout_checkin`
> table to distinguish "on-site but hasn't scouted" from "not assigned". If a future
> agent adds either, it MUST be a new numbered migration (`0033+`) with RLS mirroring the
> 0024/0031 pattern (anon + authenticated SELECT, service-role write) and MUST NOT be
> marked deployed in MEMORY.md until `supabase db push` confirms it. (That hypothetical
> would be `0034+`, after this feature's `0033`.)

---

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/useMatchScoutCoverage.ts` | **NEW.** Export `useEventScoutCoverage(eventKey)` returning `{ lastReportAt: string \| null, coverageByMatch: Map<string, MatchScoutCoverage>, scoutsTotal: number }` built from `useEventReports` + `useEventScouts` (both already cached/persisted, so this is offline-safe and adds no network round-trips). Export a thin `useMatchScoutCoverage(eventKey, matchKey)` that selects one match's entry from the map (or a zeroed default). No new query keys — reuse `['reports', eventKey]` / `['scouts', eventKey]` so realtime invalidation already covers it. |
| `src/dash/aggregate.ts` | **MODIFY.** Add pure, exported `matchScoutCoverage(reports, scouts, matchKey, stationCap = 6)` and `eventScoutCoverage(reports, scouts, stationCap = 6)` with the **frozen signatures below** so the sibling **coverage-gaps** feature imports rather than forks. No change to `aggregateTeam`/`aggregateEvent`/`TeamAgg`. Imports stay `MsrRow` + a new `ScoutLite` type (see §4). **Land this edit FIRST among the dash features that touch `aggregate.ts` (§8).** Frozen signatures: `export function matchScoutCoverage(reports: MsrRow[], scouts: ScoutLite[], matchKey: string, stationCap?: number): MatchScoutCoverage` and `export function eventScoutCoverage(reports: MsrRow[], scouts: ScoutLite[], stationCap?: number): { coverageByMatch: Map<string, MatchScoutCoverage>; lastReportAt: string \| null; scoutsTotal: number }`. |
| `src/dash/types.ts` | **MODIFY.** Add `MatchScoutCoverage` and `ScoutLite` interfaces (§4). Purely additive; `MsrRow` is untouched (it already carries `scout_id` + `server_received_at`). |
| `src/dash/ScoutHeartbeat.tsx` | **NEW.** Presentational `ScoutHeartbeat` component (tile for NextMatchView) — props `{ coverage: MatchScoutCoverage, lastReportAt: string \| null, online: boolean, pending: number, nowMs: number }`. Pure; no hooks except none — parent passes everything. Renders the "X/Y scouts" badge, relative "last report" stamp, and an offline/pending hint. `data-testid="scout-heartbeat"`. |
| `src/dash/relativeTime.ts` | **NEW.** Pure `relativeTime(iso: string \| null, nowMs: number): string` → "just now" (<60s), "Xm ago" (<60m), "Xh Ym ago" (<24h), "Xd ago" else; `null`/unparseable → "no reports yet". No `Date.now()` inside (takes `nowMs`) so it is deterministic in unit tests. |
| `src/dash/NextMatchView.tsx` | **MODIFY.** Import `useEventScoutCoverage`, `ScoutHeartbeat`, `useSync`. Compute `coverage = useEventScoutCoverage(eventKey)`; pick the anchored `match.match_key` entry; render `<ScoutHeartbeat …/>` in the RIGHT column, inserted between the "Live field status" grid (`grid-cols-2` of `FieldTile`) and the "Upcoming" block. Reuse the existing `useNow()` clock for `nowMs`. Guard for `match == null` (already early-returns) and empty coverage. **`useEventScoutCoverage` internally calls `useEventScouts`, a 4th data source the existing `loading` guard (line 608: `matchesQ.isLoading \|\| reportsQ.isLoading \|\| teamsQ.isLoading`) does NOT cover — add `scoutsQ.isLoading` to that guard (call `useEventScouts(eventKey)` alongside the others, or have the hook expose its `scoutsLoading`), OR rely on `ScoutHeartbeat` rendering the `scoutsTotal === 0` "—" empty-roster state instead of a misleading `3/0` flash. Pick the guard extension as the default; it is the cleaner fix.** |
| `src/dash/MatchView.tsx` | **MODIFY.** Import `useEventScoutCoverage`. Add a `ScoutingStatusCard` (local sub-component) rendered at the top of the right detail pane (before `MatchVideoCard`) when `selected != null`. It lists reported scouts (name + per-scout relative report time, from `selectedReports`) and registered-but-missing scouts (from `scouts` minus reported `scout_id`s). Upgrade the left-list count badge: keep `count reports` text, add a `data-testid="match-coverage-{match_key}"` ✓/partial marker driven by `coverageByMatch.get(m.match_key)`. |
| `src/sync/useSync.ts` | **MODIFY (optional, low-risk additive).** Add `lastSyncedAt: number \| null` to `UseSyncResult`; set it to `Date.now()` in `run()`'s `finally` only when `syncOnce`/`syncPitOnce` resolved without throwing (track via a local `ok` flag). Existing consumers ignore the new field. |
| `src/sync/SyncIndicator.tsx` | **MODIFY (optional).** Destructure `lastSyncedAt`; render "· synced {relativeTime(...)}" next to the "Sync now" button with `data-testid="sync-last"`. Reuse `relativeTime` with a local `Date.now()` snapshot (header re-renders often enough on poll). |
| `supabase/migrations/0033_realtime_match_scouting_report.sql` | **NEW.** Add `match_scouting_report` to the `supabase_realtime` publication + `replica identity full`, guarded `if not exists` (mirrors `0027`). Required for the Step-7 realtime branch to deliver anything (Section 2). Deploy with `supabase db push`; do NOT mark deployed in MEMORY.md until confirmed. |
| `src/dash/__tests__/NextMatchView.test.tsx` | **MODIFY (mock factory, not just appended cases).** The existing `vi.mock('@/dash/useEventData')` factory does NOT export `useEventScouts`, and there is NO `vi.mock('@/sync/useSync')`. Wiring `useEventScoutCoverage`+`useSync` into the view makes `useEventScouts` resolve to `undefined` → the new hook throws on render → **every existing NextMatchView test goes red**, not just the new ones. MUST: (a) add `useEventScouts: (k: string \| null) => useEventScoutsMock(k)` to the factory and a `const useEventScoutsMock = vi.fn()` reset in `beforeEach` with a sane default (`dataResult([...roster])`); (b) add `vi.mock('@/sync/useSync', () => ({ useSync: () => ({ online: true, queued: 0, deadLetters: 0, lastSyncedAt: null, run: vi.fn() }) }))` (match the real `UseSyncResult` shape); then append the new heartbeat cases. |
| `src/dash/__tests__/MatchView.test.tsx` | **MODIFY (mock factory).** Same hazard as NextMatchView — add `useEventScouts` to the `@/dash/useEventData` mock factory (and `useSync` if MatchView imports it; per the plan MatchView does NOT use `useSync`, so only `useEventScouts` is required) before appending the `ScoutingStatusCard` cases. |

**Reference files (NOT edited, but load-bearing for this feature — verify before/while
implementing):**

- `src/dash/DashboardScreen.tsx` — mounts `useEventLiveSync(eventKey)` at line 65 (where the
  Step-7 realtime branch takes effect) and defines the tab labels the e2e specs navigate by
  (`{ key: 'next', label: 'Next Match' }` line 32, `{ key: 'match', label: 'Match' }`
  line 35). Not modified; referenced so the implementer knows where realtime lands and which
  tab labels to target.
- `src/components/ui/IconTabs.tsx` — renders `role="tablist"`/`role="tab"` (lines 33/46), so
  the e2e `getByRole('tab', { name: … })` selectors are valid. Not modified; noted so the
  implementer doesn't second-guess the selector.

---

## 4. Core logic — types, formulas, consistency

### Types (`src/dash/types.ts`, additive)

```ts
/** Minimal scout identity the coverage view needs (subset of ScoutRow). */
export interface ScoutLite {
  id: string;
  display_name: string | null;
}

/** Per-match scout coverage synthesized from the report stream + roster. */
export interface MatchScoutCoverage {
  matchKey: string;
  /** distinct scout_ids with a LIVE (deleted=false) report on this match */
  scoutsCovered: number;
  /** scouts registered for the event (roster size, the denominator) */
  scoutsTotal: number;
  /** freshest server_received_at among this match's reports, or null */
  lastReportAt: string | null;
  /** distinct reported scout_ids (excludes null/undefined attribution) */
  reportedScoutIds: string[];
  /** roster scouts with NO report on this match */
  missingScouts: ScoutLite[];
  /** count of reports on this match whose scout_id is null/undefined */
  unattributed: number;
  /** station coverage: distinct stations reported, capped at stationCap (6) */
  stationsCovered: number;
}
```

### `matchScoutCoverage(reports, scouts, matchKey, stationCap = 6)` (pure, in `aggregate.ts`)

Algorithm (single pass over `reports`):

1. Filter to live rows for the match: `r.deleted !== true && r.match_key === matchKey`.
   (Defensive: `useEventReports` already selects `.eq('deleted', false)` (`useEventData.ts`
   line 99), so production rows are pre-filtered server-side and never deliver a deleted row.
   The `r.deleted !== true` guard exists only to keep the pure helper correct when called
   with hand-built fixtures or a future unfiltered caller — it is a unit-level guard, not an
   end-to-end path.)
2. `reportedScoutIds` = distinct non-null `r.scout_id` (use a `Set<string>`); `unattributed`
   = count of rows where `scout_id == null`.
3. `scoutsCovered = reportedScoutIds.size`.
4. `lastReportAt` = the row maximizing `Date.parse(server_received_at ?? '')` (skip rows
   where the value is nullish OR `Date.parse` is `NaN`). Keep the raw ISO string of the max,
   not the parsed number, so the formatter stays the time source. **Null-guard explicitly:
   `MsrRow.server_received_at` is typed non-nullable `string` (`types.ts` line 80), but
   QR-ingested / merged rows can surface `undefined`/garbage at runtime, so the helper MUST
   treat it as `r.server_received_at ?? null` regardless of the static type.** A row with a
   missing/garbage stamp still counts toward `scoutsCovered`/`reportedScoutIds` (it IS a
   report); it just can't win the `lastReportAt` max.
5. `stationsCovered = min(stationCap, distinct r.station count for the match)`.
6. `missingScouts` = `scouts.filter(s => !reportedScoutIds.has(s.id))` mapped to `ScoutLite`.
7. `scoutsTotal = scouts.length`.

Return the `MatchScoutCoverage`. Empty match (no rows) → `scoutsCovered:0`,
`lastReportAt:null`, `missingScouts` = all scouts, `stationsCovered:0`.

### `eventScoutCoverage(reports, scouts, stationCap = 6)` (pure, in `aggregate.ts`)

1. Group live reports by `match_key` into buckets in ONE pass.
2. For each `matchKey`, run the per-match computation (refactor: have `matchScoutCoverage`
   call an internal `coverageFromBucket(bucket, matchKey, scouts, stationCap)` so the
   event-level loop reuses it and we don't re-scan all reports per match — O(reports + matches·scouts)).
3. Track a global `lastReportAt` = max `server_received_at` across ALL live reports.
4. Return `{ coverageByMatch: Map<string, MatchScoutCoverage>, lastReportAt, scoutsTotal }`.

### Coverage tone (presentational, in `ScoutHeartbeat`/`MatchView`)

```
expected = min(stationCap /*6*/, scoutsTotal || stationCap)
tone = scoutsCovered === 0           ? 'red'    // nothing yet
     : scoutsCovered >= expected     ? 'green'  // fully covered
     :                                 'amber'  // partial
```

Display "X/Y" as `scoutsCovered`/`scoutsTotal` (fall back to `expected` when roster empty,
labeled "scouts"). The station count is a secondary tooltip, not the headline number, since
the open feature note flags that "registered" ≠ "assigned".

### `relativeTime(iso, nowMs)` (pure)

```
if !iso → 'no reports yet'
t = Date.parse(iso); if NaN → 'no reports yet'
d = nowMs - t (ms); if d < 0 → 'just now'   // clock skew guard
d < 60s        → 'just now'
d < 60m        → `${round(d/60s)}m ago`
d < 24h        → `${h}h ${m}m ago` (drop ' 0m')
else           → `${days}d ago`
```

### Consistency with mapReport / scoring

**Neither `mapReport.ts` nor `src/scoring/` is touched.** This feature is read-only over
already-persisted columns; it never changes the upsert wire shape and never recomputes a
scored aggregate. It uses `server_received_at` (server-authored) and `scout_id`
(already in the wire shape and already on `MsrRow`). The server-recomputes-aggregates
invariant is irrelevant here — no scored field is produced. No `SCHEMA_VERSION` bump.

---

## 5. UI / UX

### `ScoutHeartbeat` tile (NextMatchView, right column)

A rounded card matching the dashboard's `Card`/dark broadcast styling, inserted after the
On-Field/Queuing `FieldTile` grid:

- **Header row:** "Scout Heartbeat" label (uppercase, muted) + an online dot (reuse the
  `bg-success`/`bg-warning` dot convention from `SyncIndicator`).
- **Big number:** `{scoutsCovered}/{scoutsTotal}` with tone color; sublabel "scouts synced
  for {heroLabel}".
- **Last report:** `relativeTime(coverage.lastReportAt OR global lastReportAt, now)` — use
  the per-match stamp when the match has reports, else the global event stamp so the tile
  is never just "no reports yet" for a brand-new upcoming match. Label it accordingly
  ("last report on this match" vs "last report anywhere").
- **Pending hint (offline-aware):** when `pending > 0` show "· {pending} pending sync";
  when `!online` show an "offline — showing last synced" muted note.
- `data-testid="scout-heartbeat"`, with `data-testid="scout-heartbeat-count"` on the
  X/Y number and `data-testid="scout-heartbeat-last"` on the relative stamp.

### `ScoutingStatusCard` (MatchView, top of detail pane)

- Title: "Scouting status — {scoutsCovered}/{scoutsTotal} synced · last report {rel}".
- **Reported list:** one row per `selectedReports` entry → `{scoutName(scout_id)}` +
  `relativeTime(server_received_at, now)` + station chip. Sorted by station.
- **Missing list:** faded rows for `coverage.missingScouts` → "{name} — no report yet".
  Collapsed/hidden when empty. Caveat copy: "(registered for event; may not be assigned)".
- `data-testid="match-scout-status"`, rows `data-testid="match-scout-reported-{scout_id}"`
  and `data-testid="match-scout-missing-{scout_id}"`.

### Left match-list badge upgrade (MatchView)

Keep the `{count} reports` span; add a small marker:
`data-testid="match-coverage-{match_key}"` → ✓ (success) when
`stationsCovered >= expected`, partial dot (warning) otherwise. Does not change existing
`count === 0 ? warning : success` text coloring (preserves current tests).

### States

- **No match selected (MatchView):** existing `match-prompt` unchanged; no status card.
- **No reports yet (event):** heartbeat shows `0/{Y}`, tone red, "no reports yet".
- **Empty roster (`scoutsTotal === 0`):** show `{scoutsCovered}/—` and fall back the tone
  expected to 6; do not divide by zero.
- **Loading:** NextMatchView's existing `loading` guard (line 608) covers matches/reports/
  teams but **NOT scouts** — the heartbeat's denominator comes from `useEventScouts`, so on a
  cold offline start scouts may be `undefined` while reports are cached, risking a transient
  `3/0` / `3/—` flash. Mitigate BOTH ways: (1) add `scoutsQ.isLoading` to the NextMatchView
  guard (§3), and (2) make `ScoutHeartbeat` render the empty-roster "—" state below when
  `scoutsTotal === 0` rather than a misleading number, so even if a frame slips through it
  reads truthfully. Do NOT claim the existing guard covers scouts — it does not until
  extended.

---

## 6. Offline behavior

Everything degrades to "last known good" with zero network:

1. **Source is the persisted query cache.** `useEventReports` and `useEventScouts` are
   TanStack Query hooks whose cache is persisted to IndexedDB (`PersistQueryClientProvider`
   in `App.tsx`). Offline, `enabled` stays true but the query is served from the rehydrated
   cache; the heartbeat computes from whatever last synced. No new fetch is added.
2. **No throw on missing data.** The hook returns a zeroed `MatchScoutCoverage` default when
   `reports`/`scouts` are `undefined`, so an offline cold start (empty cache) shows
   "no reports yet" rather than crashing — and the shared `RouteError` boundary stays unused.
3. **Pending outbox is surfaced, not merged.** Offline, a scout's just-captured report sits
   in THIS device's local outbox and has no `server_received_at` yet, so it can't count as
   "synced". `ScoutHeartbeat` reads `pending` from `useSync()` (which reads `getSyncQueue()`
   even while offline) and shows "{pending} pending sync" + an "offline" note, so the lead
   understands the X/Y is "synced so far", not "captured so far". This matches the documented
   risk (offline under-counts) and manages expectations explicitly.
4. **Online recovery is automatic.** `useEventLiveSync` (already mounted in
   `DashboardScreen.tsx` line 65) invalidates `['matches', eventKey]` on realtime `match`
   changes (a third `.on('postgres_changes', …)` chained before `.subscribe()`, see
   `useEventData.ts` lines 509–516). We piggyback by adding a `match_scouting_report`
   realtime branch (see Step 7) that invalidates `['reports', eventKey]`. **This only
   delivers events because migration `0033` (Section 2) adds the table to
   `supabase_realtime`** — without that publication change the branch is a silent no-op.
   With `0033` deployed, a new scout report refreshes the heartbeat within one realtime tick
   instead of waiting out the 60s `staleTime`. Even without a live socket (unit tests / no
   network), the 60s poll + manual "Sync now" still refresh it — the realtime tick is a
   latency optimization, not the only refresh path. The branch is additive and guarded by
   the existing `typeof supabase.channel !== 'function'` no-op.

---

## 7. Test plan

### Unit (Vitest)

**`src/dash/__tests__/relativeTime.test.ts` (NEW)**
- `null` / `''` / `'not-a-date'` → "no reports yet".
- 10s ago → "just now"; 90s → "1m ago"; 25min → "25m ago".
- 75min → "1h 15m ago"; exactly 2h → "2h ago" (no " 0m").
- 50h → "2d ago". Future timestamp (skew) → "just now".

**`src/dash/__tests__/aggregate.test.ts` (EXTEND — file exists)**
- `matchScoutCoverage`: two reports for `qm1` from scouts A,B (+ one with `scout_id:null`)
  → `scoutsCovered:2`, `unattributed:1`, `reportedScoutIds` = [A,B], `lastReportAt` = the
  newest `server_received_at`, `missingScouts` = roster minus {A,B}, `stationsCovered` =
  distinct stations.
- Deleted report (`deleted:true`) is excluded from the count and from `lastReportAt`
  (**defensive only** — production rows are pre-filtered by `useEventReports`'
  `.eq('deleted', false)`; this case proves the pure helper's own guard, not an end-to-end
  scenario).
- **Missing/garbage `server_received_at`:** a row with `server_received_at: undefined` and
  one with `server_received_at: 'not-a-date'` still count toward `scoutsCovered` but neither
  can win `lastReportAt` (locks the §4-step-4 null/NaN guard).
- Match with no reports → `scoutsCovered:0`, `lastReportAt:null`, all scouts missing.
- `eventScoutCoverage`: global `lastReportAt` = max across all matches; `coverageByMatch`
  has an entry per match present in reports; `scoutsTotal` = roster length.
- Empty roster: `scoutsTotal:0`, no divide-by-zero, `missingScouts:[]`.

**`src/dash/__tests__/useEventData.test.tsx` or a new `useMatchScoutCoverage.test.tsx`**
- `useEventScoutCoverage` returns the same numbers as the pure helper given mocked
  `useEventReports`/`useEventScouts` (mock the data module as existing dash tests do).
- Offline-ish: when `useEventReports` returns `undefined` data, the hook yields the zeroed
  default (no throw).

**`src/dash/__tests__/NextMatchView.test.tsx` (EXTEND)**
- With mocked reports for the anchored match from 3 scouts and a 9-scout roster, the
  `scout-heartbeat-count` shows "3/9" and `scout-heartbeat-last` shows a relative stamp.
- No reports → "0/9" with red tone class present.

**`src/dash/__tests__/MatchView.test.tsx` (EXTEND)**
- Selecting a match renders `match-scout-status` with a `match-scout-reported-{id}` row per
  reporting scout and `match-scout-missing-{id}` rows for the rest of the roster.
- `match-coverage-{match_key}` marker present on the left list.

**`src/sync/__tests__/useSync.test.tsx` (EXTEND — if `lastSyncedAt` added)**
- After a successful `run()`, `lastSyncedAt` is a number; on a thrown `syncOnce`, it stays
  `null` (track the `ok` flag).

### Playwright e2e (`tests/e2e/heartbeat.spec.ts`, NEW — single-worker, live `2026casnv`)

Mirror `dashboard.spec.ts` setup: load `.env.local`, build an `admin` service-role client,
`test.skip` when env/migration-0009 probe is absent, `setActiveEvent(admin, '2026casnv')`
before navigating. Use a unique team/match the spec controls so it doesn't fight other
specs; clean up in `afterAll`.

Scenario A — **heartbeat reflects a freshly inserted report**

The heartbeat's per-match count badge is for the **currently-anchored** match (OUR next
match via `trackedNextMatch`), while the relative stamp falls back to the GLOBAL
`lastReportAt`. So inserting a report on an arbitrary `match_key` does NOT guarantee that
match is anchored — a `toContainText('/')` assertion is too weak (passes on `0/9`) and a
count assertion would be unreliable. Drive the assertion two robust ways:

1. As `admin`, insert (or upsert via service role) one `match_scouting_report` with
   `scout_id` of a known `scout` row and a fresh `server_received_at` (`now()`). Use the
   `match_scouting_report` columns directly (service role bypasses RLS); the row's
   `server_received_at` is what we control — set it explicitly to a recent timestamp.
2. `page.goto('/dashboard')`; `expect(getByTestId('dashboard')).toBeVisible()`.
3. Next Match tab → `expect(getByTestId('dash-next')).toBeVisible({timeout:25_000})`.
4. `expect(getByTestId('scout-heartbeat')).toBeVisible()`.
5. **GLOBAL stamp (genuinely driven by the inserted row regardless of anchoring):**
   `expect(getByTestId('scout-heartbeat-last')).not.toHaveText(/no reports yet/)`.
6. **Count for the anchored match — control the anchor:** select the inserted report's match
   via the match selector (`getByTestId('dash-next-match-select')` → `selectOption(matchKey)`)
   so the badge is for that match, THEN insert the report against that exact `match_key` and
   assert a real number: `expect(getByTestId('scout-heartbeat-count')).toContainText('1/')`
   (or `>= 1` parsed). If pinning the selector is impractical, fall back to asserting only
   step 5 (the global stamp) and drop the count assertion — do NOT ship a `toContainText('/')`
   that proves nothing.

Scenario B — **MatchView scouting-status drill-down**
1. Same active event; navigate to the Match tab. The tab label is exactly **`Match`**
   (verified: `DashboardScreen.tsx` line 35, `{ key: 'match', label: 'Match', … }`) and
   `IconTabs` renders `role="tab"` (verified: `src/components/ui/IconTabs.tsx` lines 33/46
   `role="tablist"`/`role="tab"`), so `page.getByRole('tab', { name: 'Match' }).click()`
   works.
2. Click the match item the inserted report belongs to (testid confirmed present:
   `MatchView.tsx` line 338 `match-item-${m.match_key}`):
   `getByTestId('match-item-{match_key}').click()`.
3. `expect(getByTestId('match-scout-status')).toBeVisible()`.
4. `expect(getByTestId(`match-scout-reported-${scoutId}`)).toBeVisible()`.
5. Assert the status title contains "synced".

Scenario C — **offline shows last-synced, not a crash** (reuses `sync.spec.ts` offline
pattern: `context.setOffline(true)`)

Assert ONLY the resilient invariant, NOT a specific surviving `X/Y`. On a hard reload,
TanStack Query rehydration from the IndexedDB-persisted cache races the first render: the
heartbeat may briefly show its zeroed default before `PersistQueryClientProvider` rehydrates
`['reports']`/`['scouts']`, and those queries (`enabled` stays true) will attempt a fetch
that fails offline. Asserting a specific cached count is exactly the timing flake that bites
single-worker live-DB specs.

1. Load dashboard online so the cache is warm; confirm `scout-heartbeat` visible (this also
   primes the persisted cache for the reload).
2. `await context.setOffline(true)`; `await page.reload()`.
3. `expect(getByTestId('scout-heartbeat')).toBeVisible({ timeout: 15_000 })` — the tile
   renders and there is **no `RouteError`** (`expect(getByTestId('route-error')).toHaveCount(0)`
   or equivalent). Do NOT assert a specific surviving `X/Y`.
4. If asserting the offline note, gate on its **testid being present**
   (`expect(getByTestId('scout-heartbeat')).toContainText(/offline/i)` only if the note
   testid renders), NOT on a count value.

> Caveat to verify during implementation: confirm `PersistQueryClientProvider`'s
> `buster`/`maxAge` in `App.tsx` actually rehydrates `['reports']`/`['scouts']` within the
> test window. If the warm-up in step 1 doesn't survive the reload (e.g. buster mismatch),
> the resilient-invariant assertion above still passes — that's why we assert only it.

(If `SyncIndicator.lastSyncedAt` is implemented: extend `sync.spec.ts` to assert
`getByTestId('sync-last')` appears after a successful sync.)

---

## 8. Conflict surface (overlap with the other 12 planned features)

Files this feature edits and who else touches them — coordinate ordering / merges:

| File | Also touched by | Note |
| --- | --- | --- |
| `src/dash/aggregate.ts` | **coverage-gaps**, **scouter-load-accuracy**, **multi-scout-reconciliation**, **distribution-trend** | HIGH-traffic. Add new exported pure fns ONLY; do NOT alter `aggregateTeam`/`TeamAgg`. **ENFORCED ordering, not aspirational:** this feature lands `coverageFromBucket`/`matchScoutCoverage`/`eventScoutCoverage` FIRST, with the §3 frozen signatures. coverage-gaps overlaps most (same "missing reports" idea) and MUST `import { eventScoutCoverage } from '@/dash/aggregate'` rather than re-implement — schedule coverage-gaps' `aggregate.ts` edit AFTER this feature's. If signatures must change later, change them here and update consumers, never fork a parallel helper. |
| `src/dash/types.ts` | **defense-analytics**, **matchup-intelligence**, **smart-picklist**, **multi-scout-reconciliation**, basically all dash features | Additive interfaces only (`MatchScoutCoverage`, `ScoutLite`). `MsrRow` untouched → no conflict if everyone stays additive. |
| `src/dash/NextMatchView.tsx` | **matchup-intelligence**, **alliance-simulator**, **auto-path-heatmap** | All insert into the same view. Land the smallest diff (one tile in the right column between the field tiles and Upcoming) and keep the insertion point distinct from the prediction/alliance grid those features touch. |
| `src/dash/MatchView.tsx` | **multi-scout-reconciliation**, **report-correction**, **match-video** | match-video already owns the video card; multi-scout-reconciliation will likely also add a per-match scout panel — coordinate so reconciliation EXTENDS `ScoutingStatusCard` rather than adding a second card. report-correction adds row actions in the report list (different sub-component). |
| `src/dash/useEventData.ts` | nearly every dash feature reads its hooks | This feature only ADDS a realtime `match_scouting_report` invalidation branch inside `useEventLiveSync`; keep it additive so it doesn't collide with other realtime edits. |
| `src/sync/useSync.ts`, `src/sync/SyncIndicator.tsx` | (mostly this feature alone) | Low conflict; `lastSyncedAt` is additive. |
| `src/dash/relativeTime.ts`, `src/dash/ScoutHeartbeat.tsx`, `src/dash/useMatchScoutCoverage.ts` | NEW — no conflict | distribution-trend/coverage-gaps may want `relativeTime`; export it cleanly for reuse. |

**Migration conflict:** this feature DOES add `supabase/migrations/0033_realtime_match_scouting_report.sql`.
The number `0033` must be **serialized against every other planned feature that needs a
migration** — only ONE feature can own `0033`; the rest take `0034+`. If the scheduler
assigns `0033` elsewhere, renumber this file to the next free slot (the migration body is
order-independent — it only adds a table to a publication). Coordinate the number before
parallel execution begins.

---

## 9. Step-by-step execution checklist

1. **Types** — add `ScoutLite` + `MatchScoutCoverage` to `src/dash/types.ts` (additive).
2. **Pure helpers** — add `coverageFromBucket`, `matchScoutCoverage`, `eventScoutCoverage`
   to `src/dash/aggregate.ts`; write/extend `src/dash/__tests__/aggregate.test.ts`; run
   `npx vitest run src/dash/__tests__/aggregate.test.ts`.
3. **relativeTime** — create `src/dash/relativeTime.ts` + `__tests__/relativeTime.test.ts`;
   run it green.
4. **Hook** — create `src/dash/useMatchScoutCoverage.ts` (`useEventScoutCoverage` +
   `useMatchScoutCoverage`) wrapping the existing `useEventReports`/`useEventScouts`; add a
   hook test with the data-module mock; run green.
5. **Presentational** — create `src/dash/ScoutHeartbeat.tsx` (pure, prop-driven, testids).
6. **NextMatchView** — wire `useEventScoutCoverage` + `useSync` + `useNow`, render
   `<ScoutHeartbeat/>` between the field-tile grid and Upcoming; extend
   `NextMatchView.test.tsx`.
7. **Migration + realtime branch** — (a) add `supabase/migrations/0033_realtime_match_scouting_report.sql`
   (publication add + `replica identity full`, §2); (b) add the additive
   `match_scouting_report` realtime branch in `useEventLiveSync` (a third chained
   `.on('postgres_changes', { table: 'match_scouting_report', filter: 'event_key=eq.…' }, …)`
   before `.subscribe()`, mirroring the existing `match` branch at `useEventData.ts`
   lines 509–516) that invalidates `['reports', eventKey]` (guarded no-op without
   `supabase.channel`). The branch is dead weight until the migration deploys.
8. **MatchView** — add `ScoutingStatusCard` + the left-list coverage marker; extend
   `MatchView.test.tsx`.
9. **(Optional) Sync surfacing** — add `lastSyncedAt` to `useSync.ts` + render in
   `SyncIndicator.tsx`; extend `useSync` test.
10. **Typecheck + full unit suite** — `npm run typecheck` then `npm test`.
11. **E2E** — write `tests/e2e/heartbeat.spec.ts` (Scenarios A–C); run
    `npx playwright test tests/e2e/heartbeat.spec.ts` (single worker, live `2026casnv`);
    confirm cleanup in `afterAll`.
12. **Deploy the migration** — `supabase db push` to apply `0033_realtime_match_scouting_report.sql`
    (the standing auto-deploy instruction). Confirm it landed (`supabase migration list` or the
    Supabase dashboard publication shows `match_scouting_report`), THEN verify Scenario A's
    realtime refresh works. **Do NOT add a `0033` MEMORY.md deploy note until `db push`
    confirms success** (per repo convention — MEMORY tracks only confirmed-deployed
    migrations). No edge function changes. Frontend ships via Vercel on merge to `main`.
