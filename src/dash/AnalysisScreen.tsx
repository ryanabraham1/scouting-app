// src/dash/AnalysisScreen.tsx — unlocked match intelligence and team analysis.
import { useEffect, useState } from 'react';
import { MonitorPlay, UserSearch, ListOrdered, Grid3x3, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconTabs } from '@/components/ui/IconTabs';
import { BackLink } from '@/components/ui/BackLink';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useEventLiveSync } from '@/dash/useEventData';
import NextMatchView from '@/dash/NextMatchView';
import TeamView from '@/dash/TeamView';
import MatchView from '@/dash/MatchView';
import RankingView from '@/dash/RankingView';
import AllianceSimulatorView from '@/dash/AllianceSimulatorView';

type Tab = 'next' | 'team' | 'match' | 'ranking' | 'alliance';

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'next', label: 'Pit Display', icon: MonitorPlay },
  { key: 'team', label: 'Team', icon: UserSearch },
  { key: 'match', label: 'Match', icon: Grid3x3 },
  { key: 'ranking', label: 'Ranking', icon: ListOrdered },
  { key: 'alliance', label: 'Alliance', icon: Users },
];

function readLocation(): { tab: Tab; team: number | null; match: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('tab');
    const tab = requested && TABS.some((item) => item.key === requested) ? requested as Tab : 'next';
    const teamValue = Number(params.get('team'));
    return {
      tab,
      team: Number.isInteger(teamValue) && teamValue > 0 ? teamValue : null,
      match: params.get('match'),
    };
  } catch {
    return { tab: 'next', team: null, match: null };
  }
}

export default function AnalysisScreen(): JSX.Element {
  const { eventKey, loading } = useActiveEvent();
  useEventLiveSync(eventKey);
  const initial = readLocation();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [teamSelection, setTeamSelection] = useState<{
    eventKey: string | null;
    value: number | null;
  }>({ eventKey, value: initial.team });
  const [matchSelection, setMatchSelection] = useState<{
    eventKey: string | null;
    value: string | null;
  }>({ eventKey, value: initial.match });
  const selectedTeam = teamSelection.eventKey === eventKey ? teamSelection.value : null;
  const selectedMatchKey = matchSelection.eventKey === eventKey ? matchSelection.value : null;

  function writeLocation(next: Tab, extras?: { team?: number; match?: string }): void {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      url.searchParams.delete('team');
      url.searchParams.delete('match');
      if (extras?.team) url.searchParams.set('team', String(extras.team));
      if (extras?.match) url.searchParams.set('match', extras.match);
      window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // URL history is unavailable during non-browser rendering.
    }
  }

  useEffect(() => {
    const onPopState = () => {
      const location = readLocation();
      setTab(location.tab);
      setTeamSelection({ eventKey, value: location.team });
      setMatchSelection({ eventKey, value: location.match });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [eventKey]);

  useEffect(() => {
    setTeamSelection((current) => ({ eventKey, value: current.value }));
    setMatchSelection((current) => ({ eventKey, value: current.value }));
  }, [eventKey]);

  function openTeam(teamNumber: number): void {
    setTeamSelection({ eventKey, value: teamNumber });
    writeLocation('team', { team: teamNumber });
  }

  function openMatch(matchKey: string): void {
    setMatchSelection({ eventKey, value: matchKey });
    writeLocation('match', { match: matchKey });
  }

  return (
    <div
      data-testid="analysis"
      className="flex min-h-screen min-w-0 flex-col gap-3 overflow-x-hidden bg-background px-safe py-safe text-foreground sm:gap-4"
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BackLink to="/" label="Home" icon="home" iconOnly className="sm:hidden" />
          <BackLink to="/" label="Home" icon="home" className="hidden sm:inline-flex" />
          <h1 className="truncate text-xl font-bold sm:text-2xl">Analysis</h1>
        </div>
        <span className="hidden max-w-[7rem] shrink-0 truncate font-mono text-xs text-muted-foreground sm:block sm:max-w-none sm:text-sm">
          {eventKey ?? '—'}
        </span>
      </header>

      <IconTabs<Tab>
        ariaLabel="Analysis sections"
        value={tab}
        onChange={writeLocation}
        className="!gap-1.5 [&>button]:!min-h-16 [&>button]:!min-w-[3.25rem] [&>button]:!w-[3.25rem] [&>button]:!basis-[3.25rem] [&>button]:!flex-col [&>button]:!gap-0.5 [&>button]:!px-0.5 sm:grid-cols-5 sm:!gap-2 sm:[&>button]:!min-w-0 sm:[&>button]:!w-auto sm:[&>button]:!basis-auto sm:[&>button]:!px-2"
        tabs={TABS.map((item) => {
          const Icon = item.icon;
          return { value: item.key, label: item.label, icon: <Icon /> };
        })}
      />

      {loading ? (
        <p data-testid="analysis-loading" className="text-muted-foreground">Loading event…</p>
      ) : !eventKey ? (
        <p data-testid="analysis-no-event" className="text-muted-foreground">
          No active event. A lead can set one in Lead Dashboard Settings.
        </p>
      ) : (
        <section className="min-w-0 flex-1">
          {tab === 'next' && <NextMatchView eventKey={eventKey} />}
          {tab === 'team' && (
            <TeamView
              eventKey={eventKey}
              selectedTeam={selectedTeam}
              onSelectTeam={(team) => setTeamSelection({ eventKey, value: team })}
              onOpenMatch={openMatch}
            />
          )}
          {tab === 'match' && (
            <MatchView
              eventKey={eventKey}
              initialMatchKey={selectedMatchKey}
              onSelectMatch={(match) => setMatchSelection({ eventKey, value: match })}
            />
          )}
          {tab === 'ranking' && <RankingView eventKey={eventKey} onSelectTeam={openTeam} />}
          {tab === 'alliance' && <AllianceSimulatorView eventKey={eventKey} />}
        </section>
      )}
    </div>
  );
}
