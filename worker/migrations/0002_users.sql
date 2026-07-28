-- Users + WebAuthn credentials + tiny ownership (free platform migration)
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

CREATE TABLE IF NOT EXISTS tiny_owners (
  name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tiny_owners_user ON tiny_owners(user_id);
