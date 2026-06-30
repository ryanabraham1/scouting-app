// src/dash/__tests__/MatchVideo.test.tsx
// MatchVideo lazily fetches the TBA match object for a matchKey and embeds the
// first youtube video as a responsive 16:9 iframe. Tests mock tbaGetOptional +
// isUnavailable and cover the video, loading, no-video, unavailable-sentinel,
// and (defensive) error states. Each test uses a fresh QueryClient so queries
// don't share cache.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const tbaGetOptionalMock = vi.fn();
vi.mock('@/dash/proxies', () => ({
  tbaGetOptional: (path: string) => tbaGetOptionalMock(path),
  isUnavailable: (b: unknown) =>
    typeof b === 'object' && b !== null && (b as { available?: unknown }).available === false,
}));

import MatchVideo from '@/dash/MatchVideo';

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  tbaGetOptionalMock.mockReset();
});

describe('MatchVideo', () => {
  it('embeds the first youtube video as a 16:9 iframe', async () => {
    tbaGetOptionalMock.mockResolvedValue({
      videos: [
        { type: 'tba', key: 'whatever' },
        { type: 'youtube', key: 'dQw4w9WgXcQ' },
      ],
    });
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-frame')).toBeTruthy());
    const frame = getByTestId('match-video-frame') as HTMLIFrameElement;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.src).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(tbaGetOptionalMock).toHaveBeenCalledWith('/match/2026casnv_qm1');
  });

  it('enables the JS API on the embed when an onTimeMs callback is supplied', async () => {
    tbaGetOptionalMock.mockResolvedValue({ videos: [{ type: 'youtube', key: 'dQw4w9WgXcQ' }] });
    const onTimeMs = vi.fn();
    const { getByTestId } = renderWithClient(
      <MatchVideo matchKey="2026casnv_qm1" onTimeMs={onTimeMs} />,
    );
    await waitFor(() => expect(getByTestId('match-video-frame')).toBeTruthy());
    const frame = getByTestId('match-video-frame') as HTMLIFrameElement;
    // enablejsapi=1 is required for the IFrame Player API to read currentTime.
    expect(frame.src).toContain('enablejsapi=1');
    expect(frame.src).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('still renders the embed gracefully when the YT API never loads', async () => {
    // jsdom has no window.YT — the player never attaches, but the iframe and the
    // surrounding UI must render fine (no playhead, no throw).
    tbaGetOptionalMock.mockResolvedValue({ videos: [{ type: 'youtube', key: 'dQw4w9WgXcQ' }] });
    const onTimeMs = vi.fn();
    const { getByTestId } = renderWithClient(
      <MatchVideo matchKey="2026casnv_qm1" onTimeMs={onTimeMs} />,
    );
    await waitFor(() => expect(getByTestId('match-video-frame')).toBeTruthy());
    expect(onTimeMs).not.toHaveBeenCalled();
  });

  it('shows a loading state before data resolves', () => {
    tbaGetOptionalMock.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    expect(getByTestId('match-video-loading')).toBeTruthy();
  });

  it('shows "No video available" when there are no youtube videos', async () => {
    tbaGetOptionalMock.mockResolvedValue({ videos: [{ type: 'tba', key: 'x' }] });
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-none')).toBeTruthy());
  });

  it('shows "No video available" when videos is missing', async () => {
    tbaGetOptionalMock.mockResolvedValue({});
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-none')).toBeTruthy());
  });

  it('shows an error state on a forced query rejection (retained defensive branch)', async () => {
    // tbaGetOptional never rejects in production (it degrades to the sentinel),
    // so this exercises the retained belt-and-suspenders query.isError branch
    // via a forced mock rejection — no longer reflects real proxy behavior.
    tbaGetOptionalMock.mockRejectedValue(new Error('boom'));
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-error')).toBeTruthy());
  });

  it('shows the unavailable note when TBA returns the { available:false } sentinel', async () => {
    tbaGetOptionalMock.mockResolvedValue({ available: false });
    const { getByTestId, queryByTestId } = renderWithClient(
      <MatchVideo matchKey="2026casnv_qm1" />,
    );
    await waitFor(() => expect(getByTestId('match-video-unavailable')).toBeTruthy());
    // The calm info note must NOT be the louder error state.
    expect(queryByTestId('match-video-error')).toBeNull();
  });

  it('renders a Watch-on-YouTube link when a video exists', async () => {
    tbaGetOptionalMock.mockResolvedValue({ videos: [{ type: 'youtube', key: 'dQw4w9WgXcQ' }] });
    const { getByTestId } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-yt-link')).toBeTruthy());
    const link = getByTestId('match-video-yt-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows the "appears 1–4h after the match" hint in the no-video state', async () => {
    tbaGetOptionalMock.mockResolvedValue({ videos: [{ type: 'tba', key: 'x' }] });
    const { getByTestId, getByText } = renderWithClient(<MatchVideo matchKey="2026casnv_qm1" />);
    await waitFor(() => expect(getByTestId('match-video-none')).toBeTruthy());
    expect(getByText(/1.4h after the match/)).toBeTruthy();
  });
});
