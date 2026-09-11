import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Images,
  CheckCircle2,
  Eraser,
  Eye,
  Gauge,
  ListChecks,
  Loader2,
  Maximize2,
  Plus,
  Ruler,
  Route,
  Sparkles,
  StickyNote,
  Swords,
  Trash2,
  Wrench,
  X,
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
  emptyPitQuestionnaire,
  normalizeAutoRoutines,
  normalizePitQuestionnaire,
  type PitAutoRoutine,
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
  | 'capability'
  | 'intake_source'
  | 'strategy'
  | 'vision'
  | 'shooter'
  | 'accuracy'
  | 'status'
  | 'length'
  | 'width'
  | 'height'
  | 'trench'
  | 'auto_open'
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

const DRIVETRAINS = ['', 'swerve', 'tank'];
const SHOOTER_TYPES = [
  'turret',
  'double_turret',
  'single_lane',
  'double_lane',
  'full_width_drum',
  'other',
];
const INTAKE_OPTIONS = ['ground', 'outpost_only'];
const SHOOTING_RANGES = [
  'against_hub',
  'near_hub',
  'alliance_zone_except_trench',
  'anywhere_including_trench',
  'other',
];
const ACCURACY_OPTIONS = ['not_capable', '0_25', '25_50', '50_75', '75_90', '90_100'];
const ROBOT_CAPABILITIES = [
  'shooting',
  'feed_neutral',
  'score_outpost',
  'feed_under_trench',
  'feed_opponent_to_neutral',
  'feed_opponent_to_alliance',
  'defense',
  'other',
];

// Human-friendly labels for the option keys (values written to the DB are
// unchanged — only the displayed text is prettified).
const OPTION_LABELS: Record<string, string> = {
  swerve: 'Swerve',
  tank: 'Tank',
  other: 'Other',
  turret: 'Turret',
  double_turret: 'Double turret',
  single_lane: 'Single lane shooter',
  double_lane: 'Double lane shooter',
  full_width_drum: 'Full-width shooter (drum)',
  ground: 'Ground',
  outpost_only: 'Outpost only',
  against_hub: 'Against the hub',
  near_hub: 'In the proximity of the hub',
  alliance_zone_except_trench: 'Anywhere in the alliance zone (except under trench)',
  anywhere_including_trench: 'Anywhere, including under trench',
  not_capable: 'Not capable',
  '0_25': '0–25%',
  '25_50': '25–50%',
  '50_75': '50–75%',
  '75_90': '75–90%',
  '90_100': '90–100%',
  shooting: 'Shooting',
  feed_neutral: 'Feeding from neutral',
  score_outpost: 'Scoring in outpost',
  feed_under_trench: 'Feeding by pushing balls under trench',
  feed_opponent_to_neutral: 'Feeding from opponent alliance zone into neutral zone',
  feed_opponent_to_alliance: 'Feeding from opponent alliance zone into alliance zone',
  defense: 'Defense',
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
    questionnaire: emptyPitQuestionnaire(),
    autoRoutines: [{
      id: 'auto-1',
      description: '',
      startPosition: null,
      path: null,
      underTrench: null,
      overBump: null,
      estimatedPoints: null,
    }],
    photos: [],
    photoPath: null,
    notes: '',
    scoutId: p.scoutId,
  };
}

