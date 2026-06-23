import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders the app heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '3256 Scouting' })).toBeInTheDocument();
  });
});
