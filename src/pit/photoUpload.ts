import { supabase } from '@/lib/supabase';

const BUCKET = 'pit-photos';

export async function uploadPitPhoto(
  eventKey: string,
  teamNumber: number,
  file: Blob
): Promise<string> {
  // DETERMINISTIC path (one pit photo per team per event) + upsert:true so a
  // retry / re-drain OVERWRITES the same object instead of writing a new random
  // path each time — the old random-UUID + upsert:false orphaned the previous
  // object in Storage on every re-upload.
  const path = eventKey + '/' + teamNumber + '.jpg';
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true });
  if (error) {
    throw new Error(error.message);
  }
  return path;
}

export async function signedPitPhotoUrl(path: string): Promise<string | null> {
  // 7-day expiry: a URL signed while online Friday must still be fetchable on
  // Sunday — dashboards persist the query result across the whole competition
  // weekend and can't re-sign while offline.
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7);
  if (error || !data) {
    return null;
  }
  return data.signedUrl;
}
