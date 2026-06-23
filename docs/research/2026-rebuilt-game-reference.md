# REBUILT presented by Haas (2026 FRC) — Game Reference for Scouting

## 1. Game Summary

REBUILT is a 2026 FRC game played by two ALLIANCES (each up to 4 teams, 3 robots on field per match) on an approximately 317.7 in × 651.2 in carpeted FIELD. The single objective is to score **FUEL** (5.91 in foam balls) into your ALLIANCE's **HUB** and to **climb the TOWER** for points. Each MATCH lasts **2:40 total**: a 20-second **AUTO** period (no driver control; both HUBs active) followed by a **2:20 TELEOP** period. TELEOP is subdivided into a 10 s **TRANSITION SHIFT** (both HUBs active), four 25 s **ALLIANCE SHIFTS** during which only one alliance's HUB is active at a time (the active HUB alternates every shift), and a 30 s **END GAME** in which both HUBs return to active and robots typically climb the TOWER. The defining strategic mechanic is the **active/inactive HUB**: FUEL scored in an active HUB is worth 1 point each, while FUEL scored in an inactive HUB is worth 0. Critically, the alliance that scores **more FUEL in AUTO** has its HUB set **INACTIVE first** (during SHIFT 1), penalizing the AUTO leader and forcing scouts to track scoring relative to which shift/HUB-status window it occurred in. The alliance with the most MATCH points wins.

## 2. Scoring Elements

| Element | Description | Count & Staging |
|---|---|---|
| **FUEL** | The **only** SCORING ELEMENT. A 5.91 in (15.0 cm) diameter high-density foam ball weighing 0.448–0.500 lb (~0.203–0.227 kg). Custom AndyMark part **am-5801**. A FUEL is "scored" once it passes through the top opening of the HUB and through the sensor array. Worn/damaged FUEL still counts as long as it approximately looks like one; small chunks do not. A ROBOT may CONTROL any number of FUEL after the start of the MATCH. FUEL processed through a HUB is randomly redistributed into the NEUTRAL ZONE via four base exits. | **504 staged per MATCH** at Regional/District events (may rise to **600** at District Championship / FIRST Championship). Staging: **24 per DEPOT** (×2 = 48), **24 per OUTPOST CHUTE** (×2 = 48), **up to 8 preloaded per ROBOT** (up to 48 across 6 robots), and the remainder (**~360–408**, ±24 tolerance) corralled in the **NEUTRAL ZONE** (bounding box ~206.0 in wide × 72.0 in deep, split roughly equally across the CENTER LINE; not a perfect grid). |

## 3. Field Zones

Field overview: ~317.7 in × 651.2 in low-pile carpet (Shaw Neyland II 20), bounded by ALLIANCE WALLS, OUTPOSTS, TOWER WALLS, and guardrails. Populated with **1 OUTPOST, 1 HUB, 1 TOWER per ALLIANCE**, plus **2 DEPOTS, 4 BUMPS, 4 TRENCHES**.

