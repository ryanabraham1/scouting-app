// src/dash/charts/__tests__/charts.test.tsx
// Unit tests for the dependency-free SVG chart set: render with data, render the
// shared empty state with <2 points, and basic geometry/series sanity.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { BarChart } from '@/dash/charts/BarChart';
import { LineChart } from '@/dash/charts/LineChart';
import { StackedBar } from '@/dash/charts/StackedBar';
import { EmptyChart } from '@/dash/charts/EmptyChart';
import { NOT_ENOUGH_DATA } from '@/dash/charts/chartColors';

beforeEach(() => cleanup());

describe('EmptyChart', () => {
  it('renders the shared not-enough-data copy', () => {
    const { getByText } = render(<EmptyChart testid="ec" />);
    expect(getByText(NOT_ENOUGH_DATA)).toBeTruthy();
  });
});

describe('BarChart', () => {
  const data = [
    { label: 'Qual 1', value: 10 },
    { label: 'Qual 2', value: 20 },
    { label: 'Qual 3', value: 5 },
  ];

  it('renders a responsive SVG with one bar per datum', () => {
    const { getByTestId } = render(<BarChart data={data} testid="bc" title="Fuel" />);
    const svg = within(getByTestId('bc')).getByRole('img');
    expect(svg.getAttribute('viewBox')).toBeTruthy();
    expect(svg.getAttribute('class')).toContain('w-full');
    for (let i = 0; i < data.length; i++) {
      expect(getByTestId(`bc-bar-${i}`)).toBeTruthy();
    }
  });

  it('shows the empty state with <2 points', () => {
    const { getByTestId, queryByTestId } = render(
      <BarChart data={[{ label: 'Qual 1', value: 10 }]} testid="bc" />,
    );
    expect(getByTestId('bc').getAttribute('data-chart-empty')).toBe('true');
    expect(queryByTestId('bc-bar-0')).toBeNull();
  });

  it('scales bar heights to the data (bigger value => taller bar)', () => {
    const { getByTestId } = render(<BarChart data={data} testid="bc" />);
    const h0 = Number(getByTestId('bc-bar-0').getAttribute('height'));
    const h1 = Number(getByTestId('bc-bar-1').getAttribute('height'));
    expect(h1).toBeGreaterThan(h0);
  });

  // Dense x-axes (a full qual schedule) thin their labels so they don't collide
  // into an unreadable smear on a 390px phone, while always keeping the first and
  // last labels for orientation. <=8 points keep every label (stride 1).
  it('renders every x-axis label when there are <=8 points', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ label: `Q${i + 1}`, value: i + 1 }));
    const { queryByText } = render(<BarChart data={eight} testid="bc" />);
    for (let i = 1; i <= 8; i++) {
      // exact match hits only the axis <text>, not the "Q1: 1" <title> tooltip
      expect(queryByText(`Q${i}`, { exact: true })).toBeTruthy();
    }
  });

  it('thins x-axis labels past 8 points but keeps the first and last', () => {
    // 12 points → stride = ceil(12/8) = 2 → show even indices + the last (Q12).
    const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `Q${i + 1}`, value: i + 1 }));
    const { queryByText, getByTestId } = render(<BarChart data={twelve} testid="bc" />);
    // All 12 bars still render — only the labels thin.
    for (let i = 0; i < 12; i++) expect(getByTestId(`bc-bar-${i}`)).toBeTruthy();
    expect(queryByText('Q1', { exact: true })).toBeTruthy(); // first
    expect(queryByText('Q12', { exact: true })).toBeTruthy(); // last
    expect(queryByText('Q2', { exact: true })).toBeNull(); // thinned (index 1)
    expect(queryByText('Q10', { exact: true })).toBeNull(); // thinned (index 9)
  });
});

describe('LineChart', () => {
  const data = [
    { label: 'Qual 1', value: 3 },
    { label: 'Qual 2', value: 1 },
    { label: 'Qual 3', value: 2 },
  ];

  it('renders a line path and a point per datum', () => {
    const { getByTestId } = render(<LineChart data={data} testid="lc" yMax={3} />);
    expect(getByTestId('lc-line').getAttribute('d')).toMatch(/^M /);
    for (let i = 0; i < data.length; i++) {
      expect(getByTestId(`lc-point-${i}`)).toBeTruthy();
    }
  });

  it('shows the empty state with <2 points', () => {
    const { getByTestId } = render(<LineChart data={[{ label: 'Qual 1', value: 3 }]} testid="lc" />);
    expect(getByTestId('lc').getAttribute('data-chart-empty')).toBe('true');
  });
});

describe('StackedBar', () => {
  const data = [
    { label: 'Qual 1', values: [1, 2, 3, 4] },
    { label: 'Qual 2', values: [4, 3, 2, 1] },
  ];

  it('renders one stack per datum with a segment per series', () => {
    const { getByTestId } = render(
      <StackedBar data={data} seriesNames={['S1', 'S2', 'S3', 'S4']} testid="sb" />,
    );
    expect(getByTestId('sb-stack-0')).toBeTruthy();
    expect(getByTestId('sb-stack-1')).toBeTruthy();
    expect(getByTestId('sb-seg-0-0')).toBeTruthy();
    expect(getByTestId('sb-seg-0-3')).toBeTruthy();
  });

  it('renders a legend with the series names', () => {
    const { getByText } = render(
      <StackedBar data={data} seriesNames={['Shift A', 'Shift B', 'Shift C', 'Shift D']} testid="sb" />,
    );
    expect(getByText('Shift A')).toBeTruthy();
    expect(getByText('Shift D')).toBeTruthy();
  });

  it('shows the empty state with <2 bars', () => {
    const { getByTestId } = render(
      <StackedBar data={[{ label: 'Qual 1', values: [1, 2] }]} testid="sb" />,
    );
    expect(getByTestId('sb').getAttribute('data-chart-empty')).toBe('true');
  });
});
