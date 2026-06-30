// src/dash/__tests__/AutoHeatmap.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import AutoHeatmap, { consistency } from '@/dash/AutoHeatmap';
import { HEATMAP_BINS } from '@/components/HeatmapLayer';
import type { MsrRow } from '@/dash/types';

beforeEach(() => {
  cleanup();
  // FieldDiagram renders an <img>; nothing pointer-related is exercised here, but
  // jsdom lacks getBoundingClientRect dims — stub for determinism.
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

/** Minimal MsrRow factory (mirrors AutoRoutines.test.tsx). */
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

describe('AutoHeatmap', () => {
  it('renders the container and the heatmap <g> for a team with auto data', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
        auto_path: [
          { x: 0.5, y: 0.5 },
          { x: 0.6, y: 0.6 },
        ],
      }),
    ];
    const { getByTestId, container } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap')).toBeTruthy();
    // testid is `${testid}-heatmap` -> team-auto-heatmap-heatmap.
    expect(
      container.querySelector('[data-testid="team-auto-heatmap-heatmap"]'),
    ).toBeTruthy();
  });

  it('filters to the target team only (count line excludes other teams)', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
      row({
        target_team_number: 1678,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0.2, y: 0.2 },
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap-count').textContent).toMatch(
      /1 auto across 1 match/,
    );
  });

  it('flattens start positions AND path vertices and counts autos/matches', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
        auto_path: [
          { x: 0.5, y: 0.5 },
          { x: 0.7, y: 0.7 },
        ],
      }),
      row({
        target_team_number: 254,
        match_key: 'evt_qm2',
        auto_start_position: { x: 0.52, y: 0.5 },
        auto_path: [
          { x: 0.52, y: 0.5 },
          { x: 0.72, y: 0.7 },
        ],
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap-count').textContent).toMatch(
      /2 autos across 2 matches/,
    );
  });

  it('skips reports with null start AND empty/null path (shared hasAutoData)', () => {
    const reports = [
      row({ target_team_number: 254, match_key: 'evt_qm1' }), // null start, null path
      row({
        target_team_number: 254,
        match_key: 'evt_qm2',
        auto_path: [], // empty path counts as no auto data
      }),
      row({
        target_team_number: 254,
        match_key: 'evt_qm3',
        auto_start_position: { x: 0.4, y: 0.4 },
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap-count').textContent).toMatch(
      /1 auto across 1 match/,
    );
  });

  it('renders the empty state when the team has no auto data', () => {
    const reports = [
      row({ target_team_number: 254, match_key: 'evt_qm1' }),
      row({ target_team_number: 254, match_key: 'evt_qm2', auto_path: [] }),
    ];
    const { getByTestId, queryByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap-empty')).toBeTruthy();
    expect(queryByTestId('team-auto-heatmap-heatmap')).toBeNull();
  });

  it('consistency: identical=100, 0.5 apart≈0, 0.25 apart=50, <2 starts=null', () => {
    expect(
      consistency([
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toBe(100);
    expect(
      consistency([
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ]),
    ).toBe(0);
    expect(
      consistency([
        { x: 0.4, y: 0.5 },
        { x: 0.65, y: 0.5 },
      ]),
    ).toBe(50);
    expect(consistency([{ x: 0.5, y: 0.5 }])).toBeNull();
  });

  it('renders the consistency chip with the percentage', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
      row({
        target_team_number: 254,
        match_key: 'evt_qm2',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('team-auto-heatmap-consistency').textContent).toMatch(
      /100%/,
    );
  });

  it('mirror flips the heatmap circle cx (raw center mirrored at the boundary)', () => {
    // Single start at x=0 -> bin center 0.5/HEATMAP_BINS; with mirror cx ≈ 1 - that.
    const rawX = 0.5 / HEATMAP_BINS;
    const reports = [
      row({
        target_team_number: 254,
        match_key: 'evt_qm1',
        auto_start_position: { x: 0, y: 0 },
      }),
      row({
        target_team_number: 254,
        match_key: 'evt_qm2',
        auto_start_position: { x: 0, y: 0 },
      }),
    ];
    const { container } = render(
      <AutoHeatmap teamNumber={254} reports={reports} mirror />,
    );
    const circle = container.querySelector(
      '[data-testid="team-auto-heatmap-heatmap"] circle',
    ) as SVGCircleElement | null;
    expect(circle).toBeTruthy();
    expect(Number(circle!.getAttribute('cx'))).toBeCloseTo(1 - rawX, 6);
  });

  it('defaults to the heatmap view (heatmap g + count/consistency, no stepper)', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: '2026evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
    ];
    const { getByTestId, queryByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    expect(getByTestId('auto-mode-heatmap').getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(getByTestId('team-auto-heatmap-heatmap')).toBeTruthy();
    expect(getByTestId('team-auto-heatmap-count')).toBeTruthy();
    expect(queryByTestId('auto-path-step-label')).toBeNull();
  });

  it('switches to the per-path stepper and shows "Path N / total" with the match label', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: '2026evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
        auto_path: [
          { x: 0.5, y: 0.5 },
          { x: 0.6, y: 0.6 },
        ],
      }),
      row({
        target_team_number: 254,
        match_key: '2026evt_qm2',
        auto_start_position: { x: 0.4, y: 0.4 },
        auto_path: [
          { x: 0.4, y: 0.4 },
          { x: 0.7, y: 0.7 },
        ],
      }),
    ];
    const { getByTestId, queryByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    fireEvent.click(getByTestId('auto-mode-paths'));
    // heatmap g gone, stepper present.
    expect(queryByTestId('team-auto-heatmap-heatmap')).toBeNull();
    const label = getByTestId('auto-path-step-label');
    expect(label.textContent).toMatch(/Path 1 \/ 2/);
    expect(label.textContent).toMatch(/Qualification 1/);
    // the single current path is drawn as the diagram's primary polyline.
    expect(
      getByTestId('team-auto-heatmap').querySelector(
        '[data-testid="team-auto-heatmap-polyline"]',
      ),
    ).toBeTruthy();
  });

  it('steps next/prev through paths (and wraps around)', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: '2026evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
      row({
        target_team_number: 254,
        match_key: '2026evt_qm2',
        auto_start_position: { x: 0.4, y: 0.4 },
      }),
      row({
        target_team_number: 254,
        match_key: '2026evt_qm3',
        auto_start_position: { x: 0.3, y: 0.3 },
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    fireEvent.click(getByTestId('auto-mode-paths'));
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 1 \/ 3/,
    );
    fireEvent.click(getByTestId('auto-path-step-next'));
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 2 \/ 3/,
    );
    fireEvent.click(getByTestId('auto-path-step-next'));
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 3 \/ 3/,
    );
    fireEvent.click(getByTestId('auto-path-step-next')); // wraps to 1
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 1 \/ 3/,
    );
    fireEvent.click(getByTestId('auto-path-step-prev')); // wraps back to 3
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 3 \/ 3/,
    );
  });

  it('disables the stepper buttons when there is a single path (degrades gracefully)', () => {
    const reports = [
      row({
        target_team_number: 254,
        match_key: '2026evt_qm1',
        auto_start_position: { x: 0.5, y: 0.5 },
      }),
    ];
    const { getByTestId } = render(
      <AutoHeatmap teamNumber={254} reports={reports} />,
    );
    fireEvent.click(getByTestId('auto-mode-paths'));
    expect(getByTestId('auto-path-step-label').textContent).toMatch(
      /Path 1 \/ 1/,
    );
    expect(
      (getByTestId('auto-path-step-prev') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (getByTestId('auto-path-step-next') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
