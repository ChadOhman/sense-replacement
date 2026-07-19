# HTTP API

Everything the web UI shows comes from this API — it's yours to script
against. All endpoints are unauthenticated (the app is designed for a trusted
LAN; put it behind a reverse proxy or VPN for remote access). JSON unless
noted. Timestamps are **epoch seconds UTC**; `day` strings are `YYYY-MM-DD` in
the monitor's local timezone. Response shapes are defined as TypeScript types
in [`packages/shared/src/api.ts`](../packages/shared/src/api.ts) — field
names below match those DTOs exactly.

Base URL: `http://<host>:3000`.

## System

### `GET /api/status`
Health and app state. Returns `authState` (`ok` | `needs_mfa` | `error` |
`unconfigured`), `cloudConnected` (realtime stream up), `lastFrameTs`,
`collectors[]` (per-job `lastRun`/`lastSuccess`/`lastError`), `backfill`
(`state`, `cursor`, `daysArchived`), `dbSizeBytes`, `mock`, `lastBackup`,
`solar` (true once solar CTs are detected), and the currently active
power-quality events: `activeBrownout`, `activeNeutralEpisode`, `activeStall`
(each `null` when quiet).

### `GET /api/setup/status` · `POST /api/setup/mfa`
MFA bootstrap. `POST` body `{"totp": "123456"}` completes a pending
multi-factor challenge; tokens then persist in the data directory.

### `GET /metrics`
Prometheus text exposition (note: root path, not under `/api`). Gauges for
total watts, per-leg volts, frequency, per-device watts, today's kWh, stream
connectivity, active brownout/neutral/stall, and per-collector
`last_success_age_seconds`.

## Live data

### `WS /api/live`
WebSocket relay of the realtime stream (one upstream connection to Sense is
fanned out to any number of clients). Server → client JSON messages
(`LiveMessage`):

| kind | payload | when |
| --- | --- | --- |
| `history` | `points: PowerPoint[]` — last hour at 30 s resolution | once, on connect |
| `frame` | `frame: LiveFrame` — `{ts, w, solarW, volts, voltageLegs[], hz, devices[]}` | ~1 Hz |
| `status` | `cloudConnected: boolean` | on upstream connect/disconnect |

`devices[]` lists currently-on detected devices with live watts. `solarW` is
`null` on monitors without solar CTs.

### `GET /api/summary`
Today/week/month kWh and rate-aware cost, `alwaysOnW`, `nowW`,
`alwaysOnCreep` (`null` unless the always-on floor rose >20% and >15 W above
its 90-day baseline), `solarTodayKwh` (`null` without solar).

## History

### `GET /api/history/power?from=<epoch>&to=<epoch>`
Whole-home power series. The server picks the resolution (≤2 days → 30 s,
≤60 days → 5 min, else 1 h) and returns `{resolution, points: PowerPoint[]}`
with `wAvg/wMin/wMax` (+ `solarWAvg` on solar homes).

### `GET /api/history/usage?scale=day|week|month|year&start=YYYY-MM-DD&compare=1`
Bucketed usage: `day` → last 30 days, `week` → last 12 ISO weeks, `month` →
last 12 months, `year` → all years. Returns `buckets[]` (`label`, `kwh`,
`cost`), range totals, and a per-device breakdown (top 8 + `other`). Costs
are rate-aware (see Billing). `compare=1` adds `compare[]`, the same buckets
one year earlier. `totalProductionKwh` appears on solar homes.

## Devices

