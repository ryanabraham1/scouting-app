// Isolated offline browser fixture. Uses the production board with all network
// disabled and a synthetic event; never changes the active event or live data.
import React, { Profiler, useRef, useState } from 'react';
import type { BoardEditor } from '../../src/dash/board/editor';
import type { MsrRow } from '../../src/dash/types';
import { rowToTeamPit } from '../../src/dash/useTeamPit';
import type { MatchRow } from '../../src/dash/useEventData';
import type { Shape } from '../../src/dash/board/model';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { supabase } from '../../src/lib/supabase';
import { db } from '../../src/db/localStore';
import RyansBoard from '../../src/dash/board/RyansBoard';
import '../../src/index.css';

if (!import.meta.env.DEV) throw new Error('Development fixture only');
Object.defineProperty(navigator, 'onLine', { get: () => false });
onlineManager.setOnline(false);
// Realtime does not consult navigator.onLine. Stub it before mounting.
const channel = { on: () => channel, subscribe: () => channel, track: async () => 'ok', send: async () => 'ok', presenceState: () => ({}) };
supabase.channel = (() => channel) as unknown as typeof supabase.channel;
supabase.removeChannel = (async () => 'ok') as typeof supabase.removeChannel;
const performanceMode = new URLSearchParams(location.search).has('perf');
const eventKey = performanceMode ? '_ryans_board_perf_fixture' : '_ryans_board_fixture';
// Keep synthetic records out of the real application's global outbox if this
// browser later navigates from the fixture to the dashboard.
db.boardRecords.hook('creating', (_key, row) => { if (row.boardKey === eventKey) row.syncState = 'synced'; });
db.boardRecords.hook('updating', (_changes, _key, row) => row.boardKey === eventKey ? { syncState: 'synced' as const } : undefined);
await db.boardRecords.where('boardKey').equals(eventKey).modify({ syncState: 'synced' });
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
(window as unknown as { __boardQueryClient?: typeof client }).__boardQueryClient = client;
client.setQueryData(['teams', eventKey], [{ team_number: 254, nickname: 'The Cheesy Poofs' }, { team_number: 3256, nickname: 'WarriorBorgs' }]);
const matches: MatchRow[] = [1, 2].map((n) => ({
  match_key: `${eventKey}_qm${n}`, event_key: eventKey, comp_level: 'qm', match_number: n,
  scheduled_time: null, red1: 254, red2: 971, red3: 604, blue1: 3256, blue2: 1678, blue3: 581,
  actual_red_score: n === 1 ? 120 : null, actual_blue_score: n === 1 ? 110 : null,
  winner: n === 1 ? 'red' : null, result_synced_at: null,
}));
const report: MsrRow = {
  id: 'fixture-report', target_team_number: 254, match_key: matches[0].match_key, alliance_color: 'red', station: 1,
  auto_fuel: 20, teleop_fuel_active: 50, teleop_fuel_inactive: 0, endgame_fuel: 10, fuel_points: 80,
  fuel_estimate_confidence: 0.3, fuel_by_shift: [15, 15, 10, 10], auto_left_starting_line: true,
  defense_rating: 4, pins: 1, no_show: false, died: false, tipped: false, dropped_fuel: false, fed_corral: false,
  auto_start_position: { x: 0.2, y: 0.4 }, auto_path: [{ x: 0.2, y: 0.4 }, { x: 0.4, y: 0.6 }],
  scout_id: 'fixture-scout', notes: 'Strong defense in the feed lane.', server_received_at: '2026-10-19T18:00:00Z', deleted: false,
};
client.setQueryData(['matches', eventKey], matches);
client.setQueryData(['reports', eventKey], [report]);
client.setQueryData(['scouts', eventKey], [{ id: 'fixture-scout', display_name: 'Fixture Scout', event_key: eventKey }]);
client.setQueryData(['event-pits', eventKey], new Map([[254, rowToTeamPit({ event_key: eventKey, team_number: 254, drivetrain: 'swerve', notes: 'Fast floor pickup; fits under the trench.' })]]));
client.setQueryData(['matchup-notes', eventKey], new Map([[`${eventKey}:-1:254`, 'Protect the feed lane.']]));
client.setQueryData(['tba', 'match', matches[0].match_key], { videos: [] });
function Fixture(): JSX.Element {
  const measurement = useRef({ running: false, commits: 0, total: 0 });
  const [result, setResult] = useState('Ready');
  const measure = (): void => {
    const e = (window as unknown as { __ryansBoard: BoardEditor }).__ryansBoard;
    const shapes: Shape[] = Array.from({ length: 300 }, (_, i) => i < 60 ? {
      id: `perf:${i}`, type: 'widget', kind: 'team', config: { team: i % 2 ? 254 : 3256 },
      x: (i % 10) * 350, y: Math.floor(i / 10) * 320, w: 320, h: 290, z: i, rev: 1, by: 'fixture',
    } : {
      id: `perf:${i}`, type: 'ink', points: Array.from({ length: 100 }, (_, n) => [n * 2, 20 + Math.sin(n / 5) * 20, 0.5]), color: 'blue', size: 'm',
      x: (i % 20) * 160, y: Math.floor(i / 20) * 140, w: 205, h: 50, z: i, rev: 1, by: 'fixture',
    });
    e.load(shapes);
    e.setSelection([]);
    e.setCamera({ x: 30, y: 30, z: 0.4 });
    const frames: number[] = [];
    let previous = 0;
    let n = -15; // Warm up rasterization before collecting samples.
    measurement.current = { running: false, commits: 0, total: 0 };
    setResult('Measuring 300 shapes…');
    const frame = (at: number): void => {
      if (n === 0) measurement.current = { running: true, commits: 0, total: 0 };
      if (n > 0) frames.push(at - previous);
      previous = at;
      e.setCamera({ x: 30 + Math.sin(n / 12) * 150, y: 30 + Math.cos(n / 15) * 120, z: 0.4 + Math.sin(n / 24) * 0.04 });
      n += 1;
      if (n < 120) requestAnimationFrame(frame);
      else {
        measurement.current.running = false;
        const sorted = [...frames].sort((a, b) => a - b);
        setResult(`${(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)).toFixed(1)} FPS; p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms; React ${measurement.current.commits} commits / ${measurement.current.total.toFixed(1)} ms`);
      }
    };
    requestAnimationFrame(frame);
  };
  return <><Profiler id="board" onRender={(_id, _phase, duration) => { if (measurement.current.running) { measurement.current.commits += 1; measurement.current.total += duration; } }}><RyansBoard eventKey={eventKey} /></Profiler>{performanceMode && <div className="fixed bottom-1 left-1 z-[100] rounded border bg-card p-2 text-xs"><button onClick={measure}>Measure navigation</button><output className="ml-3">{result}</output></div>}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter><Fixture /></BrowserRouter></QueryClientProvider></React.StrictMode>);
