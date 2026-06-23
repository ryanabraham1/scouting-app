Here is the consolidated punch-list.

# FRC Scouting App Spec — Consolidated Review Punch-List

## Critical

### C1. QR hand-off transfers custody without proof of server persistence
- **Problem:** The sender (offline device) marks reports synced/handed_off based only on QR receipt, so a wipe before the data reaches Supabase loses it with no trace.
- **Fix:** Treat QR as best-effort *replication* that creates a second custodian, never custody transfer. A report may only leave the outbox / its unsynced state when *this* device reads its own server-confirmed `synced_at`. Add a distinct retained `handed_off` state that stays in the outbox, and surface "handed off but not server-confirmed" gaps in the lead sync-status view.

### C2. Single device wipe = unconditional total data loss; no durability beyond one IndexedDB
- **Problem:** Local store is sole source of truth, but IndexedDB is routinely lost at competitions (reflash, cache clear, PWA uninstall, storage eviction, dead/lost phone) before sync.
- **Fix:** Call `navigator.storage.persist()` at install/first capture and surface persistence state; add a hard "you have N unsynced reports — sync or hand off" guard on app close/inactivity; provide a manual JSON export as a network-independent backup. (Combined with C1, makes a single wipe survivable.)

### C3. "Immutable reports" is false; unconditional `on_conflict=id` upsert clobbers newer data
- **Problem:** Stored derived aggregates (recomputed on scoring corrections, §16), editable notes, and post-match edits all rewrite rows after creation; the column-overwrite upsert lets a stale copy silently regress a newer server row (no precedence guard).
- **Fix:** Drop the "immutable" framing. Either make aggregates fully derived at read time (persist only raw inputs) **or** add a monotonic precedence column (`row_revision`/`content_hash`) and make the upsert conditional (`ON CONFLICT (id) DO UPDATE ... WHERE excluded.row_revision > report.row_revision`). Never use unconditional overwrite for records that exist on multiple devices.

### C4. Conflict resolution (LWW on `created_at`) is undefined and spoofable
- **Problem:** `created_at` is copied verbatim to QR peers, so divergent edits of one UUID share an identical timestamp; the "edit timestamp" fallback has no schema column; client clocks drift and are attacker-controllable (set `created_at` far in the future to always win).
- **Fix:** Resolve by a server-assigned authority (`server_received_at`/trigger `updated_at`) or a per-device logical/Lamport counter, never the client `created_at`. Add the required `edited_at`/revision column to §5.3/§5.4 and specify the exact upsert predicate. (Unifies with C3.)

### C5. `scout_id` is client-supplied — anon users can forge/overwrite reports under any identity
- **Problem:** RLS informally says "scout_id matches their own," but the policy as described never resolves `auth.uid() → scout.id`; a holder of the public anon key can insert/upsert reports with any `scout_id`, including overwriting a victim's report by its (observable) UUID, and can self-soft-delete data before alliance selection.
- **Fix:** Specify exact policies: INSERT/UPDATE `WITH CHECK (scout_id IN (SELECT id FROM scout WHERE auth_uid = auth.uid()))` plus event-key binding; UPDATE `USING` clause restricts to already-owned rows; forbid re-pointing `id`/`scout_id`/`event_key`/`match_key`; gate `deleted`. Make `scout.auth_uid` NOT NULL/UNIQUE. Prefer insert-only for anon with edits via a dedicated RPC/admin role. Enforce `created_at` as a server default.

### C6. Anon sign-in + `join_event` gated only by a short code → unlimited scouts, full data scrape
- **Problem:** The public anon key plus a short, verbally-shared join code is the only gate; anyone can mint unlimited scouts (polluting the pool and sync view), brute-force a short numeric code, and scrape schedule/assignments/reports.
- **Fix:** Make `join_event` SECURITY DEFINER with rate-limit/lockout on failed attempts, minimum code entropy (8+ random alphanumeric), and idempotency (one `auth.uid()` → at most one scout per event). Enable Supabase anonymous-abuse protections (CAPTCHA/Turnstile, anon sign-in rate limiting). Treat the join code as a low-value gate; the real boundary is per-scout RLS write scoping.

