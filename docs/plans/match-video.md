# Match Video Embeds (TBA YouTube) — Implementation Plan

> Status: feature is ~95% built and functional. `src/dash/MatchVideo.tsx` +
> `src/dash/useYouTubePlayer.ts` exist and are wired into both `TeamView`
> (LastMatchCard) and `MatchView` (MatchVideoCard). This plan covers the small
> **polish gaps** that remain to make the experience robust on a flaky venue
> network, plus the test coverage to lock it in. **No new feature scaffolding is
> needed; this is hardening + UX affordances.**

---

## 1. Overview & exact user-facing behavior

The dashboard already embeds the official TBA-linked YouTube match video next to
the activity timeline in two places:

- **TeamView → "Last match" card** (`LastMatchCard`, `TeamView.tsx:317`): shows
  the most recently scouted match's video with a "Sync to match start" control
  that aligns the activity timeline playhead to the running video.
- **MatchView → "Match video" card** (`MatchVideoCard`, `MatchView.tsx:89`): same
  embed + sync control for the match currently being inspected.

**Current behavior (verified in code):**

1. The card calls `tbaGet('/match/{matchKey}')` through TanStack Query
   (`queryKey: ['tba','match', matchKey]`, `staleTime` 5 min).
2. `firstYoutubeKey()` extracts the first `videos[]` entry where
   `type === 'youtube'` and `key` is a non-empty string.
3. If a key exists → renders a responsive 16:9 `<iframe>` to
   `https://www.youtube.com/embed/{key}?enablejsapi=1&origin={window.location.origin}`
   (testid `match-video-frame`).
4. `useYouTubePlayer` injects `https://www.youtube.com/iframe_api` once, attaches a
   `YT.Player`, and polls `getCurrentTime()` every 250 ms, reporting ms up to the
   card so "Sync to match start" can offset the timeline.
5. States: loading (`match-video-loading`), no youtube video
   (`match-video-none`, "No video available"), fetch error
   (`match-video-error`, "Couldn't load match video.").

**What changes in this plan (target user-facing behavior):**

- **Graceful TBA degradation:** when TBA is down, the card shows a calm
  "Video unavailable — TBA offline" note (info tone) instead of the louder error
  state, matching the Statbotics/Nexus degrade pattern. No console throw, no
  retry storm.
- **"Watch on YouTube" link fallback:** whenever a youtube key is known, a small
  external-link affordance under the embed opens
  `https://youtu.be/{key}` in a new tab — covers regions/devices where the iframe
  CDN is blocked but the link still works, and lets users open the video full
  screen on the YouTube app.
- **Caption for pending video:** the "No video available" note gains a one-line
  hint ("Videos usually appear 1–4h after the match") so leads don't think it's
  a bug for early matches.

These are additive; the embed + sync flow is unchanged when TBA is healthy and a
video exists.

---

## 2. Data model

**No migration is needed. Do not create migration 0033 for this feature.**

Match video keys are a transient TBA API read fetched on demand through
`tba-proxy` (60 s in-memory edge cache + 5 min client TanStack staleTime). They
are never persisted to the `match` table, and there is no aggregate computed from
them. The research's open question about persisting `video_keys jsonb` for
offline replay is **explicitly out of scope** here: a YouTube embed cannot play
offline regardless of where the key is stored, so caching the key buys nothing
for the offline-first goal. If a future feature wants "video availability" badges
in the match list without a live fetch, that would be a separate, separately
numbered migration — not this one.

---

## 3. Files to create / modify

| Path | Precise change |
| --- | --- |
| `src/dash/proxies.ts` | No change. `tbaGetOptional<T>()` already exists (lines 51–67) and returns the `{ available: false }` sentinel on any non-2xx/network error. MatchVideo will switch to it. |
| `src/dash/MatchVideo.tsx` | (a) Switch the query fn from `tbaGet` to `tbaGetOptional`; on `isUnavailable(data)` render a new info-tone `match-video-unavailable` note instead of relying on a thrown error. Keep the existing `match-video-error` branch for genuine query errors (kept as a belt-and-suspenders path). (b) Add a "Watch on YouTube" anchor (`https://youtu.be/{ytKey}`, `target="_blank" rel="noopener noreferrer"`, testid `match-video-yt-link`) rendered beneath the `PlayerFrame`. (c) Add the "Videos usually appear 1–4h after the match" hint line to the `match-video-none` branch. |
| `src/dash/__tests__/MatchVideo.test.tsx` | Update the proxies mock to also expose `tbaGetOptional` + `isUnavailable`; add tests for the unavailable sentinel branch and the "Watch on YouTube" link. Keep existing 7 tests (adjust the `tbaGet`→`tbaGetOptional` mock target). |
| `tests/e2e/dashboard.spec.ts` | Add an e2e scenario asserting the Match video card and its fallback render on the live MatchView (selectors below). Reuses the existing single-worker live-event harness. |
| `src/dash/useYouTubePlayer.ts` | No change — already graceful and correct. |
| `src/dash/TeamView.tsx` | No change to wiring; the new link/notes render inside `MatchVideo` so `LastMatchCard` gets them for free. |
| `src/dash/MatchView.tsx` | No change to wiring; same — `MatchVideoCard` gets the new affordances via `MatchVideo`. |
| `supabase/functions/tba-proxy/index.ts` | No change. It already returns 502 (not an unhandled throw) on upstream failure, which `tbaGetOptional` converts to the sentinel. |

