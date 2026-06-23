import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';

// POST a batch of received reports to the `ingest-reports` Edge Function
// (contracts §5). Auth is the receiver's session JWT (event-member gate on the
// server); the service-role upsert there carries OTHER scouts' reports safely.
export async function postIngest(reports: unknown[]): Promise<{ ingested: number }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('not signed in');
  }

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

  return (await res.json()) as { ingested: number };
}