| Zone / Structure | Alliance-specific | Description & What Robots Do There |
|---|---|---|
| **HUB** | Yes (1 per alliance) | 47 in × 47 in rectangular-prism scoring goal with a 41.7 in hexagonal top opening, front edge 72 in off carpet. Centered between two BUMPS, 158.6 in from the ALLIANCE WALL. A back net blocks FUEL launched from prohibited areas. **Robots score FUEL here.** Either ACTIVE (FUEL = 1 pt) or INACTIVE (FUEL = 0 pt). Four base exits randomly redistribute processed FUEL into the NEUTRAL ZONE. Top angles lit by DMX light bars indicating active state. |
| **TOWER** | Yes (1 per alliance) | 49.25 in wide × 45.0 in deep × 78.25 in tall structure integrated into the ALLIANCE WALL between DRIVER STATION 2 and 3. Made of TOWER WALL, TOWER BASE (39.0 in × 45.18 in floor plate), two UPRIGHTS (72.1 in tall, 32.25 in apart), and three RUNGS. **Robots climb it** to LEVEL 1/2/3 for TOWER points. RUNG centers: **LOW 27 in, MID 45 in, HIGH 63 in** from floor (18 in apart). UPRIGHTS/RUNGS powder-coated red or blue. |
| **DEPOT** | Yes (2 total) | 42.0 in wide × 27.0 in deep structure along the ALLIANCE WALL, made of 3.0 in wide steel barriers (~1.0–1.125 in tall). Staged with **24 FUEL**. **Robots collect FUEL here.** |
| **OUTPOST** | Yes (2 total) | Assembly at each end of the field connecting guardrail to ALLIANCE WALL. Upper opening 31.8 in × 7.0 in (bottom 28.1 in off floor) fed by the CHUTE; base opening 32.0 in × 7.0 in (bottom 1.88 in off ground) into the CORRAL. **HUMAN PLAYERS feed FUEL into the field here; robots deliver FUEL to human players by pushing it into the CORRAL.** SCORING ELEMENTS may exit the field through the base opening. |
| **CHUTE** | Yes (part of OUTPOST) | 15.0° sloped tunnel to the upper OUTPOST opening. Holds **~25 FUEL**, retained by the **CHUTE DOOR** (HDPE pivot arm rotated ~90° by the HUMAN PLAYER). Staged with **24 FUEL**. |
| **CORRAL** | Yes (part of OUTPOST) | 35.8 in wide × 37.6 in deep floor storage area at the OUTPOST base, walled by 8.13 in tall polycarbonate panels. **Robots push FUEL in** (through the 32.0 in × 7.0 in base opening) to deliver it to the HUMAN PLAYER. |
| **BUMP** | No (4 total) | 73.0 in wide × 44.4 in deep × 6.513 in tall ramp structures on either side of each HUB. 0.5 in thick ALLIANCE-colored textured HDPE surfaces at 15° (one ramp sloping toward the NEUTRAL ZONE, one toward the ALLIANCE ZONE). **Robots drive over them.** |
| **TRENCH** | No (4 total) | 65.65 in wide × 47.0 in deep × 40.25 in tall structure extending from guardrail to BUMP on both sides. Clearance under each arm: **50.34 in wide × 22.25 in tall.** **Robots drive underneath.** Hosts AprilTags facing the ALLIANCE ZONE and NEUTRAL ZONE. TRENCHES near the scoring table hold extra electronics; far ones have a pivot arm (locked horizontal during the match). |
| **NEUTRAL ZONE** | No | 283 in deep × 317.7 in long central region, bounded by BUMPS, TRENCHES, HUBS, and guardrails; surrounds and includes the CENTER LINE. **Bulk of FUEL (~360–408) staged here at match start; robots intake FUEL from the floor here.** HUB exits redistribute processed FUEL here. |
| **CENTER LINE** | No | White line spanning the field width, bisecting the NEUTRAL ZONE. FUEL is dispersed roughly equally on both sides. |
| **ALLIANCE ZONE** | Yes | 158.6 in deep × 317.7 in long volume formed by an ALLIANCE WALL, TOWER WALL, and guardrails. Surrounds an ALLIANCE TOWER and a DEPOT; bounded by and includes the ROBOT STARTING LINE. |
| **ROBOT STARTING LINE** | Yes | ALLIANCE-colored line spanning the field at the edge of an ALLIANCE ZONE, in front of two BUMPS and the ALLIANCE HUB. **Robots start the match relative to this line; may leave it during AUTO** to retrieve FUEL (mobility/leave). |
| **ALLIANCE AREA** | Yes | ~360 in wide × 134 in deep volume (incl. ALLIANCE WALL, OUTPOST, TOWER WALL, carpet edge, ALLIANCE-colored tape) where the DRIVE TEAM operates, behind the ALLIANCE WALL. |
| **OUTPOST AREA** | Yes | 71.0 in wide × 134 in deep volume bounded by the OUTPOST, carpet edge, and tape. Where the HUMAN PLAYER is staged and feeds FUEL via the OUTPOST. |
| **HUMAN STARTING LINE** | Yes | White line spanning the ALLIANCE AREA up to the OUTPOST AREA, 24.0 in from the bottom tube of the ALLIANCE WALL. Where drivers/coaches/non-OUTPOST human players stage at match start. |
| **ALLIANCE WALL** | Yes | Separates robots from the DRIVE TEAM. Consists of 3 DRIVER STATIONS, an OUTPOST, and a TOWER WALL. |
| **TOWER WALL** | Yes | Part of the TOWER integrated into each ALLIANCE WALL. |
| **DRIVER STATION** | Yes (3 per alliance) | Assembly within the ALLIANCE WALL behind which a DRIVE TEAM operates a robot. DS2 contains the official match timer. Each has an E-Stop (left), A-Stop (right, disables robot during AUTO), team sign, and team LED stack. |

## 4. Match Phases & Timing

**Total MATCH = 2:40 (160 s) = 20 s AUTO + 2:20 (140 s) TELEOP.** 3-second scoring-assessment carryover windows occur between AUTO/TELEOP and after a HUB deactivates (FUEL processing time); these are assessment delays, not extra match time.

