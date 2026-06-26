# Real-time webhooks: TBA + Nexus

The dashboard gets live field status and match results by **push**, not polling.
Two Supabase Edge Functions receive webhooks and land data in the DB; the
dashboard reads it over Supabase Realtime.

```
TBA  match_score ─▶ tba-webhook  ─▶ public.match (scores/winner)        ─┐
Nexus live status ─▶ nexus-webhook ─▶ public.nexus_event_status (snapshot)│─▶ Realtime ─▶ Dashboard
              (safety net) sync-event-results ─▶ public.match            ─┘
```

Endpoints (project `oztsfxyfovwnwutrxzmo`):

| Service | URL |
|---|---|
| TBA   | `https://oztsfxyfovwnwutrxzmo.supabase.co/functions/v1/tba-webhook` |
| Nexus | `https://oztsfxyfovwnwutrxzmo.supabase.co/functions/v1/nexus-webhook` |

Both are deployed with `verify_jwt = false` (external services don't send a
Supabase JWT) and do their **own** auth: TBA via an HMAC signature, Nexus via a
token header. They are **fail-closed**: the TBA `verification`/`ping` handshake
is answered without a secret (so setup completes), but **no data is written until
the secret/token is set** — an unsigned `match_score` or Nexus push is accepted
with 200 and ignored. So set the secrets below before expecting live data.

---

## 1. The Blue Alliance

1. **Pick a secret** — a long random string, e.g.
   ```bash
   openssl rand -hex 32
   ```
2. **Tell our function the secret:**
   ```bash
   npx supabase secrets set TBA_WEBHOOK_SECRET=<that-string>
   ```
3. **Create the webhook on TBA:** go to <https://www.thebluealliance.com/account>
   → *Webhooks* → add:
   - **URL:** `https://oztsfxyfovwnwutrxzmo.supabase.co/functions/v1/tba-webhook`
   - **Secret:** the **same** string from step 1.
4. **Verify it.** TBA immediately POSTs a `verification` message; our function
   answers 200. Back on the account page, click **Verify** on the webhook (resend
   the code if needed). Until verified, TBA sends nothing else.
5. **Subscribe to your event.** myTBA → *Subscriptions* → add your event (e.g.
   `2026txhou1`) and enable **Match Score** (and optionally Upcoming Match /
   Schedule Updated). Or "Subscribe to all events" for the firehose. **Use a TBA
   account that is NOT linked to your phone** or the firehose will spam push
   notifications there.

> TBA deletes endpoints that error or fail a ping. Ours always answers ping with
> 200, so it won't get pruned.

**Test:** TBA's account page has a "Send Test Match Score" button — after sending,
`select * from match where result_synced_at is not null` should show rows, and the
dashboard's next-match should advance.

---

## 2. FRC Nexus

1. **Register the webhook** at <https://frc.nexus/api> → create a
   **pushLiveEventStatus** webhook for your event:
   - **URL:** `https://oztsfxyfovwnwutrxzmo.supabase.co/functions/v1/nexus-webhook`
2. **Copy the token** Nexus shows for the webhook (it sends it as the
   `Nexus-Token` header) and store it:
   ```bash
   npx supabase secrets set NEXUS_WEBHOOK_TOKEN=<that-token>
   ```
3. That's it — Nexus pushes a fresh snapshot on every field change (match status,
   queueing, alliance changes). Our function stores only the newest (it ignores
   any push with an older `dataAsOfTime`, so the field never rolls backward).

**Test:** with the event live, `select event_key, now_queuing, data_as_of_time
from nexus_event_status` should show your event updating, and the dashboard's
"On Field" / "Queuing" tiles should track the real field.

---

## Setting both secrets at once

```bash
npx supabase secrets set \
  TBA_WEBHOOK_SECRET=<random-string> \
  NEXUS_WEBHOOK_TOKEN=<nexus-token>
```
(Setting secrets does not require redeploying the functions.)

## Notes

- The **event key the webhook reports must match the dashboard's active event**
  (set on the Setup tab). Nexus/TBA use the same `frc.events` code, e.g.
  `2026txhou1`.
- If TBA webhooks lapse, the dashboard still self-heals: it calls
  `sync-event-results` (a server-side TBA results reconcile) on load and every
  60s, so previously-played matches never get stuck "unplayed".
- Logs: `npx supabase functions logs tba-webhook` (or `nexus-webhook`) shows
  every received message and any signature/token mismatch.
