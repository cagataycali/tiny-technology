-- User↔user direct messages (send_message): D1 is the thread store;
-- delivery fans out to Telegram (telegram_bots token) + web push
-- (push_subscriptions) + the event ring at send time.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,           -- sender userId (session.sub — never client-supplied)
  to_user TEXT NOT NULL,             -- recipient userId (resolved server-side)
  via_tiny TEXT DEFAULT '',          -- which tiny brokered the send
  body TEXT NOT NULL,                -- ≤2000 chars
  read INTEGER DEFAULT 0,
  created INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_msg_inbox ON messages(to_user, read, created DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_user, created DESC);
