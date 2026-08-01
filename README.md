# sense-replacement

A self-hosted replacement for the Sense Energy Monitor web app. Sense stopped
selling home monitors at the end of 2025 and no longer maintains the web app;
this project keeps your monitor useful — and, crucially, **archives your energy
data locally** so your history survives even if Sense's cloud goes dark.

If this project keeps your monitor alive, you can
[☕ buy me a coffee](https://buymeacoffee.com/chadohman).

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
- **Local detection (NILM, experimental)** — cloud-independent device
  detection: sudden power changes on the 1 Hz stream are captured as
  transient waveforms, clustered, and labeled by you on the Detection page;
  labeled devices are then matched live (with per-device off-delay and
  match-strictness tuning), published to Home Assistant, and rolled into a
  live "unknown power" residual so 100% of your draw is always accounted
  for. If Sense's cloud ML ever disappears, this keeps device detection
  working from the raw stream alone. Approach inspired by
  [nonsense-powermonitor](https://github.com/Nils154/nonsense-powermonitor)
  (clean-room TypeScript reimplementation of the ideas).
- **Solar (experimental)** — monitors with solar CTs are auto-detected:
  live production + net readouts, a production series on the live chart,
  daily production archived alongside consumption, and production totals in
  Trends. Built against the community-documented API shape (`solar_w`,
  trends `production`) and verified in simulation — the author's monitor has
  no solar, so reports from real solar homes are very welcome (issue tracker!).

> ⚠️ This uses Sense's **undocumented** cloud API (the monitor has no local
> API). It may break without notice. Be a good citizen: the app keeps a single
> realtime stream and stays far below observed rate limits. Exactly what we
> call and how we behave is documented in
> [docs/SENSE-API.md](docs/SENSE-API.md).

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

## Self-updating (bare-metal / systemd installs)

Every push to `main` that passes CI publishes a rolling release; the app
checks for it every 30 minutes and shows an **Update** banner. Click it, watch
the modal (download → verify → install deps → stage → restart), done. The
replaced version is kept on disk and Settings offers a one-click **Roll back**.
If a new version fails to boot 3 times in a row, the wrapper auto-reverts.
Docker installs update by pulling a new image instead — the in-app updater
disables itself there, and likewise in dev builds.

One-time setup on the host (adjust paths/user if yours differ; assumes the
app lives at `/opt/sense` running as user `sense` under a systemd unit named
`sense`):

```sh
install -d -o sense -g sense /opt/sense-updates /opt/sense-updates/staging \
  /opt/sense-updates/download /opt/sense-updates/previous
install -d -o root -g root /opt/sense-updates/bin
install -o root -g root -m 755 /opt/sense/scripts/sense-run.sh /opt/sense-updates/bin/sense-run.sh
sudo -u sense pnpm --version   # verify pnpm works as the service user
mkdir -p /etc/systemd/system/sense.service.d
cat > /etc/systemd/system/sense.service.d/self-update.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/opt/sense-updates/bin/sense-run.sh
WorkingDirectory=/opt/sense
Restart=always
RestartSec=3
[Unit]
StartLimitIntervalSec=120
StartLimitBurst=10
UNIT
systemctl daemon-reload && systemctl restart sense && systemctl is-active sense
```

Make sure `DATA_DIR` in `/opt/sense/.env` is an **absolute** path. The updater
never touches `data/` or `.env*` — swaps move code only, and everything it
does is logged to `/opt/sense-updates/update.log`.

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

## API

Everything the UI shows is available over a plain HTTP API (plus a live
WebSocket, MQTT topics, and Prometheus metrics) — see
[docs/API.md](docs/API.md).

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
| `SENSE_UPDATE_DIR` | `/opt/sense-updates` | Self-update workspace (see Self-updating) |
