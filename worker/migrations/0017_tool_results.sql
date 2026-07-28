-- Device tool results (on-device generative tools, docs/on-device-genai-research-2026-07.md)
-- A device executing a client-side tool (generate_image…) posts its result
-- here; the chat route's tool callback polls it back into the agent loop.
-- Ephemeral by design — rows are swept after 15 minutes.
CREATE TABLE IF NOT EXISTS tool_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_results_lookup ON tool_results (user_id, tool_use_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_age ON tool_results (created_at);
