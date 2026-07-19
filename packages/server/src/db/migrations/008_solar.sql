-- Solar production, populated only on monitors with solar CTs.
ALTER TABLE power_rollup ADD COLUMN solar_w_avg REAL;
ALTER TABLE daily_summary ADD COLUMN production_kwh REAL;
