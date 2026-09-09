// App smoke test — the default route (/) now renders the landing page chooser,
// which lets the user pick Scout, Analysis, or Lead Dashboard.
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./auth/useSession', () => ({
  useSession: () => ({ loading: false, scout: null }),
}));

// Keep the smoke test hermetic: no network, no draft IO noise.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
  },
}));

import App from './App';

describe('App', () => {
  it('renders without crashing and shows the landing chooser by default', async () => {
    render(<App />);
    expect(await screen.findByTestId('home-screen')).toBeInTheDocument();
    expect(screen.getByTestId('home-go-scout')).toBeInTheDocument();
    expect(screen.getByTestId('home-go-analysis')).toBeInTheDocument();
    expect(screen.getByTestId('home-go-dashboard')).toBeInTheDocument();
  });
});
