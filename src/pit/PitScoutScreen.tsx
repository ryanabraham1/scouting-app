import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Cog,
  Camera,
  Images,
  CheckCircle2,
  ClipboardList,
  Eraser,
  Eye,
  BatteryCharging,
  Gauge,
  ListChecks,
  Loader2,
  Ruler,
  Route,
  StickyNote,
  Swords,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { useIsPhonePortrait } from '@/components/useIsPortrait';
import { cn } from '@/lib/utils';
import type { TeamPit } from '@/dash/useTeamPit';
import {
  PIT_NUMERIC_LIMITS,
  type PitReport,
  type PitPhoto,
  type PitPhotoBlobs,
} from './pitStore';
import { MAX_PIT_PHOTOS } from './processPhoto';
import { beginPwaUpdateBlock } from '@/pwa/registerPwa';
import {
  productionPitScoutAdapter,
  type PitScoutAdapter,
} from './pitScoutAdapter';

export type PitObservedAction =
  | 'drivetrain'
  | 'mechanism'
  | 'mechanism_other'
  | 'capability'
  | 'intake_source'
  | 'strategy'
  | 'vision'
  | 'battery_count'
  | 'charger_count'
  | 'battery_brand'
  | 'battery_connector'
  | 'length'
  | 'width'
  | 'height'
  | 'trench'
  | 'auto_pick_mode'
  | 'auto_start'
  | 'auto_draw_mode'
  | 'auto_path'
  | 'auto_clear'
  | 'notes'
  | 'photo'
  | 'next';

export interface PitScoutScreenProps {
  eventKey: string;
  teamNumber: number;
  scoutId: string;
  // Called after a successful submit so the flow can return to the team picker.
  onDone?: () => void;
  /** Optional route-level exit. When present, the first-step Back button uses it. */
  onExit?: () => void;
  adapter?: PitScoutAdapter;
  /** Read-only observer used by coach chrome; navigation still stays local. */
  onStepChange?: (step: number) => void;
  /** Read-only interaction observer used by app-native coaching. */
  onAction?: (action: PitObservedAction) => void;
  /** Lets the surrounding team picker block navigation during failed/pending saves. */
  onStorageProtectionChange?: (protectedFromNavigation: boolean) => void;
}

// Object URLs (local photo previews) must exist for the <img> to render; jsdom
// in tests may not implement createObjectURL, so degrade to an empty string
// rather than throwing.
function previewFor(file: Blob): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return '';
  }
}

const DRIVETRAINS = ['', 'swerve', 'tank', 'mecanum', 'west_coast', 'other'];
const CAPABILITY_OPTIONS = ['auto', 'climb_l1', 'climb_l2', 'climb_l3', 'defense'];
const INTAKE_OPTIONS = ['neutral', 'depot', 'human_feed'];
// Common REBUILT mechanisms; scouts can add anything else via the "Other" field.
const MECHANISM_OPTIONS = [
  'intake',
  'shooter',
  'elevator',
  'arm',
  'climber',
  'hopper',
  'indexer',
  'turret',
];
const STRATEGY_OPTIONS = ['score', 'feed', 'defend', 'cycle', 'support'];

// Human-friendly labels for the option keys (values written to the DB are
// unchanged — only the displayed text is prettified).
const OPTION_LABELS: Record<string, string> = {
  swerve: 'Swerve',
  tank: 'Tank',
  mecanum: 'Mecanum',
  west_coast: 'West Coast',
  other: 'Other',
  auto: 'Autonomous',
  climb_l1: 'Climb L1',
  climb_l2: 'Climb L2',
  climb_l3: 'Climb L3',
  defense: 'Defense',
  neutral: 'Neutral',
  depot: 'Depot',
  human_feed: 'Human feed',
  intake: 'Intake',
  shooter: 'Shooter',
  elevator: 'Elevator',
  arm: 'Arm',
  climber: 'Climber',
  hopper: 'Hopper',
  indexer: 'Indexer',
  turret: 'Turret',
  score: 'Score',
  feed: 'Feed',
  defend: 'Defend',
  cycle: 'Cycle',
  support: 'Support',
};

function labelFor(key: string): string {
  return OPTION_LABELS[key] ?? key;
}

function emptyReport(p: PitScoutScreenProps): PitReport {
  return {
    eventKey: p.eventKey,
    teamNumber: p.teamNumber,
    drivetrain: '',
    mechanisms: [],
    capabilities: [],
    intakeSources: [],
    visionSystem: '',
    batteryCount: null,
    chargerCount: null,
    batteryBrand: '',
    batteryConnector: '',
    preferredAutoStartPosition: null,
    preferredAutoPath: null,
    matchStrategy: [],
    robotLengthIn: null,
    robotWidthIn: null,
    robotHeightIn: null,
    trenchCapable: false,
    photos: [],
    photoPath: null,
    notes: '',
    scoutId: p.scoutId,
  };
}

