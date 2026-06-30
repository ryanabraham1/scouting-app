import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { signedPitPhotoUrl } from '@/pit/photoUpload';
import { tbaGetOptional, isUnavailable } from '@/dash/proxies';

// Normalized pit report for dashboard consumption. The DB folds capability list
// and intake sources into one jsonb `capabilities` column of the shape
// { items: string[], intakeSources: string[] } (see pit/pitStore.ts).
export interface TeamPit {
  eventKey: string;
  teamNumber: number;
  drivetrain: string | null;
  mechanisms: string[];
  capabilities: string[];
  intakeSources: string[];
  visionSystem: string | null;
  batteryCount: number | null;
  chargerCount: number | null;
  batteryBrand: string | null;
  batteryConnector: string | null;
  preferredAutoStartPosition: { x: number; y: number } | null;
  preferredAutoPath: { x: number; y: number }[] | null;
  matchStrategy: string[];
  robotLengthIn: number | null;
  robotWidthIn: number | null;
  robotHeightIn: number | null;
  trenchCapable: boolean;
  photoPath: string | null;
  notes: string | null;
  authorScoutId: string | null;
}

// Pull the battery sub-object out of the `batteries` jsonb column, tolerating a
// missing/legacy null.
function normalizeBatteries(raw: unknown): {
  count: number | null;
  chargers: number | null;
  brand: string | null;
  connector: string | null;
} {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    count: num(obj.count),
    chargers: num(obj.chargers),
    brand: str(obj.brand),
    connector: str(obj.connector),
  };
}

// Pull robot dimensions out of the `robot_dimensions` jsonb column.
function normalizeDimensions(raw: unknown): {
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  trenchCapable: boolean;
} {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    lengthIn: num(obj.lengthIn),
    widthIn: num(obj.widthIn),
    heightIn: num(obj.heightIn),
    trenchCapable: obj.trenchCapable === true,
  };
}

/**
 * Validate a preferred-auto start position from jsonb: only return it when BOTH
 * x and y are finite numbers. A malformed payload (missing/NaN/string coords)
 * would otherwise flow into the FieldDiagram and render an off-field or broken dot.
 */
function normalizeStartPosition(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { x?: unknown; y?: unknown };
  if (typeof o.x === 'number' && Number.isFinite(o.x) && typeof o.y === 'number' && Number.isFinite(o.y)) {
    return { x: o.x, y: o.y };
  }
  return null;
}

function normalizeCapabilities(raw: unknown): { capabilities: string[]; intakeSources: string[] } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as { items?: unknown; intakeSources?: unknown };
    return {
      capabilities: Array.isArray(obj.items) ? (obj.items as string[]) : [],
      intakeSources: Array.isArray(obj.intakeSources) ? (obj.intakeSources as string[]) : [],
    };
  }
  if (Array.isArray(raw)) return { capabilities: raw as string[], intakeSources: [] };
  return { capabilities: [], intakeSources: [] };
}

/**
 * Canonical shared mapper from a raw `pit_scouting_report` row to the normalized
 * {@link TeamPit} shape. Reuses the per-field normalizers above so both
 * `useTeamPit` (single) and `useEventPits` (batch) produce identical objects.
 * Pure — never throws on a malformed row.
 */
export function rowToTeamPit(row: Record<string, unknown>): TeamPit {
  const data = row as Record<string, any>;
  const { capabilities, intakeSources } = normalizeCapabilities(data.capabilities);
  const batteries = normalizeBatteries(data.batteries);
  const dims = normalizeDimensions(data.robot_dimensions);
  return {
    eventKey: data.event_key,
    teamNumber: data.team_number,
    drivetrain: data.drivetrain ?? null,
    mechanisms: Array.isArray(data.mechanisms) ? data.mechanisms : [],
    capabilities,
    intakeSources,
    visionSystem: data.vision_system ?? null,
    batteryCount: batteries.count,
    chargerCount: batteries.chargers,
    batteryBrand: batteries.brand,
    batteryConnector: batteries.connector,
    preferredAutoStartPosition: normalizeStartPosition(data.preferred_auto_start_position),
    preferredAutoPath: Array.isArray(data.preferred_auto_path) ? data.preferred_auto_path : null,
    matchStrategy: Array.isArray(data.match_strategy) ? data.match_strategy : [],
    robotLengthIn: dims.lengthIn,
    robotWidthIn: dims.widthIn,
    robotHeightIn: dims.heightIn,
    trenchCapable: dims.trenchCapable,
    photoPath: data.photo_path ?? null,
    notes: data.notes ?? null,
    authorScoutId: data.author_scout_id ?? null,
  };
}

