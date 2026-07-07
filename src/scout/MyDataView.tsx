// src/scout/MyDataView.tsx — per-scouter "My Data" list.
// Shows the matches scouted by THIS device's selected scouter (useSession().scout?.id),
// newest first, with the key per-match detail. Reads local reports from the offline
// store; an empty state covers a fresh device or a device with no captures yet.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { useSession } from "@/auth/useSession";
import { matchLabelFromKey } from "@/capture/UpcomingMatches";
import { listReports } from "@/db/localStore";
import type { LocalMatchReport } from "@/db/types";

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function MyDataView(): JSX.Element {
  const { scout } = useSession();
  const navigate = useNavigate();
  const scoutId = scout?.id ?? "";
  const [reports, setReports] = useState<LocalMatchReport[]>([]);
  const [loaded, setLoaded] = useState(false);

  // After a correction, ScoutHome routes here with ?updated=1. Show a transient
  // confirmation banner, then strip the param so a reload doesn't re-show it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [showUpdated, setShowUpdated] = useState(false);
  useEffect(() => {
    if (searchParams.get("updated") !== "1") return;
    setShowUpdated(true);
    setSearchParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.delete("updated");
        return sp;
      },
      { replace: true },
    );
    const t = setTimeout(() => setShowUpdated(false), 3000);
    return () => clearTimeout(t);
  }, [searchParams, setSearchParams]);

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
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/95 px-safe pt-safe pb-3 backdrop-blur">
        <Link
          to="/scout"
          data-testid="my-data-back"
          aria-label="Back to scout"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-border hover:bg-accent"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-xl font-bold">My Data</h1>
        <span className="ml-auto text-sm text-muted-foreground">
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {reports.length}
          </span>{" "}
          {reports.length === 1 ? "match" : "matches"}
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-safe pb-safe pt-4">
        {showUpdated && (
          <div
            data-testid="my-data-updated-toast"
            className="rounded-lg border border-success/40 bg-success/15 px-3 py-2 text-sm font-medium text-success motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2"
          >
            Report updated — re-uploading the correction.
          </div>
        )}

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
              className="rounded-xl border border-border border-l-4 border-l-brand/50 bg-card p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  <span className="flex flex-col">
                    <span className="text-lg font-semibold leading-tight">
                      {matchLabelFromKey(r.matchKey)}
                    </span>
                    <span className="font-mono text-[11px] leading-tight text-muted-foreground tabular-nums">
                      {r.matchKey}
                    </span>
                  </span>
                  {r.rowRevision > 1 && (
                    <span
                      data-testid={`my-data-rev-${r.id}`}
                      className="inline-flex rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning tabular-nums"
                    >
                      rev {r.rowRevision}
                    </span>
                  )}
                </span>
                <span className="text-base font-medium text-brand">
                  Team{" "}
                  <span className="font-mono font-semibold tabular-nums">
                    #{r.targetTeamNumber}
                  </span>
                </span>
              </div>
              {/* Dead-letter flag gets its own full-width line (rare, needs room);
                the Edit action sits INLINE with the stats row below so it doesn't
                open an empty band across the card's bottom. */}
              {r.syncState === "error" ? (
                <p
                  data-testid={`my-data-needs-sync-${r.id}`}
                  className="mt-2 text-xs font-medium text-destructive"
                >
                  failed to sync — fix &amp; re-save
                </p>
              ) : null}
              <div className="mt-3 flex items-end justify-between gap-3">
                <dl className="grid flex-1 grid-cols-4 gap-x-3">
                  <div className="flex flex-col gap-0.5">
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Fuel
                    </dt>
                    <dd className="font-mono text-base font-semibold text-energy tabular-nums">
                      {r.fuelPoints}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Climb
                    </dt>
                    <dd className="font-mono text-base font-semibold tabular-nums">
                      <span
                        className={
                          r.climbLevel > 0
                            ? "text-success"
                            : "text-muted-foreground"
                        }
                      >
                        {r.climbLevel > 0 ? `L${r.climbLevel}` : "—"}
                      </span>
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Defense
                    </dt>
                    <dd className="font-mono text-base font-semibold text-brand tabular-nums">
                      {fmtSeconds(r.defenseDurationMs)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Defended
                    </dt>
                    <dd className="font-mono text-base font-semibold tabular-nums">
                      {fmtSeconds(r.defendedDurationMs)}
                    </dd>
                  </div>
                </dl>
                {/* Every report gets an Edit button that re-opens the correction
                  flow — including dead-lettered (error) rows: correcting the bad
                  match/team and re-saving is the recovery path (BUG-4). */}
                <button
                  type="button"
                  data-testid={`my-data-edit-${r.id}`}
                  onClick={() => navigate(`/scout?edit=${r.id}`)}
                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent"
                >
                  <Pencil className="size-4" /> Edit
                </button>
              </div>
              {r.notes && (
                <p className="mt-2 text-sm">
                  <span className="text-muted-foreground">Notes: </span>
                  {r.notes}
                </p>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
