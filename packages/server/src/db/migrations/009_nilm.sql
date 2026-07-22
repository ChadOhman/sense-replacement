-- Local NILM (event-based device detection): captured transient waveforms,
-- their clusters, and the human-labeled devices clusters map to. Fully
-- separate namespace from the cloud-synced `devices` table — NILM device ids
-- are local integers, cloud ids are opaque strings.
CREATE TABLE nilm_devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  -- Manual wattage override; NULL = use the matched event's magnitude.
  est_w REAL,
  -- Auto-emit OFF this many seconds after ON (loads whose off transient is
  -- unrecognizable, e.g. fridges). NULL = rely on labeled off-events.
  off_delay_s INTEGER,
  -- Match-radius override for all of this device's clusters. NULL = each
  -- cluster's own radius.
  max_match_distance REAL,
  created_ts INTEGER NOT NULL
);

CREATE TABLE nilm_clusters (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('on','off')),
  -- Smoothed median waveform (JSON array of per-second watt deltas).
  profile_json TEXT NOT NULL,
  -- Max member distance to the profile at clustering time; the default
  -- live-match radius.
  radius REAL NOT NULL,
  size INTEGER NOT NULL,
  device_id INTEGER REFERENCES nilm_devices(id) ON DELETE SET NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE nilm_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('on','off')),
  -- Net power change over the capture window (signed watts).
  delta_w REAL NOT NULL,
  -- Raw per-second watt deltas (JSON array, fixed window length).
  waveform_json TEXT NOT NULL,
  cluster_id INTEGER REFERENCES nilm_clusters(id) ON DELETE SET NULL,
  -- 1 when the live matcher assigned the cluster at capture time.
  matched_live INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_nilm_events_ts ON nilm_events (ts);
CREATE INDEX idx_nilm_events_cluster ON nilm_events (cluster_id);
