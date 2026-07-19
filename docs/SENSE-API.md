# How this app talks to Sense

The Sense monitor has **no local API** — every byte of data flows through
Sense's cloud, and the API this app uses is **undocumented and unofficial**.
It was reverse-engineered years ago by the community and has stayed stable,
but Sense can change or shut it down at any time without notice. That risk is
the reason this app archives everything locally: the archive is the product,
the cloud is just the source.

This page describes exactly what we call and how we behave, both for
transparency and so it's fixable when (not if) something drifts. The client
lives in [`packages/server/src/sense/`](../packages/server/src/sense/) —
about 600 lines, self-contained, no third-party Sense libraries.

Prior art that made this possible: the Python
[`sense_energy`](https://github.com/scottbonline/sense) library (used by Home
Assistant), [`dnesting/sense`](https://github.com/dnesting/sense) (Go), and
[`sense-energy-node`](https://github.com/brbeaird/sense-energy-node). We use
them as reference documentation only.

## Endpoints

REST base: `https://api.sense.com/apiservice/api/v1/`
Realtime: `wss://clientrt.sense.com/monitors/{monitor_id}/realtimefeed`

We send a stable `User-Agent` identifying this project, plus the
`Sense-Client-Version` / `X-Sense-Protocol` headers the official clients send.

### Authentication (`auth.ts`)

1. `POST authenticate` — form-encoded `email` + `password`. Success returns
   `access_token`, `refresh_token`, `user_id`, and the monitor list (id +
   timezone). If the account has MFA, Sense responds `401` with
   `status: "mfa_required"` and an `mfa_token`.
2. `POST authenticate/mfa` — form-encoded `totp` + `mfa_token` (+
   `client_time`). The web UI collects the code; tokens are then persisted in
   the SQLite `kv` table, so **MFA is needed once per data volume, not per
   restart**.
3. `POST renew` — form-encoded `user_id` + `refresh_token` +
   `is_access_token=true`, exchanged for a fresh access token.

Any REST `401` triggers a single-flight recovery pipeline: renew → full
re-auth with the configured credentials → if Sense demands MFA again, all
collectors pause cleanly and the UI shows the MFA screen (no hammering a
401ing API).

### Data (`rest.ts`)

| call | endpoint | cadence |
| --- | --- | --- |
| device list | `app/monitors/{id}/devices` | every 6 h |
| usage trends | `app/history/trends?monitor_id=&scale=DAY&start=` | every 15 min (today), nightly re-fetch of yesterday, once per day during backfill |
| on/off timeline | `users/{user_id}/timeline?n_items=30` | every 5 min |

Responses are parsed with Zod schemas in **passthrough mode**: we validate
only the fields we use and tolerate everything else, so additive API changes
don't break parsing. Solar monitors add a `production` block to trends —
optional in our schema, ignored when absent. Historical backfill walks
backward one day per request until 30 consecutive empty days (the install
date), then never runs again.

### Realtime (`realtime.ts`)

One WebSocket to `realtimefeed?access_token=…`. Sense pushes JSON frames
roughly every 0.5–1 s; we use `type: "realtime_update"` payloads: total watts
(`w`), per-leg `voltage[]`, `hz`, currently-on `devices[]` with per-device
watts, and `solar_w` on solar monitors. Other message types are ignored.

Connection management:

- **Exponential backoff** on failure: 1 s → 2 s → … capped at 5 min, with
  jitter; reset after 60 s of healthy connection.
- **Stale-stream watchdog**: no frame for 30 s → force reconnect (streams
  sometimes go silent without closing).
- Connect-time `401/403` runs the token recovery pipeline before retrying.

## Being a good citizen

The community's main warning about this API is rate limiting. Our load
profile is deliberately conservative:

- **One** persistent realtime stream, regardless of how many browser tabs are
  open — the server fans frames out to local clients. This matches the load
  of a single open official-app session. (`REALTIME_MODE=duty-cycle` exists
  as an escape hatch: 50 s connected, 10 s off.)
- REST calls go through a token bucket at **1 request/second sustained**
  (burst 5) — far below the ~10 r/s ceiling others have observed. A full
  4-year backfill is ~1,500 requests spread over ~25 minutes, once ever.
- Steady state after backfill is ~5 REST requests per 15 minutes.

## When Sense changes something

Failure behavior is designed so the app degrades instead of breaking:

- Unparseable REST responses fail that collector's run; the job records the
  error (visible in Settings → Collectors) and retries on its normal
  schedule. The Zod error names the exact field that drifted.
- If the cloud disappears entirely, the UI serves the local archive with a
  "cloud disconnected" banner, and nightly jobs derive daily summaries from
  our own measured rollups (`source: 'rollup'`) so charts keep working
  forever.
- `pnpm probe` is a one-shot smoke test (auth + one trends call + a few live
  frames) for checking whether the cloud API still works, and
  `pnpm record-fixtures` captures sanitized real traffic into `fixtures/`
  for the replay-based mock (`SENSE_MOCK=1`) that all development runs
  against — so debugging API drift never adds load to Sense's servers.

If your install breaks and you've traced it to a changed endpoint or field,
please open an issue with the collector error message — that's usually
enough to pinpoint the drift.
