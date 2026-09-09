import { useRef, useState } from 'react';
import { Bell, BellOff, BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/Sheet';

const DISMISSED_KEY = 'frc-on-deck-notifications-dismissed';

type PermissionState = NotificationPermission | 'unsupported';

function readPermission(): PermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, 'true');
  } catch {
    // A private or full storage area should not block the permission choice.
  }
}

function clearDismissed(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // The permission itself remains authoritative when storage is unavailable.
  }
}

function initialState(): { permission: PermissionState; open: boolean } {
  const permission = readPermission();
  return {
    permission,
    open: permission === 'default' && !readDismissed(),
  };
}

export default function NotificationPermissionPrompt(): JSX.Element {
  const [initial] = useState(initialState);
  const [permission, setPermission] = useState<PermissionState>(initial.permission);
  const [open, setOpen] = useState(initial.open);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const enableRef = useRef<HTMLButtonElement>(null);

  function dismiss(): void {
    if (permission === 'default') rememberDismissed();
    setOpen(false);
    setRequestError(null);
  }

  async function enable(): Promise<void> {
    if (permission === 'unsupported') return;
    setRequesting(true);
    setRequestError(null);
    try {
      const next = await window.Notification.requestPermission();
      setPermission(next);
      if (next === 'granted') {
        clearDismissed();
        setOpen(false);
      }
    } catch {
      setRequestError(
        'Notification permission could not be opened. Try again from your browser settings.',
      );
    } finally {
      setRequesting(false);
    }
  }

  const granted = permission === 'granted';
  const blocked = permission === 'denied';
  const unsupported = permission === 'unsupported';
  const MenuIcon = granted ? BellRing : unsupported || blocked ? BellOff : Bell;
  const menuLabel = granted
    ? 'On-deck alerts on'
    : blocked
      ? 'On-deck alerts blocked'
      : unsupported
        ? 'On-deck alerts unavailable'
        : 'Enable on-deck alerts';

  return (
    <>
      <button
        type="button"
        data-testid="notification-menu-control"
        onClick={() => {
          setRequestError(null);
          setPermission(readPermission());
          setOpen(true);
        }}
        disabled={unsupported}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <MenuIcon className="size-5 shrink-0" />
        <span>{menuLabel}</span>
      </button>

      <Sheet
        open={open}
        onClose={dismiss}
        title={
          granted
            ? 'On-deck alerts are on'
            : blocked
              ? 'On-deck alerts are blocked'
              : unsupported
                ? 'On-deck alerts are unavailable'
                : 'Enable on-deck alerts?'
        }
        initialFocusRef={permission === 'default' ? enableRef : undefined}
        side="bottom"
        data-testid="notification-permission-prompt"
        className="mx-auto max-w-lg border-x sm:bottom-6 sm:rounded-2xl sm:border"
      >
        <div className="flex flex-col gap-5">
          <div className="flex gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-brand/30 bg-brand/10 text-brand">
              {granted ? (
                <BellRing className="size-6" />
              ) : blocked || unsupported ? (
                <BellOff className="size-6" />
              ) : (
                <Bell className="size-6" />
              )}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                {granted
                  ? 'This device can notify you when it is time to scout.'
                  : blocked
                    ? 'Allow notifications for this app in your browser or device settings.'
                    : unsupported
                      ? 'This browser does not support on-deck notifications.'
                      : 'Get an alert when your assigned match is queuing or on the field.'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                The on-screen banner still works even when notifications are off.
              </p>
            </div>
          </div>

          {requestError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {requestError}
            </p>
          ) : null}

          {permission === 'default' ? (
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" size="lg" onClick={dismiss}>
                Not now
              </Button>
              <Button
                ref={enableRef}
                type="button"
                variant="brand"
                size="lg"
                disabled={requesting}
                onClick={() => void enable()}
              >
                {requesting ? 'Enabling…' : 'Enable alerts'}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="brand" size="lg" onClick={() => setOpen(false)}>
              Done
            </Button>
          )}
        </div>
      </Sheet>
    </>
  );
}
