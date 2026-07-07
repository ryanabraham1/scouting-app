import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Control the install plumbing so the banner's branches are deterministic.
const state = {
  canPrompt: false,
  installed: false,
  standalone: false,
  ios: false,
  promptInstall: vi.fn(() => Promise.resolve('accepted' as const)),
};

vi.mock('@/pwa/useInstallPrompt', () => ({
  useInstallPrompt: () => ({
    canPrompt: state.canPrompt,
    installed: state.installed,
    promptInstall: state.promptInstall,
  }),
  isStandalone: () => state.standalone,
  isIOS: () => state.ios,
}));

import { InstallPrompt } from '@/pwa/InstallPrompt';

beforeEach(() => {
  cleanup();
  state.canPrompt = false;
  state.installed = false;
  state.standalone = false;
  state.ios = false;
  state.promptInstall.mockClear();
});

describe('InstallPrompt', () => {
  it('renders an Add button and calls promptInstall on click (native prompt available)', () => {
    state.canPrompt = true;
    render(<InstallPrompt />);
    expect(screen.getByTestId('install-prompt')).toBeTruthy();
    fireEvent.click(screen.getByTestId('install-prompt-add'));
    expect(state.promptInstall).toHaveBeenCalled();
  });

  it('shows Share-sheet instructions (no Add button) on iOS', () => {
    state.ios = true;
    render(<InstallPrompt />);
    expect(screen.getByTestId('install-prompt')).toBeTruthy();
    expect(screen.queryByTestId('install-prompt-add')).toBeNull();
    expect(screen.getByText(/Add to Home Screen/i)).toBeTruthy();
  });

  it('opens (and closes) the step-by-step guide from the iOS "Show me" button', () => {
    state.ios = true;
    render(<InstallPrompt />);
    fireEvent.click(screen.getByTestId('install-prompt-how'));
    const guide = screen.getByTestId('install-guide');
    expect(guide).toBeTruthy();
    // The three-step sequence is present, in order.
    expect(guide.textContent).toMatch(/Tap the Share button.*Add to Home Screen.*Tap Add/s);
    fireEvent.click(screen.getByTestId('install-guide-close'));
    expect(screen.queryByTestId('install-guide')).toBeNull();
    // Banner remains (guide close is not a dismiss).
    expect(screen.getByTestId('install-prompt')).toBeTruthy();
  });

  it('renders nothing when already installed / standalone', () => {
    state.canPrompt = true;
    state.standalone = true;
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no way to install (not iOS, no prompt)', () => {
    const { container } = render(<InstallPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('dismisses when the close button is tapped', () => {
    state.canPrompt = true;
    render(<InstallPrompt />);
    fireEvent.click(screen.getByTestId('install-prompt-dismiss'));
    expect(screen.queryByTestId('install-prompt')).toBeNull();
  });
});
