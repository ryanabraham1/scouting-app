# 2026 REBUILT Scouting App — Design (v2)

_Team 3256 "WarriorBorgs" · Game: REBUILT presented by Haas · Spec date: 2026-06-23_
_Game model: [`docs/research/2026-rebuilt-game-reference.md`](../../research/2026-rebuilt-game-reference.md)_
_Decisions log: [`docs/design/requirements-and-decisions.md`](../../design/requirements-and-decisions.md)_
_Review punch-list folded in: [`docs/design/spec-review-punchlist.md`](../../design/spec-review-punchlist.md)_

> **v2 changelog:** Reworked the three load-bearing seams the adversarial review found —
> (1) multi-custodian data integrity (revision-based precedence, server-authoritative ordering, QR
> as replication not custody transfer), (2) anonymous-auth/RLS security (concrete policies, a
> SECURITY DEFINER ingest path, identity recovery), and (3) live-capture human factors (tiered
> controls, clock degradation, derived "inactive-first"). Per the team's call, the **hold-to-shoot +
> rate-slider** capture is retained, with its uncertainty handled in the **analytics layer**
> (down-weighted, flagged, recomputable). Scope set to **qualification matches only** (picklist for
> alliance selection) and **3256 is not scouted** (drive-team marked unavailable).

## 1. Overview & Goals

An **offline-first PWA** for scouting the 2026 FRC game. Scouts capture match data on phones (often
without reliable internet); data syncs to Supabase when possible; a **QR hand-off** path lets an
offline device replicate its data to an online one. An admin configures the event from a
TheBlueAlliance (TBA) code, imports the qualification schedule, and assigns scouts to matches. A
drive-coach/pit **dashboard** blends scouting data with TBA and Statbotics for match previews, team
profiles, rankings, and an alliance-selection picklist.

- **Driver:** correctness and reusability ("build it right, no deadline"). Only the game-specific
  **scoring/compute module** changes per season; sync, admin, dashboard, and external-data layers
  are reusable.
- **Single team, single tenant.** All data belongs to Team 3256.
- **Scope:** qualification matches only. Playoff capture is out of scope (§18). Team 3256's own
  robot is not scouted (§19). **Drive-team members do not scout and are not app users**, so there is
  no drive-team availability to model.

## 2. Architecture

```
┌──────────────────── PWA (React + Vite, installable, offline-first) ────────────────────┐
│  Scouter UI          Admin UI                 Lead / Dashboard UI                       │
│  - match capture     - event setup (TBA)      - next-match preview   - picklist         │
│  - pit scouting      - schedule import (qm)   - team deep-dive       - sync status      │
│  - QR send/receive   - assignments + breaks   - ranking/compare      - CSV/JSON export  │
│        │                    │                        │                                  │
│        ▼                    ▼                        ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐         │
│  │ Local store (IndexedDB/Dexie): drafts · reports · outbox · cached reads    │        │
│  └──────────────────────────────────────────────────────────────────────────┘         │
│        │ idempotent revision-guarded write          ▲ cached reads (offline fallback)  │
└────────┼────────────────────────────────────────────┼──────────────────────────────────┘
         ▼                                             │
┌────────────────────────┐        ┌───────────────────────────────────────────────────┐
│ Supabase                │       │ Edge Functions (secrets + elevated, SECURITY DEF.) │
│ - Postgres + RLS        │◀─────▶│ - tba-proxy (TBA key, cache)                       │
│ - Auth (anon + admin)   │       │ - statbotics-proxy (cache, degrade)                │
│ - Storage (pit photos)  │       │ - join_event / recover_identity (code + name)      │
│ - Triggers (server ts,  │       │ - ingest_reports (QR + cross-scout, HMAC-checked)  │
│   revision, recompute)  │       │ - recompute aggregates from raw bursts             │
└────────────────────────┘        └───────────────────────────────────────────────────┘
         ▲
         │  QR = best-effort REPLICATION (creates a 2nd custodian), never custody transfer
   offline device ──per-frame-checksummed animated QR──▶ online device ──ingest_reports──▶ Supabase
```

**Principles:**
- **Local store is each device's source of truth**; the network is an eventual destination.
- **One revision-guarded write contract** serves network sync, QR ingest, and identity recovery, so
  re-submitting a record is always safe and never regresses a newer copy.
- **Server is authoritative** for ordering (server timestamp + monotonic revision) and for any
  number that feeds rankings (aggregates are **recomputed server-side from raw inputs**, not trusted
  from the client).
- **Edge Functions hold secrets and do elevated work** (TBA key, per-event HMAC, cross-scout ingest).

