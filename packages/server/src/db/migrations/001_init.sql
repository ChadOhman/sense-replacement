CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT,
  icon       TEXT,
  tags_json  TEXT NOT NULL DEFAULT '{}',
  is_guess   INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Whole-home measured power, rolled up from the realtime stream.
-- resolution is the bucket width in seconds: 30, 300, or 3600.
CREATE TABLE power_rollup (
  resolution   INTEGER NOT NULL,
  bucket       INTEGER NOT NULL, -- bucket start, epoch seconds UTC, aligned to resolution
  w_avg        REAL NOT NULL,
  w_min        REAL NOT NULL,
  w_max        REAL NOT NULL,
  volts        REAL,
  hz           REAL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (resolution, bucket)
) WITHOUT ROWID;

CREATE TABLE device_power_rollup (
  resolution   INTEGER NOT NULL,
  bucket       INTEGER NOT NULL,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  w_avg        REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (resolution, bucket, device_id)
) WITHOUT ROWID;

-- Canonical daily archive. source='trends' when it came from Sense's cloud,
-- 'rollup' when derived from our own measurements (cloud-dead fallback).
CREATE TABLE daily_summary (
  day    TEXT PRIMARY KEY, -- YYYY-MM-DD in the configured local TZ
  kwh    REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'trends' CHECK (source IN ('trends', 'rollup'))
);

CREATE TABLE device_daily (
  day       TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  kwh       REAL NOT NULL,
  PRIMARY KEY (day, device_id)
) WITHOUT ROWID;

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('on', 'off')),
  watts     REAL,
  source    TEXT NOT NULL DEFAULT 'timeline' CHECK (source IN ('timeline', 'realtime')),
  UNIQUE (device_id, ts, type)
);

CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_device_daily_device ON device_daily (device_id, day);
