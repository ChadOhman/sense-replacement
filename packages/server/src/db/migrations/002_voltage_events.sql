-- Mains voltage sag (brownout) events. ended_ts NULL while in progress.
CREATE TABLE voltage_events (
  id            INTEGER PRIMARY KEY,
  started_ts    INTEGER NOT NULL,
  ended_ts      INTEGER,
  leg           INTEGER NOT NULL,
  min_volts     REAL NOT NULL,
  nominal_volts REAL NOT NULL
);

CREATE INDEX idx_voltage_events_started ON voltage_events (started_ts);
