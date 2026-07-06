# UI redesign — before / after

A pass over the scouting app's visual design. This documents every change made,
grouped by area, with side-by-side before/after screenshots captured against the
live demo event (`2026casnv`, base team 3256) at the same viewport per screen.

> **Note on typography.** The first attempt introduced a display face (Chakra
> Petch) for headings. That was reverted on feedback — **headings and body stay
> on the clean platform system sans, exactly like before.** The only new webfont
> kept is a self‑hosted **monospace (JetBrains Mono), used strictly for numeric
> telemetry** (scores, timers, EPA, %, team numbers) so columns of data align
> like an instrument readout. It's bundled for offline use. If you'd rather drop
> the mono too, it's a one-line change in `tailwind.config.js`.

Nothing here was committed.

---

## What changed

### Foundations (app-wide)

| ID | Change | Where |
|----|--------|-------|
| **F1** | Numeric telemetry now renders in a monospace data face (`font-mono` + tabular figures). Headings/body unchanged (system sans). | `tailwind.config.js`, `src/index.css`, `src/main.tsx` |
| **F2** | One radius + elevation scale: controls `rounded-lg`, cards `rounded-xl`, hero panels `rounded-2xl`; removed stray input/card shadows so elevation means something; stronger 2px focus rings. | `button.tsx`, `input.tsx`, `card.tsx` |
| **F4** | Two-tier heading scale: a reusable `.eyebrow` (small uppercase mono caption) sits above section titles; `StatTile` labels adopt it. | `src/index.css`, `StatTile.tsx` |

### Components / states

| ID | Change |
|----|--------|
| **E2** | `SyncIndicator` replaced the `↑` / `⚠` text glyphs with real lucide icons (wifi, up-arrow, alert-triangle) and added a spinner to the "Syncing…" state. |
| **E3** | Active `IconTabs` tab now wears the brand (cyan) accent with a lit top-edge indicator instead of a generic grey. |
| **E4** | `Input` gained a proper `invalid` state (destructive border + ring + `aria-invalid`); screens no longer hand-roll inline error borders. |
| **E1** | Real loading **skeletons** for Team & Ranking, and empty states now lead with an icon + one directive line instead of bare muted text. |
| **E5** | A global `prefers-reduced-motion` floor; subtle motion‑safe entrance on the My Data toast and transitions on bars. |

### Dashboard

| ID | Change |
|----|--------|
| **D2** | Draft team-pool rows de-crowded into a clean two-line card: identity + primary action up top, an aligned mono stat strip + badges below. |
| **D3** | The #1 "best remaining pick" is now an emphatic **PICK NEXT** card (brand fill, oversized team number) with quieter #2/#3 runners-up. |
| **D4** | Ranking's active sort column is now obvious — brand highlight + a solid caret — and numeric cells are mono-aligned. |
| **D5** | Match scouting-status summary restructured: a coverage pill + slim coverage bar, reporter chips on their own row, and a collapsible "not reported" list. |
| **D6** | Conflict banners escalate genuine **major** discrepancies to destructive (red); minor stays amber. *(Needs multi-scout conflicting reports to see; not present in demo data.)* |
| **D7** | Charts: brighter titles, mono axis labels, fixed 3-digit y-axis overflow, clearer StackedBar legend swatches. |

### Scout / capture

| ID | Change |
|----|--------|
| **C1** | The long pit form is now a **6-step wizard** modeled on the post-match Review flow (progress bar, one focused section at a time, Back/Next). Replaces the earlier accordion. |
| **C3** | The "being defended" / "defense" review inputs use a legible tinted fill + bright text instead of low-contrast colored text. |
| **C4** | My Data rows re-laid-out into an aligned mono stat strip (fuel · climb · defense · defended) under uppercase micro-labels; bolder match count. |
| **P** | **Pit team picker autocomplete** — the team-number box now suggests this event's roster (native `<datalist>`, offline-cached with a network fallback) and confirms the matched team's nickname below the field. |
| **H** | **Scout header rebuilt for mobile** — identity + icon-only nav (Home / My Data / Log out) on one row, and the offline + sync widgets contained in a single status strip below where each row's action buttons (Refresh / Sync now / Retry all) right-align instead of staircasing. Plus a full-width logout-confirm bar. |
| **DEF** | The two live-capture defense timers now have **distinct color identities** — Playing defense holds emerald→amber, Getting defended holds indigo→red — instead of both being green→orange. Same hold→slide→lock feel, subtle fill (no glow). |

