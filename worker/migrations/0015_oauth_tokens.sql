-- Per-service OAuth token store (careless IntegrationsTab, ported to the
-- worker instead of client-side because tinyai has real server sessions).
--
-- Unlike careless (implicit flow, tokens in the browser, no refresh), tinyai
-- runs the authorization-CODE flow server-side (we already hold the client
-- secrets in env for GitHub login) so we can persist a refresh_token and mint
-- fresh access tokens without re-consent. One row per (user, service).
--
-- Tokens are stored so the worker/app can USE them (call Spotify/Google/GitHub
-- on the user's behalf) — they cannot be hashed like a device token. They live
-- only in internal-key-guarded D1 and are NEVER returned to the browser: the
-- app proxies expose "connected? / expires? / scope?" but the raw token stays
-- server-side (same trust boundary as the Telegram bot token).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT NOT NULL,             -- owner (FK users)
  service TEXT NOT NULL,             -- 'github' | 'spotify' | 'google'
  access_token TEXT NOT NULL,        -- bearer for API calls
  refresh_token TEXT DEFAULT '',     -- '' when the provider issues none
  expires_at INTEGER DEFAULT 0,      -- unix seconds; 0 = never/unknown
  scope TEXT DEFAULT '',             -- granted scopes (space-separated)
  token_type TEXT DEFAULT 'Bearer',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, service)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens (user_id);
