// src/sync/useOnline.ts
//
// Reactive online/offline status. Initializes from `navigator.onLine` and
// subscribes to the window `online`/`offline` events, cleaning up on unmount.
import { useEffect, useState } from 'react';

function readOnline(): boolean {
  // navigator.onLine is widely supported; default to online when unavailable.
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);

    // Re-sync once on mount in case the status changed between the initial
    // render and the effect firing.
    setOnline(readOnline());

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
