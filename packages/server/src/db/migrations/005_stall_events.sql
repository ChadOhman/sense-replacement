-- Motor stall events: clusters of repeated similar-magnitude power spikes
-- (failed motor start attempts). ended_ts NULL while the cluster is active.
CREATE TABLE stall_events (
  id          INTEGER PRIMARY KEY,
  started_ts  INTEGER NOT NULL,
  ended_ts    INTEGER,
  spike_count INTEGER NOT NULL,
  avg_spike_w REAL NOT NULL,
  max_spike_w REAL NOT NULL
);

CREATE INDEX idx_stall_events_started ON stall_events (started_ts);
