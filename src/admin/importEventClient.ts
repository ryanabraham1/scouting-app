import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';

export interface ImportEventResult {
  event_key: string;
  name: string;
  team_count: number;
  match_count: number;
  join_code: string;
}

export async function importEvent(eventKey: string): Promise<ImportEventResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Not signed in.');
  }

  // One retry on 502/503: those are upstream-TBA/edge blips (seen live), not
  // real answers about the event. Other statuses surface immediately.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${env.SUPABASE_URL}/functions/v1/import-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ event_key: eventKey }),
    });
    if (res.ok || attempt >= 1 || (res.status !== 502 && res.status !== 503)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `Import failed (${res.status})`);
  }

  return (await res.json()) as ImportEventResult;
}
