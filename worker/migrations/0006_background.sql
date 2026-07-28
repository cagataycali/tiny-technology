-- Wave 1 background platform (COMPARISON.md): push, scheduler, event bus.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  keys_json TEXT NOT NULL,          -- {p256dh, auth}
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tiny_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule TEXT,                    -- '*/5m' | 'daily@09:00' | NULL for once
  run_at INTEGER,                   -- unix seconds for one-shot
  prompt TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  once INTEGER DEFAULT 0,
  last_fired_at INTEGER DEFAULT 0,  -- compare-and-swap double-fire guard
  fire_count INTEGER DEFAULT 0,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  started INTEGER DEFAULT (unixepoch()),
  status TEXT,                      -- ok | error | timeout
  result_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started);

-- Event bus: per-user ring (pruned to last 200 per user on write)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- job_fired | job_result | share_view | ...
  detail TEXT,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created);
