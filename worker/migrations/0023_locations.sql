-- 🗺️ Opt-in live map presence (maps-location loop c5).
-- One row per user, written only while their "be seen by other tinys"
-- toggle is on: heartbeat = opt-in, DELETE = opt-out, and readers cut on
-- `updated` (MAP_PRESENCE_WINDOW_S) so dead clients fall off the map on
-- their own. Coordinates are stored coarsened to 4 decimals (~11m) — the
-- table never holds anything finer. Purely additive migration.

CREATE TABLE IF NOT EXISTS locations (
  user_id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmh REAL,
  heading TEXT,     -- cardinal (N/NE/…) — allowlisted in src/locations.ts
  accuracy_m INTEGER,
  updated INTEGER NOT NULL  -- unix seconds; presence window + sweep key
);

CREATE INDEX IF NOT EXISTS idx_locations_updated ON locations(updated);