### C7. QR relay vs per-scout RLS are unreconciled — the headline feature fails RLS in practice
- **Problem:** The receiver upserts the sender's reports under its *own* anon session, but those reports' `scout_id` belongs to the sender; the correct forge-protection (C5) rejects exactly these writes. crc32 is integrity, not authenticity, so forged frames can be injected.
- **Fix:** Route QR import (and identity recovery on reinstall/second device) through a SECURITY DEFINER edge/RPC "ingest" path: any joined event member may submit reports for that event, with `scout_id`/`device_id` as *advisory* authorship, not a security claim. Validate event-key membership and an HMAC keyed by a per-event secret; keep crc32 only for integrity.

### C8. Continuous rate-slider FUEL estimation fabricates the primary metric
- **Problem:** Asking a high-schooler to eyeball shots/sec and ride a 0–8 slider mid-hold multiplies two uncertain quantities; REBUILT actually needs a *count* per active/inactive window, not a rate, and "raw bursts are recomputable" only faithfully preserves the bad estimate.
- **Fix:** Make discrete event counting primary — a large `+1 FUEL` tap (small `−1` undo), each timestamped and auto-attributed to the current window by the clock. Keep hold-to-shoot only as an optional fast-burst affordance; if a rate is kept at all, make it a coarse 3-bucket (slow/med/fast) estimate on held bursts only, clearly labeled. Default the UI to tap-counting (this also dissolves boundary-splitting/segmentation complexity).

### C9. No schema-version migration strategy for mid-season form changes
- **Problem:** Records and QR payloads carry `schema_version`/`app_version`, but nothing defines the current version, how it bumps, cross-version sync/QR ingest, or how stored aggregates are read across versions — and §16 expects scoring/form changes mid-season.
- **Fix:** Add a "Schema versioning & migration" section: define `schema_version` as a constant in the isolated scoring config module; make raw inputs the migration-stable truth and recompute all aggregates on read via a version-selected compute function; add a forward-migration registry run on every ingest (sync + QR); specify QR version negotiation (migrate up or quarantine with visible error); state the policy when a device is behind. Land this in Phase 0.

### C10. Team 3256's own matches / scout unavailability are never modeled
- **Problem:** Auto-assign (§10.2) treats the pool as uniformly available, but drive-team scouts are queuing/driving/playing during 3256's own matches, and scouting 3256 itself is unaddressed.
- **Fix:** Add an availability model: mark drive-team scouts and feed 3256's match schedule into auto-assign as hard unavailability windows (queue lead-in through reset). Decide and document the policy for scouting 3256's own robot (skip / self-report from match logs / assign a non-drive scout). Specify before Phase 1.

