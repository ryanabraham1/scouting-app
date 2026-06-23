import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders its children as a button', () => {
    render(<Button>Join event</Button>);
    expect(screen.getByRole('button', { name: 'Join event' })).toBeInTheDocument();
  });
  it('applies the destructive variant class', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/destructive/);
  });
});
