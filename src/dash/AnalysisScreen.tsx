// src/dash/AnalysisScreen.tsx — unlocked match intelligence and team analysis.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MonitorPlay, UserSearch, ListOrdered, Grid3x3, Users, ChartNoAxesColumn } from 'lucide-react';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useEventLiveSync } from '@/dash/useEventData';
import NextMatchView from '@/dash/NextMatchView';
import TeamView from '@/dash/TeamView';
import MatchView from '@/dash/MatchView';
import RankingView from '@/dash/RankingView';
import AllianceSimulatorView from '@/dash/AllianceSimulatorView';
import { BottomTabBar, BOTTOM_BAR_CLEARANCE, type BottomTab } from '@/components/BottomTabBar';
import { IconTabs } from '@/components/ui/IconTabs';
import { StationMenu } from '@/components/StationMenu';

type Tab = 'next' | 'team' | 'match' | 'ranking' | 'alliance';

// Hidden for now, not removed: drop an id from here to bring its tab back.
const HIDDEN_TABS: ReadonlySet<Tab> = new Set<Tab>(['alliance']);

const TABS: readonly BottomTab<Tab>[] = (
  [
    { id: 'team', label: 'Team', icon: UserSearch },
    { id: 'match', label: 'Match', icon: Grid3x3 },
    { id: 'ranking', label: 'Ranking', icon: ListOrdered },
    { id: 'alliance', label: 'Alliance', icon: Users },
    { id: 'next', label: 'Pit', icon: MonitorPlay },
  ] satisfies BottomTab<Tab>[]
).filter((t) => !HIDDEN_TABS.has(t.id));

// Desktop keeps the pre-mobile tab row: Pit Display leads, full label.
const DESKTOP_TABS = [...TABS.filter((t) => t.id === 'next'), ...TABS.filter((t) => t.id !== 'next')].map(
  ({ id, label, icon: Icon }) => ({
    value: id,
    label: id === 'next' ? 'Pit Display' : label,
    icon: <Icon />,
  }),
);

function readLocation(search: string): { tab: Tab; team: number | null; match: string | null } {
  try {
    const params = new URLSearchParams(search);
    const requested = params.get('tab');
    const tab = requested && TABS.some((item) => item.id === requested) ? requested as Tab : 'next';
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
  const location = useLocation();
  const navigate = useNavigate();
  const initial = readLocation(location.search);
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
    const params = new URLSearchParams(location.search);
    params.set('tab', next);
    params.delete('team');
    params.delete('match');
    if (extras?.team) params.set('team', String(extras.team));
    if (extras?.match) params.set('match', extras.match);
    navigate({ search: `?${params.toString()}` });
  }

  // Router location is the source of truth: it changes on back/forward AND on
  // any in-app <TeamLink> click (which lands on this same route), so a team
  // link inside Analysis switches to that team without a remount.
  useEffect(() => {
    const next = readLocation(location.search);
    setTab(next.tab);
    setTeamSelection({ eventKey, value: next.team });
    setMatchSelection({ eventKey, value: next.match });
  }, [location.search, eventKey]);

  function openMatch(matchKey: string): void {
    setMatchSelection({ eventKey, value: matchKey });
    writeLocation('match', { match: matchKey });
  }

  return (
    <div
      data-testid="analysis"
      className={`flex min-h-screen min-w-0 flex-col gap-3 overflow-x-hidden bg-background px-safe py-safe text-foreground sm:gap-4 ${BOTTOM_BAR_CLEARANCE}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <StationMenu
          current="analysis"
          title="Analysis"
          subtitle={eventKey ?? undefined}
          avatar={<ChartNoAxesColumn aria-hidden="true" />}
        />
      </header>

      <IconTabs<Tab>
        ariaLabel="Analysis sections"
        value={tab}
        onChange={(next) => writeLocation(next)}
        tabs={DESKTOP_TABS}
        className="hidden md:grid"
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
          {tab === 'ranking' && <RankingView eventKey={eventKey} />}
          {tab === 'alliance' && <AllianceSimulatorView eventKey={eventKey} />}
        </section>
      )}
      <BottomTabBar
        tabs={TABS}
        active={tab}
        onSelect={writeLocation}
        ariaLabel="Analysis sections"
        testId="analysis-bottom-nav"
        tabTestIdPrefix="analysis-tab"
        desktop="hidden"
      />
    </div>
  );
}
