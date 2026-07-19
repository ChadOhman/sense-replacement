-- Per-leg voltage rollups (the power_rollup table only stores the cross-leg
-- average). Same resolution tiers and retention as power_rollup.
CREATE TABLE voltage_rollup (
  resolution   INTEGER NOT NULL,
  bucket       INTEGER NOT NULL,
  leg          INTEGER NOT NULL, -- 0-based
  v_avg        REAL NOT NULL,
  v_min        REAL NOT NULL,
  v_max        REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (resolution, bucket, leg)
) WITHOUT ROWID;
