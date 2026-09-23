import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CHUNK_RELOAD_GUARD_MS, isChunkLoadError, RouteError } from './router';

function renderThrowing(error: unknown) {
  const Boom = (): JSX.Element => {
    throw error;
  };
  const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteError /> }]);
  return render(<RouterProvider router={router} />);
}

const reload = vi.fn();

function stubReload() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
}

afterEach(() => {
  reload.mockReset();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isChunkLoadError', () => {
  it('recognizes each browser wording of a failed lazy chunk', () => {
    expect(
      isChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module: https://x/assets/Scout-1.js'),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
  });

  it('leaves ordinary render errors alone', () => {
    expect(isChunkLoadError(new Error('epaByTeam.get is not a function'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe('RouteError', () => {
  it('reloads once on a stale-build chunk failure, then stops looping', () => {
    stubReload();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const chunk = new TypeError('Failed to fetch dynamically imported module: /assets/a.js');

    const first = renderThrowing(chunk);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('route-error')).toHaveTextContent(/newer version/i);
    first.unmount();

    // Same failure right after the reload: show it, do not loop.
    renderThrowing(chunk);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('route-error')).toHaveTextContent(/could not be downloaded/i);
  });

  it('allows another automatic reload once the guard window has passed', () => {
    stubReload();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.sessionStorage.setItem(
      'frc-chunk-reload-at',
      String(Date.now() - CHUNK_RELOAD_GUARD_MS - 1),
    );
    renderThrowing(new TypeError('Importing a module script failed.'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never auto-reloads while offline and says why', () => {
    stubReload();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderThrowing(new TypeError('Importing a module script failed.'));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('route-error')).toHaveTextContent(/reconnect/i);
  });

  it('shows an ordinary error message without reloading', () => {
    stubReload();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderThrowing(new Error('boom'));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('route-error')).toHaveTextContent('boom');
  });
});
