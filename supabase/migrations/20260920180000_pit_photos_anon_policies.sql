-- Open the pit-photos Storage policies to the anon role, matching the pit row
-- policies (0021) and the login-less shared-trust model.
--
-- Why: a device whose anonymous sign-in never completed (venue NAT 429 at boot,
-- or a refresh rejected after a long offline stretch) still runs as `anon`. Its
-- pit ROW upsert succeeds (upsert_pit_report is granted to anon) but the photo
-- upload hit `pit_photos_insert ... to authenticated` and failed with a 403 —
-- and because the client stripped the status off that error it was retried
-- forever: the report sat at "queued to send" with no reason shown. With anon
-- allowed here the same device uploads normally; the client fix that preserves
-- the status is what makes any remaining Storage 4xx surface as a dead-letter.
drop policy if exists pit_photos_select on storage.objects;
drop policy if exists pit_photos_insert on storage.objects;
drop policy if exists pit_photos_update on storage.objects;
drop policy if exists pit_photos_delete on storage.objects;

create policy pit_photos_select on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'pit-photos');

create policy pit_photos_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'pit-photos');

create policy pit_photos_update on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'pit-photos')
  with check (bucket_id = 'pit-photos');

create policy pit_photos_delete on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'pit-photos');
