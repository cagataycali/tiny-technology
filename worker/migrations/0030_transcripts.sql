-- Transcripts (Nicla Voice recorder). The necklace's NDP120 matches a wake
-- word; the paired phone records N seconds, transcribes ON-DEVICE, uploads the
-- audio to R2 via /media/upload, and stores the transcript here. Audio bytes
-- live in R2; this table is the durable, listable text — device_id records
-- which unit produced it (the Voice board that woke, or the phone that agents
-- commanded via nicla_voice_record). Ring semantics like events: capped per
-- user (src/transcripts.ts TRANSCRIPT_RING_CAP), oldest pruned on write.
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,            -- uuid
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,        -- which device produced it (the Voice unit or the phone)
  label TEXT NOT NULL DEFAULT '', -- wake label or reason, e.g. "wake: alexa"
  text TEXT NOT NULL,
  audio_url TEXT NOT NULL DEFAULT '',
  duration_s INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL        -- unixepoch
);
CREATE INDEX IF NOT EXISTS idx_transcripts_user ON transcripts (user_id, created DESC);
