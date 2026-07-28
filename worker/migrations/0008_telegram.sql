-- Telegram integration (COMPARISON.md §2.2): per-user bot, polled by the
-- worker cron; each inbound runs the user's chosen tiny and replies.
CREATE TABLE IF NOT EXISTS telegram_bots (
  user_id TEXT PRIMARY KEY,          -- one bot per user (v1)
  token TEXT NOT NULL,               -- BotFather token
  tiny_slug TEXT NOT NULL,           -- which tiny answers
  allowed_chats TEXT DEFAULT '',     -- comma-separated chat ids ('' = pairing mode)
  last_offset INTEGER DEFAULT 0,     -- getUpdates offset (CAS'd per poll)
  enabled INTEGER DEFAULT 1,
  created INTEGER DEFAULT (unixepoch())
);
