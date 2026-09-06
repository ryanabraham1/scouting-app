import { beforeEach, describe, expect, it } from 'vitest';
import { applyRouteTheme, isScoutRoute } from './routeTheme';

describe('route theme', () => {
  beforeEach(() => {
    document.documentElement.className = 'dark';
    document.head.innerHTML = `
      <meta name="theme-color" content="#0b0f1a" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    `;
  });

  it.each(['/scout', '/scout/tutorial', '/pit', '/my-data', '/qr/send', '/qr/receive', '/sync'])(
    'uses light mode for %s',
    (pathname) => {
      expect(isScoutRoute(pathname)).toBe(true);
      applyRouteTheme(pathname);

      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        '#ffffff',
      );
      expect(
        document
          .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.getAttribute('content'),
      ).toBe('default');
    },
  );

  it.each(['/', '/dashboard', '/dashboard?tab=setup', '/admin'])(
    'keeps dark mode for %s',
    (pathname) => {
      applyRouteTheme(pathname);

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        '#0b0f1a',
      );
      expect(
        document
          .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.getAttribute('content'),
      ).toBe('black-translucent');
    },
  );
});
