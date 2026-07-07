import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  UserRound,
  LogOut,
  Search,
  Target,
  Wrench,
  Home,
  QrCode,
  ScanLine,
  FileDown,
  History,
  Crosshair,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import PitScoutFlow from '@/pit/PitScoutFlow';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useSession, clearCachedScout } from '@/auth/useSession';
import type { ScoutRow } from '@/auth/scoutRow';
import { listDrafts, listReports, getReport } from '@/db/localStore';
import type { CachedMatch, CaptureDraft, LocalMatchReport } from '@/db/types';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { exportUnsyncedToFile } from '@/export/exportReports';
import { SyncIndicator } from '@/sync/SyncIndicator';
import { InstallPrompt } from '@/pwa/InstallPrompt';
import { getStoredActiveEvent } from '@/dash/activeEventStore';
import { listRoster } from '@/roster/rosterClient';
import {
  selectScouter,
  forgetScouterName,
  isScouterLoggedOut,
  markScouterLoggedOut,
} from '@/roster/selectScouter';
import { UpcomingMatches, matchLabelFromKey } from '@/capture/UpcomingMatches';
import { getCachedAssignments, getCachedRoster, getCachedMatches, getCachedTeams } from '@/db/preloadClient';
import { OfflineReadyBadge } from '@/offline/OfflineReadyBadge';
import { cn } from '@/lib/utils';

