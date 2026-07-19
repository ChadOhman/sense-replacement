-- Daily health metrics: always-on floor and (optional) weather degree-days.
CREATE TABLE daily_metrics (
  day         TEXT PRIMARY KEY, -- YYYY-MM-DD local
  always_on_w REAL,
  hdd         REAL, -- heating degree-days (base 18C), when LAT/LON configured
  cdd         REAL
);

-- Data gaps in the power archive: a power outage, or the collector being
-- down. started_ts unique so re-scans upsert instead of duplicating.
CREATE TABLE outages (
  id         INTEGER PRIMARY KEY,
  started_ts INTEGER NOT NULL UNIQUE,
  ended_ts   INTEGER NOT NULL
);

CREATE INDEX idx_outages_started ON outages (started_ts);
