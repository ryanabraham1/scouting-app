# Matchup Intelligence — Alliance Matchup Synthesis + Per-Opponent Notes

Feature owner doc / execution-ready implementation plan.
Target app: offline-first FRC scouting PWA (team 3256, REBUILT 2026).

---

## 1. Overview & exact user-facing behavior

Two distinct-but-adjacent capabilities, both surfaced on the **Next Match** dashboard tab
(`NextMatchView`, `data-testid="dash-next"`), slotted **directly below the `WinProbBanner` and
above the two `AllianceColumn` cards**.

### 1a. Alliance Matchup Synthesis (read-only, auto-computed)
A new `MatchupPanel` card synthesizes the two alliances' `TeamAgg` aggregates (already computed
by `aggregateEvent`) into short, imperative tactical bullets. Pure, deterministic, no network.

Exact behavior:
- The panel shows two columns: **"Exploit (Red weaknesses)"** and **"Watch (Red threats)"** for the
  alliance we are NOT on, mirrored for the alliance we ARE on as **"Our edges"** / **"Our risks"**.
  Labeling pivots on `baseTeam`: the opponent alliance is framed as exploit/watch; our alliance is
  framed as edges/risks. (Same data, different verbs — keeps coaching language natural.)
  - **When `baseTeam` is in NEITHER alliance** of the viewed match (a manually selected match, or an
    event 3256 isn't attending), there is no "our" side — `ourAllianceIsRed` would be a misleading
    `false`. In that case the panel uses **neutral per-color labels** ("Red threats / Red weaknesses",
    "Blue threats / Blue weaknesses") instead of the exploit/edges framing, so nothing is mislabeled.
- Each bullet is a phrase derived from a threshold rule, e.g.:
  - `"Contest 254's L3 climb"` (a reliable high climber to deny),
  - `"Deny the feed lane — 1678 feeds heavily"`,
  - `"148 is a fragile robot (40% reliability) — pressure early"`,
  - `"Weak defense across their alliance — free shooting lanes"`,
  - `"Low fuel output (28 pts/match) — they rely on climb"`.
- Each bullet carries a small severity dot (high/med via Tailwind color) and the driving team
  number so the coach can tie it to a robot.
- When an alliance has **zero scouted matches** for all three teams, that side shows
  `"No scouting data yet"` (graceful — never blank, never throws).
- The panel **re-renders whenever `reportsQ.data` changes** (it reads the same `agg` map already
  built in `NextMatchView`), so guidance sharpens as matches are scouted. No extra query key.

### 1b. Per-Opponent Matchup Notes (free-text, persisted, resurfacing)
Below the synthesis bullets, each panel shows a **Notes** sub-section, one editable free-text note
**per (event, our-alliance, their-alliance) pairing keyed by the opponent alliance's lead team**
(see §2 for the exact key decision). A pencil/notes button opens `MatchupNotesModal`.

Exact behavior:
- Tapping **"Notes"** (`data-testid="matchup-notes-btn"`) opens a modal/sheet with a `<textarea>`
  pre-filled with the existing note (from cache → server).
- **Save** writes to Dexie immediately (`syncState: 'dirty'`), closes the modal, and the bullet
  area shows the note inline with a small **"unsynced"** chip until the outbox confirms.
- The note **resurfaces** the next time we face that opponent team at the same event: the key is
  `(event_key, our_lead_team, opp_lead_team)`, so any future match against the same opponent lead
  team shows the same note. (Cross-event persistence is an explicit non-goal for v1 — see §2.)
- A small **badge** appears on the opponent alliance column header (`data-testid="matchup-note-badge"`)
  whenever a non-empty note exists for that matchup, so the coach knows there's history without
  opening the modal.
- Fully offline: reads come from Dexie cache; writes queue in Dexie and drain through the existing
  sync controller when back online.

Non-goals (v1): cross-event note carry-over, per-robot (non-lead) note granularity, editing the
auto-synthesis bullets, retrospective "we said X, they did Y" scoring.

---

## 2. Data model

A new migration **IS** needed (a new table + RPC + history + RLS).

### Key decision (resolves the open question)
v1 is **event-scoped**, keyed on the **alliance lead teams**, not all six robots: PK
`(event_key, our_team, opp_team)` where `our_team`/`opp_team` are the **lowest team number** on
each alliance (a stable, order-independent alliance identifier that survives station shuffles).
This caps rows at roughly (teams choose 2) per event and means a note resurfaces for ANY future
match pitting the same two alliance-lead teams at that event. Cross-event carry-over is deferred;
if later desired, add a `season` table keyed `(year, our_team, opp_team)` in a follow-up migration —
do not rework this one.

> Note on terminology: "red/blue" is NOT used in the key because alliance color is not stable across
> a matchup pairing and is meaningless for resurfacing. We normalize to `(our_team, opp_team)` where
> `our_team = min(our alliance teams)` and `opp_team = min(their alliance teams)`, computed client-side
> in `matchupNotesClient.ts` so the server stays a dumb keyed store.
>
> Known v1 limitation (documented, accepted): `min()` is order-independent but NOT
> lineup-revision-independent. If the schedule is revised (surrogate/backup robots, playoff alliance
> shuffles) such that the lead (min) team of an alliance changes, the note re-keys and may not
> resurface, or may attach to a different pairing. The `MatchupNotesModal` header therefore shows the
> key explicitly (e.g. "Notes vs alliance lead {oppLead}") so a coach understands WHY a note may not
> resurface after a lineup change. Robust lineup-revision-independent keying is deferred.

### Migration: `supabase/migrations/0033_matchup_notes_table.sql`

> DEPLOYMENT: **DO NOT mark 0033 as deployed** in the memory dir. Author it, `npm run typecheck` +
> tests green, then the human runs `supabase db push`. The latest deployed migration is 0032.

```sql
-- 0033_matchup_notes_table.sql — per-opponent matchup notes (Strategy/coaching).
-- One free-text note per (event, our-alliance-lead, their-alliance-lead). Event-scoped.
-- RLS mirrors the EFFECTIVE msr/pit read path (0009 `msr_read_open`/`pit_read_open`),
-- NOT the 0003 `*_read_member` policies. CRITICAL: the dashboard authors+reads these
-- notes from a SILENT ANONYMOUS session (ensureAnonSession.ts) that never picks a
-- scouter, so it has NO scout row and `get_my_event_keys()` returns EMPTY for it. A
-- member-scoped read policy would therefore return ZERO notes to the dashboard, and a
-- member-gated RPC would silently no-op every write — exactly the bug 0009 fixed when
-- it added the open `to anon, authenticated using (true)` read policies. So: READ is
-- OPEN (single-team internal app, scouting data is openly readable). WRITES go ONLY
-- through the SECURITY DEFINER upsert RPC (granted anon+authenticated, bypasses RLS)
-- with the monotonic row_revision guard + history snapshot, exactly like
-- upsert_pit_report (0031) — which itself has NO event-membership gate. Re-apply safe:
-- create-if-not-exists / drop-policy-if-exists.

create table if not exists matchup_note (
  event_key   text   not null references event(event_key) on delete cascade,
  our_team    int    not null,
  opp_team    int    not null,
  note        text   not null default '',
  row_revision bigint not null default 1,   -- caller sends local updatedAt epoch-ms (monotonic across authors)
  updated_at  timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  author_scout_id uuid,                      -- advisory; nulled if orphaned (never FK-fails the write)
  deleted     boolean not null default false,
  primary key (event_key, our_team, opp_team)
);

-- History so any overwrite is recoverable (mirrors pit_report_history).
create table if not exists matchup_note_history (
  id         bigint generated always as identity primary key,
  event_key  text not null,
  our_team   int  not null,
  opp_team   int  not null,
  snapshot   jsonb not null,
  archived_at timestamptz not null default now()
);

-- Lookup by either side of the pairing for fast resurfacing.
create index if not exists idx_matchup_note_event_our on matchup_note (event_key, our_team);
create index if not exists idx_matchup_note_event_opp on matchup_note (event_key, opp_team);

alter table matchup_note enable row level security;
alter table matchup_note_history enable row level security;

-- READ: OPEN to anon + authenticated, mirroring 0009's msr_read_open/pit_read_open.
-- (The dashboard reads as a scouter-less anon session; a member-scoped read would
-- return nothing to it. Single-team internal app => scouting data is openly readable.)
drop policy if exists matchup_note_read_open on matchup_note;
create policy matchup_note_read_open on matchup_note
  for select to anon, authenticated
  using (true);

-- No client INSERT/UPDATE/DELETE policy: all writes flow through the RPC below.
-- history has NO policies -> default deny to the client (only the SECURITY DEFINER RPC writes it).

-- SECURITY DEFINER upsert with the monotonic revision guard + history snapshot.
-- Mirrors upsert_pit_report (0031) exactly: write only when strictly newer; equal/stale = no-op.
create or replace function upsert_matchup_note(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text   := p->>'event_key';
  v_our int          := (p->>'our_team')::int;
  v_opp int          := (p->>'opp_team')::int;
  v_note text        := coalesce(p->>'note', '');
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing_rev bigint;
  v_author uuid      := nullif(p->>'author_scout_id', '')::uuid;
begin
  -- Defense-in-depth: validate the event EXISTS rather than gating on a scout-row-
  -- derived membership. The dashboard authors notes from a scouter-less anon session,
  -- so `get_my_event_keys()` is EMPTY for it — a membership gate here would silently
  -- no-op EVERY dashboard write (data loss, and the outbox would even mark it synced
  -- because the RPC returns void). upsert_pit_report (the RPC we mirror) has no such
  -- gate for exactly this reason. We validate event existence only.
  if v_event_key is null or not exists (select 1 from event e where e.event_key = v_event_key) then
    return;
  end if;

  -- Author is advisory — never let an orphaned scout id FK/consistency-fail the write.
  if v_author is not null and not exists (select 1 from scout s where s.id = v_author) then
    v_author := null;
  end if;

  select row_revision into v_existing_rev
  from matchup_note
  where event_key = v_event_key and our_team = v_our and opp_team = v_opp;

  -- Stale OR duplicate resync: do not clobber a newer/equal note (the data-loss guard).
  if v_existing_rev is not null and v_incoming_rev <= v_existing_rev then
    return;
  end if;

  if v_existing_rev is null then
    insert into matchup_note (
      event_key, our_team, opp_team, note, row_revision,
      updated_at, server_received_at, author_scout_id, deleted
    ) values (
      v_event_key, v_our, v_opp, v_note, v_incoming_rev,
      now(), now(), v_author, false
    );
  else
    insert into matchup_note_history (event_key, our_team, opp_team, snapshot)
    select v_event_key, v_our, v_opp, to_jsonb(mn)
    from matchup_note mn
    where mn.event_key = v_event_key and mn.our_team = v_our and mn.opp_team = v_opp;

    update matchup_note set
      note = v_note,
      row_revision = v_incoming_rev,
      updated_at = now(),
      server_received_at = now(),
      author_scout_id = v_author,
      deleted = false
    where event_key = v_event_key and our_team = v_our and opp_team = v_opp;
  end if;
end;
$$;

grant execute on function upsert_matchup_note(jsonb) to anon, authenticated;
```

Wire shape sent to the RPC (snake_case, NOT routed through `mapReport.ts` — see §4):
```json
{ "event_key": "2026casnv", "our_team": 3256, "opp_team": 254,
  "note": "deny their feed lane", "row_revision": 1719700000000, "author_scout_id": "<uuid|null>" }
```

---

## 3. Files to create / modify

| Path | Precise change |
|---|---|
| `supabase/migrations/0033_matchup_notes_table.sql` | **NEW.** Full SQL above: `matchup_note` + `matchup_note_history` tables, indexes, RLS read policy, `upsert_matchup_note(jsonb)` SECURITY DEFINER RPC. Do NOT mark deployed. |
| `src/db/types.ts` | **ADD** two interfaces. `MatchupNoteRow` (server read shape: `event_key, our_team, opp_team, note, row_revision, updated_at, author_scout_id: string \| null, deleted`). `LocalMatchupNote` (Dexie draft: `key: string` = `${eventKey}:${ourTeam}:${oppTeam}`, `eventKey, ourTeam, oppTeam, note, updatedAt: string, authorScoutId: string \| null, syncState: 'dirty'\|'pending'\|'synced'\|'error', syncAttempts: number, lastSyncError: string \| null`). `author_scout_id`/`authorScoutId` back the "last edited by" surfacing (§4c). |
| `src/db/localStore.ts` | **ADD** `matchupNotes!: Table<LocalMatchupNote, string>` to `ScoutingDb`. Add a **new Dexie version** that redeclares ALL prior stores unchanged + adds `matchupNotes: 'key, eventKey, syncState, ourTeam, oppTeam'`. **VERSION NUMBER IS A HARD MERGE-GATE** (see §8): the live file currently has only `version(1)`/`version(2)` and no sibling has claimed `version(3)` yet, so this feature uses `this.version(3)` IF it merges first; whichever of {this, report-correction, multi-scout-reconciliation} merges later MUST bump to `version(4)`/`version(5)` and redeclare prior stores — a duplicate `version(3)` with a different `stores()` throws `VersionError` on DB open and breaks ALL local storage app-wide (reports/drafts/preload), not just notes. Add helpers mirroring the report queue: `saveMatchupNoteLocal`, `getMatchupNote(key)`, `listMatchupNotesForEvent(eventKey)`, `getMatchupSyncQueue`, `listMatchupDeadLetters`, `markMatchupPending/Synced/DirtyRetry/SyncError`, `requeueAuthClassMatchupDeadLetters`. |
| `src/dash/aggregate.ts` | **ADD** `export function synthesizeMatchupGuidance(redAggs, blueAggs): MatchupGuidance` + the `MatchupGuidance`/`Tactic` types. Pure; thresholds in §4. Takes arrays of `(TeamAgg \| undefined)` (undefined = unscouted team) so it degrades. Existing exports untouched. |
| `src/dash/aggregate.test.ts` (or `src/dash/__tests__/aggregate.test.ts`) | **ADD** unit tests for `synthesizeMatchupGuidance` (see §7). |
| `src/dash/matchupNotesClient.ts` | **NEW.** `normalizeMatchup(ourTeams, oppTeams): {ourTeam, oppTeam}` (= the two `min()` leads); `keyFor(eventKey, ourTeam, oppTeam): string`; `fetchMatchupNotesForEvent(eventKey): Promise<MatchupNoteRow[]>` (PostgREST select, RLS-scoped); `saveMatchupNote(eventKey, ourTeams, oppTeams, note)` → normalize, write to Dexie `dirty`, then `syncNow` opportunistically. Server write goes through the RPC in the sync file (not here) to keep the offline path single. |
| `src/dash/useEventData.ts` | **ADD** `useMatchupNotes(eventKey): UseQueryResult<Map<string, string>>` returning a key→note map. queryFn does the server select first, then merges **Dexie-local (authoritative for dirty/pending)** over server rows so an unsynced edit shows immediately. **On select failure, distinguish offline from server error** (see §6): `navigator.onLine === false` → return Dexie-only as a graceful fallback; otherwise **rethrow** (mirroring `useEventReports`, which throws on `error`) so TanStack keeps the last good persisted snapshot instead of overwriting it with a partial/empty map that would hide teammates' synced notes until `staleTime` expires. queryKey `['matchup-notes', eventKey]`. staleTime `STALE_TIME`. NOTE: the returned `Map` survives the persisted cache — `queryPersist.ts` already tags Maps/Sets in its custom serialize/deserialize (MAP_TAG), so a `Map<string,string>` round-trips correctly; no plain-object conversion is required. |
| `src/sync/matchupNotesSync.ts` | **NEW.** `syncMatchupNotesOnce(): Promise<MatchupSyncSummary>`. Drain `getMatchupSyncQueue()`; for each: `markMatchupPending`, build wire shape via `normalizeMatchup` already baked into the key, `revision = Date.parse(updatedAt) \|\| Date.now()`, `supabase.rpc('upsert_matchup_note', { p })`; on error classify via `classifySyncError` (transient→`markMatchupDirtyRetry` under `SYNC_MAX_ATTEMPTS`, else `markMatchupSyncError`); on success `markMatchupSynced`. Mirrors `pitOutbox.ts`. |
| `src/sync/useSync.ts` | **WIRE IN** (highest-attention shared file — report-correction + multi-scout-reconciliation also edit the same arrays; merge by concatenation, hand-resolve every conflict so no drain is dropped). Add `await syncMatchupNotesOnce()` in `run()` after `syncPitOnce()` (currently lines ~68-69); add `getMatchupSyncQueue()`/`listMatchupDeadLetters()` to the `refreshCounts` `Promise.all` (currently line ~52) and fold their lengths into `queued`/`deadLetters`; add `requeueAuthClassMatchupDeadLetters()` to the once-per-session requeue `Promise.all` (currently lines ~109-111). |
| `src/dash/MatchupPanel.tsx` | **NEW.** Renders the synthesis bullets (from `synthesizeMatchupGuidance`) + per-alliance Notes sub-section + note badge + the trigger button that opens `MatchupNotesModal`. Props: `{ eventKey, redTeams, blueTeams, ourSide: 'red' \| 'blue' \| null, redAggs, blueAggs }`. **`ourSide === null` (baseTeam not in this match):** do NOT use the exploit/watch-vs-edges/risks "ours/theirs" framing (it would mislabel) — fall back to neutral per-alliance labels ("Red threats / Red weaknesses", "Blue threats / Blue weaknesses") and key notes with the lower-lead alliance as `our_team` deterministically (`normalizeMatchup` is symmetric on min, so the pairing key is still stable; the modal header reflects whichever lead is shown). `data-testid="dash-matchup-panel"`. |
| `src/dash/MatchupNotesModal.tsx` | **NEW.** Controlled modal/sheet (shadcn `Sheet` or `Dialog`) with `<textarea data-testid="matchup-notes-textarea">`, Save (`matchup-notes-save`) / Cancel. Calls `saveMatchupNote` then invalidates `['matchup-notes', eventKey]`. |
| `src/dash/NextMatchView.tsx` | **MOUNT** `<MatchupPanel ... />` between `<WinProbBanner/>` and the `AllianceColumn` grid. Pass `redTeams`/`blueTeams` (already computed), `agg` per alliance (reuse `agg.get(t)`), and the base team. **Handle baseTeam-not-in-match:** `ourAllianceIsRed = redTeams.includes(baseTeam)` is `false` BOTH when 3256 is on blue AND when 3256 is not in the viewed match at all (manual match selection, or an event 3256 isn't attending) — naively passing `ourSide` would silently mislabel blue as "ours". Compute and pass `ourSide: 'red' \| 'blue' \| null`: `null` when `baseTeam` is in neither alliance. Pass it through so `MatchupPanel` uses neutral labels in that case (see below). |
| `src/dash/__tests__/MatchupPanel.test.tsx` | **NEW.** Component tests (see §7). |
| `src/sync/__tests__/matchupNotesSync.test.ts` | **NEW.** Sync unit tests (see §7). |
| `tests/e2e/matchup.spec.ts` | **NEW.** Playwright e2e (see §7). |

---

## 4. Core logic

### 4a. `synthesizeMatchupGuidance` (pure, in `aggregate.ts`)

Types:
```ts
export type TacticSeverity = 'high' | 'med';
export interface Tactic {
  teamNumber: number;        // the robot the tactic is about
  kind: 'climb' | 'feed' | 'fuel' | 'defense' | 'fragile';
  severity: TacticSeverity;
  text: string;              // imperative coaching phrase
}
export interface AllianceGuidance {
  threats: Tactic[];   // what to WATCH (their strengths)
  exploits: Tactic[];  // what to EXPLOIT (their weaknesses)
  scouted: boolean;    // false when no team on the alliance has matchesScouted > 0
}
export interface MatchupGuidance { red: AllianceGuidance; blue: AllianceGuidance; }
```

Algorithm per alliance (over the up-to-3 `TeamAgg`, skipping `undefined`/`matchesScouted === 0`):

Thresholds (constants at top of function; tuned for REBUILT magnitudes — `SCORING.CLIMB` L3 teleop = 30):
```
RELIABLE_CLIMB_RATE   = 0.6     // climbSuccessRate
HIGH_CLIMB_LEVEL      = 2.5     // avgClimbLevel
UNRELIABLE_CLIMB_RATE = 0.4
HEAVY_FEED_FUEL       = 25      // meanTeleopFuelInactive (fuel scored while feeder/inactive lane busy)
LOW_FUEL_PTS          = 30      // fuelPointsWeighted per match
STRONG_DEFENSE        = 1.5     // avgDefenseRating (0-3)
FRAGILE_RELIABILITY   = 0.6     // reliability = clamp01(1 - noShowRate - diedRate)
```

THREATS (per scouted team):
- climb: if `climbSuccessRate >= RELIABLE_CLIMB_RATE && avgClimbLevel >= HIGH_CLIMB_LEVEL`
  → high, `"Contest {team}'s L{round(avgClimbLevel)} climb"`.
- feed: if `meanTeleopFuelInactive >= HEAVY_FEED_FUEL`
  → med, `"Deny the feed lane — {team} feeds heavily"`.
- defense: if `avgDefenseRating >= STRONG_DEFENSE`
  → med, `"{team} plays defense ({avgDefenseRating.toFixed(1)}/3) — protect our shooter"`.
- fuel-strength: if `fuelPointsWeighted >= 2 * LOW_FUEL_PTS`
  → high, `"{team} is a heavy scorer (~{round(fuelPointsWeighted)} fuel pts) — pressure their cycle"`.

EXPLOITS (per scouted team):
- fragile: if `reliability < FRAGILE_RELIABILITY`
  → high, `"{team} is fragile ({pct(reliability)} reliable) — pressure early"`.
- weak-climb: if `climbSuccessRate < UNRELIABLE_CLIMB_RATE`
  → med, `"{team} rarely climbs ({pct(climbSuccessRate)}) — they may forfeit endgame"`.
- low-fuel: if `fuelPointsWeighted < LOW_FUEL_PTS`
  → med, `"{team} scores little fuel (~{round(fuelPointsWeighted)} pts) — leans on climb/defense"`.

Alliance-level rollups (added once, not per team):
- if EVERY scouted team has `avgDefenseRating < 0.5` → exploit, kind `defense`, severity med,
  `teamNumber: 0`, `"Weak defense across the alliance — free shooting lanes"`.

Sorting: within each list, `high` before `med`; stable by team number. Cap each list at 4 items.
`scouted = aggs.some(a => a && a.matchesScouted > 0)`.

The function is **pure and reads only `TeamAgg`** — no new server compute, no scoring duplication.
The `SCORING.CLIMB` magnitudes are referenced only via existing `TeamAgg.fuelPointsWeighted` /
`meanClimbPoints`; thresholds are display heuristics, NOT scoring values, so the
client-display-only / server-recompute boundary is unaffected.

### 4b. mapReport / scoring consistency
- **`mapReport.ts` is NOT touched.** It is the wire shape for match reports only. Matchup notes use
  their own dedicated RPC `upsert_matchup_note` with its own JSON shape (§2). This preserves the
  "single source of the match-report wire shape" invariant.
- **`src/scoring/` is NOT touched.** No new scored quantity is introduced; synthesis is heuristic
  display logic over already-aggregated values. No `SCHEMA_VERSION` bump, no server scoring change.

### 4c. Revision guard (note conflict resolution)
`row_revision = Date.parse(localUpdatedAt)` (epoch-ms, monotonic with edit time, comparable across
devices). The RPC writes only when strictly newer; equal/older is a no-op (idempotent re-send safe,
stale resync can't clobber). Two devices saving within the same ms is unlikely for a manual note;
if it happens the first-applied wins and the second is dropped (documented LWW-by-ms), same
semantics as `upsert_pit_report`. Two near-simultaneous edits on a hot opponent (strategy lead +
scout on a shared kiosk within a polling window) is plausible enough that the overwrite must be at
least *visible*: the panel surfaces the `matchup-note-unsynced` → synced transition clearly, and the
note row shows "last edited" from `author_scout_id` (resolved to scouter name when available) so a
silent overwrite is observable. Full conflict merging is out of scope for v1.

---

## 5. UI / UX

- **Where:** `NextMatchView` (Dashboard → Next Match tab), inserted **between `<WinProbBanner>` and
  the `AllianceColumn` grid**. Visible in both fullscreen kiosk and normal layouts (it's inside the
  scrollable `dash-next` container).
- **`MatchupPanel`** (`data-testid="dash-matchup-panel"`): a shadcn `Card` titled
  **"Alliance Matchup"** with a two-column body. Left column = the OPPONENT alliance framed as
  "Exploit / Watch"; right column = OUR alliance framed as "Our edges / Our risks". Each column:
  - severity-dotted bullet list of `Tactic.text` (high = `text-warning`/red dot, med = muted dot),
  - empty state `"No scouting data yet"` when `!guidance.<side>.scouted`,
  - a **Notes** footer row: the current note text (truncated, `data-testid="matchup-note-text"`) +
    a **"Notes"** button (`data-testid="matchup-notes-btn"`) opening the modal. The opponent column
    header shows a small dot badge (`data-testid="matchup-note-badge"`) when a note exists.
- **`MatchupNotesModal`** (shadcn `Sheet` from the right, or `Dialog`): header
  `"Notes vs alliance lead {oppLead}"` (the explicit "alliance lead" wording documents the min-keyed
  resurfacing limitation from §2 to the coach),
  a full-height `<textarea data-testid="matchup-notes-textarea">`, **Save**
  (`data-testid="matchup-notes-save"`) and **Cancel**. Save is disabled while a write is in flight.
- **States:** loading (notes query pending) → show synthesis immediately, notes area shows a thin
  skeleton; loaded; **unsynced** (Dexie `dirty`/`pending`) → an inline
  `data-testid="matchup-note-unsynced"` chip next to the note; **error** (dead-letter) → reuse the
  global SyncIndicator dead-letter count (no separate UI needed for v1).
- Mobile: the two columns stack (`grid-cols-1 md:grid-cols-2`), matching the existing
  `AllianceColumn` grid.

---

## 6. Offline behavior

- **Reads:** `useMatchupNotes` merges Dexie-local notes over the server query. The error path is
  branched (this matters — a blind catch poisons the persisted cache): on a select failure the
  queryFn checks `navigator.onLine`. If **offline** (`navigator.onLine === false`), it returns
  **Dexie-only** notes (cached drafts + previously-synced rows persisted locally) as a graceful
  fallback. If the select fails while **online** (a transient server/PostgREST error), it
  **rethrows** — so TanStack keeps the last good persisted snapshot rather than overwriting it with
  a partial map that may be missing teammates' synced notes (authored on another device) and
  serving that stale-incomplete map as authoritative until `staleTime` expires. This mirrors
  `useEventReports`, which throws on error rather than swallowing.
  The TanStack persisted cache (IndexedDB via `queryPersist`, which tags Maps so the key→note
  `Map` round-trips) rehydrates the last server snapshot on offline reload, so the panel never
  blanks. The synthesis bullets need only `reportsQ.data`, which is already persisted — guidance
  works fully offline.
- **Writes:** `saveMatchupNote` writes to Dexie with `syncState: 'dirty'` **before** any network
  call and resolves immediately, so saving offline always succeeds locally. The note shows the
  **unsynced** chip. `useSync` drains it on the next online edge / poll / `syncNow`, idempotently
  (revision guard). A lost device with an unsynced note shows the chip as the warning surface
  (matches the documented pit-note risk mitigation).
- **Degrade-gracefully:** the synthesis path and the write path return a value / no-op rather than
  throwing. The READ path does NOT follow the `proxies.ts` `{available:false}` sentinel pattern —
  notes use a direct PostgREST/RPC, not an Edge proxy — it follows `useEventReports`' error
  semantics: swallow only the offline case, rethrow a true server error so the persisted snapshot is
  preserved (see Reads above). Either way the app-wide `RouteError` single-boundary plus the
  rehydrated persisted cache mean a notes outage never blanks `dash-next`.

---

## 7. Test plan

### Unit (Vitest)
`src/dash/__tests__/aggregate.test.ts` — `synthesizeMatchupGuidance`:
1. Reliable high climber (`climbSuccessRate 0.8, avgClimbLevel 2.7`) → a `kind:'climb'`,
   `severity:'high'` threat whose `text` contains `"Contest"` and the team number and `"L3"`.
2. Fragile robot (`noShowRate 0.3, diedRate 0.2` ⇒ reliability 0.5) → `kind:'fragile'` exploit,
   `text` contains `"fragile"` and `"50%"`.
3. Heavy feeder (`meanTeleopFuelInactive 40`) → `kind:'feed'` threat containing `"feed lane"`.
4. All-`undefined`/`matchesScouted:0` alliance → `scouted === false`, both lists empty.
5. Low-fuel team (`fuelPointsWeighted 12`) → `kind:'fuel'` exploit; and the alliance-wide
   weak-defense rollup fires once (`teamNumber:0`) when all defense ratings < 0.5.
6. Each list capped at 4; `high` sorted before `med`.

`src/sync/__tests__/matchupNotesSync.test.ts` (mirror `outbox.test.ts`/`pitOutbox.test.ts`):
1. Dirty note → `supabase.rpc('upsert_matchup_note', ...)` called with normalized
   `{event_key, our_team, opp_team, note, row_revision}`; on success `markMatchupSynced`.
2. Transient error under `SYNC_MAX_ATTEMPTS` → `markMatchupDirtyRetry`, attempts bumped.
3. Transient at max attempts / terminal error → `markMatchupSyncError` (dead-letter).
4. Idempotent re-send (already synced) → not in queue, no RPC call.

`src/dash/__tests__/MatchupPanel.test.tsx`:
1. Given red/blue `TeamAgg` maps + a `useMatchupNotes` mock, renders `dash-matchup-panel` with the
   expected bullet text and the `matchup-note-badge` when a note exists.
2. No scouting data → renders `"No scouting data yet"`, no crash.
3. Clicking `matchup-notes-btn` opens the modal (textarea visible); typing + Save calls the
   `saveMatchupNote` spy with normalized team leads and closes.
4. `ourSide={null}` (baseTeam in neither alliance) → renders neutral per-color labels
   ("Red threats"/"Blue threats"), NOT "Our edges"/"Our risks"; no mislabeling, no crash.

`src/db/localStore` queue helpers + **BLOCKING Dexie-upgrade safety test**: seed `reports` and
`drafts` rows under the prior schema, open the DB at the new version, and assert those rows are
still readable (the upgrade must not drop or corrupt existing local data) AND that
`getMatchupSyncQueue` returns only dirty/pending notes. This test is a merge-gate for the
version-number collision risk in §8 — it must be green before merge, not best-effort.

### Playwright e2e — `tests/e2e/matchup.spec.ts` (single-worker, live `2026casnv`)
Follows `dashboard.spec.ts` conventions (`setActiveEvent(admin, '2026casnv')` in setup, no login).

> CRITICAL — avoid a false green. `page.reload()` does NOT clear IndexedDB, so a passing
> `matchup-note-text` assertion after reload could be served entirely from the Dexie-local note
> even if NOTHING reached the server (the exact failure mode of the original RLS/RPC bugs). The
> spec MUST verify server persistence independently. Two complementary checks are used: (a) clear
> the Dexie DB before reload so a resurfaced note can ONLY come from the server, AND (b) query the
> server directly with the admin client. An `afterAll` MUST delete the row(s) this spec writes so
> they don't accumulate in the shared live `2026casnv` DB and make `.first()` assertions match
> stale rows on reruns.

```ts
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setActiveEvent } from './helpers';

// Build the service-role admin client locally, exactly as dashboard.spec.ts does
// (admin is NOT exported from helpers; only setActiveEvent is). loadEnv()/URL/SECRET
// are pulled the same way dashboard.spec.ts sets them up.
loadEnv();
const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { persistSession: false },
});

// Track keys we write so afterAll can clean them out of the shared live DB.
const writtenNotePrefixes: string[] = [];

test.afterAll(async () => {
  // Remove every matchup_note this spec created (note text carries our unique marker).
  for (const marker of writtenNotePrefixes) {
    await admin.from('matchup_note').delete().like('note', `%${marker}%`);
  }
});

test('synthesis panel + per-opponent note PERSISTS TO SERVER and resurfaces', async ({ page }) => {
  await setActiveEvent(admin, '2026casnv');
  await page.goto('/dashboard');                 // lands on Next Match tab (dash-next)
  await expect(page.getByTestId('dash-next')).toBeVisible();
  // 1. Synthesis panel renders below the win-prob banner.
  const panel = page.getByTestId('dash-matchup-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Alliance Matchup');
  // 2. Open notes, type, save.
  await panel.getByTestId('matchup-notes-btn').first().click();
  await expect(page.getByTestId('matchup-notes-textarea')).toBeVisible();
  const marker = `m8r-${Date.now()}`;
  const note = `deny feed lane ${marker}`;
  writtenNotePrefixes.push(marker);
  await page.getByTestId('matchup-notes-textarea').fill(note);
  await page.getByTestId('matchup-notes-save').click();
  // 3. Note shows inline + a badge appears for that matchup (local immediate).
  await expect(page.getByTestId('matchup-note-text').first()).toContainText('deny feed lane');
  await expect(page.getByTestId('matchup-note-badge').first()).toBeVisible();
  // 4. SERVER persistence — independent of any local cache. Poll the live DB via the
  //    admin client until the outbox has drained the write through upsert_matchup_note.
  //    This is the assertion the original RLS/RPC bugs would have failed.
  await expect.poll(async () => {
    const { data } = await admin
      .from('matchup_note')
      .select('note')
      .eq('event_key', '2026casnv')
      .like('note', `%${marker}%`);
    return data?.length ?? 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
  // 5. Resurface from SERVER ONLY: nuke local Dexie so the note cannot come from cache.
  await page.evaluate(() => indexedDB.deleteDatabase('scouting-db'));
  await page.reload();
  await expect(page.getByTestId('dash-matchup-panel')).toBeVisible();
  await expect(page.getByTestId('matchup-note-text').first()).toContainText('deny feed lane');
});
```

Optional offline scenario: save a note while offline → assert the `matchup-note-unsynced` chip is
visible → go online → assert the chip clears after a sync poll. Toggle the network with
`page.context().setOffline(true)` / `setOffline(false)` directly, as `capture.spec.ts` and
`simulation.spec.ts` do. (There is NO shared network-toggle helper — `sync.spec.ts` only tests the
online round-trip and has no offline usage to gate behind.)

> If `2026casnv` has no scouting reports at e2e time, the panel still renders with
> `"No scouting data yet"`; the note flow is independent of scouting data, so the spec above does
> not depend on reports existing. Demo mode (`2026demo`) is an alternative target if richer data is
> needed.

---

## 8. Conflict surface (overlap with the other 12 features)

Files this feature touches and which sibling features also touch them — coordinate / merge-order:

| Shared file | Also touched by | Conflict & mitigation |
|---|---|---|
| `src/dash/NextMatchView.tsx` | **alliance-simulator** (adds a sim panel/controls), **defense-analytics** (defense badges in AllianceColumn), **dashboard-heartbeat** (live freshness banner), **auto-path-heatmap** (auto path overlay) | All insert into the same `dash-next` render tree. Mitigation: this feature inserts a single self-contained `<MatchupPanel/>` at one anchor (below `WinProbBanner`). Keep each feature's insertion to its own JSX block + testid; resolve by stacking blocks, not interleaving. |
| `src/dash/aggregate.ts` | **defense-analytics** (may add defense aggregates), **distribution-trend** (per-match series), **smart-picklist** (composite scores) | All ADD new exports; none should mutate `TeamAgg`/`aggregateTeam`. Mitigation: append-only exports; if defense-analytics adds fields to `TeamAgg`, `synthesizeMatchupGuidance` only reads existing fields, so additive. |
| `src/dash/useEventData.ts` | **defense-analytics**, **coverage-gaps**, **scouter-load-accuracy**, **distribution-trend**, **dashboard-heartbeat** (all add hooks) | All ADD `useX` hooks. Mitigation: append-only; new `useMatchupNotes` is independent. |
| `src/sync/useSync.ts` | **report-correction** (adds correction outbox), **multi-scout-reconciliation** (adds reconcile drain) | All wire a new `syncXOnce()` into `run()` + counts. Mitigation: each adds one call + folds its queue length; merge by concatenation. **Highest-attention shared file.** |
| `src/db/localStore.ts` + `src/db/types.ts` | **report-correction**, **multi-scout-reconciliation** (new Dexie tables + queue helpers) | Dexie `version()` bump collisions — **BLOCKING merge-gate, not a soft coordinate-later note.** Two features shipping the SAME `version(3)` with different `stores()` makes Dexie throw `VersionError`/`SchemaError` on `db.open()`, and the WHOLE `scouting-db` (reports, drafts, preload cache) fails to open → app-wide offline breakage, not just notes. Rule: only ONE feature claims `version(3)`; whoever merges second MUST bump to `version(4)`/`version(5)` and redeclare ALL prior stores unchanged. Enforced by a **blocking** migration-safety test (§7: opening the upgraded DB must preserve existing `reports`/`drafts` rows) — that test gates merge, it is not optional. |
| `supabase/migrations/00NN_*.sql` | **every** feature needing a migration (report-correction, multi-scout-reconciliation, export-presets, smart-picklist, coverage-gaps...) | Append-only numbering collision. Mitigation: this plan claims `0033`; the batch scheduler must hand out unique sequential numbers; whoever merges second renumbers. |
| `tests/e2e/*.spec.ts` | shared live `event.is_active` singleton | Single-worker already enforced. New `matchup.spec.ts` sets `2026casnv` active in its own setup; safe alongside `dashboard.spec.ts`. |

Features with **no** file overlap: match-video (`MatchVideo.tsx`), export-presets (`exportDash.ts`),
auto-path-heatmap (mostly `AutoRoutines.tsx`/charts) — low collision risk except the shared
`NextMatchView` anchor.

---

## 8b. Adversarial-review resolution (audit trail)

- **[high] Broken RLS read for anon dashboard** → FIXED. Replaced the `*_read_member`
  (`to authenticated`, `get_my_event_keys()`) policy with `matchup_note_read_open`
  (`for select to anon, authenticated using (true)`), mirroring 0009's `msr_read_open`. Verified in
  `0009_overhaul.sql:225/228` that the EFFECTIVE msr/pit read path is the open anon policy, added
  precisely because the login-less dashboard reads as anon.
- **[high] RPC silent no-op for anon dashboard** → FIXED. Removed the `get_my_event_keys()`
  membership gate from `upsert_matchup_note`; defense-in-depth now validates the `event` row exists.
  Verified `upsert_pit_report` (`0031`) — the RPC we mirror — has NO membership gate.
- **[high] E2E false green (local cache masks server)** → FIXED. Spec now polls the live DB via the
  admin client AND deletes `scouting-db` before reload so resurfacing can only come from the server;
  added `afterAll` admin cleanup of written rows.
- **[med] Non-existent offline helper** → FIXED. Now uses `page.context().setOffline()` directly per
  `capture.spec.ts`/`simulation.spec.ts`; noted `sync.spec.ts` has no offline helper.
- **[med] Dexie version collision under-specified** → FIXED. Version number is now a BLOCKING
  merge-gate with a blocking upgrade-safety test, not a soft coordinate-later note.
- **[med] queryFn catch poisons persisted cache** → FIXED. queryFn branches on `navigator.onLine`:
  offline → Dexie-only fallback; online error → rethrow (preserve persisted snapshot), mirroring
  `useEventReports`.
- **[low] min-key lineup-revision limitation** → DOCUMENTED in §2 + modal header wording.
- **[low] LWW same-ms drop invisibility** → MITIGATED: unsynced→synced chip + "last edited by"
  from `author_scout_id` (added to the read shape).
- **Missing file `proxies.ts`** → ADDRESSED by clarifying §6 read path follows `useEventReports`
  throw semantics, not the proxy sentinel (notes use direct PostgREST/RPC, no proxy). Not load-bearing.
- **Missing file `queryPersist.ts` (Map survival)** → PARTIAL PUSH-BACK: the concern that a
  `Map<string,string>` rehydrates as `{}` is NOT valid for this codebase — `queryPersist.ts:62-83`
  already tags Maps/Sets in a custom serialize/deserialize (MAP_TAG), so the Map round-trips. No
  plain-object conversion needed; noted inline in the `useMatchupNotes` row.
- **Missing file `baseTeamStore.ts` (baseTeam-not-in-match)** → FIXED. `ourSide` is now
  `'red' | 'blue' | null`; when `baseTeam` is in neither alliance the panel uses neutral per-color
  labels instead of mislabeling blue as "ours".

## 9. Step-by-step execution checklist

1. **Migration.** Create `supabase/migrations/0033_matchup_notes_table.sql` with the §2 SQL.
   `supabase db lint` if available. **Do NOT push / do NOT mark deployed** — hand off to the human.
2. **Types.** Add `MatchupNoteRow` + `LocalMatchupNote` to `src/db/types.ts`.
3. **Dexie.** Bump `ScoutingDb` to `version(3)` in `src/db/localStore.ts` (redeclare v2 stores
   unchanged + add `matchupNotes`); add the queue/CRUD helpers. Confirm version number not claimed
   by a sibling feature in the same batch.
4. **Synthesis.** Add `synthesizeMatchupGuidance` + types to `src/dash/aggregate.ts`. Write
   `aggregate.test.ts` cases; `npx vitest run src/dash/__tests__/aggregate.test.ts` green.
5. **Client + hook.** Add `src/dash/matchupNotesClient.ts` (`normalizeMatchup`, `keyFor`,
   `fetchMatchupNotesForEvent`, `saveMatchupNote`) and `useMatchupNotes` in `useEventData.ts`.
6. **Sync.** Add `src/sync/matchupNotesSync.ts`; wire `syncMatchupNotesOnce` + counts + requeue into
   `src/sync/useSync.ts`. Write `matchupNotesSync.test.ts`; green.
7. **UI.** Build `MatchupPanel.tsx` + `MatchupNotesModal.tsx`; mount `<MatchupPanel/>` in
   `NextMatchView.tsx` below `WinProbBanner`. Write `MatchupPanel.test.tsx`; green.
8. **Typecheck + unit.** `npm run typecheck` and `npm test` all green.
9. **E2E.** Add `tests/e2e/matchup.spec.ts`; `npx playwright test tests/e2e/matchup.spec.ts`
   (boots dev server, hits live `2026casnv`, single worker).
10. **Hand-off note.** Record that `0033` is authored-but-NOT-deployed; the human runs
    `supabase db push` and then a memory entry is added marking it deployed (NOT by this task).
```
