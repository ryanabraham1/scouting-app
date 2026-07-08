// supabase/functions/seed-demo/index.ts
// BACKEND of the revised "demo mode": builds a SEPARATE demo event (default
// `2026demo`) from a REAL source event (default `2026casnv`) using The Blue
// Alliance. It copies the REAL teams and the REAL qualification schedule, then
// generates realistic per-match scouting reports GROUNDED IN TBA match results.
//
// Real team numbers make team-scoped features work (TBA team info, world rank,
// nicknames, Statbotics / cross-event EPA) — which fake demo teams (9001..9029,
// the now-obsolete 0018 approach) broke.
//
// Mirrors import-event's idioms: env vars, the `tba<T>()` helper, `teamNum()`,
// `json()`, shared CORS, a service-role client, and the same upsert patterns.
//
// Contract:
//   POST { source_event_key?: string = "2026casnv", demo_event_key?: string = "2026demo" }
//   200  { demo_event_key, source_event_key, team_count, match_count, report_count }
//   err  non-2xx { error }
//
// The demo event is inserted with is_active=false; the client activates it.
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DEFAULT_SOURCE = "2026casnv";
const DEFAULT_DEMO = "2026demo";

// Frozen scoring magnitudes (mirror src/scoring/constants.ts SCORING.CLIMB).
const CLIMB_TELEOP_POINTS: Record<number, number> = { 1: 10, 2: 20, 3: 30 };
const SCHEMA_VERSION = 1;
const N_SCOUTS = 10;

// Teleop window bounds (ms from teleop start), mirror src/scoring/windows.ts.
// Used only to place plausible fuel_bursts on the per-report timeline.
const SHIFT_BOUNDS = {
  transition: { start: 0, end: 10000 },
  shift1: { start: 10000, end: 35000 },
  shift2: { start: 35000, end: 60000 },
  shift3: { start: 60000, end: 85000 },
  shift4: { start: 85000, end: 110000 },
  endgame: { start: 110000, end: 140000 },
} as const;

