// src/dash/__tests__/TeamTimeline.test.tsx
// TeamTimeline draws a color-coded, absolute-time activity bar for a single
// scouting report using buildTimeline(). Tests cover segment positioning, the
// auto/teleop divider, the legend, and the legacy empty state (+ fuel_by_shift
// fallback).
//
// NOTE: the component file is TeamTimeline.tsx (NOT MatchTimeline.tsx) to avoid a
// case-only filename collision with the foundation util src/dash/matchTimeline.ts
// on case-insensitive filesystems (macOS), which would resolve the import to the
// util (no default export) and break it.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import type { MsrRow, BurstRow, IntervalRow } from '@/dash/types';
import { AUTO_MS, MATCH_MS, fractionOfMatch } from '@/dash/matchTimeline';
import TeamTimeline from '@/dash/TeamTimeline';

function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 254,
    match_key: '2026casnv_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: 1,
    fuel_by_shift: [0, 0, 0, 0],
    auto_left_starting_line: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    auto_start_position: null,
    auto_path: null,
    scout_id: null,
    notes: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

const shoot: BurstRow = { startMs: 5000, endMs: 9000, rate: 3, window: 'auto' };
const feed: BurstRow = { startMs: 10000, endMs: 20000, rate: 2, window: 'shift1' };
const defense: IntervalRow = { startMs: 30000, endMs: 50000, phase: 'teleop' };
const defended: IntervalRow = { startMs: 30000, endMs: 40000, phase: 'teleop' };

beforeEach(() => cleanup());

describe('TeamTimeline', () => {
  it('renders one segment per timeline kind', () => {
    const { getByTestId } = render(
      <TeamTimeline
        report={row({
          fuel_bursts: [shoot],
          feeding_bursts: [feed],
          defense_intervals: [defense],
          defended_intervals: [defended],
        })}
      />,
    );
    expect(getByTestId('timeline-track')).toBeTruthy();
    expect(getByTestId('timeline-seg-shoot-0')).toBeTruthy();
    expect(getByTestId('timeline-seg-feed-0')).toBeTruthy();
    expect(getByTestId('timeline-seg-defense-0')).toBeTruthy();
    expect(getByTestId('timeline-seg-defended-0')).toBeTruthy();
  });

  it('positions a segment at its fraction-of-match left offset', () => {
    const { getByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} />,
    );
    const seg = getByTestId('timeline-seg-shoot-0');
    // The browser may normalize "2.500%" → "2.5%"; compare the numeric value.
    expect(parseFloat(seg.style.left)).toBeCloseTo(fractionOfMatch(5000) * 100, 3);
    expect(parseFloat(seg.style.width)).toBeCloseTo(((9000 - 5000) / MATCH_MS) * 100, 3);
  });

  it('marks the auto/teleop divider', () => {
    const { getByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} />,
    );
    const divider = getByTestId('timeline-auto-divider');
    expect(parseFloat(divider.style.left)).toBeCloseTo(fractionOfMatch(AUTO_MS) * 100, 3);
  });

  it('renders a legend naming each kind', () => {
    const { getByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} />,
    );
    const legend = getByTestId('timeline-legend');
    const scope = within(legend);
    expect(scope.getByText('Shooting')).toBeTruthy();
    expect(scope.getByText('Feeding')).toBeTruthy();
    expect(scope.getByText('Playing defense')).toBeTruthy();
    expect(scope.getByText('Being defended')).toBeTruthy();
  });

  it('renders no playhead when currentTimeMs is absent (graceful degradation)', () => {
    const { queryByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} />,
    );
    expect(queryByTestId('timeline-playhead')).toBeNull();
  });

  it('renders a playhead at fractionOfMatch(currentTimeMs) and highlights the active segment', () => {
    const { getByTestId } = render(
      <TeamTimeline
        report={row({ fuel_bursts: [shoot], defense_intervals: [defense] })}
        currentTimeMs={7000}
      />,
    );
    const head = getByTestId('timeline-playhead');
    expect(parseFloat(head.style.left)).toBeCloseTo(fractionOfMatch(7000) * 100, 3);
    // shoot spans 5000–9000 → active at 7000; defense (abs 50000–70000) is not.
    expect(getByTestId('timeline-seg-shoot-0').getAttribute('data-active')).toBe('true');
    expect(getByTestId('timeline-seg-defense-0').getAttribute('data-active')).toBeNull();
  });

  it('renders a playhead but no active segment when the time is in a gap', () => {
    const { getByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} currentTimeMs={100000} />,
    );
    expect(getByTestId('timeline-playhead')).toBeTruthy();
    expect(getByTestId('timeline-seg-shoot-0').getAttribute('data-active')).toBeNull();
  });

  it('ignores a non-finite currentTimeMs (no playhead)', () => {
    const { queryByTestId } = render(
      <TeamTimeline report={row({ fuel_bursts: [shoot] })} currentTimeMs={NaN} />,
    );
    expect(queryByTestId('timeline-playhead')).toBeNull();
  });

  it('shows an empty state for a legacy report with no timestamped data', () => {
    const { getByTestId, queryByTestId } = render(<TeamTimeline report={row({})} />);
    expect(getByTestId('timeline-empty')).toBeTruthy();
    expect(queryByTestId('timeline-track')).toBeNull();
  });

  it('falls back to a fuel_by_shift mini-bar when no timeline but shift data exists', () => {
    const { getByTestId } = render(
      <TeamTimeline report={row({ fuel_by_shift: [2, 5, 1, 0] })} />,
    );
    expect(getByTestId('timeline-empty')).toBeTruthy();
    const fallback = getByTestId('timeline-shift-fallback');
    expect(within(fallback).getAllByTestId(/timeline-shift-bar-/).length).toBe(4);
  });
});
