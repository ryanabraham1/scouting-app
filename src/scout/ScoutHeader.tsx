import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Wifi, WifiOff } from 'lucide-react';
import { useSession, clearCachedScout } from '@/auth/useSession';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useOnline } from '@/sync/useOnline';
import { forgetScouterName, markScouterLoggedOut } from '@/roster/selectScouter';
import { StationMenu } from '@/components/StationMenu';
import { Button } from '@/components/ui/button';
import NotificationPermissionPrompt from '@/capture/NotificationPermissionPrompt';
import { ScoutTopNav, type ScoutDesktopTab } from './ScoutBottomNav';
import { cn } from '@/lib/utils';

/** Shared scout chrome: content width must never determine navigation geometry. */
export function ScoutHeader({
  active,
  scoutName,
  eventKey,
  onChangeScouter,
}: {
  active: ScoutDesktopTab;
  scoutName?: string;
  eventKey?: string | null;
  onChangeScouter?: () => void;
}): JSX.Element {
  const { scout } = useSession();
  const { eventKey: activeEvent } = useActiveEvent();
  const online = useOnline();
  const navigate = useNavigate();
  const name = scoutName ?? scout?.display_name ?? 'Scout';
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  function changeScouter(): void {
    if (onChangeScouter) return onChangeScouter();
    forgetScouterName();
    markScouterLoggedOut();
    clearCachedScout();
    navigate('/scout');
  }

  return (
    <header data-testid="scout-header" className="sticky top-0 z-20 w-full shrink-0 bg-background/95 backdrop-blur">
      <div className="mx-auto w-full max-w-6xl px-safe pt-safe pb-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <StationMenu
            current="scout"
            title={`Hi, ${name.trim().split(/\s+/)[0] || 'Scout'}`}
            subtitle={eventKey ?? activeEvent ?? 'No active event'}
            avatar={initials || 'S'}
          >
            <Button
              data-testid="scout-logout"
              variant="outline"
              aria-label={`Change scouter ${name}`}
              className="min-h-11 gap-2 rounded-xl px-3"
              onClick={changeScouter}
            >
              <LogOut className="size-5 shrink-0" /> Change scouter
            </Button>
            <NotificationPermissionPrompt />
          </StationMenu>
          <Link
            to="/sync"
            data-testid="scout-connection-pill"
            aria-label={online ? 'Online. View sync status' : 'Offline. View sync status'}
            className={cn(
              'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs',
              online ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning',
            )}
          >
            {online ? <Wifi aria-hidden className="size-3.5" /> : <WifiOff aria-hidden className="size-3.5" />}
            {online ? 'Online' : 'Offline'}
          </Link>
        </div>
        <ScoutTopNav active={active} className="mt-3" />
      </div>
    </header>
  );
}
