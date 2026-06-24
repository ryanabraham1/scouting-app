import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa/registerPwa';
import { ensureAnonSession } from './auth/ensureAnonSession';
import './index.css';

// Silently establish the anonymous session before first render so RLS-backed
// reads/writes work without any login UI. Failures are non-fatal (offline-first).
void ensureAnonSession().catch(() => {});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void registerPwa();
