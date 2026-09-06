# The Scoring Sync Contract (read before touching any scoring math)

Scoring aggregates are computed from raw inputs in **three independent implementations**.
They must produce **identical numbers** for the same input, or the app silently shows
inconsistent data. This is the single most important invariant in a season migration.

## The three implementations

| # | Implementation | Language | Role |
|---|---|---|---|
| 1 | `src/scoring/` (`constants.ts`, `windows.ts`, `compute.ts`) | TypeScript | Client preview shown to the scout during/after capture. |
| 2 | The recompute block inside the `upsert_match_report` RPC (helpers `msr_is_inactive`, `msr_round_half_up`) | PL/pgSQL | **Source of truth for stored aggregates.** Recomputes from the raw inputs the client uploads. |
| 3 | `supabase/functions/seed-demo/index.ts` (`CLIMB_TELEOP_POINTS`, `SHIFT_BOUNDS`, burst/score generators) | TypeScript (Deno) | Generates synthetic demo data; must match so demo numbers are self-consistent. |

## Why three, and why the server wins

The client computes aggregates for instant feedback, but it **does not upload them** —
`src/sync/mapReport.ts` sends only **raw inputs** (`fuel_bursts`, `climb_level`,
`inactive_first`, …). The server's `upsert_match_report` recomputes the aggregates and
stores those. This is deliberate: it means a buggy or outdated client can never corrupt
stored aggregates, and re-running the upsert is idempotent. The consequence for you: **the
server SQL is authoritative**, and the client must match it so the scout isn't shown a
number that changes after sync.

`seed-demo` is a third copy because it runs in Deno (can't import the `src/` TS scoring
module) and fabricates data directly. It carries *frozen copies* of the constants with a
comment saying so.

## The exact algorithm (2026), so you can re-mirror it

For the rate-burst model, all three do the same thing:

1. **Short-circuit no-shows:** when `noShow` / `no_show` is true, emit zero for every
   fuel aggregate without discarding the raw bursts or other captured evidence.
2. **Integrate** each burst into its window: `fuel = rate × (endMs − startMs) / 1000`,
   accumulated as a float per window.
3. **Round half-up ONCE per window** (`floor(x + 0.5)`) — *not* per burst. Rounding
   timing is a correctness detail; per-burst rounding gives different totals.
4. **Classify** each teleop shift window active/inactive via `isInactive(shiftN,
   inactiveFirst)` (= `((shiftN % 2) === 1) === inactiveFirst`). auto/transition/endgame
   are always active.
5. **Sum points**: `(auto + transition + endgame + Σ active shifts) × FUEL_POINTS`.
   Inactive-shift fuel contributes 0.
6. Emit `autoFuel`, `teleopFuelActive`, `teleopFuelInactive`, `endgameFuel`,
   `fuelByShift[1..4]`, `fuelPoints`.

The SQL helpers mirror the TS line-for-line:

```sql
-- msr_is_inactive  ↔  src/scoring/windows.ts isInactive
((p_shift % 2) = 1) = p_inactive_first
-- msr_round_half_up  ↔  src/scoring/compute.ts roundHalfUp
floor(p_val + 0.5)::int
```

## Climb is an exception worth knowing

The server stores `climb_level`/`climb_success` **raw and does not compute climb points**.
Climb→points happens client/dashboard-side (`SCORING.CLIMB` in `aggregate.ts`'s
`climbPointsForMatch`). `seed-demo` *does* compute climb points (to subtract from the
attributed alliance total when fabricating fuel). So for endgame:

- Client/dash: `constants.ts SCORING.CLIMB` + `aggregate.ts`.
- Seed-demo: `CLIMB_TELEOP_POINTS`.
- Server: nothing to change for climb points (it only stores the level) — **unless** you
  decide the new game should aggregate endgame points server-side, in which case add that
  to the recompute and store a new column.

## Migration procedure for the contract

When you change the scoring model:

1. Edit **client** first (`src/scoring/`) — it has the golden tests; get them green.
2. Mirror into the **server** recompute: copy the *latest* existing `upsert_match_report`
   definition into a new migration and edit **only** the scoring block (leave the
   scouter-identity/superseding logic intact).
3. Mirror the constants into **seed-demo** and regenerate its synthetic logic.
4. Cross-check with one worked example: pick an input, compute the expected aggregate by
   hand, and confirm all three produce it. The unit tests cover the client; for the
   server, the e2e suite hits the real RPC (see verify doc) — add/adjust a case so a
   client/server divergence fails CI.

## Failure signature (so you recognize a desync later)

If the scout's review screen shows e.g. `fuelPoints = 42` but the dashboard's report
detail shows `41`, the client and server scoring disagree — almost always a rounding-site
or window-bound mismatch between `compute.ts` and the RPC. If the demo event's numbers
look internally wrong but real events are fine, it's `seed-demo` that drifted.
