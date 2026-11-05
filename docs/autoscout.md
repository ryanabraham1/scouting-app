# Auto-Scout

The lead dashboard's **Auto-Scout** tab runs [frc-auto-scout](https://github.com/ryanabraham1/frc-auto-scout)
on the team's video computer.

```text
Auto-Scout tab ── autoscout_enqueue / autoscout_cancel ──► autoscout_job
                                                               ▲
Video computer ── calls out every 5–15 s ──► autoscout-worker ─┘
                                                │
                                                └──► autoscout_result, autoscout_worker
```

The computer is never reachable from the internet. Jobs wait in Supabase while it is off, and
results land with every browser closed. It holds one worker token and no Supabase key; the
database keeps only the token's SHA-256 in `autoscout_worker_secret`.

## Job types

| Type | Footage | Limits |
|---|---|---|
| Live stream | Records from the live edge and clips each match once TBA posts its `actual_time`, then scouts it unless that option is off | Only matches after recording starts. YouTube can't clip backwards from a stream still live |
| Ended stream | Clips each match at `actual_time - stream start` | Twitch needs a pasted VOD link: a channel has no history |
| Match videos | TBA's per-match videos | Those can land hours late |

An event must be calibrated on the computer first (`autoscout serve`, Calibrate page, on the
computer itself). The tab warns when it isn't, and the computer refuses the job with a reason.

Stream jobs need no link: the computer finds the event's stream on TBA, the right day's for each
match, and a live job picks up the new day's stream when it reconnects. A pasted link overrides that.

A manual "Sync to match start" calibration (`webcast_sync`, source `manual`) overrides the
platform's stream start time for ended-stream jobs.

The computer takes about 7 minutes per match on an RTX 3060, close to qualification cycle time,
so a live job can back up in a busy block and catch up in breaks. Nothing is dropped.

## Data rules

`autoscout_result` holds automated estimates and is deliberately separate from human reports.
They appear, labelled, on the Team and Match pages and as an Auto Fuel ranking column
(`src/dash/autoScoutStats.ts`). They don't feed predictions or scouted aggregates: a human and an
automated report of one match are not two independent observations.

## Deploy

```bash
npx supabase db push
npx supabase functions deploy autoscout-worker
```

To set or rotate the token, put the new SHA-256 in the private table, then update the computer:

```sql
insert into autoscout_worker_secret (token_sha256) values ('<sha256 hex of the token>')
on conflict (id) do update set token_sha256 = excluded.token_sha256;
```

Computer setup is in the frc-auto-scout repo: `docs/SCOUTING_APP_INTEGRATION.md`.
