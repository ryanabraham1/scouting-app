// src/dash/DashboardScreen.tsx — open (no login) lead/drive-coach hub. Landscape
// tab bar with lucide icons: Next Match · Team · Scouters · Match · Ranking ·
// Picklist · Setup. Initial tab is read from ?tab= so the legacy /admin ->
// /dashboard?tab=setup alias lands on Setup; the retired ?tab=scouter and
// ?tab=roster both resolve to the merged Scouters tab.
import { useState } from 'react';
import {
  Swords,
  UserSearch,
  ListOrdered,
  ClipboardList,
  Settings,
  UserCheck,
  Grid3x3,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { IconTabs } from '@/components/ui/IconTabs';
import { BackLink } from '@/components/ui/BackLink';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useEventLiveSync } from '@/dash/useEventData';
import NextMatchView from '@/dash/NextMatchView';
import TeamView from '@/dash/TeamView';
import MatchView from '@/dash/MatchView';
import RankingView from '@/dash/RankingView';
import PicklistView from '@/dash/PicklistView';
import ScoutersTab from '@/dash/ScoutersTab';
import SetupTab from '@/dash/SetupTab';
import AllianceSimulatorView from '@/dash/AllianceSimulatorView';

type Tab = 'next' | 'team' | 'scouters' | 'match' | 'ranking' | 'picklist' | 'setup' | 'alliance';

const TABS: { key: Tab; label: string; icon: LucideIcon; needsEvent: boolean }[] = [
  { key: 'next', label: 'Next Match', icon: Swords, needsEvent: true },
  { key: 'team', label: 'Team', icon: UserSearch, needsEvent: true },
  { key: 'scouters', label: 'Scouters', icon: UserCheck, needsEvent: false },
  { key: 'match', label: 'Match', icon: Grid3x3, needsEvent: true },
  { key: 'ranking', label: 'Ranking', icon: ListOrdered, needsEvent: true },
  { key: 'picklist', label: 'Picklist', icon: ClipboardList, needsEvent: true },
  { key: 'setup', label: 'Setup', icon: Settings, needsEvent: false },
  { key: 'alliance', label: 'Alliance', icon: Users, needsEvent: true },
];

/** Legacy ?tab= values that now fold into a current tab. */
const TAB_ALIASES: Record<string, Tab> = {
  scouter: 'scouters',
  roster: 'scouters',
};

function initialTab(): Tab {
  try {
    const q = new URLSearchParams(window.location.search).get('tab');
    if (q) {
      if (TABS.some((t) => t.key === q)) return q as Tab;
      if (q in TAB_ALIASES) return TAB_ALIASES[q];
    }
  } catch {
    /* no window/search — fall through */
  }
  return 'next';
}

export default function DashboardScreen(): JSX.Element {
  const { eventKey, loading } = useActiveEvent();
  // Real-time engine for the whole dashboard: pushes Nexus field snapshots +
  // freshly-scored results into the query cache the instant they land, and runs
  // the TBA results reconcile safety net. No-op without an event.
  useEventLiveSync(eventKey);
  const [tab, setTab] = useState<Tab>(initialTab);
  // Lifted so a click in Ranking can preselect the team on the Team tab.
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  // Lifted so a click on a team's last-match card deep-links to the Match tab.
  const [selectedMatchKey, setSelectedMatchKey] = useState<string | null>(null);

  const current = TABS.find((t) => t.key === tab);
  const dataGated = current?.needsEvent ?? true;

  function openTeam(teamNumber: number): void {
    setSelectedTeam(teamNumber);
    setTab('team');
  }

  function openMatch(matchKey: string): void {
    setSelectedMatchKey(matchKey);
    setTab('match');
  }

  return (
    <div
      data-testid="dashboard"
      className="flex min-h-screen flex-col gap-4 bg-background px-safe py-safe text-foreground"
    >
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BackLink to="/" label="Home" icon="home" />
          <h1 className="text-2xl font-bold">Dashboard</h1>
        </div>
        <span className="font-mono text-sm text-muted-foreground">{eventKey ?? '—'}</span>
      </header>

      <IconTabs<Tab>
        ariaLabel="Dashboard sections"
        value={tab}
        onChange={setTab}
        tabs={[...TABS]
          // Setup is pinned to the far right no matter what other tabs exist
          // (stable sort: every non-setup tab keeps its order, setup goes last).
          .sort((a, b) => Number(a.key === 'setup') - Number(b.key === 'setup'))
          .map((t) => {
            const Icon = t.icon;
            return { value: t.key, label: t.label, icon: <Icon /> };
          })}
      />

      {/* Scouters stays usable without an event (roster lives on its own table). */}
      {tab === 'scouters' && <ScoutersTab eventKey={eventKey} />}
      {tab === 'setup' && <SetupTab />}

      {dataGated &&
        (loading ? (
          <p data-testid="dashboard-loading" className="text-muted-foreground">
            Loading event…
          </p>
        ) : !eventKey ? (
          <p data-testid="dashboard-no-event" className="text-muted-foreground">
            No active event. Set one in the Setup tab.
          </p>
        ) : (
          <section className="flex-1">
            {tab === 'next' && <NextMatchView eventKey={eventKey} />}
            {tab === 'team' && (
              <TeamView
                eventKey={eventKey}
                selectedTeam={selectedTeam}
                onSelectTeam={setSelectedTeam}
                onOpenMatch={openMatch}
              />
            )}
            {tab === 'match' && (
              <MatchView
                eventKey={eventKey}
                initialMatchKey={selectedMatchKey}
                onSelectMatch={setSelectedMatchKey}
              />
            )}
            {tab === 'ranking' && (
              <RankingView eventKey={eventKey} onSelectTeam={openTeam} />
            )}
            {tab === 'picklist' && <PicklistView eventKey={eventKey} />}
            {tab === 'alliance' && <AllianceSimulatorView eventKey={eventKey} />}
          </section>
        ))}
    </div>
  );
}