interface AssignmentRow {
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

/**
 * Normalize a free-text manual match entry into the CANONICAL `<eventKey>_qm<n>`
 * key the `match` table is keyed on. The Manual-pick field is forgiving — a scout
 * may type a bare number ("10"), a level-prefixed token ("qm10" / "q10"), or paste
 * a full key ("2026txhou1_qm10"). Without this, "10" was stored verbatim as the
 * match_key and the `match_scouting_report.match_key → match` FK rejected it on
 * sync, dead-lettering the report permanently (BUG-1 data loss).
 *
 * Manual quals only: a bare number / "q"/"qm" token always maps to a QUAL key.
 * A pasted full key (contains "_") is trusted as-is (lets a scout enter a playoff
 * match explicitly). Returns '' when nothing parseable was entered.
 */
export function normalizeManualMatchKey(raw: string, eventKey: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // A full key already carries its event code + level — trust it verbatim.
  if (trimmed.includes('_')) return trimmed;
  // Strip a leading level token ("q"/"qm") then take the trailing number.
  const m = trimmed.match(/^(?:qm|q)?\s*0*(\d+)$/i);
  if (!m) return '';
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return '';
  return eventKey ? `${eventKey}_qm${n}` : `qm${n}`;
}

/**
 * Which slot (alliance + station) a team occupies in a match row's lineup.
 * The manual pick derives alliance/station from this instead of asking the
 * scout — they only ever needed to be typed because the form predates the
 * offline schedule cache. Returns null when the row is unknown or the team
 * isn't in it (playoff rows may carry null slots until alliances are set).
 * Pure + exported for tests.
 */
export function deriveSlotForTeam(
  m:
    | Pick<CachedMatch, 'red1' | 'red2' | 'red3' | 'blue1' | 'blue2' | 'blue3'>
    | undefined,
  team: number,
): { alliance: 'red' | 'blue'; station: 1 | 2 | 3 } | null {
  if (!m || !Number.isFinite(team) || team <= 0) return null;
  const r = [m.red1, m.red2, m.red3].indexOf(team);
  if (r !== -1) return { alliance: 'red', station: (r + 1) as 1 | 2 | 3 };
  const b = [m.blue1, m.blue2, m.blue3].indexOf(team);
  if (b !== -1) return { alliance: 'blue', station: (b + 1) as 1 | 2 | 3 };
  return null;
}

// A readable label for a saved draft (e.g. "Qualification 9 · Team 111") instead
// of the raw "matchKey:scoutId:team" draft key.
function draftTitle(d: CaptureDraft): string {
  const target = (d.state as { target?: CaptureTarget } | null)?.target;
  const matchKey = target?.matchKey ?? d.draftKey.split(':')[0];
  const teamNum = target?.targetTeamNumber ?? Number(d.draftKey.split(':')[2]);
  const label = matchLabelFromKey(matchKey);
  return Number.isFinite(teamNum) && teamNum ? `${label} · Team ${teamNum}` : label;
}

function CaptureFlow(props: {
  target: CaptureTarget;
  onDone: () => void;
  onExit: () => void;
  // Edit mode opens straight on Review (the live fuel timeline can't be re-run
  // after the match). Default 'live' for a fresh capture.
  startStage?: 'live' | 'review';
  // Loaded revision of the report being corrected — drives the Review edit banner.
  editingRevision?: number;
}) {
  const session = useCaptureSession(props.target);
  const [stage, setStage] = useState<'live' | 'review'>(props.startStage ?? 'live');
  if (stage === 'review') {
    return (
      <ReviewScreen
        session={session}
        onSaved={() => props.onDone()}
        onExit={props.onExit}
        editingRevision={props.editingRevision}
      />
    );
  }
  return (
    <CaptureScreen
      session={session}
      onToReview={() => setStage('review')}
      onExit={props.onExit}
    />
  );
}

// Login-less identity: pick your name from the team roster. Tapping a name binds
// this device (anonymous auth.uid) to a per-event scout row via select_scouter.
function NamePicker(props: { eventKey: string; onPicked: (s: ScoutRow) => void }) {
  // Only id/name are used here; both the live roster (RosterScouter, which also
  // carries `hidden`) and the offline cache (CachedRosterScouter) satisfy this.
  // listRoster() already excludes hidden scouters, so the picker never offers one.
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listRoster();
        if (cancelled) return;
        if (rows.length) {
          setRoster(rows);
          return;
        }
        // Network returned an empty roster — try the offline cache before giving up.
        const cached = await getCachedRoster();
        if (!cancelled) setRoster(cached);
      } catch (err) {
        // Network failed (likely offline): fall back to whatever was downloaded.
        const cached = await getCachedRoster();
        if (cancelled) return;
        if (cached.length) {
          setRoster(cached);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load roster.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = roster.filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const pick = async (name: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await selectScouter(props.eventKey, name);
      props.onPicked(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select scouter.');
      setBusy(false);
    }
  };

  return (
    <section data-testid="scout-name-picker" className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">Who are you?</h2>
        <p className="text-sm text-muted-foreground">
          Select your name to start scouting event <span className="font-mono">{props.eventKey}</span>.
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="scout-name-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Type to find your name"
          className="h-14 rounded-xl pl-12 text-lg"
          autoComplete="off"
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ul className="grid grid-cols-2 gap-2 landscape:grid-cols-3">
        {filtered.map((r) => (
          <li key={r.id}>
            <Button
              data-testid={`scout-name-option-${r.name}`}
              size="big"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void pick(r.name)}
            >
              {r.name}
            </Button>
          </li>
        ))}
        {roster.length === 0 && !error && (
          <li className="col-span-full text-sm text-muted-foreground">
            No scouters on the roster yet — ask your lead to add names.
          </li>
        )}
      </ul>
    </section>
  );
}

type ScoutMode = 'match' | 'pit';

export default function ScoutHome() {
  const { scout } = useSession();
  const navigate = useNavigate();
  // Match/Pit switch. Deep-linkable via ?mode=pit; the toggle keeps it in the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: ScoutMode = searchParams.get('mode') === 'pit' ? 'pit' : 'match';
  const setMode = (next: ScoutMode) => {
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === 'pit') sp.set('mode', 'pit');
        else sp.delete('mode');
        return sp;
      },
      { replace: true },
    );
  };
  const [picked, setPicked] = useState<ScoutRow | null>(null);
  // Logout override: when true, force the NamePicker to show regardless of what
  // useSession resolves (the device's anonymous auth.uid stays bound to a scout
  // row until a new name is picked, so `scout` is still truthy on reload). Seeded
  // from a DURABLE flag so logging out survives reloads/remounts — otherwise the
  // old profile resurrected from cache and the user got "stuck in a profile".
  const [loggedOut, setLoggedOut] = useState<boolean>(() => isScouterLoggedOut());
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Resolve the active event without React Query (keeps this screen provider-free).
  const [activeEvent, setActiveEvent] = useState<string | null>(getStoredActiveEvent());
  useEffect(() => {
    if (activeEvent) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('event')
        .select('event_key')
        .eq('is_active', true);
      const key = (data as { event_key: string }[] | null)?.[0]?.event_key ?? null;
      if (!cancelled) setActiveEvent(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEvent]);

  // A fresh pick on THIS device wins over the session-resolved row: re-picking
  // after logout updates the same auth_uid's scout row, but useSession may still
  // hold the stale name until it refetches — `picked` reflects the new choice now.
  const candidate = loggedOut ? null : picked ?? scout;
  // Event-scope the gate. useSession caches the last scout row in NON-event-scoped
  // storage, so after a lead switches the active event a stale row would otherwise
  // short-circuit the NamePicker and silently bind captures/pit reports to the OLD
  // event_key. Once the active event is known, force a re-pick when the cached row
  // belongs to a different event. (Guarded on activeEvent so there's no flash
  // before it resolves; a fresh `picked` always reflects the current event.)
  const effective =
    candidate && activeEvent && candidate.event_key !== activeEvent ? null : candidate;
  const scoutId = effective?.id ?? '';

  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [reports, setReports] = useState<LocalMatchReport[]>([]);
  const [active, setActive] = useState<CaptureTarget | null>(null);
  // Loaded revision of the report being corrected (drives the Review edit banner).
  const [editingRev, setEditingRev] = useState<number | undefined>(undefined);

  const [matchKey, setMatchKey] = useState('');
  const [alliance, setAlliance] = useState<'red' | 'blue'>('red');
  const [station, setStation] = useState<1 | 2 | 3>(1);
  const [team, setTeam] = useState('');
  // Manual-pick validation: a warning shown when the typed match/team don't match
  // the loaded event schedule/roster (a bad manual entry dead-letters on the FK).
  const [manualWarning, setManualWarning] = useState<string | null>(null);
  // When correcting a DEAD-LETTERED report whose match/team is wrong, the manual
  // pick re-saves IN PLACE under this id (instead of creating a new report). Set by
  // the edit deep-link for an 'error' report; cleared once the capture starts.
  const [fixingReportId, setFixingReportId] = useState<string | null>(null);

  // Loaded event schedule + team list (from the offline preload cache) used to
  // validate a manual pick before it can dead-letter on the match/team FK (BUG-1)
  // AND to derive the alliance/station from the typed match + team (the lineup
  // already knows the slot, so the scout shouldn't have to). Best-effort: when
  // the cache is empty (never preloaded) validation is skipped, the normalized
  // key is trusted, and the alliance/station fallback selects appear — so a
  // fully-offline fresh device still works.
  const [knownMatches, setKnownMatches] = useState<Map<string, CachedMatch>>(new Map());
  const [knownTeams, setKnownTeams] = useState<Set<number>>(new Set());

  const refreshLocal = async () => {
    setDrafts(await listDrafts());
    setReports(await listReports());
  };

  // Assignments this scout already has a saved report for, keyed by match+team, so
  // UpcomingMatches can move them out of the "to scout" feed into "Completed".
  const completedKeys = new Set(
    reports.map((r) => `${r.matchKey}:${r.targetTeamNumber}`),
  );

  useEffect(() => {
    if (!scoutId) return;
    const name = effective?.display_name ?? '';
    const ev = effective?.event_key || activeEvent || '';
    let cancelled = false;
    void (async () => {
      // Local-first: show cached assignments immediately so an offline reload
      // still surfaces the schedule (CachedAssignment carries an extra `id`
      // field on top of AssignmentRow — the rest of the shape matches).
      const cached = await getCachedAssignments(scoutId);
      if (!cancelled && cached.length) {
        setAssignments(cached as AssignmentRow[]);
      }
      // Then refresh from the network. Offline this throws, so guard the whole
      // block and keep the cached assignments already set.
      try {
        let res = await supabase.from('assignment').select('*').eq('scout_id', scoutId);
        // No assignments under this device's row — auto-generated assignments are
        // published against roster-seeded duplicate scout rows. select_scouter
        // (migration 0014) consolidates those onto this device's row; re-query after.
        if (!cancelled && res.data && res.data.length === 0 && name && ev) {
          try {
            await selectScouter(ev, name);
            if (!cancelled) {
              res = await supabase.from('assignment').select('*').eq('scout_id', scoutId);
            }
          } catch {
            /* non-fatal: keep whatever the first query returned */
          }
        }
        if (!cancelled && res.data) {
          setAssignments(res.data as AssignmentRow[]);
        }
      } catch {
        /* offline / network failure: keep the cached assignments set above */
      }
    })();
    void refreshLocal();
    return () => {
      cancelled = true;
    };
  }, [scoutId, effective?.display_name, effective?.event_key, activeEvent]);

  // Load the cached event schedule + team list so a manual pick can be validated
  // against them before it's allowed to start (and thus before it can dead-letter
  // on the match/team FK). Keyed on the active event; best-effort + offline-safe.
  const validationEventKey = activeEvent || effective?.event_key || '';
  useEffect(() => {
    if (!validationEventKey) return;
    let cancelled = false;
    void (async () => {
      const [matches, teams] = await Promise.all([
        getCachedMatches(validationEventKey),
        getCachedTeams(validationEventKey),
      ]);
      if (cancelled) return;
      setKnownMatches(new Map(matches.map((m) => [m.match_key, m])));
      setKnownTeams(new Set(teams.map((t) => t.team_number)));
    })();
    return () => {
      cancelled = true;
    };
  }, [validationEventKey]);

  // Report-correction deep link: /scout?edit=<reportId>. Gated on the scouter
  // gate being satisfied (so the param is preserved until a name is picked). Loads
  // the report and reconstructs a CaptureTarget from its own fields with
  // editingReportId set, forces match mode, and clears the edit param so a
  // reload/back doesn't re-trigger. DEAD-LETTERED ('error') reports are editable
  // too: correcting the bad match/team that caused the FK dead-letter (BUG-1) is
  // the recovery path — re-saving re-validates and clears the error (BUG-4). No
  // `deleted` check — the local row has no `deleted` field (see
  // docs/plans/report-correction.md §1).
  const editId = searchParams.get('edit');
  useEffect(() => {
    if (!effective || !editId) return;
    let cancelled = false;
    void (async () => {
      const r = await getReport(editId);
      if (cancelled) return;
      // Always clear the param (whether eligible or not) so it doesn't re-fire.
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          sp.delete('edit');
          sp.delete('mode'); // force match mode for the correction
          return sp;
        },
        { replace: true },
      );
      if (!r) return; // not found: fall through
      setEditingRev(r.rowRevision ?? 1);
      if (r.syncState === 'error') {
        // A dead-lettered report is most likely stuck on a bad match/team FK
        // (BUG-1). The capture/review flow can't change the target match/team, so
        // route the correction through the manual-pick form pre-filled with the
        // report's values; "Start capture" then re-normalizes + re-validates them
        // (BUG-1) and re-saves IN PLACE under this id (BUG-4).
        setFixingReportId(r.id);
        setMatchKey(r.matchKey);
        setAlliance(r.allianceColor);
        setStation(r.station);
        setTeam(String(r.targetTeamNumber));
        setManualWarning('This report failed to sync — fix the match/team below, then Start to re-save.');
        return;
      }
      setActive({
        eventKey: r.eventKey,
        matchKey: r.matchKey,
        scoutId: r.scoutId,
        scoutName: r.scoutName,
        targetTeamNumber: r.targetTeamNumber,
        allianceColor: r.allianceColor,
        station: r.station,
        editingReportId: r.id,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [effective, editId, setSearchParams]);

  // Gate: no scouter selected yet on this device → pick a name (or wait for an event).
  if (!effective) {
    return (
      <div
        data-testid="scout-home"
        className="flex min-h-dvh flex-col bg-background text-foreground"
      >
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-safe pt-safe pb-3 backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
                <UserRound className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="eyebrow">3256 Scouting</p>
                <h1 className="truncate text-xl font-bold leading-tight">Scout</h1>
              </div>
            </div>
            <Link
              data-testid="nav-home"
              to="/"
              aria-label="Home"
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-accent"
            >
              <Home className="size-5 shrink-0" />
              <span className="hidden sm:inline">Home</span>
            </Link>
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-5 px-safe pb-safe pt-4">
          <div className="flex items-center rounded-xl border border-border bg-card/40 py-1 pl-3 pr-1.5">
            <SyncIndicator className="min-w-0 flex-1 flex-nowrap" detailsHref="/sync" compact />
          </div>
          <InstallPrompt />
          {!activeEvent ? (
            <p data-testid="scout-no-event" className="text-muted-foreground">
              No active event yet. Ask your scouting lead to set the active event.
            </p>
          ) : (
            <NamePicker
              eventKey={activeEvent}
              onPicked={(s) => {
                setPicked(s);
                setLoggedOut(false);
                setConfirmLogout(false);
              }}
            />
          )}
        </main>
      </div>
    );
  }

  // Match capture takes over the whole screen; it's only reachable in match mode.
  if (active && mode === 'match') {
    const isEdit = Boolean(active.editingReportId);
    // Navigation is owned ENTIRELY by ScoutHome (CaptureFlow has no router access):
    // an edit save re-uploads an existing report, so jump to My Data with the
    // updated flag; a fresh capture/exit clears the active target in place.
    const leaveEdit = () => {
      setActive(null);
      setEditingRev(undefined);
      navigate('/my-data?updated=1');
    };
    const leaveFresh = () => {
      setActive(null);
      void refreshLocal();
    };
    return (
      <CaptureFlow
        target={active}
        startStage={isEdit ? 'review' : 'live'}
        editingRevision={isEdit ? editingRev : undefined}
        onDone={isEdit ? leaveEdit : leaveFresh}
        onExit={isEdit ? () => {
          setActive(null);
          setEditingRev(undefined);
          navigate('/my-data');
        } : leaveFresh}
      />
    );
  }

  // Prefer the ACTIVE event over the (possibly stale) cached row's event so a
  // capture can never bind to a previous event. `effective` is non-null here.
  const eventKey = activeEvent || effective.event_key || '';

  const startFromAssignment = (a: AssignmentRow) => {
    setActive({
      eventKey: a.event_key,
      matchKey: a.match_key,
      scoutId,
      scoutName: effective.display_name,
      targetTeamNumber: a.target_team_number,
      allianceColor: a.alliance_color,
      station: a.station,
    });
  };

  // Live slot derivation for the manual-pick UI: when the typed match + team
  // resolve to a schedule slot, the alliance/station selects are replaced by a
  // confirmation chip. They only appear as a fallback once both fields are
  // filled but underivable (offline with no cache, unknown match, TBD lineup).
  const manualSlot = deriveSlotForTeam(
    knownMatches.get(normalizeManualMatchKey(matchKey, eventKey)),
    Number(team),
  );
  const showSlotFields = !manualSlot && matchKey.trim() !== '' && team.trim() !== '';

  const startManual = () => {
    // Normalize the free-text match field into the canonical `<eventKey>_qm<n>`
    // key so the report never dead-letters on the match FK (BUG-1).
    const normalizedKey = normalizeManualMatchKey(matchKey, eventKey);
    const targetTeam = Number(team);
    if (!normalizedKey) {
      setManualWarning('Enter a match number (e.g. 10, qm10) — couldn’t read that.');
      return;
    }
    // Validate against the loaded schedule/roster when we HAVE them. An empty cache
    // (never preloaded / fully offline fresh device) means we can't validate — trust
    // the normalized key rather than block a legitimate offline capture.
    const row = knownMatches.get(normalizedKey);
    if (knownMatches.size > 0 && !row) {
      setManualWarning(
        `Match ${matchLabelFromKey(normalizedKey)} isn’t in this event’s schedule — check the number.`,
      );
      return;
    }
    if (knownTeams.size > 0 && (!Number.isFinite(targetTeam) || !knownTeams.has(targetTeam))) {
      setManualWarning(`Team ${team || '—'} isn’t in this event — check the number.`);
      return;
    }
    // Alliance/station come from the schedule lineup, not the scout. When the
    // lineup is fully known and the team isn't in it, the match/team pair is a
    // typo — block it (same philosophy as the FK guards above). A partially
    // known lineup (playoff TBD slots) falls back to the manual selects.
    const slot = deriveSlotForTeam(row, targetTeam);
    const lineupComplete =
      row != null &&
      [row.red1, row.red2, row.red3, row.blue1, row.blue2, row.blue3].every((t) => t != null);
    if (!slot && lineupComplete) {
      setManualWarning(
        `Team ${team || '—'} isn’t playing in ${matchLabelFromKey(normalizedKey)} — check the numbers.`,
      );
      return;
    }
    setManualWarning(null);
    setActive({
      eventKey,
      matchKey: normalizedKey,
      scoutId,
      scoutName: effective.display_name,
      targetTeamNumber: targetTeam,
      allianceColor: slot?.alliance ?? alliance,
      station: slot?.station ?? station,
      // Correcting a dead-lettered report → re-save in place under its id (the
      // session reconstitutes its data and bumps the revision). A normal manual
      // pick leaves this undefined and creates a fresh report.
      ...(fixingReportId ? { editingReportId: fixingReportId } : {}),
    });
    setFixingReportId(null);
  };

  const onExport = async () => {
    const desc = await exportUnsyncedToFile();
    const a = document.createElement('a');
    a.href = desc.blobUrl;
    a.download = desc.filename;
    a.click();
    URL.revokeObjectURL(desc.blobUrl);
  };

  const logOut = () => {
    forgetScouterName();
    // Persist the logout so it survives a reload/remount: the device's anonymous
    // auth.uid stays bound to the old scout row (useSession would re-resolve it
    // on a fresh mount) AND `loggedOut` is plain React state that resets on every
    // remount — together those resurrected the old profile, leaving the user
    // "stuck in a certain profile". The durable flag (read back into `loggedOut`'s
    // initial state) keeps the picker up until a new name is picked, and clearing
    // the cached scout row stops it being seeded back before the flag is honored.
    markScouterLoggedOut();
    clearCachedScout();
    setPicked(null);
    setConfirmLogout(false);
    setLoggedOut(true);
  };

  return (
    <div
      data-testid="scout-home"
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      {/* Sticky app bar: identity + icon nav stay put while the match list
          scrolls, like a native app shell. Home/My Data/Log out collapse to
          icon-only buttons on phones (labels return ≥ sm) so the top never
          staircases into a wrapping mess. */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-safe pt-safe pb-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
              <UserRound className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="eyebrow">Scouting as</p>
              <h1 className="truncate text-xl font-bold leading-tight">
                {effective.display_name || 'Scout'}
              </h1>
            </div>
          </div>
          <nav className="flex shrink-0 items-center gap-1.5">
            <Link
              data-testid="nav-home"
              to="/"
              aria-label="Home"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-accent"
            >
              <Home className="size-5 shrink-0" />
              <span className="hidden sm:inline">Home</span>
            </Link>
            <Link
              data-testid="nav-my-data"
              to="/my-data"
              aria-label="My Data"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-accent"
            >
              <BarChart3 className="size-5 shrink-0" />
              <span className="hidden sm:inline">My Data</span>
            </Link>
            <Button
              data-testid="scout-logout"
              variant="outline"
              aria-label={`Log out ${effective.display_name || ''}`.trim()}
              className="min-h-[44px] min-w-[44px] rounded-xl px-3"
              onClick={() => setConfirmLogout(true)}
            >
              <LogOut className="size-5 shrink-0" />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </nav>
        </div>

        {/* Two-step logout confirm: a full-width destructive bar so it can't be
            fat-fingered, naming who's being logged out. */}
        {confirmLogout ? (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-medium">
              Log out{effective.display_name ? ` ${effective.display_name}` : ''}?
            </span>
            <div className="flex gap-2">
              <Button
                data-testid="scout-logout-confirm"
                variant="destructive"
                className="min-h-[44px] flex-1 sm:flex-none"
                onClick={logOut}
              >
                Log out
              </Button>
              <Button
                data-testid="scout-logout-cancel"
                variant="ghost"
                className="min-h-[44px] flex-1 sm:flex-none"
                onClick={() => setConfirmLogout(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col gap-5 px-safe pb-safe pt-4">
        {/* Status strip: ONE thin line — sync state (tap for details) on the
            left, offline-cache + sync actions as icon buttons on the right. The
            match list is the star of this screen; passive status doesn't get to
            spend two button-rows of it. Needs-attention states (nothing cached,
            dead letters) grow a small labeled button. */}
        <div className="flex items-center gap-1 rounded-xl border border-border bg-card/40 py-1 pl-3 pr-1.5">
          <SyncIndicator className="min-w-0 flex-1 flex-nowrap" detailsHref="/sync" compact />
          <OfflineReadyBadge
            eventKey={activeEvent ?? eventKey ?? null}
            scoutId={scoutId || undefined}
            compact
          />
        </div>

        <InstallPrompt />

        <SegmentedToggle<ScoutMode>
          ariaLabel="Scouting mode"
          options={[
            { value: 'match', label: 'Match', icon: <Target />, activeClassName: 'text-brand' },
            { value: 'pit', label: 'Pit', icon: <Wrench />, activeClassName: 'text-energy' },
          ]}
          value={mode}
          onChange={setMode}
        />

        {mode === 'pit' ? (
          <PitScoutFlow eventKey={eventKey} scoutId={scoutId} />
        ) : (
          <>
            <UpcomingMatches
              eventKey={eventKey}
              assignments={assignments}
              onStart={startFromAssignment}
              completedKeys={completedKeys}
            />

            <section
              data-testid="scout-manual-pick"
              className="rounded-2xl border border-border bg-card p-4"
            >
              <div className="mb-1 flex items-center gap-2">
                <Crosshair className="size-5 shrink-0 text-brand" />
                <h2 className="text-lg font-semibold">Manual pick</h2>
              </div>
              <p className="mb-3 text-sm text-muted-foreground">
                Not on your schedule? Enter the match and team — alliance and
                station are looked up from the match schedule.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mp-match">Match</Label>
                  <Input
                    id="mp-match"
                    value={matchKey}
                    onChange={(e) => setMatchKey(e.target.value)}
                    placeholder="e.g. 12"
                    className="min-h-[44px] text-base"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mp-team">Target team</Label>
                  <Input
                    id="mp-team"
                    type="number"
                    inputMode="numeric"
                    value={team}
                    onChange={(e) => setTeam(e.target.value)}
                    placeholder="e.g. 3256"
                    className="min-h-[44px] text-base"
                  />
                </div>
                {manualSlot ? (
                  <div
                    data-testid="scout-manual-derived"
                    className={cn(
                      'col-span-2 flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm font-medium',
                      manualSlot.alliance === 'red'
                        ? 'border-red-500/40 bg-red-500/10 text-red-300'
                        : 'border-blue-500/40 bg-blue-500/10 text-blue-300',
                    )}
                  >
                    <CheckCircle2 className="size-4 shrink-0" />
                    <span>
                      You’ll scout{' '}
                      <span className="font-mono font-bold tabular-nums">#{team}</span> on{' '}
                      <span className="font-bold">
                        {manualSlot.alliance} {manualSlot.station}
                      </span>
                    </span>
                  </div>
                ) : showSlotFields ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="mp-alliance">Alliance</Label>
                      <select
                        id="mp-alliance"
                        value={alliance}
                        onChange={(e) => setAlliance(e.target.value as 'red' | 'blue')}
                        className={cn(
                          'h-11 w-full rounded-lg border bg-background px-3 text-base',
                          alliance === 'red'
                            ? 'border-red-500/40 text-red-300'
                            : 'border-blue-500/40 text-blue-300',
                        )}
                      >
                        <option value="red">red</option>
                        <option value="blue">blue</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="mp-station">Station</Label>
                      <select
                        id="mp-station"
                        value={station}
                        onChange={(e) => setStation(Number(e.target.value) as 1 | 2 | 3)}
                        className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base"
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                    </div>
                  </>
                ) : null}
              </div>
              {manualWarning ? (
                <p data-testid="scout-manual-warning" className="mt-2 text-sm text-destructive">
                  {manualWarning}
                </p>
              ) : null}
              <Button
                data-testid="scout-start-capture"
                variant="brand"
                size="big"
                className="mt-4 w-full"
                disabled={!matchKey || !team || !scoutId}
                onClick={startManual}
              >
                Start capture
              </Button>
            </section>

            {/* Only surfaced when there IS something to resume — an always-on
                "No drafts." row was dead space on every visit. */}
            {drafts.length > 0 ? (
              <section>
                <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
                  <History className="size-5 shrink-0 text-warning" /> Resume drafts
                </h2>
                <ul className="flex flex-col gap-2">
                  {drafts.map((d) => (
                    <li key={d.draftKey}>
                      <Button
                        data-testid={`scout-resume-${d.draftKey}`}
                        variant="outline"
                        className="min-h-[52px] w-full justify-start gap-2 rounded-xl border-warning/40 text-sm text-warning"
                        onClick={() => {
                          const stored = (d.state as { target?: CaptureTarget } | null)?.target;
                          if (stored) {
                            setActive(stored);
                            return;
                          }
                          const [dMatch, dScout, dTeam] = d.draftKey.split(':');
                          setActive({
                            eventKey,
                            matchKey: dMatch,
                            scoutId: dScout || scoutId,
                            scoutName: effective.display_name,
                            targetTeamNumber: Number(dTeam),
                            allianceColor: alliance,
                            station,
                          });
                        }}
                      >
                        {draftTitle(d)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}

        {/* Transfer & backup toolbox: QR hand-off + file export grouped in one
            labeled zone at the end of the flow, instead of QR links floating at
            the top and a lone export button at the bottom. */}
        <section className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="eyebrow">No wifi? Move your data</h2>
          <div className="grid grid-cols-2 gap-2">
            <Link
              data-testid="nav-qr-send"
              to="/qr/send"
              className="inline-flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-energy/30 bg-energy/5 px-4 text-sm font-semibold text-energy hover:bg-energy/10"
            >
              <QrCode className="size-5 shrink-0" /> Send via QR
            </Link>
            <Link
              data-testid="nav-qr-receive"
              to="/qr/receive"
              className="inline-flex min-h-[56px] items-center justify-center gap-2 rounded-xl border border-success/30 bg-success/5 px-4 text-sm font-semibold text-success hover:bg-success/10"
            >
              <ScanLine className="size-5 shrink-0" /> Receive via QR
            </Link>
          </div>
          <Button
            variant="outline"
            className="min-h-[48px] w-full gap-2 rounded-xl text-sm font-medium text-muted-foreground"
            onClick={() => void onExport()}
          >
            <FileDown className="size-4 shrink-0" /> Export unsynced
          </Button>
        </section>
      </main>
    </div>
  );
}
