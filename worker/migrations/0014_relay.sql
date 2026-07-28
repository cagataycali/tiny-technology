-- Device relay (tiny-node PR6, docs/tiny-node-goal.md §5-6):
-- owner-scoped message envelopes between the web agent and enrolled
-- devices. Bounded payloads, poll-based delivery (device token auth),
-- replies keyed by in_reply_to. Old rows swept opportunistically on write.
CREATE TABLE IF NOT EXISTS relay_messages (
  id TEXT PRIMARY KEY,            -- envelope uuid
  user_id TEXT NOT NULL,          -- owner scope (both directions)
  to_device TEXT NOT NULL,        -- target device id, '' = addressed to the user (a reply)
  in_reply_to TEXT,               -- envelope id this answers
  payload TEXT NOT NULL,          -- JSON, bounded at write
  created_at INTEGER,
  delivered INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_relay_device ON relay_messages (to_device, delivered);
CREATE INDEX IF NOT EXISTS idx_relay_reply ON relay_messages (in_reply_to);
