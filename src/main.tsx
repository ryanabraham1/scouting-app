import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted monospace webfont (F1), bundled for offline use — reserved for
// numeric telemetry so data columns align like an instrument readout. Headings
// and body use the platform system sans (no decorative display face).
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { registerPwa } from './pwa/registerPwa';
import { ensureAnonSession } from './auth/ensureAnonSession';
import { supabase } from './lib/supabase';
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
// Keep trying to establish a session until one sticks. A boot-time failure is
// common at a venue (dozens of phones behind one NAT trip the per-IP anon
// sign-up limit), and without a session pit photo uploads and QR ingest fail on
// RLS while the device looks perfectly online. Retry on the reconnect edge, on
// every return to the foreground, and on a slow timer — whichever comes first —
// and stop as soon as a sign-in succeeds.
const SESSION_RETRY_MS = 60_000;
function keepRetryingSession(): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    window.removeEventListener('online', retry);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) clearInterval(timer);
  };
  const retry = (): void => {
    void ensureAnonSession().then(stop).catch(() => {});
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') retry();
  };
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(retry, SESSION_RETRY_MS);
}
const sessionReady = ensureAnonSession().catch(keepRetryingSession);
// A session can also be LOST later (refresh token rejected after a long offline
// stretch → supabase-js signs the device out). Re-establish it the same way.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') void ensureAnonSession().catch(keepRetryingSession);
});
const bootTimeout = new Promise<void>((resolve) => setTimeout(resolve, SESSION_BOOT_TIMEOUT_MS));
void Promise.race([sessionReady, bootTimeout]).finally(mount);
