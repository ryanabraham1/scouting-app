// src/pwa/InstallPrompt.tsx
// Dismissible "Add to Home Screen" banner shown to SCOUTING users so they can run
// the app as a full-screen, offline PWA during matches. On Chrome/Android it
// replays the captured native install prompt (one-tap Add). iOS Safari has NO
// programmatic install API — Apple only allows the manual Share-sheet flow — so
// the best we can do there is a "Show me" button that opens a big visual
// step-by-step guide. Hides itself when already installed (standalone) or dismissed.
import { useState } from 'react';
import { CheckCircle2, Download, Share, SquarePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useInstallPrompt, isStandalone, isIOS } from '@/pwa/useInstallPrompt';

const DISMISS_KEY = 'a2hs_dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Full-screen 3-step Add-to-Home-Screen guide for iOS (numbered: it IS a sequence). */
function IosInstallGuide(props: { onClose: () => void }): JSX.Element {
  const steps = [
    {
      icon: <Share className="size-6 text-brand" />,
      title: 'Tap the Share button',
      detail:
        'The square-with-arrow icon — bottom toolbar in Safari, next to the address bar in Chrome.',
    },
    {
      icon: <SquarePlus className="size-6 text-brand" />,
      title: 'Tap “Add to Home Screen”',
      detail: 'Scroll the share sheet down a little to find it.',
    },
    {
      icon: <CheckCircle2 className="size-6 text-success" />,
      title: 'Tap Add',
      detail: 'Open the new icon on your home screen — full-screen, works with no wifi.',
    },
  ];
  return (
    <div
      data-testid="install-guide"
      role="dialog"
      aria-modal="true"
      aria-label="How to add this app to your home screen"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-safe py-safe backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-bold leading-tight">Add to your home screen</h2>
          <button
            type="button"
            data-testid="install-guide-close"
            aria-label="Close guide"
            onClick={props.onClose}
            className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent"
          >
            <X className="size-4" />
          </button>
        </div>
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-start gap-3 rounded-xl border border-border bg-background/60 p-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-sm font-bold tabular-nums">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 font-semibold">
                  {s.icon} {s.title}
                </span>
                <span className="text-sm text-muted-foreground">{s.detail}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Don’t see “Add to Home Screen” in the share sheet? Open this page in Safari and
          add it from there.
        </p>
        <Button variant="brand" size="big" className="w-full" onClick={props.onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}

export function InstallPrompt(): JSX.Element | null {
  const { canPrompt, installed, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [showGuide, setShowGuide] = useState(false);

  const standalone = isStandalone();
  const ios = isIOS();

  // Nothing to do when already installed, dismissed, or there's no way to install.
  if (installed || standalone || dismissed) return null;
  if (!canPrompt && !ios) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage unavailable — non-fatal */
    }
    setDismissed(true);
  };

  return (
    <>
      <div
        data-testid="install-prompt"
        className="flex items-center gap-3 rounded-xl border border-brand/40 bg-brand/10 p-3"
      >
        <Download className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-foreground">Add this app to your home screen</p>
          <p className="text-muted-foreground">
            {canPrompt
              ? 'Install it for a full-screen, offline-ready app during matches.'
              : 'Two taps: Share, then “Add to Home Screen”.'}
          </p>
        </div>
        {canPrompt ? (
          <Button
            data-testid="install-prompt-add"
            size="sm"
            className="min-h-[44px] shrink-0"
            onClick={() => void promptInstall()}
          >
            Add
          </Button>
        ) : (
          <Button
            data-testid="install-prompt-how"
            size="sm"
            variant="brand"
            className="min-h-[44px] shrink-0"
            onClick={() => setShowGuide(true)}
          >
            Show me
          </Button>
        )}
        <button
          type="button"
          data-testid="install-prompt-dismiss"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
          className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent"
        >
          <X className="size-4" />
        </button>
      </div>
      {showGuide ? <IosInstallGuide onClose={() => setShowGuide(false)} /> : null}
    </>
  );
}

export default InstallPrompt;
