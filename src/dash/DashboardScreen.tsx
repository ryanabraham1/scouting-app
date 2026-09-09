// src/dash/DashboardScreen.tsx — lightly protected controls for lead-only work.
// The PIN is intentionally a client-side guard against accidental edits, not an
// authentication boundary. Analysis lives separately at /analysis.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Presentation,
  ClipboardList,
  Settings,
  UserCheck,
  Gavel,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconTabs } from '@/components/ui/IconTabs';
import { BackLink } from '@/components/ui/BackLink';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useEventLiveSync } from '@/dash/useEventData';
import StrategyView from '@/dash/strategy/StrategyView';
import PicklistView from '@/dash/PicklistView';
import ScoutersTab from '@/dash/ScoutersTab';
import SetupTab from '@/dash/SetupTab';
import DraftBoardView from '@/dash/DraftBoardView';

type Tab = 'strategy' | 'scouters' | 'picklist' | 'draft' | 'settings';

const LEAD_UNLOCK_KEY = 'frc-lead-dashboard-unlocked';
const LEAD_CODE = '12345';

const TABS: { key: Tab; label: string; icon: LucideIcon; needsEvent: boolean }[] = [
  { key: 'strategy', label: 'Strategy', icon: Presentation, needsEvent: true },
  { key: 'scouters', label: 'Scouters', icon: UserCheck, needsEvent: false },
  { key: 'picklist', label: 'Picklist', icon: ClipboardList, needsEvent: true },
  { key: 'draft', label: 'Draft', icon: Gavel, needsEvent: true },
  { key: 'settings', label: 'Settings', icon: Settings, needsEvent: false },
];

const TAB_ALIASES: Record<string, Tab> = {
  setup: 'settings',
  scouter: 'scouters',
  roster: 'scouters',
};

function initialTab(): Tab {
  try {
    const query = new URLSearchParams(window.location.search).get('tab');
    if (query && TABS.some((tab) => tab.key === query)) return query as Tab;
    if (query && query in TAB_ALIASES) return TAB_ALIASES[query];
  } catch {
    // Browser history is unavailable during non-browser rendering.
  }
  return 'strategy';
}

function readUnlocked(): boolean {
  try {
    return window.sessionStorage.getItem(LEAD_UNLOCK_KEY) === 'true';
  } catch {
    return false;
  }
}

function LeadGate({ children }: { children: (lockDashboard: () => void) => ReactNode }): JSX.Element {
  const [unlocked, setUnlocked] = useState(readUnlocked);
  const [code, setCode] = useState('');
  const [error, setError] = useState(false);

  function unlock(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (code !== LEAD_CODE) {
      setError(true);
      setCode('');
      return;
    }
    try {
      window.sessionStorage.setItem(LEAD_UNLOCK_KEY, 'true');
    } catch {
      // The current render can still unlock if storage is unavailable.
    }
    setError(false);
    setUnlocked(true);
  }

  function lockDashboard(): void {
    try {
      window.sessionStorage.removeItem(LEAD_UNLOCK_KEY);
    } catch {
      // State still locks this render if storage is unavailable.
    }
    setCode('');
    setUnlocked(false);
  }

  if (unlocked) return <>{children(lockDashboard)}</>;

  return (
    <main
      data-testid="lead-dashboard-lock"
      className="flex min-h-screen flex-col bg-background px-safe py-safe text-foreground"
    >
      <div className="flex items-center">
        <BackLink to="/" label="Home" icon="home" />
      </div>
      <div className="flex flex-1 items-center justify-center py-8">
        <form
          onSubmit={unlock}
          className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8"
        >
          <span className="mb-5 flex size-12 items-center justify-center rounded-xl border border-energy/30 bg-energy/10 text-energy">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-energy">Lead controls</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Unlock Lead Dashboard</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter the 5-digit team code to access strategy and event controls.
          </p>
          <label htmlFor="lead-code" className="mt-6 block text-sm font-semibold">
            Team code
          </label>
          <input
            id="lead-code"
            aria-label="Lead dashboard code"
            aria-invalid={error}
            aria-describedby={error ? 'lead-code-error' : undefined}
            autoComplete="off"
            autoFocus
            inputMode="numeric"
            type="password"
            pattern="[0-9]*"
            maxLength={5}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, '').slice(0, 5));
              setError(false);
            }}
            className="mt-2 min-h-12 w-full rounded-lg border border-input bg-background px-4 font-mono text-xl tracking-[0.35em] outline-none transition focus:border-energy focus:ring-2 focus:ring-energy/30"
          />
          {error ? (
            <p id="lead-code-error" role="alert" className="mt-2 text-sm text-destructive">
              That code is not correct. Try again.
            </p>
          ) : null}
          <button
            type="submit"
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-energy px-4 text-sm font-bold text-energy-foreground transition-colors hover:bg-energy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-energy"
          >
            Unlock dashboard
          </button>
        </form>
      </div>
    </main>
  );
}

