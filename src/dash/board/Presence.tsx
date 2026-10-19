// src/dash/board/Presence.tsx
// Multiplayer UI: collaborator cursors on the canvas, the avatar stack (with a
// "your name" popover) and the sync-state chip in the top bar.
import { useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CloudCheck, CloudOff, Loader2, MousePointer2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor } from '@/dash/board/editor';
import type { BoardLive } from '@/dash/board/live';
import { COLORS } from '@/dash/board/model';
import type { BoardSyncState } from '@/dash/board/cloud';

function useLive(live: BoardLive): number {
  return useSyncExternalStore(live.subscribe, () => live.version);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

export function RemoteCursors({ editor, live }: { editor: BoardEditor; live: BoardLive }): JSX.Element {
  useLive(live);
  const camera = useBoard(editor, (e) => e.camera);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {[...live.peers.values()].map((p) => {
        if (!p.cursor) return null;
        const x = p.cursor.x * camera.z + camera.x;
        const y = p.cursor.y * camera.z + camera.y;
        const color = COLORS[p.color];
        return (
          <div
            key={p.clientId}
            className="absolute left-0 top-0 flex items-start gap-0.5 transition-transform duration-75 ease-linear"
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            <MousePointer2 className="size-[18px]" style={{ color, fill: color }} />
            <span
              className="mt-3.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
              style={{ background: color, color: '#0a0a0a' }}
            >
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function PresenceStack({ live }: { live: BoardLive }): JSX.Element {
  useLive(live);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(live.name);
  const peers = [...live.peers.values()];
  const shown = peers.slice(0, 3);
  const avatar = (name: string, color: keyof typeof COLORS, key: string, ring = false): JSX.Element => (
    <span
      key={key}
      title={name}
      className={cn(
        '-ml-1.5 inline-flex size-[26px] items-center justify-center rounded-full border-2 border-card text-[10.5px] font-bold first:ml-0',
        ring && 'outline outline-1 outline-white/20',
      )}
      style={{ background: COLORS[color], color: '#0a0a0a' }}
    >
      {initials(name)}
    </span>
  );
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setDraft(live.name);
          setOpen((v) => !v);
        }}
        aria-label={`People on this board: ${peers.length + 1}`}
        className="flex items-center rounded-full"
      >
        {avatar(live.name, live.color, 'me', true)}
        {shown.map((p) => avatar(p.name, p.color, p.clientId))}
        {peers.length > shown.length && (
          <span className="-ml-1.5 inline-flex size-[26px] items-center justify-center rounded-full border-2 border-card bg-muted text-[10px] font-semibold text-muted-foreground">
            +{peers.length - shown.length}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="People on this board"
          className="absolute right-0 top-9 z-40 w-60 rounded-xl border border-[hsl(0_0%_20%)] bg-[hsl(0_0%_8%)] p-3 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              live.setName(draft);
              setOpen(false);
            }}
          >
            <label className="eyebrow mb-1.5 block" htmlFor="board-name">
              Your name
            </label>
            <div className="flex gap-1.5">
              <input
                id="board-name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={32}
                className="min-w-0 flex-1 rounded-lg border border-[hsl(0_0%_22%)] bg-transparent px-2 py-1 text-sm outline-none focus:border-brand"
                placeholder="Ryan"
              />
              <button type="submit" className="rounded-lg bg-white/10 px-2.5 text-xs font-semibold hover:bg-white/15">
                Save
              </button>
            </div>
          </form>
          <div className="eyebrow mb-1 mt-3">Here now</div>
          <ul className="space-y-1">
            <li className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: COLORS[live.color] }} />
              {live.name} <span className="text-muted-foreground">(you)</span>
            </li>
            {peers.map((p) => (
              <li key={p.clientId} className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: COLORS[p.color] }} />
                {p.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SyncChip({ state }: { state: BoardSyncState }): JSX.Element {
  const base = 'hidden shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] sm:inline-flex';
  if (state === 'error') {
    return (
      <Link to="/sync" className={cn(base, 'bg-destructive/15 text-destructive hover:bg-destructive/25')}>
        <AlertTriangle className="size-3" aria-hidden />
        Sync error
      </Link>
    );
  }
  if (state === 'offline') {
    return (
      <span className={cn(base, 'bg-muted text-muted-foreground')} title="Changes are saved on this device and upload when you're back online">
        <CloudOff className="size-3" aria-hidden />
        Offline, saved on device
      </span>
    );
  }
  if (state === 'saving') {
    return (
      <span className={cn(base, 'bg-brand/10 text-brand')}>
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Saving
      </span>
    );
  }
  return (
    <span className={cn(base, 'bg-success/10 text-success')}>
      <CloudCheck className="size-3" aria-hidden />
      Synced
    </span>
  );
}
