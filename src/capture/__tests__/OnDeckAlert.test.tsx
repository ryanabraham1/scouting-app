import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { OnDeckAlert } from '@/capture/OnDeckAlert';

describe('OnDeckAlert notification delivery', () => {
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
  });
});
