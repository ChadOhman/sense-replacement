-- Floating-neutral divergence episodes (legs moving in opposite directions).
-- ended_ts NULL while in progress.
CREATE TABLE neutral_events (
  id               INTEGER PRIMARY KEY,
  started_ts       INTEGER NOT NULL,
  ended_ts         INTEGER,
  max_spread_volts REAL NOT NULL,
  high_leg         INTEGER NOT NULL,
  peak_high_volts  REAL NOT NULL,
  peak_low_volts   REAL NOT NULL,
  nominal_volts    REAL NOT NULL
);

CREATE INDEX idx_neutral_events_started ON neutral_events (started_ts);
