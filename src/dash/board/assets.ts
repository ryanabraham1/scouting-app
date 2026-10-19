// Upload only while draining the durable outbox. Offline inserts keep their
// original data URL locally; a failed upload is retried by the normal outbox.
import { supabase } from '@/lib/supabase';

export async function uploadBoardImage(boardKey: string, raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'image' || typeof r.src !== 'string' || !r.src.startsWith('data:image/')) return raw;
  const response = await fetch(r.src);
  const bytes = await response.arrayBuffer();
  const blob = new Blob([bytes], { type: response.headers.get('content-type') ?? 'image/png' });
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
  // Content hash makes retries idempotent without overwriting another revision
  // (or showing a stale cached image after a replacement).
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const path = `${encodeURIComponent(boardKey)}/${hash}.${ext}`;
  const bucket = supabase.storage.from('board-assets');
  const { error } = await bucket.upload(path, blob, { contentType: blob.type, upsert: true, cacheControl: '31536000' });
  if (error) throw error;
  return { ...r, src: bucket.getPublicUrl(path).data.publicUrl };
}