**HUB active/inactive rule:** Both HUBs are ACTIVE during AUTO, TRANSITION SHIFT, and END GAME. During the four ALLIANCE SHIFTS, exactly one alliance's HUB is active and the other inactive, alternating each shift. The alliance that scored **MORE FUEL in AUTO** has its HUB **INACTIVE in SHIFT 1** (opponent active). If AUTO is tied, the FMS randomly selects. FMS Game Data relays the AUTO winner/selected alliance to all OPERATOR CONSOLES at the start of TELEOP; HUB lights (ALLIANCE color with white chase) during the TRANSITION SHIFT indicate which HUB goes inactive first.

### Timeline

| Timer | Phase | Duration | HUB Status | Notes / Audio |
|---|---|---|---|---|
| 0:20 → 0:00 | **AUTO** | 20 s | Both ACTIVE | No driver control. Score FUEL, leave ROBOT STARTING LINE, climb TOWER (LEVEL 1 only, max 2 robots/alliance). AUTO FUEL total sets shift ordering. Audio: "Cavalry Charge" at start, "Buzzer" at end. |
| 2:20 → 2:10 | **TRANSITION SHIFT** | 10 s | Both ACTIVE | First TELEOP segment. FMS relays AUTO result; lights show which HUB goes inactive in SHIFT 1. Audio: "3 Bells" at 2:20. |
| 2:10 → 1:45 | **ALLIANCE SHIFT 1** | 25 s | One active | Higher-AUTO-scoring alliance's HUB INACTIVE; opponent ACTIVE. Audio: "POWER UP – Linear Popping" at 2:10. |
| 1:45 → 1:20 | **ALLIANCE SHIFT 2** | 25 s | One active | Statuses ALTERNATE vs SHIFT 1. Audio at 1:45. |
| 1:20 → 0:55 | **ALLIANCE SHIFT 3** | 25 s | One active | Alternate again (same as SHIFT 1 pattern). Audio at 1:20. |
| 0:55 → 0:30 | **ALLIANCE SHIFT 4** | 25 s | One active | Alternate again (same as SHIFT 2 pattern). Audio at 0:55. |
| 0:30 → 0:00 | **END GAME** | 30 s | Both ACTIVE | Both HUBs return active; primary TOWER-climb window (LEVELS 1/2/3). Audio: "Steam Whistle" at 0:30, "Buzzer" at match end. "Foghorn" if match stopped. |

**HUB lighting (verify exact alignment against Table 5-3):** ALLIANCE color 100% pre-match; solid = active; pulsing = deactivation warning (starts 3 s before deactivation/match end); white chase during TRANSITION SHIFT = will be inactive in SHIFT 1; off = not active.

## 5. Scoring Table

| Action | Phase | Location | Points |
|---|---|---|---|
| Score FUEL in an ACTIVE HUB | AUTO | Own HUB | **1** each |
| Score FUEL in an ACTIVE HUB | TELEOP | Own HUB | **1** each |
| Score FUEL in an INACTIVE HUB | TELEOP (ALLIANCE SHIFTS) | Own HUB | **0** |
| TOWER climb — LEVEL 1 (robot off carpet/TOWER BASE) | AUTO | Own TOWER | **15** per robot (max 2 robots/alliance) |
| TOWER climb — LEVEL 1 (robot off carpet/TOWER BASE) | TELEOP | Own TOWER | **10** per robot |
| TOWER climb — LEVEL 2 (BUMPER fully above LOW RUNG) | TELEOP | Own TOWER | **20** per robot (not scorable in AUTO) |
| TOWER climb — LEVEL 3 (BUMPER fully above MID RUNG) | TELEOP | Own TOWER | **30** per robot (not scorable in AUTO) |
| Win the MATCH | Overall (Qual) | — | **3 RP** |
| Tie the MATCH | Overall (Qual) | — | **1 RP** |
| Opponent commits MINOR FOUL | Any | — | **+5** to your MATCH points |
| Opponent commits MAJOR FOUL | Any | — | **+15** to your MATCH points |

**TOWER climb rules:** A robot may only earn TOWER points for a **single LEVEL in TELEOP** (highest achieved). A robot that climbed LEVEL 1 in AUTO can still earn additional TOWER points in TELEOP. To score a LEVEL, the robot must contact ≥1 RUNG/UPRIGHT and may only additionally touch the TOWER WALL, support structure, FUEL, and/or another robot. AUTO FUEL/TOWER assessed up to 3 s after AUTO 0:00; TELEOP TOWER assessed 3 s after TELEOP 0:00 or when all robots come to rest, whichever is first.

## 6. Ranking Points

All three BONUS RPs are based on cumulative match totals (assumed cumulative; verify).