---

## 4. Core logic

There is **no aggregate or scoring computation** in this feature, so `mapReport.ts`
and `src/scoring/` are untouched and stay consistent by not being involved. The
only pure helpers are:

**`firstYoutubeKey(match)` (existing, unchanged):**
```
videos = match?.videos
if not Array.isArray(videos): return null
return first v in videos where v.type === 'youtube' && typeof v.key === 'string' && v.key, else null
```

**New: unavailability handling in the render branch.** After the query resolves,
order of precedence (the `isUnavailable` guard MUST come before any
`firstYoutubeKey(query.data)` call so TypeScript narrows `query.data` from
`TbaMatch | ProxyUnavailable` down to `TbaMatch` at the `firstYoutubeKey` call
site — early-return the unavailable branch):
```
if query.isLoading         -> loading note
else if query.isError      -> match-video-error (genuine query rejection; rare,
                              defensive — tbaGetOptional never rejects in prod)
else if isUnavailable(query.data) -> EARLY RETURN match-video-unavailable
                              (TBA offline, info tone). After this point
                              query.data is narrowed to TbaMatch.
else if firstYoutubeKey(query.data) is non-null -> PlayerFrame + "Watch on YouTube"
else                       -> match-video-none + "appears 1–4h after match" hint
```

> Implementation note: do NOT widen `firstYoutubeKey`'s signature to accept the
> union. Keep it `TbaMatch | undefined` and rely on the early-return narrowing
> above. `npm run typecheck` (step 9) is the gate that proves the narrowing flows
> through.

**Watch-on-YouTube URL:** `https://youtu.be/${encodeURIComponent(ytKey)}`. Keys
are 11-char YouTube IDs; `encodeURIComponent` is defensive against odd TBA data.

**Player time → sync offset (existing, unchanged, documented for completeness):**
`useYouTubePlayer` reports `getCurrentTime() * 1000` ms. The cards convert to
seconds (`ms / 1000`), and "Sync to match start" sets `offsetSeconds =
videoSeconds`. Timeline playhead = `clamp(0, MATCH_MS, (videoSeconds -
offsetSeconds) * 1000)`. Untouched by this plan.

---

## 5. UI/UX

- **Where:** inside the `MatchVideo` component, which is embedded in
  `TeamView`'s `LastMatchCard` (testid `team-last-match`) and `MatchView`'s
  `MatchVideoCard` (testid `match-video-sync` region). No layout changes to the
  cards themselves; the new elements live in the `MatchVideo` body and inherit
  the existing `max-w-xl` centered column.
- **States rendered by `MatchVideo`:**
  - `match-video-loading` — "Loading match video…" (existing).
  - `match-video-frame` — the 16:9 iframe (existing) **+ new** `match-video-yt-link`
    anchor: a small right-aligned text link with the lucide `ExternalLink` icon,
    "Watch on YouTube", `text-xs text-muted-foreground hover:text-foreground`,
    rendered directly below the `Frame`.
  - `match-video-none` — "No video available" (existing) **+ new** muted hint
    line "Videos usually appear 1–4h after the match." (`text-xs
    text-muted-foreground`).
  - `match-video-unavailable` — **new** info-tone note "Video unavailable — TBA
    offline" using the lucide `Video` icon and `text-muted-foreground` (calmer
    than the warning-toned error).
  - `match-video-error` — existing warning note retained for non-sentinel query
    failures.
- **Tone parity:** unavailable uses `text-muted-foreground` to match how
  Statbotics/Nexus outages read as "unavailable", not "broken".
