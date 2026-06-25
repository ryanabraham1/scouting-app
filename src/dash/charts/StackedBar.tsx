// src/dash/charts/StackedBar.tsx
// Dependency-free, responsive (viewBox) SVG stacked bar chart. Each category
// (e.g. a scouted match) has an array of series values stacked on top of each
// other — used for fuel-by-shift. Renders the shared EmptyChart when <2 bars.

import { CHART_COLORS, MIN_POINTS, SERIES_PALETTE, type ChartColorKey } from './chartColors';
import { EmptyChart } from './EmptyChart';

export interface StackedDatum {
  label: string;
  /** One value per series; index aligns with `seriesNames`/palette. */
  values: number[];
}

export interface StackedBarProps {
  data: StackedDatum[];
  /** Series labels for the legend; length should match `values[]`. */
  seriesNames?: string[];
  /** Token colors per series; defaults to the shared SERIES_PALETTE rotation. */
  colors?: ChartColorKey[];
  title?: string;
  yTicks?: number;
  testid?: string;
  emptyMessage?: string;
}

const VB_W = 320;
const VB_H = 180;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 30;

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function StackedBar({
  data,
  seriesNames,
  colors,
  title,
  yTicks = 4,
  testid,
  emptyMessage,
}: StackedBarProps): JSX.Element {
  if (data.length < MIN_POINTS) {
    return <EmptyChart testid={testid} message={emptyMessage} />;
  }

  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));

  const palette = colors ?? SERIES_PALETTE;
  const slot = plotW / data.length;
  const barW = Math.max(2, slot * 0.62);

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (max / yTicks) * i);
  const yFor = (v: number) => PAD_T + plotH - (max === 0 ? 0 : (v / max) * plotH);

  const seriesCount = Math.max(0, ...data.map((d) => d.values.length));

  // Thin dense x-axis labels so they don't collide on a 390px phone: show every
  // Nth label, always keeping the first and last.
  const labelStride = Math.ceil(data.length / 8);
  const showLabel = (i: number) => i % labelStride === 0 || i === data.length - 1;

  return (
    <figure data-testid={testid} className="m-0 w-full" role="group" aria-label={title}>
      {title ? (
        <figcaption className="mb-1 text-sm font-medium text-muted-foreground">{title}</figcaption>
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
              <text x={PAD_L - 4} y={y + 3} textAnchor="end" fontSize={9} fill={CHART_COLORS.axis}>
                {Math.round(t)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          let acc = 0;
          return (
            <g key={`${d.label}-${i}`} data-testid={testid ? `${testid}-stack-${i}` : undefined}>
              {d.values.map((v, s) => {
                const h = max === 0 ? 0 : (v / max) * plotH;
                const yTop = PAD_T + plotH - (acc / max) * plotH - h;
                acc += v;
                const colorKey = palette[s % palette.length];
                return (
                  <rect
                    key={s}
                    x={x}
                    y={yTop}
                    width={barW}
                    height={Math.max(0, h)}
                    fill={CHART_COLORS[colorKey]}
                    data-testid={testid ? `${testid}-seg-${i}-${s}` : undefined}
                  >
                    <title>{`${d.label} · ${seriesNames?.[s] ?? `series ${s + 1}`}: ${v}`}</title>
                  </rect>
                );
              })}
              {showLabel(i) ? (
                <text
                  x={x + barW / 2}
                  y={VB_H - PAD_B + 12}
                  textAnchor="middle"
                  fontSize={8}
                  fill={CHART_COLORS.axis}
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {Array.from({ length: seriesCount }, (_, s) => {
          const colorKey = palette[s % palette.length];
          return (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: CHART_COLORS[colorKey] }}
              />
              {seriesNames?.[s] ?? `Shift ${s + 1}`}
            </span>
          );
        })}
      </div>
    </figure>
  );
}

export default StackedBar;
