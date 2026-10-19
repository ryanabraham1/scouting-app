// src/dash/board/persistence.ts
// Ryan's Board <-> this device. Document records go to Dexie `boardRecords`
// (one row per record, written 'dirty' so the cloud outbox can drain them);
// the camera and tool prefs are per-device conveniences in localStorage.
// Plan: docs/plans/ryans-board/README.md §7.
import { deleteBoardRecordRows, getBoardRecordRows, writeBoardRecords } from '@/db/localStore';
import { notifySyncQueueChanged } from '@/sync/queueEvents';
import { isTombstone, parseRecord, type BoardRecord, type Shape } from '@/dash/board/model';
import type { BoardChange, BoardEditor, BoardStyle, Camera, Tool } from '@/dash/board/editor';

const FLUSH_MS = 250;
const CAMERA_SAVE_MS = 800;
const CLIENT_ID_KEY = 'ryans-board-client-id';
const PREFS_KEY = 'ryans-board-prefs';

function cameraKey(boardKey: string): string {
  return `ryans-board-camera:${boardKey}`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: per-device convenience only.
  }
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let tabClientId: string | null = null;

/**
 * Per-tab client id: the stable device id plus a per-page-load suffix, so two
 * tabs or windows on one device are distinct collaborators (presence, cursors,
 * broadcast echo filtering) while revs still tie-break deterministically.
 */
export function boardClientId(): string {
  if (tabClientId) return tabClientId;
  let device = safeGet(CLIENT_ID_KEY);
  if (!device) {
    device = randomId();
    safeSet(CLIENT_ID_KEY, device);
  }
  tabClientId = `${device.slice(0, 18)}.${Math.random().toString(36).slice(2, 7)}`;
  return tabClientId;
}

/** Every stored record for a board (live shapes and tombstones), validated. */
export async function loadBoardRecords(boardKey: string): Promise<BoardRecord[]> {
  const rows = await getBoardRecordRows(boardKey);
  const out: BoardRecord[] = [];
  const junk: string[] = [];
  for (const r of rows) {
    const rec = parseRecord(r.data);
    if (rec) out.push(rec);
    else junk.push(r.key);
  }
  // Rows from an older board format (e.g. the tldraw prototype) must never sync.
  if (junk.length) await deleteBoardRecordRows(junk);
  return out;
}

export function liveShapes(records: readonly BoardRecord[]): Shape[] {
  return records.filter((r): r is Shape => !isTombstone(r));
}

export function loadCamera(boardKey: string): Camera | null {
  const raw = safeGet(cameraKey(boardKey));
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Camera;
    return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) ? c : null;
  } catch {
    return null;
  }
}

interface Prefs {
  tool?: Tool;
  style?: Partial<BoardStyle>;
}

export function loadPrefs(): Prefs {
  try {
    return (JSON.parse(safeGet(PREFS_KEY) ?? '{}') as Prefs) ?? {};
  } catch {
    return {};
  }
}

/**
 * Mirror every change into Dexie (batched, serialized) and the camera/prefs
 * into localStorage. Local edits land 'dirty'; remote merges land 'synced'.
 * Returns a disposer that flushes anything pending.
 */
export function persistBoard(editor: BoardEditor, boardKey: string): () => void {
  const pending = new Map<string, { record: BoardRecord; source: BoardChange['source'] }>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let camTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.size === 0) return;
    const local: { id: string; data: unknown; deleted: boolean }[] = [];
    const remote: { id: string; data: unknown; deleted: boolean }[] = [];
    for (const { record, source } of pending.values()) {
      const row = { id: record.id, data: record, deleted: isTombstone(record) };
      (source === 'local' ? local : remote).push(row);
    }
    pending.clear();
    chain = chain
      .then(async () => {
        await writeBoardRecords(boardKey, remote, 'synced');
        await writeBoardRecords(boardKey, local, 'dirty');
        // Wake the sync controller now instead of at the next poll tick, so
        // other devices see this edit within about a second.
        if (local.length) notifySyncQueueChanged();
      })
      .catch((err: unknown) => console.error("Ryan's Board: local save failed", err));
  };

  const stopChanges = editor.onChange((c) => {
    for (const s of c.puts) {
      // A remote write never downgrades a pending local edit of the same record.
      const prev = pending.get(s.id);
      if (c.source === 'remote' && prev?.source === 'local') continue;
      pending.set(s.id, { record: s, source: c.source });
    }
    for (const t of c.tombstones) {
      const prev = pending.get(t.id);
      if (c.source === 'remote' && prev?.source === 'local') continue;
      pending.set(t.id, { record: t, source: c.source });
    }
    // onChange fires at gesture commit, not every pointer sample. Start local
    // writes immediately so a quick reload does not lose the last stroke.
    if (c.source === 'local') flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  });

  let lastCam = editor.camera;
  let lastTool = editor.tool;
  let lastStyle = editor.style;
  const saveCamera = (): void => {
    camTimer = null;
    safeSet(cameraKey(boardKey), JSON.stringify(editor.camera));
  };
  const stopState = editor.subscribe(() => {
    if (editor.camera !== lastCam) {
      lastCam = editor.camera;
      if (!camTimer) camTimer = setTimeout(saveCamera, CAMERA_SAVE_MS);
    }
    if (editor.tool !== lastTool || editor.style !== lastStyle) {
      lastTool = editor.tool;
      lastStyle = editor.style;
      safeSet(PREFS_KEY, JSON.stringify({ tool: editor.tool, style: editor.style }));
    }
  });

  const onHide = (): void => {
    flush();
    if (camTimer) {
      clearTimeout(camTimer);
      saveCamera();
    }
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') onHide();
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopChanges();
    stopState();
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    onHide();
  };
}