## 3. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | |
| Framework | React 18 + Vite | |
| PWA | `vite-plugin-pwa` (Workbox) | App-shell precache, runtime cache, install manifest, `storage.persist()` |
| Routing | React Router | Role-based guards |
| State | TanStack Query + Zustand | Query for reads/cache; Zustand for the live capture session |
| Local DB | IndexedDB via **Dexie** | drafts, reports, outbox, cached TBA/Statbotics, assignments |
| Backend | Supabase | Postgres, Auth, Storage, Edge Functions, RLS, triggers |
| QR generate | `qrcode` | Animated multi-frame, per-frame checksum |
| QR scan | `@zxing/browser` | Continuous camera scan |
| Compression | `pako` (deflate) | Shrinks QR payloads |
| Charts | Recharts | Always paired with a table view (a11y) |
| Styling | Tailwind CSS | Mobile-first, large targets, WCAG 2.2 AA |
| Testing | Vitest + RTL + Playwright | Golden-vector tests for scoring/parity |

## 4. Roles, Auth & RLS

Roles: **scouter** (anon), **lead**, **admin**.

### 4.1 Scouter identity (name + event code)
- Device does **Supabase anonymous sign-in** → anon JWT (`auth.uid()`). **Setup:** anonymous
  sign-ins must be **enabled** in Supabase (Authentication → Providers); the project had this
  **disabled** as of 2026-06-23 — a one-time Phase 0 toggle.
- Device calls **`join_event(code, display_name)`** — a **SECURITY DEFINER** RPC that:
  - validates `code` against the event's secret join code (min **8 random alphanumeric** chars),
  - is **rate-limited / lockout** on repeated failures (brute-force defense),
  - is **idempotent**: one `auth.uid()` → at most one `scout` row per event,
  - returns the scout id + event key; device caches locally.
- **Anonymous-abuse protections** enabled (Turnstile/CAPTCHA on join, anon sign-in rate limiting).
- The join code is a **soft gate**, not the security boundary — per-scout RLS write-scoping is.

### 4.2 Identity recovery (reinstall / second device)
Reinstalling yields a new `auth.uid()`, which would orphan locally-held unsynced reports. **`recover_identity(code, display_name)`** (SECURITY DEFINER) re-binds the new uid to the existing
`scout` (matched by event code + name, optionally admin-confirmed). On success the device **re-keys
its local unsynced reports' `scout_id`** and proceeds. Foreign-scout reports (recovered or via QR)
reach the server only through `ingest_reports` (§4.4).

### 4.3 RLS policies (default-deny; the anon key is public, so these are the real boundary)
- `scout.auth_uid` is **NOT NULL, UNIQUE**. A scout "owns" rows where
  `scout_id IN (SELECT id FROM scout WHERE auth_uid = auth.uid())`.
- **Reads** (per-table correlated `EXISTS` on event membership):
  - `event` exposed to scouts via a **view/column grant that excludes `join_code`** (RLS is
    row- not column-granular, so the code never ships to scouts).
  - `match`, `assignment`, `event_team`: readable by joined members of that `event_key`.
  - `team`: joined via `event_team` (it has no `event_key`).
  - `match_scouting_report`, `pit_scouting_report`: leads/admins read all; a scouter reads its own.
- **Writes (anon scouter, direct path):** **insert-only** of reports whose `scout_id` is their own
  and whose `event_key` is their joined event (`WITH CHECK`), `created_at`/`server_received_at`/
  `row_revision` are **server-set**, and re-pointing `id`/`scout_id`/`event_key`/`match_key` is
  forbidden. Edits and deletes by the original scout or a lead go through `ingest_reports`/admin RPC
  (so the precedence guard always applies).
- **Role authority:** role lives in a `profile` row whose RLS **forbids self-update**; only
  `service_role` or an existing admin grants roles. Never trust a self-set JWT claim. Join-code
  rotation is an **admin-only SECURITY DEFINER RPC**.
- Writes are bound to `scout.event_key`, **not** a global `event.is_active` (two events can be active).

### 4.4 `ingest_reports` (the one path that accepts cross-scout data)
QR relay and identity recovery submit reports authored by *another* scout, which §4.3's
forge-protection would (correctly) reject. `ingest_reports` (SECURITY DEFINER edge function)
reconciles this: **any joined member of an event may submit reports for that event**; `scout_id` /
`device_id` are **advisory authorship, not a security claim**. It validates event membership and a
per-event **HMAC** (authenticity; `crc32` remains integrity only), then applies the revision-guarded
upsert (§6.3). Server **recomputes aggregates** from raw bursts on ingest (§5.5, §11.2).

## 5. Data Model

Identifiers use **TBA keys** (`event_key`, `match_key`, `team_number`) so data aligns with
TBA/Statbotics without translation; scouting records use **client UUIDs**. All timestamps stored
**UTC**; the event's **IANA timezone** (from TBA) is used for display and "current match" logic.

