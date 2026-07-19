-- Per-billing-cycle summary reports, generated when a cycle closes.
CREATE TABLE reports (
  id           INTEGER PRIMARY KEY,
  period       TEXT NOT NULL UNIQUE, -- cycle start day YYYY-MM-DD
  generated_ts INTEGER NOT NULL,
  json         TEXT NOT NULL
);
