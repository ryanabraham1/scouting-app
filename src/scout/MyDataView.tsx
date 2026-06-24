// src/scout/MyDataView.tsx — per-scouter "My Data" list.
// Shows the matches scouted by THIS device's selected scouter (useSession().scout?.id),
// newest first, with the key per-match detail. Reads local reports from the offline
// store; an empty state covers a fresh device or a device with no captures yet.
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useSession } from '@/auth/useSession';
import { listReports } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

const CLIMB_LABEL = ['No climb', 'Level 1', 'Level 2', 'Level 3'] as const;

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function MyDataView(): JSX.Element {
  const { scout } = useSession();
  const scoutId = scout?.id ?? '';
  const [reports, setReports] = useState<LocalMatchReport[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await listReports();
      if (cancelled) return;
      const mine = all
        .filter((r) => r.scoutId === scoutId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setReports(mine);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [scoutId]);

  return (
    <div
      data-testid="my-data"
      className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground"
    >
      <header className="flex items-center gap-3">
        <a
          href="/scout"
          data-testid="my-data-back"
          aria-label="Back to scout"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-border hover:bg-accent"
        >
          <ArrowLeft className="size-5" />
        </a>
        <h1 className="text-2xl font-bold">My Data</h1>
        <span className="ml-auto text-sm text-muted-foreground">
          {reports.length} {reports.length === 1 ? 'match' : 'matches'}
        </span>
      </header>

      {loaded && reports.length === 0 && (
        <p data-testid="my-data-empty" className="text-muted-foreground">
          No matches scouted yet on this device.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {reports.map((r) => (
          <li
            key={r.id}
            data-testid="my-data-row"
            className="rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-lg font-semibold">{r.matchKey}</span>
              <span className="text-base font-medium text-muted-foreground">
                Team #{r.targetTeamNumber}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Fuel points</dt>
                <dd className="font-medium">{r.fuelPoints}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Climb</dt>
                <dd className="font-medium">{CLIMB_LABEL[r.climbLevel]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Defense</dt>
                <dd className="font-medium">{fmtSeconds(r.defenseDurationMs)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Defended</dt>
                <dd className="font-medium">{fmtSeconds(r.defendedDurationMs)}</dd>
              </div>
            </dl>
            {r.notes && (
              <p className="mt-2 text-sm">
                <span className="text-muted-foreground">Notes: </span>
                {r.notes}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
