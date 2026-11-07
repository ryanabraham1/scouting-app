// src/dash/AutoScoutCalibration.tsx — calibrate an event from any device. The computer grabs a frame
// from the stream, a lead taps the field landmarks, and the field is drawn over the picture so a
// wrong tap shows before anything is saved.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  calibrationKey,
  useAutoScoutCalibration,
  useAutoScoutCommands,
  useSendAutoScoutCommand,
} from '@/dash/autoScoutClient';
import { fieldOutlines, homography, LANDMARKS, project, type Point } from '@/dash/autoScoutGeometry';

interface Step {
  name: string;
  label: string;
  hint: string;
}

function stepsFor(blueLeft: boolean): Step[] {
  return [
    { name: 'blue_hub_center', label: 'Blue hub', hint: 'Middle of the hub where it meets the floor' },
    { name: 'red_hub_center', label: 'Red hub', hint: 'Middle of the hub where it meets the floor' },
    { name: blueLeft ? 'center_line_yW' : 'center_line_y0', label: 'Center line, far', hint: 'Where it meets the far edge of the carpet' },
    { name: blueLeft ? 'center_line_y0' : 'center_line_yW', label: 'Center line, near', hint: 'Where it meets the near edge of the carpet' },
    { name: 'blue_hub_top', label: 'Blue hub top', hint: 'Middle of the top opening (optional)' },
    { name: 'red_hub_top', label: 'Red hub top', hint: 'Middle of the top opening (optional)' },
  ];
}

const svgPath = (points: Point[], close = true) =>
  `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')}${close ? ' Z' : ''}`;

function densify(points: Point[], close: boolean): Point[] {
  const out: Point[] = [];
  const count = close ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    for (let t = 0; t < 1; t += 0.1) out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  if (!close) out.push(points[points.length - 1]);
  return out;
}

