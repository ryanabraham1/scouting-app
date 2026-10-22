// src/search/GlobalSearch.tsx
// The app-wide spotlight (Cmd/Ctrl+K, or the header search button): type a
// team, match, page or setting and jump there; a #section destination scrolls
// to and briefly highlights that part of the page. Ryan's Board keeps its own
// spotlight, so Cmd+K over the board opens that one instead. The palette (and
// the search engine it pulls in) loads on first open.
import { lazy, Suspense, useEffect, useState } from 'react';
import { router } from '@/routes/router';
import { OPEN_APP_SEARCH } from '@/search/openAppSearch';

const SearchPalette = lazy(() => import('@/search/SearchPalette'));

/** Find a #hash target by id or data-testid, waiting for lazy screens and
 * data. Re-aims while the layout above it is still moving, and stops for good
 * once it settles or the user scrolls themselves. */
export function scrollToHash(hash: string): () => void {
  const name = decodeURIComponent(hash.replace(/^#/, ''));
  if (!name) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let found: Element | null = null;
  let lastTop = NaN;
  let still = 0;
  let tries = 0;
  const stop = (): void => {
    clearTimeout(timer);
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('keydown', stop);
  };
  const tick = (): void => {
    tries += 1;
    const el = document.getElementById(name) ?? document.querySelector(`[data-testid="${CSS.escape(name)}"]`);
    if (el) {
      if (el !== found) {
        found = el;
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.classList.remove('search-flash');
        void (el as HTMLElement).offsetWidth;
        el.classList.add('search-flash');
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        window.addEventListener('wheel', stop, { passive: true });
        window.addEventListener('touchstart', stop, { passive: true });
        window.addEventListener('keydown', stop);
      } else {
        const top = el.getBoundingClientRect().top;
        const settled = Math.abs(top - lastTop) < 2;
        const atEnd = window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 2;
        // scroll-margin-top on .search-flash parks it 16px below the top.
        const aimed = Math.abs(top - 16) < 24 || atEnd;
        if (settled && aimed) still += 1;
        else {
          still = 0;
          // Content loading above pushed it away; re-aim once motion stops
          // (never mid smooth-scroll).
          if (settled) el.scrollIntoView({ block: 'start' });
        }
        lastTop = el.getBoundingClientRect().top;
      }
    }
    if (still >= 3 || tries >= 30) stop();
    else timer = setTimeout(tick, 150);
  };
  tick();
  return stop;
}

export function GlobalSearch(): JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || e.defaultPrevented) return;
      // The board's own spotlight owns Cmd+K while the board is on screen.
      if (document.querySelector('[data-testid="board-canvas"]')) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener(OPEN_APP_SEARCH, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_APP_SEARCH, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Scroll to #sections on every navigation that carries one.
  useEffect(() => {
    let stop = scrollToHash(router.state.location.hash);
    let key = router.state.location.key;
    const unsub = router.subscribe((state) => {
      if (state.location.key === key) return;
      key = state.location.key;
      stop();
      stop = scrollToHash(state.location.hash);
    });
    return () => {
      unsub();
      stop();
    };
  }, []);

  return open ? (
    <Suspense fallback={null}>
      <SearchPalette onClose={() => setOpen(false)} />
    </Suspense>
  ) : null;
}