| RP | Worth | Condition | Thresholds (Regional/District · District Champ · FIRST Champ) |
|---|---|---|---|
| **ENERGIZED RP** | 1 RP | FUEL scored in an active HUB ≥ threshold | **100 · 240 · 360** |
| **SUPERCHARGED RP** | 1 RP | FUEL scored in an active HUB ≥ higher threshold | **360 · 360 · 500** |
| **TRAVERSAL RP** | 1 RP | Total TOWER points scored in the MATCH ≥ threshold | **50** (all event levels) |
| **Win** | 3 RP | More MATCH points than opponent | — |
| **Tie** | 1 RP | Equal MATCH points | — |

Note: **DISQUALIFIED** = 0 MATCH points and 0 RP (Qual). YELLOW CARD = warning (2nd yellow → RED); RED CARD = disqualified for the match. An alliance can be ruled ineligible for a specific RP via certain violations.

## 7. Observable Robot Capabilities (Scout-Trackable)

- **Scores FUEL into the HUB** — primary cycle action; rate and volume matter most.
- **Intakes FUEL from the NEUTRAL ZONE floor** (center of field).
- **Collects FUEL from the DEPOT** (along own ALLIANCE WALL).
- **Receives FUEL from the HUMAN PLAYER** via the OUTPOST/CHUTE.
- **Delivers FUEL to the HUMAN PLAYER** by pushing it into the CORRAL.
- **Preloads FUEL** (up to 8) before the match.
- **CONTROLs/holds many FUEL at once** (capacity).
- **Leaves the ROBOT STARTING LINE during AUTO** (mobility/leave).
- **Crosses BUMPS** (drives over the 6.5 in ramps).
- **Passes under TRENCHES** (fits the 22.25 in tall × 50.34 in wide clearance).
- **Climbs the TOWER** to LEVEL 1 (off carpet), LEVEL 2 (bumpers above LOW RUNG), or LEVEL 3 (bumpers above MID RUNG).
- **Climbs the TOWER in AUTO** (LEVEL 1 only; max 2 robots/alliance).
- **Plays defense / PINs opponents** (notably while own HUB is inactive).
- **Exploits HUB active/inactive timing** — scores predominantly during own active windows.

## 8. Proposed Scouting Metrics by Phase

The active/inactive HUB mechanic means **FUEL counts must be attributed to a HUB-status window**, not just a phase. Where possible, count FUEL per shift; minimally, separate AUTO from TELEOP and flag whether scoring occurred while the HUB was active.

### AUTO (0:20–0:00, both HUBs active)
Quantitative:
- `auto_fuel_scored` (int) — FUEL into HUB during AUTO. *Ties to: FUEL in active HUB (1 pt); also drives SHIFT 1 ordering.*
- `auto_left_starting_line` (bool) — robot crossed/left ROBOT STARTING LINE. *Mobility/leave.*
- `auto_tower_level1` (bool) — robot achieved LEVEL 1 climb in AUTO (15 pts). *TOWER climb AUTO.*
- `auto_preload_count` (int 0–8, optional) — FUEL preloaded/scored from preload. *Preload capability.*

Qualitative:
- Where did it intake from in AUTO (preload only / NEUTRAL ZONE / DEPOT)?
- Did the AUTO routine look consistent/reliable across matches?
- Did it contribute to the AUTO FUEL lead (which then makes the HUB inactive in SHIFT 1 — strategic implication)?

### TELEOP (2:20–0:30, includes TRANSITION + 4 ALLIANCE SHIFTS)
Quantitative:
- `teleop_fuel_scored_active` (int) — FUEL into HUB while ACTIVE. *FUEL in active HUB (1 pt); ENERGIZED/SUPERCHARGED RP driver.*
- `teleop_fuel_scored_inactive` (int, optional) — FUEL put into HUB while INACTIVE (0 pts; indicates poor shift awareness/wasted cycles).
- `fuel_per_shift[1..4]` (int array, ideal) or `fuel_scoring_rate` (FUEL/sec during active windows) — *cycle speed.*
- `max_fuel_capacity_observed` (int) — most FUEL held/CONTROLled at once. *Capacity.*
- `intake_source` (enum/multi: NEUTRAL ZONE / DEPOT / OUTPOST-CORRAL feed) — *intake capability.*
- `crossed_bump` (bool), `passed_under_trench` (bool) — *field traversal / reach across zones.*
- `fed_corral` (bool/int) — delivered FUEL to own HUMAN PLAYER. *CORRAL delivery.*
- `defense_played` (bool/rating) + `pins_committed` (int) — *defense, esp. during own inactive shifts.*
- `fouls_committed` (int, MINOR/MAJOR) — *penalty risk.*

