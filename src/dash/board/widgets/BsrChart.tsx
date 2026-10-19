// src/dash/board/widgets/BsrChart.tsx
// The BSR line chart used by the team card and the BSR history widget: a
// labelled points axis with nice ticks, first/last match labels on the x axis,
// the current value called out at the end of each line, and a legend when
// more than one team is plotted. Drawn in real pixels (measured with a
// ResizeObserver) so text never stretches when the card is resized.
import { useLayoutEffect, useRef, useState } from 'react';
import type { LocalEpaHistoryPoint } from '@/dash/localEpa';

export interface BsrSeries {
  team: number;
  points: LocalEpaHistoryPoint[];
}

export const SERIES_COLORS = ['hsl(199 89% 48%)', '#c084fc', '#fb923c', '#4ade80'];

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function shortMatch(key: string): string {
  const i = key.lastIndexOf('_');
  return i >= 0 ? key.slice(i + 1) : key;
}

function useSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function BsrChart({
  series,
  loading,
  emptyText = 'No matches played yet.',
  showLegend,
}: {
  series: BsrSeries[];
  loading?: boolean;
  emptyText?: string;
  showLegend?: boolean;
}): JSX.Element {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const plotted = series.filter((s) => s.points.length > 0);
  const values = plotted.flatMap((s) => s.points.map((p) => p.value));
  const legend = showLegend ?? series.length > 1;

  let body: JSX.Element | null = null;
  if (!values.length) {
    body = (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        {loading ? 'Loading BSR history…' : emptyText}
      </div>
    );
  } else if (w > 0 && h > 0) {
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const left = 34;
    const right = 40;
    const top = 6;
    const bottom = 16;
    const pw = Math.max(10, w - left - right);
    const ph = Math.max(10, h - top - bottom);
    const longest = Math.max(...plotted.map((s) => s.points.length));
    const X = (i: number, n: number): number => left + (n <= 1 ? pw : (i / (n - 1)) * pw);
    const Y = (v: number): number => top + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const ref0 = plotted.find((s) => s.points.length === longest) ?? plotted[0];
    body = (
      <svg width={w} height={h} className="block overflow-visible" role="img" aria-label="BSR over the season">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + pw} y1={Y(t)} y2={Y(t)} stroke="hsl(0 0% 16%)" strokeDasharray={t === lo ? undefined : '2 3'} />
            <text x={left - 6} y={Y(t)} dy="0.32em" textAnchor="end" className="tnum" fontSize={10} fill="hsl(0 0% 55%)">
              {Math.round(t)}
            </text>
          </g>
        ))}
        <text x={left} y={h - 3} fontSize={10} className="tnum" fill="hsl(0 0% 50%)">
          {shortMatch(ref0.points[0].matchKey)}
        </text>
        <text x={left + pw} y={h - 3} fontSize={10} textAnchor="end" className="tnum" fill="hsl(0 0% 50%)">
          {shortMatch(ref0.points[ref0.points.length - 1].matchKey)}
        </text>
        {plotted.map((s, si) => {
          const color = SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length];
          const n = s.points.length;
          const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(i, n).toFixed(1)},${Y(p.value).toFixed(1)}`).join('');
          const last = s.points[n - 1];
          const ly = Y(last.value);
          return (
            <g key={s.team}>
              {si === 0 && plotted.length === 1 && (
                <path d={`${d}L${X(n - 1, n)},${top + ph}L${X(0, n)},${top + ph}Z`} fill={color} opacity={0.08} />
              )}
              <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={si > 0 ? '5 3' : undefined} />
              <circle cx={X(n - 1, n)} cy={ly} r={3} fill={color} />
              <text x={X(n - 1, n) + 6} y={ly} dy="0.32em" fontSize={11} fontWeight={600} className="tnum" fill={color}>
                {last.value.toFixed(1)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {legend && (
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {series.map((s, i) => (
            <span key={s.team} className="tnum inline-flex items-center gap-1" style={{ color: SERIES_COLORS[i % SERIES_COLORS.length] }}>
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.team}
            </span>
          ))}
          <span className="ml-auto text-muted-foreground">BSR points per match</span>
        </div>
      )}
      <div ref={ref} className="relative min-h-0 flex-1">
        {body}
      </div>
    </div>
  );
}
