import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NotificationPermissionPrompt from '@/capture/NotificationPermissionPrompt';

const requestPermission = vi.fn<() => Promise<NotificationPermission>>();
let stored = new Map<string, string>();

function installLocalStorage(): void {
  stored = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    },
  });
}

function installNotification(permission: NotificationPermission): void {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: {
      permission,
      requestPermission,
    },
  });
}

describe('NotificationPermissionPrompt', () => {
  beforeEach(() => {
    installLocalStorage();
    requestPermission.mockReset();
    installNotification('default');
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'Notification');
  });

  it('offers the one-time prompt without requesting permission automatically', () => {
    render(<NotificationPermissionPrompt />);
    expect(screen.getByTestId('notification-permission-prompt')).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('requests permission from the Enable alerts action and closes when granted', async () => {
    requestPermission.mockResolvedValue('granted');
    render(<NotificationPermissionPrompt />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable alerts' }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByTestId('notification-permission-prompt')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('notification-menu-control')).toHaveTextContent('On-deck alerts on');
  });

  it('remembers Not now but lets the scout reopen it from the menu', () => {
    render(<NotificationPermissionPrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('notification-permission-prompt')).not.toBeInTheDocument();

    cleanup();
    render(<NotificationPermissionPrompt />);
    expect(screen.queryByTestId('notification-permission-prompt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notification-menu-control'));
    expect(screen.getByTestId('notification-permission-prompt')).toBeInTheDocument();
  });

  it('explains how to recover when permission is denied', async () => {
    requestPermission.mockResolvedValue('denied');
    render(<NotificationPermissionPrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable alerts' }));

    expect(await screen.findByText('On-deck alerts are blocked')).toBeInTheDocument();
    expect(screen.getByText(/browser or device settings/i)).toBeInTheDocument();
  });

  it('does not auto-open and disables the menu action when unsupported', () => {
    Reflect.deleteProperty(window, 'Notification');
    render(<NotificationPermissionPrompt />);

    expect(screen.queryByTestId('notification-permission-prompt')).not.toBeInTheDocument();
    expect(screen.getByTestId('notification-menu-control')).toBeDisabled();
    expect(screen.getByTestId('notification-menu-control')).toHaveTextContent('unavailable');
  });
});
