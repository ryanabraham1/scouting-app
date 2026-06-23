import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  savePitDraft,
  getPitDraft,
  submitPit,
  type PitReport,
} from './pitStore';
import { uploadPitPhoto, signedPitPhotoUrl } from './photoUpload';

export interface PitScoutScreenProps {
  eventKey: string;
  teamNumber: number;
  scoutId: string;
}

const DRIVETRAINS = ['', 'swerve', 'tank', 'mecanum', 'west_coast', 'other'];
const CAPABILITY_OPTIONS = ['auto', 'climb_l1', 'climb_l2', 'climb_l3', 'defense'];
const INTAKE_OPTIONS = ['neutral', 'depot', 'human_feed'];

function emptyReport(p: PitScoutScreenProps): PitReport {
  return {
    eventKey: p.eventKey,
    teamNumber: p.teamNumber,
    drivetrain: '',
    mechanisms: [],
    capabilities: [],
    intakeSources: [],
    photoPath: null,
    notes: '',
    scoutId: p.scoutId,
  };
}

export default function PitScoutScreen(props: PitScoutScreenProps): JSX.Element {
  const [report, setReport] = React.useState<PitReport>(() => emptyReport(props));
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  const [uploading, setUploading] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void getPitDraft(props.eventKey, props.teamNumber).then((draft) => {
      if (active && draft) {
        setReport(draft.data);
        if (draft.data.photoPath) {
          void signedPitPhotoUrl(draft.data.photoPath).then((url) => {
            if (active) setPreviewUrl(url);
          });
        }
      }
    });
    return () => {
      active = false;
    };
  }, [props.eventKey, props.teamNumber]);

  function update(patch: Partial<PitReport>): void {
    setReport((prev) => {
      const next = { ...prev, ...patch };
      void savePitDraft(props.eventKey, props.teamNumber, next);
      return next;
    });
    setStatus('idle');
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadPitPhoto(props.eventKey, props.teamNumber, file);
      const url = await signedPitPhotoUrl(path);
      setPreviewUrl(url);
      update({ photoPath: path });
    } catch {
      setStatus('error');
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(): Promise<void> {
    setStatus('saving');
    try {
      await submitPit(report);
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div
      data-testid="pit-screen"
      className="mx-auto flex max-w-md flex-col gap-4 p-4"
    >
      <h1 className="text-lg font-semibold">
        Pit Scout — Team {props.teamNumber}
      </h1>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-drivetrain">Drivetrain</Label>
        <select
          id="pit-drivetrain"
          data-testid="pit-drivetrain"
          value={report.drivetrain}
          onChange={(e) => update({ drivetrain: e.target.value })}
          className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {DRIVETRAINS.map((d) => (
            <option key={d} value={d}>
              {d === '' ? 'Select…' : d}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-mechanisms">Mechanisms (comma separated)</Label>
        <Input
          id="pit-mechanisms"
          className="h-11"
          value={report.mechanisms.join(', ')}
          onChange={(e) =>
            update({
              mechanisms: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Capabilities</legend>
        {CAPABILITY_OPTIONS.map((c) => (
          <label key={c} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={report.capabilities.includes(c)}
              onChange={() =>
                update({ capabilities: toggle(report.capabilities, c) })
              }
            />
            {c}
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Intake sources</legend>
        {INTAKE_OPTIONS.map((s) => (
          <label key={s} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={report.intakeSources.includes(s)}
              onChange={() =>
                update({ intakeSources: toggle(report.intakeSources, s) })
              }
            />
            {s}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-notes">Notes</Label>
        <textarea
          id="pit-notes"
          className="min-h-24 w-full rounded-md border border-input bg-transparent p-3 text-sm"
          value={report.notes}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pit-photo">Robot photo</Label>
        <input
          id="pit-photo"
          data-testid="pit-photo"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => void onPhoto(e)}
          className="min-h-11 text-sm"
        />
        {previewUrl && (
          <img
            src={previewUrl}
            alt="pit photo preview"
            className="max-h-64 w-full rounded-md object-contain"
          />
        )}
      </div>

      <Button
        data-testid="pit-submit"
        size="lg"
        className="min-h-11"
        disabled={status === 'saving' || uploading}
        onClick={() => void onSubmit()}
      >
        {status === 'saving' ? 'Submitting…' : 'Submit'}
      </Button>

      {status === 'saved' && (
        <p data-testid="pit-saved" className="text-sm text-green-500">
          Saved.
        </p>
      )}
      {status === 'error' && (
        <p data-testid="pit-error" className="text-sm text-destructive">
          Submit failed — draft kept offline.
        </p>
      )}
    </div>
  );
}
