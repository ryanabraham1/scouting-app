import { supabase } from '@/lib/supabase';

const BUCKET = 'pit-photos';

export async function uploadPitPhoto(
  eventKey: string,
  teamNumber: number,
  file: Blob
): Promise<string> {
  const path = eventKey + '/' + teamNumber + '/' + crypto.randomUUID() + '.jpg';
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: false });
  if (error) {
    throw new Error(error.message);
  }
  return path;
}

export async function signedPitPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data) {
    return null;
  }
  return data.signedUrl;
}
