import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { OnDeckAlert } from '@/capture/OnDeckAlert';
import { installMemoryStorage } from '@/tutorial/__tests__/memoryStorage';

describe('OnDeckAlert notification delivery', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'Notification');
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('uses the PWA service worker when notification permission is granted', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted' },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification }) },
    });

    render(
      <OnDeckAlert
        result={{
          assignment: {
            match_key: '2026demo_qm12',
            target_team_number: 3256,
            alliance_color: 'blue',
            station: 2,
          },
          urgency: 'on-deck',
          liveStatus: 'on deck',
        }}
        timing={{
          source: 'estimated',
          clock: '2:18 PM',
          relative: 'in 5 min',
          state: 'future',
          minutesAway: 5,
        }}
        onStart={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledWith(
        "You're on deck — scout now",
        expect.objectContaining({
          body: expect.stringContaining('team #3256'),
          tag: 'frc-scout-on-deck',
        }),
      );
    });
    expect(screen.getByTestId('scout-on-deck-time').textContent).toBe(
      'Estimated 2:18 PM · in 5 min',
    );
    expect(screen.getByText('Scout now').className).toContain('sm:inline-flex');
  });

  it('notifies once per match even when urgency escalates or the banner remounts', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted' },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification }) },
    });
    const assignment = {
      match_key: '2026demo_qm40',
      target_team_number: 254,
      alliance_color: 'red' as const,
      station: 1 as const,
    };
    const renderAt = (urgency: 'queuing' | 'on-deck' | 'on-field' | 'soon') =>
      render(
        <OnDeckAlert
          result={{ assignment, urgency, liveStatus: null }}
          timing={null}
          onStart={vi.fn()}
        />,
      );

    const first = renderAt('queuing');
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));

    // Nexus escalates the same match: no second ping.
    first.rerender(
      <OnDeckAlert result={{ assignment, urgency: 'on-deck', liveStatus: 'on deck' }} timing={null} onStart={vi.fn()} />,
    );
    first.rerender(
      <OnDeckAlert result={{ assignment, urgency: 'on-field', liveStatus: 'on field' }} timing={null} onStart={vi.fn()} />,
    );
    // Banner unmounts (selector briefly null / navigation) and comes back.
    first.unmount();
    renderAt('soon');
    await new Promise((r) => setTimeout(r, 0));
    expect(showNotification).toHaveBeenCalledTimes(1);

    // A different match still notifies.
    renderAt('soon').unmount();
    render(
      <OnDeckAlert
        result={{ assignment: { ...assignment, match_key: '2026demo_qm41' }, urgency: 'soon', liveStatus: null }}
        timing={null}
        onStart={vi.fn()}
      />,
    );
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(2));
  });
});
