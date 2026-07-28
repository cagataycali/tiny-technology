-- Device registry (tiny-node PR2, docs/tiny-node-goal.md §3):
-- every enrolled daemon/CLI/browser becomes an addressable node of the
-- owner's tiny identity. Token is HASHED at rest (SHA-256) — the plaintext
-- is shown exactly once at enroll; revocation kills access instantly.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,            -- device uuid, generated at enroll
  user_id TEXT NOT NULL,          -- owner (FK users)
  name TEXT NOT NULL,             -- "cagatay-macbook", editable
  platform TEXT,                  -- darwin-arm64 / linux-x64 / browser
  kind TEXT,                      -- daemon | browser | cli
  capabilities TEXT,              -- JSON array: ["shell","files",...]
  token_hash TEXT NOT NULL,       -- SHA-256 hex of the device token
  last_seen INTEGER,              -- unix seconds — presence
  created_at INTEGER,
  revoked INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id, revoked);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (token_hash);
