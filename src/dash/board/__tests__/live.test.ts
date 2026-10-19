import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { channel, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown; new?: unknown }) => void>();
  const channel = { on: vi.fn(), subscribe: vi.fn(), send: vi.fn(), track: vi.fn(), presenceState: vi.fn() };
  return { channel, handlers };
});
vi.mock('@/lib/supabase', () => ({ supabase: { channel: () => channel, removeChannel: vi.fn() } }));
import { BoardEditor } from '../editor';
import { BoardLive } from '../live';

let e: BoardEditor;
let live: BoardLive;
beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  channel.on.mockImplementation((kind, filter, cb) => { handlers.set(`${kind}:${filter.event}`, cb); return channel; });
  channel.subscribe.mockImplementation((cb) => { cb('SUBSCRIBED'); return channel; });
  channel.presenceState.mockReturnValue({ peer: [{ name: 'Ryan', color: 'blue' }] });
  e = new BoardEditor({ clientId: 'local' });
  e.setViewport(1000, 800);
  live = new BoardLive(e, 'fixture');
  live.start();
  handlers.get('presence:sync')!({ payload: null });
});
afterEach(() => { live.dispose(); vi.useRealTimers(); });

function broadcast(event: string, payload: unknown): void { handlers.get(`broadcast:${event}`)!({ payload }); }

describe('board collaboration', () => {
  it('follows a peer at the same page center and stops on local pan', () => {
    broadcast('view', { c: 'peer', x: 20, y: 40, z: 2, w: 600, h: 400 });
    live.follow('peer');
    expect(e.camera).toEqual({ x: 220, y: 240, z: 2 });
    vi.advanceTimersByTime(30);
    expect(live.following).toBe('peer');
    e.panBy(10, 0);
    vi.advanceTimersByTime(30);
    expect(live.following).toBeNull();
  });
  it('rejects invalid peer viewports', () => {
    live.follow('peer');
    const camera = e.camera;
    broadcast('view', { c: 'peer', x: NaN, y: 0, z: 0, w: 600, h: 400 });
    expect(e.camera).toBe(camera);
  });
  it('tracks remote selection and clears following when that person leaves', () => {
    broadcast('cursor', { c: 'peer', x: 1, y: 2, sel: ['s:1'] });
    expect(live.peers.get('peer')?.selection).toEqual(['s:1']);
    live.follow('peer');
    channel.presenceState.mockReturnValue({});
    handlers.get('presence:sync')!({ payload: null });
    expect(live.following).toBeNull();
  });
  it('receives durable records and retires their live stroke previews', () => {
    broadcast('ink', { c: 'peer', id: 's:ink', color: 'blue', size: 'm', hl: false, from: 0, pts: [[0, 0, 0.5], [20, 20, 0.5]] });
    expect([...live.remote.strokes()]).toHaveLength(1);
    handlers.get('postgres_changes:*')!({ payload: null, new: { data: { id: 's:ink', type: 'ink', x: 0, y: 0, w: 25, h: 25, z: 1, rev: 1, by: 'peer', color: 'blue', size: 'm', points: [[0, 0, 0.5], [20, 20, 0.5]] } } });
    expect(e.shapes.has('s:ink')).toBe(true);
    expect([...live.remote.strokes()]).toHaveLength(0);
  });
});