- **Accessibility:** the YouTube link has discernible text ("Watch on YouTube"),
  `target="_blank"` with `rel="noopener noreferrer"`.

---

## 6. Offline behavior

- **No network at all:** `tbaGetOptional` catches the fetch rejection → sentinel →
  `match-video-unavailable` note. The rest of the card (activity timeline, sync
  controls) renders normally because the video query no longer throws. The
  TanStack persisted cache (IndexedDB) may rehydrate a previously fetched match
  object; if that cached object had a youtube key, the embed still mounts but the
  YouTube iframe will fail to load media offline — `useYouTubePlayer` never gets a
  ready event, so `onTimeMs` is never called and the timeline degrades to no
  playhead (no throw). The "Watch on YouTube" link is still present for when
  connectivity returns.
- **TBA up but video not yet posted (early match):** `videos[]` has no youtube
  entry → `match-video-none` + the 1–4h hint. Expected, not an error.
- **YouTube CDN/iframe blocked:** the iframe may render blank, but the
  `match-video-yt-link` anchor gives a working escape hatch.
- **No DB writes, no outbox, no sync interaction** — this feature is read-only and
  does not touch `localStore`, the dirty queue, or any RPC.

---

## 7. Test plan

### Unit (Vitest — `src/dash/__tests__/MatchVideo.test.tsx`)

Update the mock to provide all three proxy exports the component now imports:
```ts
const tbaGetOptionalMock = vi.fn();
vi.mock('@/dash/proxies', () => ({
  tbaGetOptional: (p: string) => tbaGetOptionalMock(p),
  isUnavailable: (b: unknown) =>
    typeof b === 'object' && b !== null && (b as { available?: unknown }).available === false,
}));
```

Tests (existing seven, adapted to `tbaGetOptionalMock`, plus new):
1. **embeds first youtube video** — resolves `{ videos:[{type:'tba'},{type:'youtube',key:'dQw4w9WgXcQ'}] }`; assert `match-video-frame` src contains `youtube.com/embed/dQw4w9WgXcQ` and `tbaGetOptional` called with `/match/2026casnv_qm1`.
2. **enablejsapi when onTimeMs supplied** — assert src contains `enablejsapi=1`.
3. **graceful when YT API never loads** — `onTimeMs` never called (jsdom has no `window.YT`).
4. **loading state** — pending promise → `match-video-loading`.
5. **no-video state** — `{ videos:[{type:'tba'}] }` → `match-video-none` present.
6. **missing videos array** — `{}` → `match-video-none` present.
7. **error state (defensive)** — forced rejected promise → `match-video-error`
   present. Rename/comment this test to make clear it exercises the *retained
   defensive* `query.isError` branch via a forced mock rejection;
   `tbaGetOptional` never rejects in production, so this no longer reflects real
   proxy behavior and is kept only as belt-and-suspenders for the retained branch.
8. **NEW: TBA-unavailable sentinel** — resolves `{ available:false }` → asserts `match-video-unavailable` present and `match-video-error` absent.
9. **NEW: Watch-on-YouTube link** — resolves a youtube video → asserts `match-video-yt-link` href is `https://youtu.be/dQw4w9WgXcQ`, `target="_blank"`, `rel` contains `noopener`.
10. **NEW: pending-video hint** — no-video case asserts the "1–4h" hint text is in the document alongside `match-video-none`.

Run: `npx vitest run src/dash/__tests__/MatchVideo.test.tsx`.

### Playwright e2e (`tests/e2e/dashboard.spec.ts`, single-worker, live `2026casnv` / demo)

Live TBA may or may not have a video for any given match, so assertions target
the **card existence + one of the valid terminal states**, never the iframe
loading real media.

**Harness rules (all three scenarios) — these were the failure points; do not
deviate:**

- **Route is `/dashboard`, not `/dash`.** `/dash` is not a route; it falls through
  the catch-all `{ path: '*', element: <Navigate to="/" /> }` and redirects to
  Home, so every assertion would fail. Use `page.goto('/dashboard')` to match the
  existing `dashboard.spec.ts`.
