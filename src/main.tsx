import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted monospace webfont (F1), bundled for offline use — reserved for
// numeric telemetry so data columns align like an instrument readout. Headings
// and body use the platform system sans (no decorative display face).
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { registerPwa } from './pwa/registerPwa';
import { ensureAnonSession } from './auth/ensureAnonSession';
import './index.css';

function mount(): void {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  void registerPwa();
}

// Silently establish the anonymous session BEFORE first render so RLS-backed
// reads/writes (e.g. an immediate scouter pick → select_scouter) don't race the
// session and fail with a raw "not authenticated". This used to be fire-and-forget,
// which left a small window where the very first action errored. We wait for the
// session to settle, but never block paint on a hung network: a short timeout
// falls through to render anyway (offline-first), and onAuthStateChange picks up
// the session whenever it does arrive.
const SESSION_BOOT_TIMEOUT_MS = 2500;
const sessionReady = ensureAnonSession().catch(() => {
  // First-launch-offline: no session could be established, and nothing would
  // ever retry (onAuthStateChange only observes; it can't create a session).
  // Without one, QR ingest and select_scouter stay dead for the whole app
  // lifetime — so retry on every reconnect edge until a sign-in sticks.
  const retry = (): void => {
    void ensureAnonSession()
      .then(() => window.removeEventListener('online', retry))
      .catch(() => {});
  };
  window.addEventListener('online', retry);
});
const bootTimeout = new Promise<void>((resolve) => setTimeout(resolve, SESSION_BOOT_TIMEOUT_MS));
void Promise.race([sessionReady, bootTimeout]).finally(mount);
