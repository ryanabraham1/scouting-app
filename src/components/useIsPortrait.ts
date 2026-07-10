import { useEffect, useState } from 'react';

function useMediaMatch(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return fallback;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/**
 * True when the viewport is in portrait orientation. Used to render the (very
 * wide) FieldDiagram rotated 90° so it's large and tappable on a phone held
 * vertically (the scout turns the phone sideways to view it upright). Re-renders
 * on orientation change. Defaults to portrait when matchMedia is unavailable
 * (SSR / jsdom).
 */
export function useIsPortrait(): boolean {
  return useMediaMatch('(orientation: portrait)', true);
}

/**
 * True only for phone-sized portrait viewports. A portrait tablet is wide
 * enough to show an upright field diagram with more usable drawing area.
 */
export function useIsPhonePortrait(): boolean {
  return useMediaMatch('(orientation: portrait) and (max-width: 639px)', true);
}
