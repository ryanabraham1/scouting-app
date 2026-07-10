import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_EVENT_KEY } from '../useActiveEvent';

const rpc = vi.fn();
const setStoredActiveEvent = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock('../activeEventStore', () => ({
  setStoredActiveEvent: (eventKey: string | null) => setStoredActiveEvent(eventKey),
}));

import { setActiveEvent } from '../setActiveEvent';

describe('setActiveEvent', () => {
  beforeEach(() => {
    rpc.mockReset();
    setStoredActiveEvent.mockClear();
  });

  it('updates server authority and this tab immediately', async () => {
    rpc.mockResolvedValue({ error: null });
    const setQueryData = vi.fn();

    await setActiveEvent('2026demo', { setQueryData } as never);

    expect(rpc).toHaveBeenCalledWith('set_active_event', {
      p_event_key: '2026demo',
    });
    expect(setStoredActiveEvent).toHaveBeenCalledWith('2026demo');
    expect(setQueryData).toHaveBeenCalledWith(ACTIVE_EVENT_KEY, '2026demo');
  });
});
