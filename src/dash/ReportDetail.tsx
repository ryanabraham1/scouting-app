// src/dash/ReportDetail.tsx
// REPORTDETAIL — full per-report drill-down for the lead/admin. Given ONE
// match_scouting_report row (MsrRow) and the resolved scouter name, render
// EVERY captured field, clearly grouped: identity, fuel breakdown, climb,
// defense, fouls/flags, notes, and the auto start position + path drawn
// read-only on the field diagram. Wired into a Sheet by ScouterView & MatchView
// so tapping a report row opens the complete report.

import * as React from 'react';
import {
  Hash,
  Flame,
  Mountain,
  Shield,
  AlertTriangle,
  StickyNote,
  Map as MapIcon,
} from 'lucide-react';
import { StatTile } from '@/components/ui/StatTile';
import { FieldDiagram } from '@/components/FieldDiagram';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import type { MsrRow } from '@/dash/types';

export interface ReportDetailProps {
  report: MsrRow;
  /** Resolved scouter display name for attribution (e.g. "Ada"). */
  scoutName?: string;
}

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function yesNo(b: boolean): string {
  return b ? 'Yes' : 'No';
}

function SectionHeading(props: { icon: JSX.Element; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
      {props.icon}
      <span>{props.children}</span>
    </div>
  );
}

/** A boolean flag pill — energized when set, muted when not. */
function FlagPill(props: { label: string; on: boolean; tone?: 'warning' | 'destructive' }): JSX.Element {
  const tone = props.tone ?? 'warning';
  const onClass =
    tone === 'destructive'
      ? 'border-destructive/50 bg-destructive/15 text-destructive'
      : 'border-warning/50 bg-warning/15 text-warning';
  return (
    <span
      data-testid={`report-flag-${props.label.toLowerCase().replace(/\s+/g, '-')}`}
      data-on={props.on ? 'true' : 'false'}
      className={[
        'inline-flex min-h-[44px] items-center rounded-lg border px-3 py-1.5 text-sm font-semibold',
        props.on ? onClass : 'border-border bg-muted/40 text-muted-foreground',
      ].join(' ')}
    >
      {props.label}: {yesNo(props.on)}
    </span>
  );
}

export default function ReportDetail(props: ReportDetailProps): JSX.Element {
  const { report: r, scoutName } = props;
  const matchLabel = formatMatchKeyRaw(r.match_key);
  const hasPath = !!(r.auto_path && r.auto_path.length >= 2);
  const hasStart = !!r.auto_start_position;

  return (
    <div data-testid="report-detail" className="flex flex-col gap-5 text-foreground">
      {/* Identity */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Hash />}>Identity</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Team" value={r.target_team_number} tone="brand" icon={<Hash />} />
          <StatTile label="Match" value={<span data-testid="report-match-label">{matchLabel}</span>} />
          <StatTile
            label="Alliance"
            value={`${r.alliance_color} ${r.station}`}
            tone={r.alliance_color === 'red' ? 'destructive' : 'brand'}
          />
          <StatTile label="Scout" value={scoutName ?? (r.scout_id ? r.scout_id : 'unassigned')} />
        </div>
      </section>

      {/* Fuel */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Flame />}>Fuel</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile label="Auto fuel" value={fmt(r.auto_fuel)} />
          <StatTile label="Teleop active" value={fmt(r.teleop_fuel_active)} />
          <StatTile label="Teleop inactive" value={fmt(r.teleop_fuel_inactive)} />
          <StatTile label="Endgame fuel" value={fmt(r.endgame_fuel)} />
          <StatTile label="Fuel points" value={fmt(r.fuel_points)} tone="energy" />
          <StatTile
            label="Confidence"
            value={pct(r.fuel_estimate_confidence)}
            tone={
              r.fuel_estimate_confidence != null && r.fuel_estimate_confidence < 0.7
                ? 'warning'
                : 'success'
            }
          />
        </div>
      </section>

      {/* Climb */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Mountain />}>Climb</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile label="Climb level" value={`L${r.climb_level}`} />
          <StatTile
            label="Attempted"
            value={yesNo(r.climb_attempted)}
            tone={r.climb_attempted ? 'brand' : 'default'}
          />
          <StatTile
            label="Success"
            value={yesNo(r.climb_success)}
            tone={r.climb_success ? 'success' : 'default'}
          />
        </div>
      </section>

      {/* Defense */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Shield />}>Defense</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile label="Defense rating" value={r.defense_rating} />
          <StatTile label="Pins" value={r.pins} />
        </div>
      </section>

      {/* Fouls */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<AlertTriangle />}>Fouls</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <FlagPill label="No show" on={r.no_show} tone="destructive" />
          <FlagPill label="Died" on={r.died} tone="destructive" />
          <FlagPill label="Tipped" on={r.tipped} />
          <FlagPill label="Dropped fuel" on={r.dropped_fuel} />
          <FlagPill label="Fed corral" on={r.fed_corral} />
        </div>
      </section>

      {/* Notes */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<StickyNote />}>Notes</SectionHeading>
        {r.notes ? (
          <p
            data-testid="report-notes"
            className="rounded-xl border border-border bg-card/60 p-3 text-sm leading-relaxed text-foreground"
          >
            {r.notes}
          </p>
        ) : (
          <p data-testid="report-notes-empty" className="text-sm text-muted-foreground">
            No notes for this report.
          </p>
        )}
      </section>

      {/* Auto path (read-only) */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<MapIcon />}>Auto start &amp; path</SectionHeading>
        {hasStart || hasPath ? (
          <div className="overflow-hidden rounded-xl border border-border">
            <FieldDiagram
              data-testid="report-field"
              mode="view"
              startPosition={r.auto_start_position}
              path={r.auto_path}
            />
          </div>
        ) : (
          <p data-testid="report-field-empty" className="text-sm text-muted-foreground">
            No auto start or path was recorded.
          </p>
        )}
      </section>
    </div>
  );
}
