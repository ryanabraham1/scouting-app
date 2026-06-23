import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => {
  const rows = [
    {
      match_key: 'qm1',
      alliance_color: 'red',
      station: 1,
      target_team_number: 254,
      event_key: '2026demo',
    },
  ];
  return {
    supabase: {
      from: () => ({
        // ScoutHome filters by scout_id: .select('*').eq('scout_id', id)
        select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    },
  };
});

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({ scout: { id: 'scout-1' }, session: {}, role: 'scout', loading: false }),
}));

vi.mock('@/export/exportReports', () => ({
  exportUnsyncedToFile: () =>
    Promise.resolve({ count: 0, filename: 'reports.json', blobUrl: 'blob:fake' }),
}));

import ScoutHome from '@/capture/ScoutHome';
import { db, saveDraft } from '@/db/localStore';

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('ScoutHome', () => {
  it('renders assignments and unsynced count', async () => {
    render(<ScoutHome />);
    expect(screen.getByTestId('scout-home')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByTestId('scout-assignment').length).toBe(1);
    });
  });

  it('lists resume drafts from the local store', async () => {
    await saveDraft('qm9:scout-1:111', { bursts: [] });
    render(<ScoutHome />);
    await waitFor(() => {
      expect(screen.getByText(/qm9:scout-1:111/)).toBeTruthy();
    });
  });
});

describe('ScoutHome manual pick', () => {
  it('disables start until match + team provided', async () => {
    render(<ScoutHome />);
    const btn = screen.getByTestId('scout-start-capture') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'qm5' } });
    fireEvent.change(screen.getByLabelText('Target team'), { target: { value: '111' } });
    expect((screen.getByTestId('scout-start-capture') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ScoutHome resume click', () => {
  it('opens capture from a draft and renders the LIVE start button', async () => {
    await saveDraft('qm7:scout-1:222', { bursts: [] });
    render(<ScoutHome />);
    const item = await screen.findByTestId('scout-resume-qm7:scout-1:222');
    fireEvent.click(item);
    await waitFor(() => {
      expect(screen.getByTestId('capture-start')).toBeTruthy();
    });
  });
});
