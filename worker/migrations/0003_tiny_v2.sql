-- tiny-v2 — fresh start schema for the WebAuthn/GitHub logged-in platform.
-- Users + credentials + tinys in one relational database (old `tiny` D1 stays
-- bound as DB_OLD for migration).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  github_login TEXT,
  email TEXT,
  name TEXT,
  avatar TEXT,
  created INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sign_count INTEGER DEFAULT 0,
  transports TEXT,
  label TEXT,
  created INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

-- Tinys: the relational source of truth for the new platform.
-- KV keeps a copy for the chat runtime (fast reads), this table drives
-- ownership, "my tinys" listings and the public community page.
CREATE TABLE IF NOT EXISTS tinys (
  name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_prompt TEXT DEFAULT '',
  system_knowledge TEXT DEFAULT '',
  private INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created INTEGER DEFAULT (unixepoch()),
  updated INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tinys_user ON tinys(user_id);
CREATE INDEX IF NOT EXISTS idx_tinys_public ON tinys(private, active);
