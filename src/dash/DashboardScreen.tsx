// src/dash/DashboardScreen.tsx — staff dashboard shell: resolves the active
// event, then tabs between the four views (next-match, team, ranking, picklist).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useActiveEvent } from '@/dash/useActiveEvent';
import NextMatchView from '@/dash/NextMatchView';
import TeamView from '@/dash/TeamView';
import RankingView from '@/dash/RankingView';
import PicklistView from '@/dash/PicklistView';

type Tab = 'next' | 'team' | 'ranking' | 'picklist';

const TABS: { key: Tab; label: string }[] = [
  { key: 'next', label: 'Next Match' },
  { key: 'team', label: 'Team' },
  { key: 'ranking', label: 'Ranking' },
  { key: 'picklist', label: 'Picklist' },
];

export default function DashboardScreen(): JSX.Element {
  const { eventKey, loading } = useActiveEvent();
  const [tab, setTab] = useState<Tab>('next');

  return (
    <div
      data-testid="dashboard"
      className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground"
    >
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <span className="text-sm text-muted-foreground">{eventKey ?? '—'}</span>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            data-testid={`dash-tab-${t.key}`}
            variant={tab === t.key ? 'default' : 'outline'}
            className="h-11 min-h-[44px]"
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </nav>

      {loading ? (
        <p data-testid="dashboard-loading" className="text-muted-foreground">
          Loading event…
        </p>
      ) : !eventKey ? (
        <p data-testid="dashboard-no-event" className="text-muted-foreground">
          No active event. An admin must import and activate one first.
        </p>
      ) : (
        <section className="flex-1">
          {tab === 'next' && <NextMatchView eventKey={eventKey} />}
          {tab === 'team' && <TeamView eventKey={eventKey} />}
          {tab === 'ranking' && <RankingView eventKey={eventKey} />}
          {tab === 'picklist' && <PicklistView eventKey={eventKey} />}
        </section>
      )}
    </div>
  );
}
