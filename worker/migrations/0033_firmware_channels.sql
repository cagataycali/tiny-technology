-- One row per (owner, channel): where the current firmware bundle lives.
--
-- The BYTES stay in R2 behind /api/media, which is the whole reason this table
-- holds a pointer and not a manifest. /api/media keys are unguessable per
-- upload, so there is nothing a device can poll for "latest" — this row is that
-- stable name. Copying the manifest JSON in here would put a second copy of it
-- one edit away from disagreeing with the artifact the device actually fetches
-- and hashes, and the device's verify path already checks the manifest's own
-- sha256. So: version, url, sha256, and nothing that can drift.
--
-- `channel` exists so a bundle can be proven on ONE unit before the fleet sees
-- it. A device opts in by naming a channel in its own config; a device naming
-- none never asks. There is deliberately no fleet-wide default row.
CREATE TABLE IF NOT EXISTS firmware_channels (
  user_id    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  version    TEXT NOT NULL,
  url        TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel)
);
