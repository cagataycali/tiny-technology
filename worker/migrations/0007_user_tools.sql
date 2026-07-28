-- Runtime tool building (issue #8): user-created tools, loaded into the
-- agent per request like OpenAPI skills.
CREATE TABLE IF NOT EXISTS user_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',    -- {argName: description} flat string params
  code TEXT NOT NULL,               -- JS function body: (args) => result
  created INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_user_tools_user ON user_tools(user_id);