### C11. Playoff (elimination) matches are in the model but every feature assumes quals
- **Problem:** `comp_level` supports qf/sf/f, but auto-assign, next-match preview, prediction (RP-based), and the fixed 6-station UI all assume known-in-advance qual 3v3; REBUILT uses 4-team alliances (3 of 4 on field) and playoffs have no RP and resolve live.
- **Fix:** Scope each feature by `comp_level`. Decide if playoffs are scouted; if yes, specify live bracket import/refresh, a playoff-specific (likely manual) assignment flow, prediction/preview that suppresses RP and uses fixed picked alliances, and 4-team handling. If out of scope, say so in §17 and filter import to `comp_level=qm` (and reconcile the picklist's purpose).

## Major

### M1. No per-frame QR integrity; single payload crc32 forces all-or-nothing re-scan
- **Problem:** A corrupted-but-readable frame poisons reassembly; only the whole-payload crc32 catches it, with no way to identify/re-acquire the one bad frame — risking an indefinite silent re-scan loop.
- **Fix:** Add a per-frame checksum so bad frames are rejected and re-acquired on the next loop; keep payload crc32 as the end-to-end check; surface per-index good/missing status and bound retries with an explicit "X frames still bad/missing" error.

### M2. `session_id` lifecycle/validation unspecified — cross-session frame mixing
- **Problem:** The receiver "collects until all indices seen" but never pins to one `session_id`, so old/new sessions or two senders in a busy pit can interleave into a Frankenstein payload.
- **Fix:** Receiver locks onto the first `session_id`, rejects others (or prompts new capture), and clears its partial buffer on session change. Bind `total` (and ideally the payload crc) into each frame's `(session_id, total, crc)` tuple. Document the multi-sender pit scenario.

### M3. Outbox retry storm, batch poisoning, and non-retryable errors retried forever
- **Problem:** Focus/online/timer triggers without shared backoff cause a thundering herd on Wi-Fi flap; one rejected record (4xx/RLS) can wedge an atomic batch; 4xx is lumped with network errors and retried forever with no cap/dead-letter.
- **Fix:** Shared backoff state across all triggers with exponential backoff + jitter + max-interval cap; distinguish retryable (5xx/network) from non-retryable (4xx/RLS/validation → terminal "error" state surfaced to the lead); per-record outcome handling so one poison record can't wedge the batch; max-attempt/dead-letter with a manual retry/export affordance.

### M4. UUID idempotency ≠ observation idempotency — dashboard double-counts duplicates
- **Problem:** Two reports for the same (match, target_team) with different UUIDs both upsert; re-entered/re-created reports survive dedup; aggregates over "n scouted matches" inflate, and there's no uniqueness/merge at the (match, team[, scout]) grain — also an easy ballot-stuffing vector.
- **Fix:** Decide the intended cardinality and enforce it: partial `UNIQUE (match_key, scout_id) WHERE deleted=false` (and/or include `target_team_number`). Have the dashboard aggregate over de-duplicated, assignment-matched reports (average-per-(match,team) before averaging across matches). Document that UUID idempotency does not prevent duplicate observations.

### M5. Simultaneous live control load is unrealistic for one scout over 2:40
- **Problem:** A dozen-plus live controls (hold+slider, 3 intake toggles, capacity, defense, pins, fouls, ~5 reliability flags, AUTO/endgame climb, two-tap clock, HUB-light read) guarantee the scout drops the primary FUEL metric.
- **Fix:** Tier the controls. LIVE tier (large, always visible): clock, FUEL +1/undo, single intake/idle indicator, current-window/active-inactive indicator, plus at most one-tap "FOUL"/"DEFENSE" event markers. DEFERRED tier (the existing §8.6 review screen): defense rating, max capacity, intake sources, climb level/success, reliability flags, foul detail.

### M6. Missing/late GO (and START) taps silently corrupt shift attribution
- **Problem:** The whole TELEOP clock and four 25s shift boundaries hinge on one GO tap; if missed or even 2–3s late near a boundary, attribution flips active↔inactive and looks valid; a missed 20s-AUTO START loses AUTO FUEL and the inactive-first signal, with no defined fallback.
- **Fix:** Add degradation paths: if GO is never tapped, fall back to a nominal offset and flag `teleop_clock_unconfirmed` for down-weighting; offer a second re-anchor on the 0:30 endgame audio cue; on the review screen show a clock-confidence indicator and allow dragging the TELEOP timeline ±seconds. Make AUTO FUEL a post-AUTO count entry on the GO-prompt interstitial so it survives a missed START; persist the AUTO→TELEOP gap as data.

### M7. "Inactive first" should be derived, not a fragile across-field light read
- **Problem:** Per-shift active/inactive hinges on the scout reading under-verified "white chase" HUB lights across the field in sun, in the same 10s they tap GO and start capturing; a wrong guess inverts every shift; the AUTO-fuel cross-check arrives too late to help capture.
- **Fix:** Derive inactive-first from which alliance scored more AUTO FUEL (the actual rule), storing it as "derived, pending" until partner totals arrive. Keep the light read as a fast confirm/override defaulting to the derived value. Let the lead enter the official per-match inactive-first once and push to all 6 scouts. Add `inactive_first_source` (derived/scout/official). **Suppress the cross-check on an AUTO tie** (FMS coin-flip) and require *both* alliances' AUTO fuel to evaluate it.

### M8. RLS read scoping lacks a usable membership predicate; relies on global `is_active`
- **Problem:** "Readable by joined members" needs a per-table correlated EXISTS against `scout` (and `team` has no `event_key`, so must route via `event_team`); write scoping keyed off global `event.is_active` breaks if two events are active.
- **Fix:** Spell out per-table SELECT predicates driven off scout membership (`EXISTS` join on `auth_uid=auth.uid()` and matching `event_key`; `team` via `event_team`). Bind writes to `scout.event_key`, not `is_active`. State default-deny explicitly so unlisted tables aren't world-readable.

### M9. `join_code` and admin-role mechanism are not enforceable as described
- **Problem:** `join_code` lives on the event row that's "readable by any joined member," but Postgres RLS is row- not column-granular, so the code leaks to every scout; the role source ("claim OR profile.role row") risks self-promotion to admin.
- **Fix:** Don't store `join_code` on the widely-readable row — expose `event` to scouts via a view/column GRANT that excludes it. Define role authoritatively as a row whose RLS forbids self-update (only service_role/existing admin grants roles); never trust a self-set JWT claim. Make rotation an admin-only SECURITY DEFINER RPC.

### M10. Pit-photo Storage bucket has no access policy (privacy/abuse)
- **Problem:** Storage policies are unspecified; a public bucket exposes photos (possibly of minors) to the world and unscoped anon INSERT allows arbitrary uploads/overwrites with no size/content-type limit.
- **Fix:** Make the bucket private and serve via signed URLs; anon may INSERT only to a scout/event-scoped path prefix, no overwriting others, with a max size and `image/*` restriction. Define photo deletion for soft-deleted pit reports and note the minors-in-photos consideration.

### M11. Missing FKs, NOT NULLs, CHECKs, and indexes for integrity and dashboard performance
- **Problem:** No FKs (`report.scout_id/match_key/event_key`, `assignment.scout_id`) allow orphan/cross-event rows; no enum CHECKs; no indexes on the per-match/per-team aggregation paths.
- **Fix:** Add FKs with appropriate ON DELETE behavior; NOT NULL on key columns; CHECKs on bounded enums (alliance_color, station 1..3, climb_level 0..3, defense_rating 0..3, fouls ≥ 0); indexes on `report(event_key, match_key)`, `report(target_team_number)`, `report(scout_id)`, `assignment(match_key)`, `assignment(scout_id)`, plus the M4 partial-unique index.

### M12. No time-zone handling for schedule times or device-clock ordering
- **Problem:** `scheduled_time`/`start_date`/`end_date` have no stated TZ, so a phone on home time shows wrong match times and "current match" logic breaks; LWW on unsynchronized device clocks mis-orders edits.
- **Fix:** Store all timestamps as UTC; capture the event's IANA timezone from TBA and render schedule/"current match" in event-local time. Order conflicting writes by a server timestamp (or logical counter), not raw device clock; document timer anchors as device-relative and only match-clock-relative `start_ms/end_ms` as authoritative for window attribution. (Unifies with C4.)

### M13. Pit reports: "one current per team / latest wins" is undefined and unenforced
- **Problem:** Pit reports use client UUID PKs, so two scouts create two rows (not an edit); "latest wins" has no `updated_at`, no current-row selector, and no offline merge — silently dropping or duplicating pit data, including which photo is "current."
- **Fix:** Either key `pit_scouting_report` by `(event_key, team_number)` so it upserts one row with field-wise LWW on `updated_at`, or keep append-only history with a deterministic "current" selector (max `updated_at`, tie-break `id`) and a manual-merge UI. Add `updated_at`; specify offline reconciliation on sync.

### M14. Draft autosave recovery/lifecycle/scope unspecified — live-capture data-loss hole
- **Problem:** Only "a periodic Dexie autosave draft" is mentioned: no write trigger, key, recovery prompt, post-Save cleanup, or collision rule; an OS-killed PWA tab mid-match loses clock state and the open burst.
- **Fix:** Define a draft record keyed by `assignment_id` (or event+match+scout) holding full Zustand state incl. clock phase/anchors and committed bursts; write on every committed burst/control change (not just a timer). On launch, scan for current/recent-match drafts and prompt "Resume capture?" Clear the draft only after enqueue. Make the draft share the eventual report's UUID with an explicit `draft → saved/dirty` lifecycle, and guarantee the sync loop never drains `draft`-state records and excludes drafts from the unsynced close-guard.

### M15. `event.fuel_per_match` config has no defined purpose, source, or consumer
- **Problem:** The field appears once and is never read; it's likely the staged-FUEL ceiling (504/600) but nothing populates or uses it.
- **Fix:** Either define it concretely — meaning (staged FUEL count), source (admin entry or derived from TBA event level, default 504/600), and consumers (a scarcity cap in alliance prediction, plus a validity check flagging implausible scout totals) — or remove it from the schema until a consumer exists.

### M16. Anonymous identity is browser-bound; reinstall/second device orphans reports
- **Problem:** Identity is an anon JWT in local storage; reinstall/cache-clear/device-switch yields a new `auth.uid()` and new scout row, so previously captured-but-unsynced reports (old `scout_id`) are rejected by RLS on upsert.
- **Fix:** Specify identity recovery — re-bind a new anon uid to an existing scout (admin-mediated or join-code + name match) and re-key local unsynced reports on recovery. Combine with C7's edge-function ingest so foreign-scout (QR/recovered) reports are accepted.

### M17. Phasing has hidden cross-phase dependencies; compute module is unowned
- **Problem:** The versioned scoring/compute/migration module silently underpins Phases 2 and 4 but is owned by none; Phase 2 ("fully offline, independently usable") isn't field-safe without Phase 3 durability; the canonical upsert/RLS write contract isn't pinned until Phase 3, risking a non-round-tripping Phase-2 schema.
- **Fix:** Make the versioned scoring+compute+migration module and the canonical record/upsert/RLS write contract explicit Phase 0 deliverables with frozen aggregate outputs. Re-scope Phase 2's "independently usable" claim: either pull a minimal export/QR-send earlier for durability, or label Phase 2 demo-only/not field-safe.

### M18. Accessibility reduced to "high contrast + large targets"; no standard or fallbacks
- **Problem:** No WCAG target, color-only semantics for alliance/active-state, an error-prone fine-motor rate slider used one-handed in sun, drag-only picklist, and chart-only data with no text equivalent or aria.
- **Fix:** Add an Accessibility subsection with a concrete target (e.g., WCAG 2.2 AA): never encode meaning by color alone (pair with icons/labels); replace the rate slider with large +/- steppers (also see C8); keyboard/up-down reorder fallback for the picklist; table views behind charts; `aria-live` on capture readouts; focus handling on route changes; ≥44px targets. Make it a cross-cutting acceptance criterion.

## Minor

### m1. AUTO→TELEOP gap is a fixed 3s scoring-assessment delay, not "variable length"
- **Problem:** §8.1/§8.2 justify the two-tap clock on a "variable" pause, but the manual specifies a fixed 3s delay.
- **Fix:** Correct the wording to "fixed 3-second scoring-assessment delay" and re-justify the GO tap on operational grounds (FMS reset / announcer slack / start jitter); reconsider whether the second tap is needed if a single auto-advanced clock can absorb a known 3s gap.

### m2. Soft-delete resurrection and immutable-vs-edit-vs-delete semantics undefined
- **Problem:** A `deleted=true` on device A is overwritten by a stale `deleted=false` QR copy from device B (unconditional upsert); edit/delete authorization, mutate-vs-append, and delete-vs-edit conflict resolution are all unspecified; tombstone propagation over QR is undefined.
- **Fix:** Cover deletes with the same precedence/revision guard as C3 (a delete is a higher-revision write setting `deleted=true`). Define authorization (original scout or lead/admin), choose `updated_at`+server-authority LWW, exclude `deleted=true` from aggregates, define delete-vs-edit resolution, and specify tombstones are included in QR payloads and synced like any revision.

### m3. Draft identity vs final report UUID ambiguity → orphan drafts / duplicates
- **Problem:** If the draft is keyed differently from the saved report, a mid-review crash can orphan the draft and prompt re-entry (new UUID duplicate); if it's the same row, broad sync triggers must never enqueue a draft.
- **Fix:** Make the draft the same UUID as the eventual report from capture start with an explicit lifecycle; drain only `dirty+` states; clean up the draft on Save/discard; exclude drafts from the unsynced close-guard. (Pairs with M14.)

### m4. Burst boundary-interval convention unspecified — double-count/drop at shift boundaries
- **Problem:** "Split at window boundaries" never says whether windows are half-open or closed, so the active↔inactive flip instant (e.g., 1:45, 0:30) can be counted twice or in the wrong bucket.
- **Fix:** State half-open `[start_ms, end_ms)` for every window (final ENDGAME closed at match end); assign via a single monotone lookup and split bursts only strictly inside `(start, end)`. Add tests for a burst straddling 1:45 and one starting exactly on a boundary. (Mostly moot if C8's tap-counting is adopted.)

### m5. Shift parity is correct but §8.3 wording invites a 0- vs 1-indexed off-by-one
- **Problem:** Parity is specified over the 1-based shift number; a 0-indexed array implementation silently inverts every active/inactive label with no visible error.
- **Fix:** Pin the convention in the spec: `isInactive(shiftNumber, myHubInactiveFirst) = (shiftNumber % 2 === 1) === myHubInactiveFirst`, shiftNumber ∈ {1..4}. Add a golden-vector unit test for all 8 combinations before wiring FUEL aggregation.

### m6. Fractional `rate×duration` FUEL has no specified rounding point
- **Problem:** FUEL is a discrete count but is summed from fractional segments; per-segment vs per-window vs per-match rounding changes the active-window points, and the live readout can disagree with the saved aggregate.
- **Fix:** Keep per-segment FUEL as float, sum within a window, round once per window (round-half-up), and compute `total_scored_points_fuel` from rounded active-window counts so the live readout and saved aggregate match. Document these as estimates. (Largely dissolved by C8's integer tap counts.)

### m7. Mid-burst rate changes / boundary-splitting add complexity for near-zero value
- **Problem:** Segmenting and boundary-splitting preserve sub-second rate resolution no consumer needs, raising bug surface to store a rate the scout couldn't estimate.
- **Fix:** Adopt tap-counting (C8), which makes each tap a point-in-time event trivially window-attributed and eliminates segmentation. If a hold path is kept, attribute a held burst by its midpoint (or auto-release at boundaries) rather than fractional splitting.

### m8. Live points/total readouts during the match distract with no scouting benefit
- **Problem:** Live window-estimate, match-total, and running-points readouts invite the scout to glance down during peak scoring and imply false precision.
- **Fix:** Reduce live feedback to one unobtrusive running FUEL count plus a current-window/active-inactive indicator; move points and per-window breakdown to the §8.6 review screen.

### m9. Server-trusted vs client-supplied fields not delineated; audit anchors spoofable
- **Problem:** `created_at`, `device_id`, timer anchors, `app_version`/`schema_version` are all client-authored under the anon key, so any "audit" field is attacker-controllable and `created_at`-driven LWW is exploitable.
- **Fix:** Use a server column for any ordering/LWW; mark client timestamps informational/untrusted; derive device attribution server-side from the session; CHECK `schema_version`/`app_version` against known values. (Pairs with C4/C5.)

### m10. `fuel_bursts` JSONB and other blobs are unvalidated server-side
- **Problem:** A malicious client can submit aggregates that contradict raw bursts (or omit bursts) to skew rankings, and unbounded JSONB enables multi-MB storage abuse.
- **Fix:** Don't trust client aggregates for ranking numbers — recompute server-side from `fuel_bursts` and treat stored aggregates as a cache (or add a CHECK/trigger validating consistency). Add size/length CHECKs on JSONB and notes; validate burst element shape (window ∈ allowed set, `0 ≤ start_ms ≤ end_ms`, rate ≥ 0).

### m11. AUTO-fuel cross-check assumes all 3 alliance reports exist; no partial/fallback rule
- **Problem:** Stations are routinely unscouted (the sync-status view exists for that reason), so the cross-check often can't run, and there's no rule for disagreement or for propagating a corrected derivation to saved aggregates.
- **Fix:** Run the check on whatever subset exists and flag low-confidence when incomplete; resolve conflicts from the authoritative FMS/TBA AUTO result when available (overriding the scout boolean); apply active/inactive relabeling at aggregate-compute time from the best available signal (not frozen at capture); surface low-confidence windows in the deep-dive. (Pairs with M7.)

### m12. QR payload trust/abuse bounds absent from §14
- **Problem:** §14 doesn't mention QR; crc32 is integrity not authenticity, authorship fields are written on behalf of others, and there's no per-session size/report cap.
- **Fix:** State the QR trust model in §14: relayed records carry "any joined event member may submit for the event" authority; authorship is advisory; bound ingest (reject sessions over the per-session report cap, validate `schema_version`/event membership before upsert). Resolve together with C7.

## Nit

### n1. LEVEL 2 climb's TELEOP-only status is not stated
- **Problem:** §16 attaches "(TELEOP only)" to LEVEL 3 only, leaving LEVEL 2 ambiguous though it is equally TELEOP-only (only LEVEL 1 is AUTO-eligible, max 2 robots/alliance).
- **Fix:** Reword to "LEVEL 1 = 15 (AUTO, max 2 robots/alliance) / 10 (TELEOP); LEVEL 2 = 20 (TELEOP only); LEVEL 3 = 30 (TELEOP only)." Wording fix only — the model already encodes it via `auto_climb_level1`.

### n2. AUTO-tie case for inactive-first is omitted
- **Problem:** On equal AUTO FUEL the FMS randomly selects the inactive alliance, so the AUTO-fuel cross-check has no deterministic answer and could flag a correct entry.
- **Fix:** Note that when AUTO totals are tied (or within scouting error) the check is suppressed/indeterminate; the captured `my_hub_inactive_first` remains source of truth. (Already folded into M7.)

### n3. Foul point values (+5 / +15) are unverified against the cited pages
- **Problem:** The game reference asserts MINOR +5 / MAJOR +15, which don't appear on the supplied scoring pages (the spec itself stays value-agnostic).
- **Fix:** Confirm the foul values against the manual's penalties section before any scoring computation relies on them; no design-spec change needed.

### n4. "Always active" phases (AUTO/TRANSITION/ENDGAME) — verified correct
- **Problem:** None — matches the reference exactly, as does the clock model (AUTO 20s, TRANSITION 10s, 4×25s, ENDGAME 30s; TELEOP 140s; total 160s).
- **Fix:** No change; hard-code these phases as active and assert it in the same golden-vector test as m5's parity so a refactor can't make them alternate.

---

## Verdict

The spec is **fundamentally sound in its architecture and domain modeling** — the offline-first/local-source-of-truth premise, single idempotent write path, raw-burst-plus-recomputable-aggregates design, and the game-rule math (shift parity, always-active phases, clock model) are correct and thoughtfully reasoned. The problems are concentrated in three seams that are individually fixable but currently load-bearing and under-specified: **(1) the multi-custodian data-integrity model** — "immutable" is false, the unconditional upsert plus client-clock LWW silently regresses and loses data, and QR hand-off transfers custody without proof of persistence; **(2) the anonymous-auth/RLS security model** — `scout_id` is client-trusted, the per-scout write rule directly contradicts the QR relay path, and the join-code is treated as a security boundary it cannot be; and **(3) the live-capture human-factors model** — the rate slider fabricates the core FUEL metric and the control count exceeds what one scout can sustain over a 2:40 match.

**Top 3 to fix before implementation:** (1) Replace the "immutable + unconditional upsert + `created_at` LWW" trio with an explicit precedence/revision column, server-authoritative ordering, and QR-as-replication-not-custody-transfer (C1–C4), plus persistent-storage + export durability (C2). (2) Specify the concrete RLS policies and reconcile self-sync vs QR relay through a SECURITY DEFINER ingest path with real authentication, downgrading the join code to a soft gate (C5–C7, M16). (3) Switch FUEL capture to discrete timestamped tap-counting and tier live vs deferred controls (C8, M5), which also dissolves the boundary-splitting/rounding complexity. Closing the schema-migration (C9) and 3256-own-match / playoff scoping (C10–C11) gaps in Phase 0 will prevent the most expensive rework.