> Fuel = orange / feed = cyan capture counters remain.

---

## Gallery

Each pair is **before (left) → after (right)**, same screen, same viewport.

### Home
| Before | After |
|:--:|:--:|
| ![home before](before/home.png) | ![home after](after/home.png) |

### Dashboard — Next Match  · `F1 mono numerics, E3 tabs`
The win‑probability %, projected + alliance scores now read as instrument telemetry; the active tab carries the brand accent.
| Before | After |
|:--:|:--:|
| ![next before](before/dash-next.png) | ![next after](after/dash-next.png) |

### Dashboard — Team  · `F1/F4 StatTiles, D7 charts, E1`
| Before | After |
|:--:|:--:|
| ![team before](before/dash-team.png) | ![team after](after/dash-team.png) |

### Dashboard — Ranking  · `D4 sort indicator, E1, F1`
The sorted column (Exp. Pts) is now unmistakably highlighted.
| Before | After |
|:--:|:--:|
| ![ranking before](before/dash-ranking.png) | ![ranking after](after/dash-ranking.png) |

### Dashboard — Draft  · `D2 rows, D3 best pick, E3`
| Before | After |
|:--:|:--:|
| ![draft before](before/dash-draft.png) | ![draft after](after/dash-draft.png) |

### Dashboard — Match  · `D5 status summary`
| Before | After |
|:--:|:--:|
| ![match before](before/dash-match.png) | ![match after](after/dash-match.png) |

### Dashboard — Picklist
| Before | After |
|:--:|:--:|
| ![picklist before](before/dash-picklist.png) | ![picklist after](after/dash-picklist.png) |

### Dashboard — Scouters
| Before | After |
|:--:|:--:|
| ![scouters before](before/dash-scouters.png) | ![scouters after](after/dash-scouters.png) |

### Dashboard — Setup
| Before | After |
|:--:|:--:|
| ![setup before](before/dash-setup.png) | ![setup after](after/dash-setup.png) |

### Scout — Home  · `E2 sync icons, F2`
The header sync widget swapped its `↑`/`⚠` glyphs for real icons.
| Before | After |
|:--:|:--:|
| ![scout home before](before/scout-home.png) | ![scout home after](after/scout-home.png) |

### Scout — Pit form  · `C1 stepped wizard`
The single biggest scout-side change: a wall of ~14 stacked sections becomes a stepped wizard (progress bar + Back/Next), matching the post-match Review flow. The team picker above it also gains roster autocomplete (**P**).
| Before | After |
|:--:|:--:|
| ![pit before](before/pit-form.png) | ![pit after](after/pit-form.png) |

### Scout — Live capture  · `C2 colors, F1 mono`
Counts and the match clock are now mono. (Defense/defended buttons turn amber/red once held — not visible at idle.)
| Before | After |
|:--:|:--:|
| ![capture before](before/capture-live.png) | ![capture after](after/capture-live.png) |

### Scout — Review
| Before | After |
|:--:|:--:|
| ![review before](before/review.png) | ![review after](after/review.png) |

### Scout — Review, Defense step  · `C3 input contrast, E4, F1`
"Defense played" (amber) and "Being defended" (red) now use a legible tinted fill + bright text.
| Before | After |
|:--:|:--:|
| ![review defense before](before/review-defense.png) | ![review defense after](after/review-defense.png) |

### Scout — My Data  · `C4 aligned stat strip`
| Before | After |
|:--:|:--:|
| ![my data before](before/my-data.png) | ![my data after](after/my-data.png) |

---

## Not shown in a static pair

- **D6 (conflict tone)** — only renders when two scouts submit conflicting reports for the same robot; the demo event has no such conflict. Verified in code (`ReportDetail` maps `severe → destructive`).
- **E5 (motion)** — the reduced-motion floor and toast/entrance transitions are behavioral.
- **E1 skeletons** — appear only during the brief loading window; the empty-state copy improvements are the visible part.
- **C2 active colors** — the amber/red defense states show only while a button is pressed or locked.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run src/` — **1176 passed** (one Ranking empty-state assertion was updated to match the new directive copy).

## Dependency added

- `@fontsource-variable/jetbrains-mono` (self-hosted, OFL-1.1, official Fontsource scope) — vetted safe before install. The initially-added `@fontsource-variable/inter` and `@fontsource/chakra-petch` were **uninstalled** after the display-face was reverted.
