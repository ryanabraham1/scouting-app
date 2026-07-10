import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const savePitDraft = vi.fn().mockResolvedValue(undefined);
const getPitDraft = vi.fn().mockResolvedValue(undefined);
const getPitReport = vi.fn().mockResolvedValue(undefined);
const fetchPitReportForEdit = vi.fn().mockResolvedValue(null);
const enqueuePitReport = vi.fn().mockResolvedValue(undefined);
const signedPitPhotoUrl = vi.fn().mockResolvedValue('https://signed/a.jpg');

vi.mock('../pitStore', () => ({
  PIT_NUMERIC_LIMITS: {
    batteryCount: 99,
    chargerCount: 99,
    dimensionIn: 120,
    teamNumber: 99_999,
  },
  savePitDraft: (...a: unknown[]) => savePitDraft(...a),
  getPitDraft: (...a: unknown[]) => getPitDraft(...a),
  getPitReport: (...a: unknown[]) => getPitReport(...a),
  fetchPitReportForEdit: (...a: unknown[]) => fetchPitReportForEdit(...a),
  enqueuePitReport: (...a: unknown[]) => enqueuePitReport(...a),
}));
vi.mock('../photoUpload', () => ({
  signedPitPhotoUrl: (...a: unknown[]) => signedPitPhotoUrl(...a),
}));
vi.mock('../processPhoto', () => ({
  MAX_PIT_PHOTOS: 6,
  processPitPhoto: async (file: Blob) => ({ blob: file, width: 100, height: 80 }),
}));

// jsdom has no Object URL plumbing; stub it so the local photo preview renders.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:preview';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined;
}

import PitScoutScreen, { parsePitNumber } from '../PitScoutScreen';

const props = { eventKey: '2026casj', teamNumber: 254, scoutId: 'scout-1' };

async function renderReady(element = <PitScoutScreen {...props} />): Promise<void> {
  render(element);
  await screen.findByTestId('pit-screen');
}

