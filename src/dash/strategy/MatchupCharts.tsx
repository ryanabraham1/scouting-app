// src/dash/strategy/MatchupCharts.tsx
// The recharts-powered graphics of the matchup dashboard: an alliance-profile
// radar (red vs blue overlay) and a per-team expected-contribution stacked bar.
// Split into its own module and loaded via React.lazy from MatchupDashboard so
// recharts (~145 KB gzip) rides in its own precached chunk — scout screens and
// the whiteboard never pay for it.

import {
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';

// Theme-matched literals (SVG presentation attributes can't resolve var()).
const AXIS = '#8b93a7';
const GRID = '#2e374d';
const RED = '#ef4444';
const BLUE = '#3b82f6';
const AMBER = '#f59e0b';
const SEG = { auto: '#22d3ee', teleop: '#f59e0b', climb: '#22c55e' } as const;

export interface RadarDatum {
  metric: string;
  /** Normalized 0–100 per axis (max of the two alliances = 100). */
  red: number;
  blue: number;
}

export interface ContribDatum {
  team: string; // team number as string (category axis)
  side: 'red' | 'blue';
  isBase: boolean;
  auto: number;
  teleop: number;
  climb: number;
}

export interface MatchupChartsProps {
  radar: RadarDatum[];
  contrib: ContribDatum[];
}

/** Category tick colored by alliance (amber for the base team). */
function TeamTick(props: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  data: ContribDatum[];
}): JSX.Element {
  const { x = 0, y = 0, payload, data } = props;
  const d = data.find((c) => c.team === payload?.value);
  const fill = d?.isBase ? AMBER : d?.side === 'red' ? RED : BLUE;
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fontSize={12}
      fontWeight={700}
      fill={fill}
      fontFamily="'JetBrains Mono Variable', ui-monospace, monospace"
    >
      {payload?.value}
    </text>
  );
}

export default function MatchupCharts({ radar, contrib }: MatchupChartsProps): JSX.Element {
  return (
    <div
      data-testid="matchup-charts"
      className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_1.3fr]"
    >
      {/* Alliance profile radar — the "shape" of each alliance at a glance. */}
      <figure className="m-0 flex min-h-[240px] flex-col" aria-label="Alliance profile radar">
        <figcaption className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Alliance profile
        </figcaption>
        <div className="min-h-[220px] flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radar} outerRadius="72%">
              <PolarGrid stroke={GRID} />
              <PolarAngleAxis
                dataKey="metric"
                tick={{ fill: AXIS, fontSize: 11 }}
              />
              <Radar
                name="Red"
                dataKey="red"
                stroke={RED}
                fill={RED}
                fillOpacity={0.28}
                strokeWidth={2}
              />
              <Radar
                name="Blue"
                dataKey="blue"
                stroke={BLUE}
                fill={BLUE}
                fillOpacity={0.28}
                strokeWidth={2}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, color: AXIS }}
                iconType="circle"
                iconSize={8}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </figure>

      {/* Expected contribution — stacked auto/teleop/climb per team. */}
      <figure className="m-0 flex min-h-[240px] flex-col" aria-label="Expected contribution by team">
        <figcaption className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Expected points by team
        </figcaption>
        <div className="min-h-[220px] flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={contrib} layout="vertical" margin={{ left: 8, right: 16, top: 4 }}>
              <XAxis
                type="number"
                tick={{ fill: AXIS, fontSize: 11 }}
                stroke={GRID}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="team"
                width={52}
                tickLine={false}
                stroke={GRID}
                tick={<TeamTick data={contrib} />}
              />
              <Tooltip
                cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }}
                contentStyle={{
                  background: '#0f1524',
                  border: '1px solid #2e374d',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: '#e2e8f0', fontWeight: 700 }}
                formatter={(value, name) => [Math.round(Number(value ?? 0)), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} iconType="circle" iconSize={8} />
              <Bar dataKey="auto" name="Auto" stackId="pts" fill={SEG.auto} radius={[2, 0, 0, 2]} />
              <Bar dataKey="teleop" name="Teleop" stackId="pts" fill={SEG.teleop} />
              <Bar dataKey="climb" name="Climb" stackId="pts" fill={SEG.climb} radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </figure>
    </div>
  );
}