/**
 * Fetch a single team's pit scouting report for an event. Returns null when no
 * pit report exists yet (not an error). Used by TeamView's pit panel.
 */
export function useTeamPit(eventKey: string | null | undefined, teamNumber: number | null | undefined) {
  return useQuery<TeamPit | null>({
    queryKey: ['team-pit', eventKey, teamNumber],
    enabled: !!eventKey && teamNumber != null,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pit_scouting_report')
        .select('*')
        .eq('event_key', eventKey as string)
        .eq('team_number', teamNumber as number)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return rowToTeamPit(data as Record<string, unknown>);
    },
  });
}

/**
 * Batch hook: every pit report for an event, keyed by team number. One query for
 * the whole event (vs N per-team `useTeamPit` calls). Canonical shared return is
 * a `Map<number, TeamPit>` (pinned API — do NOT add an array-shaped variant).
 * Persisted via the global query cache, so it serves offline from the last good
 * snapshot. Returns an empty Map (never throws) when no pit rows exist.
 */
export function useEventPits(
  eventKey: string | null | undefined,
): UseQueryResult<Map<number, TeamPit>> {
  return useQuery<Map<number, TeamPit>>({
    queryKey: ['event-pits', eventKey],
    enabled: !!eventKey,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pit_scouting_report')
        .select('*')
        .eq('event_key', eventKey as string);
      if (error) throw error;
      const map = new Map<number, TeamPit>();
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const pit = rowToTeamPit(row);
        if (Number.isFinite(pit.teamNumber)) map.set(pit.teamNumber, pit);
      }
      return map;
    },
  });
}

// A single TBA team-media item (see TBA v3 Team Media model). We only read the
// fields we need to pick a direct image URL.
interface TbaMedia {
  type?: string;
  preferred?: boolean;
  direct_url?: string;
}

// Media types whose `direct_url` reliably points straight at an image file.
const TBA_IMAGE_TYPES = new Set(['imgur', 'instagram-image']);

function isUsableImageMedia(m: TbaMedia): boolean {
  return (
    typeof m.type === 'string' &&
    TBA_IMAGE_TYPES.has(m.type) &&
    typeof m.direct_url === 'string' &&
    m.direct_url.length > 0
  );
}

/**
 * Pick the best image URL from a TBA team-media array: a `preferred` image
 * first, else the first usable image-type item with a non-empty direct_url.
 * Returns null when nothing usable is present.
 */
function pickTbaImageUrl(media: TbaMedia[]): string | null {
  const usable = media.filter(isUsableImageMedia);
  if (usable.length === 0) return null;
  const preferred = usable.find((m) => m.preferred === true);
  return (preferred ?? usable[0]).direct_url ?? null;
}

// Derive a 4-digit season year from an event key (e.g. "2026casj" → 2026).
// Falls back to the current calendar year when the key has no leading digits.
function seasonYearFromEventKey(eventKey: string): number {
  const m = /^(\d{4})/.exec(eventKey);
  if (m) {
    const y = Number(m[1]);
    if (Number.isFinite(y)) return y;
  }
  return new Date().getFullYear();
}

export type TeamPhotoSource = 'pit' | 'tba' | null;

export interface TeamPhoto {
  url: string | null;
  source: TeamPhotoSource;
}

/**
 * Resolve a display photo URL for a team. Prefers a scouted pit photo (resolved
 * from its Storage object path to a short-lived signed URL); otherwise falls
 * back to The Blue Alliance team media for the event's season. Never throws —
 * any failure resolves to `{ url: null, source: null }`. Works even when no pit
 * report exists (pass `pitPhotoPath = null`).
 */
export function useTeamPhoto(
  eventKey: string | null | undefined,
  teamNumber: number | null | undefined,
  pitPhotoPath: string | null | undefined,
) {
  return useQuery<TeamPhoto>({
    queryKey: ['team-photo', eventKey, teamNumber, pitPhotoPath ?? null],
    enabled: !!eventKey && teamNumber != null,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // 1) Scouted pit photo → signed URL.
      if (pitPhotoPath) {
        const url = await signedPitPhotoUrl(pitPhotoPath).catch(() => null);
        if (url) return { url, source: 'pit' };
      }
      // 2) Fall back to TBA team media for the season. Optional: never throws.
      const year = seasonYearFromEventKey(eventKey as string);
      const path = `/team/frc${teamNumber}/media/${year}`;
      const body = await tbaGetOptional<TbaMedia[]>(path);
      if (isUnavailable(body) || !Array.isArray(body)) {
        return { url: null, source: null };
      }
      const url = pickTbaImageUrl(body);
      return url ? { url, source: 'tba' } : { url: null, source: null };
    },
  });
}
