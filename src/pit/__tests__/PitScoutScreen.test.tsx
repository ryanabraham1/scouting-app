import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const savePitDraft = vi.fn().mockResolvedValue(undefined);
const getPitDraft = vi.fn().mockResolvedValue(undefined);
const submitPit = vi.fn().mockResolvedValue(undefined);
const uploadPitPhoto = vi.fn().mockResolvedValue('2026casj/254/a.jpg');
const signedPitPhotoUrl = vi.fn().mockResolvedValue('https://signed/a.jpg');

vi.mock('../pitStore', () => ({
  savePitDraft: (...a: unknown[]) => savePitDraft(...a),
  getPitDraft: (...a: unknown[]) => getPitDraft(...a),
  submitPit: (...a: unknown[]) => submitPit(...a),
}));
vi.mock('../photoUpload', () => ({
  uploadPitPhoto: (...a: unknown[]) => uploadPitPhoto(...a),
  signedPitPhotoUrl: (...a: unknown[]) => signedPitPhotoUrl(...a),
}));

import PitScoutScreen from '../PitScoutScreen';

const props = { eventKey: '2026casj', teamNumber: 254, scoutId: 'scout-1' };

describe('PitScoutScreen', () => {
  beforeEach(() => {
    savePitDraft.mockClear();
    getPitDraft.mockClear().mockResolvedValue(undefined);
    submitPit.mockClear().mockResolvedValue(undefined);
    uploadPitPhoto.mockClear().mockResolvedValue('2026casj/254/a.jpg');
    signedPitPhotoUrl.mockClear().mockResolvedValue('https://signed/a.jpg');
  });

  it('renders the pit form', () => {
    render(<PitScoutScreen {...props} />);
    expect(screen.getByTestId('pit-screen')).toBeInTheDocument();
    expect(screen.getByTestId('pit-drivetrain')).toBeInTheDocument();
    expect(screen.getByTestId('pit-submit')).toBeInTheDocument();
  });

  it('resumes a draft on mount', async () => {
    getPitDraft.mockResolvedValue({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      updatedAt: 'now',
      data: {
        eventKey: '2026casj',
        teamNumber: 254,
        drivetrain: 'tank',
        mechanisms: [],
        capabilities: [],
        intakeSources: [],
        photoPath: null,
        notes: 'resumed',
        scoutId: 'scout-1',
      },
    });
    render(<PitScoutScreen {...props} />);
    await waitFor(() =>
      expect((screen.getByTestId('pit-drivetrain') as HTMLSelectElement).value).toBe('tank')
    );
    expect(screen.getByLabelText(/notes/i)).toHaveValue('resumed');
  });

  it('submits the report and shows a saved indicator', async () => {
    render(<PitScoutScreen {...props} />);
    fireEvent.change(screen.getByTestId('pit-drivetrain'), {
      target: { value: 'swerve' },
    });
    fireEvent.click(screen.getByTestId('pit-submit'));
    await waitFor(() => expect(submitPit).toHaveBeenCalledTimes(1));
    expect(submitPit.mock.calls[0][0]).toMatchObject({
      eventKey: '2026casj',
      teamNumber: 254,
      drivetrain: 'swerve',
      scoutId: 'scout-1',
    });
    expect(await screen.findByTestId('pit-saved')).toBeInTheDocument();
  });

  it('shows an error indicator when submit fails', async () => {
    submitPit.mockRejectedValue(new Error('rls'));
    render(<PitScoutScreen {...props} />);
    fireEvent.click(screen.getByTestId('pit-submit'));
    expect(await screen.findByTestId('pit-error')).toBeInTheDocument();
  });

  it('uploads a photo and shows a preview', async () => {
    render(<PitScoutScreen {...props} />);
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('pit-photo'), {
      target: { files: [file] },
    });
    await waitFor(() => expect(uploadPitPhoto).toHaveBeenCalledTimes(1));
    expect(await screen.findByAltText(/pit photo/i)).toHaveAttribute(
      'src',
      'https://signed/a.jpg'
    );
  });
});
