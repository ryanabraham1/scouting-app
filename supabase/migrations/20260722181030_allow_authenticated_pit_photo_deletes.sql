-- Allow the login-less scout flow to remove obsolete pit photos.
-- Anonymous sign-ins use the authenticated Postgres role, matching the existing
-- SELECT/INSERT/UPDATE policies for this private bucket.

drop policy if exists pit_photos_delete on storage.objects;

create policy pit_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'pit-photos');
