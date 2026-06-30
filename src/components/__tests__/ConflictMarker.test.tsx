// src/components/__tests__/ConflictMarker.test.tsx
// Render tests for the ConflictMarker badge: tone/icon per severity tier, chip
// vs icon variants, and the inline click-toggled divergence detail + title.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import ConflictMarker from '@/components/ConflictMarker';
import type { MultiScoutGroup, ConflictSeverity, ConflictDivergences } from '@/dash/types';
import type { MsrRow } from '@/dash/types';

function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 1678,
    match_key: 'evt_qm1',
    alliance_color: 'blue',
    station: 2,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: 1,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: false,
    auto_climb_level1: false,
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

function group(severity: ConflictSeverity, div: Partial<ConflictDivergences> = {}): MultiScoutGroup {
  const divergences: ConflictDivergences = {
    fuel_spread: 0,
    climb_success_divergent: false,
    climb_level_spread: 0,
    defense_spread: 0,
    no_show_divergent: false,
    died_divergent: false,
    tipped_divergent: false,
    comparable_metric_count: 6,
    ...div,
  };
  return {
    matchKey: 'evt_qm1',
    teamNumber: 1678,
    allianceColor: 'blue',
    station: 2,
    reports: [
      row({ scout_id: 'a', fuel_points: 14, climb_success: true, climb_level: 3 }),
      row({ scout_id: 'b', fuel_points: 8, climb_success: false, climb_level: 0 }),
    ],
    scoutIds: ['a', 'b'],
    severity,
    isConflicted: severity === 'minor' || severity === 'severe',
    divergences,
  };
}

afterEach(cleanup);

describe('ConflictMarker', () => {
  it('renders a severe group with destructive tone + AlertTriangle', () => {
    const { getByTestId, container } = render(
      <ConflictMarker group={group('severe', { fuel_spread: 6, climb_success_divergent: true })} />,
    );
    const marker = getByTestId('conflict-marker');
    expect(marker.getAttribute('data-severity')).toBe('severe');
    expect(marker.innerHTML).toContain('text-destructive');
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders a minor group with warning tone', () => {
    const { getByTestId } = render(<ConflictMarker group={group('minor', { fuel_spread: 5 })} />);
    const marker = getByTestId('conflict-marker');
    expect(marker.getAttribute('data-severity')).toBe('minor');
    expect(marker.innerHTML).toContain('text-warning');
  });

  it('renders an agree group with a neutral/muted tone (no alarm)', () => {
    const { getByTestId } = render(<ConflictMarker group={group('agree')} />);
    const marker = getByTestId('conflict-marker');
    expect(marker.getAttribute('data-severity')).toBe('agree');
    expect(marker.innerHTML).toContain('text-muted-foreground');
  });

  it('renders an unknown group with a dashed/muted insufficient-data tone', () => {
    const { getByTestId } = render(
      <ConflictMarker group={group('unknown', { comparable_metric_count: 3 })} />,
    );
    const marker = getByTestId('conflict-marker');
    expect(marker.getAttribute('data-severity')).toBe('unknown');
    expect(marker.innerHTML).toContain('border-dashed');
  });

  it('chip variant shows "2 scouts"; icon variant shows the icon only', () => {
    const { getByTestId: chipGet } = render(
      <ConflictMarker group={group('severe', { fuel_spread: 6 })} variant="chip" />,
    );
    expect(chipGet('conflict-marker').textContent).toContain('2 scouts');
    cleanup();
    const { getByTestId: iconGet } = render(
      <ConflictMarker group={group('severe', { fuel_spread: 6 })} variant="icon" />,
    );
    expect(iconGet('conflict-marker').textContent).not.toContain('scouts');
  });

  it('reveals the inline divergence detail when clicked, and carries a title summary', () => {
    const g = group('severe', { fuel_spread: 6 });
    const { getByTestId, queryByTestId, container } = render(<ConflictMarker group={g} />);
    // No detail until toggled.
    expect(queryByTestId('conflict-marker-detail')).toBeNull();
    const toggle = container.querySelector('[role="button"]') as HTMLElement;
    expect(toggle.getAttribute('title')).toContain('Fuel: 14 vs 8 pts');
    fireEvent.click(toggle);
    expect(getByTestId('conflict-marker-detail').textContent).toContain('Fuel: 14 vs 8 pts');
  });

  it('shows the detail immediately when showDetail is set', () => {
    const { getByTestId } = render(
      <ConflictMarker group={group('severe', { fuel_spread: 6 })} showDetail />,
    );
    expect(getByTestId('conflict-marker-detail').textContent).toContain('Fuel: 14 vs 8 pts');
  });
});
