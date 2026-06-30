# Export Presets — Alliance-Selection Sheet & Picklist-Tool Export

Feature class: Polish / integrations. Adds one-click, tool-shaped export presets to the
**Picklist** dashboard tab beyond the existing raw `picklist-{eventKey}.json` / `.csv`.

Two presets:

1. **Alliance-Selection Sheet** — a printable, human-readable sheet that merges the picklist
   order with per-team scouting aggregates (`TeamAgg`), best-available EPA (Statbotics → local
   match-result → in-house scouting estimate), team identity (nickname/city/state), and the
   lead's tier/note. Exportable as **CSV** and as a **print-optimized HTML** view (browser
   `window.print()` → "Save as PDF"), since the brief says "printable".
2. **Picklist-Tool Export** — a Statbotics/TBA-adjacent flat CSV keyed by `team_number` with
   `rank`, `epa`, `epa_source`, `tier`, `note`, plus the headline scouting metrics, suitable
   for importing into a generic picklist spreadsheet/tool.

> **EPA source labeling is PER-TEAM and TRUSTWORTHY.** A naive port of `RankingView` will NOT
> give a correct per-row `epa_source`, because `RankingView` only renders an event-wide banner
> plus a per-row `epaInHouse` boolean — it never emits a per-row source string. `useEventEpa`
> (as shipped) collapses every team's source into ONE event-wide `source` flag (`'statbotics'`
> if *any* team has Statbotics EPA), discarding the per-team `r.source` that `seasonEpaForTeam`
> already returns. To make `epa_source` correct for each row, this feature adds a small,
> additive `sourceByTeam` map to `useEventEpa` (§4.0). Do NOT claim "IDENTICAL to RankingView" —
> RankingView has no per-row source.

---

## 1. Overview & exact user-facing behavior

On the **Picklist** tab (`src/dash/PicklistView.tsx`), in the existing header button row
(currently `Save`, `Export JSON`, `Export CSV`), add an **Export Presets** group of three
buttons:

- **`Alliance Sheet (CSV)`** — `data-testid="pick-export-alliance-csv"`
- **`Alliance Sheet (Print)`** — `data-testid="pick-export-alliance-print"`
- **`Picklist Tool (CSV)`** — `data-testid="pick-export-tool-csv"`

Behavior:

- All three reuse the picklist's current **in-memory ordered `entries`** (the lead's working
  order, including unsaved edits) — they do not require a save first. Rank = 1-based index in
  `entries`.
- On click, the app lazily fetches the supporting data it does not already have:
  - per-team scouting aggregates (`aggregateEvent` over `useEventReports`),
  - EPA (`useEventEpa`) with the same precedence `RankingView` uses (Statbotics → local →
    in-house), PLUS the new per-team `sourceByTeam` map so each row's `epa_source` is correct,
  - team identity (nickname/city/state/rookieYear) via a new lazy `fetchTeamMetadata`.
- **`Alliance Sheet (CSV)`** downloads `alliance-sheet-{eventKey}.csv`.
- **`Picklist Tool (CSV)`** downloads `picklist-tool-{eventKey}.csv`.
- **`Alliance Sheet (Print)`** opens a print-styled standalone HTML document in a new tab/window
  and immediately calls `window.print()`. The doc has a header (`Alliance Selection — {eventKey}`,
  generated timestamp, EPA-source banner) and a table; the lead saves it as PDF or prints it.
