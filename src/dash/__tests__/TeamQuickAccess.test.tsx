import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TeamQuickAccess from '../TeamQuickAccess';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe('team shortcuts', () => {
  it('keeps shortcuts usable when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
    });
    render(<TeamQuickAccess eventKey="event-a" selected={254} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin team 254' }));
    expect(within(screen.getByLabelText('Pinned teams')).getByRole('button', { name: 'Open team 254' })).toBeTruthy();
  });

  it('remembers pins and most recent visits after remount, scoped by event', () => {
    const onSelect = vi.fn();
    const view = render(<TeamQuickAccess eventKey="event-a" selected={254} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin team 254' }));
    view.rerender(<TeamQuickAccess eventKey="event-a" selected={3256} onSelect={onSelect} />);
    view.unmount();
    const restored = render(<TeamQuickAccess eventKey="event-a" selected={null} onSelect={onSelect} />);
    fireEvent.click(within(screen.getByLabelText('Pinned teams')).getByRole('button', { name: 'Open team 254' }));
    expect(onSelect).toHaveBeenCalledWith(254);
    expect(within(screen.getByLabelText('Recent teams')).getAllByRole('button').map((b) => b.textContent)).toEqual(['3256', '254']);
    restored.unmount();
    render(<TeamQuickAccess eventKey="event-b" selected={null} onSelect={onSelect} />);
    expect(screen.queryByRole('button', { name: 'Open team 254' })).toBeNull();
  });

  it('unpins teams and recovers from corrupt preferences', () => {
    localStorage.setItem('analysis-teams-v1:event-a', '{broken');
    render(<TeamQuickAccess eventKey="event-a" selected={254} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin team 254' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin team 254' }));
    expect(within(screen.getByLabelText('Pinned teams')).queryByRole('button')).toBeNull();
    expect(within(screen.getByLabelText('Recent teams')).getByRole('button', { name: 'Open team 254' })).toBeTruthy();
  });
});
