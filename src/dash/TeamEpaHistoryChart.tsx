import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from 'recharts';
import { useLayoutEffect, useRef } from 'react';
import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import type { LocalEpaHistoryPoint } from '@/dash/localEpa';

const TRACE = '#22d3ee';
const GRID = '#27272a';
const AXIS = '#a1a1aa';

interface ChartPoint extends LocalEpaHistoryPoint {
  index: number;
  matchLabel: string;
}

function compactMatchLabel(matchKey: string): string {
  return formatMatchKeyRaw(matchKey)
    .replace(/^Qual\s+/i, 'Q')
    .replace(/^Quarterfinal\s+/i, 'QF ')
    .replace(/^Semifinal\s+/i, 'SF ')
    .replace(/^Final\s+/i, 'F ');
}

function EpaTooltip({
  active,
  payload,
}: TooltipContentProps<TooltipValueType, string | number>): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-xl">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
        {point.eventKey}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-zinc-100">{point.matchLabel}</div>
      <div className="mt-1 font-mono text-lg font-bold tabular-nums text-cyan-300">
        {point.value.toFixed(1)} EPA
      </div>
    </div>
  );
}

export interface TeamEpaHistoryChartProps {
  teamNumber: number;
  points: LocalEpaHistoryPoint[];
}

export default function TeamEpaHistoryChart({
  teamNumber,
  points,
}: TeamEpaHistoryChartProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const data: ChartPoint[] = points.map((point, index) => ({
    ...point,
    index,
    matchLabel: compactMatchLabel(point.matchKey),
  }));
  const latest = data.at(-1)?.value ?? null;
  const first = data[0]?.value ?? null;
  const change = latest != null && first != null ? latest - first : null;
  const stride = Math.max(1, Math.ceil(data.length / 10));
  const ticks = data
    .filter((_, index) => index % stride === 0 || index === data.length - 1)
    .map((point) => point.index);
  const eventStarts = data.filter(
    (point, index) => index === 0 || point.eventKey !== data[index - 1]?.eventKey,
  );

  // Strategy work starts with current form. Open at the newest match while
  // preserving normal horizontal scrolling back through earlier events.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  }, [teamNumber, data.length]);

  return (
    <Card className="overflow-hidden border-zinc-800 bg-zinc-950" data-testid="team-epa-history">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <TrendingUp className="size-5 text-cyan-300" />
            EPA progression
          </CardTitle>
          <p className="mt-1 text-xs text-zinc-400">
            In-house EPA after every played match · scroll to inspect the full season
          </p>
        </div>
        {latest != null ? (
          <div className="flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-2xl font-bold text-cyan-300">{latest.toFixed(1)}</span>
            {change != null ? (
              <span className={change >= 0 ? 'text-xs text-success' : 'text-xs text-warning'}>
                {change >= 0 ? '+' : ''}{change.toFixed(1)} since first match
              </span>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div
            data-testid="team-epa-history-empty"
            className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-zinc-800 px-4 text-center text-sm text-zinc-500"
          >
            EPA progression appears after this team completes a match.
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="overflow-x-auto pb-2"
            data-testid="team-epa-history-scroll"
          >
            <div className="h-72 w-full" style={{ minWidth: Math.max(620, data.length * 24) }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 28, right: 18, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="2 5" vertical={false} />
                  <XAxis
                    type="number"
                    dataKey="index"
                    domain={[0, Math.max(0, data.length - 1)]}
                    ticks={ticks}
                    tickFormatter={(index) => data[Math.round(index)]?.matchLabel ?? ''}
                    tick={{ fill: AXIS, fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                  />
                  <YAxis
                    dataKey="value"
                    domain={['auto', 'auto']}
                    width={42}
                    tick={{ fill: AXIS, fontSize: 10 }}
                    tickFormatter={(value) => String(Math.round(Number(value)))}
                    tickLine={false}
                    axisLine={false}
                  />
                  {eventStarts.map((point) => (
                    <ReferenceLine
                      key={`${point.eventKey}-${point.index}`}
                      x={point.index}
                      stroke="#52525b"
                      strokeDasharray="3 5"
                      label={{
                        value: point.eventKey,
                        position: 'insideTopRight',
                        fill: AXIS,
                        fontSize: 9,
                      }}
                    />
                  ))}
                  <Tooltip
                    content={(tooltipProps) => <EpaTooltip {...tooltipProps} />}
                    cursor={{ stroke: '#71717a', strokeDasharray: '3 3' }}
                  />
                  <Line
                    type="linear"
                    dataKey="value"
                    name="EPA"
                    stroke={TRACE}
                    strokeWidth={3}
                    dot={{ r: 4, fill: '#09090b', stroke: TRACE, strokeWidth: 2 }}
                    activeDot={{ r: 7, fill: TRACE, stroke: '#cffafe', strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <ol className="sr-only" aria-label={`Team ${teamNumber} EPA progression by match`}>
              {data.map((point) => (
                <li key={point.matchKey}>
                  {point.eventKey}, {point.matchLabel}: {point.value.toFixed(1)} EPA
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