### 5.1 Reference (synced from TBA)
- **event** — `event_key` PK, `name`, `start_date`, `end_date`, `timezone` (IANA), `city`,
  `state_prov`, `is_active`, `staged_fuel_per_match`, `imported_at`. **`join_code` lives in a
  separate `event_secret` table** (admin-only RLS), not on the readable `event` row.
- **team** — `team_number` PK, `nickname`, `city`, `state_prov`, `rookie_year`.
- **event_team** — (`event_key`, `team_number`) PK, FK→event, FK→team.
- **match** — `match_key` PK, `event_key` FK, `comp_level` CHECK (`qm` only imported), `match_number`,
  `scheduled_time` (UTC), `red1/red2/red3`, `blue1/blue2/blue3` (FK→team), `actual_red_score`,
  `actual_blue_score`, `red_auto_fuel`, `blue_auto_fuel` (from FMS/TBA when available),
  `winner`, `result_synced_at`.

### 5.2 Identity & assignment
- **scout** — `id` uuid PK, `event_key` FK, `display_name`, `auth_uid` NOT NULL UNIQUE, `created_at`.
  (Drive-team members are not users; no drive-team flag needed.)
- **profile** — `auth_uid` PK, `role` CHECK (`scouter|lead|admin`); RLS forbids self-update.
- **assignment** — `id` PK, `event_key` FK, `match_key` FK, `scout_id` FK, `alliance_color`
  CHECK(`red|blue`), `station` CHECK(1..3), `target_team_number` FK, `source` CHECK(`manual|auto`).
  Index on (`match_key`), (`scout_id`).

### 5.3 Match scouting report
`match_scouting_report` — one report per (match, scout):
- **Identity & precedence:** `id` (client uuid) PK; `row_revision` **server-monotonic** (bumped each
  write); `server_received_at`, `updated_at` (trigger-set); `created_at` (server default,
  client value informational only); `deleted` (bool, tombstone); `device_id`, `app_version`,
  `schema_version` (CHECK ∈ known set).
- **Context (immutable after insert; re-pointing forbidden by RLS):** `event_key` FK, `match_key`
  FK, `scout_id` FK, `target_team_number` FK, `alliance_color`, `station`.
- **Window/strategy:** `inactive_first` (bool), `inactive_first_source` CHECK
  (`derived|scout|official`), `teleop_clock_unconfirmed` (bool), timer anchors (device-relative,
  informational); **match-clock-relative `start_ms/end_ms` are the authoritative attribution basis.**
- **FUEL — raw bursts** (`fuel_bursts` JSONB, **size/shape-CHECKed**): array of
  `{ start_ms, end_ms, rate, window }`, `window ∈ {auto,transition,shift1..4,endgame}`,
  `0 ≤ start_ms ≤ end_ms`, `rate ≥ 0`. **Raw bursts are the migration-stable truth.**
- **FUEL — aggregates** (a **server-recomputed cache**, never trusted from the client for ranking):
  `auto_fuel`, `teleop_fuel_active`, `teleop_fuel_inactive`, `endgame_fuel`, `fuel_by_shift[1..4]`,
  `fuel_points` (active windows only), `fuel_estimate_confidence` (since rate-derived).
- **Endgame:** `climb_level` CHECK(0..3), `climb_attempted`, `climb_success`.
- **Auto routine:** `auto_start_position` (normalized field `{x,y}` + nearest-zone label),
  `auto_path` (ordered array of normalized `{x,y}` points sketched on the field diagram — **deferred,
  from-memory, low-fidelity** qualitative context, not a scored metric), `auto_left_starting_line`,
  `auto_climb_level1`. (`auto_fuel` lives in the FUEL aggregates above.)
- **Secondary:** `intake_sources` (subset of neutral/depot/human_feed), `max_fuel_capacity_observed`
  (≥0), `defense_rating` CHECK(0..3), `pins` (≥0), `fouls_minor` (≥0), `fouls_major` (≥0),
  reliability flags (`no_show`,`died`,`tipped`,`dropped_fuel`,`fed_corral`), `notes` (length-CHECKed).
- **Integrity:** FKs on all key columns; **partial `UNIQUE (match_key, scout_id) WHERE NOT deleted`**;
  indexes on (`event_key`,`match_key`), (`target_team_number`), (`scout_id`).

### 5.4 Pit scouting report
`pit_scouting_report` — **keyed by (`event_key`, `team_number`)** so two scouts editing the same
team **upsert one row** with field-wise LWW on `updated_at` (not two orphan rows). Columns:
`drivetrain`, `mechanisms` (jsonb tags), `capabilities` (jsonb), `photo_path`, `notes`,
`row_revision`, `updated_at`, `server_received_at`, `deleted`, authorship (advisory). History is
retained in an append `pit_report_history` for audit; the keyed row is "current."

