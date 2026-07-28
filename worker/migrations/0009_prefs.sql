-- Generic per-user preferences (first use: disabled_tools for manage_tools)
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT DEFAULT '',
  updated INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
);
