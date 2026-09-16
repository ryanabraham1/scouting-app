// src/dash/strategy/discordPost.ts
// "Post to Discord" for the Strategy tab: renders every phase whiteboard that
// has content into ONE stacked PNG (field image + committed ink + robot
// squares + auto underlays — the same geometry FieldWhiteboard draws, replayed
// on an offscreen canvas) and pairs it with an analytics embed built from the
// dashboard's own prediction/aggregate objects. The message goes through the
// `discord-post` Edge Function, which holds the webhook URL secret.
//
// Pure pieces (`boardHasContent`, `buildStrategyMessage`) are separate from the
// canvas + fetch IO so they unit-test without a DOM.

import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { strokeToPathD } from '@/dash/strategy/strokePath';
import {
  FIELD_W,
  FIELD_H,
  WHITEBOARD_PHASES,
  type CanvasDoc,
  type WhiteboardPhase,
} from '@/dash/strategy/strokes';
import { ROBOT_PX, type RobotSeed } from '@/dash/strategy/FieldWhiteboard';
import { loadStrategyCanvas } from '@/dash/strategy/strategyCanvasClient';
import { teamRedFlags, type RedFlag } from '@/dash/strategy/redFlags';
import { teamNoteKeyFor, keyFor, normalizeMatchup } from '@/dash/matchupNotesClient';
import type { RoutineOverlay } from '@/components/FieldDiagram';
import type { MatchPrediction, TeamPrediction } from '@/dash/predict';
import type { TeamAgg } from '@/dash/aggregate';
import type { MsrRow } from '@/dash/types';

export const PHASE_LABEL: Record<WhiteboardPhase, string> = {
  auto: 'Auto',
  transition: 'Transition',
  active: 'Active',
  inactive: 'Inactive',
  endgame: 'Endgame',
};

/** A board is worth posting when it carries ink or a placed robot. */
export function boardHasContent(doc: CanvasDoc | null | undefined, _phase: WhiteboardPhase): boolean {
  if (!doc) return false;
  if (doc.strokes.length > 0) return true;
  return (doc.robots?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render scale: a third of the field image (1300px wide) — the photographic
 *  field compresses poorly as PNG, so a 5-board stack lands ~2.5 MB (measured
 *  5.6 MB at half scale) while ink stays crisp on a phone. */
const RENDER_W = Math.round(FIELD_W / 3);
const RENDER_H = Math.round(FIELD_H / 3);
const LABEL_H = 64;
const GAP = 12;
const FIELD_IMAGE_SRC = '/assets/field/field.png';

function loadFieldImage(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = FIELD_IMAGE_SRC;
  });
}

export interface BoardToRender {
  phase: WhiteboardPhase;
  doc: CanvasDoc;
}

/** Draw one board (field + underlays + ink + robots) at the canvas' current
 *  transform, in field-image pixel space. Mirrors FieldWhiteboard's SVG. */
