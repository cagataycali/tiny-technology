-- Voice sessions (real speech-to-speech, docs/voice-sessions-design.md)
-- One row per speech-to-speech call. The VoiceSession Durable Object relays
-- the client mic ⇄ OpenAI Realtime and journals audio segments + events.jsonl
-- to R2 (env.MEDIA under voice/{id}/…); this table is the durable index that
-- makes a call listable and re-watchable. Audio/events live in R2; only the
-- manifest metadata lives here.
CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tiny_name TEXT NOT NULL,
  voice TEXT,                       -- the OpenAI voice used (marin/cedar/…)
  status TEXT NOT NULL DEFAULT 'created',  -- created | live | ended | error
  started_at INTEGER NOT NULL,      -- unix seconds, session create
  connected_at INTEGER,             -- unix seconds, first WS upgrade
  ended_at INTEGER,                 -- unix seconds, teardown
  duration_ms INTEGER DEFAULT 0,    -- wall time client was connected
  segment_count INTEGER DEFAULT 0,  -- R2 audio segments journaled
  event_count INTEGER DEFAULT 0,    -- events.jsonl lines
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_user ON voice_sessions (user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_tiny ON voice_sessions (tiny_name, started_at);