Qualitative:
- Does the robot exploit active windows well (idle/collect when inactive, fire when active)?
- Scoring accuracy/miss rate at the HUB; does it jam or miss the hexagonal opening?
- Effective defender vs. liability (drawing fouls, getting pinned)?

### ENDGAME (0:30–0:00, both HUBs active)
Quantitative:
- `endgame_tower_level` (enum 0/1/2/3) — highest LEVEL achieved (10/20/30 pts). *TOWER climb TELEOP — only one level counts per robot.*
- `endgame_climb_success` (bool) — completed an attempted climb. *Reliability.*
- `endgame_climb_time` (sec, optional) — how long the climb took / when started. *Cycle/risk.*
- `endgame_fuel_scored` (int, optional) — FUEL scored during END GAME (both active). *FUEL in active HUB.*

Qualitative:
- Did it attempt but fail a climb (and at what level)? Did failure cost scoring time?
- Does it coordinate with alliance partners on TOWER (shared 1 TOWER per alliance — congestion risk)?
- Contribution toward the 50-point TRAVERSAL RP threshold.

## 9. Open Questions / Uncertainties

- **Table 6-4 point values were column-garbled** in extraction across multiple readers; the reconstruction (FUEL = 1 pt AUTO & TELEOP; LEVEL 1 = 15 AUTO / 10 TELEOP; LEVEL 2 = 20 TELEOP-only; LEVEL 3 = 30 TELEOP-only) is consistent across three sections but **must be verified against the PDF table grid** — especially that LEVEL 2 and LEVEL 3 have no AUTO value ("-").
- **Confirm there is no different AUTO vs TELEOP FUEL value** (text consistently says 1 pt each, but the garbled table warrants a check).
- **RP threshold ordering/values** (ENERGIZED 100/240/360 vs SUPERCHARGED 360/360/500) — verify against Table 6-5; the two RPs differ only by threshold magnitude (confirm no qualitative difference). Confirm thresholds are measured as **cumulative match total of active-HUB FUEL** (assumed) vs. some other basis.
- **BONUS RP RUNG basis:** earlier overview/glossary mention LOW/MID/HIGH RUNG (27/45/63 in) implying tiered scoring by RUNG, while the detailed scoring section scores by **LEVEL 1/2/3** (defined relative to carpet/LOW RUNG/MID RUNG). Note HIGH RUNG (63 in) is referenced but no LEVEL explicitly maps to clearing it — confirm whether LEVEL 3 corresponds to HIGH RUNG and what the HIGH RUNG is for.
- **HUB lighting Table 5-3 partially garbled** — verify exact light-state semantics (deactivation-warning pulse timing, white-chase transition indicator, post-match white assessment state, FIELD-safe purple/green states).
- **AprilTag ID-to-location mapping** is reconstructed from text (HUB: 2,3,4,5,8,9,10,11,18,19,20,21,24,25,26,27; TOWER WALL: 15,16,31,32; OUTPOST: 13,14,29,30; TRENCH: 1,6,7,12,17,22,23,28; heights: HUB 44.25 in, TOWER WALL/OUTPOST 21.75 in, TRENCH 35 in). 32 tags, IDs 1–32, 36h11 family. Verify against Figures 5-21–5-26 if vision/auto-detection of position is desired.
- **Exact FUEL preload vs. NEUTRAL ZONE counts vary** (360–408, ±24, up to 600 at championships) — not score-relevant but affects expected field density.
- **Manual pages 38 and 54 extracted empty** — possible missing content (end of FIELD STAFF section, a figure, or a table) not captured.
- **Foul stacking:** MAJOR FOUL noted as possibly repeating (e.g., every 3 s a situation is uncorrected) — confirm exact rule for how fouls accumulate, for any penalty-tracking metrics.

**Design questions the metrics raise:**
- The data model should record FUEL scoring **per ALLIANCE SHIFT (1–4)** to fully capture active/inactive value, but in-stands scouts may only reliably distinguish AUTO vs TELEOP and active vs inactive. Decide the granularity: per-shift counts (ideal, hard) vs. active/inactive split (practical).
- Since the **AUTO FUEL leader is penalized** (HUB inactive in SHIFT 1), the model should capture AUTO FUEL count not just as points but as a **strategic signal**; consider deriving expected active-window scoring from it.
- TOWER is **one structure per alliance** scored per-robot; consider tracking alliance-level TOWER congestion/coordination, not only individual climbs, since the 50-point TRAVERSAL RP is an alliance total.
- Decide whether to track **inactive-HUB FUEL** (0 pts) as a negative-efficiency metric — it is invisible in the score but reveals driver shift-awareness.