function LeadDashboard({ lockDashboard }: { lockDashboard: () => void }): JSX.Element {
  const { eventKey, loading, authoritative } = useActiveEvent();
  useEventLiveSync(eventKey);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(initialTab);

  function selectTab(next: Tab): void {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // URL history is unavailable during non-browser rendering.
    }
  }

  useEffect(() => {
    const onPopState = () => setTab(initialTab());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const current = TABS.find((item) => item.key === tab);
  const dataGated = current?.needsEvent ?? true;
  const openTeam = (teamNumber: number) =>
    navigate(`/analysis?tab=team&team=${encodeURIComponent(teamNumber)}`);

  return (
    <div
      data-testid="dashboard"
      className="flex min-h-screen min-w-0 flex-col gap-3 overflow-x-hidden bg-background px-safe py-safe text-foreground sm:gap-4"
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BackLink to="/" label="Home" icon="home" iconOnly className="sm:hidden" />
          <BackLink to="/" label="Home" icon="home" className="hidden sm:inline-flex" />
          <h1 className="truncate text-xl font-bold sm:text-2xl">Lead Dashboard</h1>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden max-w-[5rem] truncate font-mono text-xs text-muted-foreground sm:block sm:max-w-none sm:text-sm">
            {eventKey ?? '—'}
          </span>
          <button
            type="button"
            aria-label="Lock dashboard"
            onClick={lockDashboard}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Lock className="size-4" aria-hidden />
            <span className="hidden sm:inline">Lock</span>
          </button>
        </div>
      </header>

      <IconTabs<Tab>
        ariaLabel="Lead Dashboard sections"
        value={tab}
        onChange={selectTab}
        className="!gap-1.5 [&>button]:!min-h-16 [&>button]:!min-w-[3.25rem] [&>button]:!w-[3.25rem] [&>button]:!basis-[3.25rem] [&>button]:!flex-col [&>button]:!gap-0.5 [&>button]:!px-0.5 sm:grid-cols-5 sm:!gap-2 sm:[&>button]:!min-w-0 sm:[&>button]:!w-auto sm:[&>button]:!basis-auto sm:[&>button]:!px-2"
        tabs={TABS.map((item) => {
          const Icon = item.icon;
          return { value: item.key, label: item.label, icon: <Icon /> };
        })}
      />

      {!authoritative && eventKey ? (
        <div
          role="status"
          data-testid="dashboard-event-unverified"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          Showing cached event {eventKey} while server authority is being verified. Destructive
          event-scoped edits are paused.
        </div>
      ) : null}

      {tab === 'scouters' && <ScoutersTab eventKey={eventKey} />}
      {tab === 'settings' && <SetupTab />}

      {dataGated &&
        (loading ? (
          <p data-testid="dashboard-loading" className="text-muted-foreground">Loading event…</p>
        ) : !eventKey ? (
          <p data-testid="dashboard-no-event" className="text-muted-foreground">
            No active event. Set one in Settings.
          </p>
        ) : (
          <section className="min-w-0 flex-1">
            {tab === 'strategy' && <StrategyView eventKey={eventKey} />}
            {tab === 'picklist' && (
              <PicklistView eventKey={eventKey} onSelectTeam={openTeam} readOnly={!authoritative} />
            )}
            {tab === 'draft' && <DraftBoardView eventKey={eventKey} onSelectTeam={openTeam} />}
          </section>
        ))}
    </div>
  );
}

export default function DashboardScreen(): JSX.Element {
  return <LeadGate>{(lockDashboard) => <LeadDashboard lockDashboard={lockDashboard} />}</LeadGate>;
}