function reportFromCachedPit(pit: TeamPit, props: PitScoutScreenProps): PitReport {
  return {
    eventKey: props.eventKey,
    teamNumber: props.teamNumber,
    drivetrain: pit.drivetrain ?? '',
    mechanisms: pit.mechanisms,
    capabilities: pit.capabilities,
    intakeSources: pit.intakeSources,
    visionSystem: pit.visionSystem ?? '',
    batteryCount: pit.batteryCount,
    chargerCount: pit.chargerCount,
    batteryBrand: pit.batteryBrand ?? '',
    batteryConnector: pit.batteryConnector ?? '',
    preferredAutoStartPosition: pit.preferredAutoStartPosition,
    preferredAutoPath: pit.preferredAutoPath,
    matchStrategy: pit.matchStrategy,
    robotLengthIn: pit.robotLengthIn,
    robotWidthIn: pit.robotWidthIn,
    robotHeightIn: pit.robotHeightIn,
    trenchCapable: pit.trenchCapable,
    photos: pit.photos ?? [],
    photoPath: pit.photoPath,
    notes: pit.notes ?? '',
    scoutId: props.scoutId,
  };
}

// Parse a number input into `number | null` (empty / invalid → null) so partial
// entries never coerce to 0 or NaN in the report. Every numeric pit field (battery/
// charger counts, robot dimensions) is non-negative (the inputs carry min={0}), so
// floor at 0 — the min attribute alone doesn't stop a typed/pasted "-5".
export function parsePitNumber(v: string, max: number): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(0, n));
}

// Pit scouting is a stepped wizard (mirrors the post-match Review flow) instead
// of one long form: a progress bar + one focused section at a time + Back/Next.
// Steps map to logical groups of fields; the ordered titles/icons drive the header.
const STEPS: { title: string; icon: LucideIcon }[] = [
  { title: 'Drivetrain & mechanisms', icon: Gauge },
  { title: 'Capabilities & intake', icon: ListChecks },
  { title: 'Strategy, vision & power', icon: Swords },
  { title: 'Robot dimensions', icon: Ruler },
  { title: 'Preferred auto', icon: Route },
  { title: 'Notes & photos', icon: StickyNote },
];
const LAST_STEP = STEPS.length - 1;

// One step's panel. ALL panels stay mounted (so field state survives navigation
// and every control is reachable for tests); the inactive ones are display:none.
// NB: the `flex` utility would override the HTML `hidden` attribute (author
// display beats the UA [hidden] rule), so toggle the display CLASS instead —
// `hidden` (Tailwind) when inactive, `flex` when active.
function Panel(props: { active: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <div className={cn('flex-col gap-4', props.active ? 'flex' : 'hidden')}>
      {props.children}
    </div>
  );
}

// A titled card that holds a group of fields within a step.
function Group(props: {
  icon: LucideIcon;
  title: string;
  tone?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { icon: Icon, title, tone = 'text-brand', children } = props;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <p className="flex items-center gap-2 text-base font-semibold">
        <Icon className={cn('size-5 shrink-0', tone)} />
        <span className="min-w-0 break-words">{title}</span>
      </p>
      {children}
    </div>
  );
}

