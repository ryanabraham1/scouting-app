// HomeScreen landing page — lets the user choose Scout, Analysis, or Lead Dashboard.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import HomeScreen from '../HomeScreen';

// HomeScreen uses react-router <Link> for client-side (offline-safe) navigation,
// so it must render inside a router. <Link> still renders an <a href>, so the
// destination assertions below are unchanged.
function renderHome() {
  return render(
    <MemoryRouter>
      <HomeScreen />
    </MemoryRouter>,
  );
}

describe('HomeScreen', () => {
  it('renders the landing shell', () => {
    renderHome();
    expect(screen.getByTestId('home-screen')).toBeInTheDocument();
  });

  it('offers a Scout choice linking to /scout', () => {
    renderHome();
    const scout = screen.getByTestId('home-go-scout');
    expect(scout).toBeInTheDocument();
    expect(scout).toHaveAttribute('href', '/scout');
    expect(scout).toHaveTextContent(/scout/i);
  });

  it('offers a Lead Dashboard choice linking to /dashboard', () => {
    renderHome();
    const dash = screen.getByTestId('home-go-dashboard');
    expect(dash).toBeInTheDocument();
    expect(dash).toHaveAttribute('href', '/dashboard');
    expect(dash).toHaveTextContent(/dashboard/i);
  });

  it('offers an Analysis choice linking to /analysis', () => {
    renderHome();
    const analysis = screen.getByTestId('home-go-analysis');
    expect(analysis).toBeInTheDocument();
    expect(analysis).toHaveAttribute('href', '/analysis');
    expect(analysis).toHaveTextContent(/analysis/i);
  });
});
