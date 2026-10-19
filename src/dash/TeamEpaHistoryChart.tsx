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
        {point.value.toFixed(1)} BSR
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
  const data: ChartPoint[] = points.map((point, index) => ({
    ...point,
    index,
    matchLabel: compactMatchLabel(point.matchKey),
  }));
  const latest = data.at(-1)?.value ?? null;
  const previous = data.at(-2)?.value ?? null;
  const change = latest != null && previous != null ? latest - previous : null;
  const peak = data.length ? Math.max(...data.map((p) => p.value)) : null;
  const stride = Math.max(1, Math.ceil(data.length / 8));
  const ticks = data
    .filter((_, index) => index % stride === 0 || index === data.length - 1)
    .map((point) => point.index);
  const eventStarts = data.filter(
    (point, index) => index > 0 && point.eventKey !== data[index - 1]?.eventKey,
  );
  // The whole season fits the card width; dots only while they stay legible.
  const showDots = data.length <= 40;

  return (
    <Card className="overflow-hidden border-zinc-800 bg-zinc-950" data-testid="team-epa-history">
      <CardHeader className="space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <TrendingUp className="size-5 text-cyan-300" />
          BSR
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-1 sm:content-start">
          <EpaStat label="Current" value={latest == null ? '—' : latest.toFixed(1)} tone="text-cyan-300" />
          <EpaStat
            label="Last match"
            value={change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}`}
            tone={change == null ? 'text-zinc-100' : change >= 0 ? 'text-success' : 'text-warning'}
          />
          <EpaStat label="Season high" value={peak == null ? '—' : peak.toFixed(1)} tone="text-zinc-100" />
        </div>
        {data.length === 0 ? (
          <div
            data-testid="team-epa-history-empty"
            className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-zinc-800 px-4 text-center text-sm text-zinc-500"
          >
            No matches played yet.
          </div>
        ) : (
          <div className="h-52 w-full min-w-0" data-testid="team-epa-history-plot">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
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
                  width={36}
                  tick={{ fill: AXIS, fontSize: 10 }}
                  tickFormatter={(value) => String(Math.round(Number(value)))}
                  tickLine={false}
                  axisLine={false}
                />
                {eventStarts.map((point) => (
                  <ReferenceLine
                    key={`${point.eventKey}-${point.index}`}
                    x={point.index}
                    stroke="#3f3f46"
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
                  type="monotone"
                  dataKey="value"
                  name="BSR"
                  stroke={TRACE}
                  strokeWidth={2}
                  dot={showDots ? { r: 2.5, fill: '#09090b', stroke: TRACE, strokeWidth: 1.5 } : false}
                  activeDot={{ r: 5, fill: TRACE, stroke: '#cffafe', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <ol className="sr-only" aria-label={`Team ${teamNumber} BSR progression by match`}>
          {data.map((point) => (
            <li key={point.matchKey}>
              {point.eventKey}, {point.matchLabel}: {point.value.toFixed(1)} BSR
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function EpaStat(props: { label: string; value: string; tone: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <span className="truncate text-[11px] uppercase tracking-wide text-zinc-400">{props.label}</span>
      <span className={`font-mono text-lg font-semibold tabular-nums ${props.tone}`}>{props.value}</span>
    </div>
  );
}
