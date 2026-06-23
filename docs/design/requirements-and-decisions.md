# FRC Scouting App — Requirements & Decisions Log

_Living document. Captures decisions made during brainstorming for the 2026 REBUILT scouting app._
_Last updated: 2026-06-23_

## Context

- **Team:** 3256 "WarriorBorgs" (San Jose, CA) — single-team app (not multi-tenant).
- **Game:** 2026 FRC **REBUILT presented by Haas**. Full game model in
  [`docs/research/2026-rebuilt-game-reference.md`](../research/2026-rebuilt-game-reference.md).
- **Goal/driver:** Build it right, no hard deadline (learning / next-season prep / reusable).
- **Test event:** `2026casnv` — CA District Silicon Valley Event presented by Apple
  (Mar 13–15 2026, 37 teams, 89 matches). Verified reachable via TBA.

## Platform & stack

| Decision | Choice |
|---|---|
| App type | **PWA** (installable, offline-first) — web now, phone-first delivery |
| Frontend | React + Vite |
| Offline storage | IndexedDB (client) |
| Backend / DB | Supabase (Postgres + Auth + Storage + RLS) |
| External data | TheBlueAlliance API (schedule, teams, results), Statbotics API (EPA/predictions) |

## Auth & access

- **Scouters:** name + short **event code**, no passwords. Frictionless on shared phones.
- **Admin/lead:** real secured login (Supabase Auth).
- Roles: `scouter`, `lead/dashboard`, `admin`.

## Subsystems (scope)

1. **Scouter capture app** — offline-first match & pit scouting.
2. **Admin tools** — set event via TBA code, import schedule, assign scouts (manual + auto).
3. **Sync + transfer** — Supabase sync (try-upload-when-online) + **QR transfer** between devices.
4. **Drive-coach / pit dashboard** — aggregates scouting + TBA + Statbotics.

## Match scouting capture (the core)

Game twist: each alliance's HUB is **inactive during 2 of the 4 ALLIANCE SHIFTS** (FUEL scored
then = 0 pts), and the **AUTO FUEL leader is penalized first** (HUB inactive in SHIFT 1).
Therefore scoring must be **attributed to the active/inactive time window**, not just the phase.

- **FUEL capture:** **timed hold-to-shoot + rate slider.** App runs an **in-app match timer**
  (scout taps START at match start); scout holds a button while the robot is scoring and sets a
  FUEL/sec rate. App integrates rate × time and **auto-attributes each burst to AUTO / SHIFT 1–4 /
  ENDGAME**, computing active-vs-inactive scoring automatically.
- **Climb (endgame):** final **level (none/1/2/3)** + **success/fail** (attempted-but-failed). No timing.
- **Also tracked per robot:**
  - Intake source (NEUTRAL floor / DEPOT / human feed) + max FUEL capacity observed.
  - Defense rating + pins (esp. during own inactive shifts).
  - Fouls committed/drawn (minor/major).
  - Reliability flags: no-show, died/disabled, tipped, dropped FUEL, fed own CORRAL.
- **Coverage:** up to **6 scouts, one robot each** per match (clean 1:1).
- **Pit scouting:** yes — per-team robot specs (drivetrain, mechanisms, claimed capabilities) + **photo**.
- **Free-text match notes** per scouted match.

## Admin / assignments

- Admin sets the active event by **TBA event key**; app imports the **match schedule** + team list.
- Assignment: **manual** + **auto-generate**.
- Auto-assign strategy: **balanced rotation + rest breaks** (even load, rotate alliance position, insert breaks).

## Dashboard (drive-coach / pit)

- In-app **lead/dashboard role**, assumes **internet** at the table; falls back to last-synced data offline.
- Views (all in scope): **next-match preview**, **team deep-dive**, **ranking/compare table**,
  **alliance-selection picklist**.
- **Prediction:** blend our scouting estimates with **Statbotics EPA** (degrade gracefully if Statbotics down).
- **Lead sync-status view:** which matches are scouted / synced / stuck on a device.

## Extras in scope

- CSV/JSON export of all scouting + computed stats.
- Pit robot photos (Supabase Storage).
- Free-text match notes.

## Credentials / services

- **TBA API key:** provided, verified working. Store in gitignored `.env.local` (read-only key, low risk).
- **Statbotics:** no key required (open API). Currently returning 500s (temporary outage 2026-06-23).
- **Supabase:** TODO — need project URL + anon key (see "What I need from you" in the design).

## Resolved in design (2026-06-23)

- **Sync strategy:** local-first queue + **revision-guarded** idempotent upsert (server-authoritative
  ordering via `row_revision` + `server_received_at`); QR is **replication, not custody transfer**.
- **FUEL attribution:** per-shift via the in-app clock; **hold-to-shoot + rate slider kept** (team
  call), but treated as a **low-confidence estimate** and **down-weighted in analytics**; raw bursts
  retained for recompute.
- **Build order:** spine-first, **Phase 0→4** (Phase 0 also owns the versioned scoring/compute/
  migration module + the canonical write contract).
- **Scope:** **qualification matches only** (picklist for alliance selection); **playoff scouting out
  of scope**; **Team 3256 not scouted**. **Drive-team members are not app users** (they don't scout).
- **Autonomous routines:** scouts capture auto **start position + a drawable path** on a shared
  `FieldDiagram` (+ auto stats). Drive-coach dashboard **overlays both alliances' auto routines** for
  the next match; **3256 omitted** from our-alliance display.
- **Field asset:** official `FE-2026-_REBUILT_Playing_Field_With_Fuel_With_Background.png` (at repo
  root) is the diagram background, vendored to `public/assets/field/` during scaffold; tap/draw coords
  stored normalized `[0,1]²`.
- **Security model:** anonymous auth + per-scout RLS; cross-scout/QR data via a SECURITY DEFINER
  `ingest_reports` (HMAC-checked); join code is a soft gate, stored off the scout-readable row.

## Still open (verify before/within implementation)

- Confirm game scoring constants against the PDF tables (FUEL pts, climb LEVEL pts, RP & foul values).
- Confirm Statbotics v3 endpoint shapes once their API is back up (was 500ing 2026-06-23).
- Visual identity (team colors / theme) — pick during Phase 0 UI scaffold.

## Supabase status (2026-06-23)

- ✅ Project verified live: `https://oztsfxyfovwnwutrxzmo.supabase.co` (empty schema, ready for Phase 0).
- ✅ Keys stored gitignored in `.env.local`: publishable (client) + secret (server-only) + TBA key.
- ⚠️ **Roll the secret key** after setup — it was shared in chat. Then update `.env.local`.
- ⚠️ **Anonymous sign-in** still read `false` via the settings API after the toggle — confirm it's
  saved; verified for real by an anon sign-in at the start of Phase 0.

## UI styling (2026-06-23)
- **shadcn/ui** (new-york style, slate base, CSS-variable tokens, **dark by default**) on Tailwind.
  `cn()` util + `@/*` path alias; base components Button/Input/Label/Card set up in Phase 0 task A2S;
  all screens (JoinScreen, dashboard, capture) build on these. Mobile-first, ≥44px touch targets.
