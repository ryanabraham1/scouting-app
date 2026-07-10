// src/dash/__tests__/ReportDetail.test.tsx
// REPORTDETAIL test. The full per-report drill-down must surface EVERY captured
// field: friendly match label, identity, fuel breakdown + confidence, climb,
// defense, fouls/flags, notes, and the read-only auto field diagram.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, within, fireEvent } from '@testing-library/react';
import type { MsrRow, MultiScoutGroup, ConflictSeverity } from '@/dash/types';
import ReportDetail from '@/dash/ReportDetail';

function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 254,
    match_key: '2026casnv_qm7',
    alliance_color: 'red',
    station: 2,
    auto_fuel: 3,
    teleop_fuel_active: 12,
    teleop_fuel_inactive: 4,
    endgame_fuel: 1,
    fuel_points: 22,
    fuel_estimate_confidence: 0.3,
    fuel_by_shift: [1, 2, 3, 4],
    climb_level: 3,
    climb_attempted: true,
    climb_success: true,
    auto_left_starting_line: true,
    auto_climb_level1: false,
    defense_rating: 8,
    driver_skill: 10,
    agility: 7,
    pins: 2,
    no_show: false,
    died: false,
    tipped: true,
    dropped_fuel: false,
    fed_corral: true,
    auto_start_position: { x: 0.3, y: 0.6 },
    auto_path: [
      { x: 0.3, y: 0.6 },
      { x: 0.5, y: 0.4 },
    ],
    scout_id: 's1',
    notes: 'fast cycler, strong defense',
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe('ReportDetail', () => {
  it('renders the friendly match label and identity', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} scoutName="Ada" />);
    const detail = getByTestId('report-detail');
    expect(getByTestId('report-match-label').textContent).toBe('Qual 7');
    expect(within(detail).getByText(/254/)).toBeTruthy();
    expect(within(detail).getByText(/Ada/)).toBeTruthy();
    expect(within(detail).getByText(/red 2/i)).toBeTruthy();
  });

  it('shows the full fuel breakdown and confidence', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} />);
    const detail = getByTestId('report-detail');
    const text = detail.textContent ?? '';
    expect(text).toContain('Auto fuel');
    expect(text).toContain('Teleop active');
    expect(text).toContain('Teleop inactive');
    expect(text).toContain('Endgame fuel');
    expect(text).toContain('Fuel points');
    // confidence 0.3 -> 30%
    expect(text).toContain('30%');
  });

  it('shows climb, defense, pins', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} />);
    const text = getByTestId('report-detail').textContent ?? '';
    expect(text).toContain('L3');
    expect(text).toContain('Defense rating');
    expect(text).toContain('8/10');
    expect(text).toContain('10/10');
    expect(text).toContain('7/10');
    expect(text).toContain('Pins');
  });

  it('renders every flag as a pill with the right on/off state', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} />);
    expect(getByTestId('report-flag-tipped').getAttribute('data-on')).toBe('true');
    expect(getByTestId('report-flag-fed-corral').getAttribute('data-on')).toBe('true');
    expect(getByTestId('report-flag-no-show').getAttribute('data-on')).toBe('false');
    expect(getByTestId('report-flag-died').getAttribute('data-on')).toBe('false');
    expect(getByTestId('report-flag-dropped-fuel').getAttribute('data-on')).toBe('false');
  });

  it('shows foul-reason tags with friendly labels when present', () => {
    const { getByTestId } = render(
      <ReportDetail report={row({ foul_reasons: ['pinning', 'opponent_contact'] })} />,
    );
    const tags = getByTestId('report-foul-reasons');
    expect(tags.textContent).toContain('Pinning');
    expect(tags.textContent).toContain('Contact in opp. zone');
  });

  it('omits the foul-reason tags when none were recorded', () => {
    const { queryByTestId } = render(<ReportDetail report={row({ foul_reasons: [] })} />);
    expect(queryByTestId('report-foul-reasons')).toBeNull();
  });

  it('shows the notes when present', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} />);
    expect(getByTestId('report-notes').textContent).toContain('fast cycler');
  });

  it('shows a notes empty state when notes are null', () => {
    const { getByTestId } = render(<ReportDetail report={row({ notes: null })} />);
    expect(getByTestId('report-notes-empty')).toBeTruthy();
  });

  it('renders the read-only field diagram when an auto path/start exists', () => {
    const { getByTestId } = render(<ReportDetail report={row({})} />);
    const field = getByTestId('report-field');
    expect(field).toBeTruthy();
    expect(field.getAttribute('data-mode')).toBe('view');
  });

  it('shows an empty field state when no auto start/path was recorded', () => {
    const { getByTestId, queryByTestId } = render(
      <ReportDetail report={row({ auto_start_position: null, auto_path: null })} />,
    );
    expect(getByTestId('report-field-empty')).toBeTruthy();
    expect(queryByTestId('report-field')).toBeNull();
  });

  it('falls back to "unassigned" when there is no scout', () => {
    const { getByTestId } = render(<ReportDetail report={row({ scout_id: null })} />);
    expect(getByTestId('report-detail').textContent).toContain('unassigned');
  });

  // --- Multi-scout conflict banner (multi-scout-reconciliation) -------------
  function group(severity: ConflictSeverity, reports: MsrRow[]): MultiScoutGroup {
    return {
      matchKey: '2026casnv_qm7',
      teamNumber: 254,
      allianceColor: 'red',
      station: 2,
      reports,
      scoutIds: reports.map((r) => r.scout_id ?? null),
      severity,
      isConflicted: severity === 'minor' || severity === 'severe',
      divergences: {
        fuel_spread: 6,
        climb_success_divergent: true,
        climb_level_spread: 0,
        defense_spread: 0,
        no_show_divergent: false,
        died_divergent: false,
        tipped_divergent: false,
        comparable_metric_count: 6,
      },
    };
  }

  const a = row({ scout_id: 'a', fuel_points: 14, climb_success: true, climb_level: 3 });
  const b = row({ scout_id: 'b', fuel_points: 8, climb_success: false, climb_level: 0 });

  it('renders the conflict banner + a sibling button per sibling, and fires onOpenSibling', () => {
    const onOpenSibling = vi.fn();
    const { getByTestId } = render(
      <ReportDetail
        report={a}
        scoutName="Ada"
        conflictGroup={group('severe', [a, b])}
        siblingName={(id) => (id === 'b' ? 'Bria' : 'Ada')}
        onOpenSibling={onOpenSibling}
      />,
    );
    const banner = getByTestId('report-conflict');
    expect(banner.getAttribute('data-scout-id')).toBe('a');
    // One sibling button for the OTHER scout (b), labelled with the name.
    const siblingBtn = getByTestId('report-conflict-sibling-b');
    expect(siblingBtn.textContent).toContain('Bria');
    fireEvent.click(siblingBtn);
    expect(onOpenSibling).toHaveBeenCalledWith(b);
  });

  it('renders no banner when no conflictGroup is passed (back-compat)', () => {
    const { queryByTestId } = render(<ReportDetail report={row({})} scoutName="Ada" />);
    expect(queryByTestId('report-conflict')).toBeNull();
  });

  it('renders no banner for a non-conflicted (agree) group', () => {
    const { queryByTestId } = render(
      <ReportDetail report={a} conflictGroup={group('agree', [a, b])} />,
    );
    expect(queryByTestId('report-conflict')).toBeNull();
  });

  it('renders no banner for an unknown group', () => {
    const { queryByTestId } = render(
      <ReportDetail report={a} conflictGroup={group('unknown', [a, b])} />,
    );
    expect(queryByTestId('report-conflict')).toBeNull();
  });
});
