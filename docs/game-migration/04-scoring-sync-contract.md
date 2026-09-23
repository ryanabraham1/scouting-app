# The Scoring Sync Contract (read before touching any scoring math)

Scoring aggregates are computed from raw inputs in **three independent implementations**.
They must produce **identical numbers** for the same input, or the app silently shows
inconsistent data. This is the single most important invariant in a season migration.

## The three implementations

| # | Implementation | Language | Role |
|---|---|---|---|
| 1 | `src/scoring/` (`constants.ts`, `windows.ts`, `compute.ts`) | TypeScript | Client preview shown to the scout during/after capture. |
| 2 | `recompute_match_report_aggregates` called by the `upsert_match_report` RPC | PL/pgSQL | **Source of truth for stored aggregates.** Recomputes from the raw inputs the client uploads. |
| 3 | `supabase/functions/_shared/demoScoring.ts` (burst generator, attributed-points → fuel), used by `seed-demo/index.ts` | TypeScript (Deno) | Generates synthetic demo data; must match so demo numbers are self-consistent. Pinned by the pure contract test `tests/functions/seed-demo-scoring.test.ts`. |

## Why three, and why the server wins

The client computes aggregates for instant feedback, but it **does not upload them** —
`src/sync/mapReport.ts` sends only **raw inputs** (`fuel_bursts`, `no_show`,
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
4. **Treat every shooting burst as scored.** `inactiveFirst` remains in legacy report shapes
   for compatibility but does not affect the aggregate.
5. **Sum Teleop**: `transition + Σ shift1..shift4`. Store that in the legacy
   `teleopFuelActive` / `teleop_fuel_active` field and store `0` in the legacy inactive field.
6. **Sum points**: `(auto + all teleop + endgame) × FUEL_POINTS`.
7. Emit `autoFuel`, `teleopFuelActive`, `teleopFuelInactive = 0`, `endgameFuel`,
   `fuelByShift[1..4]`, `fuelPoints`.

The SQL fixed-point rounding mirrors the TS line-for-line:

```sql
-- msr_round_half_up  ↔  src/scoring/compute.ts roundHalfUp
floor(p_val + 0.5)::int
```

## Endgame / climb (2026 status)

Climb scouting was removed end-to-end on 2026-09-21 (commit `a31297e`): the capture flow,
local report shape, upsert wire shape, `SCORING.CLIMB`, every dashboard climb stat, and
seed-demo climb generation are gone. `upsert_match_report` still accepts the legacy
`climb_*` keys and coalesces absent ones to `0`/`false`, so those DB columns are inert.
Today every attributed point is **fuel** in all three implementations.

If a future game scores an endgame action you want scouted, decide first whether the
server should aggregate it (add it to the recompute and store a new column — then it
joins this contract) or keep it dashboard-side only (then it is a client concern, like
the old 2026 climb was).

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