function drawBoard(
  ctx: CanvasRenderingContext2D,
  field: HTMLImageElement | null,
  board: BoardToRender,
  robotSeeds: RobotSeed[],
  underlays: RoutineOverlay[],
): void {
  if (field) ctx.drawImage(field, 0, 0, FIELD_W, FIELD_H);
  else {
    ctx.fillStyle = '#27272a';
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  }

  if (board.phase === 'auto') {
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const o of underlays) {
      if (o.path && o.path.length >= 2) {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = FIELD_H * 0.012;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([FIELD_H * 0.02, FIELD_H * 0.025]);
        ctx.beginPath();
        o.path.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * FIELD_W, p.y * FIELD_H);
          else ctx.lineTo(p.x * FIELD_W, p.y * FIELD_H);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const anchor = o.startPosition ?? (o.path && o.path.length > 0 ? o.path[0] : null);
      if (o.startPosition) {
        const s = FIELD_H * 0.062;
        ctx.fillStyle = o.color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = FIELD_H * 0.004;
        ctx.beginPath();
        ctx.roundRect(o.startPosition.x * FIELD_W - s / 2, o.startPosition.y * FIELD_H - s / 2, s, s, FIELD_H * 0.006);
        ctx.fill();
        ctx.stroke();
      }
      if (o.label && anchor) {
        ctx.font = `800 ${FIELD_H * 0.062 * 0.42}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = o.startPosition ? 'middle' : 'alphabetic';
        ctx.lineWidth = FIELD_H * 0.004;
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#0b0f1a';
        const y = o.startPosition ? anchor.y * FIELD_H : anchor.y * FIELD_H - FIELD_H * 0.02;
        ctx.strokeText(o.label, anchor.x * FIELD_W, y);
        ctx.fillText(o.label, anchor.x * FIELD_W, y);
      }
    }
    ctx.restore();
  }

  for (const stroke of board.doc.strokes) {
    const d = strokeToPathD(stroke);
    if (!d) continue;
    ctx.fillStyle = stroke.color;
    ctx.fill(new Path2D(d));
  }

  const placed = new Map((board.doc.robots ?? []).map((r) => [r.key, r]));
  for (const seed of robotSeeds) {
    const pos = placed.get(seed.key) ?? { x: seed.defaultX, y: seed.defaultY };
    const cx = pos.x * FIELD_W;
    const cy = pos.y * FIELD_H;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = seed.color;
    ctx.beginPath();
    ctx.roundRect(cx - ROBOT_PX / 2, cy - ROBOT_PX / 2, ROBOT_PX, ROBOT_PX, FIELD_H * 0.008);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = FIELD_H * 0.006;
    ctx.beginPath();
    ctx.roundRect(cx - ROBOT_PX / 2, cy - ROBOT_PX / 2, ROBOT_PX, ROBOT_PX, FIELD_H * 0.008);
    ctx.stroke();
    ctx.fillStyle = '#0b0f1a';
    ctx.font = `700 ${ROBOT_PX * 0.34}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(seed.team), cx, cy);
  }
}

/**
 * Stack the given boards into one PNG: a labeled strip per phase (label +
 * robot color key) above each field render. Resolves null when the browser
 * can't produce a canvas blob (never throws — the analytics still post).
 */