export default function PitScoutScreen(props: PitScoutScreenProps): JSX.Element {
  React.useLayoutEffect(() => beginPwaUpdateBlock(), []);
  const adapter = props.adapter ?? productionPitScoutAdapter;
  const [report, setReport] = React.useState<PitReport>(() => emptyReport(props));
  const [photoUrls, setPhotoUrls] = React.useState<Record<string, string>>({});
  const [baseRevision, setBaseRevision] = React.useState<number | null>(null);
  const [conflictCopy, setConflictCopy] = React.useState<{
    report: PitReport;
    photoBlobs: PitPhotoBlobs;
  } | null>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const [processingPhotos, setProcessingPhotos] = React.useState(false);
  const [hydration, setHydration] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [hydrationNonce, setHydrationNonce] = React.useState(0);
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  const [draftStorage, setDraftStorage] = React.useState<
    'ready' | 'saving' | 'saved' | 'error'
  >('ready');
  // Preferred-auto editor: tap to place the start, or draw the path.
  const [autoMode, setAutoMode] = React.useState<'pick-start' | 'draw-path'>('pick-start');
  // Wizard step (mirrors the Review flow). All panels stay mounted; only the
  // active one is visible.
  const [step, setStep] = React.useState(0);
  // Phones get the tall, rotated editor; portrait tablets have enough width to
  // keep the field upright and gain a much larger precision drawing surface.
  const isPhonePortrait = useIsPhonePortrait();

  const photoBlobsRef = React.useRef<PitPhotoBlobs>({});
  const objectUrlsRef = React.useRef<Record<string, string>>({});
  const draftSaveChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const draftSaveVersionRef = React.useRef(0);
  const draftStorageRef = React.useRef(draftStorage);
  const reportRef = React.useRef(report);
  const baseRevisionRef = React.useRef(baseRevision);

  React.useEffect(() => {
    reportRef.current = report;
  }, [report]);
  React.useEffect(() => {
    baseRevisionRef.current = baseRevision;
  }, [baseRevision]);

  const queueDraftSave = React.useCallback((next: PitReport, blobs: PitPhotoBlobs): void => {
    const version = ++draftSaveVersionRef.current;
    draftStorageRef.current = 'saving';
    setDraftStorage('saving');
    draftSaveChainRef.current = draftSaveChainRef.current
      .catch(() => undefined)
      .then(() => adapter.saveDraft(
        props.eventKey,
        props.teamNumber,
        next,
        blobs,
        baseRevisionRef.current,
      ))
      .then(() => {
        if (draftSaveVersionRef.current === version) {
          draftStorageRef.current = 'saved';
          setDraftStorage('saved');
        }
      })
      .catch(() => {
        if (draftSaveVersionRef.current === version) {
          draftStorageRef.current = 'error';
          setDraftStorage('error');
        }
      });
  }, [adapter, props.eventKey, props.teamNumber]);

  React.useEffect(() => {
    const protectedFromNavigation = draftStorage === 'saving' || draftStorage === 'error';
    props.onStorageProtectionChange?.(protectedFromNavigation);
    if (!protectedFromNavigation) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      props.onStorageProtectionChange?.(false);
    };
  }, [draftStorage, props.onStorageProtectionChange]);

  function setLocalPreview(photoId: string, file: Blob): void {
    const oldUrl = objectUrlsRef.current[photoId];
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    photoBlobsRef.current = { ...photoBlobsRef.current, [photoId]: file };
    const url = previewFor(file);
    if (url) objectUrlsRef.current[photoId] = url;
    setPhotoUrls((current) => ({ ...current, [photoId]: url }));
  }

  React.useEffect(() => {
    let active = true;
    setHydration('loading');
    setConflictCopy(null);
    setReport(emptyReport(props));
    setBaseRevision(null);
    setIsEditing(false);
    draftStorageRef.current = 'ready';
    setDraftStorage('ready');
    void (async () => {
      try {
      const draft = await adapter.getDraft(props.eventKey, props.teamNumber);
      const local = await adapter.getReport(props.eventKey, props.teamNumber);
      const preserveLocal =
        Boolean(draft) || local?.syncState === 'dirty' || local?.syncState === 'pending';
      let loadedReport = preserveLocal ? (draft?.data ?? local?.data) : undefined;
      let loadedRevision = preserveLocal
        ? (draft?.baseRevision ?? local?.baseRevision ?? null)
        : null;
      let blobs = preserveLocal ? (draft?.photoBlobs ?? local?.photoBlobs ?? {}) : {};

      // Synced rows are only a local snapshot, and conflict/error rows carry a
      // revision the server has already rejected. Refresh both from the server
      // instead of rehydrating stale content/baseRevision forever. A rejected
      // local copy remains available below as an explicit recovery choice.
      if (!preserveLocal) {
        try {
          const remote = await adapter.fetchReportForEdit(
            props.eventKey,
            props.teamNumber,
            props.scoutId,
          );
          loadedReport = remote?.report;
          loadedRevision = remote?.revision ?? null;
          if (active && local?.syncState === 'error') {
            setConflictCopy({
              report: local.data,
              photoBlobs: local.photoBlobs ?? {},
            });
          }
        } catch {
          const cached = adapter.getCachedReport(props.eventKey, props.teamNumber);
          if (cached) {
            loadedReport = reportFromCachedPit(cached, props);
            loadedRevision = cached.rowRevision ?? null;
          } else if (local?.syncState === 'synced') {
            // Offline fallback only: this row was previously accepted by the
            // server. Online mounts always refresh it above.
            loadedReport = local.data;
            loadedRevision = local.rowRevision ?? local.baseRevision ?? null;
            blobs = local.photoBlobs ?? {};
          } else if (local?.syncState === 'error') {
            // The rejected row is still the only durable copy while offline.
            // Rehydrate it for explicit correction/re-submission.
            loadedReport = local.data;
            loadedRevision = local.baseRevision ?? null;
            blobs = local.photoBlobs ?? {};
          }
        }
      }
      if (!active) return;
      if (!loadedReport) {
        setHydration('ready');
        return;
      }

      const next = {
        ...emptyReport(props),
        ...loadedReport,
        photos: loadedReport.photos ?? [],
        scoutId: props.scoutId,
        eventKey: props.eventKey,
        teamNumber: props.teamNumber,
      };
      setReport(next);
      setBaseRevision(loadedRevision);
      setIsEditing(loadedRevision != null || Boolean(local));
      photoBlobsRef.current = blobs;
      for (const [photoId, blob] of Object.entries(blobs)) {
        setLocalPreview(photoId, blob);
      }
      for (const photo of next.photos) {
        if (!photo.path || blobs[photo.id]) continue;
        void adapter.signedPhotoUrl(photo.path).then((url) => {
          if (active && url) setPhotoUrls((current) => ({ ...current, [photo.id]: url }));
        }).catch(() => {
          if (active) setPhotoError('Some uploaded photos are unavailable offline.');
        });
      }
      } catch {
        if (active) setHydration('error');
        return;
      }
      if (active) setHydration('ready');
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, props.eventKey, props.scoutId, props.teamNumber, hydrationNonce]);

  function recoverConflictCopy(): void {
    if (!conflictCopy) return;
    const recovered = {
      ...emptyReport(props),
      ...conflictCopy.report,
      eventKey: props.eventKey,
      teamNumber: props.teamNumber,
      scoutId: props.scoutId,
      photos: conflictCopy.report.photos ?? [],
    };
    setReport(recovered);
    photoBlobsRef.current = conflictCopy.photoBlobs;
    setConflictCopy(null);
    setStatus('idle');
    // Keep the freshly fetched baseRevision. The recovered content is now a
    // deliberate new edit against the latest server row, not a stale retry.
    queueDraftSave(recovered, conflictCopy.photoBlobs);
  }

  React.useEffect(() => {
    props.onStepChange?.(step);
  }, [props.onStepChange, step]);

  // Revoke any live object URL on unmount.
  React.useEffect(() => {
    return () => {
      for (const url of Object.values(objectUrlsRef.current)) URL.revokeObjectURL(url);
    };
  }, []);

  function update(patch: Partial<PitReport>): void {
    const next = { ...reportRef.current, ...patch };
    reportRef.current = next;
    setReport(next);
    queueDraftSave(next, { ...photoBlobsRef.current });
    setStatus('idle');
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  async function onPhotos(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length || processingPhotos) return;
    const available = MAX_PIT_PHOTOS - report.photos.length;
    if (available <= 0) {
      setPhotoError(`You can attach up to ${MAX_PIT_PHOTOS} photos.`);
      return;
    }
    setPhotoError(null);
    setProcessingPhotos(true);
    const additions: PitPhoto[] = [];
    const failures: string[] = [];
    for (const file of files.slice(0, available)) {
      try {
        const processed = await adapter.processPhoto(file);
        const id = crypto.randomUUID();
        setLocalPreview(id, processed.blob);
        additions.push({
          id,
          path: null,
          order: report.photos.length + additions.length,
          mimeType: processed.blob.type || 'image/jpeg',
          width: processed.width,
          height: processed.height,
        });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${file.name} could not be processed.`);
      }
    }
    try {
      if (additions.length > 0) {
      const photos = [...report.photos, ...additions];
      update({ photos, photoPath: photos[0]?.path ?? null });
      props.onAction?.('photo');
      }
      if (files.length > available) {
        setPhotoError(`Only the first ${available} photo${available === 1 ? '' : 's'} were added.`);
      } else if (failures.length > 0) {
        setPhotoError(
          `${additions.length} photo${additions.length === 1 ? '' : 's'} added; ${failures.length} failed. ${failures[0]}`,
        );
      }
    } finally {
      setProcessingPhotos(false);
    }
  }

  function removePhoto(photoId: string): void {
    const url = objectUrlsRef.current[photoId];
    if (url) URL.revokeObjectURL(url);
    delete objectUrlsRef.current[photoId];
    const blobs = { ...photoBlobsRef.current };
    delete blobs[photoId];
    photoBlobsRef.current = blobs;
    setPhotoUrls((current) => {
      const next = { ...current };
      delete next[photoId];
      return next;
    });
    const photos = report.photos
      .filter((photo) => photo.id !== photoId)
      .map((photo, index) => ({ ...photo, order: index }));
    update({ photos, photoPath: photos[0]?.path ?? null });
  }

  function movePhoto(photoId: string, direction: -1 | 1): void {
    const currentIndex = report.photos.findIndex((photo) => photo.id === photoId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= report.photos.length) return;
    const photos = [...report.photos];
    [photos[currentIndex], photos[nextIndex]] = [photos[nextIndex], photos[currentIndex]];
    update({
      photos: photos.map((photo, index) => ({ ...photo, order: index })),
      photoPath: photos[0]?.path ?? null,
    });
  }

  async function onSubmit(): Promise<void> {
    if (processingPhotos || status === 'saving') return;
    setStatus('saving');
    try {
      await draftSaveChainRef.current;
      if (draftStorageRef.current === 'error') {
        setStatus('error');
        return;
      }
      // Queue locally (with the pending photo) and let the sync engine upload
      // when there's network — works fully offline.
      await adapter.enqueueReport(report, photoBlobsRef.current, baseRevision);
      setStatus('saved');
      // Nudge the sync indicator to pick up the new pending upload immediately.
      adapter.notifyQueued();
      // Back to the team picker to scout the next robot.
      props.onDone?.();
    } catch {
      setStatus('error');
    }
  }

  function retryDraftStorage(): void {
    queueDraftSave(reportRef.current, { ...photoBlobsRef.current });
  }

  // Semantic tone per option group: capabilities split between climb (success
  // green = scored end-game), defense (brand cyan = defense convention) and
  // autonomous (energy orange); intake sourcing (fuel) is energy orange.
  type ChipTone = 'success' | 'brand' | 'energy';
  const CHIP_TONE: Record<string, ChipTone> = {
    auto: 'energy',
    climb_l1: 'success',
    climb_l2: 'success',
    climb_l3: 'success',
    defense: 'brand',
    neutral: 'energy',
    depot: 'energy',
    human_feed: 'energy',
  };

  const TONE_CHIP: Record<ChipTone, string> = {
    success: 'border-success/40 bg-success/15 text-success',
    brand: 'border-brand/40 bg-brand/15 text-brand',
    energy: 'border-energy/40 bg-energy/15 text-energy',
  };
  const TONE_ACCENT: Record<ChipTone, string> = {
    success: 'accent-[hsl(var(--success))]',
    brand: 'accent-[hsl(var(--brand))]',
    energy: 'accent-[hsl(var(--energy))]',
  };

  const optionChip = (active: boolean, tone: ChipTone) =>
    cn(
      'flex min-h-[56px] items-center gap-3 rounded-2xl border px-4 text-base font-medium transition-colors',
      active
        ? TONE_CHIP[tone]
        : 'border-border bg-card text-muted-foreground hover:bg-muted',
    );

  const next = (): void => {
    props.onAction?.('next');
    setStep((s) => Math.min(LAST_STEP, s + 1));
  };
  const prev = (): void => setStep((s) => Math.max(0, s - 1));
  const StepIcon = STEPS[step].icon;
  const photoControlsDisabled =
    processingPhotos || report.photos.length >= MAX_PIT_PHOTOS;

  if (hydration !== 'ready') {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-6 text-center">
        {hydration === 'loading' ? (
          <>
            <Loader2 className="size-6 animate-spin text-brand" />
            <p role="status">Restoring saved pit work…</p>
          </>
        ) : (
          <>
            <p role="alert" className="text-destructive">
              Saved pit work could not be opened. Nothing was overwritten.
            </p>
            <Button type="button" variant="outline" onClick={() => setHydrationNonce((n) => n + 1)}>
              Try again
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="pit-screen"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-safe py-safe"
    >
      {/* Stepper header: team · step counter · current-step title · progress. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h1 className="flex min-w-0 items-center gap-2 text-xl font-bold sm:text-2xl">
            <Wrench className="size-6 shrink-0 text-brand" />
            <span className="min-w-0 break-words">
              Team <span className="font-mono text-brand tabular-nums">{props.teamNumber}</span>
            </span>
          </h1>
          <span
            data-testid="pit-step"
            className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground"
          >
            Step {step + 1} of {STEPS.length}
          </span>
        </div>
        {isEditing ? (
          <p data-testid="pit-editing" className="text-sm font-medium text-energy">
            Editing the shared pit report
          </p>
        ) : null}
        {conflictCopy ? (
          <div
            data-testid="pit-conflict-recovery"
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <p>
              Another device saved this report. The latest shared version is loaded; your
              rejected local copy is still available.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={recoverConflictCopy}>
              Recover my local copy onto latest
            </Button>
          </div>
        ) : null}
        {draftStorage === 'saving' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saving this draft on this device…
          </p>
        ) : draftStorage === 'error' ? (
          <div
            data-testid="pit-storage-error"
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p>
              This draft is only in memory because device storage failed or is full.
              Stay on this page, free storage if needed, then retry.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={retryDraftStorage}>
              Retry device save
            </Button>
          </div>
        ) : null}
        <p className="flex items-center gap-2 text-base font-semibold text-brand">
          <StepIcon className="size-5 shrink-0" />
          {STEPS[step].title}
        </p>
        <div className="flex gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`h-2 flex-1 rounded-full transition-colors ${
                i < step ? 'bg-success' : i === step ? 'bg-brand' : 'bg-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Step 1 — Drivetrain & mechanisms */}
      <Panel active={step === 0}>
        <div className="grid gap-4 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.3fr)]">
          <Group icon={Gauge} title="Drivetrain">
            <Label htmlFor="pit-drivetrain" className="sr-only">
              Drivetrain
            </Label>
            <select
              id="pit-drivetrain"
              data-testid="pit-drivetrain"
              value={report.drivetrain}
              onChange={(e) => {
                update({ drivetrain: e.target.value });
                props.onAction?.('drivetrain');
              }}
              className="h-14 w-full rounded-xl border border-input bg-transparent px-3 text-base text-foreground"
            >
              {DRIVETRAINS.map((d) => (
                <option key={d} value={d}>
                  {d === '' ? 'Select…' : labelFor(d)}
                </option>
              ))}
            </select>
          </Group>

          <Group icon={Cog} title="Mechanisms">
            <div data-testid="pit-mechanisms" className="grid gap-2 sm:grid-cols-2">
              {MECHANISM_OPTIONS.map((m) => {
                const active = report.mechanisms.includes(m);
                return (
                  <label key={m} className={optionChip(active, 'brand')}>
                    <input
                      type="checkbox"
                      className={cn('size-6', TONE_ACCENT.brand)}
                      checked={active}
                      onChange={() => {
                        update({ mechanisms: toggle(report.mechanisms, m) });
                        props.onAction?.('mechanism');
                      }}
                    />
                    {labelFor(m)}
                  </label>
                );
              })}
            </div>
            <Label htmlFor="pit-mechanisms-other" className="mt-1 text-sm text-muted-foreground">
              Other (comma separated)
            </Label>
            <Input
              id="pit-mechanisms-other"
              data-testid="pit-mechanisms-other"
              className="h-14 text-base"
              placeholder="e.g. passive deflector, vision turret"
              value={report.mechanisms.filter((m) => !MECHANISM_OPTIONS.includes(m)).join(', ')}
              onChange={(e) => {
                // Preserve the checklist selections; replace only the free-text extras.
                const known = report.mechanisms.filter((m) => MECHANISM_OPTIONS.includes(m));
                const custom = e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                update({ mechanisms: [...known, ...custom] });
                props.onAction?.('mechanism_other');
              }}
            />
          </Group>
        </div>
      </Panel>

      {/* Step 2 — Capabilities & intake */}
      <Panel active={step === 1}>
        <div className="grid gap-4 md:grid-cols-2">
          <Group icon={ListChecks} title="Capabilities" tone="text-success">
            <div data-testid="pit-capabilities" className="flex flex-col gap-2">
              {CAPABILITY_OPTIONS.map((c) => {
                const active = report.capabilities.includes(c);
                const tone = CHIP_TONE[c] ?? 'brand';
                return (
                  <label key={c} className={optionChip(active, tone)}>
                    <input
                      type="checkbox"
                      className={cn('size-6', TONE_ACCENT[tone])}
                      checked={active}
                      onChange={() => {
                        update({ capabilities: toggle(report.capabilities, c) });
                        props.onAction?.('capability');
                      }}
                    />
                    {labelFor(c)}
                  </label>
                );
              })}
            </div>
          </Group>

          <Group icon={ClipboardList} title="Intake sources" tone="text-energy">
            <div data-testid="pit-intake-sources" className="flex flex-col gap-2">
              {INTAKE_OPTIONS.map((s) => {
                const active = report.intakeSources.includes(s);
                const tone = CHIP_TONE[s] ?? 'energy';
                return (
                  <label key={s} className={optionChip(active, tone)}>
                    <input
                      type="checkbox"
                      className={cn('size-6', TONE_ACCENT[tone])}
                      checked={active}
                      onChange={() => {
                        update({ intakeSources: toggle(report.intakeSources, s) });
                        props.onAction?.('intake_source');
                      }}
                    />
                    {labelFor(s)}
                  </label>
                );
              })}
            </div>
          </Group>
        </div>
      </Panel>

      {/* Step 3 — Strategy, vision & power */}
      <Panel active={step === 2}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Group icon={Swords} title="Preferred match strategy">
            <div
              data-testid="pit-match-strategy"
              className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"
            >
              {STRATEGY_OPTIONS.map((s) => {
                const active = report.matchStrategy.includes(s);
                return (
                  <label key={s} className={optionChip(active, 'brand')}>
                    <input
                      type="checkbox"
                      className={cn('size-6', TONE_ACCENT.brand)}
                      checked={active}
                      onChange={() => {
                        update({ matchStrategy: toggle(report.matchStrategy, s) });
                        props.onAction?.('strategy');
                      }}
                    />
                    {labelFor(s)}
                  </label>
                );
              })}
            </div>
          </Group>

          <Group icon={Eye} title="Vision & batteries">
            <Label
              htmlFor="pit-vision"
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
            >
              Vision system
            </Label>
            <Input
              id="pit-vision"
              data-testid="pit-vision"
              className="h-14 text-base"
              placeholder="e.g. Limelight 3, PhotonVision, none"
              value={report.visionSystem}
              onChange={(e) => {
                update({ visionSystem: e.target.value });
                props.onAction?.('vision');
              }}
            />
            <p className="eyebrow mt-2 flex items-center gap-1.5">
              <BatteryCharging className="size-4 text-energy" />
              Batteries &amp; chargers
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-battery-count" className="text-sm text-muted-foreground">
                  # of batteries
                </Label>
                <Input
                  id="pit-battery-count"
                  data-testid="pit-battery-count"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={PIT_NUMERIC_LIMITS.batteryCount}
                  className="h-14 text-base"
                  placeholder="0"
                  value={report.batteryCount ?? ''}
                  onChange={(e) => {
                    update({
                      batteryCount: parsePitNumber(
                        e.target.value,
                        PIT_NUMERIC_LIMITS.batteryCount,
                      ),
                    });
                    props.onAction?.('battery_count');
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-charger-count" className="text-sm text-muted-foreground">
                  # of chargers
                </Label>
                <Input
                  id="pit-charger-count"
                  data-testid="pit-charger-count"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={PIT_NUMERIC_LIMITS.chargerCount}
                  className="h-14 text-base"
                  placeholder="0"
                  value={report.chargerCount ?? ''}
                  onChange={(e) => {
                    update({
                      chargerCount: parsePitNumber(
                        e.target.value,
                        PIT_NUMERIC_LIMITS.chargerCount,
                      ),
                    });
                    props.onAction?.('charger_count');
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-battery-brand" className="text-sm text-muted-foreground">
                  Brand
                </Label>
                <Input
                  id="pit-battery-brand"
                  data-testid="pit-battery-brand"
                  className="h-14 text-base"
                  placeholder="e.g. MK, Duracell"
                  value={report.batteryBrand}
                  onChange={(e) => {
                    update({ batteryBrand: e.target.value });
                    props.onAction?.('battery_brand');
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-battery-connector" className="text-sm text-muted-foreground">
                  Connector type
                </Label>
                <Input
                  id="pit-battery-connector"
                  data-testid="pit-battery-connector"
                  className="h-14 text-base"
                  placeholder="e.g. Anderson SB50"
                  value={report.batteryConnector}
                  onChange={(e) => {
                    update({ batteryConnector: e.target.value });
                    props.onAction?.('battery_connector');
                  }}
                />
              </div>
            </div>
          </Group>
        </div>
      </Panel>

      {/* Step 4 — Robot dimensions */}
      <Panel active={step === 3}>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pit-length" className="text-sm text-muted-foreground">
                Length (in)
              </Label>
              <Input
                id="pit-length"
                data-testid="pit-length"
                type="number"
                inputMode="decimal"
                min={0}
                max={PIT_NUMERIC_LIMITS.dimensionIn}
                className="h-14 text-base"
                placeholder="0"
                value={report.robotLengthIn ?? ''}
                onChange={(e) => {
                  update({
                    robotLengthIn: parsePitNumber(
                      e.target.value,
                      PIT_NUMERIC_LIMITS.dimensionIn,
                    ),
                  });
                  props.onAction?.('length');
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pit-width" className="text-sm text-muted-foreground">
                Width (in)
              </Label>
              <Input
                id="pit-width"
                data-testid="pit-width"
                type="number"
                inputMode="decimal"
                min={0}
                max={PIT_NUMERIC_LIMITS.dimensionIn}
                className="h-14 text-base"
                placeholder="0"
                value={report.robotWidthIn ?? ''}
                onChange={(e) => {
                  update({
                    robotWidthIn: parsePitNumber(
                      e.target.value,
                      PIT_NUMERIC_LIMITS.dimensionIn,
                    ),
                  });
                  props.onAction?.('width');
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pit-height" className="text-sm text-muted-foreground">
                Height (in)
              </Label>
              <Input
                id="pit-height"
                data-testid="pit-height"
                type="number"
                inputMode="decimal"
                min={0}
                max={PIT_NUMERIC_LIMITS.dimensionIn}
                className="h-14 text-base"
                placeholder="0"
                value={report.robotHeightIn ?? ''}
                onChange={(e) => {
                  update({
                    robotHeightIn: parsePitNumber(
                      e.target.value,
                      PIT_NUMERIC_LIMITS.dimensionIn,
                    ),
                  });
                  props.onAction?.('height');
                }}
              />
            </div>
          </div>
          <label className={cn(optionChip(report.trenchCapable, 'success'), 'mt-1')}>
            <input
              type="checkbox"
              data-testid="pit-trench"
              className={cn('size-6', TONE_ACCENT.success)}
              checked={report.trenchCapable}
              onChange={() => {
                update({ trenchCapable: !report.trenchCapable });
                props.onAction?.('trench');
              }}
            />
            Can fit through the trench
          </label>
        </div>
      </Panel>

      {/* Step 5 — Preferred auto */}
      <Panel active={step === 4}>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid="pit-auto-pick-start"
              variant={autoMode === 'pick-start' ? 'brand' : 'outline'}
              size="sm"
              onClick={() => {
                setAutoMode('pick-start');
                props.onAction?.('auto_pick_mode');
              }}
            >
              Set start
            </Button>
            <Button
              type="button"
              data-testid="pit-auto-draw-path"
              variant={autoMode === 'draw-path' ? 'brand' : 'outline'}
              size="sm"
              onClick={() => {
                setAutoMode('draw-path');
                props.onAction?.('auto_draw_mode');
              }}
            >
              Draw path
            </Button>
            <Button
              type="button"
              data-testid="pit-auto-clear"
              variant="outline"
              size="sm"
              className="ml-auto gap-1.5"
              onClick={() => {
                update({ preferredAutoStartPosition: null, preferredAutoPath: null });
                props.onAction?.('auto_clear');
              }}
            >
              <Eraser className="size-4" /> Clear
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {autoMode === 'pick-start'
              ? isPhonePortrait
                ? 'Turn phone sideways · tap the start spot'
                : 'Tap the field where it starts'
              : 'Drag across the field to draw the path'}
          </p>
          <div
            data-testid="pit-auto-field-shell"
            className={
              isPhonePortrait
                ? 'mx-auto flex h-[55dvh] min-h-80 w-full justify-center'
                : 'mx-auto w-full max-w-4xl'
            }
          >
            <FieldDiagram
              mode={autoMode}
              rotate={isPhonePortrait}
              fillHeight={isPhonePortrait}
              startPosition={report.preferredAutoStartPosition}
              path={report.preferredAutoPath}
              onStartChange={(p: FieldPoint) => {
                update({ preferredAutoStartPosition: p });
                props.onAction?.('auto_start');
              }}
              onPathChange={(pts: FieldPoint[]) => {
                update({ preferredAutoPath: pts });
                props.onAction?.('auto_path');
              }}
              data-testid="pit-auto-field"
            />
          </div>
        </div>
      </Panel>

      {/* Step 6 — Notes & photo */}
      <Panel active={step === 5}>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <Label htmlFor="pit-notes" className="text-sm text-muted-foreground">
            Notes
          </Label>
          <textarea
            id="pit-notes"
            data-testid="pit-notes"
            className="min-h-28 w-full rounded-xl border border-input bg-transparent p-3 text-base"
            placeholder="Anything notable about this robot…"
            value={report.notes}
            onChange={(e) => {
              update({ notes: e.target.value });
              props.onAction?.('notes');
            }}
          />
          <Label htmlFor="pit-photo" className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Camera className="size-4" />
            Robot photos ({report.photos.length}/{MAX_PIT_PHOTOS})
          </Label>
          <div className="grid grid-cols-2 gap-2 sm:max-w-xl">
            <label
              htmlFor="pit-camera"
              data-testid="pit-camera-control"
              aria-disabled={photoControlsDisabled}
              className={cn(
                'flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-input bg-muted px-3 text-center text-sm font-medium text-foreground transition-colors',
                photoControlsDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer active:bg-muted/70',
              )}
            >
              <Camera className="size-5 shrink-0" />
              Take photo
            </label>
            <label
              htmlFor="pit-photo"
              data-testid="pit-photo-control"
              aria-disabled={photoControlsDisabled}
              className={cn(
                'flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-input bg-muted px-3 text-center text-sm font-medium text-foreground transition-colors',
                photoControlsDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer active:bg-muted/70',
              )}
            >
              <Images className="size-5 shrink-0" />
              Choose photos
            </label>
          </div>
          <input
            id="pit-camera"
            data-testid="pit-camera"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void onPhotos(event)}
            disabled={photoControlsDisabled}
            className="sr-only"
          />
          <input
            id="pit-photo"
            data-testid="pit-photo"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => void onPhotos(event)}
            disabled={photoControlsDisabled}
            className="sr-only"
          />
          {photoError ? (
            <p role="alert" className="text-sm text-destructive">{photoError}</p>
          ) : null}
          {processingPhotos ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Processing selected photos…
            </p>
          ) : report.photos.length >= MAX_PIT_PHOTOS ? (
            <p className="text-sm text-muted-foreground">Photo limit reached.</p>
          ) : null}
          {report.photos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {report.photos.map((photo, index) => (
                <div key={photo.id} className="overflow-hidden rounded-xl border border-border bg-muted/30">
                  {photoUrls[photo.id] ? (
                    <img
                      src={photoUrls[photo.id]}
                      alt={`Pit photo ${index + 1} preview`}
                      className="aspect-[4/3] w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center text-xs text-muted-foreground">
                      Loading photo…
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-1 p-1.5">
                    <div className="flex">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move photo ${index + 1} earlier`}
                        disabled={index === 0}
                        onClick={() => movePhoto(photo.id, -1)}
                      >
                        <ArrowLeft className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Move photo ${index + 1} later`}
                        disabled={index === report.photos.length - 1}
                        onClick={() => movePhoto(photo.id, 1)}
                      >
                        <ArrowRight className="size-4" />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      data-testid={index === 0 ? 'pit-photo-remove' : `pit-photo-remove-${index}`}
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove photo ${index + 1}`}
                      onClick={() => removePhoto(photo.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      {/* Wizard nav: Back / Next; Submit takes Next's place on the last step
          (kept mounted-but-hidden earlier so it's always addressable). */}
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          data-testid="pit-back"
          variant="outline"
          size="big"
          className="flex-1 gap-2 sm:max-w-44 sm:flex-none"
          disabled={
            processingPhotos ||
            (step === 0 && (!props.onExit || draftStorage === 'saving' || draftStorage === 'error'))
          }
          onClick={step === 0 ? props.onExit : prev}
        >
          <ArrowLeft className="size-5" /> Back
        </Button>
        {step < LAST_STEP ? (
          <Button
            type="button"
            data-testid="pit-next"
            variant="brand"
            size="big"
            className="flex-1 gap-2 sm:max-w-44 sm:flex-none"
            disabled={processingPhotos}
            onClick={next}
          >
            Next <ArrowRight className="size-5" />
          </Button>
        ) : null}
        <Button
          data-testid="pit-submit"
          variant="brand"
          size="big"
          className={cn('flex-1 gap-2 sm:max-w-44 sm:flex-none', step !== LAST_STEP && 'hidden')}
          disabled={
            status === 'saving' ||
            processingPhotos ||
            draftStorage === 'error'
          }
          onClick={() => void onSubmit()}
        >
          {status === 'saving' ? (
            <>
              <Loader2 className="size-5 animate-spin" /> Submitting…
            </>
          ) : (
            <>
              <CheckCircle2 className="size-5" /> {isEditing ? 'Save changes' : 'Submit'}
            </>
          )}
        </Button>
      </div>

      {status === 'saved' && (
        <p
          data-testid="pit-saved"
          className="flex items-center gap-2 text-base font-medium text-success"
        >
          <CheckCircle2 className="size-5" /> Saved — queued for upload.
        </p>
      )}
      {status === 'error' && (
        <p data-testid="pit-error" className="text-base font-medium text-destructive">
          Couldn’t save — please try again.
        </p>
      )}
    </div>
  );
}