- **Set the active event first.** The Match/Team tabs are gated behind an active
  event (`DashboardScreen` renders `data-testid="dashboard-no-event"` otherwise).
  Call `await setActiveEvent(admin, eventKey)` immediately before `goto`, reusing
  the file-level `admin` client + `eventKey` (`2026casnv`). Because `workers: 1`
  and `event.is_active` is a shared singleton, set it inside each test right
  before navigating (do not rely on another describe block's ordering).
- **Reuse the existing skip/probe guards.** Add `test.skip(!URL || !SECRET, …)` at
  the top of each test (mirroring `dashboard.spec.ts:33`); the migration-0009
  `scouter_roster` probe in the shared `beforeAll` already covers the rest.
- **Tab names are exact, not regex.** Both "Next Match" and "Match" expose
  `role="tab"`, so `{ name: /match/i }` matches 2 elements and throws under strict
  mode. Use `{ name: 'Match', exact: true }`. `{ name: 'Team' }` is unambiguous.
- **Match selection is `match-item-*` inside `match-list`.** There is no
  `match-row` testid. Use `page.locator('[data-testid^="match-item-"]').first()`.
- **Team selection is a `<select>` dropdown, not rows.** There is no `team-row`
  testid; `TeamView` uses `data-testid="team-select"`. Drive it with
  `selectOption({ index: 1 })` (skip the placeholder `<option value="">`).
  `team-last-match` only renders when the chosen team has a scouted match
  (`lastReport != null`), so the assertion must tolerate its absence or the test
  must pick a team known to have reports.

Put all three in an isolated `test.describe('match video', …)` block to minimize
merge friction with other dash features appending to this file.

Scenario A — **Match video card renders on MatchView**:
```ts
test('match video card renders with a valid terminal state', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Match', exact: true }).click();
  await page.locator('[data-testid^="match-item-"]').first().click();
  await expect(page.getByText('Match video')).toBeVisible();           // CardTitle
  // one of the terminal states must appear (frame, none, unavailable, or error)
  await expect(
    page.locator(
      '[data-testid="match-video-frame"], [data-testid="match-video-none"], [data-testid="match-video-unavailable"], [data-testid="match-video-error"]'
    ).first()
  ).toBeVisible({ timeout: 15_000 });
  // NOTE: do NOT assert match-sync-now is disabled. It is disabled only while
  // !hasTime; against live YouTube the IFrame API can load and report a
  // currentTime, flipping hasTime true and enabling the button — racy/time-
  // dependent. The terminal-state existence assertion above is the robust check.
});
```

Scenario B — **Watch-on-YouTube link appears when a video exists** (conditional,
skips cleanly when the live match has no video yet):
```ts
test('watch-on-youtube link present when a video exists', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Match', exact: true }).click();
  await page.locator('[data-testid^="match-item-"]').first().click();
  const frame = page.getByTestId('match-video-frame');
  if (await frame.count()) {
    const link = page.getByTestId('match-video-yt-link');
    await expect(link).toHaveAttribute('href', /^https:\/\/youtu\.be\//);
    await expect(link).toHaveAttribute('target', '_blank');
  } else {
    test.skip(true, 'live match has no TBA video yet');
  }
});
```

Scenario C — **TeamView last-match card hosts the same embed states**:
```ts
test('team view last-match card shows a video terminal state', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Team' }).click();
  // Team selection is a dropdown; index 1 skips the placeholder option.
  await page.getByTestId('team-select').selectOption({ index: 1 });
  // team-last-match only renders if the selected team has a scouted match.
  // Tolerate absence: only assert the embed states when the card is present.
  const card = page.getByTestId('team-last-match');
  if (await card.count()) {
    await expect(card).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="match-video-frame"], [data-testid="match-video-none"], [data-testid="match-video-unavailable"]'
      ).first()
    ).toBeVisible({ timeout: 15_000 });
  } else {
    test.skip(true, 'selected team has no scouted match (no last-match card)');
  }
});
```

> All selectors above are verified against the source: `/dashboard`
> (`router.tsx:67`), `match-item-${m.match_key}` inside `match-list`
> (`MatchView.tsx:327,338`), `team-select` (`TeamView.tsx:960`), `team-last-match`
> (`TeamView.tsx:332`), exact tab labels "Match"/"Team"/"Next Match"
> (`DashboardScreen.tsx:32–36`).
> Run: `npx playwright test tests/e2e/dashboard.spec.ts`.

---

## 8. Conflict surface (overlap with the other 12 planned features)

Files this plan touches: `src/dash/MatchVideo.tsx`,
`src/dash/__tests__/MatchVideo.test.tsx`, `src/dash/proxies.ts` (read-only — no
edit), `tests/e2e/dashboard.spec.ts`.

| Feature | Shared files / risk |
| --- | --- |
| **matchup-intelligence** | Likely edits `MatchView.tsx`. This plan does **not** edit `MatchView.tsx` (changes are contained in `MatchVideo.tsx`), so conflict is limited to `tests/e2e/dashboard.spec.ts` if both add e2e blocks — append to distinct `test.describe` groups. |
| **defense-analytics / distribution-trend / auto-path-heatmap / multi-scout-reconciliation** | These edit `TeamView.tsx` and/or the activity timeline. This plan does **not** edit `TeamView.tsx`; only `MatchVideo.tsx`. The shared concept is the timeline-sync playhead (`onTimeMs` → `videoSeconds`), which lives in those cards' state, not in `MatchVideo`. If a timeline feature changes the playhead consumer, the `MatchVideo` `onTimeMs` contract (ms number) must stay stable. |
| **export-presets** | May read `MatchView`/`TeamView` for export; no video data is exported (transient TBA read), so no data-shape conflict. |
| **dashboard-heartbeat** | If it touches `proxies.ts` to add a health indicator, coordinate on `proxies.ts` (this plan only *reads* `tbaGetOptional`, adds nothing there). Low risk. |
| **smart-picklist / alliance-simulator / coverage-gaps / scouter-load-accuracy / report-correction** | Different surfaces (PicklistView, ScoutersTab, ReportDetail, aggregate). No file overlap. |

**Highest-risk shared file: `tests/e2e/dashboard.spec.ts`** — multiple dash
features will append e2e blocks. Use isolated `test.describe('match video', …)`
to minimize merge friction.

---

## 9. Step-by-step execution checklist

1. **Read** `src/dash/MatchVideo.tsx` and `src/dash/proxies.ts` (confirm
   `tbaGetOptional` + `isUnavailable` signatures — already present).
2. **Edit `MatchVideo.tsx` imports:** replace `import { tbaGet }` with
   `import { tbaGetOptional, isUnavailable } from '@/dash/proxies';` and add
   `ExternalLink` to the existing `lucide-react` import.
3. **Change the query fn** to
   `queryFn: () => tbaGetOptional<TbaMatch>(\`/match/${matchKey}\`)` and update
   the resolved type to `TbaMatch | ProxyUnavailable` (import `ProxyUnavailable`).
4. **Add the `isUnavailable(query.data)` branch** before the `firstYoutubeKey`
   branch, rendering the new `match-video-unavailable` info note. It MUST be an
   early return so `query.data` narrows to `TbaMatch` for the `firstYoutubeKey`
   call below (keep `firstYoutubeKey`'s `TbaMatch | undefined` signature as-is).
5. **Add the `match-video-yt-link` anchor** below `<PlayerFrame>` (wrap them in a
   fragment / small flex column), href `https://youtu.be/${encodeURIComponent(ytKey)}`.
   Pass `ytKey` into the success branch (it is already computed as `key`).
6. **Add the "1–4h" hint** to the `match-video-none` branch.
7. **Update `MatchVideo.test.tsx`:** swap the mock to `tbaGetOptional` +
   `isUnavailable`, adapt the existing 7 tests, add tests 8–10.
8. **Run unit tests:** `npx vitest run src/dash/__tests__/MatchVideo.test.tsx`
   then the full `npm test` to catch any consumer breakage.
9. **`npm run typecheck`** — confirm the `TbaMatch | ProxyUnavailable` union is
   handled everywhere (`firstYoutubeKey` must guard `isUnavailable` first).
10. **Add the three e2e scenarios** to `tests/e2e/dashboard.spec.ts` under a
    `test.describe('match video', …)` block. Use the verified selectors from
    section 7: route `/dashboard` (not `/dash`); `setActiveEvent(admin, eventKey)`
    before each `goto`; `test.skip(!URL || !SECRET, …)` per test; exact tab name
    `{ name: 'Match', exact: true }`; `[data-testid^="match-item-"]` for matches;
    `team-select` dropdown via `selectOption({ index: 1 })` for teams; tolerate an
    absent `team-last-match`; do NOT assert `match-sync-now` disabled state.
11. **Run e2e:** `npx playwright test tests/e2e/dashboard.spec.ts` (single worker,
    live event). Expect Scenario B to skip if the live match has no video.
12. **No `supabase db push` / `functions deploy` needed** — no migration, no edge
    function change. Do **not** create migration 0033 for this feature.
13. **Manual smoke (optional):** `npm run dev`, open `/dashboard`, pick a played match,
    confirm the embed loads, "Sync to match start" enables once the video plays,
    and the "Watch on YouTube" link opens `youtu.be`.
