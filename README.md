# sense-replacement

A self-hosted replacement for the Sense Energy Monitor web app. Sense stopped
selling home monitors at the end of 2025 and no longer maintains the web app;
this project keeps your monitor useful — and, crucially, **archives your energy
data locally** so your history survives even if Sense's cloud goes dark.

## What it does

- **Live power meter** — streaming wattage graph from your monitor's realtime
  feed, with what's-on-now device cards.
- **Device breakdown** — per-device usage today / this month, with cost.
- **History & trends** — day/week/month/year charts with cost estimates from
  your configured electricity rate.
- **Local archive** — everything is continuously written to a SQLite database
  on your disk: 30-second power rollups (kept 7 days), 5-minute (2 years),
  hourly (forever), plus daily summaries and device on/off events. On first run
  it backfills your full history from Sense's cloud (~25 min for 4 years of
  data, politely rate-limited).
- **Cloud-dead fallback** — if Sense's API disappears, the app keeps serving
  all archived data, and daily summaries are derived from its own measurements.
- **Power quality suite** — brownout, floating-neutral, and motor-stall
  detection with a dedicated per-leg voltage dashboard (Sense Labs parity).
- **Alerts & integrations** — ntfy/webhook notifications for detected events
  and device-finished runs (configurable in Settings), Home Assistant via MQTT
  discovery (`MQTT_URL`), and a Prometheus `/metrics` endpoint.
- **Real billing** — flat or time-of-use rate plans priced against your actual
  hourly usage profile, billing-cycle alignment, month-end bill forecasts, and
  year-over-year comparisons.
- **Health analytics** — per-device anomaly baselines (failing-appliance early
  warning), always-on creep detection, an outage log derived from archive
  gaps, and optional weather degree-day tracking (`LAT`/`LON`).
- **Your data, actually yours** — CSV and full-database exports from the UI,
  automatic nightly backups (`BACKUP_DIR` for a NAS mount), and a generated
  report each billing cycle.

> ⚠️ This uses Sense's **undocumented** cloud API (the monitor has no local
> API). It may break without notice. Be a good citizen: the app keeps a single
> realtime stream and stays far below observed rate limits.

## Quick start (Docker)

```sh
cp .env.example .env   # fill in SENSE_EMAIL / SENSE_PASSWORD, TZ, rate
docker compose up -d --build
open http://localhost:3000
```

If your Sense account has MFA enabled, the web UI will prompt for your
authenticator code once; tokens are then stored in the data volume and survive
restarts.

Your database lives at `./data/sense.db`. Back that file up and your energy
history is safe forever.

## Development

```sh
pnpm install
pnpm --filter @sense/shared build
SENSE_MOCK=1 pnpm dev     # server :3000 + Vite :5173, zero Sense cloud load
```

`SENSE_MOCK=1` replays recorded fixtures (or a deterministic synthetic
household if none exist) so you can develop without touching Sense's API.

Useful scripts (need real credentials in env):

- `pnpm probe` — auth + a few live frames + today's kWh; verifies the cloud API
  still works.
- `pnpm record-fixtures` — captures your device list and ~10 min of realtime
  frames into `fixtures/` for higher-fidelity mock mode.

Tests: `pnpm test`.

## Architecture

pnpm monorepo, TypeScript throughout:

- `packages/server` — Fastify. Contains the Sense cloud client (auth/MFA/token
  renewal, rate-limited REST, reconnecting websocket), the collectors
  (realtime rollups, trends polling, historical backfill, device sync, on/off
  timeline, retention/compaction), SQLite (better-sqlite3, WAL), and the HTTP
  API + `/api/live` websocket relay (one upstream stream fanned out to any
  number of browser tabs).
- `packages/web` — React + Vite + Tailwind + uPlot.
- `packages/shared` — the DTO contract between them.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `SENSE_EMAIL` / `SENSE_PASSWORD` | — | Sense account credentials (server-side only) |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite + token storage |
| `TZ` | `UTC` | Day-boundary timezone for charts |
| `CURRENCY` | `CAD` | Display currency |
| `ELECTRICITY_RATE_CENTS_PER_KWH` | `16.5` | Cost estimates (editable in Settings) |
| `SENSE_MOCK` | `0` | `1` = fixture/synthetic replay, no cloud access |
| `REALTIME_MODE` | `persistent` | `duty-cycle` = 50s on / 10s off stream |