### 5.5 Server-side recompute & validation
A trigger/function recomputes `match_scouting_report` aggregates from `fuel_bursts` on every
insert/ingest, using the **version-selected compute function** (§15). The client-sent aggregates are
ignored for ranking (kept only as an optimistic cache for instant local display). JSONB blobs are
size- and shape-validated to prevent storage abuse and aggregate/raw contradictions.

### 5.6 Local store (Dexie)
Tables: `drafts` (live capture state), `reports`, `outbox`, `cache_*`. Each local record carries
`sync_state ∈ {draft, dirty, pending, synced, error, dead}` and `last_error`. **`staged_fuel_per_match`** (default 504; 600 at champ-level events) is admin-set per event and consumed
as (a) a **scarcity cap** in alliance prediction and (b) a **validity check** flagging implausible
scout totals.

## 6. Offline-First, Durability & Sync

### 6.1 Write locally first
Every capture writes to Dexie with a client UUID and `sync_state=dirty`; the UI never blocks on the
network. In-progress capture lives in a **draft** (§8.7) that shares the eventual report's UUID.

### 6.2 Durability (a single device wipe must be survivable)
- Call **`navigator.storage.persist()`** at install/first capture; surface persistence state.
- A **close/inactivity guard**: "You have N unsynced reports — sync or hand off" before the app is
  backgrounded/closed with unsynced data.
- **Manual JSON export** of unsynced (or all) reports as a network-independent backup, re-importable
  via the same ingest path.

### 6.3 Sync service (revision-guarded, idempotent)
- A shared loop (on focus, on `online`, on a timer) drains the outbox in batches via the
  **revision-guarded upsert**: `ON CONFLICT (id) DO UPDATE … WHERE excluded.row_revision >
  report.row_revision`. A stale copy can therefore **never regress** a newer server row.
- **Server is authoritative** for ordering: `server_received_at` + monotonic `row_revision` resolve
  conflicts — **never the client `created_at`** (which is spoofable and identical across QR copies).