export default function AutoScoutCalibrationPanel({ eventKey, onClose }: { eventKey: string; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const calibrationQ = useAutoScoutCalibration(eventKey, true);
  const commandsQ = useAutoScoutCommands(eventKey);
  const send = useSendAutoScoutCommand(eventKey);
  const calibration = calibrationQ.data;

  const [points, setPoints] = useState<Record<string, Point>>({});
  const [blueLeft, setBlueLeft] = useState(true);
  const [active, setActive] = useState(0);
  const [band, setBand] = useState<[number, number]>([0.5, 0.85]);
  const [link, setLink] = useState('');
  const loaded = useRef<string | null>(null);

  const size = (calibration?.frame_size ?? [1920, 1080]) as [number, number];
  const steps = useMemo(() => stepsFor(blueLeft), [blueLeft]);
  const latest = commandsQ.data ?? [];
  const capturing = latest.find((c) => c.kind === 'capture_frame');
  const saving = latest.find((c) => c.kind === 'save_calibration');
  const busy = (c: typeof capturing) => c?.status === 'queued' || c?.status === 'running';

  // A finished capture means there's a new frame to fetch.
  const captureStatus = capturing ? `${capturing.id}:${capturing.status}` : '';
  useEffect(() => {
    if (capturing?.status === 'done') void client.invalidateQueries({ queryKey: calibrationKey(eventKey) });
  }, [captureStatus, capturing?.status, client, eventKey]);

  // Start from what's saved, once per frame, so a lead adjusts rather than redoes it.
  useEffect(() => {
    if (!calibration?.frame_at || loaded.current === calibration.frame_at) return;
    loaded.current = calibration.frame_at;
    if (calibration.points) {
      setPoints(calibration.points);
      const { blue_hub_center: blue, red_hub_center: red } = calibration.points;
      if (blue && red) setBlueLeft(blue[0] < red[0]);
    }
    if (calibration.view) {
      const [, top, , height] = calibration.view;
      setBand([top / size[1], (top + height) / size[1]]);
    }
  }, [calibration, size]);

  const h = useMemo(() => {
    const names = Object.keys(LANDMARKS).filter((name) => points[name]);
    return homography(names.map((n) => LANDMARKS[n]), names.map((n) => points[n]));
  }, [points]);

  const drawn = useMemo(() => {
    if (!h) return null;
    const lines = fieldOutlines();
    const map = (list: Point[], close = true) => svgPath(densify(list, close).map((p) => project(h, p)), close);
    return { outline: map(lines.outline), center: map(lines.center, false), hubs: lines.hubs.map((hub) => map(hub)) };
  }, [h]);

  function place(event: MouseEvent<HTMLDivElement>): void {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * size[0];
    const y = ((event.clientY - box.top) / box.height) * size[1];
    setPoints((current) => ({ ...current, [steps[active].name]: [Math.round(x), Math.round(y)] }));
    setActive((i) => (i + 1) % steps.length);
  }

  function nudge(dx: number, dy: number): void {
    const name = steps[active].name;
    setPoints((current) => (current[name] ? { ...current, [name]: [current[name][0] + dx, current[name][1] + dy] } : current));
  }

  function save(): void {
    const top = Math.round(band[0] * size[1]);
    const bottom = Math.round(band[1] * size[1]);
    send.mutate({
      kind: 'save_calibration',
      payload: { points, view: [0, top, size[0], bottom - top], frame_size: size },
    });
  }

  const missing = Object.keys(LANDMARKS).filter((name) => !points[name]).length;
  const frame = calibration?.frame_jpeg;

  return (
    <section data-testid="autoscout-calibration" className="lead-settings-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <h2 className="font-semibold">Calibrate {eventKey}</h2>
          <p className="text-sm text-muted-foreground">Use a moment when the wide shot shows the whole field.</p>
        </div>
        <span className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={send.isPending || busy(capturing)}
            onClick={() => send.mutate({ kind: 'capture_frame', payload: link.trim() ? { source_url: link.trim() } : {} })}
          >
            <Camera className="size-4" />
            {busy(capturing) ? 'Capturing…' : frame ? 'New frame' : 'Capture frame'}
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Close calibration" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </span>
      </div>
      {capturing?.status === 'failed' && (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">{capturing.error}</p>
      )}
      {send.error && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{send.error.message}</p>}

      {!frame ? (
        <div className="space-y-2 p-4 pt-0">
          <Input
            aria-label="Stream link for the frame"
            inputMode="url"
            placeholder="Stream link (optional: the live event stream is used by default)"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
      ) : (
        <div className="grid gap-4 p-4 pt-0 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div
            data-testid="autoscout-calibration-frame"
            role="presentation"
            onClick={place}
            className="relative cursor-crosshair overflow-hidden rounded-lg border border-border"
          >
            <img src={`data:image/jpeg;base64,${frame}`} alt="Stream frame to calibrate" className="block w-full select-none" draggable={false} />
            <svg viewBox={`0 0 ${size[0]} ${size[1]}`} className="pointer-events-none absolute inset-0 size-full">
              <rect x="0" y={band[0] * size[1]} width={size[0]} height={(band[1] - band[0]) * size[1]} fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray="10 8" />
              {drawn && (
                <>
                  <path d={drawn.outline} fill="none" stroke="#facc15" strokeWidth="3" />
                  <path d={drawn.center} fill="none" stroke="#fff" strokeWidth="3" />
                  {drawn.hubs.map((d) => <path key={d} d={d} fill="none" stroke="#4ade80" strokeWidth="3" />)}
                </>
              )}
              {steps.map((step, i) =>
                points[step.name] ? (
                  <g key={step.name}>
                    <circle cx={points[step.name][0]} cy={points[step.name][1]} r={i === active ? 12 : 8} fill="none" stroke={i === active ? '#22d3ee' : '#fff'} strokeWidth="3" />
                    <circle cx={points[step.name][0]} cy={points[step.name][1]} r="2" fill="#fff" />
                  </g>
                ) : null,
              )}
            </svg>
          </div>

          <div className="flex min-w-0 flex-col gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={blueLeft} onChange={(e) => setBlueLeft(e.target.checked)} />
              Blue alliance is on the left
            </label>
            <ol className="flex flex-col gap-1">
              {steps.map((step, i) => (
                <li key={step.name}>
                  <button
                    type="button"
                    aria-pressed={i === active}
                    onClick={() => setActive(i)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left',
                      i === active ? 'border-brand bg-brand/10' : 'border-border',
                    )}
                  >
                    {step.label}
                    {points[step.name] ? <Check className="size-4 text-success" /> : null}
                  </button>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">{steps[active].hint}. Tap the picture to place it.</p>
            <div className="grid grid-cols-4 gap-1" aria-label="Nudge the selected point">
              {[['←', -2, 0], ['↑', 0, -2], ['↓', 0, 2], ['→', 2, 0]].map(([label, dx, dy]) => (
                <Button key={label as string} type="button" size="sm" variant="outline" onClick={() => nudge(dx as number, dy as number)}>
                  {label}
                </Button>
              ))}
            </div>
            <label className="block text-xs text-muted-foreground">
              Top of field area
              <input type="range" className="w-full" min="0" max="0.95" step="0.005" value={band[0]} onChange={(e) => setBand([Math.min(Number(e.target.value), band[1] - 0.05), band[1]])} />
            </label>
            <label className="block text-xs text-muted-foreground">
              Bottom of field area
              <input type="range" className="w-full" min="0.05" max="1" step="0.005" value={band[1]} onChange={(e) => setBand([band[0], Math.max(Number(e.target.value), band[0] + 0.05)])} />
            </label>
            <p className="text-xs text-muted-foreground">
              The yellow outline should sit on the carpet edges and the green squares on the hub bases. The dashed box should include the field and the air above the hubs.
            </p>
            <button
              type="button"
              className="lead-primary-action disabled:opacity-50"
              disabled={missing > 0 || send.isPending || busy(saving)}
              onClick={save}
            >
              {busy(saving) ? 'Saving…' : missing > 0 ? `Place ${missing} more` : 'Save calibration'}
            </button>
            {saving?.status === 'done' && <p role="status" className="text-sm text-success">Saved to the computer.</p>}
            {saving?.status === 'failed' && <p role="alert" className="text-sm text-destructive">{saving.error}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
