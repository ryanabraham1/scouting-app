// src/auth/__tests__/JoinScreen.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const joinEvent = vi.fn();
const recoverIdentity = vi.fn();
vi.mock('../joinEvent', () => ({
  joinEvent: (...a: unknown[]) => joinEvent(...a),
  recoverIdentity: (...a: unknown[]) => recoverIdentity(...a),
}));

import { JoinScreen } from '../JoinScreen';

beforeEach(() => {
  navigate.mockReset();
  joinEvent.mockReset();
  recoverIdentity.mockReset();
});

describe('JoinScreen', () => {
  it('joins and navigates to /scout on success', async () => {
    joinEvent.mockResolvedValue({ id: 's1', event_key: '2026casnv' });
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'ABCD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('join-submit'));

    await waitFor(() => expect(joinEvent).toHaveBeenCalledWith('ABCD', 'Ada'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/scout'));
  });

  it('shows an error message and does not navigate on failure', async () => {
    joinEvent.mockRejectedValue(new Error('invalid join code'));
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'BAD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('join-submit'));

    await waitFor(() => expect(screen.getByTestId('join-error')).toHaveTextContent('invalid join code'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('recover path calls recoverIdentity then navigates', async () => {
    recoverIdentity.mockResolvedValue({ id: 's1', event_key: '2026casnv' });
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'ABCD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('recover-submit'));

    await waitFor(() => expect(recoverIdentity).toHaveBeenCalledWith('ABCD', 'Ada'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/scout'));
  });
});