### `GET /api/devices`
All detected devices with metadata, live watts (`nowW`), `todayKwh`,
`monthKwh`, `monthCost` (priced from the device's own hourly profile), and
`anomaly` (`null`, or `{pct, direction, recentKwhPerDay, baselineKwhPerDay}`
when the trailing 7 days deviate >30% and >0.2 kWh/day from the 90-day
baseline). Devices Sense has deleted are kept with `revoked: true`.

### `GET /api/devices/:id`
Detail: device metadata, `daily[]` (last 30 days with costs), `monthly[]`
(last 12 months), `events[]` (recent on/off), and `typicalRun` — median
duration/kWh/cost over recent completed runs (`null` until enough runs are
observed).

### `GET /api/events?from=&to=&deviceId=`
Device on/off event feed (default: last 24 h, newest first, max 200).
`source` is `timeline` (Sense's feed) or `realtime` (derived from the live
stream).

## Power quality

### `GET /api/voltage-summary`
Live per-leg volts, learned `nominalVolts`, per-leg 24 h stats
(avg / min-sustained / max-sustained from 30 s averages), 30-day `dips30d` /
`spikes30d` counts (5-min buckets beyond ±5% of nominal) and a `recent[]`
list.

### `GET /api/voltage-history?from=<epoch>&to=<epoch>`
Per-leg voltage series: `{resolution, legs: VoltagePoint[][]}` (index 0 =
L1).

### `GET /api/voltage-events?from=&to=`
Brownouts (sustained sags below 90% of nominal, ≥5 s, ended with hysteresis).
An active event has `endedTs: null`.

### `GET /api/neutral-events?from=&to=`
Floating-neutral divergence episodes (legs moving in opposite directions
simultaneously) plus a 7-day `health` verdict: `ok` | `suspect` | `alert`
(alert at ≥5 episodes or ≥20 V spread — call an electrician).

### `GET /api/stall-events?from=&to=`
Motor stall clusters (≥3 similar-magnitude failed-start spikes within
5-minute gaps) with spike counts and magnitudes, plus `count30d`.

### `GET /api/outages?from=&to=`
Gaps ≥5 min in the power archive — a power outage, or the collector being
offline.

## Billing

### `GET /api/billing/settings` · `PUT /api/billing/settings`
The rate plan: `{"ratePlan": {"type": "flat", "cents": 16.5}, "billingCycleDay": 1}`
or a TOU plan:

```json
{
  "ratePlan": {
    "type": "tou",
    "periods": [
      { "name": "On-peak", "weekdays": [1,2,3,4,5], "startHour": 16, "endHour": 21, "cents": 21 }
    ],
    "defaultCents": 9
  },
  "billingCycleDay": 15
}
```

Periods match in order (first wins); hours are local, half-open
`[startHour, endHour)` with wraparound (`21 → 7`); optional `months: [6,7,8]`
restricts a period seasonally; `defaultCents` covers unmatched hours.

### `GET /api/billing`
Current cycle: window, `dayOfCycle`/`daysInCycle`, to-date kWh and cost,
`forecastCost` (run-rate projection), `lastCycleCost`.

### `GET /api/settings` · `PUT /api/settings`
Legacy simple settings: `{rateCentsPerKwh, currency}`. The currency is still
authoritative here; the flat rate is superseded by the rate plan.

## Alerts

### `GET /api/alerts/settings` · `PUT /api/alerts/settings`
Notification config: `ntfyUrl`, `webhookUrl`, per-kind `enabled` toggles
(`brownout`, `neutral`, `stall`, `device_finished`, `alwayson_creep`,
`device_anomaly`), `quietHours` (`{startHour, endHour}` local, urgent alerts
bypass), `finishedDeviceIds[]` + `finishedMinRuntimeS` for device-finished
notifications.

### `POST /api/alerts/test`
Sends a test notification through the configured channels.

Webhook deliveries are JSON:
`{"event": "brownout.started", "ts": 1784..., "message": "…", "data": {…}}`.

## Data ownership

### `GET /api/export/usage.csv?from=&to=` · `GET /api/export/devices.csv?from=&to=`
Daily totals (kWh, rate-aware cost, source) / per-device daily kWh.

### `GET /api/export/power.csv?from=<epoch>&to=<epoch>&resolution=30|300|3600`
Raw power rollups (avg/min/max watts, volts, hz, samples, solar).

### `GET /api/export/database`
A consistent SQLite snapshot of the entire archive (`VACUUM INTO`),
streamed as a download.

### `GET /api/reports`
Generated billing-cycle reports (`CycleReport[]`, newest first): totals,
vs-prior-cycle, top devices, power-quality counts, anomalies.

# MQTT (optional)

With `MQTT_URL` set, the app publishes Home Assistant discovery configs
(`homeassistant/{sensor,binary_sensor}/sense_*/config`, retained) and state:

| topic | payload | cadence |
| --- | --- | --- |
| `sense/status` | `online` / `offline` (LWT) | availability |
| `sense/power` | watts | 2 s |
| `sense/voltage/{0,1}` | per-leg volts | 2 s |
| `sense/frequency` | Hz | 2 s |
| `sense/energy_today` | kWh (retained) | 2 s |
| `sense/device/{id}/power`, `sense/device/{id}/state` | watts, `ON`/`OFF` | on change |
| `sense/alert/{brownout,neutral,stall}` | `ON`/`OFF` (retained) | on change |
