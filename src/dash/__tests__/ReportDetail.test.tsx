// src/dash/__tests__/ReportDetail.test.tsx
// REPORTDETAIL test. The full per-report drill-down must surface EVERY captured
// field: friendly match label, identity, fuel breakdown + confidence, climb,
// defense, fouls/flags, notes, and the read-only auto field diagram.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
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
    defense_rating: 4,
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
});