- **Deletes are higher-revision writes** setting `deleted=true`; tombstones propagate through sync
  and QR like any revision (a stale `deleted=false` can't resurrect a deleted row).
- **Backoff & error taxonomy:** shared exponential backoff + jitter + max-interval cap across all
  triggers (no thundering herd on Wi-Fi flap). **Retryable** (5xx/network) → retry; **non-retryable**
  (4xx/RLS/validation) → terminal `error`, surfaced to the lead, never retried forever. Per-record
  outcome handling so one poison record can't wedge a batch; max-attempts → `dead` (dead-letter)
  with manual retry/export.

### 6.4 Reads
Dashboard/admin reads go through TanStack Query against Supabase, falling back to the Dexie cache
offline. TBA/Statbotics responses are cached in Dexie with a TTL.

## 7. QR Hand-off (replication, not custody transfer)

For a device that can't reach the network: replicate its unsynced reports to a peer that can.

- **QR is best-effort replication that creates a second custodian.** A report only leaves its
  unsynced state when **this device reads its own server-confirmed `synced_at`** — never on QR
  receipt. A distinct retained **`handed_off`** marker (still in the outbox) records that a peer has
  a copy; the lead sync-status view surfaces "handed off but not server-confirmed."
- **Payload:** unsynced reports → JSON → **deflate** → base64; header `{schema_version, session_id,
  count, total_frames, payload_crc}`.
- **Per-frame integrity:** each frame `{session_id, idx, total_frames, frame_crc, data}`. A
  corrupted-but-readable frame is rejected by its `frame_crc` and re-acquired on the next loop;
  `payload_crc` is the end-to-end check.
- **Session lifecycle:** the **receiver locks onto the first `session_id`**, rejects frames from
  other sessions (handles two senders in a busy pit), and clears its partial buffer on session
  change. `total_frames` and `payload_crc` are bound into every frame.
- **Display/receive:** sender shows an **animated looping** sequence with visible `idx/total` and
  per-index good/missing status; receiver collects order-independently until all indices are valid,
  verifies `payload_crc`, decompresses, then submits via **`ingest_reports`** (§4.4) — HMAC-checked,
  revision-guarded, deduped by UUID. Bounded retries with an explicit "X frames still bad/missing"
  error; per-session report cap (no silent truncation).

## 8. Match Capture Engine

The active/inactive HUB mechanic requires **window-attributed scoring**. The engine is a clock-driven
state machine. **Controls are tiered** so a scout can sustain them over a 2:40 match.

### 8.1 Clock model
Match clock counts **down**. AUTO 0:20→0:00 (20s, both active); a **fixed 3-second scoring
assessment delay**; then TELEOP 2:20→0:00 (140s): TRANSITION 2:20→2:10 (10s, both active), SHIFT 1
2:10→1:45, SHIFT 2 1:45→1:20, SHIFT 3 1:20→0:55, SHIFT 4 0:55→0:30 (25s each, one alliance active,
alternating), END GAME 0:30→0:00 (30s, both active). **Windows are half-open `[start_ms, end_ms)`**
(final ENDGAME closed at match end); a single monotone lookup attributes each instant.

### 8.2 Clock sync & degradation
- Scout taps **START** at AUTO start → 20s AUTO countdown.
- At TELEOP, a **"Tap GO"** interstitial (re-anchors past the 3s delay + FMS-reset/announcer slack +
  start jitter). One tap → exact shift boundaries run.
- **Degradation (so a mistimed/missed tap can't silently corrupt attribution):**
  - Missed GO → fall back to a nominal offset and set `teleop_clock_unconfirmed=true` (down-weighted
    downstream). Offer a **re-anchor on the 0:30 endgame audio cue**.
  - Missed START → AUTO FUEL is entered as a **post-AUTO count** on the GO interstitial (survives the
    miss); the AUTO→TELEOP gap is persisted as data.
  - Review screen shows a **clock-confidence indicator** and a **draggable TELEOP timeline (±s)**.

### 8.3 "Inactive-first" — derived, with confirm/override
The per-shift active/inactive schedule follows from which alliance scored **more FUEL in AUTO** (that
alliance's HUB is inactive in SHIFT 1). So it is **derived**, not guessed from across-field lights:
- Default `inactive_first` from summed alliance AUTO FUEL → stored **"derived, pending"** until
  partner totals arrive (`inactive_first_source=derived`).
- The scout's HUB-light read is a **fast confirm/override** (`source=scout`).
- The **lead can enter the official per-match inactive-first once** and push to all 6 scouts
  (`source=official`, authoritative).
- **AUTO tie → FMS coin-flip:** the cross-check is **suppressed when AUTO totals are tied or within
  scouting error**, and requires **both** alliances' AUTO fuel; the captured value stays source of
  truth until an official signal arrives. Relabeling is applied at **aggregate-compute time** from
  the best available signal (FMS/TBA > official > scout > derived), not frozen at capture.
- **Parity convention (pinned, golden-vector tested):**
  `isInactive(shiftNumber, inactiveFirst) = ((shiftNumber % 2) === 1) === inactiveFirst`,
  `shiftNumber ∈ {1,2,3,4}`. AUTO/TRANSITION/ENDGAME are **hard-coded active** and asserted in the
  same test (a refactor can't make them alternate).

### 8.4 FUEL capture (hold-to-shoot + rate — retained per team decision)
- A large **HOLD WHILE SHOOTING** button records a burst while held; a **rate** control (coarse
  buckets preferred over a fine slider) sets FUEL/sec; changing it ends the current segment and
  starts a new one. On release the burst (one or more constant-rate segments) commits with
  `[start_ms, end_ms]` against the match clock; segments are split at window boundaries (half-open).
- Estimated FUEL = Σ `rate × duration`; **per-segment float, summed within a window, rounded once
  per window (round-half-up)**; `fuel_points` computed from rounded active-window counts so the live
  readout and saved aggregate agree.
- **These are explicitly estimates.** Raw bursts are retained so aggregates are recomputable, and the
  **analytics layer down-weights and flags rate-derived FUEL** (§11.2) — per the team's instruction
  not to over-trust this number.

### 8.5 Tiered controls
- **LIVE tier (large, always visible):** clock + current-window/active-inactive indicator; HOLD +
  rate; one unobtrusive running FUEL count; one-tap **FOUL** and **DEFENSE** event markers.
- **DEFERRED tier (review screen, §8.7):** defense rating, max capacity, intake sources, climb
  level/success, reliability flags, foul detail, notes. (Live points/per-window breakdown also live
  here — no distracting precision mid-match.)
- AUTO live toggles kept minimal: `left_starting_line`, `auto_climb_level1`.

### 8.6 Review & save
After ENDGAME, a review screen shows the computed summary, clock-confidence, all DEFERRED fields, and
notes; the scout confirms/edits, then **Save** → enqueues to the outbox.

### 8.7 Draft autosave & recovery
A **draft** record (keyed by `assignment_id`, **sharing the eventual report's UUID**) holds full
Zustand capture state (clock phase/anchors, committed bursts, flags). It is written **on every
committed burst/control change** (not merely on a timer). On launch the app scans for current/recent
drafts and prompts **"Resume capture?"**. Lifecycle: `draft → dirty (on Save) → pending → synced`.
The sync loop **never drains `draft`-state records**, and drafts are **excluded from the close
guard's unsynced count** until saved. The draft is cleared only after the report is enqueued.

### 8.8 Autonomous routine capture
A reusable **`FieldDiagram` component** renders the **official top-down REBUILT field image**
(`FE-2026-_REBUILT_Playing_Field_With_Fuel_With_Background.png`, vendored to `public/assets/field/`;
red alliance left, blue right) with a **normalized `[0,1]×[0,1]` coordinate overlay shared by
capture and dashboard**. Tap/draw coordinates are stored normalized so they render identically at
any size and on either view. A light SVG zone layer sits on top for labels/hit-testing (HUBs, BUMPs,
TRENCHes, DEPOTs, OUTPOSTs, TOWERs, NEUTRAL ZONE, starting lines). The diagram can mirror per scouted
alliance so "near side" is consistent for the scout.
- **Start position:** the scout taps the robot's starting spot on the diagram (quick — at match
  start or on review); stored as normalized `{x,y}` + nearest-zone label.
- **Drawable path (deferred, from memory):** on the review screen the scout sketches the robot's
  AUTO path on the diagram; stored as ordered normalized points. **Explicitly low-fidelity
  recollection** — qualitative context for the drive coach, never a scored metric.
- A coarse **start-zone selector + auto stats** (`auto_fuel`, `auto_left_starting_line`,
  `auto_climb_level1`) are always captured even if no path is drawn (completeness + a11y).

## 9. Pit Scouting

A per-team form (drivetrain, mechanisms, claimed capabilities, preload count, max climb, intake
sources) plus a **photo**. Keyed by (`event_key`, `team_number`) → one current row, field-wise LWW
(§5.4). Photo: **private Storage bucket**, served via **signed URLs**; anon may INSERT only to a
`event/{event_key}/team/{team}` path prefix, **no overwriting others**, **max size + `image/*`
only**; deletion follows soft-deleted reports. (Photos may include minors — privacy by default.)

## 10. Admin — Event Setup, Availability & Assignments

### 10.1 Event setup (TBA import)
Admin enters a **TBA event key** (e.g. `2026casnv`). Via `tba-proxy`: pull `/event/{k}` (incl.
timezone), `/event/{k}/teams`, `/event/{k}/matches`; **filter to `comp_level=qm`**; upsert `event`,
`event_team`, `match`; set `is_active`; generate the join code (stored in `event_secret`). Re-import
is idempotent and refreshes schedule changes.

### 10.2 Availability & own-team handling
- Drive-team members **do not scout and are not app users**, so no drive-team availability modeling
  is needed.
- **3256 is not scouted** (team decision): in 3256's matches the slot targeting 3256 is left
  unassigned; the other robots in those matches are still covered normally.
- General per-scout unavailability windows (breaks, shifts) are still supported by auto-assign.

### 10.3 Assignments
- **Manual:** a matches × 6-station grid; admin drops scouts into slots.
- **Auto-generate (balanced rotation + breaks + availability):** inputs = ordered qual matches,
  scout pool, per-scout availability (§10.2), `break_every_n`, `rotate_positions`. For each match's
  eligible slots, assign the available scout with the **fewest assignments so far** (min-heap),
  skipping scouts on a break/unavailable and (pool permitting) those who scouted the previous match;
  rotate alliance/station; insert a rest break every `break_every_n` per scout. Deterministic;
  balanced within ±1 per scout; back-to-back avoided when the pool allows. **Edge cases logged, not
  silently dropped** (<6 available scouts → some slots unassigned; pool changes → re-balance from the
  current match forward only). Admin reviews/edits before publishing.

## 11. Dashboard (Drive-Coach / Pit)

Lead role; assumes internet, degrades to last-synced/cached data offline. Quals-only data; the
picklist serves alliance selection.

- **Next-match preview:** both alliances' 6 robots side-by-side with **de-duplicated,
  assignment-matched** scouted stats, TBA ranking, Statbotics EPA, and a **predicted score + win
  probability** with strategy callouts (e.g. "deny 254's HUB during their active shifts").
- **Team deep-dive:** scoring trend, by-window breakdown, climb reliability, pit specs + photo,
  Statbotics EPA, recent TBA results, and a **data-confidence badge**.
- **Ranking / compare table:** sortable across event teams by scouted metrics blended with TBA rank +
  Statbotics EPA; multi-select compare. Charts always backed by a table view.
- **Alliance-selection picklist:** drag- **and keyboard-** reorderable ranked list, do-not-pick
  flags, notes, configurable "best available" weighting (fuel vs climb vs defense). Persisted.
- **Autonomous routines (drive-coach):** overlay both alliances' auto start positions + sketched
  paths on the field diagram for the next match — **3256 omitted** from our side (the coach knows
  their own auto). See §11.3.
- **Lead sync-status view:** per match, which of the (≤6) expected reports are scouted / synced /
  handed-off-but-unconfirmed / still on a device / errored / dead-lettered.
- **Export:** CSV/JSON of raw reports + server-recomputed per-team aggregates.

### 11.1 Aggregation correctness
UUID idempotency prevents duplicate *rows*, not duplicate *observations*. The dashboard aggregates
over **de-duplicated, assignment-matched** reports: average per (`match`,`team`) first, then across
matches, excluding `deleted` rows. The partial-unique index (§5.3) enforces one report per
(match, scout).

### 11.2 Data-confidence & prediction (rate-FUEL is down-weighted — team instruction)
Rate-estimated FUEL is treated as a **low-confidence estimate**: surfaced with a confidence badge,
**down-weighted** in predictions, and **overridden by verifiable signals** (TBA actual scores,
Statbotics EPA, discrete climb data) where they disagree. Per robot:
`E_robot = w·S_robot + (1−w)·B_robot`, where `S_robot` = scouted estimate (active-window FUEL ×
points + climb points + auto), `B_robot` = Statbotics EPA contribution, and `w = n / (n + k)` scales
with scouting **coverage** (n scouted matches, smoothing k≈3) **and is further reduced by the FUEL
estimate's confidence** and `teleop_clock_unconfirmed` flags. Statbotics unavailable → `w=1` with a
visible badge. Alliance score = Σ robots, with a **`staged_fuel_per_match` scarcity cap** and a noted
shared-resource (HUB congestion / one-TOWER) simplification. Win probability via logistic on the
score differential. **Every number links back to its inputs.**

### 11.3 Autonomous routines (drive-coach)
For a selected upcoming match, the dashboard overlays each robot's recorded auto **start positions +
sketched paths** on the shared field diagram — **your alliance** (the two partners; **3256 is
omitted** per team decision) and the **opponent alliance** (all three). Per team it shows
recent/representative auto paths (cycle through that team's scouted matches) plus auto stats (avg
auto FUEL, leave %, auto-climb %), so the coach can plan auto, spot partner-path conflicts, and
anticipate opponents. Paths are visibly marked **low-fidelity** (from-memory sketches).

## 12. External API Integration
- **TBA** via `tba-proxy` (key in a Supabase secret): `/event/{k}` (+timezone), `/event/{k}/teams`,
  `/event/{k}/matches`, `/event/{k}/rankings`, `/team/{k}`. Honor ETag/`Last-Modified`; cache
  (schedule long TTL, rankings/results short). When available, pull **official AUTO fuel + results**
  to override scouted inactive-first and to validate aggregates.
- **Statbotics** via `statbotics-proxy`: `/v3/team_event/{team}/{event}`, `/v3/team/{team}`,
  prediction endpoints. Cache aggressively; **degrade gracefully** (it returned 500s on 2026-06-23 —
  never hard-fail). Confirm v3 shapes once it's back up.
- Both proxies add CORS + a short cache; clients read the Dexie cache offline.

## 13. PWA Specifics
`vite-plugin-pwa`: precache app shell; runtime-cache GETs (stale-while-revalidate); manifest for
install. Permissions: camera (QR + pit photo). `storage.persist()` for durability (§6.2). Mobile-first,
one-handed capture, high-contrast for sun, minimal live text entry.

## 14. Security & Secrets
- TBA key + per-event HMAC secret + `service_role` only in Edge Functions / secrets — never client or
  repo. Local dev: gitignored `.env.local`; `.gitignore` excludes `.env*`.
- Supabase **anon key** ships to the client (intended); **RLS (§4) is the boundary**. Join code is a
  soft gate, admin-rotatable, never on a scout-readable row.
- **Server-trusted vs client-supplied:** any ordering/LWW value is a **server column**
  (`server_received_at`, `row_revision`); client `created_at`/`device_id`/timer anchors/versions are
  **informational/untrusted** (`schema_version`/`app_version` CHECKed against known values).
- **Aggregates that feed rankings are recomputed server-side** from raw bursts (clients can't skew
  rankings). JSONB size/shape-validated.
- **QR trust model:** relayed records carry "any joined event member may submit for the event"
  authority; authorship is advisory; `ingest_reports` checks event membership + HMAC (authenticity)
  and `crc` (integrity), and enforces the per-session report cap.
- **Storage:** private bucket, signed URLs, scoped-path inserts, size/type limits (§9).

## 15. Schema Versioning & Migration
- `schema_version` is a **constant in the isolated scoring/compute module**; it bumps on any
  form/scoring change.
- **Raw inputs (`fuel_bursts`, flags) are the migration-stable truth**; **all aggregates are
  recomputed on read/ingest via a version-selected compute function** — never relied upon as stored.
- A **forward-migration registry** runs on **every ingest** (sync + QR + import), migrating older
  records up; a record from a **newer** schema than the device is **quarantined with a visible
  error**, not silently mis-read.
- **QR version negotiation:** frames carry `schema_version`; the receiver migrates up or quarantines.
- This module + the canonical record/upsert/RLS **write contract** are **Phase 0 deliverables** (§17).

## 16. Accessibility (cross-cutting acceptance criterion)
Target **WCAG 2.2 AA**. Never encode meaning by **color alone** (alliance/active-state pair color
with icon/label). Replace fine sliders with large **+/- steppers** where feasible; keyboard up/down
reorder for the picklist; **table views behind every chart**; `aria-live` on capture readouts; focus
handling on route changes; **≥44px** touch targets. The drawable auto path is **supplementary** —
a coarse start-zone selector + auto stats are always captured, so the data is complete without
fine-motor drawing.

## 17. Build Plan (spine-first, layered)
Each phase gets its own implementation plan (writing-plans) and is independently usable.

- **Phase 0 — Foundation + contracts.** PWA scaffold (Vite/React/TS/Tailwind, install,
  `storage.persist()`); routing + role guards; Supabase wiring; **Postgres schema + RLS + triggers
  (server ts, revision, recompute)**; the **versioned scoring/compute/migration module** and the
  **canonical record/upsert/RLS write contract** (frozen aggregate outputs); Edge Function skeletons
  (`tba-proxy`, `statbotics-proxy`, `join_event`, `recover_identity`, `ingest_reports`). _Acceptance:
  PWA installs; anon join via code works; schema deploys; proxies return `2026casnv` TBA data;
  golden-vector tests for parity + always-active phases pass._
- **Phase 1 — Admin & schedule.** Event setup from TBA key (qm filter); schedule + team import;
  **availability model + auto/manual assignment**; join-code management. _Acceptance: `2026casnv`
  imported (37 teams, qual matches); auto-assign is balanced, respects breaks, leaves 3256
  unscouted._
- **Phase 2 — Capture (+ minimal durability).** Capture engine (clock state machine, two-tap sync +
  degradation, hold-to-shoot + rate, derived inactive-first, tiered controls, review, **draft
  autosave/recovery**, reusable SVG field-diagram component + auto start-position & drawable path)
  + pit scouting + photos — offline to Dexie, **with manual JSON export/QR-send
  pulled in for field durability** (so Phase 2 is field-safe, not demo-only). _Acceptance: a full
  match captured offline; aggregates recompute correctly from raw bursts; draft survives a tab kill._
- **Phase 3 — Sync & QR.** Revision-guarded outbox sync (backoff, error taxonomy, dead-letter); QR
  send/receive (per-frame checksum, session lifecycle, `ingest_reports`); identity recovery; lead
  sync-status view. _Acceptance: offline reports sync on reconnect with no duplicates/regressions; QR
  hand-off replicates a backlog and ingests; a wiped device's handed-off data is recoverable._
- **Phase 4 — Dashboard.** Next-match preview, team deep-dive, ranking/compare, picklist,
  **autonomous-routines field overlay** (both alliances, 3256 omitted), **confidence-weighted
  prediction**, CSV/JSON export, TBA/Statbotics integration with graceful degradation.
  _Acceptance: a next-match preview renders confidence-weighted predictions; works read-only when
  Statbotics is down; rate-FUEL is visibly down-weighted._

## 18. Open Questions / Risks
- **Manual values to verify against PDF tables before Phase 2** (extraction-flagged): FUEL = 1 pt in
  AUTO and TELEOP; climb **LEVEL 1 = 15 (AUTO, max 2 robots/alliance) / 10 (TELEOP); LEVEL 2 = 20
  (TELEOP only); LEVEL 3 = 30 (TELEOP only)**; RP thresholds (ENERGIZED/SUPERCHARGED/TRAVERSAL);
  **foul values (MINOR +5 / MAJOR +15)** not on the supplied scoring pages — confirm in the penalties
  section. All scoring constants live in the one config module, so corrections are one-line.
- **Statbotics availability** — down 2026-06-23; design degrades gracefully; confirm v3 shapes later.
- **Two-tap clock drift** — mitigated by degradation paths, endgame re-anchor, draggable timeline,
  and the AUTO-fuel/official cross-check.
- **Rate-FUEL data quality** — accepted as estimate per team; isolated to capture and **down-weighted
  in analytics**; recomputable if the method improves.
- **Shared-resource prediction** — summing robots ignores HUB congestion / one-TOWER limits; flagged
  simplification with the scarcity cap as a partial guard.

## 19. Out of Scope (YAGNI)
Multi-team/multi-tenant; **playoff/elimination scouting** (4-team alliances, live brackets — quals
only); **scouting Team 3256's own robot**; native app-store builds (Capacitor remains a future
option); realtime push between devices (sync is queue/pull-based); in-app messaging; cross-season
historical analytics; computer-vision auto-scoring.
