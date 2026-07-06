// src/dash/charts/BarChart.tsx
// Dependency-free, responsive (viewBox) SVG bar chart. One value per labelled
// category. Used for per-match metrics (e.g. fuel points across scouted
// matches). Renders the shared EmptyChart when given <2 points.

import { CHART_COLORS, MIN_POINTS, type ChartColorKey } from './chartColors';
import { EmptyChart } from './EmptyChart';

export interface BarDatum {
  /** X-axis category label (e.g. "Qual 12"). */
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  /** Token color for the bars. */
  color?: ChartColorKey;
  /** Accessible title/description for the chart. */
  title?: string;
  /** Number of horizontal gridlines / y-axis ticks. */
  yTicks?: number;
  testid?: string;
  emptyMessage?: string;
}

// viewBox geometry — width 100% via the parent; the viewBox keeps it crisp.
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

export function BarChart({
  data,
  color = 'brand',
  title,
  yTicks = 4,
  testid,
  emptyMessage,
}: BarChartProps): JSX.Element {
  if (data.length < MIN_POINTS) {
    return <EmptyChart testid={testid} message={emptyMessage} />;
  }

  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;
  const rawMax = Math.max(0, ...data.map((d) => d.value));
  const max = niceMax(rawMax);

  const slot = plotW / data.length;
  const barW = Math.max(2, slot * 0.62);
  const fill = CHART_COLORS[color];

  // Thin dense x-axis labels so they don't collide/smear on a 390px phone:
  // show every Nth label, always keeping the first and last.
  const labelStride = Math.ceil(data.length / 8);
  const showLabel = (i: number) => i % labelStride === 0 || i === data.length - 1;

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (max / yTicks) * i);
  const yFor = (v: number) => PAD_T + plotH - (v / max) * plotH;

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
        {/* Y gridlines + labels */}
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
                {Math.round(t)}
              </text>
            </g>
          );
        })}

        {/* Bars + x labels */}
        {data.map((d, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          const h = max === 0 ? 0 : (d.value / max) * plotH;
          const y = PAD_T + plotH - h;
          return (
            <g key={`${d.label}-${i}`}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, h)}
                fill={fill}
                rx={1.5}
                data-testid={testid ? `${testid}-bar-${i}` : undefined}
              >
                <title>{`${d.label}: ${d.value}`}</title>
              </rect>
              {showLabel(i) ? (
                <text
                  x={x + barW / 2}
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
          );
        })}
      </svg>
    </figure>
  );
}

export default BarChart;
