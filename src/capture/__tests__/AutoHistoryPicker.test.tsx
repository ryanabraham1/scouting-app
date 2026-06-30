import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutoHistoryPicker from '@/capture/AutoHistoryPicker';
import type { AutoPath } from '@/dash/AutoHeatmap';

// Two near-identical routines recorded on RED (one option) plus a clearly
// different one recorded on BLUE (a second option).
const REDISH_A: AutoPath = {
  matchKey: 'qm1',
  label: 'Qual 1',
  start: { x: 0.2, y: 0.3 },
  path: [
    { x: 0.2, y: 0.3 },
    { x: 0.3, y: 0.35 },
    { x: 0.4, y: 0.4 },
  ],
  alliance: 'red',
};
const REDISH_B: AutoPath = {
  matchKey: 'qm5',
  label: 'Qual 5',
  start: { x: 0.21, y: 0.31 },
  path: [
    { x: 0.21, y: 0.31 },
    { x: 0.31, y: 0.36 },
    { x: 0.41, y: 0.41 },
  ],
  alliance: 'red',
};
const FAR_BLUE: AutoPath = {
  matchKey: 'qm9',
  label: 'Qual 9',
  start: { x: 0.9, y: 0.9 },
  path: [
    { x: 0.9, y: 0.9 },
    { x: 0.7, y: 0.8 },
    { x: 0.5, y: 0.7 },
  ],
  alliance: 'blue',
};

describe('AutoHistoryPicker', () => {
  it('renders an empty hint when the team has no prior autos', () => {
    render(
      <AutoHistoryPicker autos={[]} alliance="red" selectedPath={null} onSelect={() => {}} />,
    );
    expect(screen.getByTestId('auto-history-empty')).toBeTruthy();
  });

  it('clusters routines into distinct options (jittered duplicates collapse)', () => {
    render(
      <AutoHistoryPicker
        autos={[REDISH_A, REDISH_B, FAR_BLUE]}
        alliance="blue"
        selectedPath={null}
        onSelect={() => {}}
      />,
    );
    // Three routines, two real shapes → two options.
    expect(screen.getByTestId('auto-history-opt-0')).toBeTruthy();
    expect(screen.getByTestId('auto-history-opt-1')).toBeTruthy();
    expect(screen.queryByTestId('auto-history-opt-2')).toBeNull();
  });

  it('re-frames a red-recorded routine onto a RED match unchanged (round-trip identity)', () => {
    const onSelect = vi.fn();
    render(
      <AutoHistoryPicker
        autos={[REDISH_A]}
        alliance="red"
        selectedPath={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('auto-history-opt-0'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    // red → (group in blue frame) → back to red = original absolute coords.
    expect(onSelect.mock.calls[0][0].start).toEqual({ x: 0.2, y: 0.3 });
    expect(onSelect.mock.calls[0][0].path[0]).toEqual({ x: 0.2, y: 0.3 });
  });

  it('rotates a red-recorded routine 180° when applied to a BLUE match', () => {
    const onSelect = vi.fn();
    render(
      <AutoHistoryPicker
        autos={[REDISH_A]}
        alliance="blue"
        selectedPath={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('auto-history-opt-0'));
    const applied = onSelect.mock.calls[0][0];
    // (x,y) → (1-x, 1-y): the red↔blue field rotation, not a horizontal flip.
    expect(applied.start.x).toBeCloseTo(0.8, 6);
    expect(applied.start.y).toBeCloseTo(0.7, 6);
  });

  it('marks the option whose re-framed path matches the report as Selected', () => {
    // The path the report would hold after picking option A on a RED match.
    render(
      <AutoHistoryPicker
        autos={[REDISH_A]}
        alliance="red"
        selectedPath={REDISH_A.path}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('auto-history-opt-0').getAttribute('aria-pressed')).toBe('true');
  });
});