describe('PitScoutScreen', () => {
  beforeEach(() => {
    savePitDraft.mockClear();
    getPitDraft.mockClear().mockResolvedValue(undefined);
    getPitReport.mockClear().mockResolvedValue(undefined);
    fetchPitReportForEdit.mockClear().mockResolvedValue(null);
    enqueuePitReport.mockClear().mockResolvedValue(undefined);
    signedPitPhotoUrl.mockClear().mockResolvedValue('https://signed/a.jpg');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the pit form', async () => {
    await renderReady();
    expect(screen.getByTestId('pit-screen')).toBeInTheDocument();
    expect(screen.getByTestId('pit-drivetrain')).toBeInTheDocument();
    expect(screen.getByTestId('pit-submit')).toBeInTheDocument();
    expect(screen.getByTestId('pit-back')).toBeDisabled();
  });

  it('clamps finite numeric inputs to explicit upper bounds', () => {
    expect(parsePitNumber('Infinity', 99)).toBeNull();
    expect(parsePitNumber('500', 99)).toBe(99);
    expect(parsePitNumber('-5', 120)).toBe(0);
  });

  it('blocks exit and offers a retry when durable draft storage fails', async () => {
    const onExit = vi.fn();
    savePitDraft.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));
    await renderReady(<PitScoutScreen {...props} onExit={onExit} />);

    fireEvent.change(screen.getByTestId('pit-drivetrain'), { target: { value: 'swerve' } });
    expect(await screen.findByTestId('pit-storage-error')).toHaveTextContent(/only in memory/i);
    expect(screen.getByTestId('pit-back')).toBeDisabled();

    savePitDraft.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: /retry device save/i }));
    await waitFor(() => expect(screen.getByTestId('pit-back')).toBeEnabled());
    fireEvent.click(screen.getByTestId('pit-back'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('uses the first-step Back control as an injected route exit', async () => {
    const onExit = vi.fn();
    await renderReady(<PitScoutScreen {...props} onExit={onExit} />);
    const back = screen.getByTestId('pit-back');
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(onExit).toHaveBeenCalledTimes(1);
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

  it('queues the report, shows a saved indicator, and calls onDone', async () => {
    const onDone = vi.fn();
    await renderReady(<PitScoutScreen {...props} onDone={onDone} />);
    fireEvent.change(screen.getByTestId('pit-drivetrain'), {
      target: { value: 'swerve' },
    });
    fireEvent.click(screen.getByTestId('pit-submit'));
    await waitFor(() => expect(enqueuePitReport).toHaveBeenCalledTimes(1));
    expect(enqueuePitReport.mock.calls[0][0]).toMatchObject({
      eventKey: '2026casj',
      teamNumber: 254,
      drivetrain: 'swerve',
      scoutId: 'scout-1',
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('shows a saved indicator when no onDone is provided', async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId('pit-submit'));
    expect(await screen.findByTestId('pit-saved')).toBeInTheDocument();
  });

  it('shows an error indicator when queueing fails', async () => {
    enqueuePitReport.mockRejectedValue(new Error('db'));
    await renderReady();
    fireEvent.click(screen.getByTestId('pit-submit'));
    expect(await screen.findByTestId('pit-error')).toBeInTheDocument();
  });

  it('attaches a photo locally and shows a preview without uploading', async () => {
    await renderReady();
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('pit-photo'), {
      target: { files: [file] },
    });
    // Preview comes from a local object URL — no network upload at capture time.
    expect(await screen.findByAltText(/pit photo/i)).toBeInTheDocument();
    expect(signedPitPhotoUrl).not.toHaveBeenCalled();
    // The blob is persisted into the draft for offline survival.
    await waitFor(() => expect(savePitDraft).toHaveBeenCalled());
    const lastCall = savePitDraft.mock.calls[savePitDraft.mock.calls.length - 1];
    expect(Object.values(lastCall[3])[0]).toBeInstanceOf(Blob);
  });

  it('refreshes a synced local snapshot from the latest server baseline', async () => {
    const submittedData = {
      eventKey: '2026casj',
      teamNumber: 254,
      drivetrain: 'swerve',
      mechanisms: ['shooter'],
      capabilities: ['auto'],
      intakeSources: ['neutral'],
      notes: 'original notes',
      photos: [],
      photoPath: null,
      scoutId: 'another-scout',
    };
    getPitReport.mockResolvedValue({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      data: submittedData,
      photoBlobs: {},
      syncState: 'synced',
      syncAttempts: 0,
      lastSyncError: null,
      baseRevision: 100,
      rowRevision: 100,
      createdAt: 'now',
      updatedAt: 'now',
    });
    fetchPitReportForEdit.mockResolvedValue({
      report: submittedData,
      revision: 100,
    });
    fetchPitReportForEdit.mockResolvedValue({
      revision: 200,
      report: {
        eventKey: '2026casj',
        teamNumber: 254,
        drivetrain: 'tank',
        mechanisms: ['arm'],
        capabilities: [],
        intakeSources: [],
        notes: 'newer server notes',
        photos: [],
        photoPath: null,
        scoutId: 'scout-1',
      },
    });
    await renderReady();
    expect(await screen.findByTestId('pit-editing')).toBeInTheDocument();
    expect(screen.getByTestId('pit-drivetrain')).toHaveValue('tank');
    expect(screen.getByLabelText(/notes/i)).toHaveValue('newer server notes');
    expect(fetchPitReportForEdit).toHaveBeenCalled();
  });

  it('preserves a genuinely unsynced local row without fetching over it', async () => {
    getPitReport.mockResolvedValue({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      data: {
        eventKey: '2026casj', teamNumber: 254, drivetrain: 'swerve',
        mechanisms: [], capabilities: [], intakeSources: [], notes: 'offline work',
        photos: [], photoPath: null, scoutId: 'scout-1',
      },
      photoBlobs: {},
      syncState: 'dirty',
      syncAttempts: 0,
      lastSyncError: null,
      baseRevision: 100,
      rowRevision: 101,
      createdAt: 'now',
      updatedAt: 'now',
    });
    render(<PitScoutScreen {...props} />);
    await waitFor(() => expect(screen.getByLabelText(/notes/i)).toHaveValue('offline work'));
    expect(fetchPitReportForEdit).not.toHaveBeenCalled();
  });

  it('loads the server after a conflict and recovers local content onto its revision', async () => {
    getPitReport.mockResolvedValue({
      draftKey: '2026casj:254',
      eventKey: '2026casj',
      teamNumber: 254,
      data: {
        eventKey: '2026casj', teamNumber: 254, drivetrain: 'swerve',
        mechanisms: [], capabilities: [], intakeSources: [], notes: 'device A copy',
        photos: [], photoPath: null, scoutId: 'scout-a',
      },
      photoBlobs: {},
      syncState: 'error',
      syncAttempts: 1,
      lastSyncError: 'PIT_EDIT_CONFLICT',
      baseRevision: 100,
      rowRevision: 101,
      createdAt: 'now',
      updatedAt: 'now',
    });
    fetchPitReportForEdit.mockResolvedValue({
      revision: 250,
      report: {
        eventKey: '2026casj', teamNumber: 254, drivetrain: 'tank',
        mechanisms: [], capabilities: [], intakeSources: [], notes: 'device B latest',
        photos: [], photoPath: null, scoutId: 'scout-1',
      },
    });

    render(<PitScoutScreen {...props} />);
    expect(await screen.findByTestId('pit-conflict-recovery')).toHaveTextContent(
      /latest shared version/i,
    );
    expect(screen.getByLabelText(/notes/i)).toHaveValue('device B latest');
    fireEvent.click(screen.getByRole('button', { name: /recover my local copy/i }));
    expect(screen.getByLabelText(/notes/i)).toHaveValue('device A copy');
    fireEvent.click(screen.getByTestId('pit-submit'));
    await waitFor(() => expect(enqueuePitReport).toHaveBeenCalled());
    expect(enqueuePitReport.mock.calls.at(-1)?.[2]).toBe(250);
  });

  it('adds multiple library photos in one selection', async () => {
    await renderReady();
    fireEvent.change(screen.getByTestId('pit-photo'), {
      target: {
        files: [
          new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
          new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
        ],
      },
    });
    await waitFor(() => expect(screen.getAllByAltText(/pit photo/i)).toHaveLength(2));
    fireEvent.click(screen.getByTestId('pit-submit'));
    await waitFor(() => expect(enqueuePitReport).toHaveBeenCalled());
    expect(enqueuePitReport.mock.calls.at(-1)?.[0].photos).toHaveLength(2);
  });

  it('uses the wide field editor on desktop-sized viewports', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    await renderReady();

    expect(screen.getByTestId('pit-screen')).toHaveClass('max-w-5xl');
    expect(screen.getByTestId('pit-auto-field-shell')).toHaveClass('max-w-4xl');
    expect(screen.getByTestId('pit-auto-field')).toHaveAttribute('data-rotated', 'false');
  });
});
