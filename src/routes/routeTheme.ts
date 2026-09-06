const DARK_THEME_COLOR = '#0b0f1a';
const LIGHT_THEME_COLOR = '#ffffff';

/** Routes used by scouts in the stands, including pit and offline transfer tools. */
export function isScoutRoute(pathname: string): boolean {
  return (
    pathname === '/scout' ||
    pathname.startsWith('/scout/') ||
    pathname === '/pit' ||
    pathname === '/my-data' ||
    pathname === '/qr' ||
    pathname.startsWith('/qr/') ||
    pathname === '/sync'
  );
}

/** Keep the document palette and installed-app chrome in sync with the active role. */
export function applyRouteTheme(pathname: string): void {
  const light = isScoutRoute(pathname);
  document.documentElement.classList.toggle('dark', !light);

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = light ? LIGHT_THEME_COLOR : DARK_THEME_COLOR;

  const statusBar = document.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-status-bar-style"]',
  );
  if (statusBar) statusBar.content = light ? 'default' : 'black-translucent';
}
