import { useEffect, useState } from 'react';

/**
 * True when the viewport is in portrait orientation. Drives the capture fields:
 * portrait → render the wide field ROTATED 90° (tall + big) so placing/tracing
 * with a finger is accurate; landscape → render it normally. Re-renders on
 * orientation change.
 */
export function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(orientation: portrait)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = (): void => setPortrait(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return portrait;
}