function reportFromCachedPit(pit: TeamPit, props: PitScoutScreenProps): PitReport {
  const questionnaire = normalizePitQuestionnaire(pit.questionnaire);
  if (!questionnaire.additionalComments && pit.notes) questionnaire.additionalComments = pit.notes;
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
    questionnaire,
    autoRoutines: normalizeAutoRoutines(
      pit.autoRoutines,
      pit.preferredAutoStartPosition,
      pit.preferredAutoPath,
    ),
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
  { title: 'Robot basics', icon: Gauge },
  { title: 'Shooter', icon: Swords },
  { title: 'Capabilities', icon: ListChecks },
  { title: 'Autonomous routines', icon: Route },
  { title: 'Robot status', icon: Eye },
  { title: 'Photos & comments', icon: StickyNote },
];
const LAST_STEP = STEPS.length - 1;
const PIT_AUTO_VISIBLE_X_RANGE = [0.25, 1] as const;

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
  const [activeAutoId, setActiveAutoId] = React.useState<string | null>(null);
  const [autoDrawingOpen, setAutoDrawingOpen] = React.useState(false);
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
  const autoDrawingTriggerRef = React.useRef<HTMLButtonElement>(null);
  const autoDrawingCloseRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!autoDrawingOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => autoDrawingCloseRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAutoDrawingOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
      autoDrawingTriggerRef.current?.focus();
    };
  }, [autoDrawingOpen]);

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
      const localBase = local?.syncState === 'synced'
        ? Math.max(local.baseRevision ?? 0, local.rowRevision ?? 0) || null
        : local?.baseRevision ?? null;
      let loadedRevision = preserveLocal
        ? Math.max(draft?.baseRevision ?? 0, localBase ?? 0) || null
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

      const questionnaire = normalizePitQuestionnaire(loadedReport.questionnaire);
      if (!questionnaire.additionalComments && loadedReport.notes) {
        questionnaire.additionalComments = loadedReport.notes;
      }
      const next = {
        ...emptyReport(props),
        ...loadedReport,
        questionnaire,
        autoRoutines: normalizeAutoRoutines(
          loadedReport.autoRoutines,
          loadedReport.preferredAutoStartPosition,
          loadedReport.preferredAutoPath,
        ),
        photos: loadedReport.photos ?? [],
        scoutId: props.scoutId,
        eventKey: props.eventKey,
        teamNumber: props.teamNumber,
      };
      setReport(next);
      setActiveAutoId(next.autoRoutines[0]?.id ?? null);
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
    const questionnaire = normalizePitQuestionnaire(conflictCopy.report.questionnaire);
    if (!questionnaire.additionalComments && conflictCopy.report.notes) {
      questionnaire.additionalComments = conflictCopy.report.notes;
    }
    const recovered = {
      ...emptyReport(props),
      ...conflictCopy.report,
      eventKey: props.eventKey,
      teamNumber: props.teamNumber,
      scoutId: props.scoutId,
      photos: conflictCopy.report.photos ?? [],
      questionnaire,
      autoRoutines: normalizeAutoRoutines(
        conflictCopy.report.autoRoutines,
        conflictCopy.report.preferredAutoStartPosition,
        conflictCopy.report.preferredAutoPath,
      ),
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

  function updateQuestionnaire(patch: Partial<ReturnType<typeof emptyPitQuestionnaire>>): void {
    update({
      questionnaire: {
        ...normalizePitQuestionnaire(reportRef.current.questionnaire),
        ...patch,
      },
    });
  }

  function addAuto(): void {
    const routine: PitAutoRoutine = {
      id: crypto.randomUUID(),
      description: '',
      startPosition: null,
      path: null,
      underTrench: null,
      overBump: null,
      estimatedPoints: null,
    };
    update({ autoRoutines: [...(reportRef.current.autoRoutines ?? []), routine] });
    setActiveAutoId(routine.id);
    setAutoMode('pick-start');
  }

  function updateAuto(id: string, patch: Partial<PitAutoRoutine>): void {
    update({
      autoRoutines: (reportRef.current.autoRoutines ?? []).map((routine) =>
        routine.id === id ? { ...routine, ...patch } : routine
      ),
    });
  }

  function removeAuto(id: string): void {
    const routines = (reportRef.current.autoRoutines ?? []).filter((routine) => routine.id !== id);
    update({ autoRoutines: routines });
    setActiveAutoId(routines[0]?.id ?? null);
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
  const questionnaire = normalizePitQuestionnaire(report.questionnaire);
  const autoRoutines = report.autoRoutines ?? [];
  const activeAuto = autoRoutines.find((routine) => routine.id === activeAutoId) ?? autoRoutines[0];

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
        <label className="flex items-center gap-3 text-sm text-muted-foreground">
          Section
          <select aria-label="Pit section" value={step} className="h-12 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base text-foreground"
            onChange={(e) => {
              const destination = Number(e.target.value);
              setStep(destination);
            }}>
            {STEPS.map((item, i) => <option key={item.title} value={i}>{i + 1}. {item.title}</option>)}
          </select>
        </label>
      </div>

      {/* Step 1 — Robot basics */}
      <Panel active={step === 0}>
        <div className="grid gap-4 lg:grid-cols-2">
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
            {report.drivetrain === 'swerve' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-swerve-type" className="text-sm text-muted-foreground">
                  What type of swerve?
                </Label>
                <Input
                  id="pit-swerve-type"
                  data-testid="pit-swerve-type"
                  className="h-14 text-base"
                  placeholder="e.g. SDS MK4i L2"
                  value={questionnaire.swerveType}
                  onChange={(event) => updateQuestionnaire({ swerveType: event.target.value })}
                />
              </div>
            ) : null}
          </Group>

          <Group icon={Ruler} title="Robot size">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([
                ['length', 'Length (inches)', report.robotLengthIn],
                ['width', 'Width (inches)', report.robotWidthIn],
                ['height', 'Height (inches)', report.robotHeightIn],
              ] as const).map(([field, label, value]) => (
                <div key={field} className="flex flex-col gap-1.5">
                  <Label htmlFor={`pit-${field}`} className="text-sm text-muted-foreground">{label}</Label>
                  <Input
                    id={`pit-${field}`}
                    data-testid={`pit-${field}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={PIT_NUMERIC_LIMITS.dimensionIn}
                    className="h-14 text-base"
                    value={value ?? ''}
                    onChange={(event) => {
                      const number = parsePitNumber(event.target.value, PIT_NUMERIC_LIMITS.dimensionIn);
                      update({ [`robot${field[0].toUpperCase()}${field.slice(1)}In`]: number });
                      props.onAction?.(field);
                    }}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-weight" className="text-sm text-muted-foreground">
                  Weight without battery and bumpers (lb)
                </Label>
                <Input
                  id="pit-weight"
                  data-testid="pit-weight"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={PIT_NUMERIC_LIMITS.robotWeightLb}
                  className="h-14 text-base"
                  value={questionnaire.robotWeightLb ?? ''}
                  onChange={(event) => updateQuestionnaire({
                    robotWeightLb: parsePitNumber(event.target.value, PIT_NUMERIC_LIMITS.robotWeightLb),
                  })}
                />
              </div>
            </div>
            <label className={optionChip(report.trenchCapable, 'success')}>
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
              Can they go under the trench?
            </label>
          </Group>
        </div>
      </Panel>

      {/* Step 2 — Shooter */}
      <Panel active={step === 1}>
        <div className="grid gap-4 md:grid-cols-2">
          <Group icon={Swords} title="Shooter type">
            <div data-testid="pit-shooter-type" className="flex flex-col gap-2">
              {SHOOTER_TYPES.map((option) => {
                const active = questionnaire.shooterType === option;
                return (
                  <label key={option} className={optionChip(active, 'brand')}>
                    <input
                      type="radio"
                      name="pit-shooter-type"
                      className={cn('size-6', TONE_ACCENT.brand)}
                      checked={active}
                      onChange={() => {
                        updateQuestionnaire({ shooterType: option });
                        props.onAction?.('shooter');
                      }}
                    />
                    {labelFor(option)}
                  </label>
                );
              })}
            </div>
            {questionnaire.shooterType === 'other' ? (
              <Input
                data-testid="pit-shooter-other"
                className="h-14 text-base"
                aria-label="Other shooter type"
                placeholder="Describe the shooter"
                value={questionnaire.shooterTypeOther}
                onChange={(event) => updateQuestionnaire({ shooterTypeOther: event.target.value })}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Is the shooter at a fixed angle?</p>
              <label className={optionChip(questionnaire.shooterFixedAngle === 'no', 'brand')}>
                <input
                  type="radio"
                  name="pit-fixed-angle"
                  checked={questionnaire.shooterFixedAngle === 'no'}
                  onChange={() => updateQuestionnaire({ shooterFixedAngle: 'no' })}
                  className={cn('size-6', TONE_ACCENT.brand)}
                />
                No
              </label>
              <Input
                data-testid="pit-fixed-angle"
                className="h-14 text-base"
                aria-label="Fixed shooter angle"
                placeholder="Yes — enter approximate angle"
                value={questionnaire.shooterFixedAngle === 'no' ? '' : questionnaire.shooterFixedAngle}
                onChange={(event) => updateQuestionnaire({ shooterFixedAngle: event.target.value })}
              />
            </div>
          </Group>

          <Group icon={Sparkles} title="Scoring performance" tone="text-energy">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-balls-per-second">Estimated balls per second</Label>
                <Input
                  id="pit-balls-per-second"
                  data-testid="pit-balls-per-second"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={PIT_NUMERIC_LIMITS.ballsPerSecond}
                  className="h-14 text-base"
                  value={questionnaire.estimatedBallsPerSecond ?? ''}
                  onChange={(event) => updateQuestionnaire({
                    estimatedBallsPerSecond: parsePitNumber(event.target.value, PIT_NUMERIC_LIMITS.ballsPerSecond),
                  })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-ball-capacity">Estimated ball storage capacity</Label>
                <Input
                  id="pit-ball-capacity"
                  data-testid="pit-ball-capacity"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={PIT_NUMERIC_LIMITS.ballCapacity}
                  className="h-14 text-base"
                  value={questionnaire.estimatedBallCapacity ?? ''}
                  onChange={(event) => updateQuestionnaire({
                    estimatedBallCapacity: parsePitNumber(event.target.value, PIT_NUMERIC_LIMITS.ballCapacity),
                  })}
                />
              </div>
            </div>
            <p className="text-sm font-medium">Where can they shoot from?</p>
            <div data-testid="pit-shooting-range" className="flex flex-col gap-2">
              {SHOOTING_RANGES.map((option) => {
                const active = questionnaire.shootingRange === option;
                return (
                  <label key={option} className={optionChip(active, 'energy')}>
                    <input
                      type="radio"
                      name="pit-shooting-range"
                      className={cn('size-6', TONE_ACCENT.energy)}
                      checked={active}
                      onChange={() => {
                        updateQuestionnaire({ shootingRange: option });
                        props.onAction?.('shooter');
                      }}
                    />
                    {labelFor(option)}
                  </label>
                );
              })}
            </div>
            {questionnaire.shootingRange === 'other' ? (
              <Input
                data-testid="pit-shooting-range-other"
                className="h-14 text-base"
                aria-label="Other shooting range"
                placeholder="Describe where they can shoot from"
                value={questionnaire.shootingRangeOther}
                onChange={(event) => updateQuestionnaire({ shootingRangeOther: event.target.value })}
              />
            ) : null}
          </Group>
        </div>
      </Panel>

      {/* Step 3 — General capabilities */}
      <Panel active={step === 2}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Group icon={ListChecks} title="Intake & total capabilities" tone="text-success">
            <p className="text-sm font-medium">Where can they intake from?</p>
            <div data-testid="pit-intake-sources" className="flex flex-col gap-2">
              {INTAKE_OPTIONS.map((option) => {
                const active = questionnaire.intakeLocations.includes(option);
                return (
                  <label key={option} className={optionChip(active, 'energy')}>
                    <input
                      type="checkbox"
                      className={cn('size-6', TONE_ACCENT.energy)}
                      checked={active}
                      onChange={() => {
                        updateQuestionnaire({
                          intakeLocations: toggle(questionnaire.intakeLocations, option),
                        });
                        props.onAction?.('intake_source');
                      }}
                    />
                    {labelFor(option)}
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-sm font-medium">Total robot capabilities</p>
            <div data-testid="pit-capabilities" className="flex flex-col gap-2">
              {ROBOT_CAPABILITIES.map((option) => {
                const active = questionnaire.totalCapabilities.includes(option);
                return (
                  <label key={option} className={optionChip(active, option === 'defense' ? 'brand' : 'success')}>
                    <input
                      type="checkbox"
                      checked={active}
                      className={cn('size-6', TONE_ACCENT[option === 'defense' ? 'brand' : 'success'])}
                      onChange={() => {
                        updateQuestionnaire({
                          totalCapabilities: toggle(questionnaire.totalCapabilities, option),
                        });
                        props.onAction?.('capability');
                      }}
                    />
                    {labelFor(option)}
                  </label>
                );
              })}
            </div>
            {questionnaire.totalCapabilities.includes('other') ? (
              <Input
                data-testid="pit-capability-other"
                className="h-14 text-base"
                aria-label="Other robot capability"
                placeholder="Describe other capability"
                value={questionnaire.capabilityOther}
                onChange={(event) => updateQuestionnaire({ capabilityOther: event.target.value })}
              />
            ) : null}
          </Group>

          <Group icon={Gauge} title="Accuracy & cleanup">
            {([
              ['generalAccuracy', 'General scoring accuracy'],
              ['shootOnMoveAccuracy', 'Scoring accuracy while shooting on the move'],
            ] as const).map(([field, title]) => (
              <div key={field} className="flex flex-col gap-2">
                <p className="text-sm font-medium">{title}</p>
                {ACCURACY_OPTIONS.map((option) => (
                  <label key={option} className={optionChip(questionnaire[field] === option, 'brand')}>
                    <input
                      type="radio"
                      name={`pit-${field}`}
                      checked={questionnaire[field] === option}
                      className={cn('size-6', TONE_ACCENT.brand)}
                      onChange={() => {
                        updateQuestionnaire({ [field]: option });
                        props.onAction?.('accuracy');
                      }}
                    />
                    {option === 'not_capable'
                      ? field === 'generalAccuracy'
                        ? 'Not capable of scoring :('
                        : 'Not capable of SOTM'
                      : labelFor(option)}
                  </label>
                ))}
              </div>
            ))}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Can they intake while shooting? (Cleanup)</p>
              {[
                ['yes', 'Yes'],
                ['no', 'No'],
                ['not_tested', 'Not sure / not tested'],
              ].map(([value, label]) => (
                <label key={value} className={optionChip(questionnaire.intakeWhileShooting === value, 'energy')}>
                  <input
                    type="radio"
                    name="pit-intake-while-shooting"
                    checked={questionnaire.intakeWhileShooting === value}
                    className={cn('size-6', TONE_ACCENT.energy)}
                    onChange={() => updateQuestionnaire({ intakeWhileShooting: value })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </Group>
        </div>
      </Panel>

      {/* Step 4 — Autonomous routines */}
      <Panel active={step === 3}>
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            {autoRoutines.map((routine, index) => (
              <Button
                key={routine.id}
                type="button"
                variant={activeAuto?.id === routine.id ? 'brand' : 'outline'}
                size="sm"
                onClick={() => setActiveAutoId(routine.id)}
              >
                Auto {index + 1}
              </Button>
            ))}
            <Button
              type="button"
              data-testid="pit-auto-add"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={autoRoutines.length >= 12}
              onClick={addAuto}
            >
              <Plus className="size-4" /> Add auto
            </Button>
          </div>
          {!activeAuto ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Add an auto to draw and describe each routine separately.
            </div>
          ) : (
            <div className="flex flex-col gap-4" data-testid="pit-auto-editor">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  Auto {autoRoutines.findIndex((routine) => routine.id === activeAuto.id) + 1}
                </h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeAuto(activeAuto.id)}>
                  <Trash2 className="mr-1.5 size-4" /> Remove
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pit-auto-description">Describe this auto and its consistency</Label>
                <textarea
                  id="pit-auto-description"
                  data-testid="pit-auto-description"
                  className="min-h-28 w-full rounded-xl border border-input bg-transparent p-3 text-base"
                  placeholder="Starting position, balls scored, pickups, route, and consistency…"
                  value={activeAuto.description}
                  onChange={(event) => updateAuto(activeAuto.id, { description: event.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pit-auto-points">Estimated points scored in auto</Label>
                  <Input
                    id="pit-auto-points"
                    data-testid="pit-auto-points"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={PIT_NUMERIC_LIMITS.autoPoints}
                    className="h-14 text-base"
                    value={activeAuto.estimatedPoints ?? ''}
                    onChange={(event) => updateAuto(activeAuto.id, {
                      estimatedPoints: parsePitNumber(event.target.value, PIT_NUMERIC_LIMITS.autoPoints),
                    })}
                  />
                </div>
                {([
                  ['underTrench', 'Go under trench?'],
                  ['overBump', 'Go over bump?'],
                ] as const).map(([field, label]) => (
                  <div key={field} className="flex flex-col gap-1.5">
                    <Label htmlFor={`pit-auto-${field}`}>{label}</Label>
                    <select
                      id={`pit-auto-${field}`}
                      data-testid={`pit-auto-${field}`}
                      className="h-14 rounded-xl border border-input bg-transparent px-3 text-base text-foreground"
                      value={activeAuto[field] == null ? '' : activeAuto[field] ? 'yes' : 'no'}
                      onChange={(event) => updateAuto(activeAuto.id, {
                        [field]: event.target.value === '' ? null : event.target.value === 'yes',
                      })}
                    >
                      <option value="">Select…</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Label>Auto path</Label>
                <button
                  ref={autoDrawingTriggerRef}
                  type="button"
                  data-testid="pit-auto-open-drawing"
                  aria-haspopup="dialog"
                  className="group relative w-full overflow-hidden rounded-2xl border border-border bg-muted/30 text-left shadow-sm transition hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => {
                    setAutoDrawingOpen(true);
                    props.onAction?.('auto_open');
                  }}
                >
                  <div className="pointer-events-none">
                    <FieldDiagram
                      mode="view"
                      visibleXRange={PIT_AUTO_VISIBLE_X_RANGE}
                      startPosition={activeAuto.startPosition}
                      path={activeAuto.path}
                      data-testid="pit-auto-field-preview"
                    />
                  </div>
                  <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-background/90 px-3 py-2 text-sm font-semibold backdrop-blur-sm">
                    <span>{activeAuto.path?.length ? 'Edit this auto path' : 'Draw this auto path'}</span>
                    <span className="flex items-center gap-1.5 text-brand">
                      Open full screen <Maximize2 className="size-4" />
                    </span>
                  </span>
                </button>
                <p className="text-xs text-muted-foreground">
                  Shows the blue side through the neutral zone. The red scoring end is intentionally cropped out.
                </p>
              </div>

              {autoDrawingOpen ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="pit-auto-drawing-title"
                  data-testid="pit-auto-drawing-dialog"
                  className="fixed inset-0 z-[100] flex flex-col bg-background px-safe py-safe"
                >
                  <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">
                        Auto {autoRoutines.findIndex((routine) => routine.id === activeAuto.id) + 1}
                      </p>
                      <h2 id="pit-auto-drawing-title" className="truncate text-lg font-semibold">
                        Draw the blue-side route
                      </h2>
                    </div>
                    <Button
                      ref={autoDrawingCloseRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      onClick={() => setAutoDrawingOpen(false)}
                    >
                      Done <X className="size-4" />
                    </Button>
                  </header>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 sm:px-5">
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
                        updateAuto(activeAuto.id, { startPosition: null, path: null });
                        props.onAction?.('auto_clear');
                      }}
                    >
                      <Eraser className="size-4" /> Clear
                    </Button>
                    <p className="basis-full text-xs text-muted-foreground">
                      {autoMode === 'pick-start'
                        ? 'Tap where the robot starts.'
                        : 'Drag from the start through the full route.'}
                    </p>
                  </div>

                  <div
                    data-testid="pit-auto-field-shell"
                    className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-4"
                  >
                    <FieldDiagram
                      mode={autoMode}
                      rotate={isPhonePortrait}
                      fillHeight
                      visibleXRange={PIT_AUTO_VISIBLE_X_RANGE}
                      startPosition={activeAuto.startPosition}
                      path={activeAuto.path}
                      onStartChange={(point: FieldPoint) => {
                        updateAuto(activeAuto.id, { startPosition: point });
                        props.onAction?.('auto_start');
                      }}
                      onPathChange={(points: FieldPoint[]) => {
                        updateAuto(activeAuto.id, { path: points });
                        props.onAction?.('auto_path');
                      }}
                      data-testid="pit-auto-field"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </Panel>

      {/* Step 5 — Robot status */}
      <Panel active={step === 4}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Group icon={Eye} title="Vision & rebuild status">
            <Label htmlFor="pit-vision">What vision are they running, if any?</Label>
            <Input
              id="pit-vision"
              data-testid="pit-vision"
              className="h-14 text-base"
              placeholder="e.g. Limelight 3, PhotonVision, none"
              value={report.visionSystem}
              onChange={(event) => {
                update({ visionSystem: event.target.value });
                props.onAction?.('vision');
              }}
            />
            <p className="mt-2 text-sm font-medium">Did they rebuild since their last competition?</p>
            <label className={optionChip(questionnaire.rebuildChanges === 'no', 'brand')}>
              <input
                type="radio"
                name="pit-rebuild"
                checked={questionnaire.rebuildChanges === 'no'}
                className={cn('size-6', TONE_ACCENT.brand)}
                onChange={() => updateQuestionnaire({ rebuildChanges: 'no' })}
              />
              No
            </label>
            <Input
              data-testid="pit-rebuild-changes"
              className="h-14 text-base"
              aria-label="Rebuild changes"
              placeholder="Yes — describe the changes"
              value={questionnaire.rebuildChanges === 'no' ? '' : questionnaire.rebuildChanges}
              onChange={(event) => {
                updateQuestionnaire({ rebuildChanges: event.target.value });
                props.onAction?.('status');
              }}
            />
          </Group>
          <Group icon={Wrench} title="Concerns">
            <Label htmlFor="pit-concerns">Concerns (bent parts, reliability, etc.; enter N/A if none)</Label>
            <textarea
              id="pit-concerns"
              data-testid="pit-concerns"
              className="min-h-44 w-full rounded-xl border border-input bg-transparent p-3 text-base"
              value={questionnaire.concerns}
              onChange={(event) => updateQuestionnaire({ concerns: event.target.value })}
            />
          </Group>
        </div>
      </Panel>

      {/* Step 6 — Photos & comments */}
      <Panel active={step === 5}>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
          <Label htmlFor="pit-notes" className="text-sm text-muted-foreground">
            Additional comments (optional)
          </Label>
          <textarea
            id="pit-notes"
            data-testid="pit-notes"
            aria-label="Notes / additional comments"
            className="min-h-28 w-full rounded-xl border border-input bg-transparent p-3 text-base"
            placeholder="Anything else the strategy team should know…"
            value={questionnaire.additionalComments}
            onChange={(e) => {
              updateQuestionnaire({ additionalComments: e.target.value });
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
