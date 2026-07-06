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
import { foulReasonLabel } from '@/scoring/fouls';
import ConflictMarker from '@/components/ConflictMarker';
import type { MsrRow, MultiScoutGroup } from '@/dash/types';

export interface ReportDetailProps {
  report: MsrRow;
  /** Resolved scouter display name for attribution (e.g. "Ada"). */
  scoutName?: string;
  /**
   * Multi-scout group this report belongs to (multi-scout-reconciliation).
   * When `conflictGroup?.isConflicted`, a top banner renders with the divergence
   * lines + one "View {name}'s report →" button per sibling report.
   */
  conflictGroup?: MultiScoutGroup;
  /** Resolve a sibling's scout_id → display name (reuses the caller's map). */
  siblingName?: (id: string | null | undefined) => string;
  /** Swap the Sheet to a sibling report when its button is clicked. */
  onOpenSibling?: (r: MsrRow) => void;
}

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** A 0–3 subjective rating as "2/3"; "—" when not rated (0 / null / legacy). */
function ratingText(v: number | null | undefined): string {
  return v != null && v > 0 ? `${v}/3` : '—';
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
  const { report: r, scoutName, conflictGroup, siblingName, onOpenSibling } = props;
  const matchLabel = formatMatchKeyRaw(r.match_key);
  const hasPath = !!(r.auto_path && r.auto_path.length >= 2);
  const hasStart = !!r.auto_start_position;

  // Sibling reports (every group member that ISN'T the one being shown).
  const siblings =
    conflictGroup?.isConflicted
      ? conflictGroup.reports.filter((s) => s.scout_id !== r.scout_id)
      : [];
  const resolveName = siblingName ?? ((id: string | null | undefined) => (id ? id : 'unassigned'));

  return (
    <div data-testid="report-detail" className="flex flex-col gap-5 text-foreground">
      {/* Multi-scout conflict banner (renders at the very top, above identity).
          MAJOR (severe) discrepancies escalate to the destructive token; MINOR
          ones stay on warning so the tone tracks real severity. */}
      {conflictGroup?.isConflicted
        ? (() => {
            const major = conflictGroup.severity === 'severe';
            const bannerClass = major
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-warning/40 bg-warning/5';
            const siblingClass = major
              ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20';
            return (
              <section
                data-testid="report-conflict"
                data-scout-id={r.scout_id ?? ''}
                data-severity={conflictGroup.severity}
                className={[
                  'flex flex-col gap-2 rounded-xl border p-3',
                  bannerClass,
                ].join(' ')}
              >
                <SectionHeading icon={<AlertTriangle />}>Multi-scout conflict</SectionHeading>
                <ConflictMarker group={conflictGroup} showDetail />
                {siblings.length ? (
                  <div className="flex flex-wrap gap-2">
                    {siblings.map((s) => (
                      <button
                        key={s.scout_id ?? '∅'}
                        type="button"
                        data-testid={`report-conflict-sibling-${s.scout_id ?? 'unassigned'}`}
                        onClick={() => onOpenSibling?.(s)}
                        className={[
                          'rounded-lg border px-3 py-1.5 text-sm font-semibold',
                          siblingClass,
                        ].join(' ')}
                      >
                        View {resolveName(s.scout_id)}&apos;s report →
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })()
        : null}

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

      {/* Defense & ratings */}
      <section className="flex flex-col gap-2">
        <SectionHeading icon={<Shield />}>Defense &amp; ratings</SectionHeading>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile label="Defense rating" value={ratingText(r.defense_rating)} />
          <StatTile label="Driver skill" value={ratingText(r.driver_skill)} />
          <StatTile label="Agility" value={ratingText(r.agility)} />
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
        {r.foul_reasons && r.foul_reasons.length > 0 && (
          <div data-testid="report-foul-reasons" className="flex flex-wrap gap-1.5">
            {r.foul_reasons.map((key) => (
              <span
                key={key}
                className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning"
              >
                {foulReasonLabel(key)}
              </span>
            ))}
          </div>
        )}
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
