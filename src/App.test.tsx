// App smoke test — with auth removed, the default route (/ → /scout) renders the
// scouter home directly (no join/login gate). We verify the app mounts and shows
// the scout-home shell.
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
  it('renders without crashing and shows the scout home by default', async () => {
    render(<App />);
    expect(await screen.findByTestId('scout-home')).toBeInTheDocument();
  });
});