interface TbaEvent {
  name: string;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  city: string | null;
  state_prov: string | null;
}
interface TbaTeam {
  team_number: number;
  nickname: string | null;
  city: string | null;
  state_prov: string | null;
  rookie_year: number | null;
}
interface TbaMatch {
  key: string;
  comp_level: string;
  match_number: number;
  time: number | null;
  winning_alliance: string | null;
  alliances: {
    red: { team_keys: string[]; score: number | null };
    blue: { team_keys: string[]; score: number | null };
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Parse 'frcNNNN' → NNNN (int). Missing/short alliances tolerated as null.
function teamNum(teamKey: string | undefined): number | null {
  if (!teamKey) return null;
  const n = parseInt(teamKey.replace("frc", ""), 10);
  return Number.isFinite(n) ? n : null;
}

function randomJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function tba<T>(path: string): Promise<T> {
  const res = await fetch(`${TBA_BASE}${path}`, {
    headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`TBA ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// ── Deterministic PRNG, seeded by a numeric key, so a re-seed is reproducible ──
// mulberry32 — small, fast, good-enough spread for demo data.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable hash of an int → [0,1). Used for the no-results pseudo-skill fallback
// and as a PRNG seed source.
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) % 1_000_000) / 1_000_000;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function clampInt(x: number, lo: number, hi: number): number {
  const v = Math.round(x);
  return v < lo ? lo : v > hi ? hi : v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!TBA_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "function not configured" }, 500);
  }

  // Open posture (matches import-event): no admin gate.
  let body: { source_event_key?: string; demo_event_key?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const srcKey = (body.source_event_key ?? DEFAULT_SOURCE).trim();
  const demoKey = (body.demo_event_key ?? DEFAULT_DEMO).trim();
  if (!srcKey || !demoKey) {
    return json({ error: "missing source_event_key / demo_event_key" }, 400);
  }
  if (srcKey === demoKey) {
    return json({ error: "source and demo event keys must differ" }, 400);
  }

  return await runSeed(srcKey, demoKey);
});

async function runSeed(srcKey: string, demoKey: string): Promise<Response> {
  // (2) Fetch the SOURCE event from TBA.
  let ev: TbaEvent;
  let teams: TbaTeam[];
  let matches: TbaMatch[];
  try {
    [ev, teams, matches] = await Promise.all([
      tba<TbaEvent>(`/event/${srcKey}`),
      tba<TbaTeam[]>(`/event/${srcKey}/teams`),
      tba<TbaMatch[]>(`/event/${srcKey}/matches`),
    ]);
  } catch (e) {
    return json({ error: `TBA fetch failed: ${(e as Error).message}` }, 502);
  }

  const qm = matches
    .filter((m) => m.comp_level === "qm")
    .sort((a, b) => a.match_number - b.match_number);

  if (teams.length === 0 || qm.length === 0) {
    return json(
      { error: `source ${srcKey} has no teams/qm matches on TBA` },
      502,
    );
  }

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // (1) Idempotent reset — wipe any prior demo rows (FK-safe via the RPC).
  const { error: delErr } = await svc.rpc("delete_event", {
    p_event_key: demoKey,
  });
  if (delErr) return json({ error: `delete_event: ${delErr.message}` }, 500);

  // (3) Insert the DEMO event row. is_active=false — the CLIENT activates it.
  // Do NOT deactivate other events (unlike import-event).
  const { error: evErr } = await svc.from("event").insert({
    event_key: demoKey,
    name: `Demo — ${ev.name} (simulated)`,
    start_date: ev.start_date,
    end_date: ev.end_date,
    timezone: ev.timezone,
    city: ev.city,
    state_prov: ev.state_prov,
    is_active: false,
    staged_fuel_per_match: 504,
    imported_at: new Date().toISOString(),
  });
  if (evErr) return json({ error: `event insert: ${evErr.message}` }, 500);

  // Harmless join_code so the demo event behaves like an imported one.
  const { error: secErr } = await svc
    .from("event_secret")
    .upsert({ event_key: demoKey, join_code: randomJoinCode() });
  if (secErr) return json({ error: `event_secret: ${secErr.message}` }, 500);

  // (4) Teams: REAL, from TBA. Global `team` rows (upsert) + event_team join.
  const { error: teamErr } = await svc.from("team").upsert(
    teams.map((t) => ({
      team_number: t.team_number,
      nickname: t.nickname,
      city: t.city,
      state_prov: t.state_prov,
      rookie_year: t.rookie_year,
    })),
  );
  if (teamErr) return json({ error: `team upsert: ${teamErr.message}` }, 500);

  const { error: etErr } = await svc.from("event_team").upsert(
    teams.map((t) => ({ event_key: demoKey, team_number: t.team_number })),
  );
  if (etErr) return json({ error: `event_team: ${etErr.message}` }, 500);

  // (5) Per-team skill (first pass): average the actual alliance score over the
  // played qm matches each team appears in. "played" iff both alliance scores
  // are numbers ≥ 0. Fall back to a deterministic pseudo-skill if no results.
  const teamSkillRaw = new Map<number, { sum: number; count: number }>();
  let anyRealResult = false;
  for (const m of qm) {
    const rs = m.alliances.red.score;
    const bs = m.alliances.blue.score;
    const played =
      typeof rs === "number" && rs >= 0 && typeof bs === "number" && bs >= 0;
    if (!played) continue;
    anyRealResult = true;
    const redTeams = m.alliances.red.team_keys.map(teamNum);
    const blueTeams = m.alliances.blue.team_keys.map(teamNum);
    for (const t of redTeams) {
      if (t == null) continue;
      const e = teamSkillRaw.get(t) ?? { sum: 0, count: 0 };
      e.sum += rs!;
      e.count += 1;
      teamSkillRaw.set(t, e);
    }
    for (const t of blueTeams) {
      if (t == null) continue;
      const e = teamSkillRaw.get(t) ?? { sum: 0, count: 0 };
      e.sum += bs!;
      e.count += 1;
      teamSkillRaw.set(t, e);
    }
  }

  // Normalize per-team skill to ~[0,1]. Min-max over teams that have averages;
  // if the source has no real results, every team uses the deterministic hash.
  const skill = new Map<number, number>();
  if (anyRealResult) {
    const avgs: { team: number; avg: number }[] = [];
    for (const t of teams) {
      const e = teamSkillRaw.get(t.team_number);
      if (e && e.count > 0) avgs.push({ team: t.team_number, avg: e.sum / e.count });
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of avgs) {
      if (a.avg < lo) lo = a.avg;
      if (a.avg > hi) hi = a.avg;
    }
    const span = hi - lo;
    for (const t of teams) {
      const e = teamSkillRaw.get(t.team_number);
      if (e && e.count > 0) {
        const avg = e.sum / e.count;
        // Compress toward [0.05,0.95] so even the weakest team produces data.
        skill.set(
          t.team_number,
          span > 0 ? 0.05 + 0.9 * clamp01((avg - lo) / span) : 0.5,
        );
      } else {
        // Team has no played match (e.g. dropped) — deterministic fallback.
        skill.set(t.team_number, hash01(t.team_number));
      }
    }
  } else {
    for (const t of teams) skill.set(t.team_number, hash01(t.team_number));
  }
  const skillOf = (team: number | null): number =>
    team == null ? 0.4 : skill.get(team) ?? hash01(team);

  // (7) Scouts: ~10 demo scouts. Don't touch scouter_roster.
  const scoutRows = Array.from({ length: N_SCOUTS }, (_, i) => ({
    event_key: demoKey,
    display_name: `Demo Scout ${i + 1}`,
    auth_uid: crypto.randomUUID(),
  }));
  const { data: insertedScouts, error: scoutErr } = await svc
    .from("scout")
    .insert(scoutRows)
    .select("id, display_name");
  if (scoutErr) return json({ error: `scout insert: ${scoutErr.message}` }, 500);
  const scoutIds = (insertedScouts ?? [])
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map((s) => s.id as string);
  if (scoutIds.length === 0) {
    return json({ error: "no demo scouts created" }, 500);
  }

  // (6) Decide played-vs-upcoming. Always leave the last ~25% UNPLAYED so the
  // Next-Match prediction has upcoming matches — even when TBA has real results.
  const maxMatchNo = qm[qm.length - 1].match_number;
  const upcomingThreshold = Math.ceil(maxMatchNo * 0.75); // > this ⇒ forced upcoming
  // If the source has NO results at all, additionally synthesize results for
  // matches up to 70% and leave the rest upcoming.
  const synthesizedCutoff = Math.floor(maxMatchNo * 0.7);

  // Build the match rows + remember which are played (and their scores) so we
  // can generate grounded reports next.
  interface PlayedMatch {
    matchKey: string;
    matchNumber: number;
    red: (number | null)[];
    blue: (number | null)[];
    redScore: number;
    blueScore: number;
  }
  const matchRows: Record<string, unknown>[] = [];
  const playedMatches: PlayedMatch[] = [];

  for (const m of qm) {
    const matchKey = `${demoKey}_qm${m.match_number}`;
    const red = m.alliances.red.team_keys.map(teamNum);
    const blue = m.alliances.blue.team_keys.map(teamNum);
    const rs = m.alliances.red.score;
    const bs = m.alliances.blue.score;
    const hasRealResult =
      typeof rs === "number" && rs >= 0 && typeof bs === "number" && bs >= 0;

    // Forced upcoming for the last ~25% so next-match has something to predict.
    const forcedUpcoming = m.match_number > upcomingThreshold;

    let played = false;
    let redScore = 0;
    let blueScore = 0;

    if (forcedUpcoming) {
      played = false;
    } else if (anyRealResult) {
      // Use REAL results where present; otherwise it stays upcoming.
      if (hasRealResult) {
        played = true;
        redScore = rs!;
        blueScore = bs!;
      }
    } else {
      // No real results anywhere → synthesize for matches ≤ 70%.
      if (m.match_number <= synthesizedCutoff) {
        played = true;
        const rng = mulberry32((m.match_number * 2654435761) >>> 0);
        const redBase = red.reduce(
          (s, t) => s + 30 + skillOf(t) * 110,
          0,
        );
        const blueBase = blue.reduce(
          (s, t) => s + 30 + skillOf(t) * 110,
          0,
        );
        redScore = Math.max(0, Math.round(redBase + (rng() * 40 - 20)));
        blueScore = Math.max(0, Math.round(blueBase + (rng() * 40 - 20)));
      }
    }

    const base: Record<string, unknown> = {
      match_key: matchKey,
      event_key: demoKey,
      comp_level: "qm",
      match_number: m.match_number,
      scheduled_time: m.time ? new Date(m.time * 1000).toISOString() : null,
      red1: red[0] ?? null,
      red2: red[1] ?? null,
      red3: red[2] ?? null,
      blue1: blue[0] ?? null,
      blue2: blue[1] ?? null,
      blue3: blue[2] ?? null,
    };

    if (played) {
      base.actual_red_score = redScore;
      base.actual_blue_score = blueScore;
      base.winner =
        redScore > blueScore ? "red" : blueScore > redScore ? "blue" : "tie";
      base.result_synced_at = new Date().toISOString();
      playedMatches.push({
        matchKey,
        matchNumber: m.match_number,
        red,
        blue,
        redScore,
        blueScore,
      });
    }
    matchRows.push(base);
  }

  // Insert matches in chunks.
  for (let i = 0; i < matchRows.length; i += 200) {
    const { error } = await svc.from("match").insert(matchRows.slice(i, i + 200));
    if (error) return json({ error: `match insert: ${error.message}` }, 500);
  }

  // (8) match_scouting_report — the core ask. For EACH PLAYED match × its 6
  // teams, build ONE report whose magnitude is grounded in the real result.
  const reportRows: Record<string, unknown>[] = [];
  let scoutCursor = 0; // round-robin across demo scouts

  for (const pm of playedMatches) {
    const seats: {
      team: number | null;
      color: "red" | "blue";
      station: number;
      allianceScore: number;
      mates: (number | null)[];
    }[] = [
      { team: pm.red[0], color: "red", station: 1, allianceScore: pm.redScore, mates: pm.red },
      { team: pm.red[1], color: "red", station: 2, allianceScore: pm.redScore, mates: pm.red },
      { team: pm.red[2], color: "red", station: 3, allianceScore: pm.redScore, mates: pm.red },
      { team: pm.blue[0], color: "blue", station: 1, allianceScore: pm.blueScore, mates: pm.blue },
      { team: pm.blue[1], color: "blue", station: 2, allianceScore: pm.blueScore, mates: pm.blue },
      { team: pm.blue[2], color: "blue", station: 3, allianceScore: pm.blueScore, mates: pm.blue },
    ];

    for (const seat of seats) {
      if (seat.team == null) continue;
      const team = seat.team;
      const s = skillOf(team);

      // Per-row deterministic PRNG keyed by (match, team).
      const rng = mulberry32(((pm.matchNumber * 73856093) ^ (team * 19349663)) >>> 0);

      // Attribute the alliance score across its 3 teams weighted by skill
      // (+ small per-row noise) → attributedPoints.
      const mateSkills = seat.mates.map((t) => (t == null ? 0 : Math.max(0.02, skillOf(t))));
      const totalSkill = mateSkills.reduce((a, b) => a + b, 0) || 1;
      const myWeight = Math.max(0.02, s) / totalSkill;
      // +/- 12% per-row noise on the attribution share.
      const noisyWeight = myWeight * (0.88 + rng() * 0.24);
      let attributedPoints = Math.max(0, seat.allianceScore * noisyWeight);

      const noShow = rng() < 0.03;
      const died = rng() < 0.05;

      // ── Climb: propensity & success scale with skill; subtract climb pts. ──
      let climbAttempted = false;
      let climbSuccess = false;
      let climbLevel = 0;
      if (!noShow && !died) {
        const climbProp = 0.25 + s * 0.7; // 0.25..0.95
        climbAttempted = rng() < climbProp;
        if (climbAttempted) {
          const reliability = 0.78 + s * 0.2; // 0.78..0.98
          climbSuccess = rng() < reliability;
          if (climbSuccess) {
            // Higher skill ⇒ higher level. Bias toward 2/3 for strong teams.
            const lvlRoll = rng() * 0.5 + s * 0.7;
            climbLevel = lvlRoll > 0.85 ? 3 : lvlRoll > 0.5 ? 2 : 1;
          }
        }
      }
      const climbPts = climbSuccess ? CLIMB_TELEOP_POINTS[climbLevel] ?? 0 : 0;

      // The remainder of the attributed points is FUEL.
      let fuelTotal = Math.max(0, attributedPoints - climbPts);
      if (noShow) {
        attributedPoints = 0;
        fuelTotal = 0;
      }

      // Split fuel across phases: auto ~15% / teleop_active ~60% /
      // teleop_inactive ~15% / endgame ~10%, with per-row noise.
      let autoFuel = 0;
      let teleopActive = 0;
      let teleopInactive = 0;
      let endgameFuel = 0;
      if (fuelTotal > 0) {
        autoFuel = fuelTotal * 0.15 * (0.7 + rng() * 0.6);
        teleopActive = fuelTotal * 0.6 * (0.7 + rng() * 0.6);
        teleopInactive = fuelTotal * 0.15 * (0.7 + rng() * 0.6);
        endgameFuel = fuelTotal * 0.1 * (0.7 + rng() * 0.6);
        if (died) {
          // Robot died: cut teleop short, no endgame.
          teleopActive *= 0.4;
          teleopInactive *= 0.4;
          endgameFuel = 0;
        }
      }
      const vAuto = clampInt(autoFuel, 0, 500);
      const vTeleAct = clampInt(teleopActive, 0, 500);
      const vTeleInact = clampInt(teleopInactive, 0, 500);
      const vEndgame = clampInt(endgameFuel, 0, 500);

      // fuel_points = auto + teleop_active + endgame (spec: excludes inactive).
      const fuelPoints = vAuto + vTeleAct + vEndgame;
      const fuelConfidence = Math.round((0.5 + rng() * 0.5) * 100) / 100; // 0.5..1.0

      // fuel_by_shift: 4 teleop buckets summing ~ active+inactive.
      const shiftTotal = vTeleAct + vTeleInact;
      const sa = Math.round(shiftTotal * 0.3);
      const sb = Math.round(shiftTotal * 0.3);
      const sc = Math.round(shiftTotal * 0.25);
      const sd = Math.max(0, shiftTotal - sa - sb - sc);
      const fuelByShift = [sa, sb, sc, sd];

      const inactiveFirst = vTeleInact > 0 && rng() < 0.4;

      // Defense: lower-skill teams play more defense.
      const defenseRating = noShow ? 0 : clampInt(rng() * (1.5 + (1 - s) * 2.5), 0, 3);
      const pins = defenseRating > 0 ? clampInt(rng() * 3, 0, 5) : 0;

      // ── auto_start_position {x,y} (0..1) + auto_path [{x,y}...] ──
      let startPos: { x: number; y: number } | null = null;
      let path: { x: number; y: number }[] | null = null;
      if (!noShow) {
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        startPos = { x: r3(0.05 + rng() * 0.15), y: r3(0.15 + rng() * 0.7) };
        path = [
          startPos,
          { x: r3(0.3 + rng() * 0.15), y: r3(0.2 + rng() * 0.6) },
          { x: r3(0.55 + rng() * 0.15), y: r3(0.2 + rng() * 0.6) },
        ];
      }

      // ── A few fuel_bursts. window 'auto' → startMs absolute in auto time;
      // teleop windows → startMs relative to teleop start (timeline adds AUTO_MS). ──
      const r2 = (v: number) => Math.round(v * 100) / 100;
      let bursts: Record<string, unknown>[] = [];
      if (!noShow) {
        bursts = [
          { rate: r2(1.5 + rng()), startMs: 3000, endMs: 9000, window: "auto" },
          { rate: r2(2.0 + rng()), startMs: SHIFT_BOUNDS.shift1.start, endMs: SHIFT_BOUNDS.shift1.end, window: "shift1" },
          { rate: r2(2.0 + rng()), startMs: SHIFT_BOUNDS.shift2.start, endMs: SHIFT_BOUNDS.shift2.end, window: "shift2" },
        ];
        if (!died) {
          bursts.push({ rate: r2(1.5 + rng()), startMs: SHIFT_BOUNDS.shift3.start, endMs: SHIFT_BOUNDS.shift3.end, window: "shift3" });
        }
      }

      const intakeSources = defenseRating > 0 ? ["ground", "station"] : ["ground"];
      const maxFuelObserved = clampInt(fuelTotal * 0.25 * (0.5 + rng()), 0, 600);

      // ── Feeding bursts (feeding slider, migration 0010): teams flagged as
      // feeders get 1-2 bursts so the match timeline + feeding stats have data. ──
      const fedCorral = !noShow && rng() < 0.2;
      let feedingBursts: Record<string, unknown>[] = [];
      if (fedCorral) {
        feedingBursts = [
          { rate: r2(1.0 + rng()), startMs: SHIFT_BOUNDS.shift1.start + 5000, endMs: SHIFT_BOUNDS.shift1.start + 20000, window: "shift1" },
        ];
        if (rng() < 0.5) {
          feedingBursts.push({ rate: r2(1.0 + rng()), startMs: SHIFT_BOUNDS.shift3.start + 5000, endMs: SHIFT_BOUNDS.shift3.start + 20000, window: "shift3" });
        }
      }

      // ── Defense / defended intervals (0010): one teleop interval matching each
      // scalar duration, keeping the "Σ intervals == duration" invariant the
      // match timeline relies on. ──
      const defenseDurationMs = defenseRating > 0 ? clampInt(15000 + rng() * 30000, 0, 140000) : 0;
      const defendedDurationMs = clampInt(rng() * 20000, 0, 140000);
      const defenseIntervals = defenseDurationMs > 0
        ? [{ startMs: 20000, endMs: 20000 + defenseDurationMs, phase: "teleop" }]
        : [];
      const defendedIntervals = defendedDurationMs > 0
        ? [{ startMs: 60000, endMs: 60000 + defendedDurationMs, phase: "teleop" }]
        : [];

      // ── Foul reasons (0024): tag committed fouls with plausible rule keys
      // (must be keys from src/scoring/fouls.ts FOUL_REASONS). ──
      const foulsMinor = rng() < 0.3 ? 1 : 0;
      const foulsMajor = rng() < 0.1 ? 1 : 0;
      const FOUL_KEYS = ["opponent_contact", "pinning", "damage", "over_expansion", "fuel_violation", "tower_contact"];
      const foulReasons: string[] = [];
      if (foulsMinor > 0) foulReasons.push(FOUL_KEYS[clampInt(rng() * FOUL_KEYS.length, 0, FOUL_KEYS.length - 1)]);
      if (foulsMajor > 0) foulReasons.push("pinning");

      const scoutId = scoutIds[scoutCursor % scoutIds.length];
      scoutCursor += 1;

      const notes = noShow
        ? "No show."
        : died
          ? "Robot died mid-match."
          : s > 0.7
            ? "Strong cycler, consistent shots."
            : s < 0.35
              ? "Struggled to score, slow cycles."
              : "Solid contributor.";

      reportRows.push({
        schema_version: SCHEMA_VERSION,
        app_version: "demo",
        device_id: "demo-device",
        event_key: demoKey,
        match_key: pm.matchKey,
        scout_id: scoutId,
        target_team_number: team,
        alliance_color: seat.color,
        station: seat.station,
        inactive_first: inactiveFirst,
        inactive_first_source: inactiveFirst ? "derived" : null,
        fuel_bursts: bursts,
        auto_fuel: vAuto,
        teleop_fuel_active: vTeleAct,
        teleop_fuel_inactive: vTeleInact,
        endgame_fuel: vEndgame,
        fuel_by_shift: fuelByShift,
        fuel_points: fuelPoints,
        fuel_estimate_confidence: fuelConfidence,
        climb_level: climbLevel,
        climb_attempted: climbAttempted,
        climb_success: climbSuccess,
        auto_start_position: startPos,
        auto_path: path,
        auto_left_starting_line: !noShow && rng() < 0.9,
        auto_climb_level1: !noShow && rng() < 0.1,
        intake_sources: intakeSources,
        max_fuel_capacity_observed: maxFuelObserved,
        defense_rating: defenseRating,
        // Subjective super-scout ratings (0–3): scale with team strength `s`,
        // jittered; 0 when the robot never showed.
        driver_skill: noShow ? 0 : clampInt(1 + s * 2 + (rng() - 0.5), 0, 3),
        agility: noShow ? 0 : clampInt(1 + s * 2 + (rng() - 0.5), 0, 3),
        pins,
        fouls_minor: foulsMinor,
        fouls_major: foulsMajor,
        foul_reasons: foulReasons,
        no_show: noShow,
        died,
        tipped: !noShow && rng() < 0.05,
        dropped_fuel: !noShow && rng() < 0.1,
        fed_corral: fedCorral,
        feeding_bursts: feedingBursts,
        defense_duration_ms: defenseDurationMs,
        defended_duration_ms: defendedDurationMs,
        defense_intervals: defenseIntervals,
        defended_intervals: defendedIntervals,
        notes,
        deleted: false,
      });
    }
  }

  // Batch report inserts (chunks of 200) to stay under payload limits.
  for (let i = 0; i < reportRows.length; i += 200) {
    const { error } = await svc
      .from("match_scouting_report")
      .insert(reportRows.slice(i, i + 200));
    if (error) return json({ error: `report insert: ${error.message}` }, 500);
  }

  // (9) pit_scouting_report — one per team.
  const pitRows = teams.map((t, i) => {
    const s = skillOf(t.team_number);
    const rng = mulberry32((t.team_number * 2246822519) >>> 0);
    const drivetrain = (["swerve", "tank", "mecanum"] as const)[t.team_number % 3];
    const mechanisms =
      s > 0.6
        ? ["fuel shooter", "climber", "fast intake"]
        : ["fuel shooter", "floor intake"];
    const items =
      s > 0.6
        ? ["high goal", "level 3 climb", "auto routine", "defense"]
        : ["low goal", "level 1 climb"];
    // Expanded pit fields (migration 0023) so the full pit panel has content.
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const startPos = { x: r3(0.05 + rng() * 0.15), y: r3(0.15 + rng() * 0.7) };
    const strategies = s > 0.6 ? ["score", "cycle"] : rng() < 0.4 ? ["defend", "support"] : ["score", "feed"];
    return {
      event_key: demoKey,
      team_number: t.team_number,
      drivetrain,
      mechanisms,
      capabilities: { items, intakeSources: ["ground", "station"] },
      vision_system: s > 0.5 ? "AprilTags (Limelight)" : rng() < 0.5 ? "Photon Vision" : null,
      batteries: {
        count: clampInt(4 + rng() * 6, 4, 10),
        chargers: clampInt(2 + rng() * 3, 2, 5),
        brand: rng() < 0.5 ? "MK ES17-12" : "Duracell SLA",
        connector: rng() < 0.7 ? "Anderson SB50" : "Anderson SBS50",
      },
      preferred_auto_start_position: startPos,
      preferred_auto_path: [
        startPos,
        { x: r3(0.3 + rng() * 0.15), y: r3(0.2 + rng() * 0.6) },
        { x: r3(0.55 + rng() * 0.15), y: r3(0.2 + rng() * 0.6) },
      ],
      match_strategy: strategies,
      robot_dimensions: {
        lengthIn: clampInt(26 + rng() * 8, 26, 34),
        widthIn: clampInt(24 + rng() * 8, 24, 32),
        heightIn: clampInt(20 + rng() * 20, 20, 40),
        trenchCapable: rng() < 0.6,
      },
      photo_path: null,
      notes: `Demo pit notes for ${t.nickname ?? "team " + t.team_number}.`,
      author_scout_id: scoutIds[i % scoutIds.length],
      deleted: false,
    };
  });
  for (let i = 0; i < pitRows.length; i += 200) {
    const { error } = await svc
      .from("pit_scouting_report")
      .insert(pitRows.slice(i, i + 200));
    if (error) return json({ error: `pit insert: ${error.message}` }, 500);
  }

  // (10) Counts.
  return json(
    {
      demo_event_key: demoKey,
      source_event_key: srcKey,
      team_count: teams.length,
      match_count: matchRows.length,
      report_count: reportRows.length,
    },
    200,
  );
}
