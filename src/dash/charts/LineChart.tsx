// src/dash/charts/LineChart.tsx
// Dependency-free, responsive (viewBox) SVG line chart / sparkline. One numeric
// series over labelled x categories (e.g. climb level or defense rating across a
// team's scouted matches). Renders the shared EmptyChart when given <2 points.

import { CHART_COLORS, MIN_POINTS, type ChartColorKey } from './chartColors';
import { EmptyChart } from './EmptyChart';

export interface LinePoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  data: LinePoint[];
  color?: ChartColorKey;
  title?: string;
  yTicks?: number;
  /** Fixed y-axis max (e.g. 3 for climb level); auto-scaled when omitted. */
  yMax?: number;
  testid?: string;
  emptyMessage?: string;
}

const VB_W = 320;
const VB_H = 180;
// Extra left room so 3-digit y-axis values (e.g. "120") don't clip the plot.
const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 30;

// Monospace so SVG axis labels read as instrument telemetry (matches font-mono).
const AXIS_FONT = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function LineChart({
  data,
  color = 'brand',
  title,
  yTicks = 4,
  yMax,
  testid,
  emptyMessage,
}: LineChartProps): JSX.Element {
  if (data.length < MIN_POINTS) {
    return <EmptyChart testid={testid} message={emptyMessage} />;
  }

  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;
  const rawMax = Math.max(0, ...data.map((d) => d.value));
  const max = yMax != null ? Math.max(yMax, rawMax) : niceMax(rawMax);

  const stroke = CHART_COLORS[color];
  const stepX = data.length === 1 ? 0 : plotW / (data.length - 1);
  const xFor = (i: number) => PAD_L + i * stepX;
  const yFor = (v: number) => PAD_T + plotH - (max === 0 ? 0 : (v / max) * plotH);

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (max / yTicks) * i);
  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(d.value)}`).join(' ');

  // Thin dense x-axis labels so they don't collide on a 390px phone: show every
  // Nth label, always keeping the first and last.
  const labelStride = Math.ceil(data.length / 8);
  const showLabel = (i: number) => i % labelStride === 0 || i === data.length - 1;

  return (
    <figure data-testid={testid} className="m-0 w-full" role="group" aria-label={title}>
      {title ? (
        <figcaption className="eyebrow mb-1">{title}</figcaption>
      ) : null}
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="block aspect-[16/9] w-full tabular-nums"
        role="img"
      >
        {ticks.map((t) => {
          const y = yFor(t);
          return (
            <g key={`y-${t}`}>
              <line
                x1={PAD_L}
                x2={VB_W - PAD_R}
                y1={y}
                y2={y}
                stroke={CHART_COLORS.border}
                strokeWidth={0.5}
              />
              <text
                x={PAD_L - 4}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fontFamily={AXIS_FONT}
                fill={CHART_COLORS.axis}
              >
                {Number.isInteger(max / yTicks) ? Math.round(t) : t.toFixed(1)}
              </text>
            </g>
          );
        })}

        <path
          d={linePath}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          data-testid={testid ? `${testid}-line` : undefined}
        />

        {data.map((d, i) => (
          <g key={`${d.label}-${i}`}>
            <circle
              cx={xFor(i)}
              cy={yFor(d.value)}
              r={2.5}
              fill={stroke}
              data-testid={testid ? `${testid}-point-${i}` : undefined}
            >
              <title>{`${d.label}: ${d.value}`}</title>
            </circle>
            {showLabel(i) ? (
              <text
                x={xFor(i)}
                y={VB_H - PAD_B + 12}
                textAnchor="middle"
                fontSize={8}
                fontFamily={AXIS_FONT}
                fill={CHART_COLORS.axis}
              >
                {d.label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export default LineChart;
