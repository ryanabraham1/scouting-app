// Pure: does an `upsert_match_report` verdict mean the server now holds this
// report (or a newer revision of it)? Shared by ingest-reports so a QR receiver
// can clear its staged copy. `stale` (same report, server already newer — the
// sender's own outbox usually got there first) is landed: re-sending can never
// change it, and counting it as failed left the receiver stuck retrying a
// transfer that was already safe. An identity conflict or a same-revision
// content conflict is a real failure the receiver must keep.
export function isLandedUpsertVerdict(
  data: { status?: string; identity_conflict?: boolean } | null | undefined,
): boolean {
  if (!data) return false;
  if (data.status === "applied" || data.status === "idempotent") return true;
  return data.status === "stale" && data.identity_conflict !== true;
}
