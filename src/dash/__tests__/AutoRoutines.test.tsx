// src/dash/__tests__/AutoRoutines.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import AutoRoutines from '@/dash/AutoRoutines';
import { OUR_TEAM } from '@/dash/constants';
import type { MsrRow } from '@/dash/types';

beforeEach(() => {
  cleanup();
});

/** Minimal MsrRow factory: fills required fields, override per test. */
function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 100,
    match_key: 'evt_qm1',
    alliance_color: 'red',
    station: 1,
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
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

describe('AutoRoutines', () => {
  const reports: MsrRow[] = [
    // Team 254: an older report, then a newer one — newest should win.
    row({
      target_team_number: 254,
      server_received_at: '2026-06-23T01:00:00Z',
      auto_start_position: { x: 0.1, y: 0.1 },
      auto_path: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
    }),
    row({
      target_team_number: 254,
      server_received_at: '2026-06-23T05:00:00Z',
      auto_start_position: { x: 0.9, y: 0.9 },
      auto_path: [
        { x: 0.9, y: 0.9 },
        { x: 0.8, y: 0.8 },
      ],
    }),
    // Our team 3256: has auto data, but should be omitted from OUR alliance.
    row({
      target_team_number: OUR_TEAM,
      server_received_at: '2026-06-23T02:00:00Z',
      auto_start_position: { x: 0.5, y: 0.5 },
      auto_path: [
        { x: 0.5, y: 0.5 },
        { x: 0.6, y: 0.6 },
      ],
    }),
  ];

  it('renders the auto-routines container', () => {
    const { getByTestId } = render(
      <AutoRoutines reports={reports} isOurAlliance={false} />
    );
    expect(getByTestId('auto-routines')).toBeTruthy();
    expect(getByTestId('auto-routines-field')).toBeTruthy();
  });

  it('omits OUR_TEAM (3256) when isOurAlliance is true', () => {
    const { container, queryByText } = render(
      <AutoRoutines reports={reports} isOurAlliance={true} />
    );
    // 254 should be present, 3256 omitted.
    expect(queryByText(String(OUR_TEAM))).toBeNull();
    expect(queryByText('254')).toBeTruthy();
    // One overlay polyline (only team 254).
    expect(
      container.querySelector('[data-testid="auto-routines-field-overlay-0"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="auto-routines-field-overlay-1"]')
    ).toBeNull();
  });

  it('includes OUR_TEAM (3256) when isOurAlliance is false', () => {
    const { queryByText, container } = render(
      <AutoRoutines reports={reports} isOurAlliance={false} />
    );
    expect(queryByText(String(OUR_TEAM))).toBeTruthy();
    expect(queryByText('254')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="auto-routines-field-overlay-0"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="auto-routines-field-overlay-1"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="auto-routines-field-overlay-2"]')
    ).toBeNull();
  });

  it('uses the latest-by-server_received_at report per team', () => {
    const { container } = render(
      <AutoRoutines reports={reports} isOurAlliance={true} />
    );
    // Only team 254 included; its newest report path is (0.9,0.9)->(0.8,0.8).
    const overlay = container.querySelector(
      '[data-testid="auto-routines-field-overlay-0"]'
    ) as SVGPolylineElement | null;
    expect(overlay).toBeTruthy();
    expect(overlay?.getAttribute('points')).toBe('0.9,0.9 0.8,0.8');
  });

  it('skips teams without any auto data', () => {
    const noAuto: MsrRow[] = [
      row({ target_team_number: 111, server_received_at: '2026-06-23T01:00:00Z' }),
      row({
        target_team_number: 222,
        server_received_at: '2026-06-23T01:00:00Z',
        auto_start_position: { x: 0.3, y: 0.3 },
      }),
    ];
    const { container, queryByText } = render(
      <AutoRoutines reports={noAuto} isOurAlliance={false} />
    );
    // 111 has no auto data -> skipped; 222 included.
    expect(queryByText('111')).toBeNull();
    expect(queryByText('222')).toBeTruthy();
    const starts = container.querySelectorAll(
      '[data-testid^="auto-routines-field-overlay-start-"]'
    );
    expect(starts.length).toBe(1);
  });

  it('renders an empty placeholder when there are no overlays', () => {
    const { getByTestId } = render(
      <AutoRoutines
        reports={[row({ target_team_number: 111 })]}
        isOurAlliance={false}
      />
    );
    expect(getByTestId('auto-routines-empty')).toBeTruthy();
  });

  it('assigns distinct colors to each included team', () => {
    const { container } = render(
      <AutoRoutines reports={reports} isOurAlliance={false} />
    );
    const o0 = container.querySelector(
      '[data-testid="auto-routines-field-overlay-0"]'
    ) as SVGPolylineElement | null;
    const o1 = container.querySelector(
      '[data-testid="auto-routines-field-overlay-1"]'
    ) as SVGPolylineElement | null;
    expect(o0?.getAttribute('stroke')).toBeTruthy();
    expect(o1?.getAttribute('stroke')).toBeTruthy();
    expect(o0?.getAttribute('stroke')).not.toBe(o1?.getAttribute('stroke'));
  });
});