export async function renderBoardsPng(
  boards: BoardToRender[],
  robotSeeds: RobotSeed[],
  underlays: RoutineOverlay[],
): Promise<Blob | null> {
  if (boards.length === 0 || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = RENDER_W;
  canvas.height = boards.length * (LABEL_H + RENDER_H) + (boards.length - 1) * GAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const field = await loadFieldImage();

  ctx.fillStyle = '#0b0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = 0;
  for (const board of boards) {
    // Label strip.
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, y, RENDER_W, LABEL_H);
    ctx.fillStyle = '#fafafa';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(PHASE_LABEL[board.phase].toUpperCase(), 24, y + LABEL_H / 2);
    // Robot color key, right-aligned.
    let kx = RENDER_W - 24;
    ctx.font = '600 24px system-ui, sans-serif';
    for (const seed of [...robotSeeds].reverse()) {
      const label = String(seed.team);
      const w = ctx.measureText(label).width;
      kx -= w;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e4e4e7';
      ctx.fillText(label, kx, y + LABEL_H / 2);
      kx -= 30;
      ctx.fillStyle = seed.color;
      ctx.beginPath();
      ctx.roundRect(kx, y + LABEL_H / 2 - 11, 22, 22, 4);
      ctx.fill();
      kx -= 28;
    }
    y += LABEL_H;

    ctx.save();
    ctx.translate(0, y);
    ctx.scale(RENDER_W / FIELD_W, RENDER_H / FIELD_H);
    drawBoard(ctx, field, board, robotSeeds, underlays);
    ctx.restore();
    y += RENDER_H + GAP;
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface StrategyMessageInput {
  eventKey: string;
  /** Display label, e.g. "Qual 42" (or "Manual matchup"). */
  matchLabel: string;
  /** Scheduled time text, when known. */
  matchTime: string | null;
  redTeams: number[];
  blueTeams: number[];
  baseTeam: number;
  ourSide: 'red' | 'blue' | null;
  pred: MatchPrediction;
  agg: Map<number, TeamAgg>;
  reportsByTeam: Map<number, MsrRow[]>;
  /** Async season EPA-drop flags (useTeamEpaTrends), when loaded. */
  epaFlagsByTeam?: Map<number, RedFlag> | null;
  /** Matchup notes map (useMatchupNotes), when loaded. */
  notes?: Map<string, string> | null;
  /** Phases that made it into the attached image (empty → no image). */
  postedPhases: WhiteboardPhase[];
  /** Attachment filename, when an image is attached. */
  imageName?: string | null;
}

/** Discord embed colors: alliance red / blue, neutral zinc when we're not in it. */
const EMBED_COLOR = { red: 0xef4444, blue: 0x3b82f6, none: 0x71717a } as const;
const EMBED_FIELD_MAX = 1024;
const MAX_FLAGS_PER_TEAM = 3;

function num(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? String(Math.round(n)) : '—';
}

/** The strategy note for one team — current per-team key, else the legacy
 *  alliance-pair note surfaced on its former opponent-lead team (same fallback
 *  MatchupNoteCard applies). */
export function resolveTeamNote(
  notes: Map<string, string> | null | undefined,
  eventKey: string,
  team: number,
  ourTeams: number[],
  oppTeams: number[],
): string {
  if (!notes) return '';
  const current = notes.get(teamNoteKeyFor(eventKey, team));
  if (current != null) return current;
  const legacyPair = normalizeMatchup(ourTeams, oppTeams);
  if (team === legacyPair.oppTeam) {
    return notes.get(keyFor(eventKey, legacyPair.ourTeam, legacyPair.oppTeam)) ?? '';
  }
  return '';
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function teamLine(t: TeamPrediction, agg: TeamAgg | undefined, baseTeam: number): string {
  const name = t.teamNumber === baseTeam ? `**${t.teamNumber}** (us)` : `**${t.teamNumber}**`;
  const exp = t.source === 'none' ? '—' : `${num(t.expected)} (${t.source})`;
  const scouted = agg && agg.matchesScouted > 0
    ? `scouted ${num(agg.scoutingExpectedPoints)} · n=${agg.matchesScouted}`
    : 'not scouted';
  return `${name} · exp ${exp} · ${scouted}`;
}

/** Build the Discord webhook payload (content + one embed). Pure. */
export function buildStrategyMessage(input: StrategyMessageInput): Record<string, unknown> {
  const {
    eventKey, matchLabel, matchTime, redTeams, blueTeams, baseTeam, ourSide, pred, agg,
    reportsByTeam, epaFlagsByTeam, notes, postedPhases, imageName,
  } = input;
  const ourTeams = ourSide === 'blue' ? blueTeams : redTeams;
  const oppTeams = ourSide === 'blue' ? redTeams : blueTeams;

  const predictable = [...pred.red.teams, ...pred.blue.teams].some(
    (t) => t.source !== 'none' && Number.isFinite(t.expected),
  );
  const redPct = Math.round(pred.redWinProb * 100);
  const favored = pred.redWinProb >= 0.5 ? 'Red' : 'Blue';
  const favoredPct = pred.redWinProb >= 0.5 ? redPct : 100 - redPct;
  const prediction = predictable
    ? `Red **${num(pred.red.score)}** – **${num(pred.blue.score)}** Blue · ${favored} ${favoredPct}% to win`
    : 'Prediction unavailable — no scouting or season EPA for this matchup.';

  const allianceField = (side: 'red' | 'blue'): { name: string; value: string; inline: boolean } => {
    const teams = side === 'red' ? pred.red.teams : pred.blue.teams;
    const tag = ourSide === side ? ' · US' : '';
    return {
      name: `${side === 'red' ? 'Red' : 'Blue'} alliance${tag}`,
      value: clip(teams.map((t) => teamLine(t, agg.get(t.teamNumber), baseTeam)).join('\n') || '—', EMBED_FIELD_MAX),
      inline: false,
    };
  };

  const fields = [
    { name: 'Prediction', value: prediction, inline: false },
    allianceField('red'),
    allianceField('blue'),
  ];

  // Red flags for every OTHER team in the lineup (partners first), the same
  // derivation the analytics cards show, capped so the embed stays scannable.
  const flagLines: string[] = [];
  for (const team of [...ourTeams, ...oppTeams]) {
    if (team === baseTeam) continue;
    const flags = [
      ...teamRedFlags(reportsByTeam.get(team) ?? [], agg.get(team)),
      ...(epaFlagsByTeam?.get(team) ? [epaFlagsByTeam.get(team) as RedFlag] : []),
    ]
      .sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'))
      .slice(0, MAX_FLAGS_PER_TEAM);
    if (flags.length === 0) continue;
    const role = ourTeams.includes(team) ? 'partner' : 'opp';
    flagLines.push(`**${team}** (${role}): ${flags.map((f) => (f.severity === 'high' ? `HIGH: ${f.text}` : f.text)).join('; ')}`);
  }
  if (flagLines.length > 0) {
    fields.push({ name: 'Red flags', value: clip(flagLines.join('\n'), EMBED_FIELD_MAX), inline: false });
  }

  const noteLines: string[] = [];
  for (const team of [...ourTeams, ...oppTeams]) {
    if (team === baseTeam) continue;
    const note = resolveTeamNote(notes, eventKey, team, ourTeams, oppTeams).trim();
    if (note) noteLines.push(`**${team}**: ${note}`);
  }
  if (noteLines.length > 0) {
    fields.push({ name: 'Matchup notes', value: clip(noteLines.join('\n'), EMBED_FIELD_MAX), inline: false });
  }

  const lineup = `Red ${redTeams.join(', ') || '—'} vs Blue ${blueTeams.join(', ') || '—'}`;
  const boards = postedPhases.length > 0
    ? `Whiteboard: ${postedPhases.map((p) => PHASE_LABEL[p]).join(' · ')}`
    : 'Whiteboard: no drawings yet';

  const embed: Record<string, unknown> = {
    title: `${matchLabel}${matchTime ? ` · ${matchTime}` : ''} — ${lineup}`,
    description: boards,
    color: EMBED_COLOR[ourSide ?? 'none'],
    fields,
    footer: { text: `${eventKey} · posted from the Strategy tab` },
    timestamp: new Date().toISOString(),
  };
  if (imageName) embed.image = { url: `attachment://${imageName}` };

  return {
    content: `Strategy plan for **${matchLabel}**`,
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PostStrategyInput extends Omit<StrategyMessageInput, 'postedPhases' | 'imageName'> {
  /** Board key: the match_key, or MANUAL_MATCH_KEY for a schedule-less session. */
  boardMatchKey: string;
  robotSeeds: RobotSeed[];
  /** Auto-routine underlays for the auto board (what the on-screen board shows). */
  underlays: RoutineOverlay[];
}

export interface PostStrategyResult {
  postedPhases: WhiteboardPhase[];
  imageAttached: boolean;
}

/** Load every phase board, render the inked ones, build the embed, and relay it
 *  through the `discord-post` Edge Function. Throws with a user-readable message. */
export async function postStrategyToDiscord(input: PostStrategyInput): Promise<PostStrategyResult> {
  const docs = await Promise.all(
    WHITEBOARD_PHASES.map(async (phase) => ({
      phase,
      doc: await loadStrategyCanvas(input.eventKey, input.boardMatchKey, phase),
    })),
  );
  const boards = docs.filter((b) => boardHasContent(b.doc, b.phase));
  const png = await renderBoardsPng(boards, input.robotSeeds, input.underlays);
  const postedPhases = png ? boards.map((b) => b.phase) : [];
  const imageName = png ? `${input.boardMatchKey.replace(/[^a-z0-9_-]/gi, '')}-whiteboard.png` : null;

  const payload = buildStrategyMessage({ ...input, postedPhases, imageName });
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  if (png && imageName) form.append('files[0]', png, imageName);

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('No session yet — try again in a moment.');

  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/discord-post`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    body: form,
  });
  let body: { ok?: boolean; available?: boolean; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (res.status === 429) throw new Error('Discord rate-limited the post — try again in a moment.');
  if (!res.ok) throw new Error(body.error || `Post failed (${res.status})`);
  if (body.available === false) {
    throw new Error('Discord webhook is not configured on the server.');
  }
  if (!body.ok) throw new Error(body.error || 'Post failed');
  return { postedPhases, imageAttached: !!png };
}
