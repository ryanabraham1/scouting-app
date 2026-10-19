// Isolated offline browser fixture. Uses the production board with all network
// disabled and a synthetic event; never changes the active event or live data.
import React from 'react';
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
const eventKey = '_ryans_board_fixture';
// Keep synthetic records out of the real application's global outbox if this
// browser later navigates from the fixture to the dashboard.
db.boardRecords.hook('creating', (_key, row) => { if (row.boardKey === eventKey) row.syncState = 'synced'; });
db.boardRecords.hook('updating', (_changes, _key, row) => row.boardKey === eventKey ? { syncState: 'synced' as const } : undefined);
await db.boardRecords.where('boardKey').equals(eventKey).modify({ syncState: 'synced' });
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
client.setQueryData(['teams', eventKey], [{ team_number: 254, nickname: 'The Cheesy Poofs' }, { team_number: 3256, nickname: 'WarriorBorgs' }]);
client.setQueryData(['matches', eventKey], []);
client.setQueryData(['reports', eventKey], []);
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><BrowserRouter><RyansBoard eventKey={eventKey} /></BrowserRouter></QueryClientProvider></React.StrictMode>);
