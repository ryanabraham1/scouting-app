import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';

// POST a batch of received reports to the `ingest-reports` Edge Function
// (contracts §5). Auth is the receiver's session JWT (event-member gate on the
// server); the service-role upsert there carries OTHER scouts' reports safely.
export interface IngestResult {
  ingested: number;
  failed: { index: number; error: string }[];
}

// The `ingest-reports` function hard-rejects (413) any POST carrying more than
// 100 reports or a body larger than 1 MiB. A QR hand-off can legitimately carry
// far more than that (envelope MAX_QR_REPORTS = 1000, MAX_QR_PAYLOAD_BYTES = 2
// MiB), so the whole rescue backlog must be split into server-sized chunks
// rather than dead-failing the transfer. Keep these aligned with the function's
// MAX_REPORTS / MAX_REQUEST_BYTES.
const MAX_REPORTS_PER_BATCH = 100;
// Leave headroom under the server's 1 MiB request cap for the `{ "reports": [] }`
// wrapper and inter-element commas so a full batch never trips the byte limit.
const MAX_BATCH_BYTES = 1024 * 1024 - 16 * 1024;

function reportByteLength(report: unknown): number {
  // +1 for the comma/closing overhead each element contributes to the array.
  return new TextEncoder().encode(JSON.stringify(report)).byteLength + 1;
}

// Greedily split reports into batches that satisfy BOTH the server's per-batch
// count and body-size limits. An oversized single report is still emitted alone
// so postIngest can report that row as failed without sending an over-limit
// request or stranding the rest of the backlog.
export function batchReports(reports: unknown[]): unknown[][] {
  const batches: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 2; // "[]"
  for (const report of reports) {
    const size = reportByteLength(report);
    const wouldExceedCount = current.length >= MAX_REPORTS_PER_BATCH;
    const wouldExceedBytes = current.length > 0 && currentBytes + size > MAX_BATCH_BYTES;
    if (current.length > 0 && (wouldExceedCount || wouldExceedBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(report);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function postBatch(reports: unknown[], token: string): Promise<IngestResult> {
  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/ingest-reports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({ reports }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `Ingest failed (${res.status})`);
  }

  return (await res.json()) as IngestResult;
}

export async function postIngest(reports: unknown[]): Promise<IngestResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('not signed in');
  }

  // Always POST at least once (an empty transfer still round-trips { reports: [] }).
  const batches = reports.length > 0 ? batchReports(reports) : [[]];

  let ingested = 0;
  const failed: { index: number; error: string }[] = [];
  let offset = 0;
  for (const batch of batches) {
    if (batch.length === 1 && reportByteLength(batch[0]) > MAX_BATCH_BYTES) {
      failed.push({ index: offset, error: 'Report exceeds the QR upload size limit.' });
      offset += 1;
      continue;
    }
    const result = await postBatch(batch, token);
    ingested += result.ingested;
    // Re-base each chunk's per-batch index onto the caller's original array so
    // failed[].index still points at the right report across the whole backlog.
    for (const f of result.failed) {
      failed.push({ index: f.index + offset, error: f.error });
    }
    offset += batch.length;
  }

  return { ingested, failed };
}