- A small **EPA-source banner** (`data-testid="pick-export-epa-banner"`) appears in the header
  whenever EPA is NOT live Statbotics (mirrors `RankingView`'s banner copy): "local estimate from
  match results" or "in-house estimate from scouting data". This sets the lead's expectation
  before they print.
- **Unscouted teams in the picklist** (no `TeamAgg`) are STILL included in every preset, with
  identity columns filled (when metadata is available) and scouting/EPA columns showing the
  em-dash `—` (consistent with `picklistToCsv` exporting all entries as-is, and with
  `RankingView`'s `—` convention). This is decision (a) from the research gaps.
- Tier is treated as **free text passed through as-is** (no legend) — decision (b) from gap #4.
  The lead types whatever tier scheme they use.

No change to the existing JSON/CSV buttons or filenames.

---

## 2. Data model — NO migration needed

**No new migration.** This is a pure UI/export-layer composition of existing data:

- `team(team_number, nickname, city, state_prov, rookie_year)` — table from `0001_schema.sql`;
  anon/authenticated SELECT granted by `team_read_open` in `0009_overhaul.sql` (verified:
  `create policy team_read_open on team for select to anon, authenticated using (true)`). This is
  the no-auth/anon-RLS posture; `useEventTeams` already reads `event_team → team` unauthenticated,
  confirming read access. Already deployed (0009 is live), so NO migration is needed.
- `event_team(event_key, team_number)` — `0001_schema.sql`; `event_team_read_open` (0009).
- `picklist.entries` jsonb — `0007`.
- `match_scouting_report` rows — read via `useEventReports`, aggregated by the pure
  `aggregateEvent`.
- EPA via `useEventEpa` (Statbotics proxy + local fallback) — no new server surface.

`mapReport.ts`, the scoring model, and the `upsert_*` RPCs are **untouched** — presets only
read and format already-computed aggregates. The next migration, if any feature needs one,
would be `0033_`; this feature does not. **DO NOT mark any migration deployed for this feature.**

---

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/useEventData.ts` | **Additive only.** Add `sourceByTeam: Map<number, 'statbotics' \| 'local' \| 'none'>` to the `EventEpa` interface (OPTIONAL field — keep `?` so other agents' object-literal fixtures still type-check, matching the existing comment on `source`), and populate it inside `useEventEpa`'s `queryFn` by keeping each team's `r.source` (currently discarded). No change to the existing `source`/`available`/`epaByTeam` semantics, so `RankingView`/`NextMatchView` callers are unaffected. |
| `src/dash/presetExports.ts` **(new)** | New module holding all preset logic so `exportDash.ts` stays the core CSV/download primitives. Re-import `csvField`/`csvRow` helpers (see below). Exports: `interface TeamMetadata`; `interface PresetRow`; `buildPresetRows(...)`; `allianceSheetToCsv(rows, eventKey)`; `picklistToolCsv(rows)`; `allianceSheetToHtml(rows, eventKey, epaSource)`; `fetchTeamMetadata(teamNumbers, client?)`. |
| `src/dash/exportDash.ts` | Export the currently-private `csvField` and `csvRow` (add `export` keyword) so `presetExports.ts` reuses the exact escaping logic — do NOT duplicate CSV escaping. No behavior change to existing functions. |
| `src/dash/PicklistView.tsx` | Add the 3 preset buttons + EPA-source banner. Wire `useEventReports`/`useEventEpa`/`useEventMatches` + lazy `fetchTeamMetadata` on click. Pass `epaQuery.data?.sourceByTeam` into `buildPresetRows`. Add handlers `onExportAllianceCsv`, `onExportAlliancePrint`, `onExportToolCsv`. Add an `exporting`/`exportError` state pair for the lazy metadata fetch. |
| `src/dash/printWindow.ts` **(new, tiny)** | `openPrintWindow(html: string): void` — opens `window.open('', '_blank')`, writes the HTML doc, calls `print()`. Isolated so it can be mocked in unit tests and so `presetExports.ts` stays pure (HTML string builder only; side-effect lives here). |
| `src/dash/__tests__/presetExports.test.ts` **(new)** | Unit tests for `buildPresetRows` (incl. unscouted-with-no-EPA guard and per-team source from `sourceByTeam`), `fetchTeamMetadata` (error path → empty Map; column mapping), `allianceSheetToCsv`, `picklistToolCsv`, `allianceSheetToHtml`, EPA `—` degradation, unscouted-team inclusion, and CSV escaping of tier/note/nickname. |
| `src/dash/__tests__/PicklistView.test.tsx` | Add cases: the 3 preset buttons render; clicking each calls the right export. **Mock `@/dash/presetExports` WHOLESALE** (spy `buildPresetRows`/`allianceSheetToCsv`/`picklistToolCsv`/`allianceSheetToHtml`/`fetchTeamMetadata`) so the existing partial `@/dash/exportDash` mock (which exports only `downloadText`/`picklistToCsv`, NOT `csvField`/`csvRow`) is never pulled into the real preset builders — this keeps `PicklistView.test` a pure wiring test, with CSV/HTML logic covered only in `presetExports.test.ts`. Also mock `@/dash/printWindow.openPrintWindow`. |
| `tests/e2e/dashboard.spec.ts` | **EXTEND** the existing `'lead sees a next-match prediction and builds a persisted picklist'` test (which already sets the active event, navigates to Picklist, adds 254, and saves) by APPENDING the preset assertions — do NOT add a standalone `test()` block (it would lack `setActiveEvent` + the `test.skip` guards and time out on `needsEvent`). See §7.3. |

---

## 4. Core logic — formulas & data flow

### 4.0 `useEventEpa` — add per-team `sourceByTeam` (additive)

`useEventEpa` already calls `seasonEpaForTeam(team, …)` per team, and each result carries a
per-team `r.source` (`'statbotics'` | `'local'` | … from `seasonEpaForTeam`). Today the hook
throws that away and keeps only an event-wide `source`. We add an OPTIONAL `sourceByTeam` map so
the Picklist-Tool CSV can label each row's `epa_source` correctly.

```ts
export interface EventEpa {
  epaByTeam: Map<number, number | null>;
  available: boolean;
  source: 'statbotics' | 'local' | 'none';      // event-wide (unchanged)
  sourceByTeam?: Map<number, 'statbotics' | 'local' | 'none'>; // NEW, per-team
}

// inside useEventEpa queryFn, in the existing forEach:
sortedTeams.forEach((team, i) => {
  const r = results[i];
  epaByTeam.set(team, r.epa);
  sourceByTeam.set(team, r.epa != null ? (r.source as 'statbotics' | 'local') : 'none');
  if (r.epa != null) { anyEpa = true; if (r.source === 'statbotics') anyStatbotics = true; }
});
return { epaByTeam, available: anyEpa, source, sourceByTeam };
```

`sourceByTeam` is OPTIONAL (`?`) for the same reason `source` is — so other agents' object-literal
`EventEpa` fixtures (RankingView/TeamView/NextMatchView tests) keep type-checking. `useEventEpa`
ALWAYS sets it, so `buildPresetRows` can rely on it at runtime and fall back to the event-wide
`source` when a caller passes a fixture without it. No existing caller reads it, so this is a
pure additive change.

### 4.1 `TeamMetadata` and `fetchTeamMetadata`

```ts
export interface TeamMetadata {
  teamNumber: number;
  nickname: string | null;
  city: string | null;
  stateProv: string | null;
  rookieYear: number | null;
}

// Lazy, runs only on an export click. Single round-trip via event_team → team join,
// same shape useEventTeams uses but selecting the extra identity columns.
export async function fetchTeamMetadata(
  teamNumbers: number[],
  client = supabase,
): Promise<Map<number, TeamMetadata>> {
  const map = new Map<number, TeamMetadata>();
  if (teamNumbers.length === 0) return map;
  const { data, error } = await client
    .from('team')
    .select('team_number,nickname,city,state_prov,rookie_year')
    .in('team_number', teamNumbers);
  if (error) return map;            // degrade: identity columns just blank out
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const tn = Number(r.team_number);
    map.set(tn, {
      teamNumber: tn,
      nickname: (r.nickname as string) ?? null,
      city: (r.city as string) ?? null,
      stateProv: (r.state_prov as string) ?? null,
      rookieYear: (r.rookie_year as number) ?? null,
    });
  }
  return map;
}
```

Query the `team` table directly with `.in('team_number', …)` (the picklist team numbers) rather
than `event_team`, so a picklisted team that is not in `event_team` (rare, manual add) still gets
identity. `team` is open-read.

### 4.2 EPA resolution — same precedence as RankingView, with a correct PER-ROW source

The EPA *value* precedence matches `RankingView` (Statbotics/local external EPA when available,
else the in-house `scoutingExpectedPoints`). The *per-row source label* uses the new
`sourceByTeam` map (§4.0), because RankingView itself has no per-row source string — it only
shows a global banner + a per-row `epaInHouse` flag.

Two things RankingView's loop does NOT have to handle that `buildPresetRows` MUST:
1. **Unscouted teams.** RankingView iterates only scouted aggregates (`aggregateEvent` values),
   so `agg` always exists. `buildPresetRows` iterates ALL picklist entries, so `agg` can be
   `undefined`. The in-house branch must read `agg?.scoutingExpectedPoints`, never deref
   `undefined`.
2. **Per-team source.** `epa_source` must reflect THIS team's actual source, not the event-wide
   flag, otherwise a team that only resolved an in-house estimate gets mislabeled `'statbotics'`.

```
epaAvailable = epaQuery.data?.available === true
sourceByTeam = epaQuery.data?.sourceByTeam        // per-team (§4.0)
eventSource  = epaQuery.data?.source ?? 'none'    // fallback if sourceByTeam absent (fixtures)

for each entry (team):
  agg        = aggByTeam.get(team)                 // may be undefined (unscouted)
  inHouseVal = agg ? agg.scoutingExpectedPoints : null
  external   = epaAvailable ? (epaByTeam.get(team) ?? null) : null
  epaInHouse = external == null                    // we fell back to scouting for this team

  epa = epaInHouse ? inHouseVal : external          // null-safe: never derefs undefined agg

  if (epa == null)        epaSource = 'none'
  else if (epaInHouse)    epaSource = 'scouting'
  else                    epaSource = (sourceByTeam?.get(team) ?? eventSource) // 'statbotics' | 'local'
```

Notes:
- `epaInHouse` is `external == null` (per team), NOT `!epaAvailable` (event-wide). When the event
  source is `'statbotics'` but *this* team has no Statbotics number, `external` is null → we use
  the in-house estimate and label it `'scouting'` — correct, and what the event-wide rule got
  wrong.
- When `epa == null` (unscouted team AND no external source — e.g. both EPA sources down), the
  source is `'none'`; the CSV renders empty (tool) or `—` (sheet). No throw.

Answers open-question #2: when EPA is in-house we DO emit a number (= `scoutingExpectedPoints`,
same as RankingView's column) and label its source as `scouting`, rather than a separate column.

### 4.3 `PresetRow` and `buildPresetRows` — pure

```ts
export interface PresetRow {
  rank: number;                 // 1-based index in the picklist
  teamNumber: number;
  nickname: string | null;
  city: string | null;
  stateProv: string | null;
  tier: string | null;
  note: string | null;
  // scouting metrics — null when the team has no TeamAgg (unscouted)
  matchesScouted: number | null;
  expPts: number | null;        // agg.scoutingExpectedPoints
  fuelPts: number | null;       // agg.meanFuelPoints
  climbRate: number | null;     // agg.climbSuccessRate (0..1)
  defense: number | null;       // agg.avgDefenseRating
  reliability: number | null;   // agg.reliability (0..1)
  epa: number | null;
  epaSource: 'statbotics' | 'local' | 'scouting' | 'none';
}

export function buildPresetRows(
  entries: PicklistEntry[],
  aggByTeam: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  epaAvailable: boolean,
  eventSource: 'statbotics' | 'local' | 'none',
  metaByTeam: Map<number, TeamMetadata>,
  sourceByTeam?: Map<number, 'statbotics' | 'local' | 'none'>,  // §4.0; falls back to eventSource
): PresetRow[]
```

Iterate `entries` in order (rank = `i+1`); look up `agg`, `meta`, and resolve EPA per §4.2.
Unscouted teams (`agg === undefined`) get `null` metrics but keep rank/team/tier/note/identity —
the in-house EPA branch reads `agg ? agg.scoutingExpectedPoints : null`, so an unscouted team with
no external EPA yields `epa: null, epaSource: 'none'` and never dereferences `undefined`.
`buildPresetRows` reads ONLY `teamNumber`/`tier`/`note` from each `PicklistEntry` (so it stays
compatible with whatever extra fields smart-picklist adds to the entry model). Pure — fully
unit-testable with plain Maps.

### 4.4 CSV builders — reuse `csvField`/`csvRow`

`allianceSheetToCsv(rows, eventKey)` header (decision: human-readable column labels for the
printable sheet):

```
Rank,Team,Nickname,Location,Tier,Note,Matches,Exp Pts,FUEL Pts,Climb %,Defense,Reliability,EPA,EPA Source
```

- `Location` = `[city, stateProv].filter(Boolean).join(', ')` or empty.
- Numbers formatted: `expPts`/`fuelPts`/`defense` → 1 dp (`toFixed(1)`); `epa` → 0 dp; rates →
  whole-percent `"50%"`. `null` → `—`.
- All free-text (Nickname/Tier/Note/Location) flows through `csvField` so commas/quotes/newlines
  are escaped exactly like `picklistToCsv` (verified against existing test expectations).

`picklistToolCsv(rows)` header (machine-friendly snake_case keyed by `team_number`, the
Statbotics/TBA-adjacent flat shape):

```
rank,team_number,nickname,tier,note,epa,epa_source,exp_points,fuel_points,climb_rate,defense,reliability,matches_scouted
```

- `climb_rate`/`reliability` emitted as raw 0..1 decimals (machine import friendly), not `%`.
- `epa` → 1 dp or empty; `epa_source` is the literal enum string (`statbotics`/`local`/`scouting`/`none`).
- `null` numerics → empty field (not `—`) so a spreadsheet reads them as blank, not text.

### 4.5 `allianceSheetToHtml(rows, eventKey, epaSource)` — pure string builder

Returns a full self-contained `<!doctype html>` document with inline `<style>` (no external CSS,
must work offline). Includes:
- `<title>Alliance Selection — {eventKey}</title>`,
- a header `<h1>` + generated-at timestamp + the EPA-source note when `epaSource !== 'statbotics'`,
- a `<table>` mirroring the alliance-sheet CSV columns, top-3 rows visually emphasized
  (`font-weight:600`), `@media print { @page { size: landscape } }`,
- HTML-escape all text via a local `htmlEscape` (`& < > "`), since `csvField` is CSV-only.

`openPrintWindow(html)` in `printWindow.ts`:

```ts
export function openPrintWindow(html: string): void {
  const w = window.open('', '_blank');
  if (!w) return;                 // popup blocked → degrade silently (or caller shows note)
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}
```

### 4.6 Consistency with mapReport / scoring

Not touched. Presets consume `TeamAgg` (already produced by the frozen `SCORING`-based
`aggregate.ts`) and EPA (already resolved by `useEventEpa`). Because the server recomputes
aggregates, the client values shown are display-only — exactly the same status as everything
already on the dashboard. No wire-shape or scoring change, so nothing to keep in sync.

---

## 5. UI / UX

- **Where:** `PicklistView` `CardHeader`, in the existing `flex flex-wrap … gap-2` button row,
  appended after `Export CSV`. Keep all buttons `variant="outline"` and the `TOUCH` 44px class.
  On narrow screens they wrap naturally (the row is already `flex-wrap`).
- **Grouping:** wrap the 3 preset buttons in a `<div data-testid="pick-export-presets"
  className="flex flex-wrap items-center gap-2">` so e2e can scope to them.
- **States:**
  - `exporting` (boolean) — disables the 3 preset buttons and shows their label as `Working…`
    while `fetchTeamMetadata` + hook data settle on click.
  - `exportError` (string|null) — rendered as `data-testid="pick-export-error"` in the header
    (mirrors the existing `pick-save-error` styling) if metadata fetch throws unexpectedly;
    export still proceeds with blank identity columns (fetch already degrades to empty Map, so
    this is mostly a popup-blocked / no-rows note for the print path).
  - **EPA banner:** `data-testid="pick-export-epa-banner"`, only shown when EPA isn't live
    Statbotics, copy matching `RankingView`'s two cases.
- **Data wiring:** add at top of `PicklistView`:
  ```ts
  const reportsQuery = useEventReports(eventKey);
  const aggByTeam = useMemo(
    () => (reportsQuery.data ? aggregateEvent(reportsQuery.data) : new Map<number, TeamAgg>()),
    [reportsQuery.data],
  );
  const teamNumbers = useMemo(() => entries.map((e) => e.teamNumber), [entries]);
  const matchesQuery = useEventMatches(eventKey);
  // Pass matchesQuery.data for call-site parity with RankingView/NextMatchView. NOTE: the third
  // arg is accepted-but-UNUSED — EPA is season-wide (see useEventData.ts:339 and the season-EPA
  // refactor), so this does NOT feed a local fallback. It's purely so the call signature matches
  // the other tabs and the shared query key stays consistent.
  const epaQuery = useEventEpa(teamNumbers, eventKey, matchesQuery.data ?? []);
  ```
  These run on render (cheap, cached by TanStack Query, shared with RankingView's cache keys).
  `fetchTeamMetadata` is the only lazy/on-click fetch. The handlers pass
  `epaQuery.data?.sourceByTeam` (§4.0) into `buildPresetRows` for correct per-row `epa_source`.
- Buttons are disabled (or no-op) when `entries.length === 0` — nothing to export.

---

## 6. Offline behavior

Everything degrades gracefully and never throws into the shared `RouteError`:

- **Reports / aggregates:** `useEventReports` is persisted via the IndexedDB query cache; offline
  reload rehydrates the last good reports, so aggregates are available offline.
- **EPA:** `useEventEpa` reads `seasonEpaForTeam` (persisted, `EPA_STALE_TIME`; season-wide, not
  derived from the current event's matches). Offline + cache expired → `available:false` →
  per-team `external` is null → presets fall back to the in-house `scoutingExpectedPoints` with
  `epa_source = scouting` (or `none` for unscouted teams), and the EPA banner explains it. This is
  the accepted architecture behavior (see RankingView).
- **Team metadata:** `fetchTeamMetadata` degrades to an empty Map on any error (offline). Presets
  then emit blank `Nickname`/`Location` columns — the sheet still generates with rank/team/tier/
  note/scouting metrics. No hard failure.
- **Download:** `downloadText` is pure client Blob → no network. **Print:** `window.open` is local;
  the HTML is fully self-contained (inline styles), so the print sheet renders offline.
- Net: with zero network, the lead still gets a usable alliance sheet (scouting-derived EPA, blank
  team names) — exactly the local-first promise.

---

## 7. Test plan

### 7.1 Unit — `src/dash/__tests__/presetExports.test.ts`

Build fixtures with the same `agg()` factory pattern as `exportDash.test.ts`.

1. **`buildPresetRows` — happy path:** 2 scouted picklist entries → rows ranked 1,2 with metrics
   from the `TeamAgg`s and EPA from `epaByTeam` (`epaAvailable:true, source:'statbotics'`); assert
   `epaSource==='statbotics'`.
2. **`buildPresetRows` — unscouted team included:** entry with no `agg` → row present, `rank`
   correct, `matchesScouted/expPts/epa` all `null`, identity from `metaByTeam` preserved.
3. **`buildPresetRows` — in-house EPA:** `epaAvailable:false` → `epa === agg.scoutingExpectedPoints`,
   `epaSource==='scouting'`.
4. **`buildPresetRows` — per-team local EPA via `sourceByTeam`:** `epaAvailable:true`, event-wide
   `source:'statbotics'`, but `sourceByTeam` maps this team to `'local'` and `epaByTeam` has a
   number → row `epaSource==='local'` (proves per-row source, NOT the event-wide flag).
4b. **`buildPresetRows` — event source `'statbotics'` but team has NO external:** `epaAvailable:true`,
   `epaByTeam.get(team)===null`, team IS scouted → `epa===agg.scoutingExpectedPoints`,
   `epaSource==='scouting'` (the bug the old event-wide rule would have mislabeled `'statbotics'`).
4c. **`buildPresetRows` — UNSCOUTED team with NO EPA (regression guard):** entry with no `agg`,
   `epaAvailable:false` (both EPA sources down) → MUST NOT throw; row present with `epa:null`,
   `epaSource:'none'`, all metrics `null`. (This is the §4.2 unscouted+no-external path.)
4d. **`fetchTeamMetadata` — error path:** inject a fake client whose `.in()` resolves `{ error }`
   → returns an EMPTY Map (degrades, never throws). `fetchTeamMetadata` already takes a `client`
   param, so this is cheap.
4e. **`fetchTeamMetadata` — column mapping:** fake client resolves rows → Map maps
   `state_prov`→`stateProv` and `rookie_year`→`rookieYear` correctly, keyed by `team_number`.
5. **`allianceSheetToCsv` — header:** exact string
   `Rank,Team,Nickname,Location,Tier,Note,Matches,Exp Pts,FUEL Pts,Climb %,Defense,Reliability,EPA,EPA Source`.
6. **`allianceSheetToCsv` — formatting:** `Climb %` renders `"50%"`, `Exp Pts` 1 dp, `EPA` 0 dp,
   unscouted numerics render `—`, `Location` joins `city, state`.
7. **`allianceSheetToCsv` — escaping:** a nickname `Lobstah, "Bots"` and note `a,b` are wrapped and
   internal quotes doubled (assert against the same `csvField` behavior the existing test pins).
8. **`picklistToolCsv` — header + snake_case:** exact header string; `epa_source` enum literal;
   null numerics render as EMPTY field (not `—`); `climb_rate`/`reliability` raw decimals.
9. **`allianceSheetToHtml`:** contains `<title>Alliance Selection — 2026demo`, a `<table>`, one
   `<tr>` per row, HTML-escapes a nickname containing `<`/`&`, and includes the EPA note when
   `epaSource !== 'statbotics'`.

### 7.2 Unit — `src/dash/__tests__/PicklistView.test.tsx` (additions)

**Mock `@/dash/presetExports` WHOLESALE** (spy `fetchTeamMetadata` → resolves a Map, and
`buildPresetRows`/`allianceSheetToCsv`/`picklistToolCsv`/`allianceSheetToHtml` → return trivial
stubs). This is required: the existing file already mocks `@/dash/exportDash` with ONLY
`{ downloadText, picklistToCsv }`. `presetExports.ts` imports `csvField`/`csvRow` from
`exportDash`; if the real preset builders ran under that partial mock, `csvField` would be
`undefined` and break. Mocking `presetExports` wholesale keeps this a pure WIRING test (filename +
which-export-called) and leaves the CSV/HTML logic to `presetExports.test.ts`. Also mock
`@/dash/useEventData` hooks (small fixtures, incl. an `EventEpa` with `sourceByTeam`) and
`@/dash/printWindow.openPrintWindow` (spy). `@/dash/exportDash.downloadText` stays mocked as today.

1. Renders `pick-export-alliance-csv`, `pick-export-alliance-print`, `pick-export-tool-csv`.
2. Click `pick-export-alliance-csv` → `downloadText` called with first arg `alliance-sheet-2026demo.csv`,
   mime `text/csv`.
3. Click `pick-export-tool-csv` → `downloadText` first arg `picklist-tool-2026demo.csv`.
4. Click `pick-export-alliance-print` → `openPrintWindow` called once with an HTML string starting
   `<!doctype html>`.
5. EPA banner: when the mocked `useEventEpa` returns `available:false`, `pick-export-epa-banner`
   is visible with the in-house copy; when `source:'statbotics'`, the banner is absent.

### 7.3 Playwright e2e — `tests/e2e/dashboard.spec.ts` (single-worker, live `2026casnv`)

**Do NOT add a standalone `test()`.** The Picklist tab has `needsEvent:true`
(`DashboardScreen.tsx:37`); without an active event the picklist content never renders and
`pick-add-input` / `dash-picklist` time out. A new block would also miss the file's
`test.skip(!URL || !SECRET, …)` guard and the migration-0009 `beforeAll` probe. Instead, **APPEND**
to the existing `'lead sees a next-match prediction and builds a persisted picklist (no login)'`
test — it has already called `setActiveEvent(admin, eventKey)`, navigated to the Picklist tab,
added 254 (`pick-row-254` visible), and saved. Continue right after the existing
`expect(pick-saved)` assertion:

```ts
  // --- export presets (appended to the existing picklist test; 254 already added) ---

  // Register the print() no-op on the CONTEXT before opening the popup, so the
  // popup page inherits it at creation. addInitScript on context applies to all
  // pages opened afterwards.
  await page.context().addInitScript(() => { window.print = () => {}; });

  // Alliance Sheet CSV download.
  const dl1 = page.waitForEvent('download');
  await page.getByTestId('pick-export-alliance-csv').click();
  expect((await dl1).suggestedFilename()).toBe('alliance-sheet-2026casnv.csv');

  // Picklist Tool CSV download.
  const dl2 = page.waitForEvent('download');
  await page.getByTestId('pick-export-tool-csv').click();
  expect((await dl2).suggestedFilename()).toBe('picklist-tool-2026casnv.csv');

  // Print preset opens a new page (window.open). w.print() is a no-op in headless
  // Chromium and we've also stubbed it, so no dialog blocks.
  const popupPromise = page.context().waitForEvent('page');
  await page.getByTestId('pick-export-alliance-print').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(await popup.title()).toContain('Alliance Selection');
```

- Use `popup.title()` (the Playwright API that reads `document.title`), NOT
  `popup.locator('title').toHaveText(...)` — the `<title>` element lives in `<head>` and is not a
  visible node, so a locator assertion can race the `document.write`/flake. `waitForLoadState()`
  first ensures the written doc has parsed.
- `addInitScript` is registered on `page.context()` BEFORE the print click (and thus before the
  popup page is created), so the popup inherits the `print()` no-op. In practice headless Chromium
  treats `w.print()` as a no-op anyway, so this is belt-and-suspenders.
- Optional content tightening: read `await (await dl1).path()` and check the header line if the
  harness reads download bodies; otherwise the filename assertion is sufficient and avoids
  flakiness against live data.
- Demo-mode fallback: if `2026casnv` has no scouting data on a given run, the presets still export
  (unscouted rows with `—`/empty), so the filename assertions remain stable regardless of live data.

---

## 8. Conflict surface (vs the other 12 features)

| Feature | Shared file(s) | Conflict risk & mitigation |
| --- | --- | --- |
| **smart-picklist** | `src/dash/PicklistView.tsx`, `picklistClient.ts`, `exportDash.ts` | **HIGH.** Both edit the Picklist tab + entry model. Smart-picklist may add suggested ordering / extra `PicklistEntry` fields; presets read `entries` + `tier`/`note`. Coordinate: presets must consume whatever `entries` shape smart-picklist lands. Land one first, rebase the other. Both add header buttons — keep distinct `data-testid`s and button groups. |
| **alliance-simulator** | `src/dash/aggregate.ts` (read), `useEventData.ts` (EPA), possibly a new tab | MEDIUM. Likely consumes the same `TeamAgg`/EPA + picklist order; could reuse `buildPresetRows` and the new per-team `sourceByTeam`. Coordinate on the §4.0 `sourceByTeam` addition so EPA source labeling lives in ONE place (`useEventEpa`) rather than being re-derived (and re-mislabeled) per feature. |
| **matchup-intelligence** | `src/dash/useEventData.ts` (EPA hooks), `RankingView` | **MEDIUM** (raised from LOW: this feature now ALSO edits `useEventData.ts` for the additive `sourceByTeam` field on `EventEpa`). Both touch `useEventEpa`/`EventEpa`. Mitigation: this feature's edit is purely additive (one OPTIONAL field + one `set()` in the existing `forEach`), so it merges cleanly with a non-overlapping matchup-intelligence change; if matchup-intelligence refactors EPA resolution into a shared hook, presets should adopt `sourceByTeam` from it. Land one first, rebase the other. |
| **defense-analytics** | `src/dash/aggregate.ts` | LOW. May add fields to `TeamAgg`; presets only read existing fields, additive change is safe. |
| **report-correction** | sync / `mapReport.ts` / report rows | LOW. Changes upstream reports; presets read aggregates downstream — no direct file overlap. |
| **multi-scout-reconciliation** | report rows / `aggregate.ts` | LOW. Could change how aggregates dedupe; presets just consume the resulting `TeamAgg`. |
| **coverage-gaps / scouter-load-accuracy / distribution-trend / auto-path-heatmap / dashboard-heartbeat / match-video** | mostly separate dash components | NONE/LOW. No shared edit targets with the preset files. |

Primary collision is **smart-picklist** (same component + entry model). For EPA, the source-of-truth
home is now `useEventEpa`'s additive `sourceByTeam` map (§4.0), NOT an inlined `presetExports`
helper — this is the cleaner shared home flagged by review, so **alliance-simulator** and
**matchup-intelligence** consume the same per-team source instead of each re-deriving (and
re-mislabeling) it. `buildPresetRows` reads `sourceByTeam` and only `teamNumber`/`tier`/`note` off
each entry, so it survives whatever `PicklistEntry` shape smart-picklist lands.

---

## 9. Step-by-step execution checklist

1. **`useEventData.ts`:** add the OPTIONAL `sourceByTeam?` field to `EventEpa` and populate it in
   `useEventEpa`'s `forEach` (§4.0). Run `npm run typecheck` + the RankingView/NextMatch tests to
   confirm the additive change breaks no existing EPA fixtures.
2. **`exportDash.ts`:** add `export` to `csvField` and `csvRow` (no other change). Run
   `npm test -- exportDash` to confirm existing tests still pass.
3. **Create `src/dash/printWindow.ts`** with `openPrintWindow(html)` as in §4.5.
4. **Create `src/dash/presetExports.ts`:**
   - `import { csvField, csvRow } from '@/dash/exportDash'` and `supabase`, `TeamAgg`, `PicklistEntry`.
   - Add `TeamMetadata`, `PresetRow`, `fetchTeamMetadata`, `buildPresetRows`, `allianceSheetToCsv`,
     `picklistToolCsv`, `allianceSheetToHtml`, plus local `htmlEscape`.
5. **Write `src/dash/__tests__/presetExports.test.ts`** (§7.1, incl. the unscouted-no-EPA guard
   4c and the `fetchTeamMetadata` cases 4d/4e) and make it pass:
   `npx vitest run src/dash/__tests__/presetExports.test.ts`.
6. **Edit `PicklistView.tsx`:**
   - Add hook wiring + `aggByTeam`/`teamNumbers`/`epaQuery` memos (§5).
   - Add `exporting`/`exportError` state.
   - Add `onExportAllianceCsv`, `onExportAlliancePrint`, `onExportToolCsv` handlers: set
     `exporting`, await `fetchTeamMetadata(teamNumbers)`, build rows via `buildPresetRows`
     (passing `epaQuery.data?.sourceByTeam`), then `downloadText(...)` or
     `openPrintWindow(allianceSheetToHtml(...))`; clear `exporting` in `finally`.
   - Add the `pick-export-presets` button group, the EPA banner, and the error span.
7. **Extend `PicklistView.test.tsx`** (§7.2 — mock `@/dash/presetExports` WHOLESALE); run
   `npx vitest run src/dash/__tests__/PicklistView.test.ts`.
8. **`npm run typecheck`** — confirm clean.
9. **Extend the existing picklist e2e** (§7.3) in `tests/e2e/dashboard.spec.ts` (append to the
   existing test, do NOT add a standalone block); run
   `npx playwright test tests/e2e/dashboard.spec.ts` (single-worker, live `2026casnv`).
10. **`npm test`** full suite + **`npm run build`**.
11. **No migration, no `supabase db push`, no functions deploy** for this feature — purely
    frontend. Do NOT mark any migration deployed.
12. Frontend ships via Vercel on merge to `main`